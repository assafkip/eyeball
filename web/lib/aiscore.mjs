/* ═══════════════════════════════════════════════════════════════════════════
   eyeball-web — lib/aiscore.mjs : the FREE deterministic AI-design scan.

   Runs in two halves:
   - DESIGN_SIGNALS_EXPR is evaluated INSIDE the rendered page (no network, no
     model) and returns cheap visual tells (converged fonts, gradient text, emoji
     icons, repeated cards, stock-prompt copy, "powered by AI" badge).
   - scoreFromSignals() turns those into the same report shape the vision module
     emits, so the frontend renders both identically. mode: "scan".

   This path costs nothing and is also the KILL_SWITCH / over-budget fallback, so
   the tool always returns something even when the paid vision call is off.
   ═══════════════════════════════════════════════════════════════════════════ */

// Evaluated in the page context. Returns a small JSON-able signals object.
export const DESIGN_SIGNALS_EXPR = `(() => {
  const lc = (s) => (s || "").toLowerCase();
  const firstFamily = (el) => {
    try { return lc(getComputedStyle(el).fontFamily).split(",")[0].replace(/["']/g, "").trim(); }
    catch { return ""; }
  };
  const BANNED = /^(inter|roboto|space grotesk|geist|plus jakarta|manrope|dm sans|poppins|system-ui|ui-sans-serif|-apple-system|blinkmacsystemfont|segoe ui|helvetica neue|arial)$/;
  const EMOJI = /[\\u2190-\\u21FF\\u2300-\\u27BF\\u2B00-\\u2BFF\\u{1F000}-\\u{1FAFF}\\u{1F300}-\\u{1FAFF}\\u2728\\u26A1\\u{1F680}\\u{1F3AF}]/u;
  const PHRASES = ["seamlessly","leverage","cutting-edge","cutting edge","unlock the","revolutionize","empower","supercharge","game-chang","next-gen","elevate your","powered by ai","ai-powered","harness the power","take your","to the next level","effortless"];

  const h1 = document.querySelector("h1");
  const body = document.body;
  const headings = Array.from(document.querySelectorAll("h1,h2,h3")).slice(0, 12);

  // 1) converged / banned fonts on the headline + body
  const h1Font = h1 ? firstFamily(h1) : "";
  const bodyFont = body ? firstFamily(body) : "";
  const bannedFont = BANNED.test(h1Font) || BANNED.test(bodyFont);

  // 2) gradient text (background-clip:text + gradient) — usually on a <span> inside
  //    the headline, so scan elements broadly, not just the heading nodes.
  let gradientText = false;
  for (const el of Array.from(document.querySelectorAll("h1,h2,h3,h1 *,h2 *,h3 *,span,a,strong,[class*=grad]")).slice(0, 300)) {
    try {
      const cs = getComputedStyle(el);
      const clip = lc(cs.webkitBackgroundClip || cs.backgroundClip);
      const bg = lc(cs.backgroundImage);
      if (!bg.includes("gradient")) continue;
      const fill = lc(cs.webkitTextFillColor || "");
      const transparent = fill.includes("transparent") || fill.includes("rgba(0, 0, 0, 0)") || lc(cs.color).includes("rgba(0, 0, 0, 0)");
      if (clip.includes("text") || transparent) { gradientText = true; break; }
    } catch {}
  }

  // 3) large gradient background block (hero-ish)
  let gradientBg = false;
  for (const el of Array.from(document.querySelectorAll("section,div,header")).slice(0, 60)) {
    try {
      const r = el.getBoundingClientRect();
      if (r.width < 320 || r.height < 220) continue;
      if (lc(getComputedStyle(el).backgroundImage).includes("linear-gradient")) { gradientBg = true; break; }
    } catch {}
  }

  // 4) emoji used as UI/icon inside headings or buttons
  let emojiInUi = false;
  for (const el of Array.from(document.querySelectorAll("h1,h2,h3,button,a,[class*=icon],[class*=badge]")).slice(0, 80)) {
    if (EMOJI.test(el.textContent || "")) { emojiInUi = true; break; }
  }

  // 5) the three-equal-cards section
  let cardTriplet = false;
  for (const parent of Array.from(document.querySelectorAll("section,div,ul")).slice(0, 120)) {
    const kids = Array.from(parent.children);
    if (kids.length < 3 || kids.length > 6) continue;
    const tag = kids[0].tagName;
    if (!kids.every((k) => k.tagName === tag)) continue;
    const ws = kids.map((k) => Math.round(k.getBoundingClientRect().width));
    const hs = kids.map((k) => Math.round(k.getBoundingClientRect().height));
    const eq = (a) => a[0] > 120 && a.every((v) => Math.abs(v - a[0]) <= 8);
    if (eq(ws) && eq(hs)) { cardTriplet = true; break; }
  }

  // 6) stock-prompt copy + "powered by AI" badge
  const text = lc((body && body.innerText) || "").slice(0, 8000);
  const genericCopy = PHRASES.filter((p) => text.includes(p)).slice(0, 6);
  const badge = /powered by ai|ai-powered|\\u2728/i.test((body && body.innerText) || "");

  return { h1Font, bodyFont, bannedFont, gradientText, gradientBg, emojiInUi, cardTriplet, genericCopy, badge };
})()`;

const FONT_LABEL = {
  inter: "Inter", roboto: "Roboto", "space grotesk": "Space Grotesk", geist: "Geist",
  "plus jakarta": "Plus Jakarta Sans", manrope: "Manrope", "dm sans": "DM Sans", poppins: "Poppins",
};
function prettyFont(f) {
  if (!f) return "the system font stack";
  for (const k in FONT_LABEL) if (f.includes(k)) return FONT_LABEL[k];
  if (/system|apple|segoe|helvetica|arial/.test(f)) return "the default system font";
  return f;
}

/** Turn page signals into the shared report shape. mode: "scan". */
export function scoreFromSignals(signals) {
  const s = signals || {};
  const tells = [];

  if (s.bannedFont) {
    tells.push({
      name: "A converged, default font",
      evidence: `The headline / body render in ${prettyFont(s.h1Font || s.bodyFont)} — the face every AI builder reaches for.`,
      fix: "Pick a typeface with a point of view. A real display face on the headline does more for 'a human made this' than anything else.",
    });
  }
  if (s.gradientText) {
    tells.push({
      name: "Gradient text on the headline",
      evidence: "A heading uses a clipped color gradient — the single most-read 'AI made this' flag on the web right now.",
      fix: "Make the headline one solid, confident color. Save any gradient for a small, intentional accent.",
    });
  } else if (s.gradientBg) {
    tells.push({
      name: "A generic gradient backdrop",
      evidence: "A large hero block is filled with a linear gradient, the default 'make it look designed' move.",
      fix: "Replace it with a flat color, real texture, a photo, or a deliberate illustration that says something about you.",
    });
  }
  if (s.cardTriplet) {
    tells.push({
      name: "Three identical feature cards",
      evidence: "A row of equal-sized cards — the layout skeleton every generated page ships with.",
      fix: "Break the symmetry. Different sizes, one hero feature, or a layout that fits your actual story instead of the template's.",
    });
  }
  if (s.emojiInUi) {
    tells.push({
      name: "Emoji standing in for icons",
      evidence: "Emoji (🚀 ⚡ 🎯 and friends) are doing the work of a real icon set.",
      fix: "Use one consistent icon set, or custom marks. Emoji read as a placeholder nobody replaced.",
    });
  }
  if (s.badge) {
    tells.push({
      name: "A 'Powered by AI' badge",
      evidence: "The page announces it's AI-powered, usually with a sparkle. Confident design never has to say this.",
      fix: "Drop it. Let the product speak. Nobody picks a tool because a pill said 'AI'.",
    });
  }
  if (s.genericCopy && s.genericCopy.length >= 2) {
    tells.push({
      name: "Stock-prompt copy",
      evidence: `Phrases like "${s.genericCopy.slice(0, 3).join('", "')}" — the words a prompt writes, not a person.`,
      fix: "Say the specific thing your product does, in plain words a customer would actually use.",
    });
  }

  // weighting: each tell adds; gradient-text + banned font are the heaviest reads
  let score = 0;
  if (s.bannedFont) score += 26;
  if (s.gradientText) score += 30; else if (s.gradientBg) score += 14;
  if (s.cardTriplet) score += 18;
  if (s.emojiInUi) score += 12;
  if (s.badge) score += 14;
  if (s.genericCopy) score += Math.min(18, s.genericCopy.length * 6);
  score = Math.max(0, Math.min(100, score));

  let band, verdict;
  if (score <= 35) { band = "reads human-made"; verdict = "Not many tells. This looks like deliberate choices, not a template."; }
  else if (score <= 70) { band = "somewhat generic"; verdict = "A few clear tells. It's halfway to looking like everyone else's AI site."; }
  else { band = "very AI-looking"; verdict = "This is the look people now read as 'an AI made it.' The fixes below are where to start."; }

  return { aiScore: score, band, verdict, tells, mode: "scan" };
}
