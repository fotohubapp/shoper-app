/**
 * Webhook verification. This is the app's only unauthenticated inbound path —
 * anything that gets past it can create drafts against the merchant's live
 * catalogue — so the failure modes are covered explicitly: a wrong secret, a
 * truncated signature (which crashes a naive timingSafeEqual), a redelivery and
 * a stale timestamp.
 */

import { createHmac } from "crypto";
import { afterEach, describe, expect, it } from "vitest";
import { CommerceBridgeClient } from "../src/bridge-client";
import { DraftStore } from "../src/draft-store";
import {
  REPLAY_WINDOW_MS,
  checkReplay,
  deriveDeliveryId,
  isKnownEvent,
} from "../src/webhook";
import type { WebhookPayload } from "../src/types";

const SECRET = "callback-secret-value";

function sign(body: string | Buffer, secret = SECRET): string {
  return createHmac("sha256", secret).update(body).digest("hex");
}

const stores: DraftStore[] = [];

/** In-memory store: no file IO, no shared state between tests. */
function memStore(): DraftStore {
  const store = new DraftStore(":memory:", "test-passphrase-0123456789");
  stores.push(store);
  return store;
}

afterEach(() => {
  while (stores.length > 0) stores.pop()?.close();
});

describe("CommerceBridgeClient.verifyWebhookSignature", () => {
  const body = JSON.stringify({ event: "commerce.job.completed", job_id: "job_1" });

  it("accepts a correct hex signature", () => {
    expect(CommerceBridgeClient.verifyWebhookSignature(body, sign(body), SECRET)).toBe(true);
  });

  it("accepts the sha256= prefix and upper-case hex", () => {
    const hex = sign(body);
    expect(
      CommerceBridgeClient.verifyWebhookSignature(body, `sha256=${hex.toUpperCase()}`, SECRET)
    ).toBe(true);
    expect(
      CommerceBridgeClient.verifyWebhookSignature(body, `SHA256=${hex}`, SECRET)
    ).toBe(true);
  });

  it("ignores surrounding whitespace on the header", () => {
    expect(
      CommerceBridgeClient.verifyWebhookSignature(body, `  ${sign(body)}  `, SECRET)
    ).toBe(true);
  });

  it("rejects a signature made with a different secret", () => {
    expect(
      CommerceBridgeClient.verifyWebhookSignature(body, sign(body, "other-secret"), SECRET)
    ).toBe(false);
  });

  it("rejects a tampered body", () => {
    const signature = sign(body);
    const tampered = body.replace("job_1", "job_2");
    expect(CommerceBridgeClient.verifyWebhookSignature(tampered, signature, SECRET)).toBe(false);
  });

  it("returns false (never throws) on a truncated signature", () => {
    // timingSafeEqual throws on unequal buffer lengths; a truncated header must
    // be a clean rejection, not a 500 that leaks a stack trace.
    const truncated = sign(body).slice(0, 30);
    expect(() =>
      CommerceBridgeClient.verifyWebhookSignature(body, truncated, SECRET)
    ).not.toThrow();
    expect(CommerceBridgeClient.verifyWebhookSignature(body, truncated, SECRET)).toBe(false);
  });

  it("rejects an over-long signature and one with non-hex characters", () => {
    expect(
      CommerceBridgeClient.verifyWebhookSignature(body, `${sign(body)}extra`, SECRET)
    ).toBe(false);
    expect(
      CommerceBridgeClient.verifyWebhookSignature(body, "z".repeat(64), SECRET)
    ).toBe(false);
  });

  it("rejects a missing or empty signature and an empty secret", () => {
    expect(CommerceBridgeClient.verifyWebhookSignature(body, undefined, SECRET)).toBe(false);
    expect(CommerceBridgeClient.verifyWebhookSignature(body, "", SECRET)).toBe(false);
    expect(CommerceBridgeClient.verifyWebhookSignature(body, "sha256=", SECRET)).toBe(false);
    expect(CommerceBridgeClient.verifyWebhookSignature(body, sign(body), "")).toBe(false);
  });

  it("verifies a Buffer body identically to a string body", () => {
    const buffer = Buffer.from(body, "utf8");
    expect(CommerceBridgeClient.verifyWebhookSignature(buffer, sign(body), SECRET)).toBe(true);
  });

  it("verifies a body containing multi-byte characters", () => {
    // Polish copy round-trips through this path constantly; a utf8/latin1 mixup
    // in the HMAC would reject every real delivery from a PL store.
    const utf8Body = JSON.stringify({ job_id: "j", note: "Żółć — ąęś" });
    expect(
      CommerceBridgeClient.verifyWebhookSignature(utf8Body, sign(utf8Body), SECRET)
    ).toBe(true);
  });

  it("signWebhook produces a digest verifyWebhookSignature accepts", () => {
    const signature = CommerceBridgeClient.signWebhook(body, SECRET);
    expect(signature).toMatch(/^[0-9a-f]{64}$/);
    expect(CommerceBridgeClient.verifyWebhookSignature(body, signature, SECRET)).toBe(true);
  });
});

describe("CommerceBridgeClient.parseWebhook", () => {
  const payload = { event: "commerce.job.completed", job_id: "job_42" };
  const body = JSON.stringify(payload);

  it("returns the payload on a good signature and null on a bad one", () => {
    expect(CommerceBridgeClient.parseWebhook(body, "deadbeef", SECRET)).toBeNull();
    expect(CommerceBridgeClient.parseWebhook(body, sign(body), SECRET)?.job_id).toBe("job_42");
  });

  it("returns null when a verified body is not JSON", () => {
    const raw = "not-json";
    expect(CommerceBridgeClient.parseWebhook(raw, sign(raw), SECRET)).toBeNull();
  });

  it("returns null when a verified body has no job_id", () => {
    // A signed but malformed payload must not reach the draft writer with an
    // undefined job id.
    for (const bad of [
      JSON.stringify({ event: "commerce.job.completed" }),
      JSON.stringify({ event: "x", job_id: 42 }),
      JSON.stringify([1, 2, 3]),
      "null",
    ]) {
      expect(CommerceBridgeClient.parseWebhook(bad, sign(bad), SECRET)).toBeNull();
    }
  });

  it("verifies before parsing, so an unsigned malformed body is still null", () => {
    expect(CommerceBridgeClient.parseWebhook("{oops", "0".repeat(64), SECRET)).toBeNull();
  });
});

describe("deriveDeliveryId", () => {
  const body = Buffer.from(JSON.stringify({ job_id: "j" }), "utf8");

  it("prefers the explicit header", () => {
    expect(deriveDeliveryId(body, "delivery-1", undefined)).toBe("delivery-1");
  });

  it("falls back to delivery_id then nonce in the payload", () => {
    expect(
      deriveDeliveryId(body, undefined, { job_id: "j", delivery_id: "from-body" } as WebhookPayload)
    ).toBe("from-body");
    expect(
      deriveDeliveryId(body, undefined, { job_id: "j", nonce: "from-nonce" } as WebhookPayload)
    ).toBe("from-nonce");
  });

  it("hashes the body when nothing identifies the delivery", () => {
    const derived = deriveDeliveryId(body, undefined, undefined);
    expect(derived).toMatch(/^[0-9a-f]{64}$/);
    // Stable, so a redelivery of the identical body is still detectable.
    expect(deriveDeliveryId(body, undefined, undefined)).toBe(derived);
    expect(deriveDeliveryId(Buffer.from("other"), undefined, undefined)).not.toBe(derived);
  });

  it("ignores a blank header and caps an absurdly long id", () => {
    expect(deriveDeliveryId(body, "   ", undefined)).toMatch(/^[0-9a-f]{64}$/);
    const long = "x".repeat(500);
    expect(deriveDeliveryId(body, long, undefined)).toHaveLength(200);
  });
});

describe("checkReplay", () => {
  const payload: WebhookPayload = { event: "commerce.job.completed", job_id: "job_1" };
  const now = 1_700_000_000_000;
  const nowSeconds = Math.floor(now / 1000);

  it("accepts a fresh delivery once", () => {
    const store = memStore();
    const first = checkReplay(store, "d-1", nowSeconds, payload, { now });
    expect(first.ok).toBe(true);
  });

  it("rejects the same delivery id the second time", () => {
    const store = memStore();
    checkReplay(store, "d-1", nowSeconds, payload, { now });
    const second = checkReplay(store, "d-1", nowSeconds, payload, { now });
    expect(second.ok).toBe(false);
    expect(second.reason).toBe("duplicate_delivery");
  });

  it("survives a restart, because the ids are persisted", () => {
    // Replay suppression that only lives in memory is defeated by a redeploy,
    // so the id has to come back from SQLite.
    const store = memStore();
    expect(checkReplay(store, "d-1", nowSeconds, payload, { now }).ok).toBe(true);
    expect(store.registerDelivery("d-1")).toBe(false);
  });

  it("rejects a timestamp older than the window", () => {
    const store = memStore();
    const stale = nowSeconds - (REPLAY_WINDOW_MS / 1000 + 60);
    const verdict = checkReplay(store, "d-stale", stale, payload, { now });
    expect(verdict.ok).toBe(false);
    expect(verdict.reason).toBe("stale_timestamp");
  });

  it("rejects a timestamp too far in the future", () => {
    // A clock-skew allowance in one direction only would let an attacker mint
    // a capture that stays valid indefinitely.
    const store = memStore();
    const future = nowSeconds + (REPLAY_WINDOW_MS / 1000 + 60);
    expect(checkReplay(store, "d-future", future, payload, { now }).reason).toBe(
      "stale_timestamp"
    );
  });

  it("does not burn the delivery id when the timestamp is stale", () => {
    // The id must stay unused, or a legitimate retry with a fresh timestamp
    // would be misreported as a duplicate.
    const store = memStore();
    const stale = nowSeconds - (REPLAY_WINDOW_MS / 1000 + 60);
    checkReplay(store, "d-1", stale, payload, { now });
    expect(checkReplay(store, "d-1", nowSeconds, payload, { now }).ok).toBe(true);
  });

  it("accepts a timestamp at the edge of the window", () => {
    const store = memStore();
    const edge = nowSeconds - REPLAY_WINDOW_MS / 1000;
    expect(checkReplay(store, "d-edge", edge, payload, { now }).ok).toBe(true);
  });

  it("honours a narrowed window", () => {
    const store = memStore();
    const verdict = checkReplay(store, "d-1", nowSeconds - 120, payload, {
      now,
      windowMs: 60_000,
    });
    expect(verdict.reason).toBe("stale_timestamp");
  });

  it("skips the timestamp check when no timestamp was sent", () => {
    // The bridge does not always send one; the delivery id is then the only
    // replay defence, and it must still work.
    const store = memStore();
    expect(checkReplay(store, "d-1", undefined, payload, { now }).ok).toBe(true);
    expect(checkReplay(store, "d-1", undefined, payload, { now }).reason).toBe(
      "duplicate_delivery"
    );
  });

  it("ignores an unparseable timestamp rather than rejecting the delivery", () => {
    const store = memStore();
    expect(checkReplay(store, "d-1", Number.NaN, payload, { now }).ok).toBe(true);
  });

  it("returns the delivery id on every verdict", () => {
    const store = memStore();
    expect(checkReplay(store, "d-1", nowSeconds, payload, { now }).deliveryId).toBe("d-1");
    expect(checkReplay(store, "d-1", nowSeconds, payload, { now }).deliveryId).toBe("d-1");
  });
});

describe("isKnownEvent", () => {
  it("accepts the four documented events", () => {
    for (const event of [
      "commerce.item.completed",
      "commerce.job.completed",
      "commerce.job.failed",
      "commerce.job.awaiting_credits",
    ]) {
      expect(isKnownEvent(event)).toBe(true);
    }
  });

  it("rejects anything else, including near-misses", () => {
    for (const event of ["commerce.job.complete", "job.completed", "", "__proto__"]) {
      expect(isKnownEvent(event)).toBe(false);
    }
  });
});
