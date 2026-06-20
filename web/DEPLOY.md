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

- **Landing: LIVE** (renders behind the SSO wall; dogfood-verified locally at both viewports).
- **/api/check: BLOCKED by an external @sparticuz/Vercel runtime issue.** Chromium
  exits at launch with `libnss3.so: cannot open shared object file`. This is NOT the
  eyeball code: the canonical `puppeteer-core` launch fails identically, and the
  same handler renders correctly LOCALLY (score 72 on example.com). It is the
  well-known "@sparticuz libnss3 missing on the Vercel Node 22.x+ runtime" issue
  (Vercel community: "Libnss3.so missing in Node 22.x"). Tried + ruled out: raw-spawn
  + pipe transport, puppeteer-core, `LD_LIBRARY_PATH=/tmp`, pinning `engines` to
  Node 20.x.
- **Fix path (next, ~1-2 cycles):** set the Vercel PROJECT Node version explicitly
  to 20.x (the dashboard setting, not just `engines`), OR move to
  `@sparticuz/chromium-min` + a hosted brotli pack matched to the runtime, OR a
  separate always-on render service / a hosted browser API (Browserless). The MVP
  works end-to-end locally; only the serverless chromium runtime needs this dialed in.

## SECURITY: pre-public-launch gate (REQUIRED before advertising this URL)

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
