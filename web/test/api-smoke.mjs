/* ═══════════════════════════════════════════════════════════════════════════
   eyeball-web — test/api-smoke.mjs : verify the parts without network / @sparticuz.
     1) SSRF guard host table (public passes; loopback/private/encoded/rebind block).
     2) heuristic scorer: signals -> report shape, with weighting.
     3) spend guard FAILS CLOSED with no Upstash env (the deploy-safe invariant:
        no store => no paid call, kill switch off, free quota ungated).
     4) abuse limiter (in-memory).
     5) local render of our own slop page -> the scanner catches its own tells.
   ═══════════════════════════════════════════════════════════════════════════ */

import assert from "node:assert/strict";
import { dirname, join } from "node:path";
import { fileURLToPath, pathToFileURL } from "node:url";
import { assertPublicUrl } from "../lib/guard.mjs";
import { rateLimit, acquireSlot, releaseSlot, _reset } from "../lib/ratelimit.mjs";
import { scoreFromSignals, DESIGN_SIGNALS_EXPR } from "../lib/aiscore.mjs";
import { visionKillSwitchOn, storeReady, reserveSpend, consumeCaptchaToken, freeQuota, durableRateLimit } from "../lib/spendguard.mjs";
import { findBrowser } from "../lib/engine/render.mjs";

const HERE = dirname(fileURLToPath(import.meta.url));
let n = 0;
const ok = (name, cond) => { n++; assert.ok(cond, name); };

const DNS = {
  "rebind.test": ["10.0.0.1"],
  "v6only.test": ["2606:4700::1111"],
  "mixed.test": ["93.184.216.34", "fc00::1"],
  "dual.test": ["93.184.216.34", "2606:2800:220:1:248:1893:25c8:1946"],
};
const resolve = async (host) => DNS[host] || ["93.184.216.34"];
const blocked = async (u) => { try { await assertPublicUrl(u, resolve); return false; } catch (e) { return e.blocked === true; } };
const allowed = async (u) => { try { await assertPublicUrl(u, resolve); return true; } catch { return false; } };

async function main() {
  // 1) SSRF guard table
  for (const u of [
    "http://127.0.0.1/", "http://10.0.0.1/", "http://192.168.1.1/", "http://172.16.0.1/",
    "http://169.254.169.254/", "http://[::1]/", "http://2130706433/", "http://0x7f.0.0.1/",
    "http://0177.0.0.1/", "ftp://example.com/", "file:///etc/passwd", "http://localhost/",
    "http://rebind.test/", "http://[2606:4700:4700::1111]/", "http://v6only.test/", "http://mixed.test/",
  ]) ok("blocks " + u, await blocked(u));
  for (const u of ["http://example.com/", "https://example.com/a/b?q=1", "http://1.1.1.1/", "http://dual.test/"]) {
    ok("allows " + u, await allowed(u));
  }

  // 2) heuristic scorer
  const sloppy = scoreFromSignals({ bannedFont: true, h1Font: "inter", gradientText: true, cardTriplet: true, emojiInUi: true, badge: true, genericCopy: ["seamlessly", "leverage", "revolutionize"] });
  ok("sloppy signals score high", sloppy.aiScore >= 80);
  ok("sloppy report names the gradient tell", sloppy.tells.some((t) => /gradient/i.test(t.name)));
  ok("sloppy report names the font tell", sloppy.tells.some((t) => /font/i.test(t.name)));
  ok("every tell has a fix", sloppy.tells.every((t) => t.fix && t.fix.length > 10));
  ok("sloppy mode is scan", sloppy.mode === "scan");
  const clean = scoreFromSignals({ bannedFont: false, gradientText: false, gradientBg: false, cardTriplet: false, emojiInUi: false, badge: false, genericCopy: [] });
  ok("clean signals score low", clean.aiScore <= 35);
  ok("clean report has no tells", clean.tells.length === 0);

  // 3) spend guard fails closed with no Upstash env (deploy-safe invariant)
  ok("kill switch off by default", visionKillSwitchOn() === false);
  ok("store not ready without Upstash env", (await storeReady()) === false);
  const reserve = await reserveSpend();
  ok("reserveSpend fails closed (no store -> no paid call)", reserve.ok === false && reserve.reason === "no-store");
  ok("captcha token consume false without store", (await consumeCaptchaToken("x")) === false);
  const fq = await freeQuota("dev1", "1.2.3.4", false);
  ok("freeQuota ungated without store", fq.left === null && fq.exhausted === false);
  ok("durable rate limit fails open without store", (await durableRateLimit("1.2.3.4", 6, 60)).ok === true);

  // 4) abuse limiter
  _reset();
  const t0 = 1_000_000;
  for (let i = 0; i < 3; i++) ok(`ratelimit allows hit ${i + 1}/3`, rateLimit("ip1", 3, 60_000, t0 + i).ok === true);
  ok("ratelimit blocks the 4th", rateLimit("ip1", 3, 60_000, t0 + 3).ok === false);
  ok("ratelimit isolates keys", rateLimit("ip2", 3, 60_000, t0 + 3).ok === true);
  ok("ratelimit window slides", rateLimit("ip1", 3, 60_000, t0 + 60_001).ok === true);
  ok("concurrency: 2 then full", acquireSlot(2) && acquireSlot(2) && acquireSlot(2) === false);
  releaseSlot(); ok("concurrency: release frees a slot", acquireSlot(2) === true);
  releaseSlot(); releaseSlot();

  // 5) local render of our own slop page -> the scanner catches its own tells
  const browser = findBrowser();
  if (!browser) {
    console.log("api-smoke: NOTE local render skipped (no on-disk chromium)");
  } else {
    const puppeteer = (await import("puppeteer-core")).default;
    const b = await puppeteer.launch({ executablePath: browser, headless: true, args: ["--no-sandbox"] });
    try {
      const page = await b.newPage();
      await page.setViewport({ width: 1280, height: 800 });
      await page.goto(pathToFileURL(join(HERE, "../index.html")).href, { waitUntil: "load", timeout: 12000 });
      await new Promise((r) => setTimeout(r, 400));
      const signals = await page.evaluate(DESIGN_SIGNALS_EXPR);
      ok("slop page: detects the Inter/banned font", signals.bannedFont === true);
      ok("slop page: detects gradient", signals.gradientText === true || signals.gradientBg === true);
      ok("slop page: detects emoji-as-icon", signals.emojiInUi === true);
      ok("slop page: detects stock-prompt copy", Array.isArray(signals.genericCopy) && signals.genericCopy.length >= 2);
      const rep = scoreFromSignals(signals);
      ok("slop page scores high (>=70)", rep.aiScore >= 70);
    } finally { try { await b.close(); } catch {} }
  }

  console.log(`api-smoke: ${n} checks passed`);
}

main().catch((e) => { console.error("api-smoke FAILED:", e && e.message ? e.message : e); process.exit(1); });
