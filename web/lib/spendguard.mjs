/* ═══════════════════════════════════════════════════════════════════════════
   eyeball-web — lib/spendguard.mjs : the durable cost floor (Upstash Redis).

   The ONE control that actually bounds the Anthropic bill. Every function here
   FAILS CLOSED for the paid path: if Upstash is not provisioned, reserveSpend
   returns blocked, so the vision call cannot fire. The free heuristic scan is
   unaffected (it costs nothing).

   Env (all optional; absence = paid path stays off):
     UPSTASH_REDIS_REST_URL / UPSTASH_REDIS_REST_TOKEN  (Vercel Upstash integration)
     VISION_ENABLED=1            kill switch: must be "1" to allow any paid call
     DAILY_CAP_CENTS  (default 500 = $5/day)   MONTHLY_CAP_CENTS (default 5000 = $50/mo)
     VISION_COST_CENTS (default 2)             FREE_LIMIT (default 2)
   ═══════════════════════════════════════════════════════════════════════════ */

let _redis = null, _tried = false;
async function redis() {
  if (_tried) return _redis;
  _tried = true;
  const url = process.env.UPSTASH_REDIS_REST_URL;
  const token = process.env.UPSTASH_REDIS_REST_TOKEN;
  if (!url || !token) return (_redis = null);
  try {
    const { Redis } = await import("@upstash/redis");
    _redis = new Redis({ url, token });
  } catch { _redis = null; }
  return _redis;
}

const intEnv = (k, d) => { const n = parseInt(process.env[k] || "", 10); return Number.isFinite(n) ? n : d; };
const today = () => new Date().toISOString().slice(0, 10);   // serverless node: Date is fine
const month = () => new Date().toISOString().slice(0, 7);

/** Kill switch. The paid vision call requires this to be exactly "1". */
export function visionKillSwitchOn() { return process.env.VISION_ENABLED === "1"; }

/** Whether the durable store is even configured (paid path is impossible without it). */
export async function storeReady() { return !!(await redis()); }

/* ── the circuit breaker. Atomically reserve est-cost BEFORE the paid call.
   Returns {ok:true} only if a durable store is present AND both caps have room.
   On any failure or missing store -> {ok:false} (fail closed). */
export async function reserveSpend(estCents) {
  const cost = estCents != null ? estCents : intEnv("VISION_COST_CENTS", 2);
  const r = await redis();
  if (!r) return { ok: false, reason: "no-store" };
  const dailyCap = intEnv("DAILY_CAP_CENTS", 500);
  const monthlyCap = intEnv("MONTHLY_CAP_CENTS", 5000);
  const dKey = `spend:day:${today()}`, mKey = `spend:mo:${month()}`;
  try {
    const day = await r.incrby(dKey, cost);
    if (day === cost) await r.expire(dKey, 60 * 60 * 26);     // first write of the day -> TTL
    const mo = await r.incrby(mKey, cost);
    if (mo === cost) await r.expire(mKey, 60 * 60 * 24 * 32);
    if (day > dailyCap || mo > monthlyCap) {
      await r.decrby(dKey, cost); await r.decrby(mKey, cost); // refund the overshoot
      return { ok: false, reason: day > dailyCap ? "daily-cap" : "monthly-cap" };
    }
    return { ok: true };
  } catch { return { ok: false, reason: "store-error" }; }
}

/** Give budget back when the paid call did NOT happen (render failed, vision threw). */
export async function refundSpend(estCents) {
  const cost = estCents != null ? estCents : intEnv("VISION_COST_CENTS", 2);
  const r = await redis();
  if (!r) return;
  try { await r.decrby(`spend:day:${today()}`, cost); await r.decrby(`spend:mo:${month()}`, cost); } catch {}
}

/* ── single-use Turnstile token (anti-replay). Returns true if this token has
   not been seen before (and records it). Without a store, returns false so the
   paid path stays closed. */
export async function consumeCaptchaToken(token, ip) {
  const r = await redis();
  if (!r || !token || token.length > 4096) return false;   // bound pathological inputs
  try {
    const key = `tok:${ipSubnet(ip)}:${await sha256(token)}`; // IP-bound: one solve, one subnet
    const set = await r.set(key, "1", { nx: true, ex: 120 }); // short TTL: a token is used within seconds
    return set === "OK";
  } catch { return false; }
}

/* ── the free "N checks" ledger. Best-effort: durable when a store is present,
   ungated (and harmless, since the free scan costs nothing) when it is not.
   Returns {left, exhausted}. */
export async function freeQuota(deviceKey, ip, consume) {
  const limit = intEnv("FREE_LIMIT", 2);
  const r = await redis();
  if (!r) return { left: null, exhausted: false };
  try {
    const dKey = `free:dev:${deviceKey || "anon"}`;
    const ipKey = `free:ip:${ipSubnet(ip)}`;
    if (!consume) {
      const [d, i] = await Promise.all([r.get(dKey), r.get(ipKey)]);
      const used = Math.max(parseInt(d || "0", 10) || 0, parseInt(i || "0", 10) || 0);
      return { left: Math.max(0, limit - used), exhausted: used >= limit };
    }
    const d = await r.incr(dKey); if (d === 1) await r.expire(dKey, 60 * 60 * 24 * 30);
    const i = await r.incr(ipKey); if (i === 1) await r.expire(ipKey, 60 * 60 * 24 * 30);
    const used = Math.max(d, i);
    return { left: Math.max(0, limit - used), exhausted: used > limit };
  } catch { return { left: null, exhausted: false }; }
}

/* ── durable per-IP fixed-window limiter (second layer behind the in-memory one). */
export async function durableRateLimit(ip, max, windowSec) {
  const r = await redis();
  if (!r) return { ok: true };           // fail open: the in-memory limiter is the first layer
  try {
    const bucket = Math.floor(Date.now() / 1000 / windowSec);
    const key = `rl:${ipSubnet(ip)}:${windowSec}:${bucket}`;
    const n = await r.incr(key); if (n === 1) await r.expire(key, windowSec + 2);
    return { ok: n <= max };
  } catch { return { ok: true }; }
}

function ipSubnet(ip) {
  if (!ip) return "unknown";
  if (ip.includes(":")) return ip.split(":").slice(0, 4).join(":"); // IPv6 /64-ish
  return ip.split(".").slice(0, 3).join(".");                       // IPv4 /24
}

async function sha256(s) {
  const data = new TextEncoder().encode(s);
  const buf = await crypto.subtle.digest("SHA-256", data);
  return Array.from(new Uint8Array(buf)).map((b) => b.toString(16).padStart(2, "0")).join("");
}
