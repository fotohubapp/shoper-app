/**
 * The admin SPA is plain files served statically, so nothing type-checks it and
 * a control can silently stop existing. These tests read public/ as text and
 * assert the reachability facts that matter: every id app.js dereferences is
 * present in the markup, navigation is bound to the elements the markup really
 * declares, store-derived text never reaches innerHTML, and the variant toggle
 * is rendered, translated and sent to the API.
 *
 * Why the id inventory is not enough on its own: an earlier version of this file
 * pinned the 61 ids app.js referenced but index.html never declared, so CI read
 * green while the panel was a blank shell. tests/boot.test.ts covers the other
 * half by actually loading app.js in a DOM — a text scan cannot see a top-level
 * TypeError, and that is the failure that shipped.
 */

import { readFileSync } from "fs";
import { join } from "path";
import { describe, expect, it } from "vitest";
import { getStrings } from "../src/i18n";

const PUBLIC_DIR = join(__dirname, "..", "public");
const html = readFileSync(join(PUBLIC_DIR, "index.html"), "utf8");
const appJs = readFileSync(join(PUBLIC_DIR, "app.js"), "utf8");
const css = readFileSync(join(PUBLIC_DIR, "style.css"), "utf8");

/** Element ids declared in the markup (icon sprite symbols excluded). */
function markupIds(): Set<string> {
  const ids = new Set<string>();
  for (const match of html.matchAll(/id="([A-Za-z0-9_-]+)"/g)) {
    const id = match[1] as string;
    if (!id.startsWith("i-")) ids.add(id);
  }
  return ids;
}

/**
 * Ids app.js looks up. Covers the `$()` helper plus the thin wrappers built on
 * it and any raw getElementById, because an id that only appears in a wrapper
 * call is just as absent from the document as one passed to `$()`.
 */
function requiredIds(): Set<string> {
  const ids = new Set<string>();
  const patterns = [
    /\$\("([A-Za-z0-9_-]+)"\)/g,
    /set(?:Text|Hidden)\("([A-Za-z0-9_-]+)"/g,
    /getElementById\("([A-Za-z0-9_-]+)"\)/g,
  ];
  for (const pattern of patterns) {
    for (const match of appJs.matchAll(pattern)) ids.add(match[1] as string);
  }
  return ids;
}

describe("variant toggle surface", () => {
  it("renders a checkbox in the markup", () => {
    expect(html).toContain('id="o-include-variants"');
    expect(html).toMatch(/type="checkbox"[^>]*id="o-include-variants"/);
  });

  it("labels the checkbox from the i18n catalogue, not a hardcoded string", () => {
    expect(html).toContain('data-i18n="option_include_variants"');
    expect(html).toContain('data-i18n="option_include_variants_help"');
  });

  it("ships both catalogues for those keys", () => {
    for (const lang of ["pl", "en"] as const) {
      const strings = getStrings(lang);
      expect(strings["option_include_variants"]).toBeTruthy();
      expect(strings["option_include_variants_help"]).toBeTruthy();
    }
  });

  it("discloses the product-level caveat in both languages", () => {
    // Shoper stores images per product, so the copy must not imply a photo can
    // be attached to a single variant. Promising otherwise is the docs claim
    // this feature would have made false.
    expect(getStrings("pl")["option_include_variants_help"]).toMatch(/ALT/);
    expect(getStrings("pl")["option_include_variants_help"]).toMatch(/produktu/);
    const en = getStrings("en")["option_include_variants_help"] as string;
    expect(en).toMatch(/images per product/);
    expect(en).toMatch(/ALT text/);
    expect(en).toMatch(/not on the individual variant/);
  });

  it("mentions the extra request per product, since it is a real cost", () => {
    expect(getStrings("en")["option_include_variants_help"]).toMatch(/extra request/);
    expect(getStrings("pl")["option_include_variants_help"]).toMatch(/zapytania/);
  });

  it("sends include_variants on job submit", () => {
    // Without this line the control would be decorative and the server flag
    // would stay unreachable, which was the original defect.
    expect(appJs).toMatch(/include_variants:\s*includeVariants\(\)/);
  });

  it("reads the checkbox defensively, so a missing control cannot break submit", () => {
    expect(appJs).toContain('document.getElementById("o-include-variants")');
    expect(appJs).toMatch(/includeVariantsBox\s*&&\s*includeVariantsBox\.checked/);
  });

  it("invalidates the estimate when the toggle changes", () => {
    // Turning variants on changes the context sent to the model, so a stale
    // estimate would understate what the merchant is about to spend.
    expect(appJs).toMatch(
      /includeVariantsBox\.addEventListener\("change",\s*invalidateEstimate\)/
    );
  });
});

/**
 * Empty on purpose, and it must stay empty.
 *
 * This array used to pin 61 ids that app.js dereferenced but index.html never
 * declared. Freezing them made the suite read green while the panel was dead:
 * app.js ran `$("c-submit").addEventListener(...)` at the top level of its
 * IIFE, so the first absent id threw a TypeError before init() and the whole
 * screen rendered as a blank shell. app.js now renders every view into
 * #view-root and only touches ids the markup really declares, so there is
 * nothing left to exempt. Any new entry here would be a regression, not a
 * waiver — fix the markup or the lookup instead.
 */
const KNOWN_MISSING_IDS: readonly string[] = [];

describe("SPA element contract", () => {
  it("references no id that the markup does not declare", () => {
    // A missing id is not cosmetic: the lookups run during init, and before the
    // defensive $() helper existed the first absent one blanked the panel.
    const missing = [...requiredIds()].filter((id) => !markupIds().has(id)).sort();
    expect(missing).toEqual([]);
  });

  it("exempts nothing: the known-missing list is empty", () => {
    // The list is the mechanism that hid the dead panel from CI. Keeping the
    // assertion means a future desync has to be fixed, not pinned.
    expect(KNOWN_MISSING_IDS).toEqual([]);
  });

  it("declares the variant control in the markup", () => {
    // The point of the feature is reachability, so this control specifically
    // must exist in the document rather than only in the script.
    expect(markupIds().has("o-include-variants")).toBe(true);
  });

  it("dereferences no absent id at IIFE top level", () => {
    // Top-level lookups are the fatal class: they abort script evaluation
    // before any view renders, which is exactly how the panel shipped broken.
    const topLevel = [...appJs.matchAll(/^ {2}\$\("([A-Za-z0-9_-]+)"\)/gm)].map(
      (m) => m[1] as string
    );
    const fatal = topLevel.filter((id) => !markupIds().has(id));
    expect(fatal).toEqual([]);
  });

  it("renders views into the view-root shell the markup provides", () => {
    expect(markupIds().has("view-root")).toBe(true);
    expect(appJs).toContain('$("view-root")');
    expect(appJs).toMatch(/function root\(\)/);
  });

  it("drives navigation from the data-view buttons the markup declares", () => {
    // The old script queried `.tab`, which appears zero times in the markup, so
    // navigation was silently inert even before the TypeError.
    expect(html).not.toContain('class="tab"');
    expect(html).toMatch(/class="nav-item"\s+data-view="dashboard"/);
    expect(appJs).toContain(".nav-item, .tabbar-item");
  });

  it("escapes and never routes store text through innerHTML", () => {
    // Product titles, SKUs and API error strings are attacker-controlled.
    expect(appJs).toMatch(/function esc\(/);
    // The only innerHTML writes are the sprite <use> refs, built from esc().
    const innerHtmlWrites = [...appJs.matchAll(/\.innerHTML\s*=\s*(.+)/g)].map(
      (m) => (m[1] as string).trim()
    );
    for (const write of innerHtmlWrites) {
      expect(write).toMatch(/esc\(|^v; \/\//);
    }
  });

  it("guards DOM access so one missing element cannot blank the panel", () => {
    // $() must return null and log rather than throw — the whole point of the
    // rewrite is that a missing optional node degrades one control, not all.
    expect(appJs).toMatch(/function \$\(id\) \{[\s\S]*?return node;\s*\}/);
    expect(appJs).toMatch(/if \(!node\) console\.warn/);
  });

  it("pauses polling while the tab is hidden", () => {
    expect(appJs).toContain("document.hidden");
    expect(appJs).toContain("visibilitychange");
  });

  it("sends the CSRF token from /api/status on mutating calls", () => {
    expect(appJs).toContain('init.headers["X-CSRF-Token"] = state.csrf');
    expect(appJs).toContain("status.csrf_token");
  });

  it("handles 401, 402 and 429 in one place", () => {
    expect(appJs).toMatch(/status === 401/);
    expect(appJs).toMatch(/status === 402/);
    expect(appJs).toMatch(/status === 429/);
  });

  it("loads app.js and the stylesheet", () => {
    expect(html).toContain('<script src="app.js">');
    expect(html).toContain('href="style.css"');
  });

  it("styles the classes app.js toggles", () => {
    // toggle("is-hidden") is inert unless the stylesheet defines it.
    expect(appJs).toContain('classList.toggle("is-hidden"');
    expect(css).toMatch(/\.is-hidden[^{]*\{[^}]*display:\s*none/);
  });

  it("only uses class names the stylesheet defines", () => {
    // No inline styles and no invented classes: the panel has to keep looking
    // like the Shoper admin, and a typo'd class is invisible until review.
    const used = new Set<string>();
    for (const match of appJs.matchAll(/class:\s*"([^"]+)"/g)) {
      for (const cls of (match[1] as string).split(/\s+/)) {
        if (cls) used.add(cls);
      }
    }
    const missing = [...used].filter((cls) => !css.includes(`.${cls}`)).sort();
    expect(missing).toEqual([]);
  });
});
