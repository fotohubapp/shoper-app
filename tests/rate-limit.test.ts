/**
 * Throttle and backoff. Shoper's webapi bucket is small, so this layer decides
 * whether a 500-product job finishes or dies half-way through 429s. Every test
 * drives the injected clock, jitter source and sleep (LeakyBucket takes all
 * three) rather than a real timer, so the assertions are on exact millisecond
 * values instead of "roughly about right".
 */

import { describe, expect, it } from "vitest";
import {
  LeakyBucket,
  backoffDelay,
  isRetryableStatus,
  parseRetryAfter,
  sleep,
} from "../src/http";
import { ShoperClient } from "../src/shoper-client";
import { ShoperRateLimitError, ShoperTransportError } from "../src/types";
import { FetchStub, sleepSpy } from "./helpers";

/**
 * Origin for the fake clock. It must be well past `capacity * interval`,
 * because the bucket accrues burst credit by looking backwards from `now` — at
 * a clock of 0 there is nothing to look back at and the burst would vanish,
 * which is a quirk of the test clock rather than of the code under test.
 */
const T0 = 1_000_000;

function makeBucket(config: {
  requestsPerSecond: number;
  burst?: number;
  maxWaitMs?: number;
  maxQueueLength?: number;
  jitterMs?: number;
  random?: () => number;
  /**
   * When false a recorded wait does not move the clock, which models several
   * callers arriving in the same instant — the case maxWaitMs guards.
   */
  advanceOnSleep?: boolean;
}): {
  bucket: LeakyBucket;
  waits: number[];
  advance: (ms: number) => void;
  now: () => number;
} {
  let clock = T0;
  const waits: number[] = [];
  const advanceOnSleep = config.advanceOnSleep !== false;
  const instance = new LeakyBucket({
    ...config,
    now: () => clock,
    // The sleep is recorded, not performed, so a "wait" never costs real time.
    sleepImpl: async (ms: number) => {
      waits.push(ms);
      if (advanceOnSleep) clock += ms;
    },
    random: config.random ?? ((): number => 0),
  });
  return { bucket: instance, waits, advance: (ms) => (clock += ms), now: () => clock };
}

describe("LeakyBucket", () => {
  it("lets the burst through with no wait at all", async () => {
    const { bucket: b, waits } = makeBucket({ requestsPerSecond: 3, burst: 3 });
    await b.take();
    await b.take();
    await b.take();
    expect(waits).toEqual([]);
  });

  it("spaces sustained calls at 1/rps once the burst is spent", async () => {
    const { bucket: b, waits } = makeBucket({ requestsPerSecond: 2, burst: 1 });
    for (let i = 0; i < 5; i += 1) await b.take();
    // 2 rps -> 500ms apart. The first two go straight through (the burst token
    // plus the credit already accrued), then every later call pays the spacing.
    expect(waits).toEqual([500, 500, 500]);
  });

  it("adds jitter from the injected random source, not Math.random", async () => {
    const { bucket: b, waits } = makeBucket({
      requestsPerSecond: 2,
      burst: 1,
      jitterMs: 100,
      random: () => 0.5,
    });
    await b.take();
    await b.take();
    await b.take();
    // 0.5 * 100ms of jitter rides on top of each 500ms interval and compounds
    // into the next slot, which is what de-synchronises parallel callers.
    expect(waits).toEqual([50, 550]);
  });

  it("uses no jitter when jitterMs is left at the default", async () => {
    const { bucket: b, waits } = makeBucket({ requestsPerSecond: 2, burst: 1 });
    await b.take();
    await b.take();
    await b.take();
    expect(waits.every((w) => w % 500 === 0)).toBe(true);
  });

  it("recovers burst capacity while idle", async () => {
    const { bucket: b, waits, advance } = makeBucket({ requestsPerSecond: 2, burst: 2 });
    await b.take();
    await b.take();
    // Idle long enough to refill the whole bucket.
    advance(5_000);
    await b.take();
    await b.take();
    expect(waits).toEqual([]);
  });

  it("rejects a caller whose projected wait exceeds maxWaitMs", async () => {
    // advanceOnSleep false models a burst of callers arriving in the same
    // instant, which is exactly when the fail-fast guard has to fire: at 1 rps
    // the fourth simultaneous caller is already 2s out.
    const { bucket: b } = makeBucket({
      requestsPerSecond: 1,
      burst: 1,
      maxWaitMs: 1_200,
      advanceOnSleep: false,
    });
    await b.take();
    await b.take();
    await b.take();
    await expect(b.take()).rejects.toBeInstanceOf(ShoperTransportError);
    await expect(b.take()).rejects.toThrow(/exceeds maxWaitMs/);
  });

  it("gives the slot back when it refuses, so the next caller is not punished", async () => {
    // A refusal must not consume the reservation, or one over-long wait would
    // push every later caller further out and cascade into more refusals.
    const { bucket: b, waits } = makeBucket({
      requestsPerSecond: 1,
      burst: 1,
      maxWaitMs: 1_500,
      advanceOnSleep: false,
    });
    await b.take();
    await b.take();
    await b.take();
    const first = await b.take().catch((e: Error) => e.message);
    const second = await b.take().catch((e: Error) => e.message);
    // Both refusals quote the same 2000ms schedule. If the slot had been
    // consumed the second would have quoted 3000ms.
    expect(first).toMatch(/wait 2000ms exceeds/);
    expect(second).toBe(first);
    expect(waits).toEqual([1_000]);
  });

  it("rejects once the queue is saturated", async () => {
    // Real (tiny) sleeps here: the point is to hold callers inside take() at
    // the same time, which a synchronous fake sleep cannot express.
    let clock = T0;
    const b = new LeakyBucket({
      requestsPerSecond: 0.5,
      burst: 1,
      maxQueueLength: 1,
      maxWaitMs: 60_000,
      now: () => clock,
      sleepImpl: async () => {
        await new Promise((resolve) => setTimeout(resolve, 5));
      },
      random: () => 0,
    });
    await b.take();
    await b.take();

    const outcomes = await Promise.all(
      [b.take(), b.take(), b.take()].map((p) =>
        p.then(
          () => "granted",
          (e: Error) => e.message
        )
      )
    );
    // One waiter fits the queue; the rest are refused rather than piling up.
    expect(outcomes[0]).toBe("granted");
    expect(outcomes[1]).toMatch(/queue full/);
    expect(outcomes[2]).toMatch(/queue full/);
    expect(clock).toBe(T0);
  });

  it("reports the live queue depth and releases it afterwards", async () => {
    let clock = T0;
    const b = new LeakyBucket({
      requestsPerSecond: 1,
      burst: 1,
      now: () => clock,
      sleepImpl: async () => {
        await new Promise((resolve) => setTimeout(resolve, 5));
      },
      random: () => 0,
    });
    await b.take();
    await b.take();
    expect(b.queueLength).toBe(0);
    const pending = b.take();
    // Surfaced in /api/health, so it has to be accurate while a caller waits.
    expect(b.queueLength).toBe(1);
    await pending;
    expect(b.queueLength).toBe(0);
  });

  it("penalise pushes every later caller out, not just the one that got the 429", async () => {
    const { bucket: b, waits } = makeBucket({ requestsPerSecond: 100, burst: 100 });
    b.penalise(3_000);
    await b.take();
    expect(waits).toEqual([3_000]);
  });

  it("keeps the longest outstanding penalty", async () => {
    const { bucket: b, waits } = makeBucket({ requestsPerSecond: 100, burst: 100 });
    b.penalise(5_000);
    b.penalise(1_000);
    await b.take();
    expect(waits).toEqual([5_000]);
  });

  it("treats a negative penalty as zero", async () => {
    const { bucket: b, waits } = makeBucket({ requestsPerSecond: 100, burst: 100 });
    b.penalise(-5_000);
    await b.take();
    expect(waits).toEqual([]);
  });

  it("clamps an absurd rate instead of dividing by zero", async () => {
    const { bucket: b, waits } = makeBucket({ requestsPerSecond: 0, burst: 1 });
    await b.take();
    await b.take();
    await b.take();
    // Floor is 0.05 rps -> 20s spacing: finite, never Infinity or NaN.
    expect(waits).toEqual([20_000]);
    expect(waits.every((w) => Number.isFinite(w))).toBe(true);
  });
});

describe("sleep", () => {
  it("resolves immediately for a non-positive duration", async () => {
    // Guards the hot path: a computed delay of 0 must not cost a macrotask.
    await expect(sleep(0)).resolves.toBeUndefined();
    await expect(sleep(-100)).resolves.toBeUndefined();
  });

  it("rejects when the signal is already aborted", async () => {
    const controller = new AbortController();
    controller.abort();
    await expect(sleep(50_000, controller.signal)).rejects.toBeInstanceOf(ShoperTransportError);
  });

  it("rejects as soon as the signal aborts mid-wait", async () => {
    const controller = new AbortController();
    const pending = sleep(50_000, controller.signal);
    controller.abort();
    await expect(pending).rejects.toThrow(/aborted while waiting/);
  });
});

describe("backoffDelay", () => {
  it("grows exponentially and stays inside the half-jitter band", () => {
    for (let attempt = 1; attempt <= 6; attempt += 1) {
      const base = 500 * 2 ** (attempt - 1);
      const low = backoffDelay({ baseMs: 500, maxMs: 60_000, attempt, random: () => 0 });
      const high = backoffDelay({
        baseMs: 500,
        maxMs: 60_000,
        attempt,
        random: () => 0.999,
      });
      expect(low).toBe(Math.round(base * 0.5));
      expect(high).toBeLessThanOrEqual(Math.round(base * 1.5));
      expect(high).toBeGreaterThan(low);
    }
  });

  it("never exceeds maxMs", () => {
    const delay = backoffDelay({
      baseMs: 500,
      maxMs: 4_000,
      attempt: 20,
      random: () => 0.999,
    });
    expect(delay).toBe(4_000);
  });

  it("prefers Retry-After when the server asked for longer", () => {
    const delay = backoffDelay({
      baseMs: 500,
      maxMs: 60_000,
      attempt: 1,
      retryAfterMs: 9_000,
      random: () => 0,
    });
    expect(delay).toBe(9_000);
  });

  it("ignores a Retry-After shorter than the computed backoff", () => {
    // Obeying a tiny Retry-After after repeated failures would hammer a store
    // that is already struggling.
    const delay = backoffDelay({
      baseMs: 1_000,
      maxMs: 60_000,
      attempt: 4,
      retryAfterMs: 10,
      random: () => 0,
    });
    expect(delay).toBe(4_000);
  });

  it("still caps a Retry-After that is absurdly long", () => {
    const delay = backoffDelay({
      baseMs: 500,
      maxMs: 10_000,
      attempt: 1,
      retryAfterMs: 3_600_000,
      random: () => 0,
    });
    expect(delay).toBe(10_000);
  });

  it("treats attempt 0 or negative as attempt 1", () => {
    const first = backoffDelay({ baseMs: 500, maxMs: 60_000, attempt: 1, random: () => 0 });
    expect(backoffDelay({ baseMs: 500, maxMs: 60_000, attempt: 0, random: () => 0 })).toBe(first);
    expect(backoffDelay({ baseMs: 500, maxMs: 60_000, attempt: -5, random: () => 0 })).toBe(first);
  });
});

describe("parseRetryAfter", () => {
  it("reads delta-seconds", () => {
    expect(parseRetryAfter("30")).toBe(30_000);
    expect(parseRetryAfter(" 1.5 ")).toBe(1_500);
    expect(parseRetryAfter("0")).toBe(0);
  });

  it("reads an HTTP-date relative to the supplied clock", () => {
    const now = Date.parse("2026-01-01T00:00:00Z");
    expect(parseRetryAfter("Thu, 01 Jan 2026 00:00:30 GMT", now)).toBe(30_000);
  });

  it("clamps a date already in the past to zero", () => {
    const now = Date.parse("2026-01-01T00:01:00Z");
    expect(parseRetryAfter("Thu, 01 Jan 2026 00:00:00 GMT", now)).toBe(0);
  });

  it("treats a negative delta as zero rather than a negative sleep", () => {
    expect(parseRetryAfter("-30")).toBe(0);
  });

  it("returns undefined for absent or unparseable values", () => {
    expect(parseRetryAfter(undefined)).toBeUndefined();
    expect(parseRetryAfter(null)).toBeUndefined();
    expect(parseRetryAfter("")).toBeUndefined();
    expect(parseRetryAfter("   ")).toBeUndefined();
    expect(parseRetryAfter("soon")).toBeUndefined();
  });
});

describe("isRetryableStatus", () => {
  it("covers the transient statuses and nothing else", () => {
    for (const status of [408, 425, 429, 500, 502, 503, 504, 599]) {
      expect(isRetryableStatus(status)).toBe(true);
    }
    // 401/403 must never be retried: one is handled by a token refresh, the
    // other is a permission grant only the merchant can make.
    for (const status of [200, 304, 400, 401, 403, 404, 409, 422, 600]) {
      expect(isRetryableStatus(status)).toBe(false);
    }
  });
});

describe("ShoperClient 429 handling", () => {
  const STORE = "https://sklep123456.shoparena.pl";

  function client(stub: FetchStub, overrides: Record<string, unknown> = {}): ShoperClient {
    return new ShoperClient({
      storeUrl: STORE,
      accessToken: "static-token",
      fetchImpl: stub.fetch,
      requestsPerSecond: 10_000,
      retryBaseMs: 1,
      retryMaxMs: 1,
      etagCache: false,
      ...overrides,
    });
  }

  it("pushes the server's Retry-After onto the shared bucket before retrying", async () => {
    // Retry-After is honoured by penalising the shared bucket, so the delay is
    // inherited by every other queued caller, not just the unlucky one. The
    // exact arithmetic is pinned deterministically in the backoffDelay block;
    // here the header is 200ms against a 1ms backoff base, so an elapsed time
    // near 200ms can only mean the header won.
    const stub = new FetchStub()
      .push({ status: 429, headers: { "retry-after": "0.2" }, body: { error: "slow" } })
      .push({ body: { product_id: 7 } });
    const throttled = client(stub, { retryBaseMs: 1, retryMaxMs: 30_000 });

    const started = Date.now();
    const product = await throttled.getProduct(7);
    const elapsed = Date.now() - started;

    expect(product.product_id).toBe(7);
    expect(stub.calls).toHaveLength(2);
    expect(elapsed).toBeGreaterThanOrEqual(150);
  });

  it("caps the honoured Retry-After at retryMaxMs", async () => {
    // A store that answers "retry-after: 3600" must not park the job for an
    // hour; the configured ceiling wins.
    const stub = new FetchStub()
      .push({ status: 429, headers: { "retry-after": "3600" }, body: { error: "slow" } })
      .push({ body: { product_id: 7 } });
    const throttled = client(stub, { retryBaseMs: 10, retryMaxMs: 60 });

    const started = Date.now();
    await throttled.getProduct(7);
    expect(Date.now() - started).toBeLessThan(1_000);
    expect(stub.calls).toHaveLength(2);
  });

  it("throws ShoperRateLimitError with the parsed delay once retries run out", async () => {
    const stub = new FetchStub().setFallback({
      status: 429,
      headers: { "retry-after": "0" },
      body: { error: "rate limited" },
    });
    const limited = client(stub, { maxRetries: 2 });

    const error = await limited.getProduct(7).catch((e) => e);
    expect(error).toBeInstanceOf(ShoperRateLimitError);
    expect(Number.isFinite(error.retryAfterMs)).toBe(true);
    // 1 initial attempt plus 2 retries.
    expect(stub.calls).toHaveLength(3);
  });

  it("defaults retryAfterMs when the 429 carries no header", async () => {
    const stub = new FetchStub().setFallback({ status: 429, body: { error: "no header" } });
    const limited = client(stub, { maxRetries: 0 });
    const error = await limited.getProduct(7).catch((e) => e);
    expect(error).toBeInstanceOf(ShoperRateLimitError);
    expect(error.retryAfterMs).toBe(1_000);
  });

  it("retries 5xx and gives up as a transport error, not a silent success", async () => {
    const stub = new FetchStub().setFallback({ status: 503, body: "" });
    const flaky = client(stub, { maxRetries: 2 });
    const error = await flaky.getProduct(7).catch((e) => e);
    // The final 503 is not retryable any more, so it surfaces as an API error.
    expect(error.status).toBe(503);
    expect(stub.calls).toHaveLength(3);
  });

  it("retries a network failure and then succeeds", async () => {
    let calls = 0;
    const flaky = new ShoperClient({
      storeUrl: STORE,
      accessToken: "static-token",
      requestsPerSecond: 10_000,
      retryBaseMs: 1,
      retryMaxMs: 1,
      etagCache: false,
      fetchImpl: (async () => {
        calls += 1;
        if (calls === 1) throw new Error("ECONNRESET");
        return {
          ok: true,
          status: 200,
          headers: { get: () => null },
          text: async () => JSON.stringify({ product_id: 7 }),
          arrayBuffer: async () => new ArrayBuffer(0),
        };
      }) as never,
    });

    await expect(flaky.getProduct(7)).resolves.toMatchObject({ product_id: 7 });
    expect(calls).toBe(2);
  });

  it("surfaces a transport error once the retry budget is gone", async () => {
    const dead = new ShoperClient({
      storeUrl: STORE,
      accessToken: "static-token",
      requestsPerSecond: 10_000,
      retryBaseMs: 1,
      retryMaxMs: 1,
      maxRetries: 1,
      etagCache: false,
      fetchImpl: (async () => {
        throw new Error("ECONNREFUSED");
      }) as never,
    });
    const error = await dead.getProduct(7).catch((e) => e);
    expect(error).toBeInstanceOf(ShoperTransportError);
    expect(error.message).toContain("ECONNREFUSED");
  });
});

describe("sleepSpy contract", () => {
  it("records waits without spending them", async () => {
    const { sleep: spy, waits } = sleepSpy();
    const before = Date.now();
    await spy(60_000);
    expect(waits).toEqual([60_000]);
    expect(Date.now() - before).toBeLessThan(1_000);
  });
});
