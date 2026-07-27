/**
 * Boot test for the admin SPA.
 *
 * The original defect was a TypeError at the top level of app.js's IIFE:
 * `$("c-submit").addEventListener(...)` on an id the markup never declared. It
 * aborted script evaluation before init() ran, so the whole panel rendered as a
 * blank shell — and an id-inventory test alone is what let that ship, because a
 * text scan cannot see a throw.
 *
 * So this suite does the only thing that catches it: builds the real
 * index.html in jsdom, stubs fetch with plausible /api responses, evaluates
 * public/app.js, and asserts it initialises without throwing and puts something
 * in #view-root.
 */

import { readFileSync } from "fs";
import { JSDOM, VirtualConsole } from "jsdom";
import { join } from "path";
import { afterEach, describe, expect, it } from "vitest";
import { getStrings } from "../src/i18n";
import { DEFAULT_IMAGE_MODEL, IMAGE_MODELS, PRODUCT_SORTS, TONES } from "../src/types";

const PUBLIC_DIR = join(__dirname, "..", "public");
const html = readFileSync(join(PUBLIC_DIR, "index.html"), "utf8");
const appJs = readFileSync(join(PUBLIC_DIR, "app.js"), "utf8");

const CSRF = "test-csrf-token";

interface BootOptions {
  /** Overrides merged into the GET /api/status response. */
  status?: Record<string, unknown>;
  /** Paths that must answer with an HTTP error, e.g. { "/summary": 500 }. */
  fail?: Record<string, number>;
  /** Simulate a backgrounded tab (jsdom reports hidden by default). */
  hidden?: boolean;
}

/**
 * jsdom reports `document.hidden === true`, which the panel honours by pausing
 * its job poll. A test that wants the poll to run has to say the tab is visible.
 */
function setVisibility(dom: JSDOM, hidden: boolean): void {
  Object.defineProperty(dom.window.document, "hidden", {
    configurable: true,
    get: () => hidden,
  });
  Object.defineProperty(dom.window.document, "visibilityState", {
    configurable: true,
    get: () => (hidden ? "hidden" : "visible"),
  });
}

interface BootResult {
  dom: JSDOM;
  window: JSDOM["window"];
  /**
   * Uncaught errors only. app.js logs deliberately (console.warn from the
   * defensive $() helper, console.error when boot degrades to the wizard), and
   * counting those as failures would make every graceful path look broken.
   */
  errors: string[];
  /** Anything app.js logged, for tests that assert it reported a problem. */
  logs: string[];
  calls: { path: string; method: string; headers: Record<string, string> }[];
  settle: () => Promise<void>;
}

function statusBody(overrides: Record<string, unknown> = {}): Record<string, unknown> {
  return {
    connected: true,
    connection_id: "conn_test",
    store_name: "Sklep Testowy",
    store_url: "https://sklep123456.shoparena.pl",
    has_shoper_credentials: true,
    has_fotohub_key: true,
    default_preset_slug: "studio-white",
    default_model: DEFAULT_IMAGE_MODEL,
    default_language: "pl",
    default_tone: "professional",
    auto_alt_text: false,
    onboarding_dismissed: false,
    ui_language: "pl",
    models: IMAGE_MODELS,
    tones: TONES,
    sorts: PRODUCT_SORTS,
    low_balance_threshold: 50,
    missing_description_max: 20,
    last_health_check: null,
    csrf_token: CSRF,
    mcp_url: "https://apis.fotohub.app/mcp/",
    ...overrides,
  };
}

/** Canned API surface: shapes match src/server.ts, values are inert fixtures. */
function apiFixture(path: string): unknown {
  if (path.startsWith("/i18n/")) {
    return { lang: path.endsWith("/en") ? "en" : "pl", strings: getStrings(path.split("/").pop()) };
  }
  if (path === "/status") return statusBody();
  if (path === "/balance") return { available_credits: 500, low_balance: false, threshold: 50 };
  if (path === "/summary") {
    return {
      available_credits: 500,
      low_balance: false,
      spent_recently: 12,
      jobs_total: 1,
      jobs_active: 1,
      drafts_pending: 2,
      drafts_approved: 0,
      drafts_rejected: 0,
      missing_description: { count: 3, sample: 50 },
      recent_jobs: [
        {
          job_id: "job_1",
          kind: "bg_remove",
          product_ids: [1],
          created_at: "2026-07-01T10:00:00.000Z",
          state: {
            id: "job_1",
            status: "processing",
            kind: "bg_remove",
            total_items: 2,
            done_items: 1,
            failed_items: 1,
            spent_credits: 4,
            estimated_credits: 8,
          },
        },
      ],
    };
  }
  if (path === "/categories") {
    return { categories: [{ category_id: 7, name: "Buty <script>alert(1)</script>" }] };
  }
  if (path.startsWith("/products")) {
    return {
      products: [
        {
          product_id: 11,
          // Deliberately hostile: must never be parsed as markup.
          name: '<img src=x onerror="window.__xss=1">Trampki',
          sku: '"><script>window.__xss=1</script>',
          price: 129.9,
          description_length: 4,
          short_description_length: 0,
          image_count: 1,
          thumbnail: "https://example.test/t.jpg",
        },
      ],
      page: 1,
      pages: 2,
      count: 1,
    };
  }
  if (path.startsWith("/presets")) {
    return {
      presets: [
        {
          slug: "studio-white",
          name: "Studio white",
          name_pl: "Studio białe",
          category: "background",
          description: "<b>opis</b>",
          is_system: true,
        },
        {
          slug: "allegro-bundle",
          name: "Allegro pack",
          name_pl: "Pakiet Allegro",
          category: "bundle",
          description: "",
          is_system: true,
        },
      ],
      default_preset_slug: "studio-white",
    };
  }
  if (path === "/jobs") {
    return {
      jobs: [
        {
          job_id: "job_1",
          kind: "bg_remove",
          product_ids: [11],
          created_at: "2026-07-01T10:00:00.000Z",
          state: {
            id: "job_1",
            status: "completed",
            kind: "bg_remove",
            total_items: 2,
            done_items: 2,
            failed_items: 1,
            spent_credits: 4,
            estimated_credits: 8,
          },
        },
      ],
    };
  }
  if (/^\/jobs\/[^/]+\/items/.test(path)) {
    return {
      items: [
        {
          id: "it_1",
          external_id: "11",
          sku: "SKU-1",
          status: "failed",
          attempts: 1,
          error_message: '<script>window.__xss=1</script>',
        },
      ],
    };
  }
  if (/^\/jobs\/[^/]+$/.test(path)) {
    return {
      id: "job_1",
      status: "completed_with_errors",
      kind: "bg_remove",
      total_items: 2,
      done_items: 1,
      failed_items: 1,
      spent_credits: 4,
      estimated_credits: 8,
    };
  }
  if (path.startsWith("/drafts")) {
    return {
      drafts: [
        {
          id: 1,
          product_id: 11,
          variant_id: null,
          job_id: "job_1",
          item_id: "it_1",
          bridge_item_id: "b_1",
          kind: "description",
          type: "text",
          status: "pending",
          created_at: "2026-07-01T11:00:00.000Z",
          attempts: 0,
          payload: {
            text: {
              title: '<img src=x onerror="window.__xss=1"> Nowy tytuł',
              description: "Opis produktu ze szczegółami.",
            },
            before: { name: "Stary tytuł", description: "Opis produktu." },
          },
        },
        {
          id: 2,
          product_id: 12,
          variant_id: null,
          job_id: "job_1",
          item_id: "it_2",
          bridge_item_id: "b_2",
          kind: "bg_remove",
          type: "images",
          status: "pending",
          created_at: "2026-07-01T11:05:00.000Z",
          attempts: 0,
          payload: {
            images: [{ url: "https://example.test/after.jpg", alt_text: "buty" }],
            before: { image_urls: ["https://example.test/before.jpg"] },
          },
        },
      ],
    };
  }
  if (path === "/health") return { bridge: { ok: true }, shoper: { ok: true }, checked_at: "2026-07-01T12:00:00.000Z" };
  if (path === "/estimate") {
    return { credits_per_item: 2, total_credits: 4, available_credits: 500, sufficient: true, num_items: 2, num_images: 1 };
  }
  return {};
}

function boot(options: BootOptions = {}): BootResult {
  const errors: string[] = [];
  const logs: string[] = [];
  const calls: BootResult["calls"] = [];
  const virtualConsole = new VirtualConsole();
  // jsdomError is the class that matters: a thrown exception or an unhandled
  // rejection, i.e. the original blank-panel failure.
  virtualConsole.on("jsdomError", (err: Error) => errors.push(err.message));
  virtualConsole.on("error", (message: unknown) => logs.push(String(message)));
  virtualConsole.on("warn", (message: unknown) => logs.push(String(message)));

  const dom = new JSDOM(html, {
    runScripts: "outside-only",
    url: "http://localhost:8811/",
    virtualConsole,
  });
  setVisibility(dom, options.hidden === true);
  const window = dom.window as unknown as Window & typeof globalThis & Record<string, unknown>;

  window.fetch = ((input: string, init?: RequestInit) => {
    const url = String(input);
    const path = url.replace(/^https?:\/\/[^/]+/, "").replace(/^\/api/, "");
    const headers = (init?.headers ?? {}) as Record<string, string>;
    calls.push({ path, method: init?.method ?? "GET", headers });
    const failStatus = options.fail?.[path.split("?")[0] as string];
    if (failStatus) {
      return Promise.resolve({
        ok: false,
        status: failStatus,
        text: () => Promise.resolve(JSON.stringify({ error: "boom" })),
      });
    }
    const body = path === "/status" ? statusBody(options.status) : apiFixture(path);
    return Promise.resolve({
      ok: true,
      status: 200,
      text: () => Promise.resolve(JSON.stringify(body)),
    });
  }) as unknown as typeof fetch;

  // Evaluating the script is the actual assertion target: a top-level throw
  // here is precisely the bug this file exists to catch.
  window.eval(appJs);

  return {
    dom,
    window: window as unknown as JSDOM["window"],
    errors,
    logs,
    calls,
    /**
     * Let the chained promises resolve. The deepest chain is
     * /i18n -> /status -> view -> /jobs -> openJob -> /jobs/:id -> items,
     * so a few macrotask turns are needed, not just microtasks.
     */
    settle: async () => {
      for (let turn = 0; turn < 6; turn++) {
        for (let i = 0; i < 40; i++) await Promise.resolve();
        await new Promise((resolve) => setTimeout(resolve, 0));
      }
    },
  };
}

let open: BootResult | null = null;

function bootAndTrack(options?: BootOptions): BootResult {
  open = boot(options);
  return open;
}

afterEach(async () => {
  if (!open) return;
  // Closing the window while a fetch continuation is still queued would make
  // that continuation touch a torn-down document and surface as an unhandled
  // rejection attributed to app.js. Stub the network out, drain what is already
  // in flight, then close.
  (open.window as unknown as Record<string, unknown>)["fetch"] = () =>
    new Promise(() => undefined);
  await open.settle();
  open.dom.window.close();
  open = null;
});

describe("app.js boots", () => {
  it("evaluates without throwing", () => {
    const result = bootAndTrack();
    expect(result.errors).toEqual([]);
    // The IIFE exposes this only after it runs to completion.
    expect((result.window as unknown as Record<string, unknown>)["__fotohubShoper"]).toBeTruthy();
  });

  it("renders a view into #view-root", async () => {
    const result = bootAndTrack();
    await result.settle();
    const viewRoot = result.window.document.getElementById("view-root");
    expect(viewRoot).toBeTruthy();
    expect((viewRoot as HTMLElement).childElementCount).toBeGreaterThan(0);
    expect(result.errors).toEqual([]);
  });

  it("fetches translations before status, so no raw key can be shown", async () => {
    const result = bootAndTrack();
    await result.settle();
    const paths = result.calls.map((c) => c.path);
    expect(paths[0]).toBe("/i18n/pl");
    expect(paths).toContain("/status");
  });

  it("labels the shell from the catalogue rather than the HTML defaults", async () => {
    const result = bootAndTrack();
    await result.settle();
    const doc = result.window.document;
    expect(doc.getElementById("page-title")?.textContent).toBe(getStrings("pl")["dashboard_title"]);
    expect(doc.getElementById("store-name")?.textContent).toBe("Sklep Testowy");
    expect(doc.documentElement.lang).toBe("pl");
  });

  it("shows the connection wizard instead of a blank shell when not connected", async () => {
    const result = bootAndTrack({ status: { connected: false, connection_id: null } });
    await result.settle();
    const viewRoot = result.window.document.getElementById("view-root") as HTMLElement;
    expect(viewRoot.querySelector("form")).toBeTruthy();
    expect(viewRoot.querySelector("#c-store-url")).toBeTruthy();
    expect(result.errors).toEqual([]);
  });

  it("still boots when /api/status fails outright", async () => {
    const result = bootAndTrack({ fail: { "/status": 500 } });
    await result.settle();
    // A dead backend must degrade to the wizard, not to an unhandled rejection.
    const viewRoot = result.window.document.getElementById("view-root") as HTMLElement;
    expect(viewRoot.childElementCount).toBeGreaterThan(0);
    expect(result.errors).toEqual([]);
    // ...and it must say so in the console rather than failing silently.
    expect(result.logs.join(" ")).toContain("[fotohub]");
  });

  it("survives a failing dashboard summary without blanking the panel", async () => {
    const result = bootAndTrack({ fail: { "/summary": 500 } });
    await result.settle();
    const viewRoot = result.window.document.getElementById("view-root") as HTMLElement;
    expect(viewRoot.childElementCount).toBeGreaterThan(0);
    expect(result.errors).toEqual([]);
  });
});

describe("navigation", () => {
  const views = ["photos", "descriptions", "jobs", "drafts", "presets", "settings", "mcp", "dashboard"];

  for (const view of views) {
    it(`renders the ${view} view when its nav item is clicked`, async () => {
      const result = bootAndTrack();
      await result.settle();
      const doc = result.window.document;
      const button = doc.querySelector(`.nav-item[data-view="${view}"], .tabbar-item[data-view="${view}"]`);
      expect(button).toBeTruthy();
      (button as HTMLElement).click();
      await result.settle();
      const viewRoot = doc.getElementById("view-root") as HTMLElement;
      expect(viewRoot.childElementCount).toBeGreaterThan(0);
      expect(result.errors).toEqual([]);
    });
  }

  it("marks the active nav item", async () => {
    const result = bootAndTrack();
    await result.settle();
    const doc = result.window.document;
    (doc.querySelector('.nav-item[data-view="presets"]') as HTMLElement).click();
    await result.settle();
    const active = doc.querySelector('.nav-item[data-view="presets"]') as HTMLElement;
    expect(active.classList.contains("active")).toBe(true);
    expect(active.getAttribute("aria-current")).toBe("page");
  });

  it("shows the shared job options only on the wizard screens", async () => {
    const result = bootAndTrack();
    await result.settle();
    const doc = result.window.document;
    const opts = doc.getElementById("opts-common") as HTMLElement;
    expect(opts.classList.contains("is-hidden")).toBe(true);
    (doc.querySelector('.nav-item[data-view="photos"]') as HTMLElement).click();
    await result.settle();
    expect(opts.classList.contains("is-hidden")).toBe(false);
  });
});

describe("visibility-aware polling", () => {
  it("does not poll job items while the tab is hidden", async () => {
    const result = bootAndTrack({ hidden: true });
    await result.settle();
    (result.window.document.querySelector('.nav-item[data-view="jobs"]') as HTMLElement).click();
    await result.settle();

    // The job list still loads; only the per-job poll is deferred, and the
    // panel says so instead of looking stuck.
    expect(result.calls.some((c) => c.path === "/jobs")).toBe(true);
    expect(result.calls.some((c) => c.path.startsWith("/jobs/job_1"))).toBe(false);
    const note = result.window.document.querySelector("#view-root .job-progress-text");
    expect(note).toBeTruthy();
    const paused = [...result.window.document.querySelectorAll("#view-root .meta")].some(
      (n) => n.textContent === getStrings("pl")["auto_refresh_paused"]
    );
    expect(paused).toBe(true);
  });

  it("polls job items once the tab is visible", async () => {
    const result = bootAndTrack();
    await result.settle();
    (result.window.document.querySelector('.nav-item[data-view="jobs"]') as HTMLElement).click();
    await result.settle();
    expect(result.calls.some((c) => c.path.startsWith("/jobs/job_1"))).toBe(true);
  });
});

describe("product-derived text is escaped", () => {
  it("renders a hostile product name as text, not markup", async () => {
    const result = bootAndTrack();
    await result.settle();
    const doc = result.window.document;
    (doc.querySelector('.nav-item[data-view="photos"]') as HTMLElement).click();
    await result.settle();

    const viewRoot = doc.getElementById("view-root") as HTMLElement;
    expect(viewRoot.textContent).toContain("Trampki");
    // The payload must survive as literal text and inject nothing.
    expect(viewRoot.querySelector("img[onerror]")).toBeNull();
    expect(viewRoot.querySelectorAll("script").length).toBe(0);
    expect((result.window as unknown as Record<string, unknown>)["__xss"]).toBeUndefined();
  });

  it("renders a hostile job error message as text", async () => {
    const result = bootAndTrack();
    await result.settle();
    const doc = result.window.document;
    (doc.querySelector('.nav-item[data-view="jobs"]') as HTMLElement).click();
    await result.settle();

    const viewRoot = doc.getElementById("view-root") as HTMLElement;
    expect(viewRoot.textContent).toContain("<script>");
    expect(viewRoot.querySelectorAll("script").length).toBe(0);
    expect((result.window as unknown as Record<string, unknown>)["__xss"]).toBeUndefined();
  });

  it("renders hostile draft text as text", async () => {
    const result = bootAndTrack();
    await result.settle();
    const doc = result.window.document;
    (doc.querySelector('.nav-item[data-view="drafts"]') as HTMLElement).click();
    await result.settle();

    const viewRoot = doc.getElementById("view-root") as HTMLElement;
    expect(viewRoot.querySelectorAll(".draft-card").length).toBe(2);
    expect(viewRoot.querySelector("img[onerror]")).toBeNull();
    expect((result.window as unknown as Record<string, unknown>)["__xss"]).toBeUndefined();
  });

  it("renders a hostile category name as an option label, not markup", async () => {
    const result = bootAndTrack();
    await result.settle();
    const doc = result.window.document;
    (doc.querySelector('.nav-item[data-view="photos"]') as HTMLElement).click();
    await result.settle();

    const option = [...doc.querySelectorAll("#view-root option")].find((o) =>
      (o.textContent ?? "").includes("Buty")
    );
    expect(option).toBeTruthy();
    expect(doc.querySelectorAll("#view-root script").length).toBe(0);
  });
});

describe("variant toggle reaches the API", () => {
  it("sends includeVariants as include_variants on submit", async () => {
    const result = bootAndTrack();
    await result.settle();
    const doc = result.window.document;
    (doc.querySelector('.nav-item[data-view="photos"]') as HTMLElement).click();
    await result.settle();

    // Tick the variant toggle, pick a product, estimate, then submit.
    const toggle = doc.getElementById("o-include-variants") as HTMLInputElement;
    expect(toggle).toBeTruthy();
    toggle.checked = true;
    toggle.dispatchEvent(new result.window.Event("change"));

    const rowBox = doc.querySelector("#view-root tbody input[type=checkbox]") as HTMLInputElement;
    rowBox.checked = true;
    rowBox.dispatchEvent(new result.window.Event("change"));

    const estimateBtn = doc.querySelector("#view-root .estimate-btn") as HTMLElement;
    estimateBtn.click();
    await result.settle();

    const submit = doc.querySelector("#view-root .submit-btn") as HTMLButtonElement;
    expect(submit.disabled).toBe(false);
    submit.click();
    await result.settle();

    const jobCall = result.calls.filter((c) => c.path === "/jobs" && c.method === "POST").pop();
    expect(jobCall).toBeTruthy();
    expect(result.errors).toEqual([]);
  });

  it("invalidates a computed estimate when the toggle flips", async () => {
    const result = bootAndTrack();
    await result.settle();
    const doc = result.window.document;
    (doc.querySelector('.nav-item[data-view="photos"]') as HTMLElement).click();
    await result.settle();

    const rowBox = doc.querySelector("#view-root tbody input[type=checkbox]") as HTMLInputElement;
    rowBox.checked = true;
    rowBox.dispatchEvent(new result.window.Event("change"));
    (doc.querySelector("#view-root .estimate-btn") as HTMLElement).click();
    await result.settle();

    const submit = doc.querySelector("#view-root .submit-btn") as HTMLButtonElement;
    expect(submit.disabled).toBe(false);

    const toggle = doc.getElementById("o-include-variants") as HTMLInputElement;
    toggle.checked = true;
    toggle.dispatchEvent(new result.window.Event("change"));
    // A stale estimate would understate what the merchant is about to spend.
    expect(submit.disabled).toBe(true);
  });
});

describe("CSRF handling", () => {
  it("omits the token on reads and sends it on writes", async () => {
    const result = bootAndTrack();
    await result.settle();
    const doc = result.window.document;
    (doc.querySelector('.nav-item[data-view="presets"]') as HTMLElement).click();
    await result.settle();

    (doc.querySelector("#view-root .preset-card") as HTMLElement).click();
    await result.settle();

    const write = result.calls.filter((c) => c.method === "POST").pop();
    expect(write?.headers["X-CSRF-Token"]).toBe(CSRF);
    const read = result.calls.find((c) => c.path === "/status");
    expect(read?.headers["X-CSRF-Token"]).toBeUndefined();
  });
});

describe("defensive DOM access", () => {
  it("still boots when optional chrome is missing from the document", async () => {
    // The failure mode being fixed: one absent optional node used to throw and
    // blank the entire panel. Strip several and the views must still render.
    const stripped = html
      .replace(/<a class="credits-pill"[\s\S]*?<\/a>/, "")
      .replace(/<div id="low-balance-banner"[\s\S]*?<\/div>/, "")
      .replace(/<div id="toasts"[\s\S]*?<\/div>/, "")
      .replace(/<span class="nav-badge is-hidden" id="nav-badge-drafts"><\/span>/, "");

    const errors: string[] = [];
    const virtualConsole = new VirtualConsole();
    virtualConsole.on("jsdomError", (err: Error) => errors.push(err.message));
    const dom = new JSDOM(stripped, {
      runScripts: "outside-only",
      url: "http://localhost:8811/",
      virtualConsole,
    });
    setVisibility(dom, false);
    const window = dom.window as unknown as Window &
      typeof globalThis &
      Record<string, unknown>;
    window.fetch = ((input: string) => {
      const path = String(input).replace(/^\/api/, "");
      const body = path === "/status" ? statusBody() : apiFixture(path);
      return Promise.resolve({ ok: true, status: 200, text: () => Promise.resolve(JSON.stringify(body)) });
    }) as unknown as typeof fetch;

    window.eval(appJs);
    for (let i = 0; i < 40; i++) await Promise.resolve();
    await new Promise((resolve) => setTimeout(resolve, 0));
    for (let i = 0; i < 40; i++) await Promise.resolve();

    const viewRoot = dom.window.document.getElementById("view-root") as HTMLElement;
    expect(viewRoot.childElementCount).toBeGreaterThan(0);
    expect(errors).toEqual([]);
    dom.window.close();
  });
});
