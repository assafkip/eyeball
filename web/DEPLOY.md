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

## Deploy (Vercel preview)

Because `api/check.mjs` imports the engine from `../../src`, the deploy roots at
the eyeball REPO (not `web/`) so the engine is bundled. A root `vercel.json` points
the build at `web/` and registers the function. Deploy to a PREVIEW (never prod):

```
cd ~/projects/eyeball
vercel deploy            # preview; scope/login as needed
```

PREVIEW URL: (filled in after the preview deploy)
Deployed /api/check sample: (filled in: a report JSON for a sample URL)
Landing console errors: 0 (dogfood-verified locally; re-confirm on the preview)

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
