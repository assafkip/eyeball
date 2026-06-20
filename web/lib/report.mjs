/* ═══════════════════════════════════════════════════════════════════════════
   eyeball-web — lib/report.mjs : turn engine facts + assertion violations into a
   human render-health report. PURE + deterministic (unit-tested with canned input,
   no browser). Each defect gets a plain-language fix.
   ═══════════════════════════════════════════════════════════════════════════ */

// substring of the violation detail -> { rule, weight, fix }
const RULES = [
  ["not fully inside the first viewport", { rule: "headline-past-fold", weight: 20,
    fix: "Your headline runs past the first screen. Cap its width or font-size so it fits above the fold." }],
  ["pinned over the hero", { rule: "text-on-text", weight: 20,
    fix: "A text element is pinned on top of your headline. Stop positioning them to the same spot." }],
  ["draggable centroid inside the hero", { rule: "control-on-headline", weight: 18,
    fix: "An interactive control overlaps the headline. Move it off the headline's box." }],
  ["foreground signature overlaps the hero", { rule: "element-on-headline", weight: 16,
    fix: "A foreground element covers the headline. Give it its own space or send it behind." }],
  ["banned face", { rule: "font-fell-back", weight: 14,
    fix: "Your headline font did not load and fell back to a system face (Arial/Helvetica). Self-host the font or set a real fallback." }],
  ["console error", { rule: "console-error", weight: 12,
    fix: "The page throws a JavaScript error at load. Open the console and fix the first one." }],
  ["horizontal overflow", { rule: "x-overflow", weight: 12,
    fix: "The page scrolls sideways. Find the element wider than the viewport (often an image or a fixed width)." }],
  ["required global not present", { rule: "library-missing", weight: 12,
    fix: "An expected library did not load at runtime. Check the script URL/CDN." }],
  ["opacity", { rule: "hidden-headline", weight: 20,
    fix: "Your headline is (near) invisible at load. A reveal animation probably left it hidden." }],
  ["no hero element matched", { rule: "no-headline-found", weight: 10,
    fix: "No headline was found to check. Tag your main headline with data-hero-h1 (or use an <h1>)." }],
];

function classify(detail) {
  for (const [needle, info] of RULES) if (detail.includes(needle)) return info;
  return { rule: "other", weight: 8, fix: "Review this rendered difference." };
}

/**
 * @param {{viewports: object[]}} facts   from the engine
 * @param {string[]} violations           from assertRender
 * @returns {{ok:boolean, score:number, viewports:object[], summary:string, defectCount:number}}
 */
export function buildReport(facts, violations) {
  const names = ((facts && facts.viewports) || []).map((f) => (f.viewport && f.viewport.name) || "page");
  const byVp = new Map(names.map((n) => [n, []]));

  let penalty = 0;
  for (const v of violations || []) {
    const m = /^\[([^\]]+)\]\s*(.*)$/.exec(v);
    const vp = m ? m[1] : (names[0] || "page");
    const detail = m ? m[2] : v;
    const info = classify(detail);
    penalty += info.weight;
    if (!byVp.has(vp)) byVp.set(vp, []);
    byVp.get(vp).push({ rule: info.rule, detail, fix: info.fix });
  }

  const viewports = [...byVp.entries()].map(([name, defects]) => ({ name, defects }));
  const defectCount = (violations || []).length;
  const ok = defectCount === 0;
  const score = Math.max(0, 100 - penalty);
  const summary = ok
    ? "Clean. The page renders right at every viewport checked."
    : `${defectCount} render issue${defectCount === 1 ? "" : "s"} a string test would not catch.`;
  return { ok, score, viewports, summary, defectCount };
}
