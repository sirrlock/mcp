/**
 * Multi-tenant E2E: two companies on one server, full isolation via MCP tools.
 * NO license key — tests the real free-tier experience.
 *
 * Run with:
 *   SIRRD_BINARY=/path/to/sirrd npm run build && npx jest --testPathPatterns=e2e-multitenant --forceExit
 */

import {
  describe,
  it,
  expect,
  beforeAll,
  afterAll,
} from "@jest/globals";
import { spawn, ChildProcess } from "child_process";
import { createInterface, Interface } from "readline";
import { mkdtempSync, rmSync } from "fs";
import { tmpdir } from "os";
import { join } from "path";

// ── Config ──────���─────────────────────────────────────────────────────────────

const PORT = 39993;
const BASE = `http://localhost:${PORT}`;
const MASTER_KEY = "mcp-mt-e2e-master-key";
const MCP_BIN = `${__dirname}/../dist/index.js`;

// ── MCP JSON-RPC client ─────────��─────────────────────────────────────────────

interface JsonRpcResponse {
  jsonrpc: "2.0";
  id: number;
  result?: { content?: Array<{ type: string; text: string }>; isError?: boolean };
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
      clientInfo: { name: "mt-e2e-test", version: "1" },
    });
  }

  async call(tool: string, args: Record<string, unknown> = {}): Promise<string> {
    const resp = await this.rpc("tools/call", { name: tool, arguments: args });
    if (resp.error) throw new Error(`MCP error: ${resp.error.message}`);
    return resp.result?.content?.[0]?.text ?? "";
  }

  /** Returns true if the response was flagged as an error. */
  async callRaw(tool: string, args: Record<string, unknown> = {}): Promise<{ text: string; isError: boolean }> {
    const resp = await this.rpc("tools/call", { name: tool, arguments: args });
    if (resp.error) throw new Error(`MCP error: ${resp.error.message}`);
    return {
      text: resp.result?.content?.[0]?.text ?? "",
      isError: resp.result?.isError ?? false,
    };
  }
}

// ── Spawn MCP client for a given principal ────────────────────────────────────

function spawnMcp(token: string, org?: string): ChildProcess {
  const env: Record<string, string> = {
    ...process.env as Record<string, string>,
    SIRR_SERVER: BASE,
    SIRR_TOKEN: token,
  };
  if (org) env.SIRR_ORG = org;
  // Ensure SIRRLOCK_URL doesn't leak to real sirrlock.com
  env.SIRRLOCK_URL = BASE;

  const proc = spawn("node", [MCP_BIN], {
    env,
    stdio: ["pipe", "pipe", "pipe"],
  });
  // Suppress warnings
  proc.stderr!.on("data", () => {});
  return proc;
}

// ── Helpers ───────────────────────────────────────────────────────────────────

async function waitForHealth(retries = 30): Promise<void> {
  for (let i = 0; i < retries; i++) {
    try {
      const r = await fetch(`${BASE}/health`);
      if (r.ok) return;
    } catch {}
    await new Promise((r) => setTimeout(r, 200));
  }
  throw new Error("sirrd did not start in time");
}

/** Raw HTTP helper for admin ops (MCP doesn't expose org/principal management). */
async function adminPost<T>(path: string, body: unknown): Promise<T> {
  const res = await fetch(`${BASE}${path}`, {
    method: "POST",
    headers: {
      Authorization: `Bearer ${MASTER_KEY}`,
      "Content-Type": "application/json",
    },
    body: JSON.stringify(body),
  });
  if (!res.ok) {
    const text = await res.text();
    throw new Error(`Admin ${path} failed: ${res.status} ${text}`);
  }
  return (await res.json()) as T;
}

// ── Fixtures ──────────────────────────────────────────────────────────────────

let sirrd: ChildProcess;
let dataDir: string;

// Principals
let acmeId: string;
let globexId: string;

let aliceKey: string;
let bobKey: string;
let carolKey: string;
let hankKey: string;

// MCP clients (one per principal)
let alice: McpClient;
let bob: McpClient;
let carol: McpClient;
let hank: McpClient;
let anon: McpClient;

beforeAll(async () => {
  dataDir = mkdtempSync(join(tmpdir(), "sirr-mcp-mt-"));

  const sirrdBin = process.env.SIRRD_BINARY ?? process.env.SIRRD_BIN ?? "sirrd";
  sirrd = spawn(sirrdBin, ["serve", "--port", String(PORT)], {
    env: {
      ...process.env,
      SIRR_MASTER_API_KEY: MASTER_KEY,
      SIRR_DATA_DIR: dataDir,
      SIRR_RATE_LIMIT_PER_SECOND: "1000",
      SIRR_RATE_LIMIT_BURST: "1000",
    },
    stdio: ["ignore", "pipe", "pipe"],
  });

  await waitForHealth();

  // ── Create orgs + principals + keys via raw HTTP ────────────────────────

  const acme = await adminPost<{ id: string }>("/orgs", { name: "acme" });
  acmeId = acme.id;

  const aliceP = await adminPost<{ id: string }>(`/orgs/${acmeId}/principals`, { name: "alice", role: "owner" });
  const bobP = await adminPost<{ id: string }>(`/orgs/${acmeId}/principals`, { name: "bob", role: "writer" });
  const carolP = await adminPost<{ id: string }>(`/orgs/${acmeId}/principals`, { name: "carol", role: "reader" });

  const aliceKR = await adminPost<{ key: string }>(`/orgs/${acmeId}/principals/${aliceP.id}/keys`, { name: "alice-key" });
  const bobKR = await adminPost<{ key: string }>(`/orgs/${acmeId}/principals/${bobP.id}/keys`, { name: "bob-key" });
  const carolKR = await adminPost<{ key: string }>(`/orgs/${acmeId}/principals/${carolP.id}/keys`, { name: "carol-key" });

  aliceKey = aliceKR.key;
  bobKey = bobKR.key;
  carolKey = carolKR.key;

  const globex = await adminPost<{ id: string }>("/orgs", { name: "globex" });
  globexId = globex.id;

  const hankP = await adminPost<{ id: string }>(`/orgs/${globexId}/principals`, { name: "hank", role: "owner" });
  const hankKR = await adminPost<{ key: string }>(`/orgs/${globexId}/principals/${hankP.id}/keys`, { name: "hank-key" });
  hankKey = hankKR.key;

  // ── Spawn MCP clients ──────────────────────────────────────────────────

  alice = new McpClient(spawnMcp(aliceKey, acmeId));
  bob = new McpClient(spawnMcp(bobKey, acmeId));
  carol = new McpClient(spawnMcp(carolKey, acmeId));
  hank = new McpClient(spawnMcp(hankKey, globexId));
  anon = new McpClient(spawnMcp(""));

  await Promise.all([
    alice.initialize(),
    bob.initialize(),
    carol.initialize(),
    hank.initialize(),
    anon.initialize(),
  ]);
}, 30_000);

afterAll(() => {
  alice?.close();
  bob?.close();
  carol?.close();
  hank?.close();
  anon?.close();
  sirrd?.kill();
  try { rmSync(dataDir, { recursive: true }); } catch {}
});

// ── Tests ────────────────────────────────────────────────────────────────────

describe("acme secrets via MCP", () => {
  it("alice (owner) stores and reads DB_URL", async () => {
    const storeText = await alice.call("store_secret", { value: "postgres://acme-db:5432/acme", name: "DB_URL", max_reads: 10 });
    expect(storeText).toContain("DB_URL");
    expect(storeText).toContain("stored");

    const readText = await alice.call("read_secret", { name: "DB_URL" });
    expect(readText).toBe("postgres://acme-db:5432/acme");
  });

  it("bob (writer) stores and reads API_KEY", async () => {
    const storeText = await bob.call("store_secret", { value: "acme-api-key-42", name: "API_KEY", max_reads: 10 });
    expect(storeText).toContain("API_KEY");

    const readText = await bob.call("read_secret", { name: "API_KEY" });
    expect(readText).toBe("acme-api-key-42");
  });

  it("carol (reader) cannot store secrets", async () => {
    const result = await carol.callRaw("store_secret", { value: "denied", name: "NOPE" });
    expect(result.text).toContain("Error:");
    expect(result.text).toContain("403");
  });
});

describe("globex secrets via MCP", () => {
  it("hank (owner) stores DB_URL — same key name as acme", async () => {
    const storeText = await hank.call("store_secret", { value: "postgres://globex-db:5432/globex", name: "DB_URL", max_reads: 10 });
    expect(storeText).toContain("DB_URL");

    const readText = await hank.call("read_secret", { name: "DB_URL" });
    expect(readText).toBe("postgres://globex-db:5432/globex");
  });
});

describe("org isolation — same key name, different values", () => {
  it("acme DB_URL still has acme value", async () => {
    const text = await alice.call("read_secret", { name: "DB_URL" });
    expect(text).toBe("postgres://acme-db:5432/acme");
  });

  it("globex DB_URL has globex value", async () => {
    const text = await hank.call("read_secret", { name: "DB_URL" });
    expect(text).toBe("postgres://globex-db:5432/globex");
  });
});

describe("cross-org isolation via MCP", () => {
  it("hank's MCP (globex org) cannot read acme secrets via name", async () => {
    // hank's MCP is configured with globexId — reading DB_URL goes to globex, not acme
    // This tests that the MCP env-scoping works correctly
    const text = await hank.call("read_secret", { name: "API_KEY" });
    // API_KEY exists in acme but not globex → not found
    expect(text).toContain("not found");
  });

  it("alice's MCP (acme org) cannot read globex-only secrets", async () => {
    // Store a globex-only secret
    await hank.call("store_secret", { value: "globex-only", name: "GLOBEX_ONLY", max_reads: 10 });
    const text = await alice.call("read_secret", { name: "GLOBEX_ONLY" });
    expect(text).toContain("not found");
  });
});

describe("public dead drop via MCP", () => {
  it("anonymous store and read by ID", async () => {
    const storeText = await anon.call("store_secret", { value: "hello-from-mcp" });
    expect(storeText).toContain("Secret pushed");

    const idMatch = storeText.match(/ID:\s+(\S+)/);
    expect(idMatch).not.toBeNull();
    const id = idMatch![1];

    const readText = await anon.call("read_secret", { id });
    expect(readText).toBe("hello-from-mcp");
  });
});

describe("burn-after-read via MCP", () => {
  it("first read returns value, second returns not-found", async () => {
    await alice.call("store_secret", { value: "burnme-mcp", name: "BURN_MCP", max_reads: 1 });

    const first = await alice.call("read_secret", { name: "BURN_MCP" });
    expect(first).toBe("burnme-mcp");

    const second = await alice.call("read_secret", { name: "BURN_MCP" });
    expect(second).toContain("not found");
  });
});

describe("check_secret via MCP", () => {
  it("check does not consume a read", async () => {
    await alice.call("store_secret", { value: "check-me", name: "CHECK_MCP", max_reads: 2 });

    const check1 = await alice.call("check_secret", { name: "CHECK_MCP" });
    expect(check1).toContain("active");
    expect(check1).toContain("Reads used: 0");

    // Read once
    await alice.call("read_secret", { name: "CHECK_MCP" });

    const check2 = await alice.call("check_secret", { name: "CHECK_MCP" });
    expect(check2).toContain("active");
    expect(check2).toContain("Reads used: 1");
    expect(check2).toContain("Reads remaining: 1");
  });
});

describe("audit via MCP", () => {
  it("returns events from org activity", async () => {
    const text = await alice.call("audit");
    expect(text).toContain("audit event(s)");
    expect(text).toContain("secret.");
  });
});
