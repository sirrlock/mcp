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
├── index.ts       # MCP server entry: tool registration, SIRR_SERVER / SIRR_TOKEN / SIRR_ORG env vars
└── sirr.ts        # HTTP client wrapping the full Sirr REST API
```

## Tools exposed

Secrets: `get_secret`, `push_secret`, `set_secret`, `check_secret`, `patch_secret`, `list_secrets`, `delete_secret`, `prune_secrets`, `health_check`
Audit: `sirr_audit`
Webhooks: `sirr_webhook_create`, `sirr_webhook_list`, `sirr_webhook_delete`
Keys: `sirr_key_list`, `sirr_create_key`, `sirr_delete_key`
Account: `sirr_me`, `sirr_update_me`
Orgs: `sirr_org_create`, `sirr_org_list`, `sirr_org_delete`
Principals: `sirr_principal_create`, `sirr_principal_list`, `sirr_principal_delete`
Roles: `sirr_role_create`, `sirr_role_list`, `sirr_role_delete`

## Push semantics (post-redesign)

- `push_secret` — anonymous public dead drop. Accepts `{value, ttl_seconds?, max_reads?}`. POSTs to `POST /secrets`. Returns `{id, url}`. No key, no org needed.
- `set_secret` — org-scoped named secret. Accepts `{org, key, value}`. POSTs to `POST /orgs/{org}/secrets`. Returns `{key, id}`. 409 if key already exists.
- `get_secret` — two modes: `{id}` fetches `GET /secrets/{id}` (public); `{key, org}` fetches `GET /orgs/{org}/secrets/{key}` (org-scoped).

## Key Rules

- Never log or echo secret values in tool output
- `SIRR_ORG` env var still used by `check_secret`, `list_secrets`, `delete_secret`, `patch_secret`, `prune_secrets`, `sirr_audit`, webhooks
- `SIRR_TOKEN` = master key for full access, or a principal key for org-scoped access
- `check_secret` / `health_check` do NOT consume a read — safe to call freely
- `sirr_create_key` and `sirr_webhook_create` return secrets once — instruct user to save immediately
- Tool descriptions tell Claude not to memorize or repeat retrieved secret values
- `set_secret` returns 409 Conflict if the key already exists — use `patch_secret` to update

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
