/**
 * Integration tests — sirrd + sirr-mcp (stdio)
 *
 * Three modes (pick one via env vars):
 *
 *   SIRR_SERVER=http://localhost:39999 SIRR_TOKEN=mykey npm run test:integration
 *     → Connect to an already-running sirrd. No server is started.
 *
 *   SIRRD_BINARY=/path/to/sirrd npm run test:integration
 *     → Spawn a local binary. No Docker required.
 *
 *   SIRRD_IMAGE=sirrd:test npm run test:integration  (default)
 *     → Build and run via Docker.
 *
 * Run:  npm run test:integration
 */

import {
  describe,
  it,
  expect,
  beforeAll,
  afterAll,
} from "@jest/globals";
import { spawnSync, spawn, ChildProcess } from "child_process";
import { createInterface, Interface } from "readline";

// ── Config ────────────────────────────────────────────────────────────────────

// Spawn a local binary instead of Docker.
const SIRRD_BINARY = process.env["SIRRD_BINARY"];
const SIRRD_IMAGE  = process.env["SIRRD_IMAGE"] ?? "sirrd:test";
const SIRR_PORT    = 19080;
// When SIRR_SERVER is set, connect to that existing server — no server is spawned.
// SIRR_TOKEN must match SIRR_MASTER_KEY on that server.
const SIRR_TOKEN   = process.env["SIRR_TOKEN"] ?? "integration-test-key";
const SIRR_SERVER  = process.env["SIRR_SERVER"] ?? `http://localhost:${SIRR_PORT}`;
const USE_EXISTING = !!process.env["SIRR_SERVER"];
const MCP_BIN      = `${__dirname}/../dist/index.js`;

// ── MCP JSON-RPC client ───────────────────────────────────────────────────────

interface JsonRpcResponse {
  jsonrpc: "2.0";
  id: number;
  result?: { content?: Array<{ type: string; text: string }>; [k: string]: unknown };
  error?: { code: number; message: string };
}

class McpClient {
  private pending = new Map<number, (r: JsonRpcResponse) => void>();
  private nextId = 1;
  private rl: Interface;

  constructor(private proc: ChildProcess) {
    this.rl = createInterface({ input: proc.stdout! });
    this.rl.on("line", (line) => {
      if (!line.trim()) return;
      const msg = JSON.parse(line) as JsonRpcResponse;
      if (msg.id != null) {
        const resolve = this.pending.get(msg.id);
        if (resolve) {
          this.pending.delete(msg.id);
          resolve(msg);
        }
      }
    });
  }

  close(): void {
    this.rl.close();
    this.proc.kill();
  }

  private rpc(method: string, params: unknown): Promise<JsonRpcResponse> {
    const id = this.nextId++;
    return new Promise((resolve) => {
      this.pending.set(id, resolve);
      this.proc.stdin!.write(
        JSON.stringify({ jsonrpc: "2.0", id, method, params }) + "\n",
      );
    });
  }

  async initialize(): Promise<void> {
    await this.rpc("initialize", {
      protocolVersion: "2024-11-05",
      capabilities: {},
      clientInfo: { name: "integration-test", version: "1" },
    });
  }

  async call(tool: string, args: Record<string, unknown> = {}): Promise<string> {
    const resp = await this.rpc("tools/call", { name: tool, arguments: args });
    if (resp.error) throw new Error(`MCP error: ${resp.error.message}`);
    return resp.result?.content?.[0]?.text ?? "";
  }
}

// ── Helpers ───────────────────────────────────────────────────────────────────

async function waitForHealth(url: string, maxMs = 15_000): Promise<void> {
  const deadline = Date.now() + maxMs;
  while (Date.now() < deadline) {
    try {
      const res = await fetch(`${url}/health`);
      if (res.ok) return;
    } catch { /* not up yet */ }
    await new Promise((r) => setTimeout(r, 250));
  }
  throw new Error(`sirrd at ${url} did not become healthy within ${maxMs}ms`);
}

function dockerRun(): string {
  const result = spawnSync("docker", [
    "run", "-d", "--rm",
    "-p", `${SIRR_PORT}:39999`,
    "-e", `SIRR_MASTER_KEY=${SIRR_TOKEN}`,
    "-e", "SIRR_DATA_DIR=/tmp",
    "-e", "NO_BANNER=1",
    SIRRD_IMAGE,
    "serve",
  ]);
  if (result.status !== 0) {
    throw new Error(`docker run failed: ${result.stderr.toString()}`);
  }
  return result.stdout.toString().trim();
}

function dockerStop(id: string): void {
  spawnSync("docker", ["stop", id]);
}

// ── Fixtures ──────────────────────────────────────────────────────────────────

let containerId: string | undefined;
let sirrdProc: ChildProcess | undefined;
let client: McpClient;

beforeAll(async () => {
  if (USE_EXISTING) {
    // Mode 1: connect to an already-running server — nothing to spawn.
    process.stderr.write(`[integration] connecting to existing server at ${SIRR_SERVER}\n`);
  } else if (SIRRD_BINARY) {
    // Mode 2: spawn local binary — no Docker required.
    // Unique data dir per run avoids redb lock conflicts.
    const dataDir = `/tmp/sirrd-test-${Date.now()}`;
    sirrdProc = spawn(SIRRD_BINARY, ["serve"], {
      env: {
        ...process.env,
        SIRR_MASTER_KEY: SIRR_TOKEN,
        SIRR_DATA_DIR: dataDir,
        SIRR_PORT: String(SIRR_PORT),
        SIRR_HOST: "127.0.0.1",
        NO_BANNER: "1",
      },
      stdio: ["ignore", "ignore", "pipe"],
    });
    sirrdProc.stderr!.on("data", (d: Buffer) =>
      process.stderr.write(`[sirrd] ${d.toString()}`),
    );
  } else {
    // Mode 3: Docker.
    containerId = dockerRun();
  }
  await waitForHealth(SIRR_SERVER);

  const mcpProc = spawn("node", [MCP_BIN], {
    env: { ...process.env, SIRR_SERVER, SIRR_TOKEN },
    stdio: ["pipe", "pipe", "pipe"],
  });

  mcpProc.stderr!.on("data", (d: Buffer) => {
    const msg = d.toString();
    // Suppress expected startup warnings in test output
    if (!msg.includes("[sirr-mcp] Warning")) process.stderr.write(msg);
  });

  client = new McpClient(mcpProc);
  await client.initialize();
}, 30_000);

afterAll(() => {
  client?.close();
  // Only tear down servers we started — leave SIRR_SERVER (USE_EXISTING) server running.
  sirrdProc?.kill();
  if (containerId) dockerStop(containerId);
});

// ── Tests ─────────────────────────────────────────────────────────────────────

describe("health_check", () => {
  it("reports server ok", async () => {
    const text = await client.call("health_check");
    expect(text).toContain("ok");
    expect(text).toContain(SIRR_SERVER);
  });
});

describe("push_secret / get_secret", () => {
  it("stores and retrieves a bare key", async () => {
    await client.call("push_secret", { key: "INT_BARE", value: "bare-value" });
    const text = await client.call("get_secret", { key: "INT_BARE" });
    expect(text).toBe("bare-value");
  });

  it("retrieves via sirr: prefix", async () => {
    await client.call("push_secret", { key: "INT_PREFIX", value: "prefix-value" });
    const text = await client.call("get_secret", { key: "sirr:INT_PREFIX" });
    expect(text).toBe("prefix-value");
  });

  it("stores with ttl_seconds and reports expiry", async () => {
    const text = await client.call("push_secret", {
      key: "INT_TTL",
      value: "ttl-value",
      ttl_seconds: 3600,
    });
    expect(text).toContain("INT_TTL");
    expect(text).toContain("1h");
  });

  it("stores with max_reads and reports burn limit", async () => {
    const text = await client.call("push_secret", {
      key: "INT_READS",
      value: "reads-value",
      max_reads: 1,
    });
    expect(text).toContain("1 read(s)");
  });

  it("returns not-found message for missing key", async () => {
    const text = await client.call("get_secret", { key: "DOES_NOT_EXIST" });
    expect(text).toContain("not found");
  });

  it("burns a max_reads=1 secret after first read", async () => {
    await client.call("push_secret", { key: "INT_BURN", value: "burn-me", max_reads: 1 });
    await client.call("get_secret", { key: "INT_BURN" }); // consumes it
    const text = await client.call("get_secret", { key: "INT_BURN" });
    expect(text).toContain("not found");
  });
});

describe("list_secrets", () => {
  it("lists active secrets", async () => {
    await client.call("push_secret", { key: "INT_LIST", value: "listed" });
    const text = await client.call("list_secrets");
    expect(text).toContain("INT_LIST");
  });

  it("never includes secret values", async () => {
    await client.call("push_secret", { key: "INT_NOVALUE", value: "should-not-appear" });
    const text = await client.call("list_secrets");
    expect(text).not.toContain("should-not-appear");
  });
});

describe("delete_secret", () => {
  it("deletes an existing secret", async () => {
    await client.call("push_secret", { key: "INT_DEL", value: "to-delete" });
    const del = await client.call("delete_secret", { key: "INT_DEL" });
    expect(del).toContain("deleted");
    const get = await client.call("get_secret", { key: "INT_DEL" });
    expect(get).toContain("not found");
  });

  it("returns not-found for unknown key", async () => {
    const text = await client.call("delete_secret", { key: "NEVER_EXISTED" });
    expect(text).toContain("not found");
  });
});

describe("prune_secrets", () => {
  it("returns a pruned count", async () => {
    const text = await client.call("prune_secrets");
    expect(text).toMatch(/Pruned \d+ expired secret/);
  });
});

describe("check_secret", () => {
  it("HEAD does not consume a read", async () => {
    await client.call("push_secret", { key: "INT_CHECK", value: "check-val", max_reads: 2 });

    // check_secret should not decrement the read counter
    const checked = await client.call("check_secret", { key: "INT_CHECK" });
    expect(checked).toContain("active");
    expect(checked).toContain("2"); // reads remaining still 2

    // get_secret consumes one read — secret still available for second read
    const val = await client.call("get_secret", { key: "INT_CHECK" });
    expect(val).toBe("check-val");

    // verify read was counted: check again — 1 remaining
    const rechecked = await client.call("check_secret", { key: "INT_CHECK" });
    expect(rechecked).toContain("active");

    // cleanup
    await client.call("delete_secret", { key: "INT_CHECK" });
  });
});

describe("patch_secret", () => {
  it("updates TTL on an existing secret", async () => {
    await client.call("push_secret", { key: "INT_PATCH_TTL", value: "patch-target" });
    const text = await client.call("patch_secret", { key: "INT_PATCH_TTL", ttl_seconds: 7200 });
    expect(text).toContain("INT_PATCH_TTL");
    expect(text).toContain("2h");
    await client.call("delete_secret", { key: "INT_PATCH_TTL" });
  });

  it("updates max_reads on an existing secret", async () => {
    await client.call("push_secret", { key: "INT_PATCH_READS", value: "patch-reads" });
    const text = await client.call("patch_secret", { key: "INT_PATCH_READS", max_reads: 5 });
    expect(text).toContain("Max reads: 5");
    await client.call("delete_secret", { key: "INT_PATCH_READS" });
  });
});

describe("seal on burn (delete=false)", () => {
  it("seals instead of deletes when delete=false, then patch updates TTL", async () => {
    await client.call("push_secret", {
      key: "INT_SEAL",
      value: "seal-val",
      max_reads: 1,
      delete: false,
      ttl_seconds: 3600,
    });

    // consume the one read — server seals it
    const val = await client.call("get_secret", { key: "INT_SEAL" });
    expect(val).toBe("seal-val");

    // second read returns sealed / not found (410)
    const sealed = await client.call("get_secret", { key: "INT_SEAL" });
    expect(sealed).toContain("not found");

    // check_secret reports sealed status
    const status = await client.call("check_secret", { key: "INT_SEAL" });
    expect(status).toContain("sealed");

    // patch on a sealed secret extends TTL (server allows PATCH on sealed entries)
    const patched = await client.call("patch_secret", { key: "INT_SEAL", ttl_seconds: 7200 });
    expect(patched).toContain("INT_SEAL");
    expect(patched).toContain("2h");
  });
});

describe("org lifecycle", () => {
  it("create → list → delete", async () => {
    const orgName = `test-org-${Date.now()}`;
    let orgId: string | undefined;
    try {
      // create
      const created = await client.call("sirr_org_create", { name: orgName });
      expect(created).toContain(orgName);
      const idMatch = created.match(/ID:\s+(\S+)/);
      expect(idMatch).not.toBeNull();
      orgId = idMatch![1];

      // list — org appears
      const listed = await client.call("sirr_org_list");
      expect(listed).toContain(orgId);
      expect(listed).toContain(orgName);
    } finally {
      if (orgId) {
        const del = await client.call("sirr_org_delete", { org_id: orgId });
        expect(del).toContain("deleted");
      }
    }

    // deleted — no longer in list
    const afterDel = await client.call("sirr_org_list");
    if (orgId) expect(afterDel).not.toContain(orgId);
  });
});

describe("principal lifecycle", () => {
  it("create org + role + principal → list → delete all", async () => {
    const orgName = `test-org-princ-${Date.now()}`;
    let orgId: string | undefined;
    let principalId: string | undefined;

    try {
      // create org
      const orgCreated = await client.call("sirr_org_create", { name: orgName });
      const orgIdMatch = orgCreated.match(/ID:\s+(\S+)/);
      expect(orgIdMatch).not.toBeNull();
      orgId = orgIdMatch![1];

      // create custom role
      await client.call("sirr_role_create", { org_id: orgId, name: "tester", permissions: "CRL" });

      // create principal
      const princCreated = await client.call("sirr_principal_create", {
        org_id: orgId,
        name: "test-user",
        role: "tester",
      });
      expect(princCreated).toContain("test-user");
      const pidMatch = princCreated.match(/ID:\s+(\S+)/);
      expect(pidMatch).not.toBeNull();
      principalId = pidMatch![1];

      // list principals — appears
      const listed = await client.call("sirr_principal_list", { org_id: orgId });
      expect(listed).toContain("test-user");
      expect(listed).toContain("tester");
    } finally {
      // delete principal before org (required by server constraint)
      if (orgId && principalId) {
        await client.call("sirr_principal_delete", { org_id: orgId, principal_id: principalId });
      }
      if (orgId) {
        await client.call("sirr_org_delete", { org_id: orgId });
      }
    }
  });
});

describe("error handling", () => {
  it("surfaces timeout message when server is unreachable", async () => {
    // Spawn a separate MCP process pointing at a port nothing is listening on
    const badProc = spawn("node", [MCP_BIN], {
      env: { ...process.env, SIRR_SERVER: "http://127.0.0.1:19099", SIRR_TOKEN },
      stdio: ["pipe", "pipe", "pipe"],
    });
    const badClient = new McpClient(badProc);
    await badClient.initialize();
    const text = await badClient.call("health_check");
    badClient.close();
    // Either a timeout ("did not respond within") or connection refused ("Cannot reach")
    expect(text).toMatch(/did not respond within|Cannot reach/i);
  });
});
