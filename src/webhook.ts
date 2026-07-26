/**
 * Bridge webhook receiver.
 *
 * commerce-bridge POSTs callbacks to callback_url with headers:
 *   X-FotoHub-Signature  HMAC-SHA256 hex of the RAW body, keyed with the
 *                        connection's callback_secret (optionally `sha256=`
 *                        prefixed)
 *   X-FotoHub-Timestamp  unix seconds (optional; falls back to body.timestamp)
 *   X-FotoHub-Delivery   unique delivery id (optional; falls back to
 *                        body.delivery_id / a hash of the body)
 *
 * Security layers, in order:
 *   1. body size cap (raw parser),
 *   2. HMAC verification with a length pre-check and timing-safe compare,
 *   3. replay protection: timestamp must be inside REPLAY_WINDOW_MS and the
 *      delivery id must not have been seen before (persisted in SQLite, so a
 *      replay survives a restart),
 *   4. ack immediately (2xx) and process asynchronously — the bridge must never
 *      wait on a Shoper round trip.
 *
 * Events handled:
 *   commerce.item.completed       -> store the item as a pending draft
 *   commerce.job.completed        -> collect remaining items, mark terminal
 *   commerce.job.failed           -> mark terminal
 *   commerce.job.awaiting_credits -> update cached state, emit for the UI
 *
 * A typed EventEmitter is exposed so the server (or an SSE endpoint) can react
 * to deliveries without polling.
 */

import { createHash } from "crypto";
import { EventEmitter } from "events";
import { Router, raw } from "express";
import { CommerceBridgeClient } from "./bridge-client";
import { DraftStore } from "./draft-store";
import { captureBefore } from "./jobs";
import { ShoperClient } from "./shoper-client";
import {
  DraftPayload,
  JobItem,
  JobKind,
  LogSink,
  TERMINAL_JOB_STATUSES,
  WebhookEvent,
  WebhookPayload,
} from "./types";

/** Reject webhooks whose timestamp is further away than this. */
export const REPLAY_WINDOW_MS = 5 * 60 * 1000;
/** Max raw webhook body. */
export const MAX_WEBHOOK_BODY = "2mb";

export interface WebhookDeps {
  store: DraftStore;
  getBridge: () => CommerceBridgeClient;
  getShoper: () => ShoperClient;
  /** Emitter the server subscribes to. Created when omitted. */
  events?: WebhookEmitter;
  logger?: LogSink;
  /** Override the replay window (tests). */
  replayWindowMs?: number;
  /** Injectable clock (tests). */
  now?: () => number;
}

/* -------------------------------------------------------------------- */
/* Typed event emitter                                                   */
/* -------------------------------------------------------------------- */

export interface WebhookEventMap {
  /** Any accepted delivery, before handling. */
  delivery: [WebhookPayload];
  "item.completed": [{ jobId: string; item: JobItem; draftId?: number }];
  "job.completed": [{ jobId: string; collected: number }];
  "job.failed": [{ jobId: string }];
  "job.awaiting_credits": [{ jobId: string }];
  /** Rejected delivery (bad signature, replay, oversize). */
  rejected: [{ reason: string; status: number }];
  error: [Error];
}

/**
 * Small typed wrapper over node's EventEmitter so consumers get compile-time
 * checked event names and payloads.
 */
export class WebhookEmitter {
  private readonly emitter = new EventEmitter();

  constructor() {
    // A missing 'error' listener would crash the process; absorb by default.
    this.emitter.on("error", () => undefined);
    this.emitter.setMaxListeners(50);
  }

  on<K extends keyof WebhookEventMap>(
    event: K,
    listener: (...args: WebhookEventMap[K]) => void
  ): this {
    this.emitter.on(event as string, listener as (...args: unknown[]) => void);
    return this;
  }

  once<K extends keyof WebhookEventMap>(
    event: K,
    listener: (...args: WebhookEventMap[K]) => void
  ): this {
    this.emitter.once(event as string, listener as (...args: unknown[]) => void);
    return this;
  }

  off<K extends keyof WebhookEventMap>(
    event: K,
    listener: (...args: WebhookEventMap[K]) => void
  ): this {
    this.emitter.off(event as string, listener as (...args: unknown[]) => void);
    return this;
  }

  emit<K extends keyof WebhookEventMap>(event: K, ...args: WebhookEventMap[K]): boolean {
    return this.emitter.emit(event as string, ...args);
  }

  listenerCount<K extends keyof WebhookEventMap>(event: K): number {
    return this.emitter.listenerCount(event as string);
  }
}

/* -------------------------------------------------------------------- */
/* Replay protection                                                     */
/* -------------------------------------------------------------------- */

export interface ReplayCheck {
  ok: boolean;
  reason?: "stale_timestamp" | "duplicate_delivery";
  deliveryId: string;
}

/** Derive a stable delivery id when the bridge did not send one. */
export function deriveDeliveryId(
  rawBody: string | Buffer,
  header: string | undefined,
  payload: WebhookPayload | undefined
): string {
  const explicit = header?.trim() || payload?.delivery_id || payload?.nonce;
  if (explicit && typeof explicit === "string" && explicit.length > 0) {
    return explicit.slice(0, 200);
  }
  return createHash("sha256").update(rawBody).digest("hex");
}

/**
 * Verify the timestamp window and register the delivery id.
 * Both checks are needed: the window bounds how long a captured request stays
 * usable, the id makes even an in-window replay a no-op.
 */
export function checkReplay(
  store: DraftStore,
  deliveryId: string,
  timestampSeconds: number | undefined,
  payload: WebhookPayload | undefined,
  options: { windowMs?: number; now?: number } = {}
): ReplayCheck {
  const windowMs = options.windowMs ?? REPLAY_WINDOW_MS;
  const now = options.now ?? Date.now();
  if (timestampSeconds !== undefined && Number.isFinite(timestampSeconds)) {
    const deltaMs = Math.abs(now - timestampSeconds * 1000);
    if (deltaMs > windowMs) {
      return { ok: false, reason: "stale_timestamp", deliveryId };
    }
  }
  const fresh = store.registerDelivery(deliveryId, payload?.event, payload?.job_id);
  if (!fresh) return { ok: false, reason: "duplicate_delivery", deliveryId };
  return { ok: true, deliveryId };
}

/* -------------------------------------------------------------------- */
/* Draft collection                                                      */
/* -------------------------------------------------------------------- */

/** Re-exported so existing importers keep working. */
export { captureBefore };

/** Store one completed job item as a pending draft (idempotent). */
export async function itemToDraft(
  deps: WebhookDeps,
  jobId: string,
  kind: JobKind,
  item: JobItem
): Promise<number | undefined> {
  if (item.status !== "completed" || !item.result) return undefined;
  const productId = Number(item.external_id);
  if (!Number.isFinite(productId) || productId <= 0) return undefined;

  const bridgeItemId = item.id ? String(item.id) : `${jobId}:${item.external_id}`;
  // Skip when the draft already exists (item webhook + job webhook overlap).
  const existing = deps.store.getDraftByBridgeItem(bridgeItemId);
  if (existing) return existing.id;

  const shoper = deps.getShoper();
  const before: DraftPayload["before"] = await captureBefore(shoper, productId);
  const setMainImage = deps.store.readConfig().setMainImage === "1";
  const created = deps.store.createDraftFromItem(jobId, kind, item, before, {
    locale: shoper.translationLocale,
    setMainImage,
  });
  return created?.id;
}

/** Pull all completed items of a job into pending drafts. */
export async function collectJobDrafts(
  deps: WebhookDeps,
  jobId: string,
  kind: JobKind
): Promise<number> {
  const items = await deps.getBridge().getAllJobItems(jobId);
  let collected = 0;
  for (const item of items) {
    if (item.status !== "completed" || !item.result) continue;
    const bridgeItemId = item.id ? String(item.id) : `${jobId}:${item.external_id}`;
    if (deps.store.getDraftByBridgeItem(bridgeItemId)) continue;
    const draftId = await itemToDraft(deps, jobId, kind, item);
    if (draftId !== undefined) collected += 1;
  }
  return collected;
}

/* -------------------------------------------------------------------- */
/* Payload handling                                                      */
/* -------------------------------------------------------------------- */

export async function handlePayload(
  deps: WebhookDeps,
  payload: WebhookPayload
): Promise<void> {
  const events = deps.events;
  const cached = deps.store.getJob(payload.job_id);
  const kind: JobKind = cached?.kind ?? payload.job?.kind ?? "image_generate";

  if (payload.job) {
    const terminal =
      payload.event === "commerce.job.completed" ||
      payload.event === "commerce.job.failed" ||
      TERMINAL_JOB_STATUSES.includes(payload.job.status);
    if (cached) {
      deps.store.updateJobState(payload.job_id, payload.job, terminal);
    } else {
      deps.store.rememberJob({
        job_id: payload.job_id,
        kind,
        product_ids: [],
        created_at: new Date().toISOString(),
        state: payload.job,
        terminal,
      });
    }
  }

  switch (payload.event) {
    case "commerce.item.completed": {
      if (!payload.item) break;
      const draftId = await itemToDraft(deps, payload.job_id, kind, payload.item);
      events?.emit("item.completed", {
        jobId: payload.job_id,
        item: payload.item,
        ...(draftId !== undefined ? { draftId } : {}),
      });
      break;
    }
    case "commerce.job.completed": {
      const collected = await collectJobDrafts(deps, payload.job_id, kind);
      deps.store.markJobTerminal(payload.job_id);
      if (cached?.batch_id) deps.store.updateBatchStatus(cached.batch_id, "completed");
      events?.emit("job.completed", { jobId: payload.job_id, collected });
      break;
    }
    case "commerce.job.failed": {
      deps.store.markJobTerminal(payload.job_id);
      if (cached?.batch_id) {
        deps.store.updateBatchStatus(cached.batch_id, "completed_with_errors");
      }
      events?.emit("job.failed", { jobId: payload.job_id });
      break;
    }
    case "commerce.job.awaiting_credits": {
      if (cached?.batch_id) deps.store.updateBatchStatus(cached.batch_id, "awaiting_credits");
      events?.emit("job.awaiting_credits", { jobId: payload.job_id });
      break;
    }
    default:
      // Unknown future event: state was already refreshed above.
      break;
  }
}

/** Recognised event names (used to reject junk before doing any work). */
const KNOWN_EVENTS = new Set<string>([
  "commerce.item.completed",
  "commerce.job.completed",
  "commerce.job.failed",
  "commerce.job.awaiting_credits",
]);

export function isKnownEvent(event: string): event is WebhookEvent {
  return KNOWN_EVENTS.has(event);
}

/* -------------------------------------------------------------------- */
/* Router                                                                */
/* -------------------------------------------------------------------- */

/**
 * Express router mounting POST /webhooks/fotohub (plus an /api/webhook alias)
 * with raw-body HMAC verification and replay protection.
 */
export function createWebhookRouter(deps: WebhookDeps): Router {
  const router = Router();
  const events = deps.events ?? new WebhookEmitter();
  const withEvents: WebhookDeps = { ...deps, events };
  const now = deps.now ?? Date.now;

  const log = (
    level: "debug" | "info" | "warn" | "error",
    msg: string,
    meta?: Record<string, unknown>
  ): void => {
    if (!deps.logger) return;
    try {
      deps.logger(meta ? { level, msg, meta } : { level, msg });
    } catch {
      /* ignore */
    }
  };

  const handler = (
    rawBody: Buffer,
    headers: {
      signature?: string;
      timestamp?: string;
      delivery?: string;
    }
  ): { status: number; body: Record<string, unknown> } => {
    const secret = withEvents.store.readConfig().callbackSecret;
    if (!secret) {
      events.emit("rejected", { reason: "no_callback_secret", status: 400 });
      return { status: 400, body: { error: "no_callback_secret" } };
    }
    if (!rawBody || rawBody.length === 0) {
      events.emit("rejected", { reason: "empty_body", status: 400 });
      return { status: 400, body: { error: "empty_body" } };
    }

    const payload = CommerceBridgeClient.parseWebhook(rawBody, headers.signature, secret);
    if (!payload) {
      events.emit("rejected", { reason: "invalid_signature", status: 401 });
      log("warn", "webhook rejected: invalid signature");
      return { status: 401, body: { error: "invalid_signature" } };
    }
    if (!isKnownEvent(String(payload.event))) {
      events.emit("rejected", { reason: "unknown_event", status: 202 });
      return { status: 202, body: { received: true, ignored: "unknown_event" } };
    }

    const timestampSeconds =
      headers.timestamp !== undefined && headers.timestamp !== ""
        ? Number(headers.timestamp)
        : typeof payload.timestamp === "number"
          ? payload.timestamp
          : undefined;
    const deliveryId = deriveDeliveryId(rawBody, headers.delivery, payload);
    const replayOptions: { windowMs?: number; now: number } = { now: now() };
    if (deps.replayWindowMs !== undefined) replayOptions.windowMs = deps.replayWindowMs;
    const replay = checkReplay(
      withEvents.store,
      deliveryId,
      timestampSeconds,
      payload,
      replayOptions
    );
    if (!replay.ok) {
      events.emit("rejected", {
        reason: replay.reason ?? "replay",
        status: replay.reason === "stale_timestamp" ? 401 : 200,
      });
      log("warn", `webhook rejected: ${replay.reason}`, { delivery_id: deliveryId });
      // A duplicate is answered 200 so the bridge stops redelivering it.
      return replay.reason === "stale_timestamp"
        ? { status: 401, body: { error: "stale_timestamp" } }
        : { status: 200, body: { received: true, duplicate: true } };
    }

    events.emit("delivery", payload);
    // Ack fast; process async. A Shoper round trip must never block the bridge.
    void handlePayload(withEvents, payload).catch((err: unknown) => {
      const error = err instanceof Error ? err : new Error(String(err));
      log("error", `webhook handling failed: ${error.message}`);
      events.emit("error", error);
    });
    return { status: 200, body: { received: true } };
  };

  const mount = (path: string): void => {
    router.post(path, raw({ type: () => true, limit: MAX_WEBHOOK_BODY }), (req, res) => {
      const body = Buffer.isBuffer(req.body)
        ? req.body
        : Buffer.from(typeof req.body === "string" ? req.body : "");
      const headerArgs: { signature?: string; timestamp?: string; delivery?: string } = {};
      const signature = req.header("x-fotohub-signature");
      const timestamp = req.header("x-fotohub-timestamp");
      const delivery =
        req.header("x-fotohub-delivery") ?? req.header("x-fotohub-delivery-id");
      if (signature) headerArgs.signature = signature;
      if (timestamp) headerArgs.timestamp = timestamp;
      if (delivery) headerArgs.delivery = delivery;
      const result = handler(body, headerArgs);
      res.status(result.status).json(result.body);
    });
  };

  // Canonical path plus the alias the admin UI proxies.
  mount("/webhooks/fotohub");
  mount("/api/webhook");

  return router;
}
