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
 *
 * Values entered through the connection wizard are stored encrypted in
 * SQLite and take precedence over env values.
 */

import { randomBytes } from "crypto";
import express, { NextFunction, Request, Response } from "express";
import { join } from "path";
import { CommerceBridgeClient } from "./bridge-client";
import { DraftStore } from "./draft-store";
import { getStrings } from "./i18n";
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
  ShoperProductTranslation,
  TONES,
} from "./types";

const PORT = Number(process.env["PORT"] ?? 8811);
const HOST = process.env["HOST"] ?? "127.0.0.1";
const PUBLIC_DIR = join(__dirname, "..", "public");
const DATA_DIR = process.env["DATA_DIR"] ?? join(process.cwd(), "data");
const LOW_BALANCE_THRESHOLD = 50;
const MISSING_DESCRIPTION_MAX = 20;
const TERMINAL_STATUSES: readonly JobStatus[] = [
  "completed",
  "completed_with_errors",
  "failed",
  "cancelled",
];

const store = new DraftStore(
  join(DATA_DIR, "fotohub-shoper.sqlite"),
  process.env["FOTOHUB_CONFIG_SECRET"] ?? "fotohub-shoper-dev-secret"
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

// CSRF guard for every state-changing /api call.
app.use("/api", (req: Request, res: Response, next: NextFunction) => {
  if (req.method === "GET" || req.method === "HEAD" || req.method === "OPTIONS") {
    next();
    return;
  }
  if (req.get("x-csrf-token") !== CSRF_TOKEN) {
    res.status(403).json({ error: "csrf_token_invalid" });
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
    };
    if (!b.kind) throw new HttpError(400, "kind is required");
    if (!Array.isArray(b.product_ids) || b.product_ids.length === 0) {
      throw new HttpError(400, "product_ids is required");
    }

    const connectionId = requireConnectionId();
    const shoper = makeShoper();

    // Build items with real product_context from the store.
    const items: JobItemInput[] = [];
    for (const productId of b.product_ids) {
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

      // First visible product image as the source for image jobs.
      let sourceImageUrl: string | undefined;
      if (b.kind !== "description" && b.kind !== "alt_text") {
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
  console.error("[fotohub-shoper] unhandled error:", err);
  res
    .status(500)
    .json({ error: err instanceof Error ? err.message : "internal_error" });
});

/* -------------------------------------------------------------------- */
/* Boot                                                                  */
/* -------------------------------------------------------------------- */

if (require.main === module) {
  app.listen(PORT, HOST, () => {
    console.log(`FOTOhub AI for Shoper: http://${HOST}:${PORT}`);
  });
}

export { app, store };
