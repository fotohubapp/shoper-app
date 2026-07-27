#!/usr/bin/env node
/**
 * FOTOhub AI for Shoper — admin server.
 *
 * Express app serving:
 *  - the JSON API consumed by the SPA in public/ (product picker, presets,
 *    estimate, jobs, drafts, credits, health, i18n),
 *  - the bridge webhook receiver (src/webhook.ts),
 *  - the static UI (public/), embeddable as an iframe in the Shoper admin.
 *
 * Env:
 *  PORT                    default 8811
 *  HOST                    default 127.0.0.1
 *  SHOPER_STORE_URL        e.g. https://sklep123456.shoparena.pl
 *  SHOPER_ACCESS_TOKEN     pre-issued webapi token (private app), OR:
 *  SHOPER_LOGIN            webapi user login
 *  SHOPER_PASSWORD         webapi user password
 *  FOTOHUB_API_KEY         fh_live_* key
 *  FOTOHUB_CONFIG_SECRET   passphrase for the encrypted config store
 *  PUBLIC_URL              externally reachable base URL (webhook callbacks)
 *  DATA_DIR                where the SQLite DB lives (default ./data)
 *  ADMIN_TOKEN             shared secret required on /api (optional)
 *  TRUST_PROXY             "1" when behind a reverse proxy (X-Forwarded-For)
 *
 * Values entered through the connection wizard are stored encrypted in
 * SQLite and take precedence over env values.
 */

import { randomBytes, timingSafeEqual } from "crypto";
import express, { NextFunction, Request, Response } from "express";
import { join } from "path";
import { CommerceBridgeClient } from "./bridge-client";
import { DraftStore } from "./draft-store";
import { FixedWindowRateLimiter } from "./http";
import { getStrings } from "./i18n";
import { summariseVariants } from "./product-context";
import { ShoperClient } from "./shoper-client";
import { collectJobDrafts, createWebhookRouter } from "./webhook";
import {
  DEFAULT_IMAGE_MODEL,
  IMAGE_MODELS,
  InsufficientCreditsError,
  JobItemInput,
  JobKind,
  JobOptions,
  JobStatus,
  PRODUCT_SORTS,
  PresetCategory,
  ProductContext,
  ProductSort,
  ShoperPermissionError,
  ShoperProductTranslation,
  TONES,
} from "./types";

const PORT = Number(process.env["PORT"] ?? 8811);
const HOST = process.env["HOST"] ?? "127.0.0.1";
const PUBLIC_DIR = join(__dirname, "..", "public");
const DATA_DIR = process.env["DATA_DIR"] ?? join(process.cwd(), "data");
const TRUST_PROXY = process.env["TRUST_PROXY"] === "1";
const LOW_BALANCE_THRESHOLD = 50;
const MISSING_DESCRIPTION_MAX = 20;

/* -------------------------------------------------------------------- */
/* Rate limiting                                                         */
/* -------------------------------------------------------------------- */

export const RATE_LIMIT_WINDOW_MS = 60_000;
/**
 * Per-IP budgets per minute. A mutation costs a Shoper round trip or FOTOhub
 * credits, so it is far scarcer than a read. Submitting jobs and approving
 * drafts are metered hardest because each one spends real money.
 */
export const RATE_LIMITS = {
  /** Anything that spends credits or writes to the live store. */
  spend: 20,
  /** Connection wizard / disconnect: rare, and each one hits two APIs. */
  connect: 10,
  /** Other mutations (settings, language, preset default). */
  mutation: 60,
} as const;

const spendLimiter = new FixedWindowRateLimiter({
  windowMs: RATE_LIMIT_WINDOW_MS,
  max: RATE_LIMITS.spend,
});
const connectLimiter = new FixedWindowRateLimiter({
  windowMs: RATE_LIMIT_WINDOW_MS,
  max: RATE_LIMITS.connect,
});
const mutationLimiter = new FixedWindowRateLimiter({
  windowMs: RATE_LIMIT_WINDOW_MS,
  max: RATE_LIMITS.mutation,
});

/**
 * Which bucket a mutating path draws from. Ordered longest-prefix-first so
 * /api/jobs/:id/cancel is classified before the bare /api/jobs prefix.
 */
export function limiterFor(path: string): FixedWindowRateLimiter {
  if (path === "/connect" || path === "/disconnect") return connectLimiter;
  if (
    path === "/jobs" ||
    path.endsWith("/retry-failed") ||
    path.startsWith("/drafts/") ||
    path === "/drafts/approve-all"
  ) {
    return spendLimiter;
  }
  return mutationLimiter;
}

/**
 * Client identity for rate limiting. X-Forwarded-For is only honoured when the
 * operator opted in via TRUST_PROXY; otherwise any client could spoof the
 * header and get a fresh bucket per request.
 */
export function clientKey(req: Request): string {
  if (TRUST_PROXY) {
    const forwarded = req.get("x-forwarded-for");
    const first = forwarded?.split(",")[0]?.trim();
    if (first) return first;
  }
  return req.socket.remoteAddress ?? "unknown";
}

/* -------------------------------------------------------------------- */
/* Admin authentication                                                  */
/* -------------------------------------------------------------------- */

/** Constant-time compare that never throws on a length mismatch. */
export function safeEqual(a: string, b: string): boolean {
  const bufA = Buffer.from(a, "utf8");
  const bufB = Buffer.from(b, "utf8");
  if (bufA.length !== bufB.length) return false;
  return timingSafeEqual(bufA, bufB);
}

/**
 * Optional shared-secret gate for the admin API.
 *
 * The per-process CSRF token is handed out by GET /api/status, so it stops a
 * cross-site page but not anyone who can reach the port — binding to 127.0.0.1
 * is a deployment convention, not access control. When ADMIN_TOKEN is set every
 * /api call must present it; when it is unset the previous behaviour is kept
 * and boot logs a warning, because forcing a token on an existing install would
 * lock the merchant out of their own panel on upgrade.
 */
export function readAdminToken(
  env: NodeJS.ProcessEnv = process.env
): string | undefined {
  const raw = env["ADMIN_TOKEN"]?.trim();
  return raw ? raw : undefined;
}

/** Extract the presented admin token from either accepted header form. */
export function presentedAdminToken(req: Request): string | undefined {
  const bearer = req.get("authorization");
  if (bearer && /^Bearer\s+/i.test(bearer)) {
    const value = bearer.replace(/^Bearer\s+/i, "").trim();
    if (value) return value;
  }
  const header = req.get("x-admin-token")?.trim();
  return header ? header : undefined;
}

const TERMINAL_STATUSES: readonly JobStatus[] = [
  "completed",
  "completed_with_errors",
  "failed",
  "cancelled",
];

/**
 * Encryption key for the credential store. There is deliberately no fallback:
 * a default would encrypt every merchant's Shoper password and FOTOhub key
 * with a constant that ships in this public repository, which is the same as
 * storing them in plain text. Refusing to boot is the safe failure.
 */
function requireConfigSecret(): string {
  const secret = process.env["FOTOHUB_CONFIG_SECRET"];
  if (!secret || secret.trim().length < 16) {
    throw new Error(
      "FOTOHUB_CONFIG_SECRET must be set to at least 16 characters. " +
        "It encrypts stored store credentials. Generate one with: " +
        "openssl rand -hex 32"
    );
  }
  return secret;
}

const store = new DraftStore(
  join(DATA_DIR, "fotohub-shoper.sqlite"),
  requireConfigSecret()
);

/**
 * CSRF token for the admin SPA. Generated per process, handed out by
 * GET /api/status and required in the X-CSRF-Token header on every mutating
 * request. A cross-site page can POST but cannot read the token (same-origin
 * policy), so blind CSRF against the connected store is blocked.
 */
const CSRF_TOKEN = randomBytes(24).toString("base64url");

/** Timestamp of the last successful /api/health run, surfaced in Settings. */
let lastHealthCheckAt: string | null = null;

/* -------------------------------------------------------------------- */
/* Client factories (config store overrides env)                         */
/* -------------------------------------------------------------------- */

class HttpError extends Error {
  constructor(public readonly status: number, message: string) {
    super(message);
  }
}

function getFotohubKey(): string | undefined {
  return store.readConfig().fotohubApiKey ?? process.env["FOTOHUB_API_KEY"];
}

function makeBridge(): CommerceBridgeClient {
  const apiKey = getFotohubKey();
  if (!apiKey) throw new HttpError(400, "FOTOhub API key not configured");
  return new CommerceBridgeClient({ apiKey });
}

function shoperCredentials(): {
  storeUrl?: string;
  accessToken?: string;
  login?: string;
  password?: string;
} {
  const cfg = store.readConfig();
  return {
    storeUrl: cfg.shoperStoreUrl ?? process.env["SHOPER_STORE_URL"],
    accessToken: cfg.shoperAccessToken ?? process.env["SHOPER_ACCESS_TOKEN"],
    login: cfg.shoperLogin ?? process.env["SHOPER_LOGIN"],
    password: cfg.shoperPassword ?? process.env["SHOPER_PASSWORD"],
  };
}

let cachedShoper: ShoperClient | undefined;
let cachedShoperKey = "";

function makeShoper(): ShoperClient {
  const creds = shoperCredentials();
  if (!creds.storeUrl || (!creds.accessToken && !(creds.login && creds.password))) {
    throw new HttpError(400, "Shoper credentials not configured");
  }
  // Reuse the client (keeps its bearer token + throttle bucket) until creds change.
  const key = JSON.stringify(creds);
  if (!cachedShoper || cachedShoperKey !== key) {
    cachedShoper = new ShoperClient({
      storeUrl: creds.storeUrl,
      accessToken: creds.accessToken,
      login: creds.login,
      password: creds.password,
    });
    cachedShoperKey = key;
  }
  return cachedShoper;
}

function requireConnectionId(): string {
  const id = store.readConfig().connectionId;
  if (!id) throw new HttpError(400, "Not connected — run the connection wizard first");
  return id;
}

/* -------------------------------------------------------------------- */
/* App                                                                   */
/* -------------------------------------------------------------------- */

const app = express();
app.disable("x-powered-by");

// Webhook first: it needs the raw body for the HMAC check.
app.use(
  createWebhookRouter({
    store,
    getBridge: makeBridge,
    getShoper: makeShoper,
  })
);

app.use(express.json({ limit: "1mb" }));
app.use(express.static(PUBLIC_DIR));

/**
 * Shared-secret gate. Runs before CSRF so an unauthenticated caller learns
 * nothing about the panel's state, not even whether a store is connected.
 */
app.use("/api", (req: Request, res: Response, next: NextFunction) => {
  const expected = readAdminToken();
  if (!expected) {
    next();
    return;
  }
  const presented = presentedAdminToken(req);
  if (!presented || !safeEqual(presented, expected)) {
    res.status(401).json({ error: "admin_token_invalid" });
    return;
  }
  next();
});

// CSRF guard plus per-IP throttle for every state-changing /api call.
app.use("/api", (req: Request, res: Response, next: NextFunction) => {
  if (req.method === "GET" || req.method === "HEAD" || req.method === "OPTIONS") {
    next();
    return;
  }
  if (req.get("x-csrf-token") !== CSRF_TOKEN) {
    res.status(403).json({ error: "csrf_token_invalid" });
    return;
  }
  // req.path is relative to this mount point, so it excludes the /api prefix.
  const verdict = limiterFor(req.path).hit(clientKey(req));
  if (!verdict.allowed) {
    const retryAfterSeconds = Math.max(1, Math.ceil(verdict.resetMs / 1000));
    res
      .status(429)
      .set("Retry-After", String(retryAfterSeconds))
      .json({ error: "rate_limited", retry_after_ms: verdict.resetMs });
    return;
  }
  next();
});

type AsyncHandler = (req: Request, res: Response) => Promise<unknown>;

function wrap(handler: AsyncHandler) {
  return (req: Request, res: Response, next: NextFunction) => {
    handler(req, res)
      .then((result) => {
        if (!res.headersSent) res.json(result);
      })
      .catch(next);
  };
}

/* ---- 1. Connection wizard + status ----------------------------------- */

app.get(
  "/api/status",
  wrap(async () => {
    const cfg = store.readConfig();
    const creds = shoperCredentials();
    return {
      connected: Boolean(cfg.connectionId),
      connection_id: cfg.connectionId ?? null,
      store_name: cfg.storeName ?? null,
      store_url: creds.storeUrl ?? null,
      has_shoper_credentials: Boolean(
        creds.storeUrl && (creds.accessToken || (creds.login && creds.password))
      ),
      has_fotohub_key: Boolean(getFotohubKey()),
      default_preset_slug: cfg.defaultPresetSlug ?? null,
      default_model: cfg.defaultModel ?? DEFAULT_IMAGE_MODEL,
      default_language: cfg.defaultLanguage ?? "pl",
      default_tone: cfg.defaultTone ?? "professional",
      auto_alt_text: cfg.autoAltText === "1",
      onboarding_dismissed: cfg.onboardingDismissed === "1",
      ui_language: cfg.uiLanguage ?? "pl",
      models: IMAGE_MODELS,
      tones: TONES,
      sorts: PRODUCT_SORTS,
      low_balance_threshold: LOW_BALANCE_THRESHOLD,
      missing_description_max: MISSING_DESCRIPTION_MAX,
      last_health_check: lastHealthCheckAt,
      csrf_token: CSRF_TOKEN,
      mcp_url: "https://apis.fotohub.app/mcp/",
    };
  })
);

/**
 * Non-secret UI preferences (defaults for the wizard, onboarding dismissal).
 * Secrets are only ever written through /api/connect.
 */
app.post(
  "/api/settings",
  wrap(async (req) => {
    const b = req.body as {
      default_model?: string;
      default_preset_slug?: string | null;
      default_language?: string;
      default_tone?: string;
      auto_alt_text?: boolean;
      onboarding_dismissed?: boolean;
    };
    const patch: Parameters<DraftStore["writeConfig"]>[0] = {};

    if (b.default_model !== undefined) {
      if (!IMAGE_MODELS.some((m) => m.id === b.default_model)) {
        throw new HttpError(400, "unknown model");
      }
      patch.defaultModel = b.default_model;
    }
    if (b.default_preset_slug !== undefined) {
      patch.defaultPresetSlug = b.default_preset_slug ?? undefined;
    }
    if (b.default_language !== undefined) {
      if (!["pl", "en", "de"].includes(b.default_language)) {
        throw new HttpError(400, "unknown language");
      }
      patch.defaultLanguage = b.default_language;
    }
    if (b.default_tone !== undefined) {
      if (!TONES.includes(b.default_tone as never)) {
        throw new HttpError(400, "unknown tone");
      }
      patch.defaultTone = b.default_tone;
    }
    if (b.auto_alt_text !== undefined) patch.autoAltText = b.auto_alt_text ? "1" : undefined;
    if (b.onboarding_dismissed !== undefined) {
      patch.onboardingDismissed = b.onboarding_dismissed ? "1" : undefined;
    }

    store.writeConfig(patch);
    const cfg = store.readConfig();
    return {
      default_model: cfg.defaultModel ?? DEFAULT_IMAGE_MODEL,
      default_preset_slug: cfg.defaultPresetSlug ?? null,
      default_language: cfg.defaultLanguage ?? "pl",
      default_tone: cfg.defaultTone ?? "professional",
      auto_alt_text: cfg.autoAltText === "1",
      onboarding_dismissed: cfg.onboardingDismissed === "1",
    };
  })
);

/** Validate the stored (or a supplied) FOTOhub key and report the balance. */
app.post(
  "/api/validate-key",
  wrap(async (req) => {
    const b = req.body as { fotohub_api_key?: string };
    const apiKey = b?.fotohub_api_key?.trim() || getFotohubKey();
    if (!apiKey) throw new HttpError(400, "no API key configured");
    try {
      const balance = await new CommerceBridgeClient({ apiKey }).getBalance();
      return { valid: true, available_credits: balance.available_credits };
    } catch {
      throw new HttpError(401, "API key rejected by FOTOhub");
    }
  })
);

app.post(
  "/api/connect",
  wrap(async (req) => {
    const b = req.body as {
      fotohub_api_key?: string;
      shoper_store_url?: string;
      shoper_access_token?: string;
      shoper_login?: string;
      shoper_password?: string;
      store_name?: string;
    };

    const apiKey = b.fotohub_api_key ?? getFotohubKey();
    if (!apiKey) throw new HttpError(400, "fotohub_api_key is required");

    // Step 1: validate the FOTOhub key via GET /v1/billing/balance.
    const bridge = new CommerceBridgeClient({ apiKey });
    let balance;
    try {
      balance = await bridge.getBalance();
    } catch {
      throw new HttpError(401, "API key rejected by FOTOhub");
    }

    // Step 2: validate Shoper credentials.
    const env = shoperCredentials();
    const storeUrl = (b.shoper_store_url ?? env.storeUrl)?.replace(/\/+$/, "");
    const accessToken = b.shoper_access_token ?? env.accessToken;
    const login = b.shoper_login ?? env.login;
    const password = b.shoper_password ?? env.password;
    if (!storeUrl || (!accessToken && !(login && password))) {
      throw new HttpError(
        400,
        "Shoper store URL plus a webapi token or login/password are required"
      );
    }
    const shoper = new ShoperClient({ storeUrl, accessToken, login, password });
    const health = await shoper.healthCheck();
    if (!health.ok) {
      throw new HttpError(401, `Shoper credentials rejected: ${health.error}`);
    }

    // Step 3: register the bridge connection.
    const publicUrl = process.env["PUBLIC_URL"];
    const connection = await bridge.createConnection({
      platform: "shoper",
      store_url: storeUrl,
      store_name: b.store_name ?? storeUrl.replace(/^https?:\/\//, ""),
      callback_url: publicUrl
        ? `${publicUrl.replace(/\/+$/, "")}/webhooks/fotohub`
        : undefined,
    });

    // Step 4: persist everything (secrets encrypted).
    store.writeConfig({
      fotohubApiKey: apiKey,
      shoperStoreUrl: storeUrl,
      shoperAccessToken: accessToken,
      shoperLogin: login,
      shoperPassword: password,
      storeName: b.store_name ?? storeUrl.replace(/^https?:\/\//, ""),
      connectionId: connection.id,
      callbackSecret: connection.callback_secret,
    });
    cachedShoper = undefined; // force re-create with the new creds

    return {
      connection_id: connection.id,
      status: connection.status,
      available_credits: balance.available_credits,
    };
  })
);

app.post(
  "/api/disconnect",
  wrap(async () => {
    const cfg = store.readConfig();
    if (cfg.connectionId) {
      try {
        await makeBridge().deleteConnection(cfg.connectionId);
      } catch {
        /* connection may already be gone */
      }
    }
    store.clearConfig();
    cachedShoper = undefined;
    return { disconnected: true };
  })
);

/* ---- 11. Health check -------------------------------------------------- */

app.get(
  "/api/health",
  wrap(async () => {
    const results: Record<string, unknown> = {};
    try {
      const bridge = makeBridge();
      const [bridgeHealth, balance] = await Promise.all([
        bridge.health(),
        bridge.getBalance().catch(() => null),
      ]);
      results["bridge"] = bridgeHealth;
      results["balance"] = balance;
    } catch (err) {
      results["bridge"] = { ok: false, detail: (err as Error).message };
    }
    try {
      results["shoper"] = await makeShoper().healthCheck();
    } catch (err) {
      results["shoper"] = { ok: false, error: (err as Error).message };
    }
    lastHealthCheckAt = new Date().toISOString();
    results["checked_at"] = lastHealthCheckAt;
    return results;
  })
);

/* ---- Dashboard summary ------------------------------------------------- */

/**
 * One round trip for the dashboard: balance, draft counts, job counts and a
 * sampled "products without description" figure (Shoper has no server-side
 * filter for description length, so this is a sample, not a full scan).
 */
app.get(
  "/api/summary",
  wrap(async () => {
    const jobs = store.listJobs(20);
    const activeJobs = jobs.filter(
      (j) => !j.state || !TERMINAL_STATUSES.includes(j.state.status)
    ).length;
    const spentRecently = jobs.reduce(
      (sum, j) => sum + (j.state?.spent_credits ?? 0),
      0
    );

    const drafts = store.countDrafts();

    let balance: { available_credits: number } | null = null;
    try {
      balance = await makeBridge().getBalance();
    } catch {
      /* dashboard still renders without a live balance */
    }

    let missingDescription: { count: number; sample: number } | null = null;
    try {
      const page = await makeShoper().getProducts({ limit: 50, page: 1 });
      missingDescription = {
        count: page.products.filter(
          (p) => p.description_length < MISSING_DESCRIPTION_MAX
        ).length,
        sample: page.products.length,
      };
    } catch {
      /* store credentials may be missing */
    }

    return {
      available_credits: balance?.available_credits ?? null,
      low_balance:
        balance !== null && balance.available_credits < LOW_BALANCE_THRESHOLD,
      spent_recently: spentRecently,
      jobs_total: jobs.length,
      jobs_active: activeJobs,
      drafts_pending: drafts.pending,
      drafts_approved: drafts.approved,
      drafts_rejected: drafts.rejected,
      missing_description: missingDescription,
      recent_jobs: jobs.slice(0, 8),
    };
  })
);

/* ---- 2. Product picker -------------------------------------------------- */

/** Read a positive number from a query param, or undefined. */
function numParam(value: unknown): number | undefined {
  if (typeof value !== "string" || value === "") return undefined;
  const n = Number(value);
  return Number.isFinite(n) ? n : undefined;
}

app.get(
  "/api/products",
  wrap(async (req) => {
    const q = req.query;
    const sort =
      typeof q["sort"] === "string" && PRODUCT_SORTS.includes(q["sort"] as ProductSort)
        ? (q["sort"] as ProductSort)
        : undefined;
    const limit = Math.min(Math.max(numParam(q["limit"]) ?? 25, 5), 50);
    const page = await makeShoper().getProducts({
      search: typeof q["search"] === "string" && q["search"] ? q["search"] : undefined,
      categoryId: numParam(q["category_id"]),
      maxDescriptionLength:
        q["missing_description"] === "1" ? MISSING_DESCRIPTION_MAX : undefined,
      maxImages: numParam(q["max_images"]),
      priceFrom: numParam(q["price_from"]),
      priceTo: numParam(q["price_to"]),
      sort,
      limit,
      page: Math.max(numParam(q["page"]) ?? 1, 1),
    });
    return page;
  })
);

app.get(
  "/api/categories",
  wrap(async () => {
    return { categories: await makeShoper().getCategories() };
  })
);

/* ---- 3. Preset gallery --------------------------------------------------- */

app.get(
  "/api/presets",
  wrap(async (req) => {
    const category = req.query["category"];
    const vertical = req.query["vertical"];
    const presets = await makeBridge().getPresets({
      category:
        typeof category === "string" && category
          ? (category as PresetCategory)
          : undefined,
      vertical: typeof vertical === "string" && vertical ? vertical : undefined,
      platform: "shoper",
    });
    // Bundle presets featured first; the SPA groups by category.
    const sorted = [...presets].sort((a, b) => {
      if (a.category === "bundle" && b.category !== "bundle") return -1;
      if (b.category === "bundle" && a.category !== "bundle") return 1;
      return a.category.localeCompare(b.category) || a.name.localeCompare(b.name);
    });
    return {
      presets: sorted,
      default_preset_slug: store.readConfig().defaultPresetSlug ?? null,
    };
  })
);

app.post(
  "/api/presets/default",
  wrap(async (req) => {
    const b = req.body as { slug?: string };
    store.writeConfig({ defaultPresetSlug: b.slug });
    return { default_preset_slug: b.slug ?? null };
  })
);

/* ---- 4. Cost preflight ----------------------------------------------------- */

app.post(
  "/api/estimate",
  wrap(async (req) => {
    const b = req.body as {
      kind: JobKind;
      model?: string;
      num_items: number;
      options?: JobOptions;
    };
    if (!b.kind || !b.num_items) throw new HttpError(400, "kind and num_items are required");
    const estimate = await makeBridge().estimate({
      kind: b.kind,
      model: b.model,
      num_items: b.num_items,
      options: b.options,
    });
    return {
      ...estimate,
      num_items: b.num_items,
      num_images: b.options?.num_images ?? 1,
    };
  })
);

/* ---- 5 + 6. Job submit & progress -------------------------------------------- */

/** The slice of ShoperClient the item builder needs, so tests can fake it. */
export type JobItemSource = Pick<
  ShoperClient,
  | "getProduct"
  | "toSummary"
  | "translationLocale"
  | "getProductImages"
  | "imageUrl"
  | "getProductVariants"
>;

/**
 * Turn selected product ids into bridge job items.
 *
 * `includeVariants` folds each product's option combinations into
 * product_context.variants, which is what lets a text model say "available in
 * 42/43/44" instead of inventing sizes. It is opt-in because it costs one extra
 * /product-stocks call per product.
 */
export async function buildJobItems(
  shoper: JobItemSource,
  kind: JobKind,
  productIds: readonly number[],
  options: { includeVariants?: boolean } = {}
): Promise<JobItemInput[]> {
  const items: JobItemInput[] = [];
  for (const productId of productIds) {
    const product = await shoper.getProduct(productId);
    const summary = shoper.toSummary(product);
    const translations = product.translations as
      | Record<string, ShoperProductTranslation>
      | undefined;
    const t =
      translations?.[shoper.translationLocale] ??
      (translations ? Object.values(translations)[0] : undefined);

    const attributes: Record<string, string> = {};
    if (product.ean) attributes["ean"] = String(product.ean);
    if (product.code) attributes["code"] = String(product.code);

    const context: ProductContext = {
      title: summary.name,
      category:
        summary.category_id !== undefined ? String(summary.category_id) : undefined,
      attributes: Object.keys(attributes).length > 0 ? attributes : undefined,
      price: summary.price,
      current_description: t?.description ? String(t.description) : undefined,
    };

    if (options.includeVariants) {
      // A store with no variants must not fail the whole submission, so a
      // failed/empty lookup simply leaves the field off.
      const variants = await shoper.getProductVariants(productId).catch(() => []);
      const active = variants.filter((v) => v.active !== false);
      const summaries = summariseVariants(active.length > 0 ? active : variants);
      if (summaries.length > 0) context.variants = summaries;
    }

    // First visible product image as the source for image jobs.
    let sourceImageUrl: string | undefined;
    if (kind !== "description" && kind !== "alt_text") {
      const images = await shoper.getProductImages(productId);
      const main =
        images.find((i) => i.main === "1" || i.main === 1 || i.main === true) ??
        images[0];
      sourceImageUrl = main ? shoper.imageUrl(main) : undefined;
    }

    items.push({
      external_id: String(productId),
      sku: summary.sku,
      source_image_url: sourceImageUrl,
      product_context: context,
    });
  }
  return items;
}

app.post(
  "/api/jobs",
  wrap(async (req) => {
    const b = req.body as {
      kind: JobKind;
      product_ids: number[];
      model?: string;
      preset_slug?: string;
      options?: JobOptions;
      idempotency_key?: string;
      include_variants?: boolean;
    };
    if (!b.kind) throw new HttpError(400, "kind is required");
    if (!Array.isArray(b.product_ids) || b.product_ids.length === 0) {
      throw new HttpError(400, "product_ids is required");
    }

    const connectionId = requireConnectionId();
    const shoper = makeShoper();
    const includeVariants = b.include_variants === true;

    const items = await buildJobItems(shoper, b.kind, b.product_ids, {
      includeVariants,
    });

    const created = await makeBridge().createJob({
      connection_id: connectionId,
      kind: b.kind,
      model: b.model,
      preset_slug: b.preset_slug ?? store.readConfig().defaultPresetSlug,
      options: b.options,
      items,
      idempotency_key: b.idempotency_key,
    });

    // Persist locally so the progress UI survives reloads/restarts.
    store.rememberJob({
      job_id: created.job_id,
      kind: b.kind,
      product_ids: b.product_ids,
      created_at: new Date().toISOString(),
    });

    return created;
  })
);

app.get(
  "/api/jobs",
  wrap(async () => {
    return { jobs: store.listJobs() };
  })
);

app.get(
  "/api/jobs/:id",
  wrap(async (req) => {
    const jobId = req.params["id"]!;
    const cached = store.getJob(jobId);
    // Webhook already told us the job is terminal: serve from cache.
    if (cached?.terminal && cached.state) {
      return { ...cached.state, cached: true };
    }
    const state = await makeBridge().getJob(jobId);
    if (cached) {
      store.updateJobState(jobId, state, TERMINAL_STATUSES.includes(state.status));
    }
    return state;
  })
);

app.get(
  "/api/jobs/:id/items",
  wrap(async (req) => {
    const q = req.query;
    const items = await makeBridge().getJobItems(req.params["id"]!, {
      status:
        typeof q["status"] === "string" && q["status"]
          ? (q["status"] as never)
          : undefined,
      limit: typeof q["limit"] === "string" ? Number(q["limit"]) : 100,
      offset: typeof q["offset"] === "string" ? Number(q["offset"]) : 0,
    });
    return { items };
  })
);

app.post(
  "/api/jobs/:id/retry-failed",
  wrap(async (req) => {
    const result = await makeBridge().retryFailed(req.params["id"]!);
    // Job is live again.
    const jobId = req.params["id"]!;
    const cached = store.getJob(jobId);
    if (cached?.state) store.updateJobState(jobId, cached.state, false);
    return result;
  })
);

app.post(
  "/api/jobs/:id/cancel",
  wrap(async (req) => {
    await makeBridge().cancelJob(req.params["id"]!);
    store.markJobTerminal(req.params["id"]!);
    return { cancelled: true };
  })
);

app.post(
  "/api/jobs/:id/collect-drafts",
  wrap(async (req) => {
    const jobId = req.params["id"]!;
    const cached = store.getJob(jobId);
    const kind = cached?.kind ?? "image_generate";
    const collected = await collectJobDrafts(
      { store, getBridge: makeBridge, getShoper: makeShoper },
      jobId,
      kind
    );
    return { collected };
  })
);

/* ---- 7 + 8. Drafts review ------------------------------------------------------ */

app.get(
  "/api/drafts",
  wrap(async (req) => {
    const q = req.query;
    const status = typeof q["status"] === "string" && q["status"] ? q["status"] : "pending";
    return {
      drafts: store.listDrafts({
        status: status as "pending" | "approved" | "rejected",
        jobId: typeof q["job_id"] === "string" && q["job_id"] ? q["job_id"] : undefined,
        productId:
          typeof q["product_id"] === "string" && q["product_id"]
            ? Number(q["product_id"])
            : undefined,
      }),
    };
  })
);

app.post(
  "/api/drafts/:id/approve",
  wrap(async (req) => {
    const result = await store.approveDraft(Number(req.params["id"]), makeShoper());
    return { approved: true, ...result };
  })
);

app.post(
  "/api/drafts/:id/reject",
  wrap(async (req) => {
    store.rejectDraft(Number(req.params["id"]));
    return { rejected: true };
  })
);

app.post(
  "/api/drafts/approve-all",
  wrap(async (req) => {
    const b = req.body as { job_id?: string; ids?: number[] };
    // The review screen filters client-side, so it sends the visible ids
    // explicitly; without ids we fall back to "every pending draft".
    const result = Array.isArray(b?.ids)
      ? await store.approveMany(
          makeShoper(),
          b.ids.map(Number).filter((n) => Number.isFinite(n))
        )
      : await store.approveAll(makeShoper(), b?.job_id);
    return {
      approved: result.approved.length,
      failed: result.failed,
      results: result.approved,
    };
  })
);

/* ---- 9. Credits meter -------------------------------------------------------------- */

app.get(
  "/api/balance",
  wrap(async () => {
    const balance = await makeBridge().getBalance();
    return {
      ...balance,
      low_balance: balance.available_credits < LOW_BALANCE_THRESHOLD,
      threshold: LOW_BALANCE_THRESHOLD,
    };
  })
);

/* ---- 12. i18n ------------------------------------------------------------------------ */

app.get(
  "/api/i18n/:lang",
  wrap(async (req) => {
    const lang = req.params["lang"] === "en" ? "en" : "pl";
    return { lang, strings: getStrings(lang) };
  })
);

app.post(
  "/api/language",
  wrap(async (req) => {
    const b = req.body as { lang?: string };
    const lang = b?.lang === "en" ? "en" : "pl";
    store.writeConfig({ uiLanguage: lang });
    return { ui_language: lang };
  })
);

/* ---- Error handling ---------------------------------------------------------------------- */

app.use((err: unknown, _req: Request, res: Response, _next: NextFunction) => {
  if (err instanceof InsufficientCreditsError) {
    res.status(402).json({
      error: "insufficient_credits",
      required_credits: err.requiredCredits,
      available_credits: err.availableCredits,
    });
    return;
  }
  if (err instanceof HttpError) {
    res.status(err.status).json({ error: err.message });
    return;
  }
  // A 403 from Shoper is the merchant's own permission setup, not our bug, so
  // it keeps its status instead of being flattened into a 500.
  if (err instanceof ShoperPermissionError) {
    res.status(403).json({ error: "shoper_insufficient_permission", detail: err.message });
    return;
  }
  console.error("[fotohub-shoper] unhandled error:", err);
  res
    .status(500)
    .json({ error: err instanceof Error ? err.message : "internal_error" });
});

/* -------------------------------------------------------------------- */
/* Boot                                                                  */
/* -------------------------------------------------------------------- */

/**
 * Warn loudly when the panel is reachable without a shared secret. Split out so
 * a test can assert the warning fires without booting a listener.
 */
export function adminAuthBootMessage(
  env: NodeJS.ProcessEnv = process.env
): { level: "info" | "warn"; message: string } {
  if (readAdminToken(env)) {
    return { level: "info", message: "ADMIN_TOKEN is set — /api requires it." };
  }
  const host = env["HOST"] ?? "127.0.0.1";
  const exposed = host !== "127.0.0.1" && host !== "localhost";
  return {
    level: "warn",
    message:
      "ADMIN_TOKEN is not set — the admin panel is UNAUTHENTICATED. Anyone who " +
      `can reach ${host}:${env["PORT"] ?? PORT} can drive every /api route, ` +
      "including spending FOTOhub credits and writing to the live store." +
      (exposed
        ? " HOST is not loopback, so this port may be reachable from the network."
        : " Keep HOST on loopback, or set ADMIN_TOKEN."),
  };
}

if (require.main === module) {
  const boot = adminAuthBootMessage();
  if (boot.level === "warn") console.warn(`[fotohub-shoper] ${boot.message}`);
  else console.log(`[fotohub-shoper] ${boot.message}`);
  app.listen(PORT, HOST, () => {
    console.log(`FOTOhub AI for Shoper: http://${HOST}:${PORT}`);
  });
}

export { app, store };
