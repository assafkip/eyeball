/* ═══════════════════════════════════════════════════════════════════════════
   eyeball-web — api/check.mjs : the serverless render endpoint.

   GET/POST a `url`; we render it in a real headless browser and return a
   render-health report. SSRF-guarded in two layers: assertPublicUrl on the input,
   AND per-request interception in the engine (blockHost) so redirects/subresources
   to private hosts are aborted. @sparticuz/chromium is lazy-imported (so the local
   unit smoke needs neither it nor a network). Internal errors are never echoed.

   Pre-public-launch gate (see web/DEPLOY.md): durable rate limiting + captcha +
   DNS-rebind IP pinning are required before this is advertised publicly.
   ═══════════════════════════════════════════════════════════════════════════ */

import dns from "node:dns/promises";
import { dirname } from "node:path";
import { assertPublicUrl, hostIsBlocked, BlockedUrlError } from "../lib/guard.mjs";
import { buildReport } from "../lib/report.mjs";
import { render, measureExpr, SCROLL_FIRE_EXPR } from "../lib/engine/render.mjs";   // vendored copy of ../../src
import { assertRender } from "../lib/engine/assert.mjs";

const CONFIG = {
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
    heroInViewport: true, noRevealOverHero: true, noDraggableOnHero: true,
    noSignatureOverHero: true, heroFontNotBanned: ["arial", "helvetica", "system"],
    noConsoleErrors: true, requireGlobals: [], noXOverflow: true, heroMinOpacity: 0.9,
  },
  settleMs: 1200,
  scrollFire: true,
};

const RENDER_TIMEOUT_MS = 25000;
const timeout = (ms) => new Promise((_, rej) => setTimeout(() => rej(new Error("render-timeout")), ms));

const resolveHost = async (host) => {
  const recs = await dns.lookup(host, { all: true });
  return recs.map((r) => r.address);
};

/* the engine's per-request guard. Caches BLOCKED hosts only: an allowed host is
   re-resolved every time so a DNS rebind between requests is re-checked, and any
   error -> blocked (fail closed). */
function makeBlockHost() {
  const blockedHosts = new Set();
  return async (host) => {
    if (!host) return true;
    if (blockedHosts.has(host)) return true;
    let blocked = true;
    try { blocked = await hostIsBlocked(host, resolveHost); } catch { blocked = true; }
    if (blocked) blockedHosts.add(host);
    return blocked;
  };
}

async function serverlessBrowser() {
  // lazy: only needed for the real render, not for the unit smoke / local dev.
  try {
    const chromium = (await import("@sparticuz/chromium")).default;
    const browserPath = await chromium.executablePath();
    // @sparticuz decompresses chromium + its shared libs (libnss3.so etc.) to /tmp;
    // off-Lambda hosts must point LD_LIBRARY_PATH there or chromium exits with
    // "error while loading shared libraries". puppeteer spawns with process.env, so
    // set it on the process (not a per-call env). (libnss3.so scar, Vercel runtime.)
    const libDir = browserPath ? dirname(browserPath) : "/tmp";
    process.env.LD_LIBRARY_PATH = ["/tmp", libDir, "/tmp/lib", process.env.LD_LIBRARY_PATH].filter(Boolean).join(":");
    return {
      browserPath,
      browserArgs: chromium.args || [],
      headless: chromium.headless == null ? true : chromium.headless,
    };
  } catch {
    return {}; // local/dev: fall back to the engine's on-disk browser resolver
  }
}

/* Serverless render via puppeteer-core: it launches @sparticuz chromium with the
   correct shared-lib env + single-process that a hand-rolled spawn cannot (the
   libnss3.so scar), then we drive a page CDP session to produce the SAME facts the
   engine emits, reusing measureExpr + the scroll-fire + the platform-font read.
   The OSS engine stays the LOCAL render path; this is its serverless twin. */
async function renderViaPuppeteer(browser, url, config) {
  const expr = measureExpr(config.selectors || {}, (config.checks && config.checks.requireGlobals) || []);
  const settle = config.settleMs != null ? config.settleMs : 1200;
  const viewports = [];
  for (const vp of config.viewports) {
    const page = await browser.newPage();
    try {
      const consoleErrors = [];
      page.on("console", (m) => { if (m.type() === "error") consoleErrors.push("console.error: " + (m.text() || "").slice(0, 200)); });
      page.on("pageerror", (e) => consoleErrors.push("exception: " + ((e && e.message) || "").slice(0, 200)));
      const client = await page.createCDPSession();
      await client.send("DOM.enable").catch(() => {});
      await client.send("CSS.enable").catch(() => {});
      if (config.blockHost) {
        await client.send("Page.setDownloadBehavior", { behavior: "deny" }).catch(() => {});
        await client.send("Fetch.enable", { patterns: [{ urlPattern: "*" }] });
        client.on("Fetch.requestPaused", async (e) => {
          let blocked = true; // fail closed
          try { blocked = await config.blockHost(new URL(e.request.url).hostname); } catch { blocked = true; }
          try {
            if (blocked) await client.send("Fetch.failRequest", { requestId: e.requestId, errorReason: "Aborted" });
            else await client.send("Fetch.continueRequest", { requestId: e.requestId });
          } catch { /* request already gone */ }
        });
      }
      await page.setViewport({ width: vp.w, height: vp.h, isMobile: !!vp.mobile });
      await page.goto(url, { waitUntil: "load", timeout: 15000 });
      await new Promise((r) => setTimeout(r, settle));
      if (config.scrollFire !== false) { try { await page.evaluate(SCROLL_FIRE_EXPR); } catch {} }
      const facts = await page.evaluate(expr);
      facts.renderedFont = null;
      try {
        if (facts.hero && facts.hero.found && facts.hero.selector) {
          const doc = await client.send("DOM.getDocument", { depth: 0 });
          const { nodeId } = await client.send("DOM.querySelector", { nodeId: doc.root.nodeId, selector: facts.hero.selector });
          if (nodeId) {
            const pf = await client.send("CSS.getPlatformFontsForNode", { nodeId });
            const fonts = (pf.fonts || []).slice().sort((a, b) => (b.glyphCount || 0) - (a.glyphCount || 0));
            facts.renderedFont = fonts.length ? fonts[0].familyName : null;
          }
        }
      } catch { /* leave null */ }
      facts.consoleErrors = consoleErrors.slice();
      facts.viewport = { name: vp.name || `${vp.w}x${vp.h}`, w: vp.w, h: vp.h, mobile: !!vp.mobile };
      viewports.push(facts);
    } finally { try { await page.close(); } catch {} }
  }
  return { viewports };
}

/** Render one URL and return a report. Throws BlockedUrlError on a blocked URL. */
export async function runCheck(rawUrl) {
  const { host, ips } = await assertPublicUrl(rawUrl, resolveHost);
  // Pin the target host to its validated IPv4 so Chrome cannot re-resolve (rebind)
  // it to a private address mid-render. Other hosts still hit the per-request guard.
  const pin = `--host-resolver-rules=MAP ${host} ${ips[0]}`;
  const config = { ...CONFIG, blockHost: makeBlockHost() };

  const sb = await serverlessBrowser();
  if (sb.browserPath) {
    const puppeteer = (await import("puppeteer-core")).default;
    let browser;
    try {
      browser = await puppeteer.launch({
        executablePath: sb.browserPath,
        args: [...(sb.browserArgs || []), pin],
        headless: sb.headless,
      });
      const data = await Promise.race([renderViaPuppeteer(browser, rawUrl, config), timeout(RENDER_TIMEOUT_MS)]);
      return buildReport(data, assertRender(data, config));
    } finally { if (browser) try { await browser.close(); } catch {} }
  }

  // local/dev: the zero-dependency engine drives the on-disk browser (pipe transport).
  const local = { ...config, browserArgs: [pin], pipe: true };
  const data = await Promise.race([render(rawUrl, local), timeout(RENDER_TIMEOUT_MS)]);
  return buildReport(data, assertRender(data, config));
}

function send(res, code, body) {
  res.statusCode = code;
  res.setHeader("content-type", "application/json; charset=utf-8");
  res.setHeader("cache-control", "no-store");
  res.end(JSON.stringify(body));
}

export default async function handler(req, res) {
  let raw = "";
  try {
    const fromQuery = req.query && req.query.url;
    if (fromQuery) raw = Array.isArray(fromQuery) ? fromQuery[0] : fromQuery;
    else if (req.body) raw = typeof req.body === "string" ? JSON.parse(req.body).url : req.body.url;
  } catch { /* fall through to missing-url */ }
  if (!raw) return send(res, 400, { error: "Pass a url, e.g. ?url=https://example.com" });

  try {
    const report = await runCheck(raw);
    return send(res, 200, { url: raw, ...report });
  } catch (e) {
    if (e instanceof BlockedUrlError) return send(res, 400, { error: `Blocked URL: ${e.message}` });
    if (e && e.message === "render-timeout") return send(res, 504, { error: "The page took too long to render." });
    // log internally (Vercel function logs) but never echo internal stacks to the client.
    console.error("eyeball render error:", e && e.stack ? e.stack : e);
    var out = { error: "Could not render that URL. Check it loads in a browser and try again." };
    if (process.env.EYEBALL_DEBUG === "1") out.debug = String((e && e.message) || e);
    return send(res, 502, out);
  }
}
