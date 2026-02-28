import { describe, it, expect, jest, beforeEach, afterEach } from "@jest/globals";
import { parseKeyRef, formatTtl, secretsPath, auditPath, webhooksPath, prunePath } from "./helpers";

describe("parseKeyRef", () => {
  it("strips sirr: prefix", () => {
    expect(parseKeyRef("sirr:MY_KEY")).toBe("MY_KEY");
  });

  it("extracts key from hash format", () => {
    expect(parseKeyRef("MY_KEY#some-server")).toBe("MY_KEY");
  });

  it("returns bare key as-is", () => {
    expect(parseKeyRef("MY_KEY")).toBe("MY_KEY");
  });

  it("trims whitespace from bare keys", () => {
    expect(parseKeyRef("  MY_KEY  ")).toBe("MY_KEY");
  });

  it("handles sirr: with no key (edge case)", () => {
    expect(parseKeyRef("sirr:")).toBe("");
  });

  it("takes only the part before the first # in hash format", () => {
    expect(parseKeyRef("KEY#a#b")).toBe("KEY");
  });
});

describe("secretsPath", () => {
  afterEach(() => {
    delete process.env.SIRR_ORG;
  });

  it("returns /secrets without SIRR_ORG", () => {
    delete process.env.SIRR_ORG;
    expect(secretsPath()).toBe("/secrets");
  });

  it("returns /secrets/{key} without SIRR_ORG", () => {
    delete process.env.SIRR_ORG;
    expect(secretsPath("MY_KEY")).toBe("/secrets/MY_KEY");
  });

  it("returns /orgs/{org}/secrets with SIRR_ORG", () => {
    process.env.SIRR_ORG = "acme";
    expect(secretsPath()).toBe("/orgs/acme/secrets");
  });

  it("returns /orgs/{org}/secrets/{key} with SIRR_ORG", () => {
    process.env.SIRR_ORG = "acme";
    expect(secretsPath("MY_KEY")).toBe("/orgs/acme/secrets/MY_KEY");
  });
});

describe("auditPath", () => {
  afterEach(() => {
    delete process.env.SIRR_ORG;
  });

  it("returns /audit without SIRR_ORG", () => {
    delete process.env.SIRR_ORG;
    expect(auditPath()).toBe("/audit");
  });

  it("returns /orgs/{org}/audit with SIRR_ORG", () => {
    process.env.SIRR_ORG = "acme";
    expect(auditPath()).toBe("/orgs/acme/audit");
  });
});

describe("webhooksPath", () => {
  afterEach(() => {
    delete process.env.SIRR_ORG;
  });

  it("returns /webhooks without SIRR_ORG", () => {
    delete process.env.SIRR_ORG;
    expect(webhooksPath()).toBe("/webhooks");
  });

  it("returns /webhooks/{id} without SIRR_ORG", () => {
    delete process.env.SIRR_ORG;
    expect(webhooksPath("wh_123")).toBe("/webhooks/wh_123");
  });

  it("returns /orgs/{org}/webhooks with SIRR_ORG", () => {
    process.env.SIRR_ORG = "acme";
    expect(webhooksPath()).toBe("/orgs/acme/webhooks");
  });

  it("returns /orgs/{org}/webhooks/{id} with SIRR_ORG", () => {
    process.env.SIRR_ORG = "acme";
    expect(webhooksPath("wh_123")).toBe("/orgs/acme/webhooks/wh_123");
  });
});

describe("prunePath", () => {
  afterEach(() => {
    delete process.env.SIRR_ORG;
  });

  it("returns /prune without SIRR_ORG", () => {
    delete process.env.SIRR_ORG;
    expect(prunePath()).toBe("/prune");
  });

  it("returns /orgs/{org}/prune with SIRR_ORG", () => {
    process.env.SIRR_ORG = "acme";
    expect(prunePath()).toBe("/orgs/acme/prune");
  });
});

describe("formatTtl", () => {
  const realDateNow = Date.now;

  beforeEach(() => {
    // Pin now to a fixed Unix timestamp (seconds = 1_000_000)
    jest.spyOn(Date, "now").mockReturnValue(1_000_000 * 1000);
  });

  afterEach(() => {
    jest.restoreAllMocks();
  });

  it("returns 'no expiry' for null", () => {
    expect(formatTtl(null)).toBe("no expiry");
  });

  it("returns 'expired' for past timestamp", () => {
    expect(formatTtl(999_999)).toBe("expired");
  });

  it("returns 'expired' for exactly now", () => {
    expect(formatTtl(1_000_000)).toBe("expired");
  });

  it("formats seconds (< 60s)", () => {
    expect(formatTtl(1_000_000 + 45)).toBe("45s");
  });

  it("formats minutes (60s – 3599s)", () => {
    expect(formatTtl(1_000_000 + 120)).toBe("2m");
    expect(formatTtl(1_000_000 + 3599)).toBe("59m");
  });

  it("formats hours (3600s – 86399s)", () => {
    expect(formatTtl(1_000_000 + 3600)).toBe("1h");
    expect(formatTtl(1_000_000 + 7200)).toBe("2h");
  });

  it("formats days (≥ 86400s)", () => {
    expect(formatTtl(1_000_000 + 86400)).toBe("1d");
    expect(formatTtl(1_000_000 + 86400 * 7)).toBe("7d");
  });
});
