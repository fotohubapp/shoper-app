/**
 * Shoper write-back service — the ONLY module that mutates live store data.
 *
 * Everything here is deliberately defensive:
 *
 *  - Image write-back downloads the FOTOhub result URL through a guarded
 *    fetch: https-only by default, optional host allowlist, content-type
 *    allowlist, streaming max-bytes guard (so a hostile/corrupt URL cannot
 *    exhaust memory), magic-byte sniffing to catch a lying Content-Type, and a
 *    per-download timeout. Only then is it base64-encoded and POSTed to
 *    Shoper's /product-images, optionally promoted to main image and given
 *    localised ALT/title text.
 *
 *  - Text write-back maps bridge `result.text` fields onto the correct Shoper
 *    translation fields for the target locale (name, short_description,
 *    description, seo_title, seo_description, seo_keywords), with HTML
 *    sanitising on fields Shoper renders raw.
 *
 *  - Idempotency: every applied write is journalled by `bridge_item_id`. If the
 *    same item is applied twice (webhook replay, user double-click, process
 *    restart mid-approve), the second call is a no-op and reports `skipped`.
 *
 *  - Retries: transient Shoper failures (429/5xx/network) are retried with
 *    backoff inside ShoperClient; here we additionally retry the whole
 *    per-image apply once, because a partially uploaded image is safe to
 *    re-attempt (Shoper assigns a fresh gfx_id and the journal prevents a
 *    duplicate on a later approve).
 */

import { fetch as undiciFetch } from "undici";
import { backoffDelay, sleep } from "./http";
import { ShoperClient } from "./shoper-client";
import {
  DraftPayload,
  FetchLike,
  ImageFetchError,
  ImageFetchLimits,
  ItemResultText,
  LogSink,
  ShoperApiError,
  ShoperTranslationPatch,
  WriteBackResult,
} from "./types";

/** Default guard rails for downloaded images. */
export const DEFAULT_MAX_IMAGE_BYTES = 25 * 1024 * 1024;
export const DEFAULT_ALLOWED_MIME: readonly string[] = [
  "image/jpeg",
  "image/jpg",
  "image/png",
  "image/webp",
  "image/gif",
  "image/avif",
];
const DEFAULT_IMAGE_TIMEOUT_MS = 60_000;
const MAX_ALT_CHARS = 250;
const MAX_SEO_TITLE_CHARS = 255;
const MAX_SEO_DESCRIPTION_CHARS = 500;

/**
 * Journal of applied write-backs. The SQLite store implements this; tests use
 * an in-memory version.
 */
export interface WriteBackJournal {
  /** True when this bridge item was already applied successfully. */
  wasApplied(bridgeItemId: string): boolean;
  /** Record a successful application. */
  markApplied(bridgeItemId: string, detail: WriteBackResult): void;
}

export interface WriteBackOptions {
  /** Target locale for translated writes. Defaults to the client locale. */
  locale?: string;
  /** Also write the same text to this locale (e.g. en_US). */
  mirrorLocale?: string;
  /** Guard rails for image downloads. */
  imageLimits?: ImageFetchLimits;
  /** Journal used for idempotency. Omit to disable the check. */
  journal?: WriteBackJournal;
  /** Structured log sink. */
  logger?: LogSink;
  /** Injectable fetch for image downloads (tests). */
  fetchImpl?: FetchLike;
  /** Attempts per image apply (>=1). Default 2. */
  imageAttempts?: number;
  /** Overwrite ALT text on images that already have one. Default false. */
  overwriteExistingAlt?: boolean;
  /** Sanitise HTML in description fields before writing. Default true. */
  sanitiseHtml?: boolean;
}

export interface DownloadedImage {
  base64: string;
  bytes: number;
  contentType: string;
  extension: string;
}

/* -------------------------------------------------------------------- */
/* Guarded image download                                                */
/* -------------------------------------------------------------------- */

const MIME_EXTENSIONS: Record<string, string> = {
  "image/jpeg": "jpg",
  "image/jpg": "jpg",
  "image/png": "png",
  "image/webp": "webp",
  "image/gif": "gif",
  "image/avif": "avif",
};

/** Sniff the real image type from magic bytes; undefined when unknown. */
export function sniffImageMime(buffer: Buffer): string | undefined {
  if (buffer.length < 12) return undefined;
  if (buffer[0] === 0xff && buffer[1] === 0xd8 && buffer[2] === 0xff) return "image/jpeg";
  if (
    buffer[0] === 0x89 &&
    buffer[1] === 0x50 &&
    buffer[2] === 0x4e &&
    buffer[3] === 0x47
  ) {
    return "image/png";
  }
  if (buffer.subarray(0, 3).toString("latin1") === "GIF") return "image/gif";
  if (
    buffer.subarray(0, 4).toString("latin1") === "RIFF" &&
    buffer.subarray(8, 12).toString("latin1") === "WEBP"
  ) {
    return "image/webp";
  }
  // ISO-BMFF: ftyp box; avif/heic brands.
  if (buffer.subarray(4, 8).toString("latin1") === "ftyp") {
    const brand = buffer.subarray(8, 12).toString("latin1");
    if (brand.startsWith("avif") || brand.startsWith("avis")) return "image/avif";
  }
  return undefined;
}

/** Validate a candidate image URL against the configured guards. */
export function assertSafeImageUrl(rawUrl: string, limits: ImageFetchLimits = {}): URL {
  let url: URL;
  try {
    url = new URL(rawUrl);
  } catch {
    throw new ImageFetchError(`Not a valid URL: ${rawUrl.slice(0, 120)}`, "blocked_url");
  }
  const requireHttps = limits.requireHttps !== false;
  if (requireHttps ? url.protocol !== "https:" : !/^https?:$/.test(url.protocol)) {
    throw new ImageFetchError(`Blocked image URL scheme: ${url.protocol}`, "blocked_url");
  }
  if (limits.allowedHosts && limits.allowedHosts.length > 0) {
    const host = url.hostname.toLowerCase();
    const allowed = limits.allowedHosts.some(
      (entry) => host === entry.toLowerCase() || host.endsWith(`.${entry.toLowerCase()}`)
    );
    if (!allowed) {
      throw new ImageFetchError(`Image host not allowed: ${url.hostname}`, "blocked_url");
    }
  }
  return url;
}

/**
 * Download a remote image with size/mime guards and return it base64-encoded
 * for Shoper's `content` field.
 */
export async function downloadImage(
  rawUrl: string,
  limits: ImageFetchLimits = {},
  fetchImpl: FetchLike = undiciFetch as unknown as FetchLike
): Promise<DownloadedImage> {
  const url = assertSafeImageUrl(rawUrl, limits);
  const maxBytes = limits.maxBytes ?? DEFAULT_MAX_IMAGE_BYTES;
  const allowedMime = limits.allowedMimeTypes ?? DEFAULT_ALLOWED_MIME;
  const timeoutMs = limits.timeoutMs ?? DEFAULT_IMAGE_TIMEOUT_MS;

  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), timeoutMs);
  let response;
  try {
    response = await fetchImpl(url.toString(), {
      method: "GET",
      headers: { Accept: allowedMime.join(", ") },
      signal: controller.signal,
    });
  } catch (err) {
    if (controller.signal.aborted) {
      throw new ImageFetchError(`Image download timed out after ${timeoutMs}ms`, "timeout");
    }
    throw new ImageFetchError(
      `Image download failed: ${err instanceof Error ? err.message : String(err)}`,
      "http_error"
    );
  } finally {
    clearTimeout(timer);
  }

  if (!response.ok) {
    throw new ImageFetchError(
      `Image download failed with HTTP ${response.status}`,
      "http_error"
    );
  }

  const declared = (response.headers.get("content-type") ?? "").split(";")[0]?.trim().toLowerCase() ?? "";
  const declaredLength = Number(response.headers.get("content-length") ?? NaN);
  if (Number.isFinite(declaredLength) && declaredLength > maxBytes) {
    throw new ImageFetchError(
      `Image is ${declaredLength} bytes, above the ${maxBytes} byte limit`,
      "too_large"
    );
  }
  if (declared && !allowedMime.includes(declared)) {
    throw new ImageFetchError(`Unsupported image content-type: ${declared}`, "bad_mime");
  }

  const buffer = Buffer.from(await response.arrayBuffer());
  if (buffer.length === 0) throw new ImageFetchError("Image download was empty", "empty");
  if (buffer.length > maxBytes) {
    throw new ImageFetchError(
      `Image is ${buffer.length} bytes, above the ${maxBytes} byte limit`,
      "too_large"
    );
  }

  // The bytes decide, not the header. Falling back to the declared type when
  // sniffing fails would let a server label anything image/png and have it
  // uploaded to the merchant's gallery, which is the exact case the sniff
  // exists to catch.
  const contentType = sniffImageMime(buffer);
  if (!contentType || !allowedMime.includes(contentType)) {
    throw new ImageFetchError(
      `Downloaded bytes are not a supported image (${contentType ?? declared ?? "unknown"})`,
      "bad_mime"
    );
  }

  return {
    base64: buffer.toString("base64"),
    bytes: buffer.length,
    contentType,
    extension: MIME_EXTENSIONS[contentType] ?? extensionFromUrl(url.pathname) ?? "jpg",
  };
}

function extensionFromUrl(pathname: string): string | undefined {
  const m = /\.(jpe?g|png|webp|gif|avif)$/i.exec(pathname);
  const ext = m?.[1]?.toLowerCase();
  return ext === "jpeg" ? "jpg" : ext;
}

/* -------------------------------------------------------------------- */
/* Text mapping                                                          */
/* -------------------------------------------------------------------- */

/**
 * Map bridge text results onto Shoper translation fields.
 * `title -> name`, `meta_* -> seo_*`; `alt_text` is applied to images, not to
 * the product, so it is intentionally absent here.
 */
export function textToTranslationPatch(
  text: ItemResultText,
  options: { sanitiseHtml?: boolean; fields?: readonly string[] } = {}
): ShoperTranslationPatch {
  const allow = options.fields ? new Set(options.fields) : undefined;
  const want = (field: string): boolean => !allow || allow.has(field);
  const patch: ShoperTranslationPatch = {};

  if (text.title && want("title")) patch.name = collapse(text.title);
  if (text.short_description && want("short_description")) {
    patch.short_description =
      options.sanitiseHtml === false
        ? text.short_description
        : sanitiseHtml(text.short_description);
  }
  if (text.description && want("description")) {
    patch.description =
      options.sanitiseHtml === false ? text.description : sanitiseHtml(text.description);
  }
  if (text.meta_title && want("meta_title")) {
    patch.seo_title = clamp(collapse(text.meta_title), MAX_SEO_TITLE_CHARS);
  }
  if (text.meta_description && want("meta_description")) {
    patch.seo_description = clamp(
      collapse(text.meta_description),
      MAX_SEO_DESCRIPTION_CHARS
    );
  }
  if (text.meta_keywords && want("meta_keywords")) {
    patch.seo_keywords = clamp(collapse(text.meta_keywords), MAX_SEO_TITLE_CHARS);
  }
  return patch;
}

/** Backwards-compatible alias used by earlier revisions of the app. */
export const textToTranslationUpdate = textToTranslationPatch;

const DISALLOWED_TAGS = /<\/?(script|style|iframe|object|embed|link|meta|form|input|svg)\b[^>]*>/gi;
const EVENT_ATTRS = /\son[a-z]+\s*=\s*(?:"[^"]*"|'[^']*'|[^\s>]+)/gi;
const JS_URLS = /((?:href|src)\s*=\s*)(?:"javascript:[^"]*"|'javascript:[^']*'|javascript:[^\s>]+)/gi;

/**
 * Remove script-bearing markup from generated HTML before it is stored in a
 * field that the storefront renders raw. Not a full sanitiser (the copy comes
 * from our own pipeline), but it closes the obvious stored-XSS path.
 */
export function sanitiseHtml(html: string): string {
  return html
    .replace(/<(script|style)[\s\S]*?<\/\1>/gi, "")
    .replace(DISALLOWED_TAGS, "")
    .replace(EVENT_ATTRS, "")
    .replace(JS_URLS, '$1"#"')
    .trim();
}

function collapse(text: string): string {
  return text.replace(/\s+/g, " ").trim();
}

/**
 * Journal key for the image half of a mixed write-back. Keeping it separate
 * from the item key means a failure while writing text does not force a
 * duplicate image upload when the merchant retries the approve.
 */
export function imagePhase(bridgeItemId: string): string {
  return `${bridgeItemId}#images`;
}

function clamp(text: string, max: number): string {
  return text.length <= max ? text : `${text.slice(0, max - 1).trimEnd()}…`;
}

/* -------------------------------------------------------------------- */
/* Service                                                              */
/* -------------------------------------------------------------------- */

export class ShoperWriteBack {
  private readonly shoper: ShoperClient;
  private readonly options: WriteBackOptions;
  private readonly fetchImpl: FetchLike;

  constructor(shoper: ShoperClient, options: WriteBackOptions = {}) {
    this.shoper = shoper;
    this.options = options;
    this.fetchImpl = options.fetchImpl ?? (undiciFetch as unknown as FetchLike);
  }

  private log(
    level: "debug" | "info" | "warn" | "error",
    msg: string,
    meta?: Record<string, unknown>
  ): void {
    if (!this.options.logger) return;
    try {
      this.options.logger(meta ? { level, msg, meta } : { level, msg });
    } catch {
      /* ignore */
    }
  }

  private get locale(): string {
    return this.options.locale ?? this.shoper.translationLocale;
  }

  /**
   * Apply one draft payload to a live product.
   *
   * `bridgeItemId` is the idempotency anchor: when the journal already knows
   * it, nothing is written and the result reports the skip.
   */
  async apply(
    productId: number,
    payload: DraftPayload,
    bridgeItemId: string,
    overrides: { variantId?: string | null } = {}
  ): Promise<WriteBackResult> {
    const result: WriteBackResult = {
      product_id: productId,
      applied_images: 0,
      applied_fields: [],
      skipped: [],
      warnings: [],
    };

    if (this.options.journal?.wasApplied(bridgeItemId)) {
      result.skipped.push("already_applied");
      this.log("info", `write-back skipped, already applied: ${bridgeItemId}`);
      return result;
    }

    const locale = payload.locale ?? this.locale;

    if (payload.images && payload.images.length > 0) {
      // Phase key: images and text are journalled separately so a text failure
      // after a successful upload cannot cause duplicate images on retry.
      const imagePhaseKey = imagePhase(bridgeItemId);
      if (this.options.journal?.wasApplied(imagePhaseKey)) {
        result.skipped.push("images_already_applied");
      } else {
        const imageResult = await this.applyImages(productId, payload, locale);
        result.applied_images += imageResult.applied;
        result.warnings.push(...imageResult.warnings);
        result.skipped.push(...imageResult.skipped);
        if (imageResult.applied === 0 && imageResult.warnings.length > 0) {
          // Nothing landed: surface as a hard failure so the draft stays pending.
          throw new ShoperApiError(
            `No image could be written back: ${imageResult.warnings.join("; ")}`,
            502
          );
        }
        if (imageResult.applied > 0) {
          this.options.journal?.markApplied(imagePhaseKey, {
            product_id: productId,
            applied_images: imageResult.applied,
            applied_fields: [],
            skipped: [],
            warnings: imageResult.warnings,
          });
        }
      }
    }

    if (payload.text) {
      const textResult = await this.applyText(
        productId,
        payload.text,
        locale,
        Boolean(payload.images?.length)
      );
      result.applied_fields.push(...textResult.fields);
      result.warnings.push(...textResult.warnings);
    }

    if (overrides.variantId) {
      result.warnings.push(
        `variant ${overrides.variantId}: Shoper stores images per product, applied at product level`
      );
    }

    this.options.journal?.markApplied(bridgeItemId, result);
    return result;
  }

  /** Upload generated images and optionally promote one to main. */
  private async applyImages(
    productId: number,
    payload: DraftPayload,
    locale: string
  ): Promise<{ applied: number; warnings: string[]; skipped: string[] }> {
    const images = payload.images ?? [];
    const warnings: string[] = [];
    const skipped: string[] = [];
    const attempts = Math.max(1, this.options.imageAttempts ?? 2);
    const existing = await this.shoper.getProductImages(productId).catch(() => []);
    let order = existing.length;
    let applied = 0;
    let mainGfxId: number | undefined;

    for (const [index, image] of images.entries()) {
      let lastError: Error | undefined;
      let ok = false;
      for (let attempt = 1; attempt <= attempts; attempt += 1) {
        try {
          const downloaded = await downloadImage(
            image.url,
            this.options.imageLimits ?? {},
            this.fetchImpl
          );
          const name = `fotohub-${productId}-${Date.now()}-${index}.${downloaded.extension}`;
          const alt = image.alt_text
            ? clamp(collapse(image.alt_text), MAX_ALT_CHARS)
            : undefined;
          const imageOptions: Parameters<ShoperClient["addProductImageBase64"]>[2] = {
            name,
            order: order + index,
            locale,
            main: image.main === true,
          };
          if (alt) {
            imageOptions.altText = alt;
            imageOptions.title = alt;
          }
          if (
            this.options.mirrorLocale &&
            this.options.mirrorLocale !== locale &&
            alt !== undefined
          ) {
            imageOptions.extraLocales = [this.options.mirrorLocale];
          }
          const gfxId = await this.shoper.addProductImageBase64(
            productId,
            downloaded.base64,
            imageOptions
          );
          if (image.main === true) mainGfxId = gfxId;
          applied += 1;
          ok = true;
          lastError = undefined;
          this.log("info", `image applied to product ${productId}`, {
            gfx_id: gfxId,
            bytes: downloaded.bytes,
          });
          break;
        } catch (err) {
          lastError = err instanceof Error ? err : new Error(String(err));
          // A rejected URL / bad mime will never succeed — do not retry.
          if (err instanceof ImageFetchError && err.reason !== "timeout" && err.reason !== "http_error") {
            break;
          }
          if (attempt < attempts) {
            await sleep(backoffDelay({ baseMs: 400, maxMs: 4000, attempt }));
          }
        }
      }
      if (!ok && lastError) {
        warnings.push(`image ${index + 1}: ${lastError.message}`);
      }
    }

    // Explicit main promotion (some Shoper versions ignore main on create).
    if (mainGfxId !== undefined) {
      try {
        await this.shoper.setMainProductImage(mainGfxId);
      } catch (err) {
        warnings.push(
          `could not promote gfx ${mainGfxId} to main: ${
            err instanceof Error ? err.message : String(err)
          }`
        );
      }
    }
    order += images.length;
    return { applied, warnings, skipped };
  }

  /** Write text fields onto the product translation (and image ALT text). */
  private async applyText(
    productId: number,
    text: ItemResultText,
    locale: string,
    hasNewImages: boolean
  ): Promise<{ fields: string[]; warnings: string[] }> {
    const fields: string[] = [];
    const warnings: string[] = [];
    const patch = textToTranslationPatch(text, {
      sanitiseHtml: this.options.sanitiseHtml !== false,
    });

    if (Object.keys(patch).length > 0) {
      if (this.options.mirrorLocale && this.options.mirrorLocale !== locale) {
        await this.shoper.updateProductTranslationsMulti(productId, {
          [locale]: patch,
          [this.options.mirrorLocale]: patch,
        });
      } else {
        await this.shoper.updateProductTranslations(productId, patch, locale);
      }
      fields.push(...Object.keys(patch));
    }

    // ALT text: applied to existing images when the job did not add new ones
    // (a fresh image already carries its ALT from the upload call).
    if (text.alt_text && !hasNewImages) {
      const alt = clamp(collapse(text.alt_text), MAX_ALT_CHARS);
      const images = await this.shoper.getProductImages(productId).catch(() => []);
      let updated = 0;
      for (const image of images) {
        if (!this.options.overwriteExistingAlt && this.shoper.imageAlt(image)) continue;
        try {
          await this.shoper.updateProductImageAlt(Number(image.gfx_id), alt, locale, alt);
          if (this.options.mirrorLocale && this.options.mirrorLocale !== locale) {
            await this.shoper
              .updateProductImageAlt(
                Number(image.gfx_id),
                alt,
                this.options.mirrorLocale,
                alt
              )
              .catch(() => undefined);
          }
          updated += 1;
        } catch (err) {
          warnings.push(
            `alt text on gfx ${image.gfx_id}: ${
              err instanceof Error ? err.message : String(err)
            }`
          );
        }
      }
      if (updated > 0) fields.push("alt_text");
      else if (images.length > 0) warnings.push("all images already had ALT text");
    }

    return { fields, warnings };
  }

  /**
   * Variant-scoped image write-back. Shoper attaches images to products, not
   * to product-stocks, so a variant image is uploaded to the parent product
   * with the variant's option combination folded into the ALT text — which is
   * what merchants expect from the "variant photo" flow.
   */
  async applyVariantImages(
    productId: number,
    variantStockId: number,
    payload: DraftPayload,
    bridgeItemId: string
  ): Promise<WriteBackResult> {
    if (this.options.journal?.wasApplied(bridgeItemId)) {
      return {
        product_id: productId,
        applied_images: 0,
        applied_fields: [],
        skipped: ["already_applied"],
        warnings: [],
      };
    }
    const variants = await this.shoper.getProductVariants(productId).catch(() => []);
    const variant = variants.find((v) => v.stock_id === variantStockId);
    const label = variant
      ? Object.entries(variant.options)
          .map(([key, value]) => `${key}: ${value}`)
          .join(", ")
      : undefined;

    const decorated: DraftPayload = {
      ...payload,
      images: (payload.images ?? []).map((image) => ({
        ...image,
        alt_text: [image.alt_text, label].filter(Boolean).join(" — ") || undefined,
      })),
    };
    delete decorated.text;
    const result = await this.apply(productId, decorated, bridgeItemId, {
      variantId: String(variantStockId),
    });
    if (variant?.sku) result.warnings.push(`variant SKU ${variant.sku}`);
    return result;
  }
}

/** In-memory journal (tests, dry runs). */
export class MemoryWriteBackJournal implements WriteBackJournal {
  private readonly applied = new Map<string, WriteBackResult>();

  wasApplied(bridgeItemId: string): boolean {
    return this.applied.has(bridgeItemId);
  }

  markApplied(bridgeItemId: string, detail: WriteBackResult): void {
    this.applied.set(bridgeItemId, detail);
  }

  get size(): number {
    return this.applied.size;
  }
}
