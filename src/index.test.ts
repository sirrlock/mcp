/**
 * Unit tests for MCP tool handlers.
 *
 * Uses a mock HTTP server so tests run without a real sirrd instance.
 * Assertions cover: HTTP method, path, request body, response formatting,
 * 404 handling (returns text, not error), non-2xx handling (returns Error:).
 */

import {
  describe,
  it,
  expect,
  beforeAll,
  afterAll,
  afterEach,
} from "@jest/globals";
import { createServer, IncomingMessage, ServerResponse, Server } from "http";
import { spawn, ChildProcess } from "child_process";
import { createInterface, Interface } from "readline";

// ── Mock HTTP server ───────────────────────────────────────────────────────────

interface CapturedRequest {
  method: string;
  path: string;
  body: unknown;
}

class MockServer {
  private server: Server;
  private responseQueue: Array<{ status: number; body: unknown; contentType?: string }> = [];
  public lastRequest: CapturedRequest | null = null;
  readonly port: number;
  readonly url: string;

  constructor(port: number) {
    this.port = port;
    this.url = `http://127.0.0.1:${port}`;
    this.server = createServer(async (req: IncomingMessage, res: ServerResponse) => {
      const chunks: Buffer[] = [];
      for await (const chunk of req) chunks.push(chunk as Buffer);
      const raw = Buffer.concat(chunks).toString();
      let body: unknown = null;
      try { body = JSON.parse(raw); } catch { body = raw || null; }
      this.lastRequest = { method: req.method!, path: req.url!, body };
      const next = this.responseQueue.shift() ?? { status: 200, body: {} };
      const ct = next.contentType ?? "application/json";
      res.writeHead(next.status, { "Content-Type": ct });
      res.end(ct === "application/json" ? JSON.stringify(next.body) : String(next.body));
    });
  }

  start(): Promise<void> {
    return new Promise((resolve) => this.server.listen(this.port, "127.0.0.1", resolve));
  }

  stop(): Promise<void> {
    return new Promise((resolve, reject) =>
      this.server.close((err) => (err ? reject(err) : resolve())),
    );
  }

  /** Enqueue a JSON response to be served for the next request. */
  next(status: number, body: unknown): this {
    this.responseQueue.push({ status, body });
    return this;
  }

  /** Enqueue a plain-text response (simulates rate-limiter / proxy errors). */
  nextText(status: number, text: string): this {
    this.responseQueue.push({ status, body: text, contentType: "text/plain" });
    return this;
  }

  clearQueue(): void {
    this.responseQueue = [];
  }
}

// ── MCP JSON-RPC client ────────────────────────────────────────────────────────

interface JsonRpcResponse {
  jsonrpc: "2.0";
  id: number;
  result?: { content?: Array<{ type: string; text: string }>; isError?: boolean; [k: string]: unknown };
  error?: { code: number; message: string };
}

class McpClient {
  private pending = new Map<number, (r: JsonRpcResponse) => void>();
  private nextId = 1;
  private rl: Interface;

  constructor(private proc: ChildProcess) {
    this.rl = createInterface({ input: proc.stdout! });
    this.rl.on("line", (line: string) => {
      if (!line.trim()) return;
      const msg = JSON.parse(line) as JsonRpcResponse;
      if (msg.id != null) {
        const resolve = this.pending.get(msg.id);
        if (resolve) { this.pending.delete(msg.id); resolve(msg); }
      }
    });
  }

  close(): void { this.rl.close(); this.proc.kill(); }

  private rpc(method: string, params: unknown): Promise<JsonRpcResponse> {
    const id = this.nextId++;
    return new Promise((resolve) => {
      this.pending.set(id, resolve);
      this.proc.stdin!.write(JSON.stringify({ jsonrpc: "2.0", id, method, params }) + "\n");
    });
  }

  async initialize(): Promise<void> {
    await this.rpc("initialize", {
      protocolVersion: "2024-11-05",
      capabilities: {},
      clientInfo: { name: "unit-test", version: "1" },
    });
  }

  async call(tool: string, args: Record<string, unknown> = {}): Promise<string> {
    const resp = await this.rpc("tools/call", { name: tool, arguments: args });
    if (resp.error) throw new Error(`MCP error: ${resp.error.message}`);
    return resp.result?.content?.[0]?.text ?? "";
  }
}

// ── Fixtures ──────────────────────────────────────────────────────────────────

const MOCK_PORT = 19082;
const TOKEN = "unit-test-token";
const MCP_BIN = `${__dirname}/../dist/index.js`;

let mock: MockServer;
let client: McpClient;
let mcpProc: ChildProcess;

beforeAll(async () => {
  mock = new MockServer(MOCK_PORT);
  await mock.start();

  mcpProc = spawn("node", [MCP_BIN], {
    env: { ...process.env, SIRR_SERVER: mock.url, SIRR_TOKEN: TOKEN },
    stdio: ["pipe", "pipe", "pipe"],
  });
  mcpProc.stderr!.on("data", (d: Buffer) => {
    const msg = d.toString();
    if (!msg.includes("[sirr-mcp] Warning")) process.stderr.write(msg);
  });

  client = new McpClient(mcpProc);
  await client.initialize();
}, 15_000);

afterAll(async () => {
  client?.close();
  await mock?.stop();
});

afterEach(() => {
  mock.clearQueue();
});

// ── check_secret ─────────────────────────────────────────────────────────────

describe("check_secret", () => {
  it("HEAD /secrets/{key} — active secret returns metadata without consuming a read", async () => {
    const future = Math.floor(Date.now() / 1000) + 3600;
    mock.next(200, {});
    // Mock server doesn't send response headers naturally, but we test the path/method
    const text = await client.call("check_secret", { key: "MY_KEY" });
    expect(mock.lastRequest?.method).toBe("HEAD");
    expect(mock.lastRequest?.path).toBe("/secrets/MY_KEY");
    // 200 with no X-Sirr-Status header defaults to "active"
    expect(text).toContain("active");
  });

  it("404 → not found message", async () => {
    mock.next(404, {});
    const text = await client.call("check_secret", { key: "GONE" });
    expect(text).toContain("not found");
    expect(text).not.toContain("Error:");
  });

  it("410 → sealed message", async () => {
    mock.next(410, {});
    const text = await client.call("check_secret", { key: "SEALED" });
    expect(text).toContain("sealed");
    expect(text).not.toContain("Error:");
  });
});

// ── get_secret ────────────────────────────────────────────────────────────────

describe("get_secret", () => {
  it("GET /secrets/{key} and returns value", async () => {
    mock.next(200, { value: "supersecret" });
    const text = await client.call("get_secret", { key: "MY_KEY" });
    expect(mock.lastRequest?.method).toBe("GET");
    expect(mock.lastRequest?.path).toBe("/secrets/MY_KEY");
    expect(text).toBe("supersecret");
  });

  it("404 → not-found message, not an error", async () => {
    mock.next(404, { error: "not found" });
    const text = await client.call("get_secret", { key: "MISSING" });
    expect(text).toContain("not found");
    expect(text).not.toContain("Error:");
  });

  it("410 → not-found message (burned secret)", async () => {
    mock.next(410, { error: "gone" });
    const text = await client.call("get_secret", { key: "BURNED" });
    expect(text).toContain("not found");
    expect(text).not.toContain("Error:");
  });

  it("403 → Error: in output", async () => {
    mock.next(403, { error: "forbidden" });
    const text = await client.call("get_secret", { key: "DENIED" });
    expect(text).toContain("Error:");
    expect(text).toContain("403");
  });
});

// ── push_secret ───────────────────────────────────────────────────────────────

describe("push_secret", () => {
  it("POST /secrets with key and value", async () => {
    mock.next(201, { key: "FOO" });
    await client.call("push_secret", { key: "FOO", value: "bar" });
    expect(mock.lastRequest?.method).toBe("POST");
    expect(mock.lastRequest?.path).toBe("/secrets");
    expect((mock.lastRequest?.body as Record<string, unknown>)["key"]).toBe("FOO");
    expect((mock.lastRequest?.body as Record<string, unknown>)["value"]).toBe("bar");
  });

  it("reports TTL in output when ttl_seconds provided", async () => {
    mock.next(201, { key: "TTL_KEY" });
    const text = await client.call("push_secret", { key: "TTL_KEY", value: "v", ttl_seconds: 3600 });
    expect(text).toContain("1h");
  });

  it("reports burn limit in output when max_reads provided", async () => {
    mock.next(201, { key: "BURN_KEY" });
    const text = await client.call("push_secret", { key: "BURN_KEY", value: "v", max_reads: 1 });
    expect(text).toContain("1 read(s)");
  });

  it("does not send null for omitted optional fields", async () => {
    mock.next(201, { key: "BARE" });
    await client.call("push_secret", { key: "BARE", value: "v" });
    const body = mock.lastRequest?.body as Record<string, unknown>;
    expect(body["ttl_seconds"]).toBeUndefined();
    expect(body["max_reads"]).toBeUndefined();
  });

  it("sends delete=false for seal-on-burn behavior", async () => {
    mock.next(201, { key: "SEAL" });
    const text = await client.call("push_secret", { key: "SEAL", value: "v", max_reads: 3, delete: false });
    expect((mock.lastRequest?.body as Record<string, unknown>)["delete"]).toBe(false);
    expect(text).toContain("Sealed on burn");
  });
});

// ── patch_secret ──────────────────────────────────────────────────────────────

describe("patch_secret", () => {
  it("PATCH /secrets/{key} with body", async () => {
    mock.next(200, { key: "FOO", read_count: 0, max_reads: 5, expires_at: null });
    await client.call("patch_secret", { key: "FOO", max_reads: 5 });
    expect(mock.lastRequest?.method).toBe("PATCH");
    expect(mock.lastRequest?.path).toBe("/secrets/FOO");
    expect((mock.lastRequest?.body as Record<string, unknown>)["max_reads"]).toBe(5);
  });

  it("only sends provided fields", async () => {
    mock.next(200, { key: "FOO", read_count: 0, max_reads: null, expires_at: null });
    await client.call("patch_secret", { key: "FOO", ttl_seconds: 7200 });
    const body = mock.lastRequest?.body as Record<string, unknown>;
    expect(body["ttl_seconds"]).toBe(7200);
    expect(body["max_reads"]).toBeUndefined();
    expect(body["value"]).toBeUndefined();
  });

  it("formats response with expiry and max_reads", async () => {
    const future = Math.floor(Date.now() / 1000) + 7200;
    mock.next(200, { key: "FOO", read_count: 1, max_reads: 5, expires_at: future });
    const text = await client.call("patch_secret", { key: "FOO" });
    expect(text).toContain("FOO");
    expect(text).toContain("2h");
    expect(text).toContain("Max reads: 5 (1 used)");
  });
});

// ── list_secrets ──────────────────────────────────────────────────────────────

describe("list_secrets", () => {
  it("GET /secrets and formats list", async () => {
    mock.next(200, {
      secrets: [
        { key: "KEY_A", read_count: 2, max_reads: null, expires_at: null },
        { key: "KEY_B", read_count: 0, max_reads: 1, expires_at: null },
      ],
    });
    const text = await client.call("list_secrets");
    expect(mock.lastRequest?.method).toBe("GET");
    expect(mock.lastRequest?.path).toBe("/secrets");
    expect(text).toContain("KEY_A");
    expect(text).toContain("KEY_B");
    expect(text).toContain("0/1 reads");
  });

  it("empty vault → 'No active secrets'", async () => {
    mock.next(200, { secrets: [] });
    const text = await client.call("list_secrets");
    expect(text).toBe("No active secrets.");
  });
});

// ── delete_secret ─────────────────────────────────────────────────────────────

describe("delete_secret", () => {
  it("DELETE /secrets/{key}", async () => {
    mock.next(200, { deleted: true });
    await client.call("delete_secret", { key: "TO_DEL" });
    expect(mock.lastRequest?.method).toBe("DELETE");
    expect(mock.lastRequest?.path).toBe("/secrets/TO_DEL");
  });

  it("404 → not-found message, not an error", async () => {
    mock.next(404, { error: "not found" });
    const text = await client.call("delete_secret", { key: "MISSING" });
    expect(text).toContain("not found");
    expect(text).not.toContain("Error:");
  });
});

// ── prune_secrets ─────────────────────────────────────────────────────────────

describe("prune_secrets", () => {
  it("POST /prune and reports count", async () => {
    mock.next(200, { pruned: 3 });
    const text = await client.call("prune_secrets");
    expect(mock.lastRequest?.method).toBe("POST");
    expect(mock.lastRequest?.path).toBe("/prune");
    expect(text).toContain("3");
  });
});

// ── sirr_audit ────────────────────────────────────────────────────────────────

describe("sirr_audit", () => {
  it("GET /audit with query params", async () => {
    mock.next(200, { events: [
      { id: 1, timestamp: 1000, action: "secret.read", key: "K", source_ip: "1.2.3.4", success: true },
    ]});
    const text = await client.call("sirr_audit", { since: 500, action: "secret.read", limit: 10 });
    expect(mock.lastRequest?.method).toBe("GET");
    expect(mock.lastRequest?.path).toContain("/audit");
    expect(mock.lastRequest?.path).toContain("since=500");
    expect(mock.lastRequest?.path).toContain("action=secret.read");
    expect(mock.lastRequest?.path).toContain("limit=10");
    expect(text).toContain("secret.read");
  });

  it("passes until param in query string", async () => {
    mock.next(200, { events: [] });
    await client.call("sirr_audit", { since: 100, until: 200 });
    expect(mock.lastRequest?.path).toContain("since=100");
    expect(mock.lastRequest?.path).toContain("until=200");
  });

  it("empty events → 'No audit events found'", async () => {
    mock.next(200, { events: [] });
    const text = await client.call("sirr_audit");
    expect(text).toBe("No audit events found.");
  });
});

// ── sirr_webhook_create / list / delete ───────────────────────────────────────

describe("sirr_webhook_create", () => {
  it("POST /webhooks with url and events", async () => {
    mock.next(201, { id: "wh_1", secret: "whsec_abc" });
    const text = await client.call("sirr_webhook_create", { url: "https://example.com/hook", events: ["secret.created"] });
    expect(mock.lastRequest?.method).toBe("POST");
    expect(mock.lastRequest?.path).toBe("/webhooks");
    const body = mock.lastRequest?.body as Record<string, unknown>;
    expect(body["url"]).toBe("https://example.com/hook");
    expect(body["events"]).toEqual(["secret.created"]);
    expect(text).toContain("wh_1");
    expect(text).toContain("whsec_abc");
  });
});

describe("sirr_webhook_list", () => {
  it("GET /webhooks and formats list", async () => {
    mock.next(200, { webhooks: [{ id: "wh_1", url: "https://example.com", events: ["*"], created_at: 0 }] });
    const text = await client.call("sirr_webhook_list");
    expect(mock.lastRequest?.path).toBe("/webhooks");
    expect(text).toContain("wh_1");
  });

  it("empty → 'No webhooks registered'", async () => {
    mock.next(200, { webhooks: [] });
    expect(await client.call("sirr_webhook_list")).toBe("No webhooks registered.");
  });
});

describe("sirr_webhook_delete", () => {
  it("DELETE /webhooks/{id}", async () => {
    mock.next(200, { deleted: true });
    await client.call("sirr_webhook_delete", { id: "wh_1" });
    expect(mock.lastRequest?.method).toBe("DELETE");
    expect(mock.lastRequest?.path).toBe("/webhooks/wh_1");
  });

  it("404 → not-found message, not an error", async () => {
    mock.next(404, { error: "not found" });
    const text = await client.call("sirr_webhook_delete", { id: "wh_missing" });
    expect(text).toContain("not found");
    expect(text).not.toContain("Error:");
  });
});

// ── sirr_key_list ─────────────────────────────────────────────────────────────

describe("sirr_key_list", () => {
  it("GET /me and extracts keys array", async () => {
    const future = Math.floor(Date.now() / 1000) + 86400;
    mock.next(200, {
      id: "p1", name: "alice", role: "admin", org_id: "org1", metadata: {}, created_at: 0,
      keys: [{ id: "key_1", name: "my-key", valid_after: 0, valid_before: future, created_at: 0 }],
    });
    const text = await client.call("sirr_key_list");
    expect(mock.lastRequest?.path).toBe("/me");
    expect(text).toContain("key_1");
    expect(text).toContain("my-key");
  });

  it("empty keys → 'No API keys'", async () => {
    mock.next(200, { id: "p1", name: "alice", role: "admin", org_id: "org1", metadata: {}, created_at: 0, keys: [] });
    expect(await client.call("sirr_key_list")).toBe("No API keys.");
  });
});

// ── sirr_me ───────────────────────────────────────────────────────────────────

describe("sirr_me", () => {
  it("GET /me and returns JSON", async () => {
    mock.next(200, { id: "p1", name: "alice", role: "admin", org_id: "org1" });
    const text = await client.call("sirr_me");
    expect(mock.lastRequest?.method).toBe("GET");
    expect(mock.lastRequest?.path).toBe("/me");
    expect(text).toContain("alice");
  });
});

// ── sirr_update_me ────────────────────────────────────────────────────────────

describe("sirr_update_me", () => {
  it("PATCH /me with metadata body", async () => {
    mock.next(200, { id: "p1", name: "alice", role: "admin", org_id: "org1", metadata: { env: "prod" } });
    await client.call("sirr_update_me", { metadata: { env: "prod" } });
    expect(mock.lastRequest?.method).toBe("PATCH");
    expect(mock.lastRequest?.path).toBe("/me");
    const body = mock.lastRequest?.body as Record<string, unknown>;
    expect(body["metadata"]).toEqual({ env: "prod" });
    expect(body["name"]).toBeUndefined();
    expect(body["email"]).toBeUndefined();
  });
});

// ── sirr_create_key ───────────────────────────────────────────────────────────

describe("sirr_create_key", () => {
  it("POST /me/keys with name and optional validity", async () => {
    const future = Math.floor(Date.now() / 1000) + 3600;
    mock.next(201, { id: "key_2", name: "ci-key", key: "sk_live_abc123", valid_after: 0, valid_before: future });
    const text = await client.call("sirr_create_key", { name: "ci-key", valid_for_seconds: 3600 });
    expect(mock.lastRequest?.method).toBe("POST");
    expect(mock.lastRequest?.path).toBe("/me/keys");
    const body = mock.lastRequest?.body as Record<string, unknown>;
    expect(body["name"]).toBe("ci-key");
    expect(body["valid_for_seconds"]).toBe(3600);
    expect(body["permissions"]).toBeUndefined();
    expect(body["prefix"]).toBeUndefined();
    expect(text).toContain("sk_live_abc123");
    expect(text).toContain("ci-key");
  });
});

// ── sirr_delete_key ───────────────────────────────────────────────────────────

describe("sirr_delete_key", () => {
  it("DELETE /me/keys/{keyId}", async () => {
    mock.next(200, { deleted: true });
    await client.call("sirr_delete_key", { keyId: "key_2" });
    expect(mock.lastRequest?.method).toBe("DELETE");
    expect(mock.lastRequest?.path).toBe("/me/keys/key_2");
  });

  it("404 → not-found message, not an error", async () => {
    mock.next(404, { error: "not found" });
    const text = await client.call("sirr_delete_key", { keyId: "gone" });
    expect(text).toContain("not found");
    expect(text).not.toContain("Error:");
  });
});

// ── org management ────────────────────────────────────────────────────────────

describe("sirr_org_create", () => {
  it("POST /orgs with name", async () => {
    mock.next(201, { id: "org_1", name: "acme" });
    const text = await client.call("sirr_org_create", { name: "acme" });
    expect(mock.lastRequest?.method).toBe("POST");
    expect(mock.lastRequest?.path).toBe("/orgs");
    expect((mock.lastRequest?.body as Record<string, unknown>)["name"]).toBe("acme");
    expect(text).toContain("org_1");
    expect(text).toContain("acme");
  });
});

describe("sirr_org_list", () => {
  it("GET /orgs and formats list", async () => {
    mock.next(200, { orgs: [{ id: "org_1", name: "acme", metadata: {}, created_at: 0 }] });
    const text = await client.call("sirr_org_list");
    expect(mock.lastRequest?.method).toBe("GET");
    expect(mock.lastRequest?.path).toBe("/orgs");
    expect(text).toContain("org_1");
  });

  it("empty → 'No organizations'", async () => {
    mock.next(200, { orgs: [] });
    expect(await client.call("sirr_org_list")).toBe("No organizations.");
  });
});

describe("sirr_org_delete", () => {
  it("DELETE /orgs/{org_id}", async () => {
    mock.next(200, { deleted: true });
    await client.call("sirr_org_delete", { org_id: "org_1" });
    expect(mock.lastRequest?.method).toBe("DELETE");
    expect(mock.lastRequest?.path).toBe("/orgs/org_1");
  });

  it("404 → not-found message, not an error", async () => {
    mock.next(404, { error: "not found" });
    const text = await client.call("sirr_org_delete", { org_id: "missing" });
    expect(text).toContain("not found");
    expect(text).not.toContain("Error:");
  });
});

// ── principal management ──────────────────────────────────────────────────────

describe("sirr_principal_create", () => {
  it("POST /orgs/{org_id}/principals with name and role", async () => {
    mock.next(201, { id: "p_1", name: "bob", role: "reader", org_id: "org_1" });
    const text = await client.call("sirr_principal_create", { org_id: "org_1", name: "bob", role: "reader" });
    expect(mock.lastRequest?.method).toBe("POST");
    expect(mock.lastRequest?.path).toBe("/orgs/org_1/principals");
    const body = mock.lastRequest?.body as Record<string, unknown>;
    expect(body["name"]).toBe("bob");
    expect(body["role"]).toBe("reader");
    expect(text).toContain("p_1");
  });
});

describe("sirr_principal_list", () => {
  it("GET /orgs/{org_id}/principals", async () => {
    mock.next(200, { principals: [{ id: "p_1", name: "bob", role: "reader", org_id: "org_1", created_at: 0 }] });
    const text = await client.call("sirr_principal_list", { org_id: "org_1" });
    expect(mock.lastRequest?.path).toBe("/orgs/org_1/principals");
    expect(text).toContain("bob");
    expect(text).toContain("reader");
  });
});

describe("sirr_principal_delete", () => {
  it("DELETE /orgs/{org_id}/principals/{principal_id}", async () => {
    mock.next(200, { deleted: true });
    await client.call("sirr_principal_delete", { org_id: "org_1", principal_id: "p_1" });
    expect(mock.lastRequest?.method).toBe("DELETE");
    expect(mock.lastRequest?.path).toBe("/orgs/org_1/principals/p_1");
  });

  it("404 → not-found message, not an error", async () => {
    mock.next(404, { error: "not found" });
    const text = await client.call("sirr_principal_delete", { org_id: "org_1", principal_id: "gone" });
    expect(text).toContain("not found");
    expect(text).not.toContain("Error:");
  });
});

// ── role management ───────────────────────────────────────────────────────────

describe("sirr_role_create", () => {
  it("POST /orgs/{org_id}/roles with name and permissions", async () => {
    mock.next(201, { name: "reader", permissions: "RL", org_id: "org_1" });
    const text = await client.call("sirr_role_create", { org_id: "org_1", name: "reader", permissions: "RL" });
    expect(mock.lastRequest?.method).toBe("POST");
    expect(mock.lastRequest?.path).toBe("/orgs/org_1/roles");
    expect((mock.lastRequest?.body as Record<string, unknown>)["permissions"]).toBe("RL");
    expect(text).toContain("reader");
    expect(text).toContain("RL");
  });
});

describe("sirr_role_list", () => {
  it("GET /orgs/{org_id}/roles", async () => {
    mock.next(200, { roles: [
      { name: "admin", permissions: "CRPDLMA", built_in: true, created_at: 0 },
      { name: "reader", permissions: "RL", built_in: false, created_at: 0 },
    ]});
    const text = await client.call("sirr_role_list", { org_id: "org_1" });
    expect(mock.lastRequest?.path).toBe("/orgs/org_1/roles");
    expect(text).toContain("admin");
    expect(text).toContain("(built-in)");
    expect(text).toContain("reader");
  });
});

describe("sirr_role_delete", () => {
  it("DELETE /orgs/{org_id}/roles/{role_name}", async () => {
    mock.next(200, { deleted: true });
    await client.call("sirr_role_delete", { org_id: "org_1", role_name: "reader" });
    expect(mock.lastRequest?.method).toBe("DELETE");
    expect(mock.lastRequest?.path).toBe("/orgs/org_1/roles/reader");
  });

  it("404 → not-found message, not an error", async () => {
    mock.next(404, { error: "not found" });
    const text = await client.call("sirr_role_delete", { org_id: "org_1", role_name: "gone" });
    expect(text).toContain("not found");
    expect(text).not.toContain("Error:");
  });
});

// ── error handling ────────────────────────────────────────────────────────────

describe("error handling", () => {
  it("non-JSON error body → Error: with text content", async () => {
    mock.nextText(429, "Too Many Requests");
    const text = await client.call("list_secrets");
    expect(text).toContain("Error:");
    expect(text).toContain("429");
  });

  it("non-2xx JSON error → Error: with status and message", async () => {
    mock.next(401, { error: "invalid token" });
    const text = await client.call("list_secrets");
    expect(text).toContain("Error:");
    expect(text).toContain("401");
    expect(text).toContain("invalid token");
  });
});
