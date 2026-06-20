/* ═══════════════════════════════════════════════════════════════════════════
   eyeball-web — api/check.mjs : score how AI-generated a homepage's design looks.

   Render the URL in headless chromium -> (a) extract cheap design signals + (b) take
   a screenshot. The FREE path scores from the signals (deterministic, no model). The
   PAID path sends ONLY the screenshot to Claude vision for a sharper read + fixes.

   The paid call FAILS CLOSED. It fires only when ALL of these hold:
     VISION_ENABLED=1 (kill switch) · ANTHROPIC_API_KEY set · TURNSTILE_SECRET set ·
     Upstash store reachable · valid single-use captcha token · atomic spend reserve
     under the daily/monthly cap · a screenshot actually captured.
   Miss any one -> the free heuristic scan is returned and nothing is billed. So
   deploying without the account-level setup is safe by construction.

   SSRF: assertPublicUrl on input + target-IP pin + per-request fail-closed host
   re-validation in the CDP Fetch interceptor. Trusted client IP only.
   ═══════════════════════════════════════════════════════════════════════════ */

import dns from "node:dns/promises";
import { dirname } from "node:path";
import { randomUUID } from "node:crypto";
import { assertPublicUrl, hostIsBlocked, BlockedUrlError } from "../lib/guard.mjs";
import { findBrowser } from "../lib/browser.mjs";   // on-disk browser resolver (local dev)
import { rateLimit, acquireSlot, releaseSlot } from "../lib/ratelimit.mjs";
import { DESIGN_SIGNALS_EXPR, scoreFromSignals } from "../lib/aiscore.mjs";
import { scoreDesign, isJpegBase64 } from "../lib/vision.mjs";
import {
  visionKillSwitchOn, storeReady, reserveSpend, refundSpend,
  consumeCaptchaToken, freeQuota, durableRateLimit,
} from "../lib/spendguard.mjs";

const PER_MIN = 6, PER_HOUR = 40, MAX_CONCURRENT = 4;
const RENDER_TIMEOUT_MS = 14000;
const timeout = (ms) => new Promise((_, rej) => setTimeout(() => rej(new Error("render-timeout")), ms));

function clientIp(req) {
  const h = req.headers || {};
  // Trusted platform headers ONLY. x-forwarded-for is client-controllable (an attacker
  // rotates it to mint fresh rate-limit/quota buckets), so it is deliberately NOT used.
  const ip = h["x-vercel-forwarded-for"] || h["x-real-ip"];
  return (ip ? String(ip).split(",")[0].trim() : "") || (req.socket && req.socket.remoteAddress) || "unknown";
}

const resolveHost = async (host) => {
  const recs = await dns.lookup(host, { all: true });
  return recs.map((r) => r.address);
};

/* per-request SSRF guard. Caches BLOCKED hosts only: allowed hosts are re-resolved
   every request (DNS-rebind re-check), and any error -> blocked (fail closed). */
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

/* Cloudflare Turnstile server-side verify. Returns false when not configured, so the
   PAID path (which requires TURNSTILE_SECRET) stays off until keys are set. */
async function verifyTurnstile(token, ip) {
  const secret = process.env.TURNSTILE_SECRET;
  if (!secret || !token) return false;
  try {
    const r = await fetch("https://challenges.cloudflare.com/turnstile/v0/siteverify", {
      method: "POST",
      headers: { "content-type": "application/x-www-form-urlencoded" },
      body: new URLSearchParams({ secret, response: token, remoteip: ip || "" }),
    });
    const j = await r.json();
    return !!(j && j.success);
  } catch { return false; }
}
async function captchaOkForVision(token, ip) {
  if (!(await verifyTurnstile(token, ip))) return false;
  return await consumeCaptchaToken(token, ip);   // single-use, IP-bound; false on replay / no store
}

async function serverlessBrowser() {
  try {
    const chromium = (await import("@sparticuz/chromium")).default;
    // @sparticuz only extracts the NSS libs when AWS_LAMBDA_JS_RUNTIME is set AT IMPORT
    // (set as a deploy env). setGraphicsMode(false) drops swiftshader; LD_LIBRARY_PATH
    // points chromium at the exec dir. (the libnss3.so crack.)
    try { if (typeof chromium.setGraphicsMode === "function") chromium.setGraphicsMode(false); else chromium.setGraphicsMode = false; } catch {}
    const browserPath = await chromium.executablePath();
    const libDir = browserPath ? dirname(browserPath) : "/tmp";
    process.env.LD_LIBRARY_PATH = [libDir, "/tmp", process.env.LD_LIBRARY_PATH].filter(Boolean).join(":");
    return { browserPath, browserArgs: chromium.args || [], headless: chromium.headless == null ? true : chromium.headless };
  } catch { return {}; }
}

/* Render at a fixed desktop viewport; return design signals + a capped JPEG screenshot.
   Budgets: 12s nav, a request-count cap, fixed 1280x800 viewport, quality-55 JPEG —
   all bound per-request compute + image-token cost. Throws on nav failure. */
async function renderDesign(browser, url, blockHost) {
  const page = await browser.newPage();
  try {
    let reqCount = 0;
    const client = await page.createCDPSession();
    await client.send("Page.setDownloadBehavior", { behavior: "deny" }).catch(() => {});
    await client.send("Fetch.enable", { patterns: [{ urlPattern: "*" }] });
    client.on("Fetch.requestPaused", async (e) => {
      let blocked = true;                                   // fail closed
      try { blocked = await blockHost(new URL(e.request.url).hostname); } catch { blocked = true; }
      if (!blocked && ++reqCount > 300) blocked = true;     // request-count budget
      try {
        if (blocked) await client.send("Fetch.failRequest", { requestId: e.requestId, errorReason: "Aborted" });
        else await client.send("Fetch.continueRequest", { requestId: e.requestId });
      } catch { /* gone */ }
    });
    await page.setViewport({ width: 1280, height: 800, deviceScaleFactor: 1 });
    await page.goto(url, { waitUntil: "load", timeout: 12000 });
    await new Promise((r) => setTimeout(r, 900));
    let signals = {};
    try { signals = await page.evaluate(DESIGN_SIGNALS_EXPR); } catch {}
    let screenshot = null;
    try { screenshot = await page.screenshot({ type: "jpeg", quality: 55, encoding: "base64", fullPage: false }); } catch {}
    return { signals, screenshot };
  } finally { try { await page.close(); } catch {} }
}

/** Score one URL. ctx: { ip, captchaToken, deviceKey }. Throws BlockedUrlError on a blocked URL. */
export async function runCheck(rawUrl, ctx = {}) {
  const { host, ips } = await assertPublicUrl(rawUrl, resolveHost);
  const pin = `--host-resolver-rules=MAP ${host} ${ips[0]}`;
  const blockHost = makeBlockHost();

  const sb = await serverlessBrowser();
  const executablePath = sb.browserPath || findBrowser();
  if (!executablePath) throw new Error("no browser available");
  const puppeteer = (await import("puppeteer-core")).default;

  let browser, rendered;
  try {
    browser = await puppeteer.launch({
      executablePath,
      args: [...(sb.browserArgs || []), pin, "--no-sandbox"],
      headless: sb.headless == null ? true : sb.headless,
    });
    rendered = await Promise.race([renderDesign(browser, rawUrl, blockHost), timeout(RENDER_TIMEOUT_MS)]);
  } finally { if (browser) try { await browser.close(); } catch {} }

  const { signals, screenshot } = rendered || {};
  let report = scoreFromSignals(signals);     // FREE heuristic — always returned
  let freeLeft = null, paywalled = false;

  // PAID vision read — every gate must pass; otherwise the free scan stands (fail closed).
  const paidEligible = visionKillSwitchOn()
    && !!process.env.ANTHROPIC_API_KEY
    && !!process.env.TURNSTILE_SECRET
    && isJpegBase64(screenshot)                // a real screenshot, or no paid call
    && (await storeReady());                   // no durable cap, no paid call

  if (paidEligible) {
    const q = await freeQuota(ctx.deviceKey, ctx.ip, false);
    freeLeft = q.left;
    if (q.exhausted) {
      paywalled = true;                        // out of free deep reads -> quick scan only
    } else if (await captchaOkForVision(ctx.captchaToken, ctx.ip)) {
      const reserve = await reserveSpend();    // atomic, BEFORE the paid call
      if (reserve.ok) {
        try {
          report = await scoreDesign(screenshot);
          const used = await freeQuota(ctx.deviceKey, ctx.ip, true);
          freeLeft = used.left;
        } catch { await refundSpend(); /* paid call failed -> refund + keep free scan */ }
      }
      // reserve not ok (over cap) -> keep the free scan, consume no credit
    }
  }
  return { url: rawUrl, ...report, freeLeft, paywalled };
}

/* ── cookie helpers (device key for the free-quota ledger) */
function getCookie(req, name) {
  const raw = (req.headers && req.headers.cookie) || "";
  for (const part of raw.split(";")) {
    const [k, ...v] = part.trim().split("=");
    if (k === name) return decodeURIComponent(v.join("="));
  }
  return null;
}

function send(res, code, body) {
  res.statusCode = code;
  res.setHeader("content-type", "application/json; charset=utf-8");
  res.setHeader("cache-control", "no-store");
  res.setHeader("x-content-type-options", "nosniff");
  res.end(JSON.stringify(body));
}

export default async function handler(req, res) {
  // device key for the free-quota ledger (httpOnly cookie; IP subnet is the backstop)
  let deviceKey = getCookie(req, "eb_dev");
  if (!deviceKey) {
    deviceKey = randomUUID();
    res.setHeader("set-cookie", `eb_dev=${deviceKey}; Path=/; Max-Age=31536000; HttpOnly; Secure; SameSite=Lax`);
  }

  let raw = "";
  try {
    const fromQuery = req.query && req.query.url;
    if (fromQuery) raw = Array.isArray(fromQuery) ? fromQuery[0] : fromQuery;
    else if (req.body) raw = typeof req.body === "string" ? JSON.parse(req.body).url : req.body.url;
  } catch { /* fall through */ }
  if (!raw) return send(res, 400, { error: "Pass a url, e.g. ?url=https://example.com" });

  const ip = clientIp(req);
  const token = (req.query && (req.query["cf-turnstile-response"] || req.query.token)) ||
    (req.body && typeof req.body === "object" ? req.body["cf-turnstile-response"] : undefined);

  // rate limit: in-memory fast path + durable second layer
  if (!rateLimit(`m:${ip}`, PER_MIN, 60_000).ok || !rateLimit(`h:${ip}`, PER_HOUR, 3_600_000).ok
      || !(await durableRateLimit(ip, PER_MIN, 60)).ok) {
    res.setHeader("retry-after", "60");
    return send(res, 429, { error: "Too many checks. Give it a minute and try again." });
  }
  if (!acquireSlot(MAX_CONCURRENT)) return send(res, 429, { error: "Busy right now. Try again in a few seconds." });

  try {
    const report = await runCheck(raw, { ip, captchaToken: token, deviceKey });
    return send(res, 200, report);
  } catch (e) {
    if (e instanceof BlockedUrlError) return send(res, 400, { error: `Blocked URL: ${e.message}` });
    if (e && e.message === "render-timeout") return send(res, 504, { error: "That page took too long to load." });
    console.error("eyeball check error:", e && e.message ? e.message : e);  // server log only: message, never headers/stacks/client echo
    return send(res, 502, { error: "Could not score that URL. Check it loads in a browser and try again." });
  } finally {
    releaseSlot();
  }
}
