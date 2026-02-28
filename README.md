# @sirrlock/mcp — Sirr MCP Server

[![npm version](https://img.shields.io/npm/v/@sirrlock/mcp)](https://www.npmjs.com/package/@sirrlock/mcp)
[![npm downloads](https://img.shields.io/npm/dm/@sirrlock/mcp)](https://www.npmjs.com/package/@sirrlock/mcp)
[![CI](https://github.com/sirrlock/mcp/actions/workflows/ci.yml/badge.svg)](https://github.com/sirrlock/mcp/actions)
[![TypeScript](https://img.shields.io/badge/TypeScript-5-blue)](https://www.typescriptlang.org/)
[![Node.js](https://img.shields.io/badge/node-%3E%3D18-brightgreen)](https://nodejs.org)
[![License: MIT](https://img.shields.io/badge/License-MIT-yellow.svg)](https://github.com/sirrlock/mcp/blob/main/LICENSE)
[![GitHub stars](https://img.shields.io/github/stars/sirrlock/mcp)](https://github.com/sirrlock/mcp)
[![Last commit](https://img.shields.io/github/last-commit/sirrlock/mcp)](https://github.com/sirrlock/mcp)

Gives AI assistants like Claude direct access to your [Sirr](https://sirr.dev) secret vault. Push, read, and manage ephemeral secrets without leaving a conversation.

## Demo

**Session 1 — store the secret**

```
❯ set the BITBUCKET_TOKEN to 123asdzxc

⏺ sirr-mcp - push_secret (MCP)(key: "BITBUCKET_TOKEN", value: "123asdzxc", max_reads: 1)
  ⎿  Stored secret 'BITBUCKET_TOKEN'. Burns after 1 read.

⏺ Stored. Burns after first read.
```

**Session 2 — Claude retrieves and uses it (the vault burns it)**

```
❯ deploy to staging using sirr:BITBUCKET_TOKEN

⏺ sirr-mcp - get_secret (MCP)(key: "BITBUCKET_TOKEN")
  ⎿  123asdzxc

⏺ Got it. Deploying to staging with the token. Done.
```

**Session 3 — secret is already gone**

```
❯ what is the BITBUCKET_TOKEN?

⏺ sirr-mcp - get_secret (MCP)(key: "BITBUCKET_TOKEN")
  ⎿  Secret 'BITBUCKET_TOKEN' not found, expired, or already burned.

⏺ The secret no longer exists on the server.
```

The secret existed just long enough to be used once. The vault enforces it server-side (`max_reads=1`). Claude is instructed by the tool description not to memorize or repeat the value. Even if a different agent, session, or attacker asks — there is nothing left to return.

## Install

```bash
npm install -g @sirrlock/mcp
```

Or use `npx` without a global install — see the configuration block below.

## Quick start

1. **Start Sirr** — run the Sirr server and note the `SIRR_MASTER_KEY` you set (or the one it printed on first launch).
2. **Set your token** — `SIRR_TOKEN` in your MCP config must equal that `SIRR_MASTER_KEY` value (or a principal key for org-scoped access).
3. **Add to `.mcp.json`** — paste the config block below, substituting your server URL and key.
4. **Verify** — run `sirr-mcp --health` to confirm the connection before starting your AI session.

## Configuration

Add Sirr to your project's `.mcp.json` or `~/.claude/settings.json`:

```json
{
  "mcpServers": {
    "sirr": {
      "command": "sirr-mcp",
      "env": {
        "SIRR_SERVER": "http://localhost:39999",
        "SIRR_TOKEN": "your-sirr-master-key"
      }
    }
  }
}
```

Using `npx` without a global install:

```json
{
  "mcpServers": {
    "sirr": {
      "command": "npx",
      "args": ["-y", "@sirrlock/mcp"],
      "env": {
        "SIRR_SERVER": "http://localhost:39999",
        "SIRR_TOKEN": "your-sirr-master-key"
      }
    }
  }
}
```

> **What is `SIRR_TOKEN`?** For single-tenant usage, set it to `SIRR_MASTER_KEY` (full access). For multi-tenant org-scoped usage, set it to a principal key. A mismatch is the most common cause of 401 errors. See [sirr.dev/errors#401](https://sirr.dev/errors#401).

### Environment variables

| Variable | Default | Description |
|---|---|---|
| `SIRR_SERVER` | `http://localhost:39999` | Sirr server URL |
| `SIRR_TOKEN` | — | Bearer token — `SIRR_MASTER_KEY` for full access, or a principal key for org-scoped access |
| `SIRR_ORG` | — | Organization ID for multi-tenant mode. When set, all secret/audit/webhook/prune paths are prefixed with `/orgs/{id}/`. Leave unset for single-tenant usage. |

## CLI flags

```bash
# Print the installed version and exit
sirr-mcp --version

# Check that the MCP server can reach Sirr and exit
SIRR_SERVER=http://localhost:39999 SIRR_TOKEN=mykey sirr-mcp --health
```

`--health` exits with code `0` on success and `1` on failure, making it safe to use in scripts and CI.

## Available tools

### Secrets

| Tool | Description |
|---|---|
| `check_secret(key)` | Check if a secret exists and inspect its metadata — **without consuming a read** |
| `get_secret(key)` | Retrieve a secret value (increments read counter; burns if max_reads reached) |
| `push_secret(key, value, ttl_seconds?, max_reads?, delete?)` | Store a secret with optional expiry, read limit, and seal behavior |
| `patch_secret(key, value?, ttl_seconds?, max_reads?)` | Update an existing secret's value, TTL, or read limit |
| `list_secrets()` | List all active secrets — metadata only, values never returned |
| `delete_secret(key)` | Burn a secret immediately, regardless of TTL or read count |
| `prune_secrets()` | Delete all expired secrets in one sweep |
| `health_check()` | Verify the Sirr server is reachable and healthy |

### Audit

| Tool | Description |
|---|---|
| `sirr_audit(since?, until?, action?, limit?)` | Query the audit log — secret creates, reads, deletes, and key events |

### Webhooks

| Tool | Description |
|---|---|
| `sirr_webhook_create(url, events?)` | Register a webhook URL; returns ID and signing secret (shown once) |
| `sirr_webhook_list()` | List all registered webhooks (signing secrets redacted) |
| `sirr_webhook_delete(id)` | Remove a webhook by ID |

### Principal keys

| Tool | Description |
|---|---|
| `sirr_key_list()` | List all API keys for the current principal |
| `sirr_create_key(name, valid_for_seconds?, valid_before?)` | Create a new API key; raw key returned once — save it |
| `sirr_delete_key(keyId)` | Revoke an API key by ID |

### Account (principal-scoped)

| Tool | Description |
|---|---|
| `sirr_me()` | Get the current principal's profile, role, and key list |
| `sirr_update_me(metadata)` | Replace the current principal's metadata |

### Organizations

| Tool | Description |
|---|---|
| `sirr_org_create(name, metadata?)` | Create a new organization |
| `sirr_org_list()` | List all organizations (master key only) |
| `sirr_org_delete(org_id)` | Delete an organization — must have no principals |

### Principals

| Tool | Description |
|---|---|
| `sirr_principal_create(org_id, name, role, metadata?)` | Create a principal (user or service account) in an org |
| `sirr_principal_list(org_id)` | List all principals in an org |
| `sirr_principal_delete(org_id, principal_id)` | Delete a principal — must have no active keys |

### Roles

| Tool | Description |
|---|---|
| `sirr_role_create(org_id, name, permissions)` | Create a custom role. Permissions: C=create R=read P=patch D=delete L=list M=manage A=admin |
| `sirr_role_list(org_id)` | List all roles in an org (built-in and custom) |
| `sirr_role_delete(org_id, role_name)` | Delete a custom role — must not be in use |

## Inline secret references

You can reference secrets inline in any prompt:

```
"Use sirr:DATABASE_URL to run a migration"
"Deploy with sirr:DEPLOY_TOKEN"
```

The `sirr:KEYNAME` prefix tells Claude to fetch from the vault automatically.

## Secret lifecycle

Sirr secrets expire by design. The `push_secret` tool lets you control exactly how:

| Option | Behavior |
|---|---|
| `ttl_seconds: 3600` | Secret expires after 1 hour, regardless of reads |
| `max_reads: 1` | Secret is deleted after the first read |
| `max_reads: 5, delete: false` | After 5 reads the secret is **sealed** (returns 410, stays in DB) instead of deleted |
| No options | Secret persists until explicitly deleted |

Use `check_secret` to inspect a secret's status without consuming a read — useful when you want to verify a secret is still available before fetching it.

## Security notes

- Claude only sees secret **values** when you explicitly ask it to fetch via `get_secret`
- `list_secrets` returns metadata only — values are never included
- Set `max_reads=1` on any secret shared for a single AI session
- The MCP server never logs secret values
- `SIRR_TOKEN` lives in your MCP config's `env` block — it is never passed as a tool argument or in prompts
- Use HTTPS (`https://`) when `SIRR_SERVER` points to a remote host — plain HTTP transmits secrets unencrypted

## Troubleshooting

| Symptom | Cause | Fix |
|---|---|---|
| `Error: Sirr 401` | `SIRR_TOKEN` doesn't match server key | Verify both values match exactly — no extra spaces or newlines. [sirr.dev/errors#401](https://sirr.dev/errors#401) |
| `Error: Sirr 402` | Free-tier limit reached | Delete unused secrets or upgrade. [sirr.dev/errors#402](https://sirr.dev/errors#402) |
| `Error: Sirr 403` | Token lacks the required permission | Use a token with the needed scope. [sirr.dev/errors#403](https://sirr.dev/errors#403) |
| `Error: Sirr 409` | Resource has dependencies | Remove dependents first (e.g. delete principals before org). [sirr.dev/errors#409](https://sirr.dev/errors#409) |
| `Secret '…' not found` | Secret expired, was burned, or key was mistyped | Re-push the secret if you still need it. [sirr.dev/errors#404](https://sirr.dev/errors#404) |
| `did not respond within 10s` | Sirr server is unreachable | Check `SIRR_SERVER` URL and confirm Sirr is running (`sirr-mcp --health`). |
| `[sirr-mcp] Warning: SIRR_TOKEN is not set` | Token missing from MCP config | Add `SIRR_TOKEN` to the `env` block in `.mcp.json`. |
| MCP server not found by Claude | `sirr-mcp` not on PATH | Install globally (`npm install -g @sirrlock/mcp`) or use the `npx` config variant. |

## Related

| Package | Description |
|---------|-------------|
| [sirr](https://github.com/sirrlock/sirr) | Rust monorepo: `sirrd` server + `sirr` CLI |
| [@sirrlock/node](https://github.com/sirrlock/node) | Node.js / TypeScript SDK |
| [sirr (PyPI)](https://github.com/sirrlock/python) | Python SDK |
| [Sirr.Client (NuGet)](https://github.com/sirrlock/dotnet) | .NET SDK |
| [sirr.dev](https://sirr.dev) | Documentation |
| [secretdrop.app](https://secretdrop.app) | Hosted service + license keys |
