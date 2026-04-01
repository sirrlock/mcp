# @sirrlock/mcp — Sirr MCP Server

[![npm version](https://img.shields.io/npm/v/@sirrlock/mcp)](https://www.npmjs.com/package/@sirrlock/mcp)
[![npm downloads](https://img.shields.io/npm/dm/@sirrlock/mcp)](https://www.npmjs.com/package/@sirrlock/mcp)
[![CI](https://github.com/sirrlock/mcp/actions/workflows/ci.yml/badge.svg)](https://github.com/sirrlock/mcp/actions)
[![TypeScript](https://img.shields.io/badge/TypeScript-5-blue)](https://www.typescriptlang.org/)
[![Node.js](https://img.shields.io/badge/node-%3E%3D18-brightgreen)](https://nodejs.org)
[![License: MIT](https://img.shields.io/badge/License-MIT-yellow.svg)](https://github.com/sirrlock/mcp/blob/main/LICENSE)
[![GitHub stars](https://img.shields.io/github/stars/sirrlock/mcp)](https://github.com/sirrlock/mcp)
[![Last commit](https://img.shields.io/github/last-commit/sirrlock/mcp)](https://github.com/sirrlock/mcp)

Gives AI assistants like Claude direct access to your [Sirr](https://sirr.dev) secret vault. Store, read, and share ephemeral secrets without leaving a conversation.

## Demo

### Anonymous dead drop — store and burn

**Session 1 — store a secret (no name, no org needed)**

```
❯ stash this deploy token: 123asdzxc

⏺ sirr-mcp - store_secret (MCP)(value: "123asdzxc")
  ⎿  Secret pushed.
     ID: a1b2c3d4e5f6…
     URL: https://sirr.sirrlock.com/s/a1b2c3d4e5f6…
     Burns after 1 read(s).

⏺ Stored. Share the URL — it burns after one read.
```

**Session 2 — retrieve by ID (the vault burns it)**

```
❯ get the secret at a1b2c3d4e5f6…

⏺ sirr-mcp - read_secret (MCP)(id: "a1b2c3d4e5f6…")
  ⎿  123asdzxc

⏺ Got it. Deploying to staging with the token. Done.
```

**Session 3 — secret is already gone**

```
❯ get that secret again

⏺ sirr-mcp - read_secret (MCP)(id: "a1b2c3d4e5f6…")
  ⎿  Secret not found, expired, or already burned.

⏺ The secret no longer exists on the server.
```

### Org-scoped named secret — store and read by name

```
❯ store the BITBUCKET_TOKEN as 123asdzxc

⏺ sirr-mcp - store_secret (MCP)(value: "123asdzxc", name: "BITBUCKET_TOKEN")
  ⎿  Secret 'BITBUCKET_TOKEN' stored in org 'acme'.

❯ deploy to staging using sirr:BITBUCKET_TOKEN

⏺ sirr-mcp - read_secret (MCP)(name: "BITBUCKET_TOKEN")
  ⎿  123asdzxc
```

The secret existed just long enough to be used. The vault enforces expiry server-side. Claude is instructed by the tool description not to memorize or repeat the value. Even if a different agent, session, or attacker asks — there is nothing left to return.

## Install

```bash
npm install -g @sirrlock/mcp
```

Or use `npx` without a global install — see the configuration block below.

## Quick start

### Zero config (public dead drops + share links)

Works immediately. No account, no token, no org needed:

```
❯ stash this API key: sk-abc123
⏺ [calls store_secret] → burn URL

❯ share this password with the contractor: hunter2
⏺ [calls share_secret] → sirrlock.com burn link
```

### Sirr Cloud (org-scoped named secrets)

1. **Sign up** at [sirrlock.com](https://sirrlock.com/sign-in) — free tier includes 3 seats and unlimited secrets.
2. **Get your principal key** from the dashboard (Settings → API Keys).
3. **Add to `.mcp.json`** — paste the config block below with your key and org ID.
4. **Verify** — run `sirr-mcp --health` to confirm the connection.

### Self-Hosted

1. **Start Sirr** — run `sirrd serve` and note the `SIRR_MASTER_API_KEY` you set.
2. **Set your token** — `SIRR_TOKEN` in your MCP config must equal that key value.
3. **Add to `.mcp.json`** — use the self-hosted config block below.
4. **Verify** — run `sirr-mcp --health` to confirm the connection.

## Configuration

### Sirr Cloud (default)

No `SIRR_SERVER` needed — defaults to `https://sirr.sirrlock.com`.

```json
{
  "mcpServers": {
    "sirr": {
      "command": "sirr-mcp",
      "env": {
        "SIRR_TOKEN": "your-principal-key",
        "SIRR_ORG": "your-org-id"
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
        "SIRR_TOKEN": "your-principal-key",
        "SIRR_ORG": "your-org-id"
      }
    }
  }
}
```

### Self-Hosted

Point `SIRR_SERVER` at your own `sirrd` instance:

```json
{
  "mcpServers": {
    "sirr": {
      "command": "sirr-mcp",
      "env": {
        "SIRR_SERVER": "http://localhost:39999",
        "SIRR_TOKEN": "your-master-api-key"
      }
    }
  }
}
```

> **What is `SIRR_TOKEN`?** On Sirr Cloud, use a **principal key** from the sirrlock.com dashboard. For self-hosted, use the `SIRR_MASTER_API_KEY` value (full access) or a principal key for org-scoped access. A mismatch is the most common cause of 401 errors. See [sirr.dev/errors#401](https://sirr.dev/errors#401).

### Environment variables

| Variable | Default | Description |
|---|---|---|
| `SIRR_SERVER` | `https://sirr.sirrlock.com` | Sirr server URL. Omit for Cloud; set to your instance URL for self-hosted. |
| `SIRR_TOKEN` | — | Bearer token — a principal key (Cloud or org-scoped) or `SIRR_MASTER_API_KEY` (self-hosted full access) |
| `SIRR_ORG` | — | Organization ID. Required for named secrets (store/read by name). Optional for anonymous dead drops. |

## CLI flags

```bash
# Print the installed version and exit
sirr-mcp --version

# Check connectivity (Cloud)
SIRR_TOKEN=your-principal-key SIRR_ORG=your-org-id sirr-mcp --health

# Check connectivity (self-hosted)
SIRR_SERVER=http://localhost:39999 SIRR_TOKEN=your-master-key sirr-mcp --health
```

`--health` exits with code `0` on success and `1` on failure, making it safe to use in scripts and CI.

## Available tools

| Tool | Description |
|---|---|
| `store_secret(value, name?, ttl_seconds?, max_reads?)` | Store a secret. With `name`: org-scoped named secret. Without: anonymous burn-after-read dead drop. |
| `read_secret(id?)` or `read_secret(name?)` | Read a secret. By `id`: public dead drop. By `name`: org-scoped (requires `SIRR_ORG`). |
| `check_secret(name)` | Check if a secret exists and view metadata — **without consuming a read**. |
| `share_secret(value)` | Create a burn-after-read link via sirrlock.com. Burns after 1 read or 24h. No account needed. |
| `audit(since?, action?, limit?)` | Query the audit log — secret creates, reads, deletes. |

That's it. Five tools. Everything else (webhooks, keys, orgs, roles, principals) is managed via the [CLI](https://sirr.dev/cli) or [web dashboard](https://sirrlock.com).

## Inline secret references

You can reference org-scoped secrets inline in any prompt:

```
"Use sirr:DATABASE_URL to run a migration"
"Deploy with sirr:DEPLOY_TOKEN"
```

The `sirr:KEYNAME` prefix tells Claude to fetch from the vault automatically (requires `SIRR_ORG` to be set).

## Secret lifecycle

Sirr secrets expire by design. `store_secret` supports expiry controls:

| Option | Behavior |
|---|---|
| `ttl_seconds: 3600` | Secret expires after 1 hour, regardless of reads |
| `max_reads: 1` | Secret is deleted after the first read (default for anonymous dead drops) |
| No options | Secret persists until explicitly deleted |

Use `check_secret` to inspect a secret's status without consuming a read — useful when you want to verify a secret is still available before fetching it.

## Security notes

- Claude only sees secret **values** when you explicitly ask it to fetch via `read_secret`
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
| `Error: Sirr 409` | Name already exists (`store_secret`) | Delete the existing secret first, or choose a different name. [sirr.dev/errors#409](https://sirr.dev/errors#409) |
| `Secret '…' not found` | Secret expired, was burned, or name was mistyped | Re-store the secret if you still need it. [sirr.dev/errors#404](https://sirr.dev/errors#404) |
| `did not respond within 10s` | Sirr server is unreachable | Check `SIRR_SERVER` URL and confirm Sirr is running (`sirr-mcp --health`). |
| `[sirr-mcp] Warning: SIRR_TOKEN is not set` | Token missing from MCP config | Add `SIRR_TOKEN` to the `env` block in `.mcp.json`. Anonymous dead drops and share links still work without it. |
| MCP server not found by Claude | `sirr-mcp` not on PATH | Install globally (`npm install -g @sirrlock/mcp`) or use the `npx` config variant. |

## Related

| Package | Description |
|---------|-------------|
| [sirr](https://github.com/sirrlock/sirr) | Rust monorepo: `sirrd` server + `sirr` CLI |
| [@sirrlock/node](https://github.com/sirrlock/node) | Node.js / TypeScript SDK |
| [sirr (PyPI)](https://github.com/sirrlock/python) | Python SDK |
| [Sirr.Client (NuGet)](https://github.com/sirrlock/dotnet) | .NET SDK |
| [sirr.dev](https://sirr.dev) | Documentation |
| [sirrlock.com](https://sirrlock.com) | Managed cloud + license keys |
