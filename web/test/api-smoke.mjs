/* ═══════════════════════════════════════════════════════════════════════════
   eyeball-web — test/api-smoke.mjs : verify the render API's parts without a
   network or @sparticuz. Three layers:
     1) the SSRF guard over a host table (public passes; loopback/private/
        link-local/metadata/encoded-IP/rebind-to-private blocked),
     2) the pure report builder on canned facts/violations,
     3) the engine rendering a known-bad fixture -> a real report defect.
   ═══════════════════════════════════════════════════════════════════════════ */

import assert from "node:assert/strict";
import { join, dirname } from "node:path";
import { fileURLToPath } from "node:url";
import { assertPublicUrl } from "../lib/guard.mjs";
import { buildReport } from "../lib/report.mjs";
import { rateLimit, acquireSlot, releaseSlot, _reset } from "../lib/ratelimit.mjs";
import { render } from "../lib/engine/render.mjs";   // vendored copy (web/ self-contained)
import { assertRender } from "../lib/engine/assert.mjs";

const HERE = dirname(fileURLToPath(import.meta.url));
let n = 0;
const ok = (name, cond) => { n++; assert.ok(cond, name); };

// resolver stub keyed by host. Covers: public IPv4, rebind-to-private,
// IPv6-only (no v4 to pin), public-A + private-AAAA (must block), and dual-stack
// public (must allow).
const DNS = {
  "rebind.test": ["10.0.0.1"],
  "v6only.test": ["2606:4700::1111"],
  "mixed.test": ["93.184.216.34", "fc00::1"],          // public A, private AAAA -> block
  "dual.test": ["93.184.216.34", "2606:2800:220:1:248:1893:25c8:1946"], // both public -> allow
};
const resolve = async (host) => DNS[host] || ["93.184.216.34"];
const blocked = async (u) => { try { await assertPublicUrl(u, resolve); return false; } catch (e) { return e.blocked === true; } };
const allowed = async (u) => { try { await assertPublicUrl(u, resolve); return true; } catch { return false; } };

async function main() {
  // 1) SSRF guard table
  for (const u of [
    "http://127.0.0.1/", "http://10.0.0.1/", "http://192.168.1.1/", "http://172.16.0.1/",
    "http://169.254.169.254/", "http://[::1]/", "http://2130706433/", "http://0x7f.0.0.1/",
    "http://0177.0.0.1/", "ftp://example.com/", "file:///etc/passwd", "http://localhost/",
    "http://rebind.test/", "http://[2606:4700:4700::1111]/", "http://v6only.test/",
    "http://mixed.test/",
  ]) ok("blocks " + u, await blocked(u));

  for (const u of ["http://example.com/", "https://example.com/a/b?q=1", "http://1.1.1.1/", "http://dual.test/"]) {
    ok("allows " + u, await allowed(u));
  }

  // 2) pure report
  const facts = { viewports: [{ viewport: { name: "desktop", w: 1440, h: 900 } }, { viewport: { name: "mobile", w: 390, h: 844 } }] };
  const rep = buildReport(facts, [
    "[desktop] hero not fully inside the first viewport (box 1,2 -> 3,4 vs 1440x900)",
    "[mobile] hero renders in a banned face 'Arial'",
  ]);
  ok("report flags not-ok", rep.ok === false);
  ok("report score below 100", rep.score < 100);
  ok("report keeps both viewports", rep.viewports.length === 2);
  ok("report maps a fold defect with a fix", rep.viewports.some((v) => v.defects.some((d) => d.rule === "headline-past-fold" && d.fix.length > 10)));
  ok("report maps a font defect", rep.viewports.some((v) => v.defects.some((d) => d.rule === "font-fell-back")));
  const clean = buildReport(facts, []);
  ok("clean report is ok with score 100", clean.ok === true && clean.score === 100);

  // 3) the engine renders a known-bad fixture into a real defect
  const cfg = {
    viewports: [{ name: "desktop", w: 1440, h: 900 }],
    selectors: { hero: ["[data-hero-h1]", "h1"], reveal: ["[data-reveal]", ".truth"], signature: ["[data-signature]"], draggable: ["[data-draggable]"] },
    checks: { heroInViewport: true, heroFontNotBanned: ["arial", "helvetica", "system"], noConsoleErrors: true },
    settleMs: 600, scrollFire: false,
  };
  const data = await render(join(HERE, "../../test/fixtures/bad-fold.html"), cfg);
  const report = buildReport(data, assertRender(data, cfg));
  ok("engine render -> report flags the seeded fold defect", report.viewports.some((v) => v.defects.some((d) => d.rule === "headline-past-fold")));

  // 4) abuse limiter: allows up to max, then blocks; concurrency slots release.
  _reset();
  const t0 = 1_000_000;
  for (let i = 0; i < 3; i++) ok(`ratelimit allows hit ${i + 1}/3`, rateLimit("ip1", 3, 60_000, t0 + i).ok === true);
  ok("ratelimit blocks the 4th", rateLimit("ip1", 3, 60_000, t0 + 3).ok === false);
  ok("ratelimit isolates other keys", rateLimit("ip2", 3, 60_000, t0 + 3).ok === true);
  ok("ratelimit window slides", rateLimit("ip1", 3, 60_000, t0 + 60_001).ok === true);
  ok("concurrency: 2 slots then full", acquireSlot(2) && acquireSlot(2) && acquireSlot(2) === false);
  releaseSlot(); ok("concurrency: a release frees a slot", acquireSlot(2) === true);
  releaseSlot(); releaseSlot();

  console.log(`api-smoke: ${n} checks passed`);
}

main().catch((e) => { console.error("api-smoke FAILED:", e && e.message ? e.message : e); process.exit(1); });
