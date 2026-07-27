/**
 * Draft approval ordering. Approval is the moment local state and the live shop
 * can diverge, and the ordering is deliberate: the row is claimed inside a
 * SQLite transaction, the Shoper write happens OUTSIDE it (network IO must never
 * hold a write lock), and `approved` is only recorded after that write resolves.
 * Get it wrong in either direction and the merchant either sees "approved" for a
 * change that never reached their shop, or loses a draft they can no longer
 * retry. Both directions are pinned, plus the concurrent double-approve.
 */

import { afterEach, describe, expect, it } from "vitest";
import { DraftStore } from "../src/draft-store";
import { ShoperClient } from "../src/shoper-client";
import { ShoperApiError } from "../src/types";
import type { JobItem } from "../src/types";
import { PNG_BYTES } from "./helpers";

const stores: DraftStore[] = [];

function memStore(): DraftStore {
  const store = new DraftStore(":memory:", "test-passphrase-0123456789");
  stores.push(store);
  return store;
}

afterEach(() => {
  while (stores.length > 0) stores.pop()?.close();
});

/** Completed bridge item carrying both an image and text. */
function item(overrides: Partial<JobItem> = {}): JobItem {
  return {
    id: "bridge-item-1",
    external_id: "7",
    status: "completed",
    attempts: 1,
    result: {
      image_urls: ["https://cdn.fotohub.app/results/img-1.png"],
      text: { title: "Nowa nazwa" },
    },
    ...overrides,
  };
}

/**
 * Shoper double whose product write is controlled by the test: `gate` decides
 * whether the call resolves, throws, or blocks until released.
 */
function fakeShoper(hooks: { onWrite?: () => Promise<void> } = {}): {
  client: ShoperClient;
  writes: number;
} {
  const state = { writes: 0 };
  const client = {
    translationLocale: "pl_PL",
    getProductImages: async () => [],
    imageAlt: () => undefined,
    getProductVariants: async () => [],
    addProductImageBase64: async () => 101,
    setMainProductImage: async () => undefined,
    updateProductImageAlt: async () => undefined,
    updateProductTranslationsMulti: async () => undefined,
    updateProductTranslations: async () => {
      state.writes += 1;
      if (hooks.onWrite) await hooks.onWrite();
    },
  } as unknown as ShoperClient;
  return {
    client,
    get writes() {
      return state.writes;
    },
  };
}

/** Write-back options that keep image downloads off the network. */
function writeBackOptions(): { writeBack: { fetchImpl: never } } {
  const fetchImpl = (async () => ({
    ok: true,
    status: 200,
    headers: { get: (name: string) => (name.toLowerCase() === "content-type" ? "image/png" : null) },
    text: async () => "",
    arrayBuffer: async () =>
      PNG_BYTES.buffer.slice(
        PNG_BYTES.byteOffset,
        PNG_BYTES.byteOffset + PNG_BYTES.byteLength
      ) as ArrayBuffer,
  })) as never;
  return { writeBack: { fetchImpl } };
}

function seedDraft(store: DraftStore, overrides: Partial<JobItem> = {}): number {
  const draft = store.createDraftFromItem("job-1", "complete_listing", item(overrides), {}, {
    locale: "pl_PL",
  });
  if (!draft) throw new Error("fixture did not create a draft");
  return draft.id;
}

describe("draft creation", () => {
  it("stores images and text as one mixed pending draft", () => {
    const store = memStore();
    const id = seedDraft(store);
    const draft = store.getDraft(id)!;
    expect(draft.status).toBe("pending");
    expect(draft.type).toBe("mixed");
    expect(draft.payload.images).toHaveLength(1);
    expect(draft.payload.text?.title).toBe("Nowa nazwa");
    expect(draft.bridge_item_id).toBe("bridge-item-1");
  });

  it("is idempotent per bridge item id", () => {
    // The item webhook and the job webhook both deliver the same item, so a
    // second collect must not produce a second review card.
    const store = memStore();
    const first = seedDraft(store);
    const second = store.createDraftFromItem("job-1", "complete_listing", item(), {});
    expect(second?.id).toBe(first);
    expect(store.listDrafts({ status: "pending" })).toHaveLength(1);
  });

  it("refuses items with nothing to apply or a bad product id", () => {
    const store = memStore();
    expect(store.createDraftFromItem("j", "description", item({ result: {} }), {})).toBeNull();
    expect(
      store.createDraftFromItem("j", "description", item({ external_id: "0" }), {})
    ).toBeNull();
    expect(
      store.createDraftFromItem("j", "description", item({ external_id: "abc" }), {})
    ).toBeNull();
  });

  it("marks the first image as main only when asked", () => {
    const store = memStore();
    const plain = store.createDraftFromItem("j1", "image_generate", item(), {}, {})!;
    expect(plain.payload.images?.[0]?.main).toBeUndefined();

    const promoted = store.createDraftFromItem(
      "j2",
      "image_generate",
      item({ id: "bridge-item-2" }),
      {},
      { setMainImage: true }
    )!;
    expect(promoted.payload.images?.[0]?.main).toBe(true);
  });
});

describe("approveDraft ordering", () => {
  it("marks approved only after the Shoper write resolves", async () => {
    const store = memStore();
    const id = seedDraft(store);
    let statusDuringWrite: string | undefined;

    const shoper = fakeShoper({
      onWrite: async () => {
        // Observed from inside the remote call: the row must be 'applying', so
        // the UI can never show "approved" for a write still in flight.
        statusDuringWrite = store.getDraft(id)?.status;
      },
    });

    const result = await store.approveDraft(id, shoper.client, writeBackOptions());

    expect(statusDuringWrite).toBe("applying");
    expect(store.getDraft(id)?.status).toBe("approved");
    expect(store.getDraft(id)?.applied_at).toBeTruthy();
    expect(result.applied_fields).toContain("name");
  });

  it("does not hold a write lock while the remote call is in flight", async () => {
    // The claim transaction must have committed before the network call starts,
    // or a slow Shoper upload would block every other query for its duration.
    const store = memStore();
    const id = seedDraft(store);
    let couldWriteDuringCall = false;

    const shoper = fakeShoper({
      onWrite: async () => {
        store.writeConfig({ storeName: "written during remote call" });
        couldWriteDuringCall = true;
      },
    });

    await store.approveDraft(id, shoper.client, writeBackOptions());
    expect(couldWriteDuringCall).toBe(true);
    expect(store.readConfig().storeName).toBe("written during remote call");
  });

  it("leaves the row retryable and NOT approved when the write throws", async () => {
    const store = memStore();
    const id = seedDraft(store);
    const shoper = fakeShoper({
      onWrite: async () => {
        throw new ShoperApiError("Shoper PUT /products/7 failed with 500", 500);
      },
    });

    await expect(store.approveDraft(id, shoper.client, writeBackOptions())).rejects.toThrow(
      /500/
    );

    const draft = store.getDraft(id)!;
    expect(draft.status).toBe("failed");
    expect(draft.applied_at).toBeNull();
    expect(draft.decided_at).toBeNull();
    expect(draft.error).toContain("500");
    // 'failed' is claimable again, so the merchant can retry from the UI.
    expect(draft.attempts).toBe(1);
  });

  it("counts a retry after a failure and can then succeed", async () => {
    const store = memStore();
    const id = seedDraft(store);
    let attempt = 0;
    const shoper = fakeShoper({
      onWrite: async () => {
        attempt += 1;
        if (attempt === 1) throw new ShoperApiError("transient", 502);
      },
    });

    await expect(store.approveDraft(id, shoper.client, writeBackOptions())).rejects.toThrow();
    await store.approveDraft(id, shoper.client, writeBackOptions());

    const draft = store.getDraft(id)!;
    expect(draft.status).toBe("approved");
    expect(draft.attempts).toBe(2);
  });

  it("does not double-write when the same draft is approved twice concurrently", async () => {
    // The compare-and-set is the only thing standing between a double-click and
    // two uploads of the same photo.
    const store = memStore();
    const id = seedDraft(store);
    let release: (() => void) | undefined;
    const gate = new Promise<void>((resolve) => {
      release = resolve;
    });
    const shoper = fakeShoper({ onWrite: () => gate });

    const first = store.approveDraft(id, shoper.client, writeBackOptions());
    // The claim is synchronous up to the first await, so by now the row is held.
    const second = store.approveDraft(id, shoper.client, writeBackOptions()).catch(
      (e: Error) => e.message
    );
    expect(await second).toMatch(/already being applied/);

    release?.();
    await first;
    expect(shoper.writes).toBe(1);
    expect(store.getDraft(id)?.status).toBe("approved");
  });

  it("reports an already-approved draft as a no-op instead of rewriting", async () => {
    const store = memStore();
    const id = seedDraft(store);
    const shoper = fakeShoper();
    await store.approveDraft(id, shoper.client, writeBackOptions());

    const again = await store.approveDraft(id, shoper.client, writeBackOptions());
    expect(again.skipped).toContain("already_approved");
    expect(shoper.writes).toBe(1);
  });

  it("refuses to approve a rejected draft", async () => {
    const store = memStore();
    const id = seedDraft(store);
    expect(store.rejectDraft(id)).toBe(true);
    const shoper = fakeShoper();
    await expect(store.approveDraft(id, shoper.client, writeBackOptions())).rejects.toThrow(
      /was rejected/
    );
    expect(shoper.writes).toBe(0);
  });

  it("throws for an unknown draft id", async () => {
    const store = memStore();
    await expect(store.approveDraft(999, fakeShoper().client)).rejects.toThrow(
      /Draft not found/
    );
  });

  it("records who decided the draft", async () => {
    const store = memStore();
    const id = seedDraft(store);
    await store.approveDraft(id, fakeShoper().client, {
      decidedBy: "scheduler",
      ...writeBackOptions(),
    });
    expect(store.getDraft(id)?.decided_by).toBe("scheduler");
  });

  it("journals the applied item, suppressing a duplicate write for a fresh draft", async () => {
    // The journal is keyed on bridge_item_id, not draft id, so re-collecting a
    // job after the DB row was cleared still cannot double-write.
    const store = memStore();
    const id = seedDraft(store);
    const shoper = fakeShoper();
    await store.approveDraft(id, shoper.client, writeBackOptions());
    expect(store.wasApplied("bridge-item-1")).toBe(true);
    expect(store.journalSize()).toBeGreaterThan(0);

    store.raw.prepare("DELETE FROM drafts WHERE id = ?").run(id);
    const reborn = seedDraft(store);
    const result = await store.approveDraft(reborn, shoper.client, writeBackOptions());
    expect(result.skipped).toContain("already_applied");
    expect(shoper.writes).toBe(1);
  });
});

describe("rejectDraft", () => {
  it("rejects a pending draft and never touches the shop", () => {
    const store = memStore();
    const id = seedDraft(store);
    expect(store.rejectDraft(id)).toBe(true);
    const draft = store.getDraft(id)!;
    expect(draft.status).toBe("rejected");
    expect(draft.applied_at).toBeNull();
    expect(draft.decided_at).toBeTruthy();
  });

  it("will not reject an already-approved draft", async () => {
    // The write already landed in the shop, so "rejected" would be a lie.
    const store = memStore();
    const id = seedDraft(store);
    await store.approveDraft(id, fakeShoper().client, writeBackOptions());
    expect(store.rejectDraft(id)).toBe(false);
    expect(store.getDraft(id)?.status).toBe("approved");
  });

  it("reports false for an unknown id", () => {
    expect(memStore().rejectDraft(4242)).toBe(false);
  });
});

describe("approveMany / approveAll", () => {
  function seedThree(store: DraftStore): number[] {
    return [1, 2, 3].map((n) => {
      const draft = store.createDraftFromItem(
        "job-1",
        "description",
        item({ id: `bridge-item-${n}`, external_id: String(n) }),
        {}
      );
      return draft!.id;
    });
  }

  it("keeps going when one draft fails and reports both sides", async () => {
    const store = memStore();
    const ids = seedThree(store);
    const shoper = fakeShoper({
      onWrite: async () => {
        // Fail only the second write.
        if (shoper.writes === 2) throw new ShoperApiError("boom", 500);
      },
    });

    const result = await store.approveMany(shoper.client, ids, writeBackOptions());
    expect(result.approved).toHaveLength(2);
    expect(result.failed).toHaveLength(1);
    expect(result.failed[0]!.error).toContain("boom");
    // The failed row stays retryable; the others are done.
    expect(store.countDrafts()).toMatchObject({ approved: 2, failed: 1, pending: 0 });
  });

  it("approveAll scopes to one job when asked", async () => {
    const store = memStore();
    seedThree(store);
    store.createDraftFromItem(
      "job-2",
      "description",
      item({ id: "other-job-item", external_id: "9" }),
      {}
    );

    const result = await store.approveAll(fakeShoper().client, "job-1", writeBackOptions());
    expect(result.approved).toHaveLength(3);
    expect(store.listDrafts({ status: "pending" }).map((d) => d.job_id)).toEqual(["job-2"]);
  });

  it("approveAll with no job id takes every pending draft", async () => {
    const store = memStore();
    seedThree(store);
    const result = await store.approveAll(fakeShoper().client, undefined, writeBackOptions());
    expect(result.approved).toHaveLength(3);
    expect(store.listDrafts({ status: "pending" })).toHaveLength(0);
  });

  it("is a no-op on an empty id list", async () => {
    const store = memStore();
    const shoper = fakeShoper();
    const result = await store.approveMany(shoper.client, []);
    expect(result).toEqual({ approved: [], failed: [] });
    expect(shoper.writes).toBe(0);
  });
});

describe("encrypted config", () => {
  it("round-trips secrets and stores them encrypted at rest", () => {
    const store = memStore();
    store.writeConfig({ fotohubApiKey: "fh_live_secret", storeName: "Sklep" });
    expect(store.readConfig().fotohubApiKey).toBe("fh_live_secret");

    const row = store.raw
      .prepare("SELECT value, encrypted FROM config WHERE key = 'fotohubApiKey'")
      .get() as { value: string; encrypted: number };
    expect(row.encrypted).toBe(1);
    expect(row.value).not.toContain("fh_live_secret");
    expect(row.value.startsWith("v1:")).toBe(true);

    // Non-secret values stay readable, which keeps debugging sane.
    const plain = store.raw
      .prepare("SELECT value, encrypted FROM config WHERE key = 'storeName'")
      .get() as { value: string; encrypted: number };
    expect(plain.encrypted).toBe(0);
    expect(plain.value).toBe("Sklep");
  });

  it("skips a value it cannot decrypt instead of crashing the panel", () => {
    const store = memStore();
    store.writeConfig({ fotohubApiKey: "fh_live_secret", storeName: "Sklep" });
    store.raw
      .prepare("UPDATE config SET value = 'v1:AAAA:BBBB:CCCC' WHERE key = 'fotohubApiKey'")
      .run();

    const config = store.readConfig();
    expect(config.fotohubApiKey).toBeUndefined();
    expect(config.storeName).toBe("Sklep");
  });

  it("deletes a key when written empty, rather than storing a blank secret", () => {
    const store = memStore();
    store.writeConfig({ fotohubApiKey: "fh_live_secret" });
    store.writeConfig({ fotohubApiKey: "" });
    expect(store.readConfig().fotohubApiKey).toBeUndefined();
  });

  it("clearConfig removes everything, so disconnect really disconnects", () => {
    const store = memStore();
    store.writeConfig({ fotohubApiKey: "fh_live_secret", connectionId: "conn-1" });
    store.clearConfig();
    expect(store.readConfig()).toEqual({});
  });
});

describe("schema", () => {
  it("applies every migration and is idempotent on reopen", () => {
    const store = memStore();
    const version = store.schemaVersion;
    expect(version).toBeGreaterThan(0);
    // Re-running migrate() over an existing DB must not throw or re-apply.
    const reopened = new DraftStore(":memory:", "test-passphrase-0123456789");
    stores.push(reopened);
    expect(reopened.schemaVersion).toBe(version);
  });
});
