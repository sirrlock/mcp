/**
 * Unit tests for MCP tool handlers (5-tool surface).
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

  next(status: number, body: unknown): this {
    this.responseQueue.push({ status, body });
    return this;
  }

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
    env: { ...process.env, SIRR_SERVER: mock.url, SIRRLOCK_URL: mock.url, SIRR_TOKEN: TOKEN, SIRR_ORG: "test-org" },
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

// ── store_secret (anonymous dead drop) ───────────────────────────────────────

describe("store_secret (anonymous)", () => {
  it("POST /secrets with value only (no name)", async () => {
    mock.next(201, { id: "deadbeef01020304" });
    const text = await client.call("store_secret", { value: "bar" });
    expect(mock.lastRequest?.method).toBe("POST");
    expect(mock.lastRequest?.path).toBe("/secrets");
    expect((mock.lastRequest?.body as Record<string, unknown>)["name"]).toBeUndefined();
    expect((mock.lastRequest?.body as Record<string, unknown>)["value"]).toBe("bar");
    expect(text).toContain("deadbeef01020304");
  });

  it("returns URL in output", async () => {
    mock.next(201, { id: "abc123" });
    const text = await client.call("store_secret", { value: "v" });
    expect(text).toContain("/s/abc123");
  });

  it("reports TTL in output when ttl_seconds provided", async () => {
    mock.next(201, { id: "ttlid" });
    const text = await client.call("store_secret", { value: "v", ttl_seconds: 3600 });
    expect(text).toContain("1h");
  });

  it("reports burn limit in output", async () => {
    mock.next(201, { id: "burnid" });
    const text = await client.call("store_secret", { value: "v", max_reads: 3 });
    expect(text).toContain("3 read(s)");
  });

  it("does not send null for omitted optional fields", async () => {
    mock.next(201, { id: "bareid" });
    await client.call("store_secret", { value: "v" });
    const body = mock.lastRequest?.body as Record<string, unknown>;
    expect(body["ttl_seconds"]).toBeUndefined();
    expect(body["max_reads"]).toBeUndefined();
  });
});

// ── store_secret (named, org-scoped) ─────────────────────────────────────────

describe("store_secret (named)", () => {
  it("POST /orgs/{org}/secrets with name and value", async () => {
    mock.next(201, { key: "FOO", id: "hexid001" });
    const text = await client.call("store_secret", { value: "bar", name: "FOO" });
    expect(mock.lastRequest?.method).toBe("POST");
    expect(mock.lastRequest?.path).toBe("/orgs/test-org/secrets");
    expect((mock.lastRequest?.body as Record<string, unknown>)["key"]).toBe("FOO");
    expect((mock.lastRequest?.body as Record<string, unknown>)["value"]).toBe("bar");
    expect(text).toContain("FOO");
  });

  it("409 → conflict message", async () => {
    mock.next(409, { error: "conflict" });
    const text = await client.call("store_secret", { value: "bar", name: "FOO" });
    expect(text).toContain("already exists");
    expect(text).toContain("FOO");
  });

  it("401 → Error: in output", async () => {
    mock.next(401, { error: "unauthorized" });
    const text = await client.call("store_secret", { value: "bar", name: "FOO" });
    expect(text).toContain("Error:");
    expect(text).toContain("401");
  });
});

// ── read_secret ──────────────────────────────────────────────────────────────

describe("read_secret", () => {
  it("GET /secrets/{id} (public dead drop) and returns value", async () => {
    mock.next(200, { id: "abc123", value: "supersecret" });
    const text = await client.call("read_secret", { id: "abc123" });
    expect(mock.lastRequest?.method).toBe("GET");
    expect(mock.lastRequest?.path).toBe("/secrets/abc123");
    expect(text).toBe("supersecret");
  });

  it("GET /orgs/{org}/secrets/{name} (org-scoped) and returns value", async () => {
    mock.next(200, { id: "hex64id", value: "orgsecret" });
    const text = await client.call("read_secret", { name: "MY_KEY" });
    expect(mock.lastRequest?.method).toBe("GET");
    expect(mock.lastRequest?.path).toBe("/orgs/test-org/secrets/MY_KEY");
    expect(text).toBe("orgsecret");
  });

  it("strips sirr: prefix from name", async () => {
    mock.next(200, { id: "hex64id", value: "orgsecret" });
    await client.call("read_secret", { name: "sirr:MY_KEY" });
    expect(mock.lastRequest?.path).toBe("/orgs/test-org/secrets/MY_KEY");
  });

  it("error if neither id nor name provided", async () => {
    const text = await client.call("read_secret", {});
    expect(text).toContain("Error:");
  });

  it("404 → not-found message, not an error (public id)", async () => {
    mock.next(404, { error: "not found" });
    const text = await client.call("read_secret", { id: "MISSING" });
    expect(text).toContain("not found");
    expect(text).not.toContain("Error:");
  });

  it("410 → not-found message (burned public secret)", async () => {
    mock.next(410, { error: "gone" });
    const text = await client.call("read_secret", { id: "BURNED" });
    expect(text).toContain("not found");
    expect(text).not.toContain("Error:");
  });

  it("403 → Error: in output (public id)", async () => {
    mock.next(403, { error: "forbidden" });
    const text = await client.call("read_secret", { id: "DENIED" });
    expect(text).toContain("Error:");
    expect(text).toContain("403");
  });
});

// ── check_secret ─────────────────────────────────────────────────────────────

describe("check_secret", () => {
  it("HEAD request — active secret returns metadata without consuming a read", async () => {
    mock.next(200, {});
    const text = await client.call("check_secret", { name: "MY_KEY" });
    expect(mock.lastRequest?.method).toBe("HEAD");
    expect(mock.lastRequest?.path).toBe("/orgs/test-org/secrets/MY_KEY");
    expect(text).toContain("active");
  });

  it("404 → not found message", async () => {
    mock.next(404, {});
    const text = await client.call("check_secret", { name: "GONE" });
    expect(text).toContain("not found");
    expect(text).not.toContain("Error:");
  });

  it("410 → sealed message", async () => {
    mock.next(410, {});
    const text = await client.call("check_secret", { name: "SEALED" });
    expect(text).toContain("sealed");
    expect(text).not.toContain("Error:");
  });
});

// ── share_secret ──────────────────────────────────────────────────────────────

describe("share_secret", () => {
  it("returns a sirrlock share URL on success", async () => {
    mock.next(200, { key: "a3f9c2d1e4b5" });
    const text = await client.call("share_secret", { value: "hunter2" });
    expect(mock.lastRequest?.method).toBe("POST");
    expect(mock.lastRequest?.path).toBe("/api/public/secret");
    expect((mock.lastRequest?.body as Record<string, unknown>)["value"]).toBe("hunter2");
    expect(text).toContain("/s/a3f9c2d1e4b5");
    expect(text).toContain("burns after one read");
  });

  it("returns an error when the upstream call fails", async () => {
    mock.next(503, { error: "unavailable" });
    const text = await client.call("share_secret", { value: "hunter2" });
    expect(text).toContain("Error:");
  });
});

// ── audit ────────────────────────────────────────────────────────────────────

describe("audit", () => {
  it("GET /orgs/{org}/audit with query params", async () => {
    mock.next(200, { events: [
      { id: 1, timestamp: 1000, action: "secret.read", key: "K", source_ip: "1.2.3.4", success: true },
    ]});
    const text = await client.call("audit", { since: 500, action: "secret.read", limit: 10 });
    expect(mock.lastRequest?.method).toBe("GET");
    expect(mock.lastRequest?.path).toContain("/orgs/test-org/audit");
    expect(mock.lastRequest?.path).toContain("since=500");
    expect(mock.lastRequest?.path).toContain("action=secret.read");
    expect(mock.lastRequest?.path).toContain("limit=10");
    expect(text).toContain("secret.read");
  });

  it("empty events → 'No audit events found'", async () => {
    mock.next(200, { events: [] });
    const text = await client.call("audit");
    expect(text).toBe("No audit events found.");
  });
});

// ── error handling ────────────────────────────────────────────────────────────

describe("error handling", () => {
  it("non-JSON error body → Error: with text content", async () => {
    mock.nextText(429, "Too Many Requests");
    const text = await client.call("audit");
    expect(text).toContain("Error:");
    expect(text).toContain("429");
  });

  it("non-2xx JSON error → Error: with status and message", async () => {
    mock.next(401, { error: "invalid token" });
    const text = await client.call("audit");
    expect(text).toContain("Error:");
    expect(text).toContain("401");
    expect(text).toContain("invalid token");
  });

  it("unknown tool → Unknown tool error", async () => {
    const text = await client.call("nonexistent_tool");
    expect(text).toContain("Unknown tool");
  });
});
