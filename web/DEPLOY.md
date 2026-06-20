# eyeball-web — deploy + GO-gate

**Product:** paste a URL → eyeball renders the homepage and scores how AI-generated the
design looks. Two layers:

- **Free scan** (always on, costs nothing): a deterministic read of the rendered page
  (converged fonts, the violet/blue gradient, three-identical-cards, emoji icons,
  stock-prompt copy, "Powered by AI" badge). `lib/aiscore.mjs`.
- **Paid deep read** (Claude vision): sends ONLY a screenshot to Claude for a sharper
  judgment + per-tell fixes. `lib/vision.mjs`. **Off by default. Fail-closed.**

## Safe by construction

The paid call fires only when ALL hold (any miss → free scan, nothing billed):
`VISION_ENABLED=1` · `ANTHROPIC_API_KEY` set · `TURNSTILE_SECRET` set · Upstash
reachable · valid single-use captcha token · atomic spend reserve under the daily/
monthly cap · a screenshot was actually captured. So you can deploy right now and the
worst case is a free deterministic scan — there is no path to an Anthropic bill until
you do the GO-gate below.

Verified locally: `node test/api-smoke.mjs` → 46 checks (SSRF table, heuristic scorer,
**spend guard fails closed with no Upstash env**, rate limiter, and a live render of our
own slop page that the scanner correctly flags).

## Deploy (free scan only — safe today)

```
cd ~/projects/eyeball/web
vercel deploy --yes --scope assaf-kipnis-projects -e AWS_LAMBDA_JS_RUNTIME=nodejs20.x
```
(`AWS_LAMBDA_JS_RUNTIME` is required for chromium to launch — the libnss3 fix.)

## GO-gate — turn ON the paid Claude vision read (your account actions)

The threat model is a hard NO-GO on exposing the paid call until the durable cost floor
is live. These are billing/account actions, so they are yours. Do all of 1–5, then 6.

1. **Upstash Redis** (the spend breaker — the one control that bounds the bill):
   Vercel dashboard → Storage → Upstash Redis → connect to the `eyeball-web` project.
   It auto-injects `UPSTASH_REDIS_REST_URL` + `UPSTASH_REDIS_REST_TOKEN`.
2. **Anthropic key + cap:** create a DEDICATED Anthropic API key used only by eyeball,
   set a monthly spend limit + alerts on it in the Anthropic Console, then add it to
   Vercel as `ANTHROPIC_API_KEY` (Production, server runtime only).
3. **Vercel spend cap:** Vercel → Settings → Spend Management → hard monthly cap with
   auto-pause (bounds compute even if app logic fails).
4. **Cloudflare Turnstile** (captcha): create a free widget, add `TURNSTILE_SITEKEY` +
   `TURNSTILE_SECRET` to Vercel env. The frontend widget + backend enforcement +
   single-use token check activate automatically.
5. **Caps (optional, have defaults):** `DAILY_CAP_CENTS` (default 500 = $5/day),
   `MONTHLY_CAP_CENTS` (5000 = $50/mo), `VISION_COST_CENTS` (2), `FREE_LIMIT` (2),
   `VISION_MODEL` (default `claude-sonnet-4-6`; set `claude-haiku-4-5` to go cheaper or
   `claude-opus-4-8` for the sharpest eye).
6. **Flip the kill switch:** set `VISION_ENABLED=1`. (To stop spend instantly during an
   incident, set it back to `0` — no redeploy needed.)

## Residual risk (accepted, per the threat model)

Distributed denial-of-wallet via proxy/botnet rotation is bounded only by the global
daily cap: the worst an attacker can do is burn the chosen daily cap (a fixed, survivable
dollar amount) and deny service for the rest of that UTC day. Acceptable only because the
cap is hard, identity-independent, and checked atomically BEFORE the call. The only
durable fix beyond the cap is requiring a verified identity before paid calls (deferred).

## Hardening backlog (should-have / later, from the threat model)

- result cache + in-flight dedup keyed by normalized URL (anti-amplification);
- redirect-hop + subresource IP pinning (initial host is pinned; subresource hosts are
  re-validated per request but not pinned);
- Vercel WAF rate rule on `/api/check` + BotID; IPv6 keyed by /64;
- verified-identity tier for monetization beyond the anonymous free pool.
