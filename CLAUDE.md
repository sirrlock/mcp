# @sirrlock/mcp — Claude Development Guide

## Purpose

MCP (Model Context Protocol) server for Sirr — gives AI assistants direct access to
the Sirr secret vault. Published to npm as `@sirrlock/mcp`.

## Stack

- TypeScript, Node 18+
- `@modelcontextprotocol/sdk` for MCP protocol
- Native `fetch` — no axios, no node-fetch
- `@biomejs/biome` for lint + format
- Jest + ts-jest for tests

## Structure

```
src/
├── index.ts       # MCP server entry: 5 tools, env vars (SIRR_SERVER, SIRR_TOKEN, SIRR_ORG)
└── helpers.ts     # Pure helpers: parseKeyRef, path builders, formatTtl
```

## Tools exposed (5 total)

| Tool | Description |
|---|---|
| `store_secret` | With `name`: org-scoped named secret (requires SIRR_ORG). Without: anonymous dead drop. |
| `read_secret` | By `id`: public dead drop. By `name`: org-scoped (requires SIRR_ORG). |
| `check_secret` | Metadata check without consuming a read. |
| `share_secret` | Burn-after-read link via sirrlock.com. No auth needed. |
| `audit` | Query the audit log. |

Everything else (webhooks, keys, orgs, roles, principals) is CLI/web-only — not exposed via MCP.

## Routing semantics

- `store_secret` without `name` → `POST /secrets` (public dead drop). Returns `{id}`.
- `store_secret` with `name` → `POST /orgs/{SIRR_ORG}/secrets` (org-scoped). Returns `{key, id}`. 409 if name exists.
- `read_secret` with `id` → `GET /secrets/{id}` (public).
- `read_secret` with `name` → `GET /orgs/{SIRR_ORG}/secrets/{name}` (org-scoped).
- `share_secret` → `POST {SIRRLOCK_URL}/api/public/secret` (sirrlock.com hosted).

## Key Rules

- Never log or echo secret values in tool output
- `SIRR_ORG` env var is required for named secrets (store/read by name) and audit
- `SIRR_TOKEN` = master key for full access, or a principal key for org-scoped access
- `check_secret` does NOT consume a read — safe to call freely
- Tool descriptions tell Claude not to memorize or repeat retrieved secret values
- `store_secret` with a name returns 409 Conflict if the name already exists

## Commands

```bash
npm install
npm run build    # tsc → dist/
npm test
npm run lint
sirr-mcp --health   # connectivity check
```

## CI

GitHub Actions — Node 18, 20, 22 matrix. Steps: install → lint → build → test → publish.

## Pre-Commit Checklist

1. **README.md** — New tools or env vars?
2. **CLAUDE.md** — New constraints worth recording?
3. **llms.txt** — Reflects current tool list?
