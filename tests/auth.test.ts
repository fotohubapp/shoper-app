/**
 * Shoper auth handling. The 401-vs-403 split is the whole point of these tests:
 * a 401 means the bearer token went stale and one re-auth fixes it, while in
 * Shoper a 403 means the webapi user was never granted the resource. Treating
 * them alike burns a round trip on every permission error and reports the
 * merchant's own admin misconfiguration as an auth failure, so both directions
 * are pinned: exactly one refresh on 401, exactly zero on 403.
 */

import { describe, expect, it } from "vitest";
import { ShoperClient } from "../src/shoper-client";
import {
  ShoperAuthError,
  ShoperNotFound,
  ShoperPermissionError,
  ShoperRateLimitError,
  ShoperValidationError,
} from "../src/types";
import { FetchStub, listBody } from "./helpers";

const STORE = "https://sklep123456.shoparena.pl";

/** Client that owns credentials, so re-authentication is possible. */
function credentialClient(stub: FetchStub, overrides: Record<string, unknown> = {}): ShoperClient {
  return new ShoperClient({
    storeUrl: STORE,
    login: "webapi-user",
    password: "webapi-pass",
    fetchImpl: stub.fetch,
    // Keep retry sleeps at the floor and open the throttle wide: these tests
    // assert on call sequences, not on timing, and must not burn wall clock in
    // the leaky bucket (which spaces calls 500ms apart at the default 2 rps).
    retryBaseMs: 1,
    retryMaxMs: 1,
    requestsPerSecond: 10_000,
    etagCache: false,
    ...overrides,
  });
}

function authOk(token = "token-1", expiresIn = 3600): { body: Record<string, unknown> } {
  return { body: { access_token: token, expires_in: expiresIn } };
}

const PRODUCT = { product_id: 7, translations: { pl_PL: { name: "Buty" } } };

describe("token acquisition", () => {
  it("authenticates once with Basic credentials and reuses the bearer token", async () => {
    const stub = new FetchStub()
      .push(authOk())
      .push({ body: PRODUCT })
      .push({ body: PRODUCT });
    const client = credentialClient(stub);

    await client.getProduct(7);
    await client.getProduct(7);

    expect(stub.callsTo("/auth")).toHaveLength(1);
    const basic = Buffer.from("webapi-user:webapi-pass").toString("base64");
    expect(stub.callsTo("/auth")[0]!.headers["Authorization"]).toBe(`Basic ${basic}`);
    const reads = stub.callsTo("/products/7");
    expect(reads).toHaveLength(2);
    expect(reads[1]!.headers["Authorization"]).toBe("Bearer token-1");
  });

  it("never calls /auth when a static access token was supplied", async () => {
    const stub = new FetchStub().push({ body: PRODUCT });
    const client = new ShoperClient({
      storeUrl: STORE,
      accessToken: "static-token",
      fetchImpl: stub.fetch,
      etagCache: false,
    });

    await client.getProduct(7);
    expect(stub.callsTo("/auth")).toHaveLength(0);
    expect(stub.calls[0]!.headers["Authorization"]).toBe("Bearer static-token");
  });

  it("refuses to construct without either credential form", () => {
    expect(() => new ShoperClient({ storeUrl: STORE })).toThrow(/accessToken or login\+password/);
  });

  it("refreshes proactively once the token is inside the skew window", async () => {
    // expires_in 60s with a 5-minute skew means the very next call must re-auth
    // rather than send a token the store is about to reject.
    const stub = new FetchStub()
      .push(authOk("token-1", 60))
      .push({ body: PRODUCT })
      .push(authOk("token-2", 3600))
      .push({ body: PRODUCT });
    const client = credentialClient(stub);

    await client.getProduct(7);
    await client.getProduct(7);

    expect(stub.callsTo("/auth")).toHaveLength(2);
    expect(stub.callsTo("/products/7")[1]!.headers["Authorization"]).toBe("Bearer token-2");
  });
});

describe("401 handling", () => {
  it("re-authenticates exactly once and retries the request", async () => {
    const stub = new FetchStub()
      .push(authOk("stale-token"))
      .push({ status: 401, body: { error: "invalid_token" } })
      .push(authOk("fresh-token"))
      .push({ body: PRODUCT });
    const client = credentialClient(stub);

    const product = await client.getProduct(7);

    expect(product.product_id).toBe(7);
    // One initial auth plus exactly one refresh: not two, not zero.
    expect(stub.callsTo("/auth")).toHaveLength(2);
    const reads = stub.callsTo("/products/7");
    expect(reads).toHaveLength(2);
    expect(reads[0]!.headers["Authorization"]).toBe("Bearer stale-token");
    expect(reads[1]!.headers["Authorization"]).toBe("Bearer fresh-token");
  });

  it("does not loop when the retry is also rejected", async () => {
    const stub = new FetchStub()
      .push(authOk("t1"))
      .push({ status: 401, body: { error: "invalid_token" } })
      .push(authOk("t2"))
      .push({ status: 401, body: { error_description: "still bad" } });
    const client = credentialClient(stub);

    const error = await client.getProduct(7).catch((e) => e);
    expect(error).toBeInstanceOf(ShoperAuthError);
    expect(error.status).toBe(401);
    // The second 401 must surface, not trigger a third auth.
    expect(stub.callsTo("/auth")).toHaveLength(2);
    expect(stub.callsTo("/products/7")).toHaveLength(2);
  });

  it("does not attempt a refresh when the token is static", async () => {
    const stub = new FetchStub().push({ status: 401, body: { error: "invalid_token" } });
    const client = new ShoperClient({
      storeUrl: STORE,
      accessToken: "static-token",
      fetchImpl: stub.fetch,
      etagCache: false,
    });

    await expect(client.getProduct(7)).rejects.toBeInstanceOf(ShoperAuthError);
    expect(stub.callsTo("/auth")).toHaveLength(0);
    expect(stub.calls).toHaveLength(1);
  });
});

describe("403 handling", () => {
  it("does NOT re-authenticate and reports insufficient permission", async () => {
    const stub = new FetchStub()
      .push(authOk())
      .push({ status: 403, body: { error: "Forbidden" } });
    const client = credentialClient(stub);

    const error = await client.getProduct(7).catch((e) => e);

    expect(error).toBeInstanceOf(ShoperPermissionError);
    expect(error).not.toBeInstanceOf(ShoperAuthError);
    expect(error.status).toBe(403);
    expect(error.message).toContain("insufficient permission");
    // The remedy is a Shoper admin permission grant, so the message must say
    // so instead of implying the token is stale.
    expect(error.message).toContain("not a token problem");
    // Only the initial auth: no refresh, and no second read.
    expect(stub.callsTo("/auth")).toHaveLength(1);
    expect(stub.callsTo("/products/7")).toHaveLength(1);
    expect(stub.calls).toHaveLength(2);
  });

  it("names the path the webapi user could not reach", async () => {
    const stub = new FetchStub().push(authOk()).push({ status: 403, body: {} });
    const client = credentialClient(stub);
    const error = await client.getProductStocks(7).catch((e) => e);
    expect(error.message).toContain("/product-stocks");
  });

  it("keeps the token usable for other resources after a 403", async () => {
    // A permission error on one endpoint must not invalidate the bearer token,
    // or every later call pays for a needless re-auth.
    const stub = new FetchStub()
      .push(authOk("token-1"))
      .push({ status: 403, body: {} })
      .push({ body: PRODUCT });
    const client = credentialClient(stub);

    await expect(client.getProductStocks(7)).rejects.toBeInstanceOf(ShoperPermissionError);
    await client.getProduct(7);

    expect(stub.callsTo("/auth")).toHaveLength(1);
    expect(stub.callsTo("/products/7")[0]!.headers["Authorization"]).toBe("Bearer token-1");
  });
});

describe("other status mapping", () => {
  it("maps 404, 422 and 429 to their own error classes", async () => {
    const cases: Array<[number, unknown]> = [
      [404, ShoperNotFound],
      [422, ShoperValidationError],
    ];
    for (const [status, expected] of cases) {
      const stub = new FetchStub().push(authOk()).push({ status, body: { error: "no" } });
      const client = credentialClient(stub);
      const error = await client.getProduct(7).catch((e) => e);
      expect(error).toBeInstanceOf(expected as never);
    }

    // 429 is retryable, so it only surfaces once the retry budget is gone.
    const rateStub = new FetchStub().push(authOk()).setFallback({
      status: 429,
      headers: { "retry-after": "0" },
      body: { error: "slow down" },
    });
    const rateClient = credentialClient(rateStub, { maxRetries: 1 });
    await expect(rateClient.getProduct(7)).rejects.toBeInstanceOf(ShoperRateLimitError);
  });

  it("returns undefined for an allowed 404 instead of throwing", async () => {
    const stub = new FetchStub().push(authOk()).push({ status: 404, body: { error: "gone" } });
    const client = credentialClient(stub);
    await expect(client.getProductImage(999)).resolves.toBeUndefined();
  });

  it("redacts the password when auth itself fails", async () => {
    const stub = new FetchStub().push({
      status: 401,
      body: { error_description: "bad credentials for password=webapi-pass" },
    });
    const client = credentialClient(stub);
    const error = await client.getProduct(7).catch((e) => e);
    expect(error).toBeInstanceOf(ShoperAuthError);
    expect(error.message).not.toContain("webapi-pass");
  });

  it("healthCheck reports the failure instead of throwing", async () => {
    const stub = new FetchStub().push(authOk()).push({ status: 403, body: {} });
    const client = credentialClient(stub);
    const health = await client.healthCheck();
    expect(health.ok).toBe(false);
    expect(health.error).toContain("insufficient permission");
  });

  it("healthCheck reports the product count on success", async () => {
    const stub = new FetchStub().push(authOk()).push({ body: listBody([PRODUCT], { count: 42 }) });
    const client = credentialClient(stub);
    await expect(client.healthCheck()).resolves.toEqual({ ok: true, count: 42 });
  });
});
