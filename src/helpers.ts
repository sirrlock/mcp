/**
 * Pure helper functions extracted for testability.
 */

/**
 * Parse a secret key reference from natural language.
 *   "sirr:KEYNAME"   → "KEYNAME"
 *   "KEYNAME#server" → "KEYNAME"
 *   "KEYNAME"        → "KEYNAME"
 */
export function parseKeyRef(ref: string): string {
  if (ref.startsWith("sirr:")) return ref.slice(5);
  if (ref.includes("#")) return ref.split("#")[0]!;
  return ref.trim();
}

// ── Org-aware path helpers ────────────────────────────────────────────────────

export function secretsPath(key?: string): string {
  const org = process.env.SIRR_ORG;
  const base = org ? `/orgs/${org}/secrets` : '/secrets';
  return key ? `${base}/${key}` : base;
}

/** Always routes to the public (unauthenticated) secrets endpoint. */
export function publicSecretsPath(id?: string): string {
  return id ? `/secrets/${id}` : '/secrets';
}

/** Always routes to the org-scoped secrets endpoint. */
export function orgSecretsPath(org: string, key?: string): string {
  const base = `/orgs/${org}/secrets`;
  return key ? `${base}/${key}` : base;
}

export function auditPath(): string {
  const org = process.env.SIRR_ORG;
  return org ? `/orgs/${org}/audit` : '/audit';
}

/**
 * Format a Unix timestamp (seconds) as a human-readable TTL string
 * relative to now. Returns "no expiry" for null, "expired" for past timestamps.
 */
export function formatTtl(expiresAt: number | null): string {
  if (expiresAt === null) return "no expiry";
  const now = Math.floor(Date.now() / 1000);
  const secs = expiresAt - now;
  if (secs <= 0) return "expired";
  if (secs < 60) return `${secs}s`;
  if (secs < 3600) return `${Math.floor(secs / 60)}m`;
  if (secs < 86400) return `${Math.floor(secs / 3600)}h`;
  return `${Math.floor(secs / 86400)}d`;
}
