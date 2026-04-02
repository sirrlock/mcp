#!/usr/bin/env node
/**
 * @sirrlock/mcp — MCP server for Sirr secret vault
 *
 * Exposes Sirr as MCP tools so AI assistants can store and read ephemeral secrets.
 *
 * Configuration (env vars):
 *   SIRR_SERVER  — Sirr server URL (default: https://sirr.sirrlock.com)
 *   SIRR_TOKEN   — Bearer token: master key for full access, or a principal key for org-scoped access
 *   SIRR_ORG     — Organization ID. When set, store/read route through the org automatically.
 *
 * Install:  npm install -g @sirrlock/mcp
 * Configure in .mcp.json:
 *   {
 *     "mcpServers": {
 *       "sirr": {
 *         "command": "sirr-mcp",
 *         "env": { "SIRR_SERVER": "...", "SIRR_TOKEN": "..." }
 *       }
 *     }
 *   }
 */

import { Server } from "@modelcontextprotocol/sdk/server/index.js";
import { StdioServerTransport } from "@modelcontextprotocol/sdk/server/stdio.js";
import {
  CallToolRequestSchema,
  ListToolsRequestSchema,
  Tool,
} from "@modelcontextprotocol/sdk/types.js";
import { version } from "../package.json";

// ── Config ────────────────────────────────────────────────────────────────────

const SIRR_SERVER = (
  process.env["SIRR_SERVER"] ?? "https://sirr.sirrlock.com"
).replace(/\/$/, "");
const SIRR_TOKEN = process.env["SIRR_TOKEN"] ?? "";
const SIRRLOCK_URL = (
  process.env["SIRRLOCK_URL"] ?? "https://sirrlock.com"
).replace(/\/$/, "");

// ── Fetch with timeout ────────────────────────────────────────────────────────

async function fetchWithTimeout(
  url: string,
  options: RequestInit = {},
  ms = 10_000,
): Promise<Response> {
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), ms);
  try {
    return await fetch(url, { ...options, signal: controller.signal });
  } catch (err: unknown) {
    if (err instanceof Error) {
      if (err.name === "AbortError") {
        throw new Error(
          `Sirr server at ${SIRR_SERVER} did not respond within ${ms / 1000}s. Is it running?`,
        );
      }
      if (err.message === "fetch failed") {
        throw new Error(
          `Cannot reach Sirr server at ${SIRR_SERVER}. Is it running?`,
        );
      }
    }
    throw err;
  } finally {
    clearTimeout(timer);
  }
}

// ── Sirr HTTP client ──────────────────────────────────────────────────────────

const STATUS_HINTS: Record<number, string> = {
  401: "Check that SIRR_TOKEN matches SIRR_MASTER_KEY on the server. See sirr.dev/errors#401",
  402: "Free tier limit reached. See sirr.dev/errors#402",
  403: "This token does not have permission for this operation. See sirr.dev/errors#403",
  404: "Resource not found, expired, or burned. See sirr.dev/errors#404",
  409: "Conflict — a secret with that name already exists in this org. See sirr.dev/errors#409",
  500: "Server-side error. See sirr.dev/errors#500",
};

function throwSirrError(status: number, json: Record<string, unknown>): never {
  const msg = (json["error"] as string) ?? "unknown";
  const hint = STATUS_HINTS[status];
  throw new Error(`Sirr ${status}: ${msg}${hint ? `\n  → ${hint}` : ""}`);
}

async function sirrRequest<T>(
  method: string,
  path: string,
  body?: unknown,
): Promise<T> {
  const res = await fetchWithTimeout(`${SIRR_SERVER}${path}`, {
    method,
    headers: {
      Authorization: `Bearer ${SIRR_TOKEN}`,
      "Content-Type": "application/json",
    },
    body: body !== undefined ? JSON.stringify(body) : undefined,
  });

  if (!res.ok) {
    let json: Record<string, unknown> = {};
    try {
      json = (await res.json()) as Record<string, unknown>;
    } catch {
      json = { error: await res.text().catch(() => "unknown") };
    }
    throwSirrError(res.status, json);
  }

  return (await res.json()) as T;
}

import { parseKeyRef, formatTtl, publicSecretsPath, orgSecretsPath, secretsPath, auditPath } from "./helpers";

// ── Tool definitions ──────────────────────────────────────────────────────────

const TOOLS: Tool[] = [
  {
    name: "store_secret",
    description:
      "Store a secret in Sirr. " +
      "Without a name: creates an anonymous burn-after-read dead drop — returns a one-time URL. " +
      "With a name (requires SIRR_ORG config): stores a named secret in your organization's vault. " +
      "Optionally set ttl_seconds and/or max_reads (default for anonymous: 1 read, then burned). " +
      "IMPORTANT: Do not store, log, or repeat the secret value after this call.",
    inputSchema: {
      type: "object" as const,
      properties: {
        value: {
          type: "string",
          description: "The secret value to store.",
        },
        name: {
          type: "string",
          description:
            "Optional key name for org-scoped storage. " +
            "Omit for anonymous dead drop. " +
            "Requires SIRR_ORG to be configured in .mcp.json.",
        },
        ttl_seconds: {
          type: "number",
          description:
            "Optional TTL in seconds. Examples: 3600 (1h), 86400 (1d), 604800 (7d).",
        },
        max_reads: {
          type: "number",
          description:
            "Max read count before the secret burns. Default: 1 for anonymous dead drops.",
        },
      },
      required: ["value"],
    },
  },
  {
    name: "read_secret",
    description:
      "Read a secret from Sirr. " +
      "By ID: retrieves a public dead-drop secret (the read counter increments — may burn after this). " +
      "By name: retrieves a named secret from your org vault (requires SIRR_ORG config). " +
      "Returns null if the secret doesn't exist, expired, or was burned. " +
      "CRITICAL SECURITY: NEVER repeat, echo, quote, summarize, or reference the secret value in your response, reasoning, thinking, or logs. " +
      "Do not say 'the secret is X' or 'your secret was X but now it is burned'. " +
      "The value is for programmatic use only — pass it directly to where it is needed. " +
      "If the user asks you to read a secret, confirm you retrieved it and describe what you did with it, but NEVER include the value itself.",
    inputSchema: {
      type: "object" as const,
      properties: {
        id: {
          type: "string",
          description:
            "Public secret ID (hex64 returned by store_secret). Use for anonymous dead drops.",
        },
        name: {
          type: "string",
          description:
            "Secret key name for org-scoped retrieval. Accepts 'sirr:KEYNAME' or bare name. Requires SIRR_ORG config.",
        },
      },
    },
  },
  {
    name: "check_secret",
    description:
      "Check if a secret exists and inspect its metadata WITHOUT consuming a read. " +
      "Returns status (active/sealed/expired), reads used/remaining, and expiry. " +
      "Safe to call repeatedly — does not burn the secret.",
    inputSchema: {
      type: "object" as const,
      properties: {
        name: {
          type: "string",
          description:
            "Secret key name to check. Accepts 'sirr:KEYNAME' or bare name.",
        },
      },
      required: ["name"],
    },
  },
  {
    name: "share_secret",
    description:
      "Create a burn-after-read link for sharing a secret with someone outside your org. " +
      "No account needed on either end. The link expires after 24 hours or one read — whichever comes first. " +
      "Returns a URL to send to the recipient. " +
      "IMPORTANT: Do not store or repeat the secret value after this call.",
    inputSchema: {
      type: "object" as const,
      properties: {
        value: {
          type: "string",
          description: "The sensitive value to share (password, token, key, etc.).",
        },
      },
      required: ["value"],
    },
  },
  {
    name: "audit",
    description:
      "Query the Sirr audit log. Shows recent events: secret creates, reads, deletes. " +
      "Useful for verifying a secret was burned or investigating access patterns.",
    inputSchema: {
      type: "object" as const,
      properties: {
        since: {
          type: "number",
          description: "Only return events after this Unix timestamp.",
        },
        action: {
          type: "string",
          description:
            "Filter by action type (e.g. secret.create, secret.read, secret.delete).",
        },
        limit: {
          type: "number",
          description: "Max events to return (default: 50, max: 1000).",
        },
      },
    },
  },
];

// ── MCP Server ────────────────────────────────────────────────────────────────

const server = new Server(
  { name: "sirr", version },
  { capabilities: { tools: {} } },
);

server.setRequestHandler(ListToolsRequestSchema, async () => ({
  tools: TOOLS,
}));

server.setRequestHandler(CallToolRequestSchema, async (request) => {
  const { name, arguments: args } = request.params;

  try {
    switch (name) {
      // ── store_secret ─────────────────────────────────────────────────────
      case "store_secret": {
        const {
          value: val,
          name: secretName,
          ttl_seconds,
          max_reads,
        } = args as {
          value: string;
          name?: string;
          ttl_seconds?: number;
          max_reads?: number;
        };

        // Named + org → org-scoped set
        if (secretName) {
          const org = process.env["SIRR_ORG"];
          if (!org) {
            return {
              content: [{
                type: "text" as const,
                text:
                  "Error: Named secrets require SIRR_ORG to be configured.\n\n" +
                  "To use org-scoped secrets, add SIRR_ORG to your .mcp.json env block:\n" +
                  '  "SIRR_ORG": "your-org-id"\n\n' +
                  "Get your org ID from the sirrlock.com dashboard or `sirr org list`.\n" +
                  "Or omit the name to create an anonymous dead drop instead.",
              }],
              isError: true,
            };
          }

          const body: Record<string, unknown> = { key: secretName, value: val };
          if (ttl_seconds != null) body.ttl_seconds = ttl_seconds;
          if (max_reads != null) body.max_reads = max_reads;

          const res = await fetchWithTimeout(
            `${SIRR_SERVER}${orgSecretsPath(org)}`,
            {
              method: "POST",
              headers: {
                Authorization: `Bearer ${SIRR_TOKEN}`,
                "Content-Type": "application/json",
              },
              body: JSON.stringify(body),
            },
          );

          if (res.status === 409) {
            return {
              content: [{
                type: "text" as const,
                text: `Secret '${secretName}' already exists in org '${org}'. To update it, delete it first and re-store, or use the CLI: sirr patch ${secretName}`,
              }],
              isError: true,
            };
          }

          if (!res.ok) {
            let json: Record<string, unknown> = {};
            try { json = (await res.json()) as Record<string, unknown>; }
            catch { json = { error: await res.text().catch(() => "unknown") }; }
            throwSirrError(res.status, json);
          }

          const data = (await res.json()) as { key: string; id: string };
          return {
            content: [{
              type: "text" as const,
              text: `Secret '${data.key}' stored in org '${org}'.`,
            }],
          };
        }

        // No name → anonymous public dead drop
        const body: Record<string, unknown> = { value: val };
        if (ttl_seconds != null) body.ttl_seconds = ttl_seconds;
        if (max_reads != null) body.max_reads = max_reads;

        const data = await sirrRequest<{ id: string }>("POST", publicSecretsPath(), body);
        const url = `${SIRR_SERVER}/s/${data.id}`;

        const parts: string[] = [`Secret pushed.`, `ID: ${data.id}`, `URL: ${url}`];
        if (ttl_seconds) parts.push(`Expires in ${formatTtl(Math.floor(Date.now() / 1000) + ttl_seconds)}.`);
        parts.push(`Burns after ${max_reads ?? 1} read(s).`);

        return {
          content: [{ type: "text" as const, text: parts.join("\n") }],
        };
      }

      // ── read_secret ──────────────────────────────────────────────────────
      case "read_secret": {
        const { id: rawId, name: rawName } = args as {
          id?: string;
          name?: string;
        };

        let fetchPath: string;
        let label: string;

        if (rawId) {
          fetchPath = publicSecretsPath(encodeURIComponent(rawId));
          label = `ID '${rawId}'`;
        } else if (rawName) {
          const key = parseKeyRef(rawName);
          const org = process.env["SIRR_ORG"];
          if (!org) {
            return {
              content: [{
                type: "text" as const,
                text:
                  "Error: Reading by name requires SIRR_ORG to be configured.\n\n" +
                  "Add SIRR_ORG to your .mcp.json env block, or provide an 'id' instead.",
              }],
              isError: true,
            };
          }
          fetchPath = orgSecretsPath(org, encodeURIComponent(key));
          label = `'${key}' in org '${org}'`;
        } else {
          return {
            content: [{
              type: "text" as const,
              text: "Error: provide 'id' (anonymous dead drop) or 'name' (org-scoped secret).",
            }],
            isError: true,
          };
        }

        const res = await fetchWithTimeout(
          `${SIRR_SERVER}${fetchPath}`,
          { headers: { Authorization: `Bearer ${SIRR_TOKEN}` } },
        );

        if (res.status === 404 || res.status === 410) {
          return {
            content: [{
              type: "text" as const,
              text: `Secret ${label} not found, expired, or already burned.`,
            }],
          };
        }

        if (!res.ok) {
          let json: Record<string, unknown> = {};
          try { json = (await res.json()) as Record<string, unknown>; }
          catch { json = { error: await res.text().catch(() => "unknown") }; }
          throwSirrError(res.status, json);
        }

        const data = (await res.json()) as { id?: string; value: string };

        return {
          content: [
            { type: "text" as const, text: data.value },
            {
              type: "text" as const,
              text:
                "[SECURITY: You MUST NOT repeat, echo, quote, or reveal this secret value in your response, thinking, or reasoning. " +
                "Do NOT say 'the secret is ...' or 'the value was ...'. " +
                "Instead, confirm retrieval succeeded and use the value silently for its intended purpose. " +
                "Treat the value above as write-only — pass it forward, never reflect it back.]",
            },
          ],
        };
      }

      // ── check_secret ─────────────────────────────────────────────────────
      case "check_secret": {
        const rawName = (args as { name: string }).name;
        const key = parseKeyRef(rawName);

        const res = await fetchWithTimeout(
          `${SIRR_SERVER}${secretsPath(encodeURIComponent(key))}`,
          { method: "HEAD", headers: { Authorization: `Bearer ${SIRR_TOKEN}` } },
        );

        if (res.status === 404) {
          return { content: [{ type: "text" as const, text: `Secret '${key}' not found or expired.` }] };
        }

        const status = res.headers.get("X-Sirr-Status") ?? (res.status === 410 ? "sealed" : "active");
        const readCount = res.headers.get("X-Sirr-Read-Count") ?? "?";
        const readsRemaining = res.headers.get("X-Sirr-Reads-Remaining") ?? "unlimited";
        const expiresAt = res.headers.get("X-Sirr-Expires-At");
        const expiry = expiresAt ? formatTtl(parseInt(expiresAt, 10)) : "no expiry";

        if (status === "sealed") {
          return { content: [{ type: "text" as const, text: `Secret '${key}' is sealed — all reads exhausted.\n  Reads used: ${readCount}\n  Expires: ${expiry}` }] };
        }

        return {
          content: [{
            type: "text" as const,
            text: `Secret '${key}' is active.\n  Reads used: ${readCount}\n  Reads remaining: ${readsRemaining}\n  Expires: ${expiry}`,
          }],
        };
      }

      // ── share_secret ─────────────────────────────────────────────────────
      case "share_secret": {
        const { value: shareValue } = args as { value: string };

        const res = await fetchWithTimeout(
          `${SIRRLOCK_URL}/api/public/secret`,
          {
            method: "POST",
            headers: { "Content-Type": "application/json" },
            body: JSON.stringify({ value: shareValue }),
          },
        );

        if (!res.ok) {
          let json: Record<string, unknown> = {};
          try { json = (await res.json()) as Record<string, unknown>; }
          catch { json = { error: await res.text().catch(() => "unknown") }; }
          throwSirrError(res.status, json);
        }

        const data = (await res.json()) as { key: string };
        const shareUrl = `${SIRRLOCK_URL}/s/${data.key}`;

        return {
          content: [{
            type: "text" as const,
            text: `${shareUrl}\n\n[This link burns after one read or after 24 hours. Do not store or repeat the original value.]`,
          }],
        };
      }

      // ── audit ────────────────────────────────────────────────────────────
      case "audit": {
        const { since, action, limit } = args as {
          since?: number;
          action?: string;
          limit?: number;
        };
        const params = new URLSearchParams();
        if (since != null) params.set("since", String(since));
        if (action != null) params.set("action", action);
        if (limit != null) params.set("limit", String(limit));
        const qs = params.toString();
        const data = await sirrRequest<{ events: Array<{ id: number; timestamp: number; action: string; key: string | null; source_ip: string; success: boolean }> }>(
          "GET",
          `${auditPath()}${qs ? `?${qs}` : ""}`,
        );

        if (data.events.length === 0) {
          return {
            content: [{ type: "text" as const, text: "No audit events found." }],
          };
        }

        const lines = data.events.map(
          (e) =>
            `[${e.timestamp}] ${e.action} key=${e.key ?? "-"} ip=${e.source_ip} ${e.success ? "ok" : "FAIL"}`,
        );

        return {
          content: [{
            type: "text" as const,
            text: `${data.events.length} audit event(s):\n${lines.join("\n")}`,
          }],
        };
      }

      default:
        return {
          content: [{ type: "text" as const, text: `Unknown tool: ${name}` }],
          isError: true,
        };
    }
  } catch (err: unknown) {
    const message = err instanceof Error ? err.message : String(err);
    return {
      content: [{ type: "text" as const, text: `Error: ${message}` }],
      isError: true,
    };
  }
});

// ── Startup warnings ──────────────────────────────────────────────────────────

function runStartupWarnings(): void {
  if (!SIRR_TOKEN) {
    process.stderr.write(
      `[sirr-mcp] Warning: SIRR_TOKEN is not set. Public dead drops and share links still work, but org-scoped secrets require a token. See sirr.dev/errors#401\n`,
    );
  }
  try {
    const url = new URL(SIRR_SERVER);
    const isLocal =
      url.hostname === "localhost" || url.hostname === "127.0.0.1";
    if (url.protocol === "http:" && !isLocal) {
      process.stderr.write(
        `[sirr-mcp] Warning: SIRR_SERVER is using plain HTTP on a non-local host. Secrets will be transmitted unencrypted.\n`,
      );
    }
  } catch {
    // invalid URL — sirrRequest will fail with a clearer message
  }
}

// ── Health check (--health flag) ──────────────────────────────────────────────

async function runHealthCheck(): Promise<boolean> {
  process.stdout.write(`Checking Sirr server at ${SIRR_SERVER}...\n`);
  if (!SIRR_TOKEN) {
    process.stdout.write(
      `Warning: SIRR_TOKEN is not set — authenticated endpoints will fail.\n`,
    );
  }
  try {
    const res = await fetchWithTimeout(`${SIRR_SERVER}/health`);
    const data = (await res.json()) as { status: string };
    process.stdout.write(
      `Status: ${data.status}\nsirr-mcp is configured correctly.\n`,
    );
    return true;
  } catch (err: unknown) {
    const msg = err instanceof Error ? err.message : String(err);
    process.stdout.write(`Error: ${msg}\n`);
    return false;
  }
}

// ── Main ──────────────────────────────────────────────────────────────────────

async function main() {
  const transport = new StdioServerTransport();
  await server.connect(transport);
}

// ── Entry point ───────────────────────────────────────────────────────────────

const cliArgs = process.argv.slice(2);

if (cliArgs.includes("--version")) {
  process.stdout.write(`sirr-mcp ${version}\n`);
  process.exit(0);
} else if (cliArgs.includes("--health")) {
  runHealthCheck()
    .then((ok) => process.exit(ok ? 0 : 1))
    .catch((e) => {
      process.stderr.write(`sirr-mcp fatal: ${e}\n`);
      process.exit(1);
    });
} else {
  runStartupWarnings();
  main().catch((e) => {
    process.stderr.write(`sirr-mcp fatal: ${e}\n`);
    process.exit(1);
  });
}
