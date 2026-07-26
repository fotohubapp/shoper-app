/**
 * Shared types for @fotohub/shoper-app.
 *
 * Covers the Shoper REST API surface (https://developers.shoper.pl/) used by
 * this integration and the frozen FOTOhub commerce-bridge REST contract.
 */

/* ------------------------------------------------------------------------ */
/* Infrastructure                                                            */
/* ------------------------------------------------------------------------ */

/**
 * Minimal fetch signature both undici's fetch and the global fetch satisfy.
 * Injectable so tests can run entirely offline.
 */
export type FetchLike = (
  url: string,
  init?: {
    method?: string;
    headers?: Record<string, string>;
    body?: string | Buffer | Uint8Array;
    signal?: AbortSignal;
  }
) => Promise<FetchLikeResponse>;

export interface FetchLikeResponse {
  ok: boolean;
  status: number;
  headers: { get(name: string): string | null };
  text(): Promise<string>;
  arrayBuffer(): Promise<ArrayBuffer>;
}

export type LogLevel = "debug" | "info" | "warn" | "error";

export interface LogRecord {
  level: LogLevel;
  msg: string;
  /** Millisecond duration for request/response pairs. */
  durationMs?: number;
  status?: number;
  method?: string;
  /** Already redacted — safe to persist. */
  url?: string;
  requestId?: string;
  attempt?: number;
  meta?: Record<string, unknown>;
}

export type LogSink = (record: LogRecord) => void;

/* ------------------------------------------------------------------------ */
/* Shoper REST API types                                                     */
/* ------------------------------------------------------------------------ */

export interface ShoperConfig {
  /** Shop URL, e.g. https://sklep123456.shoparena.pl or a custom domain. */
  storeUrl: string;
  /**
   * Pre-issued webapi access token (private app / "webapi" access).
   * When set, login/password are not needed (token refresh is not possible;
   * a 401 becomes a hard error).
   */
  accessToken?: string;
  /** Webapi user login (used with password when no accessToken given). */
  login?: string;
  /** Webapi user password. */
  password?: string;
  /** Requests per second allowed against Shoper webapi. Default 2. */
  requestsPerSecond?: number;
  /** Max time a queued request may wait for a rate-limit slot. Default 60s. */
  maxQueueWaitMs?: number;
  /** Max queued requests before new callers are rejected. Default 500. */
  maxQueueLength?: number;
  /** Retry attempts for 429/5xx/network failures (excluding the first try). Default 3. */
  maxRetries?: number;
  /** Base backoff in ms (doubled per attempt, jittered). Default 500. */
  retryBaseMs?: number;
  /** Hard cap on a single backoff sleep. Default 20s. */
  retryMaxMs?: number;
  /** Per-request timeout in ms. Default 60s. */
  timeoutMs?: number;
  /**
   * Refresh the bearer token this many ms before its declared expiry.
   * Default 5 minutes.
   */
  refreshSkewMs?: number;
  /** Locale used for translated reads/writes. Default pl_PL. */
  locale?: string;
  /** Extra locale kept in sync on writes when requested (e.g. en_US). */
  secondaryLocale?: string;
  /** Structured log sink (redacted). */
  logger?: LogSink;
  /** Injectable fetch (tests). */
  fetchImpl?: FetchLike;
  /** Enable ETag/If-None-Match caching for GETs. Default true. */
  etagCache?: boolean;
  /** Max cached ETag entries. Default 500. */
  etagCacheSize?: number;
}

/** Shoper wraps translated fields per locale under `translations`. */
export interface ShoperProductTranslation {
  translation_id?: string | number;
  product_id?: string | number;
  name?: string;
  short_description?: string;
  description?: string;
  active?: string | number | boolean;
  seo_title?: string;
  seo_description?: string;
  seo_keywords?: string;
  permalink?: string;
  [key: string]: unknown;
}

/** Writable subset of a product translation. */
export type ShoperTranslationPatch = Partial<
  Pick<
    ShoperProductTranslation,
    | "name"
    | "short_description"
    | "description"
    | "seo_title"
    | "seo_description"
    | "seo_keywords"
  >
>;

export const TRANSLATION_FIELDS = [
  "name",
  "short_description",
  "description",
  "seo_title",
  "seo_description",
  "seo_keywords",
] as const;

export type TranslationField = (typeof TRANSLATION_FIELDS)[number];

export interface ShoperStock {
  stock_id?: string | number;
  product_id?: string | number;
  price?: string | number;
  price_wholesale?: string | number;
  sku?: string;
  code?: string;
  ean?: string;
  stock?: string | number;
  active?: string | number | boolean;
  /** Variant option map: {option_id: value_id}. */
  option?: Record<string, string | number> | null;
  extended?: unknown;
  [key: string]: unknown;
}

export interface ShoperProduct {
  product_id: string | number;
  producer_id?: string | number | null;
  category_id?: string | number | null;
  tax_id?: string | number | null;
  unit_id?: string | number | null;
  code?: string;
  ean?: string;
  add_date?: string;
  edit_date?: string;
  stock?: ShoperStock;
  translations?: Record<string, ShoperProductTranslation>;
  /** Main image (Shoper returns object or null). */
  main_image?: ShoperProductImage | null;
  categories?: Array<string | number>;
  attributes?: Record<string, Record<string, string>> | unknown[];
  related?: unknown;
  collection?: unknown;
  [key: string]: unknown;
}

export interface ShoperProductImage {
  gfx_id: string | number;
  product_id?: string | number;
  main?: string | number | boolean;
  order?: string | number;
  /** File name on the Shoper CDN. */
  name?: string;
  unic_name?: string;
  hidden?: string | number | boolean;
  translations?: Record<string, { name?: string; [key: string]: unknown }>;
  [key: string]: unknown;
}

export interface ShoperCategory {
  category_id: string | number;
  parent_id?: string | number | null;
  order?: string | number;
  translations?: Record<string, { name?: string; [key: string]: unknown }>;
  [key: string]: unknown;
}

/** Flattened category with its full ancestor path. */
export interface CategoryNode {
  category_id: number;
  parent_id: number | null;
  name: string;
  /** ["Home", "Shoes", "Sneakers"] */
  path: string[];
  /** "Home > Shoes > Sneakers" */
  path_label: string;
  depth: number;
  children: CategoryNode[];
}

export interface ShoperProducer {
  producer_id: string | number;
  name?: string;
  translations?: Record<string, { name?: string; [key: string]: unknown }>;
  [key: string]: unknown;
}

export interface ShoperAttributeGroup {
  group_id: string | number;
  translations?: Record<string, { name?: string; [key: string]: unknown }>;
  [key: string]: unknown;
}

export interface ShoperAttribute {
  attribute_id: string | number;
  group_id?: string | number;
  translations?: Record<string, { name?: string; [key: string]: unknown }>;
  [key: string]: unknown;
}

export interface ShoperOption {
  option_id: string | number;
  translations?: Record<string, { name?: string; [key: string]: unknown }>;
  [key: string]: unknown;
}

export interface ShoperOptionValue {
  value_id: string | number;
  option_id?: string | number;
  translations?: Record<string, { value?: string; name?: string; [key: string]: unknown }>;
  [key: string]: unknown;
}

export interface ShoperCollection {
  collection_id: string | number;
  translations?: Record<string, { name?: string; [key: string]: unknown }>;
  [key: string]: unknown;
}

export interface ShoperTax {
  tax_id: string | number;
  value?: string | number;
  name?: string;
  [key: string]: unknown;
}

export interface ShoperCurrency {
  currency_id: string | number;
  name?: string;
  code?: string;
  title?: string;
  rate?: string | number;
  is_default?: string | number | boolean;
  [key: string]: unknown;
}

/** Normalised variant row (Shoper product-stocks + options). */
export interface ProductVariant {
  stock_id: number;
  product_id: number;
  sku?: string;
  ean?: string;
  price?: number;
  stock?: number;
  active: boolean;
  /** Human-readable option combination, e.g. {"Size": "42", "Colour": "Red"}. */
  options: Record<string, string>;
}

/** Shoper list envelope: {count, pages, page, list: [...]}. */
export interface ShoperListResponse<T> {
  count: number | string;
  pages: number | string;
  page: number | string;
  list: T[];
}

export interface ShoperAuthResponse {
  access_token: string;
  expires_in?: number;
  token_type?: string;
}

/** Sort orders offered by the product picker. */
export type ProductSort =
  | "name_asc"
  | "name_desc"
  | "price_asc"
  | "price_desc"
  | "images_asc"
  | "desc_asc"
  | "newest"
  | "oldest";

export const PRODUCT_SORTS: readonly ProductSort[] = [
  "name_asc",
  "name_desc",
  "price_asc",
  "price_desc",
  "images_asc",
  "desc_asc",
  "newest",
  "oldest",
] as const;

export interface ProductQuery {
  /** Free-text search against the localised product name. */
  search?: string;
  /** Restrict to a category id. */
  categoryId?: number;
  /** Restrict to a category id and all of its descendants. */
  categoryIdWithChildren?: number;
  /** Restrict to a producer/brand id. */
  producerId?: number;
  /** Restrict to a collection id. */
  collectionId?: number;
  /** Only active (1) / inactive (0) products. */
  active?: boolean;
  /** SKU / code exact match (server-side). */
  code?: string;
  /** EAN exact match (server-side). */
  ean?: string;
  /** Products edited on/after this ISO date (server-side). */
  editedAfter?: string;
  /** Products added on/after this ISO date (server-side). */
  addedAfter?: string;
  /** Explicit product id whitelist (server-side `IN`). */
  productIds?: number[];
  /**
   * Client-side filter: keep only products whose plain-text description is
   * shorter than this many characters (missing-description filter).
   */
  maxDescriptionLength?: number;
  /** Client-side filter: keep only products with fewer than N images. */
  maxImages?: number;
  /** Client-side filter: keep only products missing image ALT text. */
  missingAltText?: boolean;
  /** Client-side filter: minimum gross price. */
  priceFrom?: number;
  /** Client-side filter: maximum gross price. */
  priceTo?: number;
  /** Sort order (name/price/date go to Shoper, the rest sort the page locally). */
  sort?: ProductSort;
  limit?: number;
  page?: number;
  /** Skip the (cached) category-name decoration for cheap bulk scans. */
  skipCategoryNames?: boolean;
}

export interface ProductListPage {
  products: ProductSummary[];
  page: number;
  pages: number;
  count: number;
  /** True when client-side filters removed rows from this page. */
  filtered?: boolean;
}

/** Normalised product row for the picker UI. */
export interface ProductSummary {
  product_id: number;
  name: string;
  sku?: string;
  ean?: string;
  price?: number;
  currency?: string;
  category_id?: number;
  category_name?: string;
  category_path?: string;
  producer_id?: number;
  producer_name?: string;
  description_length: number;
  short_description_length: number;
  image_count: number;
  missing_alt_count?: number;
  thumbnail?: string;
  active?: boolean;
  edit_date?: string;
}

/* ------------------------------------------------------------------------ */
/* FOTOhub commerce-bridge contract types                                    */
/* ------------------------------------------------------------------------ */

export type JobKind =
  | "image_generate"
  | "image_edit"
  | "bg_remove"
  | "bg_replace"
  | "upscale"
  | "recolor"
  | "description"
  | "alt_text"
  | "complete_listing";

export const JOB_KINDS: readonly JobKind[] = [
  "image_generate",
  "image_edit",
  "bg_remove",
  "bg_replace",
  "upscale",
  "recolor",
  "description",
  "alt_text",
  "complete_listing",
] as const;

/** Kinds that need a source image on every item. */
export const IMAGE_SOURCE_KINDS: readonly JobKind[] = [
  "image_edit",
  "bg_remove",
  "bg_replace",
  "upscale",
  "recolor",
] as const;

/** Kinds that produce text results. */
export const TEXT_KINDS: readonly JobKind[] = [
  "description",
  "alt_text",
  "complete_listing",
] as const;

export type JobStatus =
  | "queued"
  | "processing"
  | "completed"
  | "completed_with_errors"
  | "failed"
  | "cancelled"
  | "awaiting_credits";

export const TERMINAL_JOB_STATUSES: readonly JobStatus[] = [
  "completed",
  "completed_with_errors",
  "failed",
  "cancelled",
] as const;

export type ItemStatus =
  | "queued"
  | "processing"
  | "completed"
  | "failed"
  | "cancelled";

export type Language = "en" | "pl" | "de";

export const LANGUAGES: readonly Language[] = ["en", "pl", "de"] as const;

export type Tone =
  | "professional"
  | "casual"
  | "luxury"
  | "playful"
  | "technical"
  | "minimal";

export const TONES: readonly Tone[] = [
  "professional",
  "casual",
  "luxury",
  "playful",
  "technical",
  "minimal",
] as const;

export interface JobOptions {
  language?: Language;
  tone?: Tone;
  brand_rules?: string;
  aspect_ratio?: string;
  /** 1-4 */
  num_images?: number;
  output_format?: string;
  background?: string;
  recolor_prompt?: string;
  target_object?: string;
  /** Fields the copy job should produce (complete_listing/description). */
  fields?: string[];
  [key: string]: unknown;
}

export interface ProductContext {
  title: string;
  category?: string;
  attributes?: Record<string, string>;
  price?: number;
  currency?: string;
  brand?: string;
  sku?: string;
  ean?: string;
  current_description?: string;
  variants?: string[];
}

export interface JobItemInput {
  external_id: string;
  sku?: string;
  variant_id?: string;
  source_image_url?: string;
  product_context?: ProductContext;
}

export interface CreateJobRequest {
  connection_id: string;
  kind: JobKind;
  model?: string;
  preset_slug?: string;
  options?: JobOptions;
  items: JobItemInput[];
  idempotency_key?: string;
}

export interface CreateJobResponse {
  job_id: string;
  status: JobStatus;
  total_items: number;
  estimated_credits: number;
}

export interface JobState {
  id: string;
  status: JobStatus;
  kind: JobKind;
  total_items: number;
  done_items: number;
  failed_items: number;
  spent_credits: number;
  estimated_credits: number;
}

export interface ItemResultText {
  title?: string;
  short_description?: string;
  description?: string;
  meta_title?: string;
  meta_description?: string;
  meta_keywords?: string;
  alt_text?: string;
  faq?: Array<{ question: string; answer: string }> | string;
  json_ld?: string;
}

export interface ItemResult {
  image_urls?: string[];
  text?: ItemResultText;
}

export interface JobItem {
  id: string;
  external_id: string;
  sku?: string;
  variant_id?: string;
  status: ItemStatus;
  attempts: number;
  result?: ItemResult;
  error_message?: string;
  credits_used?: number;
}

export interface JobItemsQuery {
  status?: ItemStatus;
  limit?: number;
  offset?: number;
}

export type PresetCategory =
  | "background"
  | "scene"
  | "lighting"
  | "composition"
  | "channel"
  | "vertical"
  | "description_tone"
  | "bundle";

export const PRESET_CATEGORIES: readonly PresetCategory[] = [
  "background",
  "scene",
  "lighting",
  "composition",
  "channel",
  "vertical",
  "description_tone",
  "bundle",
] as const;

export interface Preset {
  slug: string;
  name: string;
  name_pl: string;
  category: PresetCategory;
  description: string;
  fragments?: Record<string, unknown>;
  thumbnail_url?: string;
  is_system: boolean;
}

export interface PresetQuery {
  category?: PresetCategory;
  vertical?: string;
  platform?: string;
}

export interface EstimateRequest {
  kind: JobKind;
  model?: string;
  num_items: number;
  options?: JobOptions;
}

export interface EstimateResponse {
  credits_per_item: number;
  total_credits: number;
  available_credits: number;
  sufficient: boolean;
}

export interface Connection {
  id: string;
  status: string;
  callback_secret?: string;
  platform?: string;
  store_url?: string;
  store_name?: string;
}

export interface CreateConnectionRequest {
  platform: string;
  store_url: string;
  store_name: string;
  callback_url?: string;
  settings?: Record<string, unknown>;
}

export type WebhookEvent =
  | "commerce.item.completed"
  | "commerce.job.completed"
  | "commerce.job.failed"
  | "commerce.job.awaiting_credits";

export const WEBHOOK_EVENTS: readonly WebhookEvent[] = [
  "commerce.item.completed",
  "commerce.job.completed",
  "commerce.job.failed",
  "commerce.job.awaiting_credits",
] as const;

export interface WebhookPayload {
  event: WebhookEvent;
  job_id: string;
  item?: JobItem;
  job?: JobState;
  /** Unix seconds; used for the replay window when the header is absent. */
  timestamp?: number;
  /** Unique delivery id; used for replay suppression. */
  delivery_id?: string;
  nonce?: string;
  [key: string]: unknown;
}

export interface BillingBalance {
  available_credits: number;
  [key: string]: unknown;
}

/* ------------------------------------------------------------------------ */
/* Image models exposed in the UI                                            */
/* ------------------------------------------------------------------------ */

export interface ImageModelInfo {
  id: string;
  label: string;
  creditsPerImage: number;
  isDefault?: boolean;
}

export const IMAGE_MODELS: readonly ImageModelInfo[] = [
  { id: "seedream-5-0-260128", label: "SeedDream 5.0", creditsPerImage: 2, isDefault: true },
  { id: "dola-seedream-5-0-pro-260628", label: "SeedDream 5.0 Pro", creditsPerImage: 3 },
  { id: "gpt-image-2", label: "GPT Image 2", creditsPerImage: 2 },
  { id: "nano-banana-pro", label: "Nano Banana Pro", creditsPerImage: 5.3 },
  { id: "nano-banana-fast", label: "Nano Banana Fast", creditsPerImage: 2 },
  { id: "imagen-4-standard", label: "Imagen 4 Standard", creditsPerImage: 3 },
  { id: "imagen-4-ultra", label: "Imagen 4 Ultra", creditsPerImage: 5 },
  { id: "imagen-4-fast", label: "Imagen 4 Fast", creditsPerImage: 2 },
] as const;

export const DEFAULT_IMAGE_MODEL = "seedream-5-0-260128";

export function isKnownModel(id: string | undefined): boolean {
  return Boolean(id) && IMAGE_MODELS.some((m) => m.id === id);
}

/* ------------------------------------------------------------------------ */
/* Draft store types                                                         */
/* ------------------------------------------------------------------------ */

export type DraftStatus = "pending" | "applying" | "approved" | "rejected" | "failed";

export type DraftType = "images" | "text" | "mixed";

export interface DraftImage {
  url: string;
  alt_text?: string;
  /** Replace the product's main image with this one. */
  main?: boolean;
}

export interface DraftPayload {
  /** Proposed new images (not yet on the product). */
  images?: DraftImage[];
  /** Proposed text fields (not yet on the product). */
  text?: ItemResultText;
  /** Snapshot of live values at draft time, for before/after review. */
  before?: {
    name?: string;
    short_description?: string;
    description?: string;
    seo_title?: string;
    seo_description?: string;
    seo_keywords?: string;
    image_urls?: string[];
  };
  /** Target locale for text write-back (defaults to the client locale). */
  locale?: string;
}

export interface DraftRow {
  id: number;
  product_id: number;
  variant_id: string | null;
  job_id: string;
  item_id: string;
  /** Globally unique bridge item identifier (idempotency anchor). */
  bridge_item_id: string;
  kind: JobKind;
  type: DraftType;
  status: DraftStatus;
  payload: DraftPayload;
  created_at: string;
  decided_at?: string | null;
  decided_by?: string | null;
  applied_at?: string | null;
  attempts: number;
  error?: string | null;
}

export interface DraftFilter {
  status?: DraftStatus;
  jobId?: string;
  productId?: number;
  kind?: JobKind;
  type?: DraftType;
  search?: string;
  limit?: number;
  offset?: number;
}

/* ------------------------------------------------------------------------ */
/* Local job records                                                         */
/* ------------------------------------------------------------------------ */

export interface CachedJob {
  job_id: string;
  kind: JobKind;
  product_ids: number[];
  created_at: string;
  /** Last known state from polling or webhooks. */
  state?: JobState;
  /** Set when a terminal webhook arrived, so the UI can skip bridge polls. */
  terminal?: boolean;
  /** Batch id when the job is one chunk of a larger orchestrated run. */
  batch_id?: string | null;
  model?: string | null;
  preset_slug?: string | null;
  options?: JobOptions | null;
  estimated_credits?: number | null;
  /** Set when created by a schedule. */
  schedule_id?: number | null;
}

/** A logical bulk run spanning one or more bridge jobs. */
export interface JobBatch {
  batch_id: string;
  kind: JobKind;
  created_at: string;
  job_ids: string[];
  total_items: number;
  estimated_credits: number;
  model?: string | null;
  preset_slug?: string | null;
  options?: JobOptions | null;
  schedule_id?: number | null;
  status: JobStatus;
}

/* ------------------------------------------------------------------------ */
/* Scheduler                                                                 */
/* ------------------------------------------------------------------------ */

export type ScheduleTask =
  | "descriptions_missing"
  | "alt_text_missing"
  | "bg_remove_new"
  | "upscale_small";

export const SCHEDULE_TASKS: readonly ScheduleTask[] = [
  "descriptions_missing",
  "alt_text_missing",
  "bg_remove_new",
  "upscale_small",
] as const;

export interface ScheduleDefinition {
  id: number;
  name: string;
  task: ScheduleTask;
  enabled: boolean;
  /** Local hour (0-23) at which a daily run starts. */
  hour: number;
  /** Local minute (0-59). */
  minute: number;
  /** Run every N days (1 = daily). */
  interval_days: number;
  /** Hard cap on estimated credits per run; the run aborts above it. */
  max_credits_per_run: number;
  /** Max products picked up per run. */
  max_items_per_run: number;
  model?: string | null;
  preset_slug?: string | null;
  options?: JobOptions | null;
  last_run_at?: string | null;
  last_run_status?: string | null;
  last_run_detail?: string | null;
  next_run_at?: string | null;
  created_at: string;
}

export type ScheduleInput = Omit<
  ScheduleDefinition,
  "id" | "created_at" | "last_run_at" | "last_run_status" | "last_run_detail" | "next_run_at"
>;

/* ------------------------------------------------------------------------ */
/* Write-back                                                                */
/* ------------------------------------------------------------------------ */

export interface WriteBackResult {
  product_id: number;
  applied_images: number;
  applied_fields: string[];
  skipped: string[];
  warnings: string[];
}

export interface ImageFetchLimits {
  /** Reject downloads larger than this. Default 25 MiB. */
  maxBytes?: number;
  /** Allowed content types. Default jpeg/png/webp/gif/avif. */
  allowedMimeTypes?: readonly string[];
  /** Only allow https URLs (plus http when explicitly enabled). Default true. */
  requireHttps?: boolean;
  /** Optional host allowlist for downloaded images. */
  allowedHosts?: readonly string[];
  timeoutMs?: number;
}

/* ------------------------------------------------------------------------ */
/* Errors                                                                    */
/* ------------------------------------------------------------------------ */

export class FotoHubBridgeError extends Error {
  constructor(
    message: string,
    public readonly status: number,
    public readonly body?: unknown
  ) {
    super(message);
    this.name = "FotoHubBridgeError";
  }
}

export class InsufficientCreditsError extends FotoHubBridgeError {
  constructor(
    public readonly requiredCredits: number,
    public readonly availableCredits: number,
    body?: unknown
  ) {
    super(
      `Insufficient credits: need ${requiredCredits}, have ${availableCredits}`,
      402,
      body
    );
    this.name = "InsufficientCreditsError";
  }
}

export class ShoperApiError extends Error {
  constructor(
    message: string,
    public readonly status: number,
    public readonly body?: unknown
  ) {
    super(message);
    this.name = "ShoperApiError";
  }
}

/** 401/403 — token rejected or missing permissions. */
export class ShoperAuthError extends ShoperApiError {
  constructor(message: string, status = 401, body?: unknown) {
    super(message, status, body);
    this.name = "ShoperAuthError";
  }
}

/** 429 — webapi bucket exhausted. */
export class ShoperRateLimitError extends ShoperApiError {
  constructor(
    message: string,
    public readonly retryAfterMs: number,
    body?: unknown
  ) {
    super(message, 429, body);
    this.name = "ShoperRateLimitError";
  }
}

/** 404 — resource does not exist. */
export class ShoperNotFound extends ShoperApiError {
  constructor(message: string, body?: unknown) {
    super(message, 404, body);
    this.name = "ShoperNotFound";
  }
}

/** 400/422 — payload rejected. */
export class ShoperValidationError extends ShoperApiError {
  constructor(message: string, status = 400, body?: unknown) {
    super(message, status, body);
    this.name = "ShoperValidationError";
  }
}

/** Local queue/timeout failures that never reached Shoper. */
export class ShoperTransportError extends ShoperApiError {
  constructor(message: string, body?: unknown) {
    super(message, 0, body);
    this.name = "ShoperTransportError";
  }
}

/** Image download rejected by the write-back guards. */
export class ImageFetchError extends Error {
  constructor(
    message: string,
    public readonly reason:
      | "http_error"
      | "too_large"
      | "bad_mime"
      | "blocked_url"
      | "timeout"
      | "empty"
  ) {
    super(message);
    this.name = "ImageFetchError";
  }
}
