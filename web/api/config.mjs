/* eyeball-web — api/config.mjs : public client config.
   Exposes the Turnstile SITE key (public by design; the SECRET stays server-side)
   and the visitor's remaining free deep-reads. No secrets, ever. */
import { freeQuotaPeek } from "../lib/spendguard.mjs";

function getCookie(req, name) {
  const raw = (req.headers && req.headers.cookie) || "";
  for (const part of raw.split(";")) {
    const [k, ...v] = part.trim().split("=");
    if (k === name) return decodeURIComponent(v.join("="));
  }
  return null;
}
function clientIp(req) {
  const h = req.headers || {};
  const ip = h["x-vercel-forwarded-for"] || h["x-real-ip"];
  return (ip ? String(ip).split(",")[0].trim() : "") || (req.socket && req.socket.remoteAddress) || "unknown";
}

export default async function handler(req, res) {
  res.setHeader("content-type", "application/json; charset=utf-8");
  res.setHeader("cache-control", "no-store");
  // Advertise the site key only when the SECRET is also set, so the frontend never
  // shows a captcha the backend won't enforce (no fail-open mismatch).
  const turnstileSiteKey = (process.env.TURNSTILE_SITEKEY && process.env.TURNSTILE_SECRET)
    ? process.env.TURNSTILE_SITEKEY : null;

  let freeLeft = null;
  try {
    const q = await freeQuotaPeek(getCookie(req, "eb_dev"), clientIp(req));
    freeLeft = q.left;   // null when no durable store (free tier ungated, costs nothing)
  } catch { /* leave null */ }

  res.end(JSON.stringify({ turnstileSiteKey, freeLeft }));
}
