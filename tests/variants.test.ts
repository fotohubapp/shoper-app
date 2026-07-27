/**
 * Variant support, end to end through the layer a merchant actually reaches.
 * The plumbing existed for a while with no caller, which is the worst state for
 * a feature to be in: it reads as shipped in the code and is unreachable in the
 * product. These tests pin the whole path — the extra /product-stocks read is
 * opt-in, the option labels come out human-readable, the summaries land in
 * product_context, and nothing is fetched when the flag is off.
 */

import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { summariseVariants } from "../src/product-context";
import { ShoperClient } from "../src/shoper-client";
import type { JobItemSource } from "../src/server";
import type { JobItemInput, JobKind, ProductVariant, ShoperProduct } from "../src/types";
import { FetchStub, listBody, tempDir } from "./helpers";

/**
 * buildJobItems lives in server.ts, whose module body opens the SQLite store, so
 * the value is imported dynamically with a throwaway DATA_DIR. The type-only
 * import above costs nothing at runtime.
 */
let buildJobItems: (
  shoper: JobItemSource,
  kind: JobKind,
  productIds: readonly number[],
  options?: { includeVariants?: boolean }
) => Promise<JobItemInput[]>;
let releaseDir: (() => void) | undefined;

beforeAll(async () => {
  const temp = tempDir();
  releaseDir = temp.cleanup;
  process.env["DATA_DIR"] = temp.dir;
  process.env["FOTOHUB_CONFIG_SECRET"] = "0123456789abcdef0123456789abcdef";
  ({ buildJobItems } = await import("../src/server"));
});

afterAll(() => {
  releaseDir?.();
});

const PRODUCT: ShoperProduct = {
  product_id: 7,
  code: "BUTY",
  ean: "1234567890123",
  stock: { sku: "BUTY-SKU", price: 199.99, active: 1 },
  translations: { pl_PL: { name: "Buty sportowe", description: "<p>Opis</p>" } },
} as unknown as ShoperProduct;

/** Minimal JobItemSource whose variant lookup is observable. */
function source(
  variants: ProductVariant[] | Error,
  overrides: Partial<JobItemSource> = {}
): { shoper: JobItemSource; variantCalls: number[] } {
  const variantCalls: number[] = [];
  const shoper = {
    translationLocale: "pl_PL",
    getProduct: async () => PRODUCT,
    toSummary: () => ({
      product_id: 7,
      name: "Buty sportowe",
      description_length: 4,
      short_description_length: 0,
      image_count: 0,
      sku: "BUTY-SKU",
      price: 199.99,
      category_id: 12,
    }),
    getProductImages: async () => [],
    imageUrl: () => undefined,
    getProductVariants: async (productId: number) => {
      variantCalls.push(productId);
      if (variants instanceof Error) throw variants;
      return variants;
    },
    ...overrides,
  } as unknown as JobItemSource;
  return { shoper, variantCalls };
}

function variant(options: Record<string, string>, extra: Partial<ProductVariant> = {}): ProductVariant {
  return { stock_id: 1, product_id: 7, active: true, options, ...extra };
}

describe("buildJobItems with includeVariants", () => {
  it("does not read variants at all when the flag is off", async () => {
    // The lookup costs one extra Shoper request per product, which is why it is
    // opt-in rather than always on.
    const { shoper, variantCalls } = source([variant({ Rozmiar: "42" })]);
    const items = await buildJobItems(shoper, "description", [7]);
    expect(variantCalls).toEqual([]);
    expect(items[0]!.product_context?.variants).toBeUndefined();
  });

  it("ignores a falsy or absent flag rather than guessing", async () => {
    const { shoper, variantCalls } = source([variant({ Rozmiar: "42" })]);
    await buildJobItems(shoper, "description", [7], {});
    await buildJobItems(shoper, "description", [7], { includeVariants: false });
    expect(variantCalls).toEqual([]);
  });

  it("puts human-readable option combinations into product_context", async () => {
    // This is the whole point of the feature: the model gets "Rozmiar: 42"
    // instead of a stock id, so generated copy can name real sizes.
    const { shoper, variantCalls } = source([
      variant({ Rozmiar: "42", Kolor: "czerwony" }, { stock_id: 1 }),
      variant({ Rozmiar: "43", Kolor: "czerwony" }, { stock_id: 2 }),
    ]);

    const items = await buildJobItems(shoper, "description", [7], { includeVariants: true });

    expect(variantCalls).toEqual([7]);
    expect(items[0]!.product_context?.variants).toEqual([
      "Kolor: czerwony, Rozmiar: 42",
      "Kolor: czerwony, Rozmiar: 43",
    ]);
  });

  it("prefers active variants and falls back when none are active", async () => {
    const activeOnly = source([
      variant({ Rozmiar: "42" }, { stock_id: 1, active: true }),
      variant({ Rozmiar: "43" }, { stock_id: 2, active: false }),
    ]);
    const withActive = await buildJobItems(activeOnly.shoper, "description", [7], {
      includeVariants: true,
    });
    // A discontinued size must not be advertised as available.
    expect(withActive[0]!.product_context?.variants).toEqual(["Rozmiar: 42"]);

    const noneActive = source([
      variant({ Rozmiar: "42" }, { stock_id: 1, active: false }),
      variant({ Rozmiar: "43" }, { stock_id: 2, active: false }),
    ]);
    const fallback = await buildJobItems(noneActive.shoper, "description", [7], {
      includeVariants: true,
    });
    // Better to describe an out-of-stock range than to omit variants entirely.
    expect(fallback[0]!.product_context?.variants).toHaveLength(2);
  });

  it("omits the field when a store has no variants", async () => {
    const { shoper } = source([]);
    const items = await buildJobItems(shoper, "description", [7], { includeVariants: true });
    expect(items[0]!.product_context?.variants).toBeUndefined();
  });

  it("omits the field when variant rows carry no options", async () => {
    // Every simple product has one bare product-stocks row; turning that into a
    // variant list would feed the model noise.
    const { shoper } = source([variant({})]);
    const items = await buildJobItems(shoper, "description", [7], { includeVariants: true });
    expect(items[0]!.product_context?.variants).toBeUndefined();
  });

  it("does not fail the whole submission when the lookup is denied", async () => {
    // /product-stocks needs its own webapi permission, so a 403 here is normal
    // in the field and must degrade to "no variants", not kill the job.
    const { shoper } = source(new Error("Shoper GET /product-stocks failed with 403"));
    const items = await buildJobItems(shoper, "description", [7], { includeVariants: true });
    expect(items).toHaveLength(1);
    expect(items[0]!.product_context?.variants).toBeUndefined();
  });

  it("carries the rest of the context regardless of the flag", async () => {
    const { shoper } = source([variant({ Rozmiar: "42" })]);
    const items = await buildJobItems(shoper, "description", [7], { includeVariants: true });
    expect(items[0]).toMatchObject({
      external_id: "7",
      sku: "BUTY-SKU",
      product_context: {
        title: "Buty sportowe",
        category: "12",
        price: 199.99,
        attributes: { ean: "1234567890123", code: "BUTY" },
      },
    });
  });

  it("reads variants once per product across a batch", async () => {
    const { shoper, variantCalls } = source([variant({ Rozmiar: "42" })]);
    await buildJobItems(shoper, "description", [7, 8, 9], { includeVariants: true });
    expect(variantCalls).toEqual([7, 8, 9]);
  });

  it("skips the image read for text-only kinds and performs it otherwise", async () => {
    const imageCalls: number[] = [];
    const overrides = {
      getProductImages: async (productId: number) => {
        imageCalls.push(productId);
        return [{ gfx_id: 5, main: "1", name: "a.jpg" }];
      },
      imageUrl: () => "https://shop.example/userdata/public/gfx/5/a.jpg",
    } as Partial<JobItemSource>;

    for (const kind of ["description", "alt_text"] as const) {
      const { shoper } = source([], overrides);
      const items = await buildJobItems(shoper, kind, [7]);
      expect(items[0]!.source_image_url).toBeUndefined();
    }
    expect(imageCalls).toEqual([]);

    const { shoper } = source([], overrides);
    const items = await buildJobItems(shoper, "bg_remove", [7]);
    expect(items[0]!.source_image_url).toContain("/gfx/5/a.jpg");
    expect(imageCalls).toEqual([7]);
  });
});

describe("summariseVariants", () => {
  it("sorts option keys so the same combination always renders identically", () => {
    // Stable ordering keeps the prompt deterministic across products.
    expect(summariseVariants([variant({ Rozmiar: "42", Kolor: "czerwony" })])).toEqual([
      "Kolor: czerwony, Rozmiar: 42",
    ]);
    expect(summariseVariants([variant({ Kolor: "czerwony", Rozmiar: "42" })])).toEqual([
      "Kolor: czerwony, Rozmiar: 42",
    ]);
  });

  it("de-duplicates identical combinations", () => {
    const rows = [
      variant({ Rozmiar: "42" }, { stock_id: 1 }),
      variant({ Rozmiar: "42" }, { stock_id: 2 }),
    ];
    expect(summariseVariants(rows)).toEqual(["Rozmiar: 42"]);
  });

  it("caps the list so a 500-variant product cannot blow the prompt budget", () => {
    const rows = Array.from({ length: 500 }, (_, i) =>
      variant({ Rozmiar: String(i) }, { stock_id: i })
    );
    const summaries = summariseVariants(rows);
    expect(summaries.length).toBeGreaterThan(0);
    expect(summaries.length).toBeLessThan(500);
  });

  it("skips rows with no options", () => {
    expect(summariseVariants([variant({})])).toEqual([]);
  });
});

describe("ShoperClient.getProductVariants", () => {
  const STORE = "https://sklep123456.shoparena.pl";

  function client(stub: FetchStub): ShoperClient {
    return new ShoperClient({
      storeUrl: STORE,
      accessToken: "static-token",
      fetchImpl: stub.fetch,
      requestsPerSecond: 10_000,
      etagCache: false,
    });
  }

  it("joins product-stocks rows with option and value labels", async () => {
    const stub = new FetchStub()
      .push({
        body: listBody([
          {
            stock_id: 55,
            product_id: 7,
            sku: "BUTY-42",
            price: "199.99",
            stock: "3",
            active: "1",
            option: { "10": 100 },
          },
        ]),
      })
      // optionLabels() reads /options and /option-values in parallel.
      .push({ body: listBody([{ option_id: 10, translations: { pl_PL: { name: "Rozmiar" } } }]) })
      .push({
        body: listBody([
          { value_id: 100, option_id: 10, translations: { pl_PL: { value: "42" } } },
        ]),
      });

    const variants = await client(stub).getProductVariants(7);

    expect(variants).toHaveLength(1);
    expect(variants[0]).toMatchObject({
      stock_id: 55,
      product_id: 7,
      sku: "BUTY-42",
      price: 199.99,
      stock: 3,
      active: true,
      options: { Rozmiar: "42" },
    });
  });

  it("filters product-stocks by product id rather than scanning the store", async () => {
    const stub = new FetchStub()
      .push({ body: listBody([]) })
      .setFallback({ body: listBody([]) });
    await client(stub).getProductVariants(7);
    expect(stub.calls[0]!.url).toContain("/product-stocks");
    expect(decodeURIComponent(stub.calls[0]!.url)).toContain('{"product_id":7}');
  });

  it("returns an empty list without reading labels when there are no rows", async () => {
    // A simple product should not pay for the /options + /option-values reads.
    const stub = new FetchStub().push({ body: listBody([]) });
    await expect(client(stub).getProductVariants(7)).resolves.toEqual([]);
    expect(stub.calls).toHaveLength(1);
  });

  it("falls back to raw ids when the label lookup is denied", async () => {
    // Losing the labels degrades prompt quality; failing the call would lose
    // the variants entirely.
    const stub = new FetchStub()
      .push({
        body: listBody([{ stock_id: 55, product_id: 7, active: "1", option: { "10": 100 } }]),
      })
      .setFallback({ status: 403, body: { error: "Forbidden" } });

    const variants = await client(stub).getProductVariants(7);
    expect(variants[0]!.options).toEqual({ option_10: "100" });
  });

  it("treats a row with no active flag as active", async () => {
    const stub = new FetchStub()
      .push({ body: listBody([{ stock_id: 55, product_id: 7, option: {} }]) })
      .setFallback({ body: listBody([]) });
    const variants = await client(stub).getProductVariants(7);
    expect(variants[0]!.active).toBe(true);
  });
});
