/**
 * FOTOhub commerce-bridge REST client.
 *
 * Base: https://apis.fotohub.app/v1/commerce
 * Auth: Bearer fh_live_* / fh_test_*
 *
 * Full coverage of the frozen bridge contract:
 *   POST   /connections                  register this store
 *   GET    /connections                  list connections
 *   DELETE /connections/{id}             unregister
 *   POST   /jobs                         create a bulk job
 *   GET    /jobs/{id}                    job state
 *   GET    /jobs/{id}/items?status=      per-item results
 *   POST   /jobs/{id}/retry-failed       requeue failed items
 *   POST   /jobs/{id}/cancel             cancel a running job
 *   GET    /presets?category=&vertical=  preset gallery
 *   POST   /estimate                     credit preflight
 *   GET    /v1/billing/balance           credit balance (api-server root)
 *
 * Transport: bounded retries with full-jitter backoff on 429/5xx/network
 * errors honouring Retry-After, per-request timeout, structured logging with
 * API-key redaction, and stable idempotency-key generation so a retried job
 * submission can never double-charge credits.
 */

import { createHash, createHmac, timingSafeEqual } from "crypto";
import { fetch as undiciFetch } from "undici";
import { backoffDelay, isRetryableStatus, parseRetryAfter, redact, redactUrl, sleep } from "./http";
import {
  BillingBalance,
  Connection,
  CreateConnectionRequest,
  CreateJobRequest,
  CreateJobResponse,
  EstimateRequest,
  EstimateResponse,
  FetchLike,
  FotoHubBridgeError,
  InsufficientCreditsError,
  JobItem,
  JobItemInput,
  JobItemsQuery,
  JobKind,
  JobState,
  LogSink,
  Preset,
  PresetCategory,
  PresetQuery,
  WebhookPayload,
} from "./types";

const DEFAULT_API_ROOT = "https://apis.fotohub.app";
/** Bridge caps a single job at 500 items. */
export const MAX_JOB_ITEMS = 500;

export interface BridgeClientConfig {
  /** FOTOhub API key (fh_live_* or fh_test_*). */
  apiKey: string;
  /** Override the API root (testing). Default: https://apis.fotohub.app */
  apiRoot?: string;
  /** Retry attempts beyond the first try. Default 3. */
  maxRetries?: number;
  retryBaseMs?: number;
  retryMaxMs?: number;
  /** Per-request timeout in ms. Default 60s (120s for job creation). */
  timeoutMs?: number;
  logger?: LogSink;
  fetchImpl?: FetchLike;
  /** Optional correlation id echoed as X-Request-Id. */
  requestId?: string;
}

interface RequestOptions {
  query?: Record<string, string | number | boolean | undefined>;
  body?: unknown;
  /** Path is absolute under the API root, not under /v1/commerce. */
  root?: boolean;
  /** Extra headers (e.g. Idempotency-Key). */
  headers?: Record<string, string>;
  /** Override the default timeout. */
  timeoutMs?: number;
  /** Do not retry (non-idempotent calls that lack an idempotency key). */
  noRetry?: boolean;
  /** Return undefined instead of throwing on 404. */
  allow404?: boolean;
}

export class CommerceBridgeClient {
  private readonly apiRoot: string;
  private readonly apiKey: string;
  private readonly maxRetries: number;
  private readonly retryBaseMs: number;
  private readonly retryMaxMs: number;
  private readonly timeoutMs: number;
  private readonly logger?: LogSink;
  private readonly fetchImpl: FetchLike;
  private readonly requestId?: string;

  constructor(config: BridgeClientConfig) {
    if (!config.apiKey) throw new Error("apiKey is required");
    this.apiKey = config.apiKey.trim();
    this.apiRoot = (config.apiRoot ?? DEFAULT_API_ROOT).replace(/\/+$/, "");
    this.maxRetries = Math.max(0, config.maxRetries ?? 3);
    this.retryBaseMs = Math.max(50, config.retryBaseMs ?? 600);
    this.retryMaxMs = Math.max(this.retryBaseMs, config.retryMaxMs ?? 20_000);
    this.timeoutMs = Math.max(1000, config.timeoutMs ?? 60_000);
    this.logger = config.logger;
    this.fetchImpl = config.fetchImpl ?? (undiciFetch as unknown as FetchLike);
    if (config.requestId) this.requestId = config.requestId;
  }

  private get bridgeBase(): string {
    return `${this.apiRoot}/v1/commerce`;
  }

  /** Non-reversible fingerprint of the API key, safe to log/persist. */
  get keyFingerprint(): string {
    return createHash("sha256").update(this.apiKey).digest("hex").slice(0, 12);
  }

  private log(
    level: "debug" | "warn" | "error",
    msg: string,
    extra: Record<string, unknown> = {}
  ): void {
    if (!this.logger) return;
    try {
      this.logger({
        level,
        msg: redact(msg),
        ...(extra as Record<string, never>),
      });
    } catch {
      /* never let logging break a request */
    }
  }

  private async request<T>(
    method: string,
    path: string,
    options: RequestOptions = {}
  ): Promise<T> {
    const base = options.root ? this.apiRoot : this.bridgeBase;
    const url = new URL(`${base}${path}`);
    if (options.query) {
      for (const [key, value] of Object.entries(options.query)) {
        if (value !== undefined) url.searchParams.set(key, String(value));
      }
    }
    const target = url.toString();
    const timeout = options.timeoutMs ?? this.timeoutMs;
    const attempts = options.noRetry ? 1 : this.maxRetries + 1;
    let lastError: Error | undefined;

    for (let attempt = 1; attempt <= attempts; attempt += 1) {
      const controller = new AbortController();
      const timer = setTimeout(() => controller.abort(), timeout);
      const started = Date.now();
      let response;
      try {
        const headers: Record<string, string> = {
          Authorization: `Bearer ${this.apiKey}`,
          Accept: "application/json",
          ...options.headers,
        };
        if (options.body !== undefined) headers["Content-Type"] = "application/json";
        if (this.requestId) headers["X-Request-Id"] = this.requestId;
        response = await this.fetchImpl(target, {
          method,
          headers,
          body: options.body !== undefined ? JSON.stringify(options.body) : undefined,
          signal: controller.signal,
        });
      } catch (err) {
        lastError = controller.signal.aborted
          ? new FotoHubBridgeError(`commerce-bridge ${method} ${path} timed out`, 0)
          : err instanceof Error
            ? err
            : new Error(String(err));
        this.log("warn", `bridge ${method} ${path} transport failure: ${lastError.message}`, {
          attempt,
          method,
          url: redactUrl(target),
        });
        if (attempt >= attempts) break;
        await sleep(backoffDelay({ baseMs: this.retryBaseMs, maxMs: this.retryMaxMs, attempt }));
        continue;
      } finally {
        clearTimeout(timer);
      }

      const durationMs = Date.now() - started;
      this.log(response.ok ? "debug" : "warn", `bridge ${method} ${path}`, {
        status: response.status,
        durationMs,
        attempt,
        method,
        url: redactUrl(target),
      });

      // 402 must never be retried — it is a deterministic business answer.
      if (isRetryableStatus(response.status) && attempt < attempts) {
        const retryAfterMs = parseRetryAfter(response.headers.get("retry-after"));
        await sleep(
          backoffDelay({
            baseMs: this.retryBaseMs,
            maxMs: this.retryMaxMs,
            attempt,
            retryAfterMs,
          })
        );
        continue;
      }

      const text = await response.text().catch(() => "");
      let body: unknown = text || undefined;
      if (text) {
        try {
          body = JSON.parse(text);
        } catch {
          /* leave raw text */
        }
      }

      if (!response.ok) {
        if (response.status === 404 && options.allow404) return undefined as T;
        if (response.status === 402) {
          const b = body as
            | { required_credits?: number; available_credits?: number }
            | undefined;
          throw new InsufficientCreditsError(
            Number(b?.required_credits ?? 0),
            Number(b?.available_credits ?? 0),
            body
          );
        }
        throw new FotoHubBridgeError(
          redact(
            `commerce-bridge ${method} ${path} failed with ${response.status}${
              text ? `: ${text.slice(0, 300)}` : ""
            }`
          ),
          response.status,
          body
        );
      }

      return body as T;
    }

    throw new FotoHubBridgeError(
      redact(
        `commerce-bridge ${method} ${path} unreachable after ${attempts} attempts: ${
          lastError?.message ?? "rate limited"
        }`
      ),
      0
    );
  }

  /* ---------------------------------------------------------------- */
  /* Connections                                                       */
  /* ---------------------------------------------------------------- */

  async createConnection(req: CreateConnectionRequest): Promise<Connection> {
    const res = await this.request<Connection | { connection: Connection }>(
      "POST",
      "/connections",
      { body: req, noRetry: true }
    );
    return unwrap(res, "connection");
  }

  async listConnections(): Promise<Connection[]> {
    const res = await this.request<Connection[] | { connections: Connection[] }>(
      "GET",
      "/connections"
    );
    if (Array.isArray(res)) return res;
    return res?.connections ?? [];
  }

  async getConnection(connectionId: string): Promise<Connection | undefined> {
    const list = await this.listConnections();
    return list.find((c) => c.id === connectionId);
  }

  async deleteConnection(connectionId: string): Promise<void> {
    await this.request<void>("DELETE", `/connections/${encodeURIComponent(connectionId)}`, {
      allow404: true,
    });
  }

  /**
   * Register the connection if absent, otherwise reuse the existing record.
   * Returns whether the connection was created in this call.
   */
  async ensureConnection(
    req: CreateConnectionRequest
  ): Promise<{ connection: Connection; created: boolean }> {
    const existing = await this.listConnections().catch(() => [] as Connection[]);
    const match = existing.find(
      (c) =>
        c.platform === req.platform &&
        normaliseUrl(c.store_url) === normaliseUrl(req.store_url)
    );
    if (match) return { connection: match, created: false };
    return { connection: await this.createConnection(req), created: true };
  }

  /** Connection reachability: the bridge is up and the key is accepted. */
  async connectionHealth(connectionId?: string): Promise<{
    ok: boolean;
    connection_found?: boolean;
    status?: string;
    detail?: string;
  }> {
    try {
      const list = await this.listConnections();
      if (!connectionId) return { ok: true, connection_found: false };
      const match = list.find((c) => c.id === connectionId);
      const result: {
        ok: boolean;
        connection_found: boolean;
        status?: string;
        detail?: string;
      } = { ok: Boolean(match), connection_found: Boolean(match) };
      if (match?.status !== undefined) result.status = match.status;
      if (!match) result.detail = "connection_id not present on this API key";
      return result;
    } catch (err) {
      return { ok: false, detail: err instanceof Error ? redact(err.message) : String(err) };
    }
  }

  /* ---------------------------------------------------------------- */
  /* Jobs                                                              */
  /* ---------------------------------------------------------------- */

  /**
   * Create a bulk job. An idempotency key is generated when the caller does
   * not supply one, so a network-level retry cannot create a duplicate job.
   */
  async createJob(req: CreateJobRequest): Promise<CreateJobResponse> {
    if (!req.connection_id) throw new Error("connection_id is required");
    if (!req.items || req.items.length === 0) throw new Error("items must not be empty");
    if (req.items.length > MAX_JOB_ITEMS) {
      throw new Error(`items exceeds the bridge limit of ${MAX_JOB_ITEMS} per job`);
    }
    const idempotencyKey = req.idempotency_key ?? buildIdempotencyKey(req);
    const payload: CreateJobRequest = { ...req, idempotency_key: idempotencyKey };
    return this.request<CreateJobResponse>("POST", "/jobs", {
      body: payload,
      headers: { "Idempotency-Key": idempotencyKey },
      timeoutMs: Math.max(this.timeoutMs, 120_000),
    });
  }

  async getJob(jobId: string): Promise<JobState> {
    const res = await this.request<JobState | { job: JobState }>(
      "GET",
      `/jobs/${encodeURIComponent(jobId)}`
    );
    return unwrap(res, "job");
  }

  async getJobItems(jobId: string, query: JobItemsQuery = {}): Promise<JobItem[]> {
    const res = await this.request<{ items?: JobItem[] } | JobItem[]>(
      "GET",
      `/jobs/${encodeURIComponent(jobId)}/items`,
      {
        query: {
          status: query.status,
          limit: query.limit,
          offset: query.offset,
        },
      }
    );
    if (Array.isArray(res)) return res;
    return res?.items ?? [];
  }

  /** Fetch every item, paging through the collection. */
  async getAllJobItems(jobId: string, pageSize = 100): Promise<JobItem[]> {
    const limit = Math.min(Math.max(1, pageSize), 500);
    const all: JobItem[] = [];
    let offset = 0;
    for (;;) {
      const page = await this.getJobItems(jobId, { limit, offset });
      all.push(...page);
      if (page.length < limit) break;
      offset += limit;
      if (offset > 100_000) break;
    }
    return all;
  }

  /** Async iterator over job items (memory-friendly for 500-item jobs). */
  async *iterateJobItems(
    jobId: string,
    query: JobItemsQuery = {},
    pageSize = 100
  ): AsyncGenerator<JobItem, void, void> {
    const limit = Math.min(Math.max(1, pageSize), 500);
    let offset = query.offset ?? 0;
    for (;;) {
      const itemQuery: JobItemsQuery = { limit, offset };
      if (query.status) itemQuery.status = query.status;
      const page = await this.getJobItems(jobId, itemQuery);
      for (const item of page) yield item;
      if (page.length < limit) return;
      offset += limit;
    }
  }

  async retryFailed(jobId: string): Promise<{ requeued: number }> {
    const res = await this.request<{ requeued?: number } | undefined>(
      "POST",
      `/jobs/${encodeURIComponent(jobId)}/retry-failed`,
      { noRetry: true }
    );
    return { requeued: Number(res?.requeued ?? 0) };
  }

  async cancelJob(jobId: string): Promise<{ cancelled: boolean }> {
    await this.request<void>("POST", `/jobs/${encodeURIComponent(jobId)}/cancel`, {
      noRetry: true,
    });
    return { cancelled: true };
  }

  /* ---------------------------------------------------------------- */
  /* Presets & estimates                                              */
  /* ---------------------------------------------------------------- */

  async getPresets(query: PresetQuery = {}): Promise<Preset[]> {
    const res = await this.request<{ presets?: Preset[] } | Preset[]>("GET", "/presets", {
      query: {
        category: query.category,
        vertical: query.vertical,
        platform: query.platform,
      },
    });
    if (Array.isArray(res)) return res;
    return res?.presets ?? [];
  }

  /** Presets grouped by category (what the gallery renders). */
  async getPresetsByCategory(
    query: Omit<PresetQuery, "category"> = {}
  ): Promise<Record<PresetCategory, Preset[]>> {
    const presets = await this.getPresets(query);
    const out = {} as Record<PresetCategory, Preset[]>;
    for (const preset of presets) {
      const bucket = out[preset.category] ?? [];
      bucket.push(preset);
      out[preset.category] = bucket;
    }
    for (const list of Object.values(out)) {
      list.sort((a, b) => a.name.localeCompare(b.name));
    }
    return out;
  }

  async estimate(req: EstimateRequest): Promise<EstimateResponse> {
    if (!req.kind) throw new Error("kind is required");
    if (!Number.isFinite(req.num_items) || req.num_items <= 0) {
      throw new Error("num_items must be a positive number");
    }
    const res = await this.request<EstimateResponse>("POST", "/estimate", { body: req });
    return {
      credits_per_item: Number(res?.credits_per_item ?? 0),
      total_credits: Number(res?.total_credits ?? 0),
      available_credits: Number(res?.available_credits ?? 0),
      sufficient: Boolean(res?.sufficient),
    };
  }

  /* ---------------------------------------------------------------- */
  /* Health & billing (api-server root endpoints)                      */
  /* ---------------------------------------------------------------- */

  async health(): Promise<{ ok: boolean; detail?: unknown }> {
    try {
      const res = await this.request<unknown>("GET", "/health", {
        noRetry: true,
        timeoutMs: 10_000,
      });
      return { ok: true, detail: res };
    } catch (err) {
      return { ok: false, detail: err instanceof Error ? redact(err.message) : String(err) };
    }
  }

  /** GET /v1/billing/balance — also serves as the API-key validation call. */
  async getBalance(): Promise<BillingBalance> {
    const res = await this.request<BillingBalance>("GET", "/v1/billing/balance", {
      root: true,
    });
    return { ...res, available_credits: Number(res?.available_credits ?? 0) };
  }

  /* ---------------------------------------------------------------- */
  /* Webhook signature verification                                    */
  /* ---------------------------------------------------------------- */

  /**
   * Verify X-FotoHub-Signature (HMAC-SHA256 hex of the raw request body,
   * keyed with the connection's callback_secret). Accepts both a bare hex
   * digest and a `sha256=<hex>` prefixed form. Constant-time compare with a
   * length pre-check (timingSafeEqual throws on length mismatch).
   */
  static verifyWebhookSignature(
    rawBody: string | Buffer,
    signatureHeader: string | undefined,
    callbackSecret: string
  ): boolean {
    if (!signatureHeader || !callbackSecret) return false;
    const provided = signatureHeader.trim().replace(/^sha256=/i, "").toLowerCase();
    if (!/^[0-9a-f]{64}$/.test(provided)) return false;
    const expected = createHmac("sha256", callbackSecret).update(rawBody).digest("hex");
    const a = Buffer.from(expected, "utf8");
    const b = Buffer.from(provided, "utf8");
    if (a.length !== b.length) return false;
    return timingSafeEqual(a, b);
  }

  /** Sign a payload the way the bridge does (used by tests/tooling). */
  static signWebhook(rawBody: string | Buffer, callbackSecret: string): string {
    return createHmac("sha256", callbackSecret).update(rawBody).digest("hex");
  }

  /** Parse + verify a webhook. Returns null when the signature is invalid. */
  static parseWebhook(
    rawBody: string | Buffer,
    signatureHeader: string | undefined,
    callbackSecret: string
  ): WebhookPayload | null {
    if (
      !CommerceBridgeClient.verifyWebhookSignature(rawBody, signatureHeader, callbackSecret)
    ) {
      return null;
    }
    const text = typeof rawBody === "string" ? rawBody : rawBody.toString("utf8");
    try {
      const parsed = JSON.parse(text) as WebhookPayload;
      if (!parsed || typeof parsed !== "object" || typeof parsed.job_id !== "string") {
        return null;
      }
      return parsed;
    } catch {
      return null;
    }
  }
}

/* -------------------------------------------------------------------- */
/* Idempotency                                                           */
/* -------------------------------------------------------------------- */

/**
 * Stable idempotency key: sha256 over connection id, kind, model, preset,
 * canonicalised options and the sorted list of item identities. Re-submitting
 * the identical request produces the identical key, so the bridge dedupes it
 * and no credits are spent twice. Changing anything meaningful (a different
 * preset, one more product) yields a different key.
 */
export function buildIdempotencyKey(req: {
  connection_id: string;
  kind: JobKind;
  model?: string;
  preset_slug?: string;
  options?: Record<string, unknown>;
  items: readonly JobItemInput[];
}): string {
  const itemIds = req.items
    .map((item) =>
      [item.external_id, item.variant_id ?? "", item.sku ?? ""].join("~")
    )
    .sort((a, b) => (a < b ? -1 : a > b ? 1 : 0));
  const canonical = JSON.stringify([
    req.connection_id,
    req.kind,
    req.model ?? "",
    req.preset_slug ?? "",
    canonicaliseOptions(req.options),
    itemIds,
  ]);
  return createHash("sha256").update(canonical).digest("hex").slice(0, 48);
}

/** Deterministic JSON for objects with unordered keys. */
function canonicaliseOptions(value: unknown): unknown {
  if (value === null || value === undefined) return null;
  if (Array.isArray(value)) return value.map(canonicaliseOptions);
  if (typeof value === "object") {
    const entries = Object.entries(value as Record<string, unknown>)
      .filter(([, v]) => v !== undefined)
      .sort(([a], [b]) => (a < b ? -1 : a > b ? 1 : 0));
    return entries.map(([k, v]) => [k, canonicaliseOptions(v)]);
  }
  return value;
}

function unwrap<T>(res: T | Record<string, T>, key: string): T {
  if (res && typeof res === "object" && key in (res as Record<string, unknown>)) {
    return (res as Record<string, T>)[key] as T;
  }
  return res as T;
}

function normaliseUrl(url: string | undefined): string {
  return (url ?? "").trim().replace(/\/+$/, "").toLowerCase();
}
