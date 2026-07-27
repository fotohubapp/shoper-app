/**
 * Admin-server gates. Three separate things can leave this panel wide open, and
 * each is checked here: the encryption passphrase (a fallback would encrypt
 * every merchant's Shoper password with a constant committed to a public repo),
 * the optional shared-secret gate on /api, and the per-IP throttle on mutations
 * that spend credits or write to the live store.
 *
 * Nothing here binds a port. The routing decisions live in exported pure
 * functions precisely so they can be tested without a listener.
 */

import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { FixedWindowRateLimiter } from "../src/http";
import { tempDir } from "./helpers";

const GOOD_SECRET = "0123456789abcdef0123456789abcdef";

/** Env keys these tests mutate, restored after each case. */
const MANAGED = [
  "FOTOHUB_CONFIG_SECRET",
  "DATA_DIR",
  "ADMIN_TOKEN",
  "TRUST_PROXY",
  "HOST",
  "PORT",
] as const;

let saved: Record<string, string | undefined> = {};
let cleanups: Array<() => void> = [];

beforeEach(() => {
  saved = {};
  for (const key of MANAGED) saved[key] = process.env[key];
  vi.resetModules();
});

afterEach(() => {
  for (const key of MANAGED) {
    if (saved[key] === undefined) delete process.env[key];
    else process.env[key] = saved[key] as string;
  }
  while (cleanups.length > 0) cleanups.pop()?.();
  cleanups = [];
});

/** Import the server module with a throwaway DATA_DIR. */
async function loadServer(env: Record<string, string | undefined> = {}) {
  const { dir, cleanup } = tempDir();
  cleanups.push(cleanup);
  process.env["DATA_DIR"] = dir;
  process.env["FOTOHUB_CONFIG_SECRET"] = GOOD_SECRET;
  for (const [key, value] of Object.entries(env)) {
    if (value === undefined) delete process.env[key];
    else process.env[key] = value;
  }
  return import("../src/server");
}

describe("FOTOHUB_CONFIG_SECRET", () => {
  it("refuses to boot when the secret is missing", async () => {
    const { dir, cleanup } = tempDir();
    cleanups.push(cleanup);
    process.env["DATA_DIR"] = dir;
    delete process.env["FOTOHUB_CONFIG_SECRET"];

    // Booting with a hardcoded fallback would mean every install shares one
    // key, so refusing to start is the safe failure.
    await expect(import("../src/server")).rejects.toThrow(/FOTOHUB_CONFIG_SECRET must be set/);
  });

  it("refuses a secret shorter than 16 characters", async () => {
    const { dir, cleanup } = tempDir();
    cleanups.push(cleanup);
    process.env["DATA_DIR"] = dir;
    process.env["FOTOHUB_CONFIG_SECRET"] = "short";
    await expect(import("../src/server")).rejects.toThrow(/at least 16 characters/);
  });

  it("refuses a secret that is only whitespace padding", async () => {
    const { dir, cleanup } = tempDir();
    cleanups.push(cleanup);
    process.env["DATA_DIR"] = dir;
    process.env["FOTOHUB_CONFIG_SECRET"] = `   ${"x".repeat(10)}   `;
    await expect(import("../src/server")).rejects.toThrow(/at least 16 characters/);
  });

  it("tells the operator how to generate one", async () => {
    const { dir, cleanup } = tempDir();
    cleanups.push(cleanup);
    process.env["DATA_DIR"] = dir;
    delete process.env["FOTOHUB_CONFIG_SECRET"];
    const error = await import("../src/server").catch((e: Error) => e);
    expect((error as Error).message).toContain("openssl rand -hex 32");
  });

  it("boots with a long secret", async () => {
    const server = await loadServer();
    expect(server.app).toBeDefined();
    expect(server.store.readConfig()).toEqual({});
  });
});

describe("admin token gate", () => {
  it("is inactive when ADMIN_TOKEN is unset or blank", async () => {
    const server = await loadServer({ ADMIN_TOKEN: undefined });
    expect(server.readAdminToken({})).toBeUndefined();
    expect(server.readAdminToken({ ADMIN_TOKEN: "" })).toBeUndefined();
    expect(server.readAdminToken({ ADMIN_TOKEN: "   " })).toBeUndefined();
  });

  it("is active once ADMIN_TOKEN is set, trimming the value", async () => {
    const server = await loadServer();
    expect(server.readAdminToken({ ADMIN_TOKEN: "  secret-value  " })).toBe("secret-value");
  });

  it("accepts the token from Authorization: Bearer or X-Admin-Token", async () => {
    const server = await loadServer();
    const req = (headers: Record<string, string>) =>
      ({ get: (name: string) => headers[name.toLowerCase()] }) as never;

    expect(server.presentedAdminToken(req({ authorization: "Bearer tok" }))).toBe("tok");
    // Header names are case-insensitive over the wire, so the scheme must be too.
    expect(server.presentedAdminToken(req({ authorization: "bearer tok" }))).toBe("tok");
    expect(server.presentedAdminToken(req({ "x-admin-token": "tok" }))).toBe("tok");
  });

  it("ignores an empty or non-Bearer Authorization header", async () => {
    const server = await loadServer();
    const req = (headers: Record<string, string>) =>
      ({ get: (name: string) => headers[name.toLowerCase()] }) as never;

    expect(server.presentedAdminToken(req({}))).toBeUndefined();
    expect(server.presentedAdminToken(req({ authorization: "Bearer   " }))).toBeUndefined();
    expect(server.presentedAdminToken(req({ "x-admin-token": "  " }))).toBeUndefined();
    // Basic credentials are the Shoper webapi's scheme, not ours.
    expect(server.presentedAdminToken(req({ authorization: "Basic abc" }))).toBeUndefined();
  });

  it("compares tokens without throwing on a length mismatch", async () => {
    const server = await loadServer();
    expect(server.safeEqual("abc", "abc")).toBe(true);
    expect(server.safeEqual("abc", "abd")).toBe(false);
    // timingSafeEqual throws on unequal lengths; a short guess must be a plain
    // false, not a 500 that reveals the comparison happened.
    expect(() => server.safeEqual("short", "much-longer-token")).not.toThrow();
    expect(server.safeEqual("short", "much-longer-token")).toBe(false);
    expect(server.safeEqual("", "")).toBe(true);
    expect(server.safeEqual("żółć", "żółć")).toBe(true);
  });

  it("warns at boot when the panel is unauthenticated", async () => {
    const server = await loadServer();
    const boot = server.adminAuthBootMessage({ HOST: "127.0.0.1" });
    expect(boot.level).toBe("warn");
    expect(boot.message).toContain("UNAUTHENTICATED");
    expect(boot.message).toContain("Keep HOST on loopback");
  });

  it("escalates the warning when HOST is not loopback", async () => {
    // Binding 0.0.0.0 with no token is the actually dangerous combination, so
    // the message has to say so rather than repeat generic advice.
    const server = await loadServer();
    const boot = server.adminAuthBootMessage({ HOST: "0.0.0.0", PORT: "8811" });
    expect(boot.level).toBe("warn");
    expect(boot.message).toContain("not loopback");
    expect(boot.message).toContain("8811");
  });

  it("reports info, not a warning, once a token is configured", async () => {
    const server = await loadServer();
    const boot = server.adminAuthBootMessage({ ADMIN_TOKEN: "secret", HOST: "0.0.0.0" });
    expect(boot.level).toBe("info");
    expect(boot.message).not.toContain("UNAUTHENTICATED");
  });
});

describe("rate-limit routing", () => {
  it("meters credit-spending and store-writing paths hardest", async () => {
    const server = await loadServer();
    // Same limiter instance per bucket, and the tightest budget on the paths
    // that cost money.
    for (const path of [
      "/jobs",
      "/jobs/job-1/retry-failed",
      "/drafts/12/approve",
      "/drafts/12/reject",
      "/drafts/approve-all",
    ]) {
      expect(server.limiterFor(path)).toBe(server.limiterFor("/jobs"));
    }
    expect(server.RATE_LIMITS.spend).toBeLessThan(server.RATE_LIMITS.mutation);
  });

  it("gives the connection wizard its own, tighter bucket", async () => {
    const server = await loadServer();
    expect(server.limiterFor("/connect")).toBe(server.limiterFor("/disconnect"));
    expect(server.limiterFor("/connect")).not.toBe(server.limiterFor("/jobs"));
    expect(server.RATE_LIMITS.connect).toBeLessThan(server.RATE_LIMITS.spend);
  });

  it("routes ordinary mutations to the loose bucket", async () => {
    const server = await loadServer();
    for (const path of ["/settings", "/language", "/presets/default", "/validate-key"]) {
      expect(server.limiterFor(path)).toBe(server.limiterFor("/settings"));
    }
    expect(server.limiterFor("/settings")).not.toBe(server.limiterFor("/jobs"));
  });

  it("does not let a job sub-path escape into the loose bucket", async () => {
    // /jobs/:id/cancel and /collect-drafts hit the bridge, so they must not be
    // classified as cheap settings writes by a sloppy prefix match.
    const server = await loadServer();
    expect(server.limiterFor("/jobs/job-1/retry-failed")).toBe(server.limiterFor("/jobs"));
  });

  it("derives the client key from the socket unless TRUST_PROXY is set", async () => {
    const untrusted = await loadServer({ TRUST_PROXY: undefined });
    const req = {
      get: (name: string) => (name === "x-forwarded-for" ? "1.2.3.4, 5.6.7.8" : undefined),
      socket: { remoteAddress: "10.0.0.1" },
    } as never;
    // Honouring the header unconditionally would hand every client a fresh
    // bucket per request, making the limiter decorative.
    expect(untrusted.clientKey(req)).toBe("10.0.0.1");

    vi.resetModules();
    const trusted = await loadServer({ TRUST_PROXY: "1" });
    expect(trusted.clientKey(req)).toBe("1.2.3.4");
  });

  it("falls back to a constant key when the socket has no address", async () => {
    const server = await loadServer();
    const req = { get: () => undefined, socket: {} } as never;
    expect(server.clientKey(req)).toBe("unknown");
  });
});

describe("FixedWindowRateLimiter", () => {
  function limiter(max = 3, windowMs = 60_000): {
    limiter: FixedWindowRateLimiter;
    advance: (ms: number) => void;
  } {
    let clock = 1_000;
    const instance = new FixedWindowRateLimiter({ max, windowMs, now: () => clock });
    return { limiter: instance, advance: (ms) => (clock += ms) };
  }

  it("allows up to max and then refuses with a reset hint", () => {
    const { limiter: l } = limiter(3);
    expect(l.hit("ip").remaining).toBe(2);
    expect(l.hit("ip").remaining).toBe(1);
    const third = l.hit("ip");
    expect(third.allowed).toBe(true);
    expect(third.remaining).toBe(0);

    const fourth = l.hit("ip");
    expect(fourth.allowed).toBe(false);
    // The value the 429's Retry-After is computed from.
    expect(fourth.resetMs).toBeGreaterThan(0);
    expect(fourth.resetMs).toBeLessThanOrEqual(60_000);
  });

  it("keeps buckets independent per key", () => {
    const { limiter: l } = limiter(1);
    expect(l.hit("a").allowed).toBe(true);
    expect(l.hit("a").allowed).toBe(false);
    // One noisy IP must not lock out the merchant on another.
    expect(l.hit("b").allowed).toBe(true);
  });

  it("opens a fresh window once the old one expires", () => {
    const { limiter: l, advance } = limiter(1, 60_000);
    expect(l.hit("ip").allowed).toBe(true);
    expect(l.hit("ip").allowed).toBe(false);
    advance(60_001);
    const reopened = l.hit("ip");
    expect(reopened.allowed).toBe(true);
    expect(reopened.used).toBe(1);
  });

  it("does not reopen the window a millisecond early", () => {
    const { limiter: l, advance } = limiter(1, 60_000);
    l.hit("ip");
    advance(59_999);
    expect(l.hit("ip").allowed).toBe(false);
  });

  it("shrinks the reported reset as the window drains", () => {
    const { limiter: l, advance } = limiter(1, 10_000);
    l.hit("ip");
    advance(4_000);
    expect(l.hit("ip").resetMs).toBe(6_000);
  });

  it("stays bounded when flooded with spoofed keys", () => {
    // A forged X-Forwarded-For flood must not grow the map without limit.
    const l = new FixedWindowRateLimiter({ max: 5, windowMs: 60_000, maxKeys: 32 });
    for (let i = 0; i < 5_000; i += 1) l.hit(`key-${i}`);
    expect(l.trackedKeys).toBeLessThanOrEqual(32);
  });

  it("clamps nonsensical options instead of dividing by zero", () => {
    const l = new FixedWindowRateLimiter({ max: 0, windowMs: 0 });
    const first = l.hit("ip");
    expect(first.allowed).toBe(true);
    // max floors at 1, so the second hit in the window is refused.
    expect(l.hit("ip").allowed).toBe(false);
    expect(first.resetMs).toBeGreaterThan(0);
  });

  it("reset clears one key or all of them", () => {
    const { limiter: l } = limiter(1);
    l.hit("a");
    l.hit("b");
    l.reset("a");
    expect(l.hit("a").allowed).toBe(true);
    expect(l.hit("b").allowed).toBe(false);
    l.reset();
    expect(l.trackedKeys).toBe(0);
    expect(l.hit("b").allowed).toBe(true);
  });

  it("counts over-limit hits so a caller cannot reset by hammering", () => {
    const { limiter: l } = limiter(2);
    l.hit("ip");
    l.hit("ip");
    const a = l.hit("ip");
    const b = l.hit("ip");
    expect(a.allowed).toBe(false);
    expect(b.allowed).toBe(false);
    expect(b.used).toBeGreaterThan(a.used);
  });
});
