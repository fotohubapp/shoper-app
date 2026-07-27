/**
 * Write-back is the only code that mutates a merchant's live catalogue, and
 * image uploads are additive — Shoper assigns a fresh gfx_id every time — so a
 * double-apply silently duplicates product photos with no undo. The journal is
 * what prevents that, and the image and text phases are journalled separately so
 * a text failure after a successful upload does not force a duplicate image on
 * retry. Both halves of that contract are pinned here.
 */

import { describe, expect, it, vi } from "vitest";
import { ShoperClient } from "../src/shoper-client";
import {
  MemoryWriteBackJournal,
  ShoperWriteBack,
  assertSafeImageUrl,
  downloadImage,
  imagePhase,
  sanitiseHtml,
  sniffImageMime,
  textToTranslationPatch,
} from "../src/writeback";
import { ImageFetchError, ShoperApiError } from "../src/types";
import type { DraftPayload } from "../src/types";
import { FetchStub, PNG_BYTES } from "./helpers";

const IMAGE_URL = "https://cdn.fotohub.app/results/img-1.png";

/**
 * Fake Shoper client recording every write. Typed as ShoperClient because
 * ShoperWriteBack only touches the handful of methods stubbed here, and a real
 * client would need a socket.
 */
function fakeShoper(overrides: Partial<Record<string, unknown>> = {}): {
  client: ShoperClient;
  uploads: Array<{ productId: number; options: Record<string, unknown> }>;
  translations: Array<{ productId: number; patch: Record<string, unknown>; locale?: string }>;
  altWrites: Array<{ gfxId: number; alt: string; locale: string }>;
  mainPromotions: number[];
} {
  const uploads: Array<{ productId: number; options: Record<string, unknown> }> = [];
  const translations: Array<{
    productId: number;
    patch: Record<string, unknown>;
    locale?: string;
  }> = [];
  const altWrites: Array<{ gfxId: number; alt: string; locale: string }> = [];
  const mainPromotions: number[] = [];
  let nextGfxId = 100;

  const client = {
    translationLocale: "pl_PL",
    getProductImages: async () => [],
    imageAlt: () => undefined,
    addProductImageBase64: async (
      productId: number,
      _base64: string,
      options: Record<string, unknown>
    ) => {
      uploads.push({ productId, options });
      nextGfxId += 1;
      return nextGfxId;
    },
    updateProductTranslations: async (
      productId: number,
      patch: Record<string, unknown>,
      locale?: string
    ) => {
      translations.push({ productId, patch, ...(locale ? { locale } : {}) });
    },
    updateProductTranslationsMulti: async (
      productId: number,
      perLocale: Record<string, Record<string, unknown>>
    ) => {
      for (const [locale, patch] of Object.entries(perLocale)) {
        translations.push({ productId, patch, locale });
      }
    },
    updateProductImageAlt: async (gfxId: number, alt: string, locale: string) => {
      altWrites.push({ gfxId, alt, locale });
    },
    setMainProductImage: async (gfxId: number) => {
      mainPromotions.push(gfxId);
    },
    getProductVariants: async () => [],
    ...overrides,
  } as unknown as ShoperClient;

  return { client, uploads, translations, altWrites, mainPromotions };
}

/** Fetch stub that serves real PNG bytes for the image download path. */
function imageFetch(times = 1): FetchStub {
  const stub = new FetchStub();
  stub.pushMany(times, {
    bytes: PNG_BYTES,
    headers: { "content-type": "image/png" },
  });
  return stub;
}

const imagePayload: DraftPayload = {
  images: [{ url: IMAGE_URL, alt_text: "Czerwone buty" }],
};

describe("journal idempotency", () => {
  it("uploads on the first apply and writes nothing on the second", async () => {
    const journal = new MemoryWriteBackJournal();
    const { client, uploads } = fakeShoper();
    const writeBack = new ShoperWriteBack(client, { journal, fetchImpl: imageFetch(2).fetch });

    const first = await writeBack.apply(7, imagePayload, "item-1");
    expect(first.applied_images).toBe(1);
    expect(uploads).toHaveLength(1);

    const second = await writeBack.apply(7, imagePayload, "item-1");
    // The observable proof is that no second upload happened, not that a flag
    // was set: a duplicate here means a duplicate photo in the merchant's shop.
    expect(second.applied_images).toBe(0);
    expect(second.skipped).toContain("already_applied");
    expect(uploads).toHaveLength(1);
  });

  it("keys idempotency per bridge item, so a different item still writes", async () => {
    const journal = new MemoryWriteBackJournal();
    const { client, uploads } = fakeShoper();
    const writeBack = new ShoperWriteBack(client, { journal, fetchImpl: imageFetch(2).fetch });

    await writeBack.apply(7, imagePayload, "item-1");
    await writeBack.apply(8, imagePayload, "item-2");
    expect(uploads.map((u) => u.productId)).toEqual([7, 8]);
  });

  it("journals the image phase separately from the item", async () => {
    const journal = new MemoryWriteBackJournal();
    const { client } = fakeShoper();
    const writeBack = new ShoperWriteBack(client, { journal, fetchImpl: imageFetch().fetch });

    await writeBack.apply(7, imagePayload, "item-1");
    expect(journal.wasApplied("item-1")).toBe(true);
    expect(journal.wasApplied(imagePhase("item-1"))).toBe(true);
    expect(imagePhase("item-1")).toBe("item-1#images");
  });

  it("does not re-upload the image when a retry follows a text failure", async () => {
    // This is the reason the phases are split. The first attempt uploads the
    // image and then dies writing text; the retry must write the text and
    // upload NOTHING, because the photo is already on the product.
    const journal = new MemoryWriteBackJournal();
    let textCalls = 0;
    const { client, uploads, translations } = fakeShoper({
      updateProductTranslations: async (
        productId: number,
        patch: Record<string, unknown>
      ) => {
        textCalls += 1;
        if (textCalls === 1) throw new ShoperApiError("Shoper PUT failed with 500", 500);
        translations.push({ productId, patch });
      },
    });
    const mixed: DraftPayload = {
      images: [{ url: IMAGE_URL }],
      text: { title: "Nowa nazwa" },
    };
    const writeBack = new ShoperWriteBack(client, { journal, fetchImpl: imageFetch(2).fetch });

    await expect(writeBack.apply(7, mixed, "item-1")).rejects.toThrow(/500/);
    expect(uploads).toHaveLength(1);
    // The item key must NOT be journalled after a failure, or the retry would
    // be skipped entirely and the text would never land.
    expect(journal.wasApplied("item-1")).toBe(false);
    expect(journal.wasApplied(imagePhase("item-1"))).toBe(true);

    const retry = await writeBack.apply(7, mixed, "item-1");
    expect(uploads).toHaveLength(1);
    expect(retry.skipped).toContain("images_already_applied");
    expect(retry.applied_fields).toContain("name");
    expect(journal.wasApplied("item-1")).toBe(true);
  });

  it("writes without a journal when none is configured", async () => {
    const { client, uploads } = fakeShoper();
    const writeBack = new ShoperWriteBack(client, { fetchImpl: imageFetch(2).fetch });
    await writeBack.apply(7, imagePayload, "item-1");
    await writeBack.apply(7, imagePayload, "item-1");
    // No journal means no suppression — documented, and the caller's choice.
    expect(uploads).toHaveLength(2);
  });

  it("does not journal the image phase when every upload failed", async () => {
    const journal = new MemoryWriteBackJournal();
    const { client } = fakeShoper();
    const stub = new FetchStub().setFallback({ status: 404 });
    const writeBack = new ShoperWriteBack(client, {
      journal,
      fetchImpl: stub.fetch,
      imageAttempts: 1,
    });

    await expect(writeBack.apply(7, imagePayload, "item-1")).rejects.toThrow(
      /No image could be written back/
    );
    // Nothing landed, so a retry must be free to try again.
    expect(journal.wasApplied(imagePhase("item-1"))).toBe(false);
    expect(journal.wasApplied("item-1")).toBe(false);
  });
});

describe("image apply", () => {
  it("sends base64 content, ALT text and the ordering index", async () => {
    const { client, uploads } = fakeShoper();
    const writeBack = new ShoperWriteBack(client, { fetchImpl: imageFetch().fetch });
    await writeBack.apply(7, imagePayload, "item-1");

    const upload = uploads[0]!;
    expect(upload.productId).toBe(7);
    expect(upload.options["altText"]).toBe("Czerwone buty");
    expect(upload.options["title"]).toBe("Czerwone buty");
    expect(upload.options["order"]).toBe(0);
    expect(String(upload.options["name"])).toMatch(/^fotohub-7-\d+-0\.png$/);
  });

  it("appends after the images the product already has", async () => {
    const { client, uploads } = fakeShoper({
      getProductImages: async () => [{ gfx_id: 1 }, { gfx_id: 2 }],
    });
    const writeBack = new ShoperWriteBack(client, { fetchImpl: imageFetch().fetch });
    await writeBack.apply(7, imagePayload, "item-1");
    expect(uploads[0]!.options["order"]).toBe(2);
  });

  it("promotes a main image explicitly, because some Shoper versions ignore the flag", async () => {
    const { client, mainPromotions } = fakeShoper();
    const writeBack = new ShoperWriteBack(client, { fetchImpl: imageFetch().fetch });
    await writeBack.apply(7, { images: [{ url: IMAGE_URL, main: true }] }, "item-1");
    expect(mainPromotions).toHaveLength(1);
  });

  it("mirrors ALT text into the secondary locale when configured", async () => {
    const { client, uploads } = fakeShoper();
    const writeBack = new ShoperWriteBack(client, {
      fetchImpl: imageFetch().fetch,
      mirrorLocale: "en_US",
    });
    await writeBack.apply(7, imagePayload, "item-1");
    expect(uploads[0]!.options["extraLocales"]).toEqual(["en_US"]);
  });

  it("retries a transient download failure, then succeeds", async () => {
    const stub = new FetchStub()
      .push({ status: 503 })
      .push({ bytes: PNG_BYTES, headers: { "content-type": "image/png" } });
    const { client, uploads } = fakeShoper();
    const writeBack = new ShoperWriteBack(client, {
      fetchImpl: stub.fetch,
      imageAttempts: 2,
    });

    const result = await writeBack.apply(7, imagePayload, "item-1");
    expect(result.applied_images).toBe(1);
    expect(stub.calls).toHaveLength(2);
    expect(uploads).toHaveLength(1);
  });

  it("does not retry a permanently rejected URL", async () => {
    // A blocked scheme will never become allowed, so a retry only wastes time.
    const stub = new FetchStub();
    const { client } = fakeShoper();
    const writeBack = new ShoperWriteBack(client, {
      fetchImpl: stub.fetch,
      imageAttempts: 3,
    });

    await expect(
      writeBack.apply(7, { images: [{ url: "ftp://example.com/x.png" }] }, "item-1")
    ).rejects.toThrow(/No image could be written back/);
    expect(stub.calls).toHaveLength(0);
  });

  it("throws rather than half-succeeding when nothing could be uploaded", async () => {
    // The draft must stay pending so the merchant can retry; silently
    // reporting success would lose the generated image.
    const { client } = fakeShoper();
    const stub = new FetchStub().setFallback({ status: 500 });
    const writeBack = new ShoperWriteBack(client, { fetchImpl: stub.fetch, imageAttempts: 1 });
    await expect(writeBack.apply(7, imagePayload, "item-1")).rejects.toBeInstanceOf(
      ShoperApiError
    );
  });

  it("reports a partial batch as applied with warnings", async () => {
    const stub = new FetchStub()
      .push({ bytes: PNG_BYTES, headers: { "content-type": "image/png" } })
      .setFallback({ status: 404 });
    const { client, uploads } = fakeShoper();
    const writeBack = new ShoperWriteBack(client, { fetchImpl: stub.fetch, imageAttempts: 1 });

    const result = await writeBack.apply(
      7,
      { images: [{ url: IMAGE_URL }, { url: "https://cdn.fotohub.app/gone.png" }] },
      "item-1"
    );
    expect(result.applied_images).toBe(1);
    expect(uploads).toHaveLength(1);
    expect(result.warnings.join(" ")).toMatch(/image 2/);
  });
});

describe("text apply", () => {
  it("maps bridge fields onto Shoper translation fields", () => {
    const patch = textToTranslationPatch({
      title: "  Buty   sportowe ",
      short_description: "<p>Krótki</p>",
      description: "<p>Długi</p>",
      meta_title: "Meta",
      meta_description: "Meta opis",
      meta_keywords: "buty, sport",
    });
    expect(patch).toEqual({
      name: "Buty sportowe",
      short_description: "<p>Krótki</p>",
      description: "<p>Długi</p>",
      seo_title: "Meta",
      seo_description: "Meta opis",
      seo_keywords: "buty, sport",
    });
  });

  it("never maps alt_text onto the product", () => {
    // ALT text belongs on an image row; writing it to the product would
    // overwrite a real field with a caption.
    const patch = textToTranslationPatch({ alt_text: "Czerwone buty" });
    expect(patch).toEqual({});
  });

  it("honours an explicit field allowlist", () => {
    const patch = textToTranslationPatch(
      { title: "T", description: "D", meta_title: "M" },
      { fields: ["title"] }
    );
    expect(patch).toEqual({ name: "T" });
  });

  it("clamps over-long SEO values with an ellipsis", () => {
    const patch = textToTranslationPatch({ meta_title: "x".repeat(400) });
    expect(patch.seo_title).toHaveLength(255);
    expect(patch.seo_title?.endsWith("…")).toBe(true);
  });

  it("sanitises HTML by default and leaves it alone when disabled", () => {
    const dirty = '<p>ok</p><script>alert(1)</script><img src=x onerror="bad()">';
    expect(textToTranslationPatch({ description: dirty }).description).not.toContain("script");
    expect(
      textToTranslationPatch({ description: dirty }, { sanitiseHtml: false }).description
    ).toBe(dirty);
  });

  it("writes the patch to one locale, or to both when mirroring", async () => {
    const single = fakeShoper();
    await new ShoperWriteBack(single.client, {}).apply(7, { text: { title: "T" } }, "i1");
    expect(single.translations).toEqual([
      { productId: 7, patch: { name: "T" }, locale: "pl_PL" },
    ]);

    const mirrored = fakeShoper();
    await new ShoperWriteBack(mirrored.client, { mirrorLocale: "en_US" }).apply(
      7,
      { text: { title: "T" } },
      "i1"
    );
    expect(mirrored.translations.map((t) => t.locale)).toEqual(["pl_PL", "en_US"]);
  });

  it("prefers the locale recorded on the draft payload", async () => {
    const { client, translations } = fakeShoper();
    await new ShoperWriteBack(client, {}).apply(
      7,
      { text: { title: "T" }, locale: "de_DE" },
      "i1"
    );
    expect(translations[0]!.locale).toBe("de_DE");
  });

  it("applies ALT text to existing images only when no new image was added", async () => {
    const withExisting = fakeShoper({
      getProductImages: async () => [{ gfx_id: 5 }, { gfx_id: 6 }],
    });
    const result = await new ShoperWriteBack(withExisting.client, {}).apply(
      7,
      { text: { alt_text: "Opis zdjęcia" } },
      "i1"
    );
    expect(withExisting.altWrites.map((a) => a.gfxId)).toEqual([5, 6]);
    expect(result.applied_fields).toContain("alt_text");
  });

  it("does not touch existing ALT text when the job added a fresh image", async () => {
    // A new upload already carries its own ALT, so rewriting the old images
    // would relabel photos the job never generated.
    const stub = imageFetch();
    const { client, altWrites } = fakeShoper({
      getProductImages: async () => [{ gfx_id: 5 }],
    });
    await new ShoperWriteBack(client, { fetchImpl: stub.fetch }).apply(
      7,
      { images: [{ url: IMAGE_URL }], text: { alt_text: "Opis" } },
      "i1"
    );
    expect(altWrites).toHaveLength(0);
  });

  it("skips images that already have ALT text unless overwrite is on", async () => {
    const base = {
      getProductImages: async () => [{ gfx_id: 5 }],
      imageAlt: () => "istniejący opis",
    };
    const guarded = fakeShoper(base);
    const guardedResult = await new ShoperWriteBack(guarded.client, {}).apply(
      7,
      { text: { alt_text: "Nowy" } },
      "i1"
    );
    expect(guarded.altWrites).toHaveLength(0);
    expect(guardedResult.warnings).toContain("all images already had ALT text");

    const forced = fakeShoper(base);
    await new ShoperWriteBack(forced.client, { overwriteExistingAlt: true }).apply(
      7,
      { text: { alt_text: "Nowy" } },
      "i1"
    );
    expect(forced.altWrites).toHaveLength(1);
  });

  it("records a warning instead of throwing when one ALT write fails", async () => {
    const { client } = fakeShoper({
      getProductImages: async () => [{ gfx_id: 5 }],
      updateProductImageAlt: async () => {
        throw new ShoperApiError("Shoper PUT failed with 500", 500);
      },
    });
    const result = await new ShoperWriteBack(client, {}).apply(
      7,
      { text: { alt_text: "Nowy" } },
      "i1"
    );
    expect(result.warnings.join(" ")).toMatch(/alt text on gfx 5/);
  });
});

describe("variant image write-back", () => {
  it("folds the option label into ALT text and warns it is product-level", async () => {
    // Shoper has no per-stock image table, so the honest outcome is: the photo
    // lands in the product gallery and only the ALT text names the variant.
    const { client, uploads } = fakeShoper({
      getProductVariants: async () => [
        {
          stock_id: 55,
          product_id: 7,
          sku: "BUTY-42",
          active: true,
          options: { Rozmiar: "42", Kolor: "czerwony" },
        },
      ],
    });
    const writeBack = new ShoperWriteBack(client, { fetchImpl: imageFetch().fetch });

    const result = await writeBack.applyVariantImages(
      7,
      55,
      { images: [{ url: IMAGE_URL, alt_text: "Buty" }] },
      "item-1"
    );

    expect(uploads[0]!.options["altText"]).toBe("Buty — Rozmiar: 42, Kolor: czerwony");
    expect(result.warnings.join(" ")).toContain("Shoper stores images per product");
    expect(result.warnings.join(" ")).toContain("BUTY-42");
  });

  it("drops the text half, because a variant has no own description", async () => {
    const { client, translations } = fakeShoper({
      getProductVariants: async () => [
        { stock_id: 55, product_id: 7, active: true, options: { Rozmiar: "42" } },
      ],
    });
    const writeBack = new ShoperWriteBack(client, { fetchImpl: imageFetch().fetch });
    await writeBack.applyVariantImages(
      7,
      55,
      { images: [{ url: IMAGE_URL }], text: { title: "Nie zapisuj" } },
      "item-1"
    );
    expect(translations).toHaveLength(0);
  });

  it("still uploads when the variant row cannot be resolved", async () => {
    const { client, uploads } = fakeShoper();
    const writeBack = new ShoperWriteBack(client, { fetchImpl: imageFetch().fetch });
    const result = await writeBack.applyVariantImages(
      7,
      999,
      { images: [{ url: IMAGE_URL, alt_text: "Buty" }] },
      "item-1"
    );
    expect(uploads).toHaveLength(1);
    expect(result.applied_images).toBe(1);
  });

  it("is idempotent through the same journal", async () => {
    const journal = new MemoryWriteBackJournal();
    const { client, uploads } = fakeShoper();
    const writeBack = new ShoperWriteBack(client, {
      journal,
      fetchImpl: imageFetch(2).fetch,
    });
    await writeBack.applyVariantImages(7, 55, { images: [{ url: IMAGE_URL }] }, "item-1");
    const second = await writeBack.applyVariantImages(
      7,
      55,
      { images: [{ url: IMAGE_URL }] },
      "item-1"
    );
    expect(uploads).toHaveLength(1);
    expect(second.skipped).toContain("already_applied");
  });
});

describe("image download guards", () => {
  it("requires https by default and allows http only on request", () => {
    expect(() => assertSafeImageUrl("http://cdn.fotohub.app/x.png")).toThrow(ImageFetchError);
    expect(
      assertSafeImageUrl("http://cdn.fotohub.app/x.png", { requireHttps: false }).protocol
    ).toBe("http:");
  });

  it("blocks non-http schemes even when https is not required", () => {
    for (const url of ["file:///etc/passwd", "ftp://h/x.png", "data:image/png;base64,AA"]) {
      expect(() => assertSafeImageUrl(url, { requireHttps: false })).toThrow(ImageFetchError);
    }
  });

  it("enforces the host allowlist, including subdomains", () => {
    const limits = { allowedHosts: ["fotohub.app"] };
    expect(assertSafeImageUrl("https://cdn.fotohub.app/x.png", limits).hostname).toBe(
      "cdn.fotohub.app"
    );
    expect(() => assertSafeImageUrl("https://evil.example/x.png", limits)).toThrow(
      /host not allowed/
    );
    // Suffix matching must not accept a lookalike domain.
    expect(() => assertSafeImageUrl("https://notfotohub.app/x.png", limits)).toThrow(
      /host not allowed/
    );
  });

  it("rejects a malformed URL", () => {
    expect(() => assertSafeImageUrl("not a url")).toThrow(/Not a valid URL/);
  });

  it("rejects a body larger than maxBytes, declared or actual", async () => {
    const declared = new FetchStub().push({
      bytes: PNG_BYTES,
      headers: { "content-type": "image/png", "content-length": "999999999" },
    });
    await expect(
      downloadImage(IMAGE_URL, { maxBytes: 1024 }, declared.fetch)
    ).rejects.toThrow(/above the 1024 byte limit/);

    // A lying content-length must not get past the post-read check.
    const actual = new FetchStub().push({
      bytes: Buffer.concat([PNG_BYTES, Buffer.alloc(5_000)]),
      headers: { "content-type": "image/png" },
    });
    await expect(
      downloadImage(IMAGE_URL, { maxBytes: 1024 }, actual.fetch)
    ).rejects.toThrow(/above the 1024 byte limit/);
  });

  it("rejects a disallowed declared content-type", async () => {
    const stub = new FetchStub().push({
      bytes: PNG_BYTES,
      headers: { "content-type": "text/html" },
    });
    await expect(downloadImage(IMAGE_URL, {}, stub.fetch)).rejects.toThrow(
      /Unsupported image content-type/
    );
  });

  it("trusts sniffed magic bytes over a lying content-type", async () => {
    // A server that claims image/png but sends HTML must be caught, and one
    // that claims image/jpeg while sending a real PNG is still a valid image.
    const lying = new FetchStub().push({
      body: "<html>nope</html>",
      headers: { "content-type": "image/png" },
    });
    await expect(downloadImage(IMAGE_URL, {}, lying.fetch)).rejects.toThrow(
      /not a supported image/
    );

    const mislabelled = new FetchStub().push({
      bytes: PNG_BYTES,
      headers: { "content-type": "image/jpeg" },
    });
    await expect(downloadImage(IMAGE_URL, {}, mislabelled.fetch)).resolves.toMatchObject({
      contentType: "image/png",
      extension: "png",
    });
  });

  it("rejects an empty body and a non-2xx response", async () => {
    const empty = new FetchStub().push({ bytes: Buffer.alloc(0), headers: {} });
    await expect(downloadImage(IMAGE_URL, {}, empty.fetch)).rejects.toThrow(/empty/);

    const notFound = new FetchStub().push({ status: 404 });
    await expect(downloadImage(IMAGE_URL, {}, notFound.fetch)).rejects.toThrow(/HTTP 404/);
  });

  it("returns base64 the Shoper content field can carry", async () => {
    const stub = imageFetch();
    const downloaded = await downloadImage(IMAGE_URL, {}, stub.fetch);
    expect(Buffer.from(downloaded.base64, "base64").equals(PNG_BYTES)).toBe(true);
    expect(downloaded.bytes).toBe(PNG_BYTES.length);
  });

  it("reports a network failure as an ImageFetchError, not a raw throw", async () => {
    const failing = (async () => {
      throw new Error("ECONNRESET");
    }) as never;
    const error = await downloadImage(IMAGE_URL, {}, failing).catch((e) => e);
    expect(error).toBeInstanceOf(ImageFetchError);
    expect(error.reason).toBe("http_error");
  });

  it("reports an aborted download as a timeout", async () => {
    const hanging = (async (_url: string, init?: { signal?: AbortSignal }) => {
      await new Promise((resolve) => setTimeout(resolve, 50));
      const error = new Error("aborted");
      if (init?.signal?.aborted) throw error;
      throw error;
    }) as never;
    const error = await downloadImage(IMAGE_URL, { timeoutMs: 1 }, hanging).catch((e) => e);
    expect(error).toBeInstanceOf(ImageFetchError);
    expect(error.reason).toBe("timeout");
  });

  it("clears its timeout so a fast download does not keep the process alive", async () => {
    const clear = vi.spyOn(global, "clearTimeout");
    await downloadImage(IMAGE_URL, {}, imageFetch().fetch);
    expect(clear).toHaveBeenCalled();
  });
});

describe("sniffImageMime", () => {
  it("identifies the supported formats from magic bytes", () => {
    expect(sniffImageMime(PNG_BYTES)).toBe("image/png");
    expect(sniffImageMime(Buffer.concat([Buffer.from([0xff, 0xd8, 0xff]), Buffer.alloc(9)]))).toBe(
      "image/jpeg"
    );
    expect(sniffImageMime(Buffer.concat([Buffer.from("GIF89a"), Buffer.alloc(6)]))).toBe(
      "image/gif"
    );
    const webp = Buffer.concat([
      Buffer.from("RIFF"),
      Buffer.alloc(4),
      Buffer.from("WEBP"),
    ]);
    expect(sniffImageMime(webp)).toBe("image/webp");
    const avif = Buffer.concat([Buffer.alloc(4), Buffer.from("ftyp"), Buffer.from("avif")]);
    expect(sniffImageMime(avif)).toBe("image/avif");
  });

  it("returns undefined for a short or unknown buffer", () => {
    expect(sniffImageMime(Buffer.alloc(4))).toBeUndefined();
    expect(sniffImageMime(Buffer.from("<html>not an image!"))).toBeUndefined();
  });
});

describe("sanitiseHtml", () => {
  it("strips scripts, event handlers and javascript: URLs", () => {
    const dirty =
      '<p>ok</p><script>steal()</script><a href="javascript:evil()">x</a>' +
      '<img src="y" onerror="bad()"><iframe src="z"></iframe>';
    const clean = sanitiseHtml(dirty);
    expect(clean).toContain("<p>ok</p>");
    expect(clean).not.toContain("script");
    expect(clean).not.toContain("onerror");
    expect(clean).not.toContain("javascript:");
    expect(clean).not.toContain("<iframe");
  });

  it("keeps ordinary formatting markup intact", () => {
    const html = "<p><strong>Buty</strong> <em>sportowe</em></p><ul><li>42</li></ul>";
    expect(sanitiseHtml(html)).toBe(html);
  });
});
