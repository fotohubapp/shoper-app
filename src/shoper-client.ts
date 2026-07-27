/**
 * Shoper REST API client (https://developers.shoper.pl/developers/api/).
 *
 * Auth models supported:
 *  - webapi token: pre-issued access token for a private app ("Aplikacja
 *    własna" / webapi access). No refresh possible; 401 is a hard error.
 *  - login/password: POST {store}/webapi/rest/auth with HTTP Basic auth,
 *    returns a bearer token (expires ~30 days). The client refreshes it
 *    proactively before `expires_in` elapses and reactively on a 401.
 *
 * Transport hardening:
 *  - leaky-bucket throttle (configurable rps, burst, bounded FIFO queue with
 *    a max wait, jitter) so bulk jobs stay inside Shoper's webapi limits,
 *  - retry with full-jitter exponential backoff on 429/5xx/network errors,
 *    honouring Retry-After and pushing the penalty onto the shared bucket so
 *    every queued caller backs off, not just the unlucky one,
 *  - per-request timeout via AbortSignal,
 *  - typed errors (ShoperAuthError / ShoperPermissionError /
 *    ShoperRateLimitError / ShoperNotFound / ShoperValidationError /
 *    ShoperTransportError). A 403 is a permission problem, never a stale
 *    token, so it is reported as such and never triggers a refresh.
 *  - request/response log hooks with API-key + Authorization redaction,
 *  - opt-in ETag/If-None-Match caching for GETs (Shoper sends ETags on some
 *    collections; a 304 replays the cached body at zero parse cost).
 *
 * Translated product fields (name/short_description/description/seo_*) live
 * under `translations.{locale}` (default locale pl_PL).
 */

import { fetch as undiciFetch } from "undici";
import {
  BoundedLru,
  backoffDelay,
  isRetryableStatus,
  parseRetryAfter,
  redact,
  redactUrl,
  sleep,
} from "./http";
import { LeakyBucket } from "./http";
import {
  CategoryNode,
  FetchLike,
  LogRecord,
  LogSink,
  ProductListPage,
  ProductQuery,
  ProductSort,
  ProductSummary,
  ProductVariant,
  ShoperApiError,
  ShoperAttribute,
  ShoperAttributeGroup,
  ShoperAuthError,
  ShoperAuthResponse,
  ShoperCategory,
  ShoperCollection,
  ShoperConfig,
  ShoperCurrency,
  ShoperListResponse,
  ShoperNotFound,
  ShoperOption,
  ShoperOptionValue,
  ShoperPermissionError,
  ShoperProducer,
  ShoperProduct,
  ShoperProductImage,
  ShoperProductTranslation,
  ShoperRateLimitError,
  ShoperStock,
  ShoperTax,
  ShoperTransportError,
  ShoperTranslationPatch,
  ShoperValidationError,
} from "./types";

export const DEFAULT_LOCALE = "pl_PL";
export const SECONDARY_LOCALE = "en_US";
/** Shoper hard limit per page. */
export const MAX_PAGE_LIMIT = 50;
const CATEGORY_CACHE_MS = 5 * 60 * 1000;
const LOOKUP_CACHE_MS = 10 * 60 * 1000;

/** Map picker sort ids onto Shoper's `order` query parameter. */
function shoperOrder(sort: ProductSort | undefined): string | undefined {
  switch (sort) {
    case "name_asc":
      return "translations.name ASC";
    case "name_desc":
      return "translations.name DESC";
    case "price_asc":
      return "stock.price ASC";
    case "price_desc":
      return "stock.price DESC";
    case "newest":
      return "add_date DESC";
    case "oldest":
      return "add_date ASC";
    default:
      return undefined;
  }
}

type QueryValue = string | number | boolean | undefined;

interface RequestOptions {
  query?: Record<string, QueryValue>;
  body?: unknown;
  /** Skip the ETag cache for this call. */
  noCache?: boolean;
  /** Treat 404 as `undefined` instead of throwing. */
  allow404?: boolean;
  /** Internal: attempt counter for retries. */
  attempt?: number;
  /** Internal: set once we already re-authenticated for this call. */
  retriedAuth?: boolean;
  signal?: AbortSignal;
}

interface CacheEntry {
  etag: string;
  body: unknown;
}

/* -------------------------------------------------------------------- */
/* Client                                                                */
/* -------------------------------------------------------------------- */

export class ShoperClient {
  private readonly storeUrl: string;
  private readonly login?: string;
  private readonly password?: string;
  private token?: string;
  /** Epoch ms after which the token must be refreshed (0 = unknown). */
  private tokenExpiresAt = 0;
  private readonly tokenIsStatic: boolean;
  private authInFlight?: Promise<string>;

  private readonly bucket: LeakyBucket;
  private readonly locale: string;
  private readonly secondary: string;
  private readonly maxRetries: number;
  private readonly retryBaseMs: number;
  private readonly retryMaxMs: number;
  private readonly timeoutMs: number;
  private readonly refreshSkewMs: number;
  private readonly logger?: LogSink;
  private readonly fetchImpl: FetchLike;
  private readonly etagEnabled: boolean;
  private readonly etagCache: BoundedLru<CacheEntry>;

  private categoryCache?: { at: number; nodes: CategoryNode[]; flat: Map<number, CategoryNode> };
  private categoryCachePending?: Promise<CategoryNode[]>;
  private producerCache?: { at: number; map: Map<number, string> };
  private optionCache?: {
    at: number;
    options: Map<number, string>;
    values: Map<number, string>;
  };
  private currencyCache?: { at: number; code: string };
  private attributeCache?: { at: number; map: Map<number, string> };
  private taxCache?: { at: number; map: Map<number, number> };

  constructor(config: ShoperConfig, localeOverride?: string) {
    if (!config.storeUrl) throw new Error("storeUrl is required");
    const normalised = config.storeUrl.trim().replace(/\/+$/, "");
    if (!/^https?:\/\//i.test(normalised)) {
      throw new Error("storeUrl must start with http:// or https://");
    }
    this.storeUrl = normalised;
    this.login = config.login;
    this.password = config.password;
    this.token = config.accessToken;
    this.tokenIsStatic = Boolean(config.accessToken);
    this.locale = localeOverride ?? config.locale ?? DEFAULT_LOCALE;
    this.secondary = config.secondaryLocale ?? SECONDARY_LOCALE;
    this.maxRetries = Math.max(0, config.maxRetries ?? 3);
    this.retryBaseMs = Math.max(50, config.retryBaseMs ?? 500);
    this.retryMaxMs = Math.max(this.retryBaseMs, config.retryMaxMs ?? 20_000);
    this.timeoutMs = Math.max(1000, config.timeoutMs ?? 60_000);
    this.refreshSkewMs = Math.max(0, config.refreshSkewMs ?? 5 * 60 * 1000);
    this.logger = config.logger;
    this.fetchImpl = config.fetchImpl ?? (undiciFetch as unknown as FetchLike);
    this.etagEnabled = config.etagCache !== false;
    this.etagCache = new BoundedLru<CacheEntry>(config.etagCacheSize ?? 500);

    const rps = config.requestsPerSecond ?? 2;
    this.bucket = new LeakyBucket({
      requestsPerSecond: rps,
      burst: Math.max(1, Math.ceil(rps)),
      maxWaitMs: config.maxQueueWaitMs ?? 60_000,
      maxQueueLength: config.maxQueueLength ?? 500,
      jitterMs: 25,
    });

    if (!this.token && !(this.login && this.password)) {
      throw new Error("Shoper auth requires either accessToken or login+password");
    }
  }

  private get apiBase(): string {
    return `${this.storeUrl}/webapi/rest`;
  }

  /** Locale used for translated fields (pl_PL by default). */
  get translationLocale(): string {
    return this.locale;
  }

  get secondaryLocale(): string {
    return this.secondary;
  }

  get baseUrl(): string {
    return this.storeUrl;
  }

  /** Pending rate-limit queue depth (surfaced in /api/health). */
  get queueDepth(): number {
    return this.bucket.queueLength;
  }

  /** Number of cached ETag responses (surfaced in /api/health). */
  get etagCacheSize(): number {
    return this.etagCache.size;
  }

  /**
   * Drop every cached lookup (categories, producers, options, currency, tax,
   * attributes) and the ETag cache. Called after a write that could invalidate
   * them, and by the settings screen's "refresh store data" action.
   */
  clearCaches(): void {
    this.categoryCache = undefined;
    this.producerCache = undefined;
    this.optionCache = undefined;
    this.currencyCache = undefined;
    this.attributeCache = undefined;
    this.taxCache = undefined;
    this.etagCache.clear();
  }

  private log(record: LogRecord): void {
    if (!this.logger) return;
    try {
      this.logger({ ...record, msg: redact(record.msg) });
    } catch {
      /* a broken log sink must never break a request */
    }
  }

  /* ---------------------------------------------------------------- */
  /* Auth                                                              */
  /* ---------------------------------------------------------------- */

  /** POST /webapi/rest/auth with Basic credentials -> bearer token. */
  private async authenticate(): Promise<string> {
    if (this.authInFlight) return this.authInFlight;
    if (!this.login || !this.password) {
      throw new ShoperAuthError(
        "Shoper token expired/rejected and no login/password configured for re-auth",
        401
      );
    }
    const basic = Buffer.from(`${this.login}:${this.password}`).toString("base64");
    const attempt = async (): Promise<string> => {
      let lastError: Error | undefined;
      for (let i = 0; i <= this.maxRetries; i += 1) {
        await this.bucket.take();
        const started = Date.now();
        let response;
        try {
          response = await this.timedFetch(`${this.apiBase}/auth`, {
            method: "POST",
            headers: { Authorization: `Basic ${basic}`, Accept: "application/json" },
          });
        } catch (err) {
          lastError = err instanceof Error ? err : new Error(String(err));
          if (i === this.maxRetries) break;
          await sleep(backoffDelay({ baseMs: this.retryBaseMs, maxMs: this.retryMaxMs, attempt: i + 1 }));
          continue;
        }

        const text = await response.text().catch(() => "");
        this.log({
          level: response.ok ? "debug" : "warn",
          msg: "shoper auth",
          method: "POST",
          url: `${this.apiBase}/auth`,
          status: response.status,
          durationMs: Date.now() - started,
          attempt: i + 1,
        });

        if (isRetryableStatus(response.status) && i < this.maxRetries) {
          const retryAfterMs = parseRetryAfter(response.headers.get("retry-after"));
          const delay = backoffDelay({
            baseMs: this.retryBaseMs,
            maxMs: this.retryMaxMs,
            attempt: i + 1,
            retryAfterMs,
          });
          this.bucket.penalise(delay);
          await sleep(delay);
          continue;
        }

        let body: unknown;
        try {
          body = text ? JSON.parse(text) : undefined;
        } catch {
          body = undefined;
        }
        const parsed = body as ShoperAuthResponse | { error_description?: string } | undefined;
        if (!response.ok || !parsed || !("access_token" in parsed) || !parsed.access_token) {
          const detail =
            parsed && "error_description" in parsed && parsed.error_description
              ? String(parsed.error_description)
              : "no token returned";
          // The store's own error text is echoed here, and a misconfigured
          // store can echo the credential straight back, so it goes through
          // the same redaction as every other error path.
          throw new ShoperAuthError(
            redact(`Shoper auth failed (${response.status}): ${detail}`),
            response.status || 401,
            body
          );
        }
        this.token = parsed.access_token;
        const expiresIn = Number(parsed.expires_in ?? 0);
        this.tokenExpiresAt =
          Number.isFinite(expiresIn) && expiresIn > 0 ? Date.now() + expiresIn * 1000 : 0;
        return parsed.access_token;
      }
      throw new ShoperTransportError(
        `Shoper auth unreachable: ${lastError?.message ?? "unknown transport error"}`
      );
    };

    this.authInFlight = attempt().finally(() => {
      this.authInFlight = undefined;
    });
    return this.authInFlight;
  }

  /** Return a usable bearer token, refreshing proactively before expiry. */
  private async ensureToken(): Promise<string> {
    const needsRefresh =
      !this.token ||
      (!this.tokenIsStatic &&
        this.tokenExpiresAt > 0 &&
        Date.now() >= this.tokenExpiresAt - this.refreshSkewMs);
    if (needsRefresh) {
      if (this.tokenIsStatic && this.token) return this.token;
      return this.authenticate();
    }
    return this.token as string;
  }

  /** Force a re-auth on the next request (used after credential rotation). */
  invalidateToken(): void {
    if (!this.tokenIsStatic) {
      this.token = undefined;
      this.tokenExpiresAt = 0;
    }
  }

  private async timedFetch(
    url: string,
    init: { method?: string; headers?: Record<string, string>; body?: string }
  ): Promise<Awaited<ReturnType<FetchLike>>> {
    const controller = new AbortController();
    const timer = setTimeout(() => controller.abort(), this.timeoutMs);
    try {
      return await this.fetchImpl(url, { ...init, signal: controller.signal });
    } catch (err) {
      if (controller.signal.aborted) {
        throw new ShoperTransportError(`Shoper request timed out after ${this.timeoutMs}ms`);
      }
      throw err instanceof Error ? err : new Error(String(err));
    } finally {
      clearTimeout(timer);
    }
  }

  /* ---------------------------------------------------------------- */
  /* Core request                                                      */
  /* ---------------------------------------------------------------- */

  private buildUrl(path: string, query?: Record<string, QueryValue>): string {
    const url = new URL(`${this.apiBase}${path}`);
    if (query) {
      for (const [key, value] of Object.entries(query)) {
        if (value === undefined) continue;
        url.searchParams.set(key, String(value));
      }
    }
    return url.toString();
  }

  private async request<T>(
    method: string,
    path: string,
    options: RequestOptions = {}
  ): Promise<T> {
    const url = this.buildUrl(path, options.query);
    const cacheKey = `${method} ${url}`;
    const useCache =
      this.etagEnabled && method === "GET" && !options.noCache && options.body === undefined;

    let lastTransportError: Error | undefined;

    for (let attempt = 1; attempt <= this.maxRetries + 1; attempt += 1) {
      const token = await this.ensureToken();
      await this.bucket.take();

      const headers: Record<string, string> = {
        Authorization: `Bearer ${token}`,
        Accept: "application/json",
      };
      if (options.body !== undefined) headers["Content-Type"] = "application/json";
      const cached = useCache ? this.etagCache.get(cacheKey) : undefined;
      if (cached) headers["If-None-Match"] = cached.etag;

      const started = Date.now();
      let response;
      try {
        response = await this.timedFetch(url, {
          method,
          headers,
          body: options.body !== undefined ? JSON.stringify(options.body) : undefined,
        });
      } catch (err) {
        lastTransportError = err instanceof Error ? err : new Error(String(err));
        this.log({
          level: "warn",
          msg: `shoper ${method} transport failure: ${lastTransportError.message}`,
          method,
          url: redactUrl(url),
          attempt,
          durationMs: Date.now() - started,
        });
        if (attempt > this.maxRetries) break;
        await sleep(
          backoffDelay({ baseMs: this.retryBaseMs, maxMs: this.retryMaxMs, attempt })
        );
        continue;
      }

      const durationMs = Date.now() - started;
      this.log({
        level: response.ok || response.status === 304 ? "debug" : "warn",
        msg: `shoper ${method} ${path}`,
        method,
        url: redactUrl(url),
        status: response.status,
        durationMs,
        attempt,
      });

      // 304: replay the cached representation.
      if (response.status === 304 && cached) {
        return cached.body as T;
      }

      // Expired/rejected token: re-authenticate once (only when we own creds).
      // Deliberately 401 only. In Shoper a 403 means the webapi user lacks the
      // permission for this resource, so re-authenticating would spend an extra
      // round trip, return the same 403, and bury the real cause behind an
      // auth-looking error.
      if (
        response.status === 401 &&
        !options.retriedAuth &&
        !this.tokenIsStatic &&
        this.login &&
        this.password
      ) {
        this.invalidateToken();
        await this.authenticate();
        return this.request<T>(method, path, { ...options, retriedAuth: true });
      }

      if (isRetryableStatus(response.status) && attempt <= this.maxRetries) {
        const retryAfterMs = parseRetryAfter(response.headers.get("retry-after"));
        const delay = backoffDelay({
          baseMs: this.retryBaseMs,
          maxMs: this.retryMaxMs,
          attempt,
          retryAfterMs,
        });
        // Make every other queued caller respect the penalty too.
        this.bucket.penalise(delay);
        await sleep(delay);
        continue;
      }

      const text = await response.text().catch(() => "");
      let body: unknown = text;
      if (text) {
        try {
          body = JSON.parse(text);
        } catch {
          /* leave raw text */
        }
      } else {
        body = undefined;
      }

      if (!response.ok) {
        if (response.status === 404 && options.allow404) {
          return undefined as T;
        }
        throw this.toError(method, path, response.status, body, text, response.headers.get("retry-after"));
      }

      if (useCache) {
        const etag = response.headers.get("etag");
        if (etag) this.etagCache.set(cacheKey, { etag, body });
      }

      return body as T;
    }

    throw new ShoperTransportError(
      `Shoper ${method} ${path} failed after ${this.maxRetries + 1} attempts: ${
        lastTransportError?.message ?? "rate limited"
      }`
    );
  }

  private toError(
    method: string,
    path: string,
    status: number,
    body: unknown,
    rawText: string,
    retryAfter: string | null
  ): ShoperApiError {
    const detail = extractErrorDetail(body) ?? rawText.slice(0, 300);
    const message = redact(`Shoper ${method} ${path} failed with ${status}: ${detail}`);
    if (status === 403) {
      return new ShoperPermissionError(
        `${message} — insufficient permission: the Shoper webapi user cannot ` +
          `access ${path}. Grant it in the Shoper admin under the webapi user's ` +
          `permission list (this is not a token problem).`,
        body
      );
    }
    if (status === 401) return new ShoperAuthError(message, status, body);
    if (status === 404) return new ShoperNotFound(message, body);
    if (status === 429) {
      return new ShoperRateLimitError(message, parseRetryAfter(retryAfter) ?? 1000, body);
    }
    if (status === 400 || status === 409 || status === 422) {
      return new ShoperValidationError(message, status, body);
    }
    return new ShoperApiError(message, status, body);
  }

  /* ---------------------------------------------------------------- */
  /* Pagination helpers                                                */
  /* ---------------------------------------------------------------- */

  /**
   * Async iterator over every page of a Shoper collection. Stops as soon as
   * the reported page count is reached, so a caller can `break` early without
   * fetching the tail.
   */
  async *paginate<T>(
    path: string,
    query: Record<string, QueryValue> = {},
    pageSize = MAX_PAGE_LIMIT
  ): AsyncGenerator<T[], void, void> {
    const limit = Math.min(Math.max(1, pageSize), MAX_PAGE_LIMIT);
    let page = 1;
    for (;;) {
      const res = await this.request<ShoperListResponse<T>>("GET", path, {
        query: { ...query, limit, page },
      });
      const list = res?.list ?? [];
      if (list.length > 0) yield list;
      const pages = Number(res?.pages ?? 1);
      if (!Number.isFinite(pages) || page >= pages || list.length === 0) return;
      page += 1;
      // Defensive: Shoper occasionally reports absurd page counts.
      if (page > 10_000) return;
    }
  }

  /** Async iterator over individual records of a collection. */
  async *iterate<T>(
    path: string,
    query: Record<string, QueryValue> = {},
    pageSize = MAX_PAGE_LIMIT
  ): AsyncGenerator<T, void, void> {
    for await (const batch of this.paginate<T>(path, query, pageSize)) {
      for (const item of batch) yield item;
    }
  }

  /** Collect every record of a collection, with a hard safety cap. */
  private async collectAll<T>(
    path: string,
    query: Record<string, QueryValue> = {},
    maxRecords = 20_000
  ): Promise<T[]> {
    const out: T[] = [];
    for await (const batch of this.paginate<T>(path, query)) {
      out.push(...batch);
      if (out.length >= maxRecords) break;
    }
    return out.slice(0, maxRecords);
  }

  /* ---------------------------------------------------------------- */
  /* Health                                                            */
  /* ---------------------------------------------------------------- */

  /** Cheap credential check: fetch a single product page. */
  async healthCheck(): Promise<{ ok: boolean; error?: string; count?: number }> {
    try {
      const res = await this.request<ShoperListResponse<ShoperProduct>>("GET", "/products", {
        query: { limit: 1, page: 1 },
        noCache: true,
      });
      return { ok: true, count: Number(res?.count ?? 0) };
    } catch (err) {
      return { ok: false, error: err instanceof Error ? redact(err.message) : String(err) };
    }
  }

  /* ---------------------------------------------------------------- */
  /* Products                                                          */
  /* ---------------------------------------------------------------- */

  /** Build the Shoper `filters` JSON for a product query. */
  private async buildProductFilters(
    query: ProductQuery
  ): Promise<Record<string, unknown>> {
    const filters: Record<string, unknown> = {};
    if (query.search) {
      filters[`translations.${this.locale}.name`] = { like: `%${escapeLike(query.search)}%` };
    }
    if (query.categoryIdWithChildren !== undefined) {
      const ids = await this.categoryWithDescendants(query.categoryIdWithChildren);
      filters["category_id"] = ids.length > 1 ? { in: ids } : ids[0];
    } else if (query.categoryId !== undefined) {
      filters["category_id"] = query.categoryId;
    }
    if (query.producerId !== undefined) filters["producer_id"] = query.producerId;
    if (query.collectionId !== undefined) filters["collection_id"] = query.collectionId;
    if (query.code) filters["code"] = query.code;
    if (query.ean) filters["ean"] = query.ean;
    if (query.active !== undefined) filters["stock.active"] = query.active ? 1 : 0;
    if (query.editedAfter) filters["edit_date"] = { ">=": query.editedAfter };
    if (query.addedAfter) filters["add_date"] = { ">=": query.addedAfter };
    if (query.productIds && query.productIds.length > 0) {
      filters["product_id"] = { in: query.productIds };
    }
    return filters;
  }

  /**
   * List products with picker filters. Server-side: pagination, category
   * (optionally including descendants), producer, collection, code/EAN, active
   * flag, date windows, id whitelist, text search and name/price/date sorts.
   * Client-side: description-length, image-count, missing-ALT and price-range
   * filters (Shoper exposes no server filters for those).
   */
  async getProducts(query: ProductQuery = {}): Promise<ProductListPage> {
    const filters = await this.buildProductFilters(query);
    const limit = Math.min(Math.max(1, query.limit ?? MAX_PAGE_LIMIT), MAX_PAGE_LIMIT);

    const res = await this.request<ShoperListResponse<ShoperProduct>>("GET", "/products", {
      query: {
        limit,
        page: Math.max(1, query.page ?? 1),
        filters: Object.keys(filters).length > 0 ? JSON.stringify(filters) : undefined,
        order: shoperOrder(query.sort),
      },
    });

    const raw = res?.list ?? [];
    let summaries = raw.map((p) => this.toSummary(p));
    const before = summaries.length;

    if (query.maxDescriptionLength !== undefined) {
      const max = query.maxDescriptionLength;
      summaries = summaries.filter((s) => s.description_length < max);
    }
    if (query.priceFrom !== undefined) {
      const from = query.priceFrom;
      summaries = summaries.filter((s) => s.price !== undefined && s.price >= from);
    }
    if (query.priceTo !== undefined) {
      const to = query.priceTo;
      summaries = summaries.filter((s) => s.price !== undefined && s.price <= to);
    }

    // Image-derived filters need the image rows. One batched
    // `product_id IN (...)` read covers the whole page instead of N requests.
    if (query.maxImages !== undefined || query.missingAltText) {
      const imagesByProduct = await this.getProductImagesForProducts(
        summaries.map((s) => s.product_id)
      ).catch(() => new Map<number, ShoperProductImage[]>());
      const kept: ProductSummary[] = [];
      for (const s of summaries) {
        const images = imagesByProduct.get(s.product_id) ?? [];
        const visible = images.filter((i) => !isTruthy(i.hidden));
        const missingAlt = visible.filter((i) => !this.imageAlt(i)).length;
        const row: ProductSummary = {
          ...s,
          image_count: visible.length,
          missing_alt_count: missingAlt,
        };
        if (query.maxImages !== undefined && visible.length >= query.maxImages) continue;
        if (query.missingAltText && missingAlt === 0) continue;
        kept.push(row);
      }
      summaries = kept;
    }

    // Sorts Shoper cannot express server-side are applied to the page.
    if (query.sort === "images_asc") {
      summaries = [...summaries].sort((a, b) => a.image_count - b.image_count);
    } else if (query.sort === "desc_asc") {
      summaries = [...summaries].sort(
        (a, b) => a.description_length - b.description_length
      );
    }

    if (!query.skipCategoryNames) {
      const [flat, producers, currency] = await Promise.all([
        this.categoryIndex().catch(() => undefined),
        this.producerNameMap().catch(() => undefined),
        this.defaultCurrencyCode().catch(() => undefined),
      ]);
      summaries = summaries.map((s) => {
        const node = s.category_id !== undefined ? flat?.get(s.category_id) : undefined;
        return {
          ...s,
          category_name: node?.name ?? s.category_name,
          category_path: node?.path_label ?? s.category_path,
          producer_name:
            s.producer_id !== undefined ? producers?.get(s.producer_id) : undefined,
          currency: currency ?? s.currency,
        };
      });
    }

    return {
      products: summaries,
      page: Number(res?.page ?? 1),
      pages: Number(res?.pages ?? 1),
      count: Number(res?.count ?? summaries.length),
      filtered: summaries.length !== before,
    };
  }

  /**
   * Resolve every product matching a query (all pages), applying the same
   * client-side filters as getProducts. Bounded by `max`.
   */
  async findAllProducts(query: ProductQuery = {}, max = 5000): Promise<ProductSummary[]> {
    const out: ProductSummary[] = [];
    const pageSize = MAX_PAGE_LIMIT;
    let page = 1;
    for (;;) {
      const result = await this.getProducts({
        ...query,
        limit: pageSize,
        page,
        skipCategoryNames: true,
      });
      out.push(...result.products);
      if (out.length >= max) break;
      if (page >= result.pages || result.pages === 0) break;
      page += 1;
      if (page > 400) break; // 400 * 50 = 20k hard stop
    }
    return out.slice(0, max);
  }

  /**
   * Async iterator over every product summary matching a query, page by page.
   * Cheaper than findAllProducts for large catalogues because the caller can
   * process (and discard) each page instead of buffering all of them.
   */
  async *iterateProducts(
    query: ProductQuery = {},
    max = 20_000
  ): AsyncGenerator<ProductSummary[], void, void> {
    let page = 1;
    let emitted = 0;
    for (;;) {
      const result = await this.getProducts({
        ...query,
        limit: MAX_PAGE_LIMIT,
        page,
        skipCategoryNames: query.skipCategoryNames ?? true,
      });
      if (result.products.length > 0) {
        emitted += result.products.length;
        yield result.products;
      }
      if (emitted >= max) return;
      if (result.pages === 0 || page >= result.pages) return;
      page += 1;
      if (page > 400) return;
    }
  }

  /**
   * Total number of products matching the server-side portion of a query.
   * Client-side filters (description length, image count, ALT text) cannot be
   * counted without a full scan, so this is the pre-filter total.
   */
  async countProducts(query: ProductQuery = {}): Promise<number> {
    const filters = await this.buildProductFilters(query);
    const res = await this.request<ShoperListResponse<ShoperProduct>>("GET", "/products", {
      query: {
        limit: 1,
        page: 1,
        filters: Object.keys(filters).length > 0 ? JSON.stringify(filters) : undefined,
      },
    });
    return Number(res?.count ?? 0);
  }

  async getProduct(productId: number): Promise<ShoperProduct> {
    const product = await this.request<ShoperProduct>("GET", `/products/${productId}`);
    if (!product || product.product_id === undefined) {
      throw new ShoperNotFound(`Shoper product ${productId} not found`);
    }
    return product;
  }

  /**
   * Fetch several products, tolerating individual failures.
   *
   * Detail reads go one-by-one on purpose: Shoper's /products collection omits
   * some expanded structures (notably `attributes`) that product_context needs,
   * so a batched list call would silently degrade prompt quality.
   */
  async getProductsByIds(ids: readonly number[]): Promise<Map<number, ShoperProduct>> {
    const out = new Map<number, ShoperProduct>();
    for (const id of ids) {
      try {
        out.set(id, await this.getProduct(id));
      } catch (err) {
        this.log({
          level: "warn",
          msg: `skipping product ${id}: ${err instanceof Error ? err.message : String(err)}`,
        });
      }
    }
    return out;
  }

  /**
   * Resolve normalised summaries for an explicit id list in as few requests as
   * possible (server-side `product_id IN (...)`, chunked to keep the query
   * string sane). Used by the picker to render "selected products".
   */
  async getProductSummariesByIds(ids: readonly number[]): Promise<ProductSummary[]> {
    const unique = [...new Set(ids.map(Number).filter((n) => Number.isFinite(n) && n > 0))];
    if (unique.length === 0) return [];
    const out: ProductSummary[] = [];
    for (const group of chunkNumbers(unique, MAX_PAGE_LIMIT)) {
      const res = await this.request<ShoperListResponse<ShoperProduct>>("GET", "/products", {
        query: {
          limit: MAX_PAGE_LIMIT,
          page: 1,
          filters: JSON.stringify({ product_id: { in: group } }),
        },
      });
      for (const product of res?.list ?? []) out.push(this.toSummary(product));
    }
    const order = new Map(unique.map((id, index) => [id, index]));
    return out.sort(
      (a, b) => (order.get(a.product_id) ?? 0) - (order.get(b.product_id) ?? 0)
    );
  }

  /**
   * Update translated fields on a product. Only the supplied fields are
   * written — Shoper merges the translations object. Passing `locales` writes
   * the same values to several locales at once.
   */
  async updateProductTranslations(
    productId: number,
    fields: ShoperTranslationPatch,
    locale: string = this.locale
  ): Promise<void> {
    const clean = pruneUndefined(fields);
    if (Object.keys(clean).length === 0) return;
    await this.request<unknown>("PUT", `/products/${productId}`, {
      body: { translations: { [locale]: clean } },
    });
  }

  async updateProductTranslationsMulti(
    productId: number,
    perLocale: Record<string, ShoperTranslationPatch>
  ): Promise<void> {
    const translations: Record<string, ShoperTranslationPatch> = {};
    for (const [locale, fields] of Object.entries(perLocale)) {
      const clean = pruneUndefined(fields);
      if (Object.keys(clean).length > 0) translations[locale] = clean;
    }
    if (Object.keys(translations).length === 0) return;
    await this.request<unknown>("PUT", `/products/${productId}`, { body: { translations } });
  }

  /** Generic product PUT (non-translated fields, e.g. producer_id). */
  async updateProduct(productId: number, patch: Record<string, unknown>): Promise<void> {
    const clean = pruneUndefined(patch);
    if (Object.keys(clean).length === 0) return;
    await this.request<unknown>("PUT", `/products/${productId}`, { body: clean });
  }

  /** Read every translation locale present on a product. */
  async getProductTranslations(
    productId: number
  ): Promise<Record<string, ShoperProductTranslation>> {
    const product = await this.getProduct(productId);
    return (product.translations as Record<string, ShoperProductTranslation>) ?? {};
  }

  /** Read one locale's translation record (undefined when absent). */
  async getProductTranslation(
    productId: number,
    locale: string = this.locale
  ): Promise<ShoperProductTranslation | undefined> {
    const all = await this.getProductTranslations(productId);
    return all[locale];
  }

  /** Locales that actually carry a name for this product. */
  async getProductLocales(productId: number): Promise<string[]> {
    const all = await this.getProductTranslations(productId);
    return Object.entries(all)
      .filter(([, t]) => typeof t?.name === "string" && String(t.name).trim() !== "")
      .map(([locale]) => locale)
      .sort();
  }

  /** Replace the product's category assignment (main + additional). */
  async setProductCategories(
    productId: number,
    mainCategoryId: number,
    additionalCategoryIds: readonly number[] = []
  ): Promise<void> {
    const categories = [
      ...new Set([mainCategoryId, ...additionalCategoryIds].filter((n) => Number.isFinite(n))),
    ];
    await this.updateProduct(productId, {
      category_id: mainCategoryId,
      categories,
    });
  }

  /* ---------------------------------------------------------------- */
  /* Product images                                                    */
  /* ---------------------------------------------------------------- */

  async getProductImages(productId: number): Promise<ShoperProductImage[]> {
    const images = await this.collectAll<ShoperProductImage>(
      "/product-images",
      { filters: JSON.stringify({ product_id: productId }) },
      500
    );
    return images.sort((a, b) => Number(a.order ?? 0) - Number(b.order ?? 0));
  }

  /** One image by gfx_id (undefined when it no longer exists). */
  async getProductImage(gfxId: number): Promise<ShoperProductImage | undefined> {
    return this.request<ShoperProductImage | undefined>(
      "GET",
      `/product-images/${gfxId}`,
      { allow404: true, noCache: true }
    );
  }

  /** Images grouped per product id in one pass (bulk ALT-text scans). */
  async getProductImagesForProducts(
    productIds: readonly number[]
  ): Promise<Map<number, ShoperProductImage[]>> {
    const out = new Map<number, ShoperProductImage[]>();
    const unique = [...new Set(productIds.map(Number).filter((n) => Number.isFinite(n)))];
    if (unique.length === 0) return out;
    for (const id of unique) out.set(id, []);
    for (const group of chunkNumbers(unique, MAX_PAGE_LIMIT)) {
      const images = await this.collectAll<ShoperProductImage>(
        "/product-images",
        { filters: JSON.stringify({ product_id: { in: group } }) },
        5000
      );
      for (const image of images) {
        const productId = Number(image.product_id);
        const bucket = out.get(productId);
        if (bucket) bucket.push(image);
      }
    }
    for (const bucket of out.values()) {
      bucket.sort((a, b) => Number(a.order ?? 0) - Number(b.order ?? 0));
    }
    return out;
  }

  /** Localised ALT text ("name" on the image translation), if any. */
  imageAlt(image: ShoperProductImage): string | undefined {
    const t = this.pickTranslation(image.translations);
    const alt = t?.name;
    return typeof alt === "string" && alt.trim() !== "" ? alt : undefined;
  }

  /**
   * Add an image to a product from a base64 payload (Shoper's POST
   * /product-images expects `content`, not a URL). Returns the new gfx_id.
   */
  async addProductImageBase64(
    productId: number,
    base64: string,
    options: {
      name: string;
      altText?: string;
      /** `title` attribute on the storefront <img> (tooltip text). */
      title?: string;
      main?: boolean;
      order?: number;
      locale?: string;
      /** Mirror the same ALT/title into these extra locales. */
      extraLocales?: readonly string[];
    }
  ): Promise<number> {
    const body: Record<string, unknown> = {
      product_id: productId,
      name: options.name,
      content: base64,
    };
    if (options.main !== undefined) body["main"] = options.main ? 1 : 0;
    if (options.order !== undefined) body["order"] = options.order;
    if (options.altText || options.title) {
      const entry: Record<string, string> = {};
      if (options.altText) entry["name"] = options.altText;
      if (options.title) entry["title"] = options.title;
      const locales = [
        options.locale ?? this.locale,
        ...(options.extraLocales ?? []),
      ].filter((l, i, arr) => l && arr.indexOf(l) === i);
      const translations: Record<string, Record<string, string>> = {};
      for (const locale of locales) translations[locale] = { ...entry };
      body["translations"] = translations;
    }

    const created = await this.request<number | string | { gfx_id?: number | string }>(
      "POST",
      "/product-images",
      { body }
    );
    const gfxId =
      typeof created === "object" && created !== null
        ? Number(created.gfx_id ?? 0)
        : Number(created);
    if (!Number.isFinite(gfxId) || gfxId <= 0) {
      throw new ShoperApiError(
        `Shoper accepted the image but returned no gfx_id (${JSON.stringify(created)?.slice(0, 120)})`,
        502,
        created
      );
    }
    return gfxId;
  }

  /** Update the translated ALT text ("name") of an existing product image. */
  async updateProductImageAlt(
    gfxId: number,
    altText: string,
    locale: string = this.locale,
    title?: string
  ): Promise<void> {
    const entry: Record<string, string> = { name: altText };
    if (title) entry["title"] = title;
    await this.request<unknown>("PUT", `/product-images/${gfxId}`, {
      body: { translations: { [locale]: entry } },
    });
  }

  async updateProductImage(gfxId: number, patch: Record<string, unknown>): Promise<void> {
    const clean = pruneUndefined(patch);
    if (Object.keys(clean).length === 0) return;
    await this.request<unknown>("PUT", `/product-images/${gfxId}`, { body: clean });
  }

  async deleteProductImage(gfxId: number): Promise<void> {
    await this.request<unknown>("DELETE", `/product-images/${gfxId}`);
  }

  /** Promote an image to the product's main image. */
  async setMainProductImage(gfxId: number): Promise<void> {
    await this.updateProductImage(gfxId, { main: 1 });
  }

  /** Reorder images: the supplied gfx_id sequence becomes order 0..n-1. */
  async reorderProductImages(gfxIds: readonly number[]): Promise<void> {
    for (let i = 0; i < gfxIds.length; i += 1) {
      const id = gfxIds[i];
      if (id === undefined) continue;
      await this.updateProductImage(id, { order: i });
    }
  }

  /* ---------------------------------------------------------------- */
  /* Variants (product-stocks + options)                               */
  /* ---------------------------------------------------------------- */

  /** Normalised variants of a product, with human-readable option labels. */
  async getProductVariants(productId: number): Promise<ProductVariant[]> {
    const stocks = await this.collectAll<ShoperStock>(
      "/product-stocks",
      { filters: JSON.stringify({ product_id: productId }) },
      500
    );
    if (stocks.length === 0) return [];
    const labels = await this.optionLabels().catch(() => undefined);

    return stocks.map((stock) => {
      const options: Record<string, string> = {};
      const raw = stock.option;
      if (raw && typeof raw === "object") {
        for (const [optionId, valueId] of Object.entries(raw)) {
          const optionName = labels?.options.get(Number(optionId)) ?? `option_${optionId}`;
          const valueName = labels?.values.get(Number(valueId)) ?? String(valueId);
          options[optionName] = valueName;
        }
      }
      return {
        stock_id: Number(stock.stock_id ?? 0),
        product_id: Number(stock.product_id ?? productId),
        sku: stock.sku ?? stock.code,
        ean: stock.ean,
        price: stock.price !== undefined ? Number(stock.price) : undefined,
        stock: stock.stock !== undefined ? Number(stock.stock) : undefined,
        active: isTruthy(stock.active) || stock.active === undefined,
        options,
      };
    });
  }

  /** Raw product-stocks rows (variant write paths need the unnormalised shape). */
  async getProductStocks(productId: number): Promise<ShoperStock[]> {
    return this.collectAll<ShoperStock>(
      "/product-stocks",
      { filters: JSON.stringify({ product_id: productId }) },
      500
    );
  }

  /** Patch one variant row (price/stock/sku/active). */
  async updateProductStock(stockId: number, patch: Record<string, unknown>): Promise<void> {
    const clean = pruneUndefined(patch);
    if (Object.keys(clean).length === 0) return;
    await this.request<unknown>("PUT", `/product-stocks/${stockId}`, { body: clean });
  }

  /** All options defined in the store (variant axes). */
  async getOptions(): Promise<Array<{ option_id: number; name: string }>> {
    const raw = await this.collectAll<ShoperOption>("/options", {}, 2000);
    return raw.map((o) => ({
      option_id: Number(o.option_id),
      name: this.pickTranslation(o.translations)?.name ?? `option_${o.option_id}`,
    }));
  }

  /** All option values, grouped by their parent option id. */
  async getOptionValues(): Promise<
    Array<{ value_id: number; option_id?: number; label: string }>
  > {
    const raw = await this.collectAll<ShoperOptionValue>("/option-values", {}, 20_000);
    return raw.map((v) => {
      const t = this.pickTranslation(
        v.translations as Record<string, { name?: string; value?: string }> | undefined
      );
      const entry: { value_id: number; option_id?: number; label: string } = {
        value_id: Number(v.value_id),
        label: t?.value ?? t?.name ?? String(v.value_id),
      };
      if (v.option_id !== undefined) entry.option_id = Number(v.option_id);
      return entry;
    });
  }

  /** option_id -> name and value_id -> label maps (cached). */
  async optionLabels(): Promise<{ options: Map<number, string>; values: Map<number, string> }> {
    const now = Date.now();
    if (this.optionCache && now - this.optionCache.at < LOOKUP_CACHE_MS) {
      return { options: this.optionCache.options, values: this.optionCache.values };
    }
    const [options, values] = await Promise.all([
      this.collectAll<ShoperOption>("/options", {}, 2000),
      this.collectAll<ShoperOptionValue>("/option-values", {}, 20_000),
    ]);
    const optionMap = new Map<number, string>();
    for (const o of options) {
      const t = this.pickTranslation(o.translations);
      optionMap.set(Number(o.option_id), t?.name ?? `option_${o.option_id}`);
    }
    const valueMap = new Map<number, string>();
    for (const v of values) {
      const t = this.pickTranslation(
        v.translations as Record<string, { name?: string; value?: string }> | undefined
      );
      valueMap.set(Number(v.value_id), t?.value ?? t?.name ?? String(v.value_id));
    }
    this.optionCache = { at: Date.now(), options: optionMap, values: valueMap };
    return { options: optionMap, values: valueMap };
  }

  /* ---------------------------------------------------------------- */
  /* Categories                                                        */
  /* ---------------------------------------------------------------- */

  /** Flat list of categories, cheapest form (id + name). */
  async getCategories(): Promise<Array<{ category_id: number; name: string }>> {
    const tree = await this.categoryTree();
    return flattenTree(tree).map((n) => ({ category_id: n.category_id, name: n.name }));
  }

  /** Full category tree with ancestor paths, cached for 5 minutes. */
  async categoryTree(): Promise<CategoryNode[]> {
    const now = Date.now();
    if (this.categoryCache && now - this.categoryCache.at < CATEGORY_CACHE_MS) {
      return this.categoryCache.nodes;
    }
    if (!this.categoryCachePending) {
      this.categoryCachePending = this.loadCategoryTree().finally(() => {
        this.categoryCachePending = undefined;
      });
    }
    return this.categoryCachePending;
  }

  private async loadCategoryTree(): Promise<CategoryNode[]> {
    const raw = await this.collectAll<ShoperCategory>("/categories", {}, 20_000);
    const nodes = new Map<number, CategoryNode>();
    for (const c of raw) {
      const id = Number(c.category_id);
      if (!Number.isFinite(id)) continue;
      const parentRaw = c.parent_id;
      const parent =
        parentRaw === null || parentRaw === undefined || Number(parentRaw) === 0
          ? null
          : Number(parentRaw);
      nodes.set(id, {
        category_id: id,
        parent_id: parent,
        name: this.pickTranslation(c.translations)?.name ?? String(id),
        path: [],
        path_label: "",
        depth: 0,
        children: [],
      });
    }

    const roots: CategoryNode[] = [];
    for (const node of nodes.values()) {
      const parent = node.parent_id !== null ? nodes.get(node.parent_id) : undefined;
      if (parent) parent.children.push(node);
      else roots.push(node);
    }

    // Compute paths iteratively (guards against cyclic parent references).
    const stack: CategoryNode[] = [...roots];
    const seen = new Set<number>();
    while (stack.length > 0) {
      const node = stack.pop() as CategoryNode;
      if (seen.has(node.category_id)) continue;
      seen.add(node.category_id);
      const parent = node.parent_id !== null ? nodes.get(node.parent_id) : undefined;
      node.path = parent && parent.path.length > 0 ? [...parent.path, node.name] : [node.name];
      node.path_label = node.path.join(" > ");
      node.depth = node.path.length - 1;
      for (const child of node.children) stack.push(child);
    }
    // Orphans (parent id points nowhere) still need a path.
    for (const node of nodes.values()) {
      if (node.path.length === 0) {
        node.path = [node.name];
        node.path_label = node.name;
      }
    }

    const sortRec = (list: CategoryNode[]): void => {
      list.sort((a, b) => a.name.localeCompare(b.name));
      for (const n of list) sortRec(n.children);
    };
    sortRec(roots);

    this.categoryCache = { at: Date.now(), nodes: roots, flat: nodes };
    return roots;
  }

  /** category_id -> node lookup (cached). */
  async categoryIndex(): Promise<Map<number, CategoryNode>> {
    await this.categoryTree();
    return this.categoryCache?.flat ?? new Map();
  }

  /** category_id -> name lookup (cached). */
  async categoryNameMap(): Promise<Map<number, string>> {
    const index = await this.categoryIndex();
    const out = new Map<number, string>();
    for (const [id, node] of index) out.set(id, node.name);
    return out;
  }

  /** "Home > Shoes > Sneakers" for one category id. */
  async categoryPath(categoryId: number): Promise<string | undefined> {
    const index = await this.categoryIndex();
    return index.get(categoryId)?.path_label;
  }

  /** A category id plus every descendant id. */
  async categoryWithDescendants(categoryId: number): Promise<number[]> {
    const index = await this.categoryIndex();
    const root = index.get(categoryId);
    if (!root) return [categoryId];
    const out: number[] = [];
    const stack: CategoryNode[] = [root];
    while (stack.length > 0) {
      const node = stack.pop() as CategoryNode;
      out.push(node.category_id);
      for (const child of node.children) stack.push(child);
      if (out.length > 5000) break;
    }
    return out;
  }

  /* ---------------------------------------------------------------- */
  /* Producers, attributes, collections, tax, currency                 */
  /* ---------------------------------------------------------------- */

  async getProducers(): Promise<Array<{ producer_id: number; name: string }>> {
    const raw = await this.collectAll<ShoperProducer>("/producers", {}, 5000);
    return raw.map((p) => ({
      producer_id: Number(p.producer_id),
      name: this.pickTranslation(p.translations)?.name ?? p.name ?? String(p.producer_id),
    }));
  }

  async producerNameMap(): Promise<Map<number, string>> {
    const now = Date.now();
    if (this.producerCache && now - this.producerCache.at < LOOKUP_CACHE_MS) {
      return this.producerCache.map;
    }
    const list = await this.getProducers();
    const map = new Map<number, string>();
    for (const p of list) map.set(p.producer_id, p.name);
    this.producerCache = { at: Date.now(), map };
    return map;
  }

  /** attribute_id -> {name, group} lookup for flattening product attributes. */
  async getAttributes(): Promise<
    Array<{ attribute_id: number; group_id?: number; name: string; group?: string }>
  > {
    const [groups, attributes] = await Promise.all([
      this.collectAll<ShoperAttributeGroup>("/attribute-groups", {}, 2000),
      this.collectAll<ShoperAttribute>("/attributes", {}, 20_000),
    ]);
    const groupNames = new Map<number, string>();
    for (const g of groups) {
      groupNames.set(
        Number(g.group_id),
        this.pickTranslation(g.translations)?.name ?? String(g.group_id)
      );
    }
    return attributes.map((a) => {
      const groupId = a.group_id !== undefined ? Number(a.group_id) : undefined;
      const entry: {
        attribute_id: number;
        group_id?: number;
        name: string;
        group?: string;
      } = {
        attribute_id: Number(a.attribute_id),
        name: this.pickTranslation(a.translations)?.name ?? String(a.attribute_id),
      };
      if (groupId !== undefined) {
        entry.group_id = groupId;
        const groupName = groupNames.get(groupId);
        if (groupName !== undefined) entry.group = groupName;
      }
      return entry;
    });
  }

  /** Attribute groups (the "parameter set" a product's attributes belong to). */
  async getAttributeGroups(): Promise<Array<{ group_id: number; name: string }>> {
    const raw = await this.collectAll<ShoperAttributeGroup>("/attribute-groups", {}, 2000);
    return raw.map((g) => ({
      group_id: Number(g.group_id),
      name: this.pickTranslation(g.translations)?.name ?? String(g.group_id),
    }));
  }

  /** attribute_id -> label ("Group / Name" when the group is known), cached. */
  async attributeLabelMap(): Promise<Map<number, string>> {
    const now = Date.now();
    if (this.attributeCache && now - this.attributeCache.at < LOOKUP_CACHE_MS) {
      return this.attributeCache.map;
    }
    const attributes = await this.getAttributes();
    const map = new Map<number, string>();
    for (const attribute of attributes) {
      map.set(
        attribute.attribute_id,
        attribute.group ? `${attribute.group} / ${attribute.name}` : attribute.name
      );
    }
    this.attributeCache = { at: Date.now(), map };
    return map;
  }

  async getCollections(): Promise<Array<{ collection_id: number; name: string }>> {
    const raw = await this.collectAll<ShoperCollection>("/collections", {}, 5000);
    return raw.map((c) => ({
      collection_id: Number(c.collection_id),
      name: this.pickTranslation(c.translations)?.name ?? String(c.collection_id),
    }));
  }

  async getTaxes(): Promise<ShoperTax[]> {
    return this.collectAll<ShoperTax>("/taxes", {}, 200);
  }

  /** tax_id -> VAT rate as a percentage (cached). */
  async taxRateMap(): Promise<Map<number, number>> {
    const now = Date.now();
    if (this.taxCache && now - this.taxCache.at < LOOKUP_CACHE_MS) return this.taxCache.map;
    const map = new Map<number, number>();
    try {
      for (const tax of await this.getTaxes()) {
        const rate = Number(tax.value);
        if (Number.isFinite(rate)) map.set(Number(tax.tax_id), rate);
      }
    } catch {
      /* tax data is decorative here; an empty map is fine */
    }
    this.taxCache = { at: Date.now(), map };
    return map;
  }

  async getCurrencies(): Promise<ShoperCurrency[]> {
    return this.collectAll<ShoperCurrency>("/currencies", {}, 200);
  }

  /** ISO code of the store's default currency (cached, defaults to PLN). */
  async defaultCurrencyCode(): Promise<string> {
    const now = Date.now();
    if (this.currencyCache && now - this.currencyCache.at < LOOKUP_CACHE_MS) {
      return this.currencyCache.code;
    }
    let code = "PLN";
    try {
      const currencies = await this.getCurrencies();
      const def = currencies.find((c) => isTruthy(c.is_default)) ?? currencies[0];
      const candidate = def?.code ?? def?.name ?? def?.title;
      if (typeof candidate === "string" && candidate.trim() !== "") code = candidate.trim();
    } catch {
      /* keep the PLN default */
    }
    this.currencyCache = { at: Date.now(), code };
    return code;
  }

  /* ---------------------------------------------------------------- */
  /* Helpers                                                           */
  /* ---------------------------------------------------------------- */

  /** Public image URL for a Shoper CDN image. */
  imageUrl(image: ShoperProductImage): string | undefined {
    const file = image.unic_name ?? image.name;
    if (!file) return undefined;
    return `${this.storeUrl}/userdata/public/gfx/${image.gfx_id}/${file}`;
  }

  private pickTranslation<T extends Record<string, unknown>>(
    translations?: Record<string, T>
  ): T | undefined {
    if (!translations) return undefined;
    return (
      translations[this.locale] ??
      translations[DEFAULT_LOCALE] ??
      Object.values(translations)[0]
    );
  }

  /** Localised translation record of a product (falls back across locales). */
  productTranslation(product: ShoperProduct): ShoperProductTranslation | undefined {
    return this.pickTranslation(
      product.translations as Record<string, ShoperProductTranslation> | undefined
    );
  }

  toSummary(p: ShoperProduct): ProductSummary {
    const t = this.productTranslation(p);
    const description = stripHtml(String(t?.description ?? ""));
    const shortDescription = stripHtml(String(t?.short_description ?? ""));
    const mainImage = p.main_image ?? undefined;
    const summary: ProductSummary = {
      product_id: Number(p.product_id),
      name: t?.name ?? p.code ?? String(p.product_id),
      description_length: description.length,
      short_description_length: shortDescription.length,
      image_count: mainImage ? 1 : 0,
    };
    const sku = p.stock?.sku ?? p.code;
    if (sku) summary.sku = String(sku);
    if (p.ean) summary.ean = String(p.ean);
    if (p.stock?.price !== undefined) summary.price = Number(p.stock.price);
    if (p.category_id !== undefined && p.category_id !== null) {
      summary.category_id = Number(p.category_id);
    }
    if (p.producer_id !== undefined && p.producer_id !== null) {
      summary.producer_id = Number(p.producer_id);
    }
    if (mainImage) {
      const url = this.imageUrl(mainImage);
      if (url) summary.thumbnail = url;
    }
    if (p.stock?.active !== undefined) summary.active = isTruthy(p.stock.active);
    if (p.edit_date) summary.edit_date = String(p.edit_date);
    return summary;
  }
}

/* -------------------------------------------------------------------- */
/* Module helpers                                                        */
/* -------------------------------------------------------------------- */

const HTML_ENTITIES: Record<string, string> = {
  "&nbsp;": " ",
  "&amp;": "&",
  "&lt;": "<",
  "&gt;": ">",
  "&quot;": '"',
  "&#39;": "'",
  "&apos;": "'",
  "&hellip;": "…",
  "&ndash;": "-",
  "&mdash;": "-",
};

/** Strip HTML tags/entities and collapse whitespace. */
export function stripHtml(html: string): string {
  return html
    .replace(/<(script|style)[\s\S]*?<\/\1>/gi, " ")
    .replace(/<br\s*\/?>/gi, " ")
    .replace(/<\/(p|div|li|tr|h[1-6])>/gi, " ")
    .replace(/<[^>]*>/g, " ")
    .replace(/&#(\d+);/g, (_m, code: string) => {
      const n = Number(code);
      return Number.isFinite(n) && n > 0 && n < 0x10ffff ? String.fromCodePoint(n) : " ";
    })
    .replace(/&[a-z#0-9]+;/gi, (entity) => HTML_ENTITIES[entity.toLowerCase()] ?? " ")
    .replace(/\s+/g, " ")
    .trim();
}

export function isTruthy(v: unknown): boolean {
  return v === true || v === 1 || v === "1" || v === "true";
}

/** Escape SQL-LIKE wildcards inside a user-supplied search term. */
export function escapeLike(term: string): string {
  return term.replace(/[%_\\]/g, (m) => `\\${m}`);
}

/** Split a numeric id list into chunks small enough for one `IN (...)` filter. */
function chunkNumbers(ids: readonly number[], size: number): number[][] {
  const limit = Math.max(1, Math.floor(size));
  const out: number[][] = [];
  for (let i = 0; i < ids.length; i += limit) {
    out.push(ids.slice(i, i + limit) as number[]);
  }
  return out;
}

function pruneUndefined<T extends Record<string, unknown>>(input: T): Partial<T> {
  const out: Record<string, unknown> = {};
  for (const [key, value] of Object.entries(input)) {
    if (value !== undefined) out[key] = value;
  }
  return out as Partial<T>;
}

function extractErrorDetail(body: unknown): string | undefined {
  if (!body || typeof body !== "object") return undefined;
  const record = body as Record<string, unknown>;
  for (const key of ["error_description", "error", "message", "detail"]) {
    const value = record[key];
    if (typeof value === "string" && value.trim() !== "") return value;
  }
  return undefined;
}

function flattenTree(nodes: readonly CategoryNode[]): CategoryNode[] {
  const out: CategoryNode[] = [];
  const stack = [...nodes];
  while (stack.length > 0) {
    const node = stack.pop() as CategoryNode;
    out.push(node);
    for (const child of node.children) stack.push(child);
  }
  return out.sort((a, b) => a.path_label.localeCompare(b.path_label));
}
