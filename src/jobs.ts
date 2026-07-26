/**
 * High-level job orchestration.
 *
 * The bridge contract is per-job: <=500 items, one kind, one model, one preset.
 * Merchants think in terms of "all products in this category without a
 * description". This module bridges the two:
 *
 *   1. resolve products from a filter (server-side where Shoper supports it,
 *      client-side fallback for description length / image count / ALT text),
 *   2. build a rich product_context per item and pick a source image for
 *      image kinds,
 *   3. preflight: POST /estimate, then compare against GET /v1/billing/balance
 *      plus an optional per-run credit cap, and refuse before spending
 *      anything,
 *   4. chunk into bridge jobs of at most MAX_JOB_ITEMS, submit each with a
 *      stable idempotency key,
 *   5. persist a batch + per-job record in SQLite so the run is resumable
 *      after a process restart,
 *   6. return a handle exposing poll / onProgress / retryFailed / cancel.
 *
 * Concurrency safety: a module-level lock keyed by batch signature prevents
 * two identical bulk submissions racing; per-job idempotency keys make the
 * bridge side safe even if the lock is bypassed (e.g. two processes).
 */

import { randomUUID } from "crypto";
import { CommerceBridgeClient, MAX_JOB_ITEMS, buildIdempotencyKey } from "./bridge-client";
import { DraftStore } from "./draft-store";
import { chunk } from "./http";
import { buildProductContexts, pickSourceImageUrl } from "./product-context";
import { ShoperClient } from "./shoper-client";
import {
  CachedJob,
  CreateJobRequest,
  EstimateResponse,
  IMAGE_SOURCE_KINDS,
  InsufficientCreditsError,
  JobBatch,
  JobItem,
  JobItemInput,
  JobKind,
  JobOptions,
  JobState,
  JobStatus,
  Language,
  LogSink,
  ProductQuery,
  TERMINAL_JOB_STATUSES,
  Tone,
} from "./types";

export interface JobsDeps {
  shoper: ShoperClient;
  bridge: CommerceBridgeClient;
  store: DraftStore;
  connectionId: string;
  logger?: LogSink;
}

export interface BulkRunOptions {
  /** Which products to act on. */
  filter?: ProductQuery;
  /** Explicit product ids (skips filter resolution). */
  productIds?: readonly number[];
  /** Image model id (image kinds only). */
  model?: string;
  /** Preset slug applied to every item. */
  presetSlug?: string;
  /** Bridge job options. */
  options?: JobOptions;
  /** Cap the number of products picked up. Default 1000. */
  maxItems?: number;
  /** Refuse the run when the estimate exceeds this many credits. */
  maxCredits?: number;
  /** Attach the run to a schedule id (audit trail). */
  scheduleId?: number;
  /** Skip the /estimate preflight (used when the caller already ran it). */
  skipEstimate?: boolean;
  /** Include variant option summaries in product_context. */
  includeVariants?: boolean;
  /** Token budget for each product_context. */
  contextTokenBudget?: number;
  /** Mark the first generated image as the product main image. */
  setMainImage?: boolean;
}

export interface BulkRunPreflight {
  kind: JobKind;
  product_ids: number[];
  num_items: number;
  estimate?: EstimateResponse;
  chunks: number;
  blocked?: {
    reason: "no_products" | "insufficient_credits" | "over_cap";
    detail: string;
    required_credits?: number;
    available_credits?: number;
  };
}

export interface BatchProgress {
  batch_id: string;
  kind: JobKind;
  status: JobStatus;
  job_ids: string[];
  total_items: number;
  done_items: number;
  failed_items: number;
  spent_credits: number;
  estimated_credits: number;
  jobs: JobState[];
  terminal: boolean;
}

export type ProgressListener = (progress: BatchProgress) => void;

/** Handle returned by every bulk* call. */
export interface BatchHandle {
  batch_id: string;
  kind: JobKind;
  job_ids: string[];
  total_items: number;
  estimated_credits: number;
  /** Fetch fresh state for every job in the batch. */
  poll(): Promise<BatchProgress>;
  /** Poll on an interval until terminal; returns the final progress. */
  onProgress(listener: ProgressListener, intervalMs?: number): Promise<BatchProgress>;
  /** Requeue failed items across every job in the batch. */
  retryFailed(): Promise<{ requeued: number }>;
  /** Cancel every non-terminal job in the batch. */
  cancel(): Promise<{ cancelled: number }>;
  /** Pull completed items into pending drafts. */
  collectDrafts(): Promise<number>;
}

/** In-process guard against duplicate concurrent submissions. */
const inFlight = new Set<string>();

/* -------------------------------------------------------------------- */
/* Orchestrator                                                          */
/* -------------------------------------------------------------------- */

export class JobOrchestrator {
  constructor(private readonly deps: JobsDeps) {}

  private log(
    level: "debug" | "info" | "warn" | "error",
    msg: string,
    meta?: Record<string, unknown>
  ): void {
    if (!this.deps.logger) return;
    try {
      this.deps.logger(meta ? { level, msg, meta } : { level, msg });
    } catch {
      /* ignore */
    }
  }

  /* ---------------------------------------------------------------- */
  /* Product resolution                                                */
  /* ---------------------------------------------------------------- */

  /**
   * Resolve the product ids a run should target. Server-side filters are used
   * where Shoper supports them; description-length / image-count / ALT-text
   * filters fall back to a client-side scan inside ShoperClient.
   */
  async resolveProductIds(options: BulkRunOptions): Promise<number[]> {
    const max = Math.max(1, options.maxItems ?? 1000);
    if (options.productIds && options.productIds.length > 0) {
      return [...new Set(options.productIds.map(Number).filter(isPositiveInt))].slice(0, max);
    }
    const summaries = await this.deps.shoper.findAllProducts(options.filter ?? {}, max);
    return [...new Set(summaries.map((s) => s.product_id))].slice(0, max);
  }

  /* ---------------------------------------------------------------- */
  /* Item building                                                     */
  /* ---------------------------------------------------------------- */

  /** Build bridge job items (context + source image) for the given products. */
  async buildItems(
    kind: JobKind,
    productIds: readonly number[],
    options: BulkRunOptions = {}
  ): Promise<JobItemInput[]> {
    const products = await this.deps.shoper.getProductsByIds(productIds);
    const contexts = await buildProductContexts(this.deps.shoper, [...products.values()], {
      includeVariants: options.includeVariants === true,
      ...(options.contextTokenBudget !== undefined
        ? { tokenBudget: options.contextTokenBudget }
        : {}),
    });

    const needsImage = IMAGE_SOURCE_KINDS.includes(kind);
    const items: JobItemInput[] = [];
    for (const productId of productIds) {
      const product = products.get(productId);
      if (!product) continue;
      const item: JobItemInput = { external_id: String(productId) };
      const context = contexts.get(productId);
      if (context) item.product_context = context;
      const sku = product.stock?.sku ?? product.code;
      if (sku) item.sku = String(sku);
      if (needsImage || kind === "alt_text") {
        const url = await pickSourceImageUrl(this.deps.shoper, productId);
        if (url) item.source_image_url = url;
        else if (needsImage) {
          this.log("warn", `product ${productId} has no source image, skipping`);
          continue;
        }
      }
      items.push(item);
    }
    return items;
  }

  /* ---------------------------------------------------------------- */
  /* Preflight                                                         */
  /* ---------------------------------------------------------------- */

  /**
   * Resolve products, estimate cost and check the balance + optional cap
   * WITHOUT creating any job. `run()` calls this first; the UI calls it to
   * render the confirmation screen.
   */
  async preflight(kind: JobKind, options: BulkRunOptions = {}): Promise<BulkRunPreflight> {
    const productIds = await this.resolveProductIds(options);
    const result: BulkRunPreflight = {
      kind,
      product_ids: productIds,
      num_items: productIds.length,
      chunks: Math.ceil(productIds.length / MAX_JOB_ITEMS),
    };
    if (productIds.length === 0) {
      result.blocked = { reason: "no_products", detail: "No products matched the filter" };
      return result;
    }
    if (options.skipEstimate) return result;

    const estimateRequest: Parameters<CommerceBridgeClient["estimate"]>[0] = {
      kind,
      num_items: productIds.length,
    };
    if (options.model) estimateRequest.model = options.model;
    if (options.options) estimateRequest.options = options.options;
    const estimate = await this.deps.bridge.estimate(estimateRequest);
    result.estimate = estimate;

    if (options.maxCredits !== undefined && estimate.total_credits > options.maxCredits) {
      result.blocked = {
        reason: "over_cap",
        detail: `Estimated ${estimate.total_credits} credits exceeds the ${options.maxCredits} credit cap for this run`,
        required_credits: estimate.total_credits,
        available_credits: estimate.available_credits,
      };
      return result;
    }
    if (!estimate.sufficient || estimate.total_credits > estimate.available_credits) {
      result.blocked = {
        reason: "insufficient_credits",
        detail: `Need ${estimate.total_credits} credits, ${estimate.available_credits} available`,
        required_credits: estimate.total_credits,
        available_credits: estimate.available_credits,
      };
    }
    return result;
  }

  /* ---------------------------------------------------------------- */
  /* Run                                                               */
  /* ---------------------------------------------------------------- */

  /**
   * Full bulk run: preflight, chunk, submit, persist. Throws
   * InsufficientCreditsError when the preflight blocks on credits, so the HTTP
   * layer can answer 402 exactly like the bridge does.
   */
  async run(kind: JobKind, options: BulkRunOptions = {}): Promise<BatchHandle> {
    const preflight = await this.preflight(kind, options);
    if (preflight.blocked) {
      if (preflight.blocked.reason === "insufficient_credits") {
        throw new InsufficientCreditsError(
          preflight.blocked.required_credits ?? 0,
          preflight.blocked.available_credits ?? 0
        );
      }
      throw new Error(preflight.blocked.detail);
    }

    const items = await this.buildItems(kind, preflight.product_ids, options);
    if (items.length === 0) {
      throw new Error(
        "No product could be prepared for this job (missing source images or products vanished)"
      );
    }

    const groups = chunk(items, MAX_JOB_ITEMS);
    const signature = `${this.deps.connectionId}:${kind}:${
      options.presetSlug ?? ""
    }:${options.model ?? ""}:${items.map((i) => i.external_id).join(",")}`;
    if (inFlight.has(signature)) {
      throw new Error("An identical bulk run is already being submitted");
    }
    inFlight.add(signature);

    const batchId = randomUUID();
    const createdAt = new Date().toISOString();
    const jobIds: string[] = [];
    let estimatedCredits = 0;

    try {
      const batch: Omit<JobBatch, "job_ids"> = {
        batch_id: batchId,
        kind,
        created_at: createdAt,
        total_items: items.length,
        estimated_credits: preflight.estimate?.total_credits ?? 0,
        model: options.model ?? null,
        preset_slug: options.presetSlug ?? null,
        options: options.options ?? null,
        schedule_id: options.scheduleId ?? null,
        status: "queued",
      };
      this.deps.store.createBatch(batch);

      for (const [index, group] of groups.entries()) {
        const request: CreateJobRequest = {
          connection_id: this.deps.connectionId,
          kind,
          items: group,
        };
        if (options.model) request.model = options.model;
        if (options.presetSlug) request.preset_slug = options.presetSlug;
        if (options.options) request.options = options.options;
        request.idempotency_key = buildIdempotencyKey(request);

        const created = await this.deps.bridge.createJob(request);
        jobIds.push(created.job_id);
        estimatedCredits += Number(created.estimated_credits ?? 0);

        const record: CachedJob = {
          job_id: created.job_id,
          kind,
          product_ids: group.map((i) => Number(i.external_id)),
          created_at: new Date().toISOString(),
          batch_id: batchId,
          model: options.model ?? null,
          preset_slug: options.presetSlug ?? null,
          options: options.options ?? null,
          estimated_credits: Number(created.estimated_credits ?? 0),
          schedule_id: options.scheduleId ?? null,
        };
        this.deps.store.rememberJob(record);
        this.log("info", `submitted job ${created.job_id}`, {
          batch_id: batchId,
          chunk: index + 1,
          of: groups.length,
          items: group.length,
        });
      }

      this.deps.store.createBatch({
        batch_id: batchId,
        kind,
        created_at: createdAt,
        total_items: items.length,
        estimated_credits: estimatedCredits || (preflight.estimate?.total_credits ?? 0),
        model: options.model ?? null,
        preset_slug: options.presetSlug ?? null,
        options: options.options ?? null,
        schedule_id: options.scheduleId ?? null,
        status: "queued",
      });
    } catch (err) {
      // Partial failure: whatever was submitted is recorded, so the merchant
      // still sees (and is billed only for) the jobs that landed.
      if (jobIds.length > 0) {
        this.deps.store.updateBatchStatus(batchId, "completed_with_errors");
      }
      throw err;
    } finally {
      inFlight.delete(signature);
    }

    return this.handle(batchId);
  }

  /* ---------------------------------------------------------------- */
  /* Convenience wrappers                                              */
  /* ---------------------------------------------------------------- */

  /** Bulk product photography (generate / edit / bg / upscale / recolor). */
  async bulkImages(
    filter: ProductQuery,
    presetSlug: string | undefined,
    model: string | undefined,
    options: Omit<BulkRunOptions, "filter" | "presetSlug" | "model"> & {
      kind?: JobKind;
    } = {}
  ): Promise<BatchHandle> {
    const kind = options.kind ?? "image_generate";
    const runOptions: BulkRunOptions = { ...options, filter };
    if (presetSlug) runOptions.presetSlug = presetSlug;
    if (model) runOptions.model = model;
    return this.run(kind, runOptions);
  }

  /** Bulk AI copy: descriptions and/or SEO fields. */
  async bulkDescriptions(
    filter: ProductQuery,
    tone: Tone | undefined,
    language: Language | undefined,
    fields: readonly string[] | undefined,
    options: Omit<BulkRunOptions, "filter"> = {}
  ): Promise<BatchHandle> {
    const jobOptions: JobOptions = { ...options.options };
    if (tone) jobOptions.tone = tone;
    if (language) jobOptions.language = language;
    if (fields && fields.length > 0) jobOptions.fields = [...fields];
    return this.run("description", { ...options, filter, options: jobOptions });
  }

  /** Bulk ALT text for images that lack it. */
  async bulkAltText(
    filter: ProductQuery,
    language: Language | undefined,
    options: Omit<BulkRunOptions, "filter"> = {}
  ): Promise<BatchHandle> {
    const jobOptions: JobOptions = { ...options.options };
    if (language) jobOptions.language = language;
    return this.run("alt_text", {
      ...options,
      filter: { missingAltText: true, ...filter },
      options: jobOptions,
    });
  }

  /** Photos + copy + SEO in a single bridge job kind. */
  async completeListing(
    filter: ProductQuery,
    presetSlug: string | undefined,
    model: string | undefined,
    options: Omit<BulkRunOptions, "filter" | "presetSlug" | "model"> & {
      tone?: Tone;
      language?: Language;
    } = {}
  ): Promise<BatchHandle> {
    const jobOptions: JobOptions = { ...options.options };
    if (options.tone) jobOptions.tone = options.tone;
    if (options.language) jobOptions.language = options.language;
    const runOptions: BulkRunOptions = { ...options, filter, options: jobOptions };
    if (presetSlug) runOptions.presetSlug = presetSlug;
    if (model) runOptions.model = model;
    return this.run("complete_listing", runOptions);
  }

  /* ---------------------------------------------------------------- */
  /* Handles                                                           */
  /* ---------------------------------------------------------------- */

  /**
   * Build a handle for an existing batch. Because batches live in SQLite, a
   * run started before a restart can be resumed with just its id.
   */
  handle(batchId: string): BatchHandle {
    const batch = this.deps.store.getBatch(batchId);
    if (!batch) throw new Error(`Unknown batch: ${batchId}`);
    const self = this;

    return {
      batch_id: batch.batch_id,
      kind: batch.kind,
      job_ids: batch.job_ids,
      total_items: batch.total_items,
      estimated_credits: batch.estimated_credits,

      async poll(): Promise<BatchProgress> {
        return self.batchProgress(batchId);
      },

      async onProgress(
        listener: ProgressListener,
        intervalMs = 4000
      ): Promise<BatchProgress> {
        const delay = Math.max(1000, intervalMs);
        for (;;) {
          const progress = await self.batchProgress(batchId);
          try {
            listener(progress);
          } catch {
            /* a broken listener must not stop the poll loop */
          }
          if (progress.terminal) return progress;
          await new Promise((resolve) => setTimeout(resolve, delay));
        }
      },

      async retryFailed(): Promise<{ requeued: number }> {
        let requeued = 0;
        for (const jobId of self.batchJobIds(batchId)) {
          try {
            const res = await self.deps.bridge.retryFailed(jobId);
            requeued += res.requeued;
            const cached = self.deps.store.getJob(jobId);
            if (cached?.state) self.deps.store.updateJobState(jobId, cached.state, false);
          } catch (err) {
            self.log("warn", `retry-failed on ${jobId} failed: ${errorText(err)}`);
          }
        }
        self.deps.store.updateBatchStatus(batchId, "processing");
        return { requeued };
      },

      async cancel(): Promise<{ cancelled: number }> {
        let cancelled = 0;
        for (const jobId of self.batchJobIds(batchId)) {
          const cached = self.deps.store.getJob(jobId);
          if (cached?.terminal) continue;
          try {
            await self.deps.bridge.cancelJob(jobId);
            self.deps.store.markJobTerminal(jobId);
            cancelled += 1;
          } catch (err) {
            self.log("warn", `cancel on ${jobId} failed: ${errorText(err)}`);
          }
        }
        self.deps.store.updateBatchStatus(batchId, "cancelled");
        return { cancelled };
      },

      async collectDrafts(): Promise<number> {
        let collected = 0;
        for (const jobId of self.batchJobIds(batchId)) {
          collected += await self.collectJobDrafts(jobId);
        }
        return collected;
      },
    };
  }

  private batchJobIds(batchId: string): string[] {
    return this.deps.store.getBatch(batchId)?.job_ids ?? [];
  }

  /** Aggregate live state across every job in a batch. */
  async batchProgress(batchId: string): Promise<BatchProgress> {
    const batch = this.deps.store.getBatch(batchId);
    if (!batch) throw new Error(`Unknown batch: ${batchId}`);

    const states: JobState[] = [];
    for (const jobId of batch.job_ids) {
      const cached = this.deps.store.getJob(jobId);
      if (cached?.terminal && cached.state) {
        states.push(cached.state);
        continue;
      }
      try {
        const state = await this.deps.bridge.getJob(jobId);
        this.deps.store.updateJobState(
          jobId,
          state,
          TERMINAL_JOB_STATUSES.includes(state.status)
        );
        states.push(state);
      } catch (err) {
        this.log("warn", `poll of ${jobId} failed: ${errorText(err)}`);
        if (cached?.state) states.push(cached.state);
      }
    }

    const progress: BatchProgress = {
      batch_id: batch.batch_id,
      kind: batch.kind,
      status: aggregateStatus(states),
      job_ids: batch.job_ids,
      total_items: batch.total_items || sum(states, (s) => s.total_items),
      done_items: sum(states, (s) => s.done_items),
      failed_items: sum(states, (s) => s.failed_items),
      spent_credits: sum(states, (s) => s.spent_credits),
      estimated_credits: batch.estimated_credits || sum(states, (s) => s.estimated_credits),
      jobs: states,
      terminal: false,
    };
    progress.terminal =
      states.length > 0 && states.every((s) => TERMINAL_JOB_STATUSES.includes(s.status));
    if (progress.terminal) this.deps.store.updateBatchStatus(batchId, progress.status);
    return progress;
  }

  /**
   * Pull completed items of one job into pending drafts (idempotent). Used by
   * the webhook receiver, the "collect" endpoint and batch handles.
   */
  async collectJobDrafts(jobId: string): Promise<number> {
    const cached = this.deps.store.getJob(jobId);
    const kind = cached?.kind ?? "image_generate";
    const items = await this.deps.bridge.getAllJobItems(jobId);
    let collected = 0;
    for (const item of items) {
      if (item.status !== "completed" || !item.result) continue;
      const bridgeItemId = item.id ? String(item.id) : `${jobId}:${item.external_id}`;
      if (this.deps.store.getDraftByBridgeItem(bridgeItemId)) continue;
      const before = await captureBefore(this.deps.shoper, Number(item.external_id));
      const created = this.deps.store.createDraftFromItem(jobId, kind, item, before, {
        locale: this.deps.shoper.translationLocale,
      });
      if (created) collected += 1;
    }
    return collected;
  }

  /**
   * Resume every non-terminal job after a restart: refresh state and collect
   * drafts for jobs that finished while the process was down.
   */
  async resumeActiveJobs(): Promise<{ refreshed: number; collected: number }> {
    const active = this.deps.store.listActiveJobs();
    let refreshed = 0;
    let collected = 0;
    for (const job of active) {
      try {
        const state = await this.deps.bridge.getJob(job.job_id);
        const terminal = TERMINAL_JOB_STATUSES.includes(state.status);
        this.deps.store.updateJobState(job.job_id, state, terminal);
        refreshed += 1;
        if (terminal) collected += await this.collectJobDrafts(job.job_id);
      } catch (err) {
        this.log("warn", `resume of ${job.job_id} failed: ${errorText(err)}`);
      }
    }
    return { refreshed, collected };
  }
}

/* -------------------------------------------------------------------- */
/* Helpers                                                               */
/* -------------------------------------------------------------------- */

/** Snapshot the live product values for before/after review. */
export async function captureBefore(
  shoper: ShoperClient,
  productId: number
): Promise<NonNullable<import("./types").DraftPayload["before"]>> {
  if (!isPositiveInt(productId)) return {};
  try {
    const product = await shoper.getProduct(productId);
    const t = shoper.productTranslation(product);
    const images = await shoper.getProductImages(productId).catch(() => []);
    const before: NonNullable<import("./types").DraftPayload["before"]> = {};
    if (t?.name) before.name = String(t.name);
    if (t?.short_description) before.short_description = String(t.short_description);
    if (t?.description) before.description = String(t.description);
    if (t?.seo_title) before.seo_title = String(t.seo_title);
    if (t?.seo_description) before.seo_description = String(t.seo_description);
    if (t?.seo_keywords) before.seo_keywords = String(t.seo_keywords);
    const urls = images
      .map((i) => shoper.imageUrl(i))
      .filter((u): u is string => Boolean(u));
    if (urls.length > 0) before.image_urls = urls;
    return before;
  } catch {
    // Before-snapshot is best-effort; the draft is still reviewable.
    return {};
  }
}

/** Fold several job statuses into one batch status. */
export function aggregateStatus(states: readonly JobState[]): JobStatus {
  if (states.length === 0) return "queued";
  if (states.some((s) => s.status === "processing")) return "processing";
  if (states.some((s) => s.status === "awaiting_credits")) return "awaiting_credits";
  if (states.some((s) => s.status === "queued")) return "queued";
  if (states.every((s) => s.status === "cancelled")) return "cancelled";
  if (states.every((s) => s.status === "failed")) return "failed";
  if (
    states.some((s) => s.status === "failed" || s.status === "completed_with_errors") ||
    states.some((s) => s.failed_items > 0)
  ) {
    return "completed_with_errors";
  }
  return "completed";
}

function sum<T>(items: readonly T[], pick: (item: T) => number): number {
  return items.reduce((total, item) => total + (Number(pick(item)) || 0), 0);
}

function isPositiveInt(value: unknown): value is number {
  return typeof value === "number" && Number.isFinite(value) && value > 0;
}

function errorText(err: unknown): string {
  return err instanceof Error ? err.message : String(err);
}

/** Exported for tests: split items the way run() does. */
export function chunkItems(items: readonly JobItemInput[], size = MAX_JOB_ITEMS): JobItemInput[][] {
  return chunk(items, Math.min(Math.max(1, size), MAX_JOB_ITEMS));
}

/** Exported for tests/UI: does this item list need source images? */
export function requiresSourceImage(kind: JobKind): boolean {
  return IMAGE_SOURCE_KINDS.includes(kind);
}

/** Count completed/failed items in a list (used by the drafts UI). */
export function summariseItems(items: readonly JobItem[]): {
  completed: number;
  failed: number;
  pending: number;
} {
  let completed = 0;
  let failed = 0;
  let pending = 0;
  for (const item of items) {
    if (item.status === "completed") completed += 1;
    else if (item.status === "failed" || item.status === "cancelled") failed += 1;
    else pending += 1;
  }
  return { completed, failed, pending };
}
