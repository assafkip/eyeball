/* ═══════════════════════════════════════════════════════════════════════════
   eyeball — assert.mjs : the pure, config-driven render assertions.

   Given the FACTS from render.mjs + the config, return a list of violations.
   Pure (no I/O), so the self-test exercises it directly. The engine measures; this
   decides. It FAILS CLOSED: missing or wrong-count viewports is a violation, never
   a silent green.
   ═══════════════════════════════════════════════════════════════════════════ */

/* a hero that RENDERS in one of these means the brand webfont failed and degraded
   to a banned system face. Real serif/sans fallbacks (Georgia, Times) are fine. */
const DEFAULT_BANNED_FONTS = ["arial", "helvetica", "segoe ui", "liberation sans", "system"];

function boxesOverlap(a, b, shrink = 2) {
  return !(
    a.right - shrink <= b.left || a.left + shrink >= b.right ||
    a.bottom - shrink <= b.top || a.top + shrink >= b.bottom
  );
}
function pointInBox(x, y, b) { return b.left <= x && x <= b.right && b.top <= y && y <= b.bottom; }

function fontBanned(font, banned) {
  if (!font) return false;
  const f = font.toLowerCase();
  return banned.some((b) => f.includes(String(b).toLowerCase()) || (b === "system" && (f.startsWith(".") || f.includes("-apple-system"))));
}

/**
 * @param {{viewports: object[]}} data  facts from render()
 * @param {object} config               the eyeball config (viewports + checks)
 * @returns {string[]} violations (empty = pass)
 */
export function assertRender(data, config) {
  const checks = (config && config.checks) || {};
  const expected = ((config && config.viewports) || []).length || 1;
  const vps = (data && data.viewports) || [];
  const fails = [];

  // fail closed: a broken render must not read as green.
  if (vps.length !== expected) {
    fails.push(`render produced ${vps.length} viewport(s), expected ${expected} (broken render, failing closed)`);
    return fails;
  }

  for (const f of vps) {
    const vp = f.viewport || {};
    const tag = vp.name || "?";
    const vw = vp.w || 0, vh = vp.h || 0;

    if (checks.noConsoleErrors) {
      for (const err of (f.consoleErrors || []).slice(0, 5)) fails.push(`[${tag}] console error: ${err}`);
    }
    for (const g of (checks.requireGlobals || [])) {
      if (!(f.globals && f.globals[g])) fails.push(`[${tag}] required global not present at runtime: window.${g}`);
    }

    const hero = f.hero;
    if (!hero || !hero.found) { fails.push(`[${tag}] no hero element matched (selectors: ${JSON.stringify((config.selectors||{}).hero||[])})`); continue; }
    const hr = hero.rect;

    if (checks.heroMinOpacity != null && hero.opacity < checks.heroMinOpacity) {
      fails.push(`[${tag}] hero opacity ${hero.opacity} < ${checks.heroMinOpacity} (hidden hero)`);
    }
    if (checks.heroInViewport) {
      const tol = 2;
      if (hr.bottom > vh + tol || hr.top < -tol || hr.right > vw + tol || hr.left < -tol) {
        fails.push(`[${tag}] hero not fully inside the first viewport (box ${Math.round(hr.left)},${Math.round(hr.top)} -> ${Math.round(hr.right)},${Math.round(hr.bottom)} vs ${vw}x${vh})`);
      }
    }
    if (checks.heroFontNotBanned) {
      const banned = Array.isArray(checks.heroFontNotBanned) ? checks.heroFontNotBanned : DEFAULT_BANNED_FONTS;
      if (fontBanned(f.renderedFont, banned)) fails.push(`[${tag}] hero renders in a banned face '${f.renderedFont}' (webfont missed -> system fallback)`);
    }
    if (checks.noRevealOverHero && f.reveal && f.reveal.found) {
      const r = f.reveal.rect;
      if (r.width > 1 && r.height > 1 && boxesOverlap(r, hr)) fails.push(`[${tag}] reveal element pinned over the hero (text-on-text)`);
    }
    if (checks.noSignatureOverHero && f.signature && f.signature.found && !f.signature.isBackground) {
      if (boxesOverlap(f.signature.rect, hr)) fails.push(`[${tag}] foreground signature overlaps the hero`);
    }
    if (checks.noDraggableOnHero && f.draggable && f.draggable.found) {
      const r = f.draggable.rect;
      const cx = (r.left + r.right) / 2, cy = (r.top + r.bottom) / 2;
      if (pointInBox(cx, cy, hr)) fails.push(`[${tag}] draggable centroid inside the hero box`);
    }
    if (checks.noXOverflow && f.scrollWidth > vw + 2) {
      fails.push(`[${tag}] horizontal overflow (scrollWidth ${f.scrollWidth} > ${vw})`);
    }
  }
  return fails;
}

export const _internal = { boxesOverlap, pointInBox, fontBanned, DEFAULT_BANNED_FONTS };
