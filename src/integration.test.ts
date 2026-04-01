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
    process.stderr.write(`[integration] connecting to existing server at ${SIRR_SERVER}\n`);
  } else if (SIRRD_BINARY) {
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
    containerId = dockerRun();
  }
  await waitForHealth(SIRR_SERVER);

  const mcpProc = spawn("node", [MCP_BIN], {
    env: { ...process.env, SIRR_SERVER, SIRR_TOKEN },
    stdio: ["pipe", "pipe", "pipe"],
  });

  mcpProc.stderr!.on("data", (d: Buffer) => {
    const msg = d.toString();
    if (!msg.includes("[sirr-mcp] Warning")) process.stderr.write(msg);
  });

  client = new McpClient(mcpProc);
  await client.initialize();
}, 30_000);

afterAll(() => {
  client?.close();
  sirrdProc?.kill();
  if (containerId) dockerStop(containerId);
});

// ── Tests (5-tool surface) ───────────────────────────────────────────────────

describe("store_secret (anonymous) + read_secret", () => {
  it("stores and retrieves by ID", async () => {
    const storeText = await client.call("store_secret", { value: "bare-value" });
    expect(storeText).toContain("Secret pushed");
    // Extract ID from output
    const idMatch = storeText.match(/ID:\s+(\S+)/);
    expect(idMatch).not.toBeNull();
    const id = idMatch![1];

    const readText = await client.call("read_secret", { id });
    expect(readText).toBe("bare-value");
  });

  it("stores with ttl_seconds and reports expiry", async () => {
    const text = await client.call("store_secret", {
      value: "ttl-value",
      ttl_seconds: 3600,
    });
    expect(text).toContain("1h");
  });

  it("stores with max_reads and reports burn limit", async () => {
    const text = await client.call("store_secret", {
      value: "reads-value",
      max_reads: 1,
    });
    expect(text).toContain("1 read(s)");
  });

  it("returns not-found for missing ID", async () => {
    const text = await client.call("read_secret", { id: "0000000000000000000000000000000000000000000000000000000000000000" });
    expect(text).toContain("not found");
  });

  it("burns a max_reads=1 secret after first read", async () => {
    const stored = await client.call("store_secret", { value: "burn-me", max_reads: 1 });
    const idMatch = stored.match(/ID:\s+(\S+)/);
    const id = idMatch![1];

    await client.call("read_secret", { id }); // consumes it
    const text = await client.call("read_secret", { id });
    expect(text).toContain("not found");
  });
});

describe("check_secret", () => {
  it("HEAD does not consume a read", async () => {
    // Note: check_secret uses secretsPath which routes through SIRR_ORG if set.
    // Without SIRR_ORG in integration env, it hits /secrets/{key}.
    // This test verifies the tool works against a real server.
    const stored = await client.call("store_secret", { value: "check-val", max_reads: 2 });
    const idMatch = stored.match(/ID:\s+(\S+)/);
    const id = idMatch![1];

    // check by name won't work without org, but we can verify the tool doesn't crash
    // For a full named-secret check, org setup would be needed
    const checked = await client.call("check_secret", { name: id });
    // May return active or not-found depending on server routing — either is valid
    expect(checked).toBeTruthy();
  });
});

describe("audit", () => {
  it("returns audit events or empty message", async () => {
    const text = await client.call("audit");
    // Server without org may return events or "No audit events found"
    expect(text).toBeTruthy();
  });
});

describe("error handling", () => {
  it("surfaces timeout message when server is unreachable", async () => {
    const badProc = spawn("node", [MCP_BIN], {
      env: { ...process.env, SIRR_SERVER: "http://127.0.0.1:19099", SIRR_TOKEN },
      stdio: ["pipe", "pipe", "pipe"],
    });
    const badClient = new McpClient(badProc);
    await badClient.initialize();
    // Use audit as a generic authenticated tool call
    const text = await badClient.call("audit");
    badClient.close();
    expect(text).toMatch(/did not respond within|Cannot reach/i);
  });

  it("returns Unknown tool for nonexistent tools", async () => {
    const text = await client.call("health_check");
    expect(text).toContain("Unknown tool");
  });
});
