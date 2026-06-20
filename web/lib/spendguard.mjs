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

/* the day+month incr, the cap check, and the over-cap refund run in ONE atomic
   Lua eval so a concurrent burst can't overshoot and a mid-sequence failure can't
   leave a counter permanently overstated (the denial-of-wallet hole). Returns 1
   if reserved under both caps, 0 if over (and atomically refunded). */
const RESERVE_LUA = `
local cost = tonumber(ARGV[1])
local d = redis.call('INCRBY', KEYS[1], cost)
if d == cost then redis.call('EXPIRE', KEYS[1], tonumber(ARGV[4])) end
local m = redis.call('INCRBY', KEYS[2], cost)
if m == cost then redis.call('EXPIRE', KEYS[2], tonumber(ARGV[5])) end
if d > tonumber(ARGV[2]) or m > tonumber(ARGV[3]) then
  redis.call('DECRBY', KEYS[1], cost)
  redis.call('DECRBY', KEYS[2], cost)
  return 0
end
return 1`;
const REFUND_LUA = `redis.call('DECRBY', KEYS[1], tonumber(ARGV[1])); redis.call('DECRBY', KEYS[2], tonumber(ARGV[1])); return 1`;

/* ── the circuit breaker. Atomically reserve est-cost BEFORE the paid call.
   {ok:true} only if a durable store is present AND both caps have room.
   On any failure or missing store -> {ok:false} (fail closed). */
export async function reserveSpend(estCents) {
  const cost = estCents != null ? estCents : intEnv("VISION_COST_CENTS", 2);
  const r = await redis();
  if (!r) return { ok: false, reason: "no-store" };
  const dailyCap = intEnv("DAILY_CAP_CENTS", 500);
  const monthlyCap = intEnv("MONTHLY_CAP_CENTS", 5000);
  const dKey = `spend:day:${today()}`, mKey = `spend:mo:${month()}`;
  try {
    const okv = await r.eval(RESERVE_LUA, [dKey, mKey], [String(cost), String(dailyCap), String(monthlyCap), String(60 * 60 * 26), String(60 * 60 * 24 * 32)]);
    return Number(okv) === 1 ? { ok: true } : { ok: false, reason: "cap" };
  } catch { return { ok: false, reason: "store-error" }; }
}

/** Give budget back when the paid call did NOT happen (render failed, vision threw). Atomic. */
export async function refundSpend(estCents) {
  const cost = estCents != null ? estCents : intEnv("VISION_COST_CENTS", 2);
  const r = await redis();
  if (!r) return;
  try { await r.eval(REFUND_LUA, [`spend:day:${today()}`, `spend:mo:${month()}`], [String(cost)]); } catch {}
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

/* ── the free "N checks" ledger. Atomic check-and-consume so concurrent requests
   can't both slip past the limit (the TOCTOU hole). Durable when a store is
   present; ungated (harmless, the free scan costs nothing) when it is not. */
const FREE_CONSUME_LUA = `
local limit = tonumber(ARGV[1])
local dv = tonumber(redis.call('GET', KEYS[1]) or '0')
local ip = tonumber(redis.call('GET', KEYS[2]) or '0')
if math.max(dv, ip) >= limit then return -1 end
local nd = redis.call('INCR', KEYS[1]); if nd == 1 then redis.call('EXPIRE', KEYS[1], tonumber(ARGV[2])) end
local ni = redis.call('INCR', KEYS[2]); if ni == 1 then redis.call('EXPIRE', KEYS[2], tonumber(ARGV[2])) end
local left = limit - math.max(nd, ni)
if left < 0 then left = 0 end
return left`;
const FREE_REFUND_LUA = `
if tonumber(redis.call('GET', KEYS[1]) or '0') > 0 then redis.call('DECR', KEYS[1]) end
if tonumber(redis.call('GET', KEYS[2]) or '0') > 0 then redis.call('DECR', KEYS[2]) end
return 1`;
const freeKeys = (deviceKey, ip) => [`free:dev:${deviceKey || "anon"}`, `free:ip:${ipSubnet(ip)}`];

/** Non-consuming peek (config endpoint display only). */
export async function freeQuotaPeek(deviceKey, ip) {
  const limit = intEnv("FREE_LIMIT", 2);
  const r = await redis();
  if (!r) return { left: null, exhausted: false };
  try {
    const [d, i] = await Promise.all(freeKeys(deviceKey, ip).map((k) => r.get(k)));
    const used = Math.max(parseInt(d || "0", 10) || 0, parseInt(i || "0", 10) || 0);
    return { left: Math.max(0, limit - used), exhausted: used >= limit };
  } catch { return { left: null, exhausted: false }; }
}

/** Atomically reserve ONE free credit BEFORE the paid call. exhausted=true (and
   nothing consumed) once the limit is reached. */
export async function freeQuotaConsume(deviceKey, ip) {
  const limit = intEnv("FREE_LIMIT", 2);
  const r = await redis();
  if (!r) return { left: null, exhausted: false };   // no store -> ungated (free scan is free)
  try {
    const left = Number(await r.eval(FREE_CONSUME_LUA, freeKeys(deviceKey, ip), [String(limit), String(60 * 60 * 24 * 30)]));
    return left < 0 ? { left: 0, exhausted: true } : { left, exhausted: false };
  } catch { return { left: null, exhausted: false }; }
}

/** Hand a consumed credit back when the paid call did not happen. */
export async function freeQuotaRefund(deviceKey, ip) {
  const r = await redis();
  if (!r) return;
  try { await r.eval(FREE_REFUND_LUA, freeKeys(deviceKey, ip), []); } catch {}
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
