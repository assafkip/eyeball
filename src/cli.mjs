#!/usr/bin/env node
/* ═══════════════════════════════════════════════════════════════════════════
   eyeball — cli.mjs : render a page, assert the layout/render facts, exit.

   Usage:
     eyeball <file-or-url> [--config eyeball.config.json] [--settle ms]
     eyeball --doctor      resolve a browser + WebSocket, or print the install hint
     eyeball --selftest    run the package's negative self-test (test/selftest.mjs)

   Exit codes: 0 pass · 1 a render assertion failed (or a render error, fail-closed)
   · 2 usage / bad config / self-test broken · 3 no browser found (install one;
   eyeball adds no npm dependency).
   ═══════════════════════════════════════════════════════════════════════════ */

import { existsSync, readFileSync } from "node:fs";
import { join, dirname, resolve } from "node:path";
import { fileURLToPath, pathToFileURL } from "node:url";
import { render, doctor, INSTALL_HINT } from "./render.mjs";
import { assertRender } from "./assert.mjs";

const HERE = dirname(fileURLToPath(import.meta.url));

/* the built-in default config: the markup contract + the common checks. A project
   overrides it with --config or an eyeball.config.json in the working directory. */
const DEFAULT_CONFIG = {
  viewports: [
    { name: "desktop", w: 1440, h: 900 },
    { name: "mobile", w: 390, h: 844, mobile: true },
  ],
  selectors: {
    hero: ["[data-hero-h1]", "h1"],
    reveal: ["[data-reveal]", ".truth"],
    signature: ["[data-signature]"],
    draggable: ["[data-draggable]"],
  },
  checks: {
    heroInViewport: true,
    noRevealOverHero: true,
    noDraggableOnHero: true,
    heroFontNotBanned: ["arial", "helvetica", "system"],
    noConsoleErrors: true,
    requireGlobals: [],
    noXOverflow: true,
    heroMinOpacity: 0.9,
  },
  settleMs: 2000,
  scrollFire: true,
};

function loadConfig(explicitPath) {
  let cfg = {};
  const path = explicitPath || (existsSync(join(process.cwd(), "eyeball.config.json")) ? join(process.cwd(), "eyeball.config.json") : null);
  if (path) {
    if (!existsSync(path)) { process.stderr.write(`eyeball: config not found: ${path}\n`); process.exit(2); }
    try { cfg = JSON.parse(readFileSync(path, "utf8")); }
    catch (e) { process.stderr.write(`eyeball: bad config JSON (${e.message})\n`); process.exit(2); }
  }
  const merged = {
    ...DEFAULT_CONFIG, ...cfg,
    checks: { ...DEFAULT_CONFIG.checks, ...(cfg.checks || {}) },
    selectors: { ...DEFAULT_CONFIG.selectors, ...(cfg.selectors || {}) },
  };
  // a config with viewports null/empty would crash the OK line; fall back to default.
  if (!Array.isArray(merged.viewports) || merged.viewports.length === 0) merged.viewports = DEFAULT_CONFIG.viewports;
  return JSON.parse(JSON.stringify(merged));   // fresh copy, safe to mutate (--settle)
}

async function main() {
  const argv = process.argv.slice(2);
  if (argv.includes("--doctor")) process.exit(doctor());

  if (argv.includes("--selftest")) {
    const stPath = join(HERE, "..", "test", "selftest.mjs");
    if (!existsSync(stPath)) { process.stderr.write("eyeball: test/selftest.mjs not present in this build\n"); process.exit(2); }
    const mod = await import(pathToFileURL(stPath).href);
    process.exit(await mod.selftest());
  }

  const cfgIdx = argv.indexOf("--config");
  if (cfgIdx >= 0 && (cfgIdx + 1 >= argv.length || argv[cfgIdx + 1].startsWith("--"))) {
    process.stderr.write("eyeball: --config needs a path\n"); process.exit(2);
  }
  const settleIdx = argv.indexOf("--settle");
  if (settleIdx >= 0 && (settleIdx + 1 >= argv.length || argv[settleIdx + 1].startsWith("--"))) {
    process.stderr.write("eyeball: --settle needs a number in ms\n"); process.exit(2);
  }
  const cfgPath = cfgIdx >= 0 ? argv[cfgIdx + 1] : null;
  const target = argv.find((a, i) => !a.startsWith("--") && argv[i - 1] !== "--config" && argv[i - 1] !== "--settle");
  if (!target) { process.stderr.write("usage: eyeball <file-or-url> [--config path] [--settle ms] | --doctor | --selftest\n"); process.exit(2); }

  const config = loadConfig(cfgPath ? resolve(cfgPath) : null);
  if (settleIdx >= 0) { const ms = parseInt(argv[settleIdx + 1], 10); if (!isNaN(ms)) config.settleMs = ms; }
  const targetArg = /^[a-z]+:\/\//i.test(target) ? target : resolve(target);

  try {
    const data = await render(targetArg, config);
    const violations = assertRender(data, config);
    if (violations.length) {
      process.stdout.write(`eyeball: FAIL (${violations.length}) on ${target}\n`);
      for (const v of violations) process.stdout.write(`  - ${v}\n`);
      process.exit(1);
    }
    process.stdout.write(`eyeball: OK ${target} passed render checks at ${config.viewports.length} viewport(s)\n`);
    process.exit(0);
  } catch (e) {
    if (e && e.code === "NO_BROWSER") { process.stderr.write(INSTALL_HINT + "\n"); process.exit(3); }
    process.stderr.write(`eyeball: render failed, failing closed: ${e && e.message ? e.message : e}\n`);
    process.exit(1);
  }
}

main();
