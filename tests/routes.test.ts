/**
 * The /api middleware chain, driven end to end through the real Express app
 * (helpers.inject supplies genuine request/response objects on an unconnected
 * socket, so nothing here binds a port). Unit-testing limiterFor() proves the
 * routing table; only running the chain proves the throttle is actually wired
 * in front of the handlers, returns 429 with a Retry-After, and sits behind the
 * admin gate rather than in front of it.
 */

import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { inject, tempDir, type RequestListenerLike } from "./helpers";

const GOOD_SECRET = "0123456789abcdef0123456789abcdef";
const MANAGED = ["FOTOHUB_CONFIG_SECRET", "DATA_DIR", "ADMIN_TOKEN", "TRUST_PROXY"] as const;

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

async function loadApp(env: Record<string, string | undefined> = {}) {
  const { dir, cleanup } = tempDir();
  cleanups.push(cleanup);
  process.env["DATA_DIR"] = dir;
  process.env["FOTOHUB_CONFIG_SECRET"] = GOOD_SECRET;
  for (const [key, value] of Object.entries(env)) {
    if (value === undefined) delete process.env[key];
    else process.env[key] = value;
  }
  const server = await import("../src/server");
  // Reset the module-level buckets: they are process-wide, so a previous test's
  // hits would otherwise leak into this one.
  for (const path of ["/jobs", "/connect", "/settings"]) {
    server.limiterFor(path).reset();
  }
  return server;
}

async function csrfToken(app: unknown, headers: Record<string, string> = {}): Promise<string> {
  const res = await inject(app as RequestListenerLike, "GET", "/api/status", { headers });
  return res.json<{ csrf_token: string }>().csrf_token;
}

describe("CSRF guard", () => {
  it("lets GET through and hands out the token", async () => {
    const { app } = await loadApp();
    const res = await inject(app as RequestListenerLike, "GET", "/api/status");
    expect(res.status).toBe(200);
    expect(res.json<{ csrf_token: string }>().csrf_token).toMatch(/.{20,}/);
  });

  it("rejects a mutation with no token", async () => {
    const { app } = await loadApp();
    const res = await inject(app as RequestListenerLike, "POST", "/api/language", {
      body: { lang: "en" },
    });
    expect(res.status).toBe(403);
    expect(res.json()).toEqual({ error: "csrf_token_invalid" });
  });

  it("rejects a mutation with the wrong token", async () => {
    const { app } = await loadApp();
    const res = await inject(app as RequestListenerLike, "POST", "/api/language", {
      headers: { "x-csrf-token": "not-the-token" },
      body: { lang: "en" },
    });
    expect(res.status).toBe(403);
  });

  it("accepts a mutation carrying the issued token", async () => {
    const { app } = await loadApp();
    const token = await csrfToken(app);
    const res = await inject(app as RequestListenerLike, "POST", "/api/language", {
      headers: { "x-csrf-token": token },
      body: { lang: "en" },
    });
    expect(res.status).toBe(200);
    expect(res.json()).toEqual({ ui_language: "en" });
  });
});

describe("admin token gate", () => {
  it("leaves every route reachable when ADMIN_TOKEN is unset", async () => {
    const { app } = await loadApp({ ADMIN_TOKEN: undefined });
    expect((await inject(app as RequestListenerLike, "GET", "/api/status")).status).toBe(200);
  });

  it("blocks reads as well as writes once ADMIN_TOKEN is set", async () => {
    // The gate runs before CSRF on purpose: an unauthenticated caller must not
    // even learn whether a store is connected, let alone collect the CSRF token.
    const { app } = await loadApp({ ADMIN_TOKEN: "panel-secret" });
    const res = await inject(app as RequestListenerLike, "GET", "/api/status");
    expect(res.status).toBe(401);
    expect(res.json()).toEqual({ error: "admin_token_invalid" });
    expect(res.body).not.toContain("csrf_token");
  });

  it("rejects a wrong token and accepts the right one, in either header form", async () => {
    const { app } = await loadApp({ ADMIN_TOKEN: "panel-secret" });
    expect(
      (
        await inject(app as RequestListenerLike, "GET", "/api/status", {
          headers: { "x-admin-token": "guess" },
        })
      ).status
    ).toBe(401);

    const accepted: Array<Record<string, string>> = [
      { "x-admin-token": "panel-secret" },
      { authorization: "Bearer panel-secret" },
    ];
    for (const headers of accepted) {
      const res = await inject(app as RequestListenerLike, "GET", "/api/status", { headers });
      expect(res.status).toBe(200);
    }
  });

  it("still enforces CSRF for an authenticated caller", async () => {
    // The shared token authenticates the operator; it does not excuse a
    // cross-site POST made from a page the operator happens to have open.
    const { app } = await loadApp({ ADMIN_TOKEN: "panel-secret" });
    const auth = { "x-admin-token": "panel-secret" };
    const res = await inject(app as RequestListenerLike, "POST", "/api/language", {
      headers: auth,
      body: { lang: "en" },
    });
    expect(res.status).toBe(403);

    const token = await csrfToken(app, auth);
    const allowed = await inject(app as RequestListenerLike, "POST", "/api/language", {
      headers: { ...auth, "x-csrf-token": token },
      body: { lang: "en" },
    });
    expect(allowed.status).toBe(200);
  });

  it("does not gate the static UI, only /api", async () => {
    // Locking the HTML shell would leave the operator with a blank page and no
    // way to enter the token.
    const { app } = await loadApp({ ADMIN_TOKEN: "panel-secret" });
    const res = await inject(app as RequestListenerLike, "GET", "/index.html");
    expect(res.status).toBe(200);
  });
});

describe("per-IP throttle", () => {
  it("returns 429 with a Retry-After once the spend budget is gone", async () => {
    const server = await loadApp();
    const app = server.app as unknown as RequestListenerLike;
    const token = await csrfToken(server.app);
    const headers = { "x-csrf-token": token };

    const statuses: number[] = [];
    let limited: Awaited<ReturnType<typeof inject>> | undefined;
    for (let i = 0; i < server.RATE_LIMITS.spend + 1; i += 1) {
      const res = await inject(app, "POST", "/api/jobs", { headers, body: {} });
      statuses.push(res.status);
      if (res.status === 429) limited = res;
    }

    // The first `spend` calls reach the handler (400: no kind supplied), and
    // only the one past the budget is throttled.
    expect(statuses.slice(0, server.RATE_LIMITS.spend).every((s) => s === 400)).toBe(true);
    expect(statuses[server.RATE_LIMITS.spend]).toBe(429);
    expect(limited?.json()).toMatchObject({ error: "rate_limited" });
    const retryAfter = Number(limited?.headers["retry-after"]);
    expect(retryAfter).toBeGreaterThanOrEqual(1);
    expect(retryAfter).toBeLessThanOrEqual(60);
    expect(limited?.json<{ retry_after_ms: number }>().retry_after_ms).toBeGreaterThan(0);
  });

  it("throttles the connection wizard on its own tighter budget", async () => {
    const server = await loadApp();
    const app = server.app as unknown as RequestListenerLike;
    const headers = { "x-csrf-token": await csrfToken(server.app) };

    for (let i = 0; i < server.RATE_LIMITS.connect; i += 1) {
      const res = await inject(app, "POST", "/api/connect", { headers, body: {} });
      expect(res.status).not.toBe(429);
    }
    expect((await inject(app, "POST", "/api/connect", { headers, body: {} })).status).toBe(429);
    // Exhausting the wizard bucket must not lock out job submission.
    expect((await inject(app, "POST", "/api/jobs", { headers, body: {} })).status).toBe(400);
  });

  it("keeps budgets per client address", async () => {
    const server = await loadApp();
    const app = server.app as unknown as RequestListenerLike;
    const headers = { "x-csrf-token": await csrfToken(server.app) };

    for (let i = 0; i < server.RATE_LIMITS.connect + 1; i += 1) {
      await inject(app, "POST", "/api/connect", {
        headers,
        body: {},
        remoteAddress: "10.0.0.1",
      });
    }
    // A different operator on another address must be unaffected.
    const other = await inject(app, "POST", "/api/connect", {
      headers,
      body: {},
      remoteAddress: "10.0.0.2",
    });
    expect(other.status).not.toBe(429);
  });

  it("does not throttle reads", async () => {
    // GETs cost nothing and the dashboard polls them; throttling would break
    // the panel rather than protect it.
    const server = await loadApp();
    const app = server.app as unknown as RequestListenerLike;
    for (let i = 0; i < server.RATE_LIMITS.spend + 5; i += 1) {
      expect((await inject(app, "GET", "/api/status")).status).toBe(200);
    }
  });

  it("rejects on CSRF before spending throttle budget", async () => {
    // Otherwise an unauthenticated flood could exhaust the merchant's own
    // budget and lock them out of their panel.
    const server = await loadApp();
    const app = server.app as unknown as RequestListenerLike;
    for (let i = 0; i < server.RATE_LIMITS.spend + 5; i += 1) {
      expect((await inject(app, "POST", "/api/jobs", { body: {} })).status).toBe(403);
    }
    const headers = { "x-csrf-token": await csrfToken(server.app) };
    expect((await inject(app, "POST", "/api/jobs", { headers, body: {} })).status).toBe(400);
  });

  it("throttles behind the admin gate, not in front of it", async () => {
    // An unauthenticated caller must not be able to consume the budget either.
    const server = await loadApp({ ADMIN_TOKEN: "panel-secret" });
    const app = server.app as unknown as RequestListenerLike;
    for (let i = 0; i < server.RATE_LIMITS.spend + 5; i += 1) {
      expect((await inject(app, "POST", "/api/jobs", { body: {} })).status).toBe(401);
    }
    const auth = { "x-admin-token": "panel-secret" };
    const headers = { ...auth, "x-csrf-token": await csrfToken(server.app, auth) };
    expect((await inject(app, "POST", "/api/jobs", { headers, body: {} })).status).toBe(400);
  });
});

describe("job submit validation", () => {
  it("requires kind and a non-empty product_ids before spending anything", async () => {
    const server = await loadApp();
    const app = server.app as unknown as RequestListenerLike;
    const headers = { "x-csrf-token": await csrfToken(server.app) };

    const noKind = await inject(app, "POST", "/api/jobs", {
      headers,
      body: { product_ids: [1] },
    });
    expect(noKind.status).toBe(400);
    expect(noKind.json<{ error: string }>().error).toMatch(/kind is required/);

    for (const body of [
      { kind: "description" },
      { kind: "description", product_ids: [] },
      { kind: "description", product_ids: "nope" },
    ]) {
      const res = await inject(app, "POST", "/api/jobs", { headers, body });
      expect(res.status).toBe(400);
      expect(res.json<{ error: string }>().error).toMatch(/product_ids is required/);
    }
  });

  it("refuses a job before a store is connected", async () => {
    const server = await loadApp();
    const app = server.app as unknown as RequestListenerLike;
    const headers = { "x-csrf-token": await csrfToken(server.app) };
    const res = await inject(app, "POST", "/api/jobs", {
      headers,
      body: { kind: "description", product_ids: [1] },
    });
    expect(res.status).toBe(400);
    expect(res.json<{ error: string }>().error).toMatch(/Not connected/);
  });
});

describe("settings validation", () => {
  it("rejects an unknown model, language or tone", async () => {
    const server = await loadApp();
    const app = server.app as unknown as RequestListenerLike;
    const headers = { "x-csrf-token": await csrfToken(server.app) };

    for (const [body, message] of [
      [{ default_model: "not-a-model" }, /unknown model/],
      [{ default_language: "kl" }, /unknown language/],
      [{ default_tone: "sarcastic" }, /unknown tone/],
    ] as const) {
      const res = await inject(app, "POST", "/api/settings", { headers, body });
      expect(res.status).toBe(400);
      expect(res.json<{ error: string }>().error).toMatch(message);
    }
  });

  it("persists a valid patch and echoes the stored values", async () => {
    const server = await loadApp();
    const app = server.app as unknown as RequestListenerLike;
    const headers = { "x-csrf-token": await csrfToken(server.app) };

    const res = await inject(app, "POST", "/api/settings", {
      headers,
      body: { default_language: "en", default_tone: "luxury", auto_alt_text: true },
    });
    expect(res.status).toBe(200);
    expect(res.json()).toMatchObject({
      default_language: "en",
      default_tone: "luxury",
      auto_alt_text: true,
    });
    // Survives into the status payload the SPA reads on boot.
    const status = await inject(app, "GET", "/api/status");
    expect(status.json()).toMatchObject({ default_language: "en", auto_alt_text: true });
  });
});

describe("i18n route", () => {
  it("serves pl by default and en on request, falling back for junk", async () => {
    const server = await loadApp();
    const app = server.app as unknown as RequestListenerLike;
    const pl = await inject(app, "GET", "/api/i18n/pl");
    expect(pl.json<{ lang: string }>().lang).toBe("pl");
    expect((await inject(app, "GET", "/api/i18n/en")).json<{ lang: string }>().lang).toBe("en");
    expect((await inject(app, "GET", "/api/i18n/xx")).json<{ lang: string }>().lang).toBe("pl");
  });

  it("includes the variant toggle strings the wizard renders", async () => {
    const server = await loadApp();
    const app = server.app as unknown as RequestListenerLike;
    for (const lang of ["pl", "en"]) {
      const strings = (
        await inject(app, "GET", `/api/i18n/${lang}`)
      ).json<{ strings: Record<string, string> }>().strings;
      expect(strings["option_include_variants"]).toBeTruthy();
      // The help text is where the product-level caveat is disclosed, so an
      // empty string here would ship a misleading feature.
      expect(strings["option_include_variants_help"]).toMatch(/Shoper/);
    }
  });
});
