/**
 * Builds the `product_context` object the bridge feeds into image and copy
 * prompts.
 *
 * The richer this context is, the better the generated copy — but prompt
 * budget is finite and Shoper descriptions are often multi-kilobyte HTML
 * blobs. So this module:
 *   1. flattens everything useful out of a Shoper product (title, category
 *      path, producer/brand, attributes, parameters, price + currency, SKU,
 *      EAN, variant option summary, existing description with HTML stripped),
 *   2. then trims it down to a token budget with a deterministic priority
 *      order, so identical products always produce identical context (which
 *      keeps the job idempotency key stable).
 *
 * Token estimation uses a conservative chars-per-token heuristic; no
 * tokeniser dependency, no network.
 */

import {
  MAX_PAGE_LIMIT,
  ShoperClient,
  isTruthy,
  stripHtml,
} from "./shoper-client";
import {
  ProductContext,
  ProductVariant,
  ShoperProduct,
  ShoperProductTranslation,
} from "./types";

/**
 * Average characters per token for mixed PL/EN prose. Polish is
 * token-hungrier than English, so 3.2 is deliberately pessimistic.
 */
export const CHARS_PER_TOKEN = 3.2;

/** Default budget for the whole product_context object. */
export const DEFAULT_CONTEXT_TOKEN_BUDGET = 700;

/** Hard caps applied before the budget trimmer even runs. */
const MAX_TITLE_CHARS = 300;
const MAX_ATTRIBUTES = 40;
const MAX_ATTRIBUTE_KEY_CHARS = 60;
const MAX_ATTRIBUTE_VALUE_CHARS = 160;
const MAX_VARIANT_SUMMARIES = 12;
const MAX_DESCRIPTION_CHARS = 4000;

export interface BuildContextOptions {
  /** Token budget for the serialised context. Default 700. */
  tokenBudget?: number;
  /** Include the existing description (source material for rewrites). */
  includeDescription?: boolean;
  /** Include a variant option summary. */
  includeVariants?: boolean;
  /** Pre-resolved category path ("Home > Shoes"). */
  categoryPath?: string;
  /** Pre-resolved producer/brand name. */
  brand?: string;
  /** Pre-resolved currency code. */
  currency?: string;
  /** Pre-resolved attribute id -> label map. */
  attributeLabels?: Map<number, string>;
  /** Pre-fetched variants (avoids an extra API call). */
  variants?: readonly ProductVariant[];
  /** Locale for translated reads. */
  locale?: string;
}

/** Rough token count of a string. */
export function estimateTokens(text: string): number {
  if (!text) return 0;
  return Math.ceil(text.length / CHARS_PER_TOKEN);
}

/** Rough token count of the JSON serialisation of a value. */
export function estimateContextTokens(context: ProductContext): number {
  return estimateTokens(JSON.stringify(context));
}

/* -------------------------------------------------------------------- */
/* Attribute flattening                                                  */
/* -------------------------------------------------------------------- */

/**
 * Shoper returns product attributes in several shapes depending on API
 * version and whether `translations` are expanded:
 *   {"1": {"5": "Red", "6": "Cotton"}}       group -> attribute -> value
 *   {"colour": "Red"}                        already flat
 *   [{attribute_id: 5, value: "Red"}]        list form
 * All three are normalised into a flat {label: value} map. Labels are
 * resolved through `attributeLabels` when available, otherwise the numeric id
 * is kept (still better than dropping the data).
 */
export function flattenAttributes(
  raw: unknown,
  attributeLabels?: Map<number, string>
): Record<string, string> {
  const out: Record<string, string> = {};

  const push = (key: string, value: unknown): void => {
    if (value === null || value === undefined) return;
    const label = truncate(cleanLabel(key), MAX_ATTRIBUTE_KEY_CHARS);
    if (!label) return;
    const text = truncate(
      stripHtml(typeof value === "string" ? value : JSON.stringify(value)),
      MAX_ATTRIBUTE_VALUE_CHARS
    );
    if (!text) return;
    if (Object.keys(out).length >= MAX_ATTRIBUTES) return;
    out[label] = text;
  };

  const labelFor = (id: string): string => {
    const numeric = Number(id);
    if (Number.isFinite(numeric) && attributeLabels?.has(numeric)) {
      return attributeLabels.get(numeric) as string;
    }
    return id;
  };

  if (Array.isArray(raw)) {
    for (const entry of raw) {
      if (!entry || typeof entry !== "object") continue;
      const rec = entry as Record<string, unknown>;
      const idRaw = rec["attribute_id"] ?? rec["id"];
      const name =
        (typeof rec["name"] === "string" && rec["name"]) ||
        (idRaw !== undefined ? labelFor(String(idRaw)) : undefined);
      const value = rec["value"] ?? rec["values"] ?? rec["text"];
      if (name) push(name, Array.isArray(value) ? value.join(", ") : value);
    }
    return out;
  }

  if (raw && typeof raw === "object") {
    for (const [key, value] of Object.entries(raw as Record<string, unknown>)) {
      if (value && typeof value === "object" && !Array.isArray(value)) {
        // group -> attribute -> value
        for (const [innerKey, innerValue] of Object.entries(
          value as Record<string, unknown>
        )) {
          push(labelFor(innerKey), innerValue);
        }
      } else {
        push(labelFor(key), Array.isArray(value) ? value.join(", ") : value);
      }
    }
  }

  return out;
}

function cleanLabel(label: string): string {
  return label.replace(/[_-]+/g, " ").replace(/\s+/g, " ").trim();
}

function truncate(text: string, max: number): string {
  const trimmed = text.trim();
  if (trimmed.length <= max) return trimmed;
  return `${trimmed.slice(0, Math.max(0, max - 1)).trimEnd()}…`;
}

/** Compact one-line summaries of variant option combinations. */
export function summariseVariants(variants: readonly ProductVariant[]): string[] {
  const seen = new Set<string>();
  const out: string[] = [];
  for (const variant of variants) {
    const parts = Object.entries(variant.options)
      .sort(([a], [b]) => (a < b ? -1 : a > b ? 1 : 0))
      .map(([key, value]) => `${key}: ${value}`);
    if (parts.length === 0) continue;
    const label = parts.join(", ");
    if (seen.has(label)) continue;
    seen.add(label);
    out.push(label);
    if (out.length >= MAX_VARIANT_SUMMARIES) break;
  }
  return out;
}

/* -------------------------------------------------------------------- */
/* Trimming                                                              */
/* -------------------------------------------------------------------- */

/**
 * Reduce a context until it fits `tokenBudget`.
 *
 * Priority (last dropped first): title > category > brand > price > sku/ean >
 * attributes > variants > current_description. The description is truncated
 * before being dropped, and attributes are shed one at a time from the end of
 * a stable alphabetical ordering — so the result is deterministic.
 */
export function trimContext(
  context: ProductContext,
  tokenBudget: number = DEFAULT_CONTEXT_TOKEN_BUDGET
): ProductContext {
  const budget = Math.max(60, Math.floor(tokenBudget));
  const working: ProductContext = { ...context };
  if (working.attributes) working.attributes = sortRecord(working.attributes);

  const fits = (): boolean => estimateContextTokens(working) <= budget;
  if (fits()) return working;

  // 1. Shrink the description progressively (it dominates the payload).
  if (working.current_description) {
    const overshootChars = (): number =>
      Math.max(0, JSON.stringify(working).length - budget * CHARS_PER_TOKEN);
    let text = working.current_description;
    while (text.length > 120 && !fits()) {
      const cut = Math.max(120, Math.floor(text.length - overshootChars() - 32));
      if (cut >= text.length) break;
      text = truncate(text.slice(0, cut), cut + 1);
      working.current_description = text;
    }
    if (!fits()) {
      delete working.current_description;
    }
  }
  if (fits()) return working;

  // 2. Drop variants.
  if (working.variants) {
    while (working.variants.length > 0 && !fits()) {
      working.variants = working.variants.slice(0, -1);
    }
    if (working.variants.length === 0) delete working.variants;
  }
  if (fits()) return working;

  // 3. Shed attributes from the tail of the sorted list.
  if (working.attributes) {
    let entries = Object.entries(working.attributes);
    while (entries.length > 0 && !fits()) {
      entries = entries.slice(0, -1);
      working.attributes = Object.fromEntries(entries);
    }
    if (entries.length === 0) delete working.attributes;
  }
  if (fits()) return working;

  // 4. Drop the low-value scalars.
  for (const key of ["ean", "sku", "brand", "category"] as const) {
    if (working[key] !== undefined) {
      delete working[key];
      if (fits()) return working;
    }
  }

  // 5. Last resort: truncate the title (never dropped — the prompt needs it).
  const maxTitleChars = Math.max(24, Math.floor(budget * CHARS_PER_TOKEN) - 40);
  if (working.title.length > maxTitleChars) {
    working.title = truncate(working.title, maxTitleChars);
  }
  return working;
}

function sortRecord(record: Record<string, string>): Record<string, string> {
  return Object.fromEntries(
    Object.entries(record).sort(([a], [b]) => (a < b ? -1 : a > b ? 1 : 0))
  );
}

/* -------------------------------------------------------------------- */
/* Builders                                                              */
/* -------------------------------------------------------------------- */

/**
 * Build a context from an already-fetched Shoper product plus pre-resolved
 * lookups. Pure and synchronous — this is the function the tests exercise.
 */
export function buildProductContextSync(
  product: ShoperProduct,
  translation: ShoperProductTranslation | undefined,
  options: BuildContextOptions = {}
): ProductContext {
  const title =
    truncate(
      stripHtml(String(translation?.name ?? product.code ?? `#${product.product_id}`)),
      MAX_TITLE_CHARS
    ) || `#${product.product_id}`;

  const context: ProductContext = { title };

  if (options.categoryPath) context.category = options.categoryPath;
  if (options.brand) context.brand = options.brand;

  const price = product.stock?.price;
  if (price !== undefined && price !== null && Number.isFinite(Number(price))) {
    context.price = Number(price);
    if (options.currency) context.currency = options.currency;
  }

  const sku = product.stock?.sku ?? product.code;
  if (sku) context.sku = String(sku);
  const ean = product.ean ?? product.stock?.ean;
  if (ean) context.ean = String(ean);

  const attributes = flattenAttributes(product.attributes, options.attributeLabels);
  if (Object.keys(attributes).length > 0) context.attributes = sortRecord(attributes);

  if (options.includeVariants !== false && options.variants && options.variants.length > 0) {
    const active = options.variants.filter((v) => v.active !== false);
    const summaries = summariseVariants(active.length > 0 ? active : options.variants);
    if (summaries.length > 0) context.variants = summaries;
  }

  if (options.includeDescription !== false) {
    const source = translation?.description ?? translation?.short_description;
    if (source) {
      const plain = stripHtml(String(source));
      if (plain) context.current_description = truncate(plain, MAX_DESCRIPTION_CHARS);
    }
  }

  return trimContext(context, options.tokenBudget ?? DEFAULT_CONTEXT_TOKEN_BUDGET);
}

/**
 * Build a context for one product, resolving category path / brand / currency
 * / attribute labels / variants through the Shoper client. All lookups are
 * cached inside ShoperClient, so a bulk run pays for them once.
 */
export async function buildProductContext(
  shoper: ShoperClient,
  product: ShoperProduct,
  options: BuildContextOptions = {}
): Promise<ProductContext> {
  const translation = shoper.productTranslation(product);
  const resolved: BuildContextOptions = { ...options };

  if (resolved.categoryPath === undefined && product.category_id !== undefined && product.category_id !== null) {
    resolved.categoryPath = await shoper
      .categoryPath(Number(product.category_id))
      .catch(() => undefined);
  }
  if (
    resolved.brand === undefined &&
    product.producer_id !== undefined &&
    product.producer_id !== null
  ) {
    const producers = await shoper.producerNameMap().catch(() => undefined);
    resolved.brand = producers?.get(Number(product.producer_id));
  }
  if (resolved.currency === undefined) {
    resolved.currency = await shoper.defaultCurrencyCode().catch(() => undefined);
  }
  if (resolved.attributeLabels === undefined && hasNumericAttributeKeys(product.attributes)) {
    resolved.attributeLabels = await attributeLabelMap(shoper).catch(() => undefined);
  }
  if (resolved.variants === undefined && options.includeVariants) {
    resolved.variants = await shoper
      .getProductVariants(Number(product.product_id))
      .catch(() => []);
  }

  return buildProductContextSync(product, translation, resolved);
}

/**
 * attribute_id -> "Group / Name" labels. Delegates to the client's cached
 * lookup so a bulk run pays for the attribute + group reads once.
 */
export async function attributeLabelMap(
  shoper: ShoperClient
): Promise<Map<number, string>> {
  return shoper.attributeLabelMap();
}

function hasNumericAttributeKeys(raw: unknown): boolean {
  if (!raw) return false;
  if (Array.isArray(raw)) return raw.length > 0;
  if (typeof raw !== "object") return false;
  for (const value of Object.values(raw as Record<string, unknown>)) {
    if (value && typeof value === "object" && !Array.isArray(value)) {
      for (const key of Object.keys(value as Record<string, unknown>)) {
        if (Number.isFinite(Number(key))) return true;
      }
    }
  }
  for (const key of Object.keys(raw as Record<string, unknown>)) {
    if (Number.isFinite(Number(key))) return true;
  }
  return false;
}

/**
 * Batch context builder for a bulk job: resolves the shared lookups once and
 * then builds each product's context. `products` is expected to be at most a
 * few hundred entries (one bridge job).
 */
export async function buildProductContexts(
  shoper: ShoperClient,
  products: readonly ShoperProduct[],
  options: BuildContextOptions = {}
): Promise<Map<number, ProductContext>> {
  const out = new Map<number, ProductContext>();
  if (products.length === 0) return out;

  const needsLabels = products.some((p) => hasNumericAttributeKeys(p.attributes));
  const [categoryIndex, producers, currency, attributeLabels] = await Promise.all([
    shoper.categoryIndex().catch(() => undefined),
    shoper.producerNameMap().catch(() => undefined),
    shoper.defaultCurrencyCode().catch(() => undefined),
    needsLabels ? attributeLabelMap(shoper).catch(() => undefined) : Promise.resolve(undefined),
  ]);

  for (const product of products) {
    const productId = Number(product.product_id);
    const perProduct: BuildContextOptions = { ...options };
    if (currency !== undefined) perProduct.currency = currency;
    if (attributeLabels !== undefined) perProduct.attributeLabels = attributeLabels;
    if (product.category_id !== undefined && product.category_id !== null) {
      const node = categoryIndex?.get(Number(product.category_id));
      if (node) perProduct.categoryPath = node.path_label;
    }
    if (product.producer_id !== undefined && product.producer_id !== null) {
      const brand = producers?.get(Number(product.producer_id));
      if (brand) perProduct.brand = brand;
    }
    if (options.includeVariants) {
      perProduct.variants = await shoper.getProductVariants(productId).catch(() => []);
    }
    out.set(
      productId,
      buildProductContextSync(product, shoper.productTranslation(product), perProduct)
    );
  }
  return out;
}

/**
 * Pick the best source image URL for an image job: the main image when
 * present, otherwise the first visible image by display order.
 */
export async function pickSourceImageUrl(
  shoper: ShoperClient,
  productId: number
): Promise<string | undefined> {
  const images = await shoper.getProductImages(productId).catch(() => []);
  const visible = images.filter((i) => !isTruthy(i.hidden));
  const main = visible.find((i) => isTruthy(i.main)) ?? visible[0];
  return main ? shoper.imageUrl(main) : undefined;
}

/** Exported for tests: the page limit the picker uses. */
export const PICKER_PAGE_LIMIT = MAX_PAGE_LIMIT;
