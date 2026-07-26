/**
 * Shared HTTP plumbing: leaky-bucket rate limiting, exponential backoff with
 * jitter, Retry-After parsing, secret redaction and a small bounded LRU used
 * for ETag caching.
 *
 * Kept dependency-free and side-effect-free so it is unit-testable without a
 * network or a database.
 */

import { ShoperTransportError } from "./types";

export function sleep(ms: number, signal?: AbortSignal): Promise<void> {
  if (ms <= 0) return Promise.resolve();
  return new Promise((resolve, reject) => {
    const timer = setTimeout(() => {
      signal?.removeEventListener("abort", onAbort);
      resolve();
    }, ms);
    const onAbort = (): void => {
      clearTimeout(timer);
      reject(new ShoperTransportError("aborted while waiting"));
    };
    if (signal) {
      if (signal.aborted) {
        clearTimeout(timer);
        reject(new ShoperTransportError("aborted while waiting"));
        return;
      }
      signal.addEventListener("abort", onAbort, { once: true });
    }
  });
}

/* -------------------------------------------------------------------- */
/* Leaky bucket                                                          */
/* -------------------------------------------------------------------- */

export interface LeakyBucketOptions {
  /** Sustained request rate. */
  requestsPerSecond: number;
  /** Burst capacity (tokens). Default max(1, ceil(rps)). */
  burst?: number;
  /** Reject a caller that would wait longer than this. Default 60_000. */
  maxWaitMs?: number;
  /** Reject new callers once this many are queued. Default 500. */
  maxQueueLength?: number;
  /** Random jitter (ms) added to each grant to de-synchronise callers. */
  jitterMs?: number;
  /** Injectable clock (tests). */
  now?: () => number;
  /** Injectable sleep (tests). */
  sleepImpl?: (ms: number) => Promise<void>;
  /** Injectable jitter source in [0,1). */
  random?: () => number;
}

/**
 * Token bucket with a strictly FIFO waiting queue.
 *
 * Callers `await take()`. Grants are spaced so the sustained rate never
 * exceeds `requestsPerSecond`, while allowing an initial burst. Waiters are
 * served in arrival order, so a bulk job cannot starve an interactive request
 * that arrived first.
 */
export class LeakyBucket {
  private readonly intervalMs: number;
  private readonly capacity: number;
  private readonly maxWaitMs: number;
  private readonly maxQueueLength: number;
  private readonly jitterMs: number;
  private readonly now: () => number;
  private readonly sleepImpl: (ms: number) => Promise<void>;
  private readonly random: () => number;

  /** Timestamp at which the next token becomes available. */
  private nextFreeAt = 0;
  private queued = 0;

  constructor(options: LeakyBucketOptions) {
    const rps = Math.max(0.05, options.requestsPerSecond);
    this.intervalMs = 1000 / rps;
    this.capacity = Math.max(1, Math.floor(options.burst ?? Math.max(1, Math.ceil(rps))));
    this.maxWaitMs = options.maxWaitMs ?? 60_000;
    this.maxQueueLength = options.maxQueueLength ?? 500;
    this.jitterMs = Math.max(0, options.jitterMs ?? 0);
    this.now = options.now ?? Date.now;
    this.sleepImpl = options.sleepImpl ?? sleep;
    this.random = options.random ?? Math.random;
  }

  get queueLength(): number {
    return this.queued;
  }

  /**
   * Reserve one slot. Resolves when the caller may issue its request.
   * Throws ShoperTransportError when the queue is saturated or the projected
   * wait exceeds maxWaitMs (fail fast instead of piling up requests).
   */
  async take(): Promise<void> {
    if (this.queued >= this.maxQueueLength) {
      throw new ShoperTransportError(
        `Rate-limit queue full (${this.queued} waiting); request rejected`
      );
    }

    const now = this.now();
    // Allow a burst: tokens accumulated while idle, capped at `capacity`.
    const earliest = now - this.capacity * this.intervalMs;
    if (this.nextFreeAt < earliest) this.nextFreeAt = earliest;

    const scheduledAt = Math.max(this.nextFreeAt, earliest);
    const jitter = this.jitterMs > 0 ? this.random() * this.jitterMs : 0;
    this.nextFreeAt = scheduledAt + this.intervalMs + jitter;

    const waitMs = scheduledAt - now;
    if (waitMs <= 0) return;
    if (waitMs > this.maxWaitMs) {
      // Give the slot back so a later caller is not punished for our refusal.
      this.nextFreeAt = scheduledAt;
      throw new ShoperTransportError(
        `Rate-limit wait ${Math.round(waitMs)}ms exceeds maxWaitMs ${this.maxWaitMs}`
      );
    }
    this.queued += 1;
    try {
      await this.sleepImpl(waitMs);
    } finally {
      this.queued -= 1;
    }
  }

  /**
   * Push the next available slot forward (used after a 429 so every queued
   * caller respects the server's Retry-After, not just the one that got it).
   */
  penalise(delayMs: number): void {
    const target = this.now() + Math.max(0, delayMs);
    if (target > this.nextFreeAt) this.nextFreeAt = target;
  }
}

/* -------------------------------------------------------------------- */
/* Backoff                                                               */
/* -------------------------------------------------------------------- */

export interface BackoffOptions {
  /** Base delay in ms for attempt 1. */
  baseMs: number;
  /** Hard cap for a single sleep. */
  maxMs: number;
  /** 1-based attempt number. */
  attempt: number;
  /** Server-provided Retry-After in ms (wins when larger). */
  retryAfterMs?: number;
  /** Injectable jitter source in [0,1). */
  random?: () => number;
}

/**
 * Full-jitter exponential backoff: base * 2^(attempt-1) scaled by a random
 * factor in [0.5, 1.5), clamped to maxMs. Retry-After takes precedence when
 * the server asked for a longer pause.
 */
export function backoffDelay(options: BackoffOptions): number {
  const attempt = Math.max(1, options.attempt);
  const rand = options.random ?? Math.random;
  const exponential = options.baseMs * Math.pow(2, attempt - 1);
  const jittered = exponential * (0.5 + rand());
  let delay = Math.min(jittered, options.maxMs);
  if (options.retryAfterMs !== undefined && options.retryAfterMs > delay) {
    delay = Math.min(options.retryAfterMs, options.maxMs);
  }
  return Math.round(delay);
}

/** Parse a Retry-After header (delta-seconds or HTTP-date) into ms. */
export function parseRetryAfter(
  header: string | null | undefined,
  now: number = Date.now()
): number | undefined {
  if (!header) return undefined;
  const trimmed = header.trim();
  if (trimmed === "") return undefined;
  const seconds = Number(trimmed);
  if (Number.isFinite(seconds)) {
    return Math.max(0, Math.round(seconds * 1000));
  }
  const date = Date.parse(trimmed);
  if (Number.isFinite(date)) return Math.max(0, date - now);
  return undefined;
}

/** True for statuses worth retrying (transient). */
export function isRetryableStatus(status: number): boolean {
  return status === 408 || status === 425 || status === 429 || (status >= 500 && status <= 599);
}

/* -------------------------------------------------------------------- */
/* Redaction                                                             */
/* -------------------------------------------------------------------- */

const SECRET_PATTERNS: ReadonlyArray<[RegExp, string]> = [
  // FOTOhub API keys.
  [/\b(fh_(?:live|test)_)[A-Za-z0-9_-]{4,}/g, "$1***"],
  // Bearer / Basic credentials.
  [/\b(Bearer|Basic)\s+[A-Za-z0-9._~+/=-]{6,}/gi, "$1 ***"],
  // access_token / token / password / secret / api_key in JSON or query form.
  [
    /("?(?:access_token|refresh_token|token|password|passwd|secret|callback_secret|api_key|apikey|client_secret)"?\s*[:=]\s*"?)([^"&,\s}]{3,})/gi,
    '$1***"',
  ],
];

/**
 * Strip anything that looks like a credential from a string before logging.
 * Deliberately aggressive: over-redacting a log line is always cheaper than
 * leaking a live API key into a log file.
 */
export function redact(input: string): string {
  let out = input;
  for (const [pattern, replacement] of SECRET_PATTERNS) {
    out = out.replace(pattern, replacement);
  }
  return out;
}

/** Redact a URL: drop credentials in userinfo and mask sensitive params. */
export function redactUrl(rawUrl: string): string {
  try {
    const url = new URL(rawUrl);
    if (url.username || url.password) {
      url.username = "***";
      url.password = "";
    }
    for (const key of [...url.searchParams.keys()]) {
      if (/token|password|secret|key|auth|sig/i.test(key)) {
        url.searchParams.set(key, "***");
      }
    }
    return redact(url.toString());
  } catch {
    return redact(rawUrl);
  }
}

/** Redact a header map for logging. */
export function redactHeaders(
  headers: Record<string, string | undefined>
): Record<string, string> {
  const out: Record<string, string> = {};
  for (const [key, value] of Object.entries(headers)) {
    if (value === undefined) continue;
    out[key] = /authorization|cookie|token|secret|signature|api-key/i.test(key)
      ? "***"
      : redact(value);
  }
  return out;
}

/* -------------------------------------------------------------------- */
/* Fixed-window per-key rate limiter (HTTP layer)                        */
/* -------------------------------------------------------------------- */

export interface RateLimiterOptions {
  /** Window length in ms. */
  windowMs: number;
  /** Allowed hits per key per window. */
  max: number;
  /** Injectable clock (tests). */
  now?: () => number;
  /** Stop tracking more than this many keys (memory guard). */
  maxKeys?: number;
}

export interface RateLimitVerdict {
  allowed: boolean;
  /** Hits used in the current window (including this one when allowed). */
  used: number;
  remaining: number;
  /** Ms until the current window resets. */
  resetMs: number;
}

/**
 * Fixed-window counter keyed by client IP. Deliberately in-process and
 * dependency-free: this app is a single-tenant sidecar, so a shared store would
 * add an operational dependency without buying anything. The key cap prevents a
 * spoofed-header flood from growing the map without bound.
 */
export class FixedWindowRateLimiter {
  private readonly windowMs: number;
  private readonly max: number;
  private readonly now: () => number;
  private readonly maxKeys: number;
  private readonly hits = new Map<string, { count: number; resetAt: number }>();

  constructor(options: RateLimiterOptions) {
    this.windowMs = Math.max(100, options.windowMs);
    this.max = Math.max(1, Math.floor(options.max));
    this.now = options.now ?? Date.now;
    this.maxKeys = Math.max(16, options.maxKeys ?? 5000);
  }

  get trackedKeys(): number {
    return this.hits.size;
  }

  /** Count one hit against `key` and report whether it may proceed. */
  hit(key: string): RateLimitVerdict {
    const now = this.now();
    const existing = this.hits.get(key);
    if (!existing || existing.resetAt <= now) {
      this.evictIfNeeded(now);
      const entry = { count: 1, resetAt: now + this.windowMs };
      this.hits.set(key, entry);
      return { allowed: true, used: 1, remaining: this.max - 1, resetMs: this.windowMs };
    }
    existing.count += 1;
    const resetMs = Math.max(0, existing.resetAt - now);
    if (existing.count > this.max) {
      return { allowed: false, used: existing.count, remaining: 0, resetMs };
    }
    return {
      allowed: true,
      used: existing.count,
      remaining: Math.max(0, this.max - existing.count),
      resetMs,
    };
  }

  /** Drop expired entries; hard-trim when the map is still oversized. */
  private evictIfNeeded(now: number): void {
    if (this.hits.size < this.maxKeys) return;
    for (const [key, entry] of this.hits) {
      if (entry.resetAt <= now) this.hits.delete(key);
    }
    while (this.hits.size >= this.maxKeys) {
      const oldest = this.hits.keys().next();
      if (oldest.done) break;
      this.hits.delete(oldest.value);
    }
  }

  reset(key?: string): void {
    if (key === undefined) this.hits.clear();
    else this.hits.delete(key);
  }
}

/* -------------------------------------------------------------------- */
/* Bounded LRU (ETag cache)                                              */
/* -------------------------------------------------------------------- */

export class BoundedLru<V> {
  private readonly map = new Map<string, V>();

  constructor(private readonly maxSize: number) {}

  get size(): number {
    return this.map.size;
  }

  get(key: string): V | undefined {
    const value = this.map.get(key);
    if (value === undefined) return undefined;
    // Refresh recency.
    this.map.delete(key);
    this.map.set(key, value);
    return value;
  }

  set(key: string, value: V): void {
    if (this.map.has(key)) this.map.delete(key);
    this.map.set(key, value);
    while (this.map.size > this.maxSize) {
      const oldest = this.map.keys().next();
      if (oldest.done) break;
      this.map.delete(oldest.value);
    }
  }

  delete(key: string): void {
    this.map.delete(key);
  }

  clear(): void {
    this.map.clear();
  }
}

/* -------------------------------------------------------------------- */
/* Misc                                                                  */
/* -------------------------------------------------------------------- */

/** Split an array into chunks of at most `size` items. */
export function chunk<T>(items: readonly T[], size: number): T[][] {
  const limit = Math.max(1, Math.floor(size));
  const out: T[][] = [];
  for (let i = 0; i < items.length; i += limit) {
    out.push(items.slice(i, i + limit) as T[]);
  }
  return out;
}

/**
 * Run `worker` over `items` with at most `concurrency` in flight, preserving
 * result order. Rejections are captured per item so one failure cannot abort
 * the whole batch.
 */
export async function mapWithConcurrency<T, R>(
  items: readonly T[],
  concurrency: number,
  worker: (item: T, index: number) => Promise<R>
): Promise<Array<{ ok: true; value: R } | { ok: false; error: Error }>> {
  const limit = Math.max(1, Math.floor(concurrency));
  const results = new Array<{ ok: true; value: R } | { ok: false; error: Error }>(
    items.length
  );
  let cursor = 0;

  async function run(): Promise<void> {
    for (;;) {
      const index = cursor++;
      if (index >= items.length) return;
      const item = items[index] as T;
      try {
        results[index] = { ok: true, value: await worker(item, index) };
      } catch (err) {
        results[index] = {
          ok: false,
          error: err instanceof Error ? err : new Error(String(err)),
        };
      }
    }
  }

  await Promise.all(Array.from({ length: Math.min(limit, items.length) }, run));
  return results;
}
