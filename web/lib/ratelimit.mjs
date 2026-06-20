/* ═══════════════════════════════════════════════════════════════════════════
   eyeball-web — lib/ratelimit.mjs : abuse limiter for the public render endpoint.

   Best-effort sliding-window limiter keyed by client IP, plus a global per-instance
   in-flight cap. This bounds COGS + abuse on the MVP. It is PER-INSTANCE (serverless
   scales horizontally), so a durable store (Vercel KV / Upstash) + a captcha are the
   hardening for real volume; both are wired (see check.mjs verifyTurnstile + the
   pre-public-launch gate in DEPLOY.md). Pure + injectable clock for testing.
   ═══════════════════════════════════════════════════════════════════════════ */

const buckets = new Map();        // key -> number[] (recent hit timestamps)
let inFlight = 0;

/** sliding-window check. Returns {ok} or {ok:false, retryMs}. */
export function rateLimit(key, max, windowMs, now = Date.now()) {
  const recent = (buckets.get(key) || []).filter((t) => now - t < windowMs);
  if (recent.length >= max) {
    buckets.set(key, recent);
    return { ok: false, retryMs: Math.max(1000, windowMs - (now - recent[0])) };
  }
  recent.push(now);
  buckets.set(key, recent);
  if (buckets.size > 5000) {       // opportunistic cleanup so the map can't grow unbounded
    for (const [k, v] of buckets) if (!v.some((t) => now - t < windowMs)) buckets.delete(k);
  }
  return { ok: true, remaining: max - recent.length };
}

/** global concurrency guard: acquire() returns false when too many renders are
   already running on this instance (a render is expensive). Always release(). */
export function acquireSlot(maxConcurrent) {
  if (inFlight >= maxConcurrent) return false;
  inFlight += 1;
  return true;
}
export function releaseSlot() { inFlight = Math.max(0, inFlight - 1); }

/* test-only reset */
export function _reset() { buckets.clear(); inFlight = 0; }
