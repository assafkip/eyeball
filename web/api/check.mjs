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
import { assertPublicUrl, hostIsBlocked, BlockedUrlError } from "../lib/guard.mjs";
import { buildReport } from "../lib/report.mjs";
import { render } from "../lib/engine/render.mjs";   // vendored copy of ../../src (web/ is self-contained for Vercel root=web)
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
    return { browserPath: await chromium.executablePath(), browserArgs: chromium.args || [] };
  } catch {
    return {}; // local/dev: fall back to the engine's on-disk browser resolver
  }
}

/** Render one URL and return a report. Throws BlockedUrlError on a blocked URL. */
export async function runCheck(rawUrl) {
  const { host, ips } = await assertPublicUrl(rawUrl, resolveHost);

  const { browserPath, browserArgs } = await serverlessBrowser();
  // Pin the target host to its validated IPv4 so Chrome cannot re-resolve (rebind)
  // it to a private address mid-render. Other hosts still hit the per-request guard
  // (fail-closed). Full cross-host pinning is in the pre-public-launch gate.
  const pin = [`--host-resolver-rules=MAP ${host} ${ips[0]}`];
  const config = {
    ...CONFIG,
    browserPath,
    browserArgs: [...(browserArgs || []), ...pin],
    blockHost: makeBlockHost(),
  };

  const data = await Promise.race([
    render(rawUrl, config),
    new Promise((_, rej) => setTimeout(() => rej(new Error("render-timeout")), RENDER_TIMEOUT_MS)),
  ]);
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
    // never echo internal stacks/errors to the client.
    return send(res, 502, { error: "Could not render that URL. Check it loads in a browser and try again." });
  }
}
