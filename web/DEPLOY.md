# eyeball-web — deploy + verification receipt

The free "paste a URL, get a render-health report" MVP. Powered by the eyeball
engine (`../src/render.mjs`) on serverless chromium.

## Verified locally (this build)

- **Dogfood gate (the bypass):** `node ../src/cli.mjs web/index.html` -> OK at both
  viewports. The landing passes eyeball's own render gate (hero in the fold, real
  font, no overlap, no console errors, no x-overflow).
- **End-to-end render:** `runCheck("https://example.com")` returned a real report
  (ok:false, score 72, 2 defects: example.com's system-font headline trips the
  font check at desktop + mobile). Path proven: SSRF guard -> IPv4 pin -> engine
  render (local chromium) -> assertions -> report.
- **API smoke:** `node test/api-smoke.mjs` -> 27 checks (SSRF host table incl.
  encoded IPs / IPv6 / private-AAAA / rebind, pure report, file:// engine render).

## Deploy status (2026-06-20)

Deployed to a Vercel preview (project `eyeball-web`, scope `assaf-kipnis-projects`,
SSO-walled). The engine is vendored into `web/lib/engine`, so the deploy roots at
`web/` and is self-contained.

```
cd ~/projects/eyeball/web
vercel deploy --yes --scope assaf-kipnis-projects     # preview, SSO-walled
```

- **Landing + /api/check: LIVE and rendering** behind the SSO wall.
  `/api/check?url=https://example.com` returns a real report (ok:true, score 100).

### How the serverless render was fixed (the libnss3 crack)

A live diagnostic (`/api/check?diag=1`, debug-only) showed the truth: Node was 20.x
(fine), but `libnss3.so` was genuinely absent and only the graphics libs
(swiftshader) had been extracted to /tmp. Root cause: `@sparticuz/chromium` only
extracts the NSS crypto libs when it detects a Lambda runtime AT IMPORT, which
Vercel does not set. Fix (in `api/check.mjs` + deploy):
- `chromium.setGraphicsMode(false)` (drop the swiftshader libs we don't need),
- `process.env.LD_LIBRARY_PATH = dirname(executablePath)` before launch,
- deploy env `AWS_LAMBDA_JS_RUNTIME=nodejs20.x` so @sparticuz extracts the full
  lib set (this is the breakthrough). Engine pinned to Node 20.x.

**Deploy command (the env var is REQUIRED):**
```
vercel deploy --yes --scope assaf-kipnis-projects -e AWS_LAMBDA_JS_RUNTIME=nodejs20.x
```
Best: also set `AWS_LAMBDA_JS_RUNTIME=nodejs20.x` for ALL environments in the
Vercel dashboard (Settings -> Environment Variables) so plain `vercel deploy`
works without `-e`. The CLI env-add for the Preview target was flaky in testing;
the dashboard is the reliable place.

## PUBLIC (2026-06-20)

Deployment protection is OFF; the tool is publicly reachable and rendering:
- **https://eyeball-web-assaf-kipnis-projects.vercel.app** (also `eyeball-web.vercel.app`)
- Verified public (no auth): example.com -> clean/100; news.ycombinator.com -> 80
  (2 issues); vercel.com -> 0 (10 issues); stripe.com -> graceful timeout.

Live abuse protection: per-IP rate limit (6/min, 40/hour), a per-instance
concurrency slot, the SSRF guard, and a hard render timeout. Cloudflare Turnstile
captcha is BUILT and turns on automatically once its keys are set.

### Before promoting it widely (do these 2):
1. **Captcha:** create a free Cloudflare Turnstile widget, then add
   `TURNSTILE_SITEKEY` + `TURNSTILE_SECRET` to the Vercel project env (all
   environments). The frontend widget + backend enforcement activate automatically.
2. **Spend cap:** set a Vercel spend limit (Settings -> Billing) so abuse can never
   run up an unbounded bill. The in-memory rate limit is best-effort per instance;
   durable rate limiting (Vercel KV) + the spend cap are the real backstops.

## SECURITY: pre-public-launch gate (hardening detail)

The MVP preview is unadvertised and protected by: the SSRF guard (resolve-all-
records IPv4/IPv6 blocklist, encoded-IP parsing), browser-level request
interception (fail-closed, blocks redirects/subresources to private hosts),
target-host IP pinning (anti-rebind for the main host), download/popup deny, and a
hard render timeout. The following MUST land before any public launch:

- durable rate limiting (Vercel KV / edge) + a captcha or token (in-memory limits
  reset on serverless scale-out);
- full cross-host subresource IP pinning (the main host is pinned; subresource
  hosts are guarded per-request but not pinned);
- IPv6 rendering support (currently IPv6 is blocked, IPv4-only render);
- COGS controls (a render pool / budget) once traffic is real.
