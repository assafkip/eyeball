#!/usr/bin/env node
/* ═══════════════════════════════════════════════════════════════════════════
   eyeball — scan.mjs : the authoritative dogfood gate CLI.

   Renders a URL or local HTML file in a real browser, runs the design + UX
   read, prints the verdict, and exits non-zero if it FAILS the gate (AI-design
   too high, or the primary action is not in the first screen). This is what a
   "run it through eyeball before you ship" gate calls.

   Usage:
     node scan.mjs <url|file> [--vision] [--max-ai N]
   --vision  also runs the paid Claude UX read (needs ANTHROPIC_API_KEY)
   --max-ai  fail threshold for the AI-design score (default 75)
   Exit: 0 = PASS, 1 = FAIL, 64 = bad usage, 0 (advisory) if no browser on disk.
   ═══════════════════════════════════════════════════════════════════════════ */

import { existsSync } from "node:fs";
import { resolve } from "node:path";
import { pathToFileURL } from "node:url";
import { findBrowser } from "./lib/engine/render.mjs";
import { DESIGN_SIGNALS_EXPR, scoreFromSignals } from "./lib/aiscore.mjs";

const argv = process.argv.slice(2);
const arg = argv.find((a) => !a.startsWith("--"));
if (!arg) { console.error("usage: node scan.mjs <url|file> [--vision] [--max-ai N]"); process.exit(64); }
const wantVision = argv.includes("--vision");
const maxAi = (() => { const i = argv.indexOf("--max-ai"); const n = i >= 0 ? parseInt(argv[i + 1], 10) : NaN; return Number.isFinite(n) ? n : 75; })();

let target;
if (/^https?:\/\//i.test(arg)) target = arg;
else { const p = resolve(arg); if (!existsSync(p)) { console.error("not found: " + arg); process.exit(64); } target = pathToFileURL(p).href; }

const exe = findBrowser();
if (!exe) { console.error("eyeball: no chromium on disk; gate is advisory (skipped)."); process.exit(0); }

const puppeteer = (await import("puppeteer-core")).default;
const b = await puppeteer.launch({ executablePath: exe, headless: true, args: ["--no-sandbox"] });
let report, screenshot = null;
try {
  const page = await b.newPage();
  await page.setViewport({ width: 1280, height: 800, deviceScaleFactor: 1 });
  await page.goto(target, { waitUntil: "load", timeout: 20000 });
  await new Promise((r) => setTimeout(r, 700));
  const signals = await page.evaluate(DESIGN_SIGNALS_EXPR);
  report = scoreFromSignals(signals);
  if (wantVision) screenshot = await page.screenshot({ type: "jpeg", quality: 55, encoding: "base64", fullPage: false });
} finally { try { await b.close(); } catch {} }

if (wantVision && screenshot && process.env.ANTHROPIC_API_KEY) {
  try {
    process.env.VISION_ENABLED = "1";   // local CLI explicitly opts into the paid read
    const { scoreDesign } = await import("./lib/vision.mjs");
    report = await scoreDesign(screenshot);
  } catch (e) { console.error("vision read failed (" + (e && e.message) + "); using the free scan."); }
}

console.log(`\neyeball gate -> ${target}`);
console.log(`AI-design: ${report.aiScore}/100 (${report.band})  [${report.mode}]`);
console.log(report.verdict);
for (const t of report.tells || []) console.log(`  - ${t.name} :: ${t.fix}`);
if (report.ux) {
  const u = report.ux;
  console.log(`UX: ${u.primaryActionInFold === false ? "PRIMARY ACTION NOT IN FIRST SCREEN" : "action reachable in first screen"}` +
    `${u.secondsToUnderstand != null ? `  ~${u.secondsToUnderstand}s to understand` : ""}  bounce:${u.bounceRisk}`);
  for (const i of u.issues || []) console.log(`  ! ${i.issue} :: ${i.fix}`);
}

const failAi = report.aiScore > maxAi;
const failUx = report.ux && report.ux.primaryActionInFold === false;
if (failAi || failUx) {
  console.error(`\nGATE: FAIL — ${[failAi ? `AI-design ${report.aiScore} > ${maxAi}` : null, failUx ? "primary action not in first screen" : null].filter(Boolean).join(" + ")}`);
  process.exit(1);
}
console.log("\nGATE: PASS");
process.exit(0);
