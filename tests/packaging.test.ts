/**
 * Packaging facts that are easy to get wrong and invisible until publish time:
 * a declared licence with no LICENSE file, an env var the code reads but the
 * example never mentions (so an operator ships an unauthenticated panel without
 * knowing the option existed), and a manifest that describes this application as
 * an importable library.
 */

import { existsSync, readFileSync } from "fs";
import { join } from "path";
import { describe, expect, it } from "vitest";

const ROOT = join(__dirname, "..");
const pkg = JSON.parse(readFileSync(join(ROOT, "package.json"), "utf8")) as {
  name: string;
  license: string;
  main?: string;
  types?: string;
  private?: boolean;
  bin?: Record<string, string>;
  files: string[];
  scripts: Record<string, string>;
  devDependencies: Record<string, string>;
};
const envExample = readFileSync(join(ROOT, ".env.example"), "utf8");
const readme = readFileSync(join(ROOT, "README.md"), "utf8");

/** Every process.env key the shipped source reads. */
function envKeysUsed(): Set<string> {
  const keys = new Set<string>();
  const files = ["server.ts", "webhook.ts", "jobs.ts", "scheduler.ts", "draft-store.ts"];
  for (const file of files) {
    const path = join(ROOT, "src", file);
    if (!existsSync(path)) continue;
    const source = readFileSync(path, "utf8");
    for (const match of source.matchAll(/env\["([A-Z_]+)"\]/g)) keys.add(match[1] as string);
  }
  return keys;
}

/** Assignable keys declared in .env.example. */
function envKeysDocumented(): Set<string> {
  const keys = new Set<string>();
  for (const match of envExample.matchAll(/^([A-Z_]+)=/gm)) keys.add(match[1] as string);
  return keys;
}

describe("licence", () => {
  it("ships the MIT text the manifest promises", () => {
    expect(pkg.license).toBe("MIT");
    const license = readFileSync(join(ROOT, "LICENSE"), "utf8");
    expect(license).toContain("MIT License");
    expect(license).toContain("Copyright (c) 2026 FOTOhub");
    expect(license).toContain("WITHOUT WARRANTY OF ANY KIND");
  });

  it("includes LICENSE in the published files", () => {
    expect(pkg.files).toContain("LICENSE");
  });
});

describe("manifest shape", () => {
  it("is packaged as an application, not a library", () => {
    // main/types would advertise an import surface this package does not have:
    // server.ts boots a listener and opens SQLite as a side effect of loading.
    expect(pkg.main).toBeUndefined();
    expect(pkg.types).toBeUndefined();
    expect(pkg.bin).toEqual({ "fotohub-shoper": "dist/server.js" });
  });

  it("keeps the bin entry executable via a shebang", () => {
    // npm links bin targets directly, so without this the command fails with a
    // syntax error from the shell rather than starting node.
    const source = readFileSync(join(ROOT, "src", "server.ts"), "utf8");
    expect(source.startsWith("#!/usr/bin/env node")).toBe(true);
  });

  it("exposes test scripts and pins vitest", () => {
    expect(pkg.scripts["test"]).toBe("vitest run");
    expect(pkg.scripts["test:watch"]).toBe("vitest");
    expect(pkg.devDependencies["vitest"]).toMatch(/^\^?3\./);
  });

  it("gates publish behind a build and the test suite", () => {
    // A green publish must be impossible while the suite is red.
    const prepublish = pkg.scripts["prepublishOnly"] ?? "";
    expect(prepublish).toContain("verify");
    expect(prepublish).toContain("build");
    expect(pkg.scripts["verify"]).toContain("test");
    expect(pkg.scripts["verify"]).toContain("typecheck");
  });

  it("type-checks the tests as well as the source", () => {
    expect(pkg.scripts["typecheck"]).toContain("tsconfig.test.json");
    expect(existsSync(join(ROOT, "tsconfig.test.json"))).toBe(true);
  });
});

describe(".env.example", () => {
  it("documents every env var the app reads", () => {
    const documented = envKeysDocumented();
    const missing = [...envKeysUsed()].filter((key) => !documented.has(key)).sort();
    expect(missing).toEqual([]);
  });

  it("still covers the original ten settings", () => {
    for (const key of [
      "SHOPER_STORE_URL",
      "SHOPER_ACCESS_TOKEN",
      "SHOPER_LOGIN",
      "SHOPER_PASSWORD",
      "FOTOHUB_API_KEY",
      "FOTOHUB_CONFIG_SECRET",
      "PORT",
      "HOST",
      "PUBLIC_URL",
      "DATA_DIR",
    ]) {
      expect(envKeysDocumented()).toContain(key);
    }
  });

  it("warns that an empty ADMIN_TOKEN leaves the panel unauthenticated", () => {
    // The whole risk of the optional gate is that its default is "off", so the
    // example is where that has to be said out loud.
    expect(envExample).toMatch(/ADMIN_TOKEN=/);
    expect(envExample).toContain("UNAUTHENTICATED");
    expect(envExample).toMatch(/X-Admin-Token/);
  });

  it("warns that TRUST_PROXY without a real proxy defeats the rate limiter", () => {
    expect(envExample).toMatch(/TRUST_PROXY=/);
    expect(envExample).toMatch(/X-Forwarded-For/);
    expect(envExample).toMatch(/forge/);
  });

  it("never ships a real-looking credential", () => {
    expect(envExample).not.toMatch(/fh_(live|test)_[A-Za-z0-9]{6,}/);
    // Every secret line must be left empty for the operator to fill in.
    for (const key of ["FOTOHUB_API_KEY", "SHOPER_PASSWORD", "ADMIN_TOKEN"]) {
      expect(envExample).toMatch(new RegExp(`^${key}=\\s*$`, "m"));
    }
  });
});

describe("README", () => {
  it("documents the admin token, including the unauthenticated default", () => {
    expect(readme).toContain("ADMIN_TOKEN");
    expect(readme).toMatch(/unauthenticated/i);
  });

  it("documents the rate limits", () => {
    expect(readme).toMatch(/429/);
    expect(readme).toMatch(/Retry-After/);
  });

  it("states honestly what variant support does and does not do", () => {
    // The plumbing cannot attach an image to a single variant, and the README
    // is where an optimistic docs matrix would otherwise claim it can.
    expect(readme).toMatch(/include_variants/);
    expect(readme).toMatch(/per product/i);
    expect(readme).toMatch(/ALT/);
  });
});
