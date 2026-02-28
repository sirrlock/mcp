#!/usr/bin/env node
/**
 * @sirrlock/mcp — MCP server for Sirr secret vault
 *
 * Exposes Sirr as MCP tools so Claude Code can read/write ephemeral secrets.
 *
 * Configuration (env vars):
 *   SIRR_SERVER  — Sirr server URL (default: http://localhost:39999)
 *   SIRR_TOKEN   — Bearer token: SIRR_MASTER_KEY for full access, or a principal key for org-scoped access
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
  process.env["SIRR_SERVER"] ?? "http://localhost:39999"
).replace(/\/$/, "");
const SIRR_TOKEN = process.env["SIRR_TOKEN"] ?? "";

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
      // Node fetch throws "fetch failed" for ECONNREFUSED and other network errors
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

interface SecretMeta {
  key: string;
  created_at: number;
  expires_at: number | null;
  max_reads: number | null;
  read_count: number;
}

const STATUS_HINTS: Record<number, string> = {
  401: "Check that SIRR_TOKEN matches SIRR_MASTER_KEY on the server. See sirr.dev/errors#401",
  402: "Free tier limit reached. See sirr.dev/errors#402",
  403: "This token does not have permission for this operation. See sirr.dev/errors#403",
  404: "Resource not found, expired, or burned. See sirr.dev/errors#404",
  409: "Conflict — the resource has dependencies that must be removed first. See sirr.dev/errors#409",
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

import { parseKeyRef, formatTtl, secretsPath, auditPath, webhooksPath, prunePath } from "./helpers";

// ── Tool definitions ──────────────────────────────────────────────────────────

const TOOLS: Tool[] = [
  {
    name: "get_secret",
    description:
      "Retrieve a secret from the Sirr vault by key name. " +
      "The secret's read counter is incremented — if it was set with max_reads=1 it will be deleted after this call. " +
      "Returns null if the secret does not exist, has expired, or has been burned. " +
      "Accepts bare key names, 'sirr:KEYNAME' references, or 'KEYNAME#id' format. " +
      "IMPORTANT: Do not store, log, memorize, or repeat the returned secret value beyond its immediate use. " +
      "Treat it as ephemeral — use it once for its intended purpose and discard it.",
    inputSchema: {
      type: "object" as const,
      properties: {
        key: {
          type: "string",
          description:
            "Secret key name. Accepts 'sirr:KEYNAME', 'KEYNAME#id', or bare key name.",
        },
      },
      required: ["key"],
    },
  },
  {
    name: "check_secret",
    description:
      "Check whether a secret exists and inspect its metadata — WITHOUT consuming a read. " +
      "Use this to verify a secret is still available before fetching it, or to inspect read counts and expiry. " +
      "Returns status (active/sealed), reads used/remaining, and expiry. " +
      "A 'sealed' secret has exhausted its max_reads; it still exists but cannot be read.",
    inputSchema: {
      type: "object" as const,
      properties: {
        key: {
          type: "string",
          description: "Secret key name. Accepts 'sirr:KEYNAME', 'KEYNAME#id', or bare key name.",
        },
      },
      required: ["key"],
    },
  },
  {
    name: "push_secret",
    description:
      "Store a secret in the Sirr vault. Optionally set a TTL (seconds) and/or a max read limit. " +
      "Use max_reads=1 for one-time credentials that burn after first access. " +
      "Use ttl_seconds for time-expiring secrets. " +
      "By default, the secret is deleted when burned. Set delete=false to seal it instead (returns 410 on subsequent reads).",
    inputSchema: {
      type: "object" as const,
      properties: {
        key: {
          type: "string",
          description: "Key name to store the secret under.",
        },
        value: {
          type: "string",
          description: "Secret value.",
        },
        ttl_seconds: {
          type: "number",
          description:
            "Optional TTL in seconds. Examples: 3600 (1h), 86400 (1d), 604800 (7d).",
        },
        max_reads: {
          type: "number",
          description: "Optional maximum read count. Set to 1 for a one-time secret.",
        },
        delete: {
          type: "boolean",
          description:
            "If false, the secret is sealed (returns 410) instead of deleted when burned. Default: true.",
        },
      },
      required: ["key", "value"],
    },
  },
  {
    name: "list_secrets",
    description:
      "List all active secrets in the Sirr vault. Returns metadata only — values are never included. " +
      "Shows key name, expiry time, and read count for each secret.",
    inputSchema: {
      type: "object" as const,
      properties: {},
    },
  },
  {
    name: "delete_secret",
    description:
      "Immediately delete (burn) a secret from the Sirr vault, regardless of TTL or read count.",
    inputSchema: {
      type: "object" as const,
      properties: {
        key: {
          type: "string",
          description: "Key name to delete.",
        },
      },
      required: ["key"],
    },
  },
  {
    name: "patch_secret",
    description:
      "Update an existing secret's value, TTL, or max read count. All fields are optional — only provided fields are changed.",
    inputSchema: {
      type: "object" as const,
      properties: {
        key: {
          type: "string",
          description: "Key name to update.",
        },
        value: {
          type: "string",
          description: "New secret value.",
        },
        ttl_seconds: {
          type: "number",
          description: "New TTL in seconds from now.",
        },
        max_reads: {
          type: "number",
          description: "New max read count.",
        },
      },
      required: ["key"],
    },
  },
  {
    name: "prune_secrets",
    description:
      "Trigger an immediate sweep of all expired secrets on the server. " +
      "Returns the count of secrets that were deleted.",
    inputSchema: {
      type: "object" as const,
      properties: {},
    },
  },
  {
    name: "health_check",
    description: "Check if the Sirr server is reachable and healthy.",
    inputSchema: {
      type: "object" as const,
      properties: {},
    },
  },
  {
    name: "sirr_audit",
    description:
      "Query the Sirr audit log. Returns recent events like secret creates, reads, deletes. " +
      "Useful for security monitoring and debugging access patterns.",
    inputSchema: {
      type: "object" as const,
      properties: {
        since: {
          type: "number",
          description: "Only return events after this Unix timestamp.",
        },
        until: {
          type: "number",
          description: "Only return events before this Unix timestamp.",
        },
        action: {
          type: "string",
          description: "Filter by action type (e.g. secret.create, secret.read, key.create).",
        },
        limit: {
          type: "number",
          description: "Maximum events to return (default: 100, max: 1000).",
        },
      },
    },
  },
  {
    name: "sirr_webhook_create",
    description:
      "Register a webhook URL to receive Sirr event notifications. " +
      "Returns the webhook ID and signing secret (shown once — save it).",
    inputSchema: {
      type: "object" as const,
      properties: {
        url: {
          type: "string",
          description: "Webhook endpoint URL (must start with http:// or https://).",
        },
        events: {
          type: "array",
          items: { type: "string" },
          description: "Event types to subscribe to (default: all). Examples: secret.created, secret.burned.",
        },
      },
      required: ["url"],
    },
  },
  {
    name: "sirr_webhook_list",
    description: "List all registered webhooks on the Sirr server. Signing secrets are redacted.",
    inputSchema: {
      type: "object" as const,
      properties: {},
    },
  },
  {
    name: "sirr_webhook_delete",
    description: "Remove a webhook registration by its ID.",
    inputSchema: {
      type: "object" as const,
      properties: {
        id: {
          type: "string",
          description: "Webhook ID to delete.",
        },
      },
      required: ["id"],
    },
  },
  {
    name: "sirr_key_list",
    description: "List all API keys for the current principal. Key values are never returned.",
    inputSchema: {
      type: "object" as const,
      properties: {},
    },
  },
  {
    name: "sirr_me",
    description:
      "Get the current authenticated user/org profile from the Sirr server. " +
      "Returns account details and current plan information.",
    inputSchema: {
      type: "object" as const,
      properties: {},
    },
  },
  {
    name: "sirr_update_me",
    description:
      "Update the current principal's metadata on the Sirr server.",
    inputSchema: {
      type: "object" as const,
      properties: {
        metadata: {
          type: "object",
          additionalProperties: { type: "string" },
          description: "Key/value metadata to set on the principal (replaces existing metadata).",
        },
      },
      required: ["metadata"],
    },
  },
  {
    name: "sirr_create_key",
    description:
      "Create a new API key for the current principal via /me/keys. " +
      "The raw key is returned once — save it immediately.",
    inputSchema: {
      type: "object" as const,
      properties: {
        name: {
          type: "string",
          description: "Human-readable name for the key.",
        },
        valid_for_seconds: {
          type: "number",
          description: "How long the key is valid, in seconds (default: 1 year).",
        },
        valid_before: {
          type: "number",
          description: "Explicit expiry as a Unix timestamp (alternative to valid_for_seconds).",
        },
      },
      required: ["name"],
    },
  },
  {
    name: "sirr_delete_key",
    description: "Revoke an API key belonging to the current principal.",
    inputSchema: {
      type: "object" as const,
      properties: {
        keyId: {
          type: "string",
          description: "API key ID to delete.",
        },
      },
      required: ["keyId"],
    },
  },
  // ── Org management ──────────────────────────────────────────────────────────
  {
    name: "sirr_org_create",
    description: "Create a new organization. Requires master key or sirr_admin permission.",
    inputSchema: {
      type: "object" as const,
      properties: {
        name: { type: "string", description: "Organization name (1–128 chars)." },
        metadata: {
          type: "object",
          additionalProperties: { type: "string" },
          description: "Optional key/value metadata.",
        },
      },
      required: ["name"],
    },
  },
  {
    name: "sirr_org_list",
    description: "List all organizations. Requires master key.",
    inputSchema: { type: "object" as const, properties: {} },
  },
  {
    name: "sirr_org_delete",
    description: "Delete an organization by ID. Org must have no principals. Requires master key.",
    inputSchema: {
      type: "object" as const,
      properties: {
        org_id: { type: "string", description: "Organization ID to delete." },
      },
      required: ["org_id"],
    },
  },
  // ── Principal management ─────────────────────────────────────────────────────
  {
    name: "sirr_principal_create",
    description: "Create a principal (user/service) in an organization.",
    inputSchema: {
      type: "object" as const,
      properties: {
        org_id: { type: "string", description: "Organization ID." },
        name: { type: "string", description: "Principal name (1–128 chars)." },
        role: { type: "string", description: "Role name (must exist in the org or be a built-in role)." },
        metadata: {
          type: "object",
          additionalProperties: { type: "string" },
          description: "Optional key/value metadata.",
        },
      },
      required: ["org_id", "name", "role"],
    },
  },
  {
    name: "sirr_principal_list",
    description: "List all principals in an organization.",
    inputSchema: {
      type: "object" as const,
      properties: {
        org_id: { type: "string", description: "Organization ID." },
      },
      required: ["org_id"],
    },
  },
  {
    name: "sirr_principal_delete",
    description: "Delete a principal from an organization. Principal must have no active keys.",
    inputSchema: {
      type: "object" as const,
      properties: {
        org_id: { type: "string", description: "Organization ID." },
        principal_id: { type: "string", description: "Principal ID to delete." },
      },
      required: ["org_id", "principal_id"],
    },
  },
  // ── Role management ──────────────────────────────────────────────────────────
  {
    name: "sirr_role_create",
    description:
      "Create a custom role in an organization. " +
      "Permissions are a letter string: C=create, R=read, P=patch, D=delete, L=list, M=manage, A=admin.",
    inputSchema: {
      type: "object" as const,
      properties: {
        org_id: { type: "string", description: "Organization ID." },
        name: { type: "string", description: "Role name (1–64 chars)." },
        permissions: {
          type: "string",
          description: "Permission letters, e.g. 'CRL' for create+read+list.",
        },
      },
      required: ["org_id", "name", "permissions"],
    },
  },
  {
    name: "sirr_role_list",
    description: "List all roles in an organization (built-in and custom).",
    inputSchema: {
      type: "object" as const,
      properties: {
        org_id: { type: "string", description: "Organization ID." },
      },
      required: ["org_id"],
    },
  },
  {
    name: "sirr_role_delete",
    description: "Delete a custom role from an organization. Cannot delete built-in roles or roles in use.",
    inputSchema: {
      type: "object" as const,
      properties: {
        org_id: { type: "string", description: "Organization ID." },
        role_name: { type: "string", description: "Role name to delete." },
      },
      required: ["org_id", "role_name"],
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
      case "get_secret": {
        const rawKey = (args as { key: string }).key;
        const key = parseKeyRef(rawKey);

        const res = await fetchWithTimeout(
          `${SIRR_SERVER}${secretsPath(encodeURIComponent(key))}`,
          { headers: { Authorization: `Bearer ${SIRR_TOKEN}` } },
        );

        if (res.status === 404 || res.status === 410) {
          return {
            content: [
              {
                type: "text" as const,
                text: `Secret '${key}' not found, expired, or already burned.`,
              },
            ],
          };
        }

        if (!res.ok) {
          let json: Record<string, unknown> = {};
          try { json = (await res.json()) as Record<string, unknown>; }
          catch { json = { error: await res.text().catch(() => "unknown") }; }
          throwSirrError(res.status, json);
        }

        const data = (await res.json()) as { value: string };

        return {
          content: [
            {
              type: "text" as const,
              text: data.value,
            },
            {
              type: "text" as const,
              text: "[Use immediately — do not store, log, or memorize this value.]",
            },
          ],
        };
      }

      case "check_secret": {
        const rawKey = (args as { key: string }).key;
        const key = parseKeyRef(rawKey);

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

      case "push_secret": {
        const { key, value: val, ttl_seconds, max_reads, delete: del } = args as {
          key: string;
          value: string;
          ttl_seconds?: number;
          max_reads?: number;
          delete?: boolean;
        };

        const body: Record<string, unknown> = { key, value: val };
        if (ttl_seconds != null) body.ttl_seconds = ttl_seconds;
        if (max_reads != null) body.max_reads = max_reads;
        if (del !== undefined) body.delete = del;
        await sirrRequest("POST", secretsPath(), body);

        const parts: string[] = [`Stored secret '${key}'.`];
        if (ttl_seconds) parts.push(`Expires in ${formatTtl(Math.floor(Date.now() / 1000) + ttl_seconds)}.`);
        if (max_reads) parts.push(`Burns after ${max_reads} read(s).`);
        if (del === false) parts.push("Sealed on burn (not deleted).");

        return {
          content: [{ type: "text" as const, text: parts.join(" ") }],
        };
      }

      case "list_secrets": {
        const data = await sirrRequest<{ secrets: SecretMeta[] }>(
          "GET",
          secretsPath(),
        );

        if (data.secrets.length === 0) {
          return {
            content: [{ type: "text" as const, text: "No active secrets." }],
          };
        }

        const lines = data.secrets.map((m) => {
          const expiry = formatTtl(m.expires_at);
          const reads =
            m.max_reads != null
              ? `${m.read_count}/${m.max_reads} reads`
              : `${m.read_count} reads`;
          return `• ${m.key} — ${expiry} — ${reads}`;
        });

        return {
          content: [
            {
              type: "text" as const,
              text: `${data.secrets.length} active secret(s):\n${lines.join("\n")}`,
            },
          ],
        };
      }

      case "delete_secret": {
        const { key } = args as { key: string };

        const res = await fetchWithTimeout(
          `${SIRR_SERVER}${secretsPath(encodeURIComponent(key))}`,
          {
            method: "DELETE",
            headers: { Authorization: `Bearer ${SIRR_TOKEN}` },
          },
        );

        if (res.status === 404) {
          return {
            content: [
              { type: "text" as const, text: `Secret '${key}' not found.` },
            ],
          };
        }

        if (!res.ok) {
          let json: Record<string, unknown> = {};
          try { json = (await res.json()) as Record<string, unknown>; }
          catch { json = { error: await res.text().catch(() => "unknown") }; }
          throwSirrError(res.status, json);
        }

        return {
          content: [
            {
              type: "text" as const,
              text: `Secret '${key}' deleted.`,
            },
          ],
        };
      }

      case "patch_secret": {
        const { key, value: val, ttl_seconds, max_reads } = args as {
          key: string; value?: string; ttl_seconds?: number; max_reads?: number;
        };
        const body: Record<string, unknown> = {};
        if (val !== undefined) body.value = val;
        if (ttl_seconds !== undefined) body.ttl_seconds = ttl_seconds;
        if (max_reads !== undefined) body.max_reads = max_reads;
        const data = await sirrRequest<{
          key: string; read_count: number; max_reads: number | null; expires_at: number | null;
        }>("PATCH", secretsPath(encodeURIComponent(key)), body);
        const parts: string[] = [`Secret '${key}' updated.`, `Expires: ${formatTtl(data.expires_at)}`];
        if (data.max_reads != null) parts.push(`Max reads: ${data.max_reads} (${data.read_count} used)`);
        return { content: [{ type: "text" as const, text: parts.join("\n  ") }] };
      }

      case "prune_secrets": {
        const data = await sirrRequest<{ pruned: number }>("POST", prunePath());
        return {
          content: [
            {
              type: "text" as const,
              text: `Pruned ${data.pruned} expired secret(s).`,
            },
          ],
        };
      }

      case "health_check": {
        const res = await fetchWithTimeout(`${SIRR_SERVER}/health`);

        if (!res.ok) {
          const json = (await res.json()) as Record<string, unknown>;
          throwSirrError(res.status, json);
        }

        const data = (await res.json()) as { status: string };
        return {
          content: [
            {
              type: "text" as const,
              text: `Sirr server status: ${data.status} (${SIRR_SERVER})`,
            },
          ],
        };
      }

      case "sirr_audit": {
        const { since, until, action, limit } = args as {
          since?: number;
          until?: number;
          action?: string;
          limit?: number;
        };
        const params = new URLSearchParams();
        if (since != null) params.set("since", String(since));
        if (until != null) params.set("until", String(until));
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
          content: [
            {
              type: "text" as const,
              text: `${data.events.length} audit event(s):\n${lines.join("\n")}`,
            },
          ],
        };
      }

      case "sirr_webhook_create": {
        const { url, events } = args as { url: string; events?: string[] };
        const body: Record<string, unknown> = { url };
        if (events) body.events = events;
        const data = await sirrRequest<{ id: string; secret: string }>(
          "POST",
          webhooksPath(),
          body,
        );

        return {
          content: [
            {
              type: "text" as const,
              text: `Webhook registered.\n  ID: ${data.id}\n  Secret: ${data.secret}\n  (Save the secret — it won't be shown again)`,
            },
          ],
        };
      }

      case "sirr_webhook_list": {
        const data = await sirrRequest<{
          webhooks: Array<{ id: string; url: string; events: string[]; created_at: number }>;
        }>("GET", webhooksPath());

        if (data.webhooks.length === 0) {
          return {
            content: [{ type: "text" as const, text: "No webhooks registered." }],
          };
        }

        const lines = data.webhooks.map(
          (w) => `• ${w.id} — ${w.url} [${w.events.join(",")}]`,
        );

        return {
          content: [
            {
              type: "text" as const,
              text: `${data.webhooks.length} webhook(s):\n${lines.join("\n")}`,
            },
          ],
        };
      }

      case "sirr_webhook_delete": {
        const { id } = args as { id: string };
        const res = await fetchWithTimeout(
          `${SIRR_SERVER}${webhooksPath(encodeURIComponent(id))}`,
          { method: "DELETE", headers: { Authorization: `Bearer ${SIRR_TOKEN}` } },
        );
        if (res.status === 404) {
          return { content: [{ type: "text" as const, text: `Webhook '${id}' not found.` }] };
        }
        if (!res.ok) {
          let json: Record<string, unknown> = {};
          try { json = (await res.json()) as Record<string, unknown>; }
          catch { json = { error: await res.text().catch(() => "unknown") }; }
          throwSirrError(res.status, json);
        }
        return { content: [{ type: "text" as const, text: `Webhook '${id}' deleted.` }] };
      }

      case "sirr_key_list": {
        const me = await sirrRequest<{
          keys: Array<{
            id: string;
            name: string;
            valid_after: number;
            valid_before: number;
            created_at: number;
          }>;
        }>("GET", "/me");

        if (!me.keys || me.keys.length === 0) {
          return {
            content: [{ type: "text" as const, text: "No API keys." }],
          };
        }

        const lines = me.keys.map(
          (k) =>
            `• ${k.id} — ${k.name} (expires ${new Date(k.valid_before * 1000).toISOString()})`,
        );

        return {
          content: [
            {
              type: "text" as const,
              text: `${me.keys.length} API key(s):\n${lines.join("\n")}`,
            },
          ],
        };
      }

      case "sirr_me": {
        const data = await sirrRequest<Record<string, unknown>>("GET", "/me");
        return {
          content: [
            {
              type: "text" as const,
              text: JSON.stringify(data, null, 2),
            },
          ],
        };
      }

      case "sirr_update_me": {
        const { metadata } = args as { metadata: Record<string, string> };
        const data = await sirrRequest<Record<string, unknown>>("PATCH", "/me", { metadata });
        return {
          content: [
            {
              type: "text" as const,
              text: `Profile updated.\n${JSON.stringify(data, null, 2)}`,
            },
          ],
        };
      }

      case "sirr_create_key": {
        const { name: keyName, valid_for_seconds, valid_before } = args as {
          name: string;
          valid_for_seconds?: number;
          valid_before?: number;
        };
        const body: Record<string, unknown> = { name: keyName };
        if (valid_for_seconds != null) body.valid_for_seconds = valid_for_seconds;
        if (valid_before != null) body.valid_before = valid_before;
        const data = await sirrRequest<{
          id: string;
          name: string;
          key: string;
          valid_after: number;
          valid_before: number;
        }>("POST", "/me/keys", body);

        return {
          content: [
            {
              type: "text" as const,
              text: `API key created.\n  ID: ${data.id}\n  Name: ${data.name}\n  Key: ${data.key}\n  Valid until: ${new Date(data.valid_before * 1000).toISOString()}\n  (Save the key — it won't be shown again)`,
            },
          ],
        };
      }

      case "sirr_delete_key": {
        const { keyId } = args as { keyId: string };
        const res = await fetchWithTimeout(
          `${SIRR_SERVER}/me/keys/${encodeURIComponent(keyId)}`,
          { method: "DELETE", headers: { Authorization: `Bearer ${SIRR_TOKEN}` } },
        );
        if (res.status === 404) {
          return { content: [{ type: "text" as const, text: `API key '${keyId}' not found.` }] };
        }
        if (!res.ok) {
          let json: Record<string, unknown> = {};
          try { json = (await res.json()) as Record<string, unknown>; }
          catch { json = { error: await res.text().catch(() => "unknown") }; }
          throwSirrError(res.status, json);
        }
        return { content: [{ type: "text" as const, text: `API key '${keyId}' deleted.` }] };
      }

      // ── Org management ────────────────────────────────────────────────────────

      case "sirr_org_create": {
        const { name: orgName, metadata } = args as { name: string; metadata?: Record<string, string> };
        const data = await sirrRequest<{ id: string; name: string }>(
          "POST", "/orgs", { name: orgName, metadata: metadata ?? {} },
        );
        return {
          content: [{ type: "text" as const, text: `Org created.\n  ID: ${data.id}\n  Name: ${data.name}` }],
        };
      }

      case "sirr_org_list": {
        const data = await sirrRequest<{
          orgs: Array<{ id: string; name: string; metadata: Record<string, string>; created_at: number }>;
        }>("GET", "/orgs");
        if (data.orgs.length === 0) {
          return { content: [{ type: "text" as const, text: "No organizations." }] };
        }
        const lines = data.orgs.map((o) => `• ${o.id} — ${o.name}`);
        return {
          content: [{ type: "text" as const, text: `${data.orgs.length} org(s):\n${lines.join("\n")}` }],
        };
      }

      case "sirr_org_delete": {
        const { org_id } = args as { org_id: string };
        const res = await fetchWithTimeout(
          `${SIRR_SERVER}/orgs/${encodeURIComponent(org_id)}`,
          { method: "DELETE", headers: { Authorization: `Bearer ${SIRR_TOKEN}` } },
        );
        if (res.status === 404) {
          return { content: [{ type: "text" as const, text: `Org '${org_id}' not found.` }] };
        }
        if (!res.ok) {
          let json: Record<string, unknown> = {};
          try { json = (await res.json()) as Record<string, unknown>; }
          catch { json = { error: await res.text().catch(() => "unknown") }; }
          throwSirrError(res.status, json);
        }
        return { content: [{ type: "text" as const, text: `Org '${org_id}' deleted.` }] };
      }

      // ── Principal management ──────────────────────────────────────────────────

      case "sirr_principal_create": {
        const { org_id, name: pName, role, metadata } = args as {
          org_id: string; name: string; role: string; metadata?: Record<string, string>;
        };
        const data = await sirrRequest<{ id: string; name: string; role: string; org_id: string }>(
          "POST", `/orgs/${encodeURIComponent(org_id)}/principals`,
          { name: pName, role, metadata: metadata ?? {} },
        );
        return {
          content: [{ type: "text" as const, text: `Principal created.\n  ID: ${data.id}\n  Name: ${data.name}\n  Role: ${data.role}` }],
        };
      }

      case "sirr_principal_list": {
        const { org_id } = args as { org_id: string };
        const data = await sirrRequest<{
          principals: Array<{ id: string; name: string; role: string; org_id: string; created_at: number }>;
        }>("GET", `/orgs/${encodeURIComponent(org_id)}/principals`);
        if (data.principals.length === 0) {
          return { content: [{ type: "text" as const, text: "No principals." }] };
        }
        const lines = data.principals.map((p) => `• ${p.id} — ${p.name} [${p.role}]`);
        return {
          content: [{ type: "text" as const, text: `${data.principals.length} principal(s):\n${lines.join("\n")}` }],
        };
      }

      case "sirr_principal_delete": {
        const { org_id, principal_id } = args as { org_id: string; principal_id: string };
        const res = await fetchWithTimeout(
          `${SIRR_SERVER}/orgs/${encodeURIComponent(org_id)}/principals/${encodeURIComponent(principal_id)}`,
          { method: "DELETE", headers: { Authorization: `Bearer ${SIRR_TOKEN}` } },
        );
        if (res.status === 404) {
          return { content: [{ type: "text" as const, text: `Principal '${principal_id}' not found.` }] };
        }
        if (!res.ok) {
          let json: Record<string, unknown> = {};
          try { json = (await res.json()) as Record<string, unknown>; }
          catch { json = { error: await res.text().catch(() => "unknown") }; }
          throwSirrError(res.status, json);
        }
        return { content: [{ type: "text" as const, text: `Principal '${principal_id}' deleted.` }] };
      }

      // ── Role management ───────────────────────────────────────────────────────

      case "sirr_role_create": {
        const { org_id, name: roleName, permissions } = args as {
          org_id: string; name: string; permissions: string;
        };
        const data = await sirrRequest<{ name: string; permissions: string; org_id: string }>(
          "POST", `/orgs/${encodeURIComponent(org_id)}/roles`,
          { name: roleName, permissions },
        );
        return {
          content: [{ type: "text" as const, text: `Role '${data.name}' created with permissions '${data.permissions}'.` }],
        };
      }

      case "sirr_role_list": {
        const { org_id } = args as { org_id: string };
        const data = await sirrRequest<{
          roles: Array<{ name: string; permissions: string; built_in: boolean; created_at: number }>;
        }>("GET", `/orgs/${encodeURIComponent(org_id)}/roles`);
        if (data.roles.length === 0) {
          return { content: [{ type: "text" as const, text: "No roles." }] };
        }
        const lines = data.roles.map(
          (r) => `• ${r.name} [${r.permissions}]${r.built_in ? " (built-in)" : ""}`,
        );
        return {
          content: [{ type: "text" as const, text: `${data.roles.length} role(s):\n${lines.join("\n")}` }],
        };
      }

      case "sirr_role_delete": {
        const { org_id, role_name } = args as { org_id: string; role_name: string };
        const res = await fetchWithTimeout(
          `${SIRR_SERVER}/orgs/${encodeURIComponent(org_id)}/roles/${encodeURIComponent(role_name)}`,
          { method: "DELETE", headers: { Authorization: `Bearer ${SIRR_TOKEN}` } },
        );
        if (res.status === 404) {
          return { content: [{ type: "text" as const, text: `Role '${role_name}' not found.` }] };
        }
        if (!res.ok) {
          let json: Record<string, unknown> = {};
          try { json = (await res.json()) as Record<string, unknown>; }
          catch { json = { error: await res.text().catch(() => "unknown") }; }
          throwSirrError(res.status, json);
        }
        return {
          content: [{ type: "text" as const, text: `Role '${role_name}' deleted.` }],
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
      `[sirr-mcp] Warning: SIRR_TOKEN is not set. See sirr.dev/errors#401\n`,
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
  // MCP servers communicate via stdio — no console output here
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
