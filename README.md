# eyeball

Put a real browser in your CI gate. Zero npm dependencies.

A string/grep check on your built HTML cannot see a headline pushed past the fold,
a reveal printed over the headline, a control sitting on the headline, or a webfont
that silently fell back to Arial. Those are **render** facts. `eyeball` opens the
page in a real headless browser, measures them, and fails your build when the page
renders wrong, not just when the strings are wrong.

> Green should mean it renders right, not that the strings are right.

## Why it has no dependencies

`eyeball` does not install Playwright or Puppeteer. It uses a chromium-class
browser **already on disk** (a Playwright/Puppeteer cache, system Chrome, or
`$CHROME_PATH`) and drives it over the Chrome DevTools Protocol using Node's
**built-in `WebSocket`**. That means `requires: Node >= 22` and one browser
somewhere on the machine, nothing in `node_modules`.

```bash
node src/cli.mjs --doctor      # OK <browser path>, or the one-line install hint
```

If no browser is found it prints how to get one and **exits non-zero** (it fails
closed, never a silent pass).

## Usage

```bash
# render a built file (or a URL) and assert it
node src/cli.mjs ./dist/index.html --config eyeball.config.json
node src/cli.mjs https://staging.example.com --config eyeball.config.json

# from this repo, with the bin wired:
npx . ./dist/index.html --config eyeball.config.json
```

Exit codes: `0` pass · `1` a render assertion failed (or a render error, fail
closed) · `2` usage error, bad config, or a broken `--selftest` · `3` no browser
found. Note the modes differ: in a normal run a missing browser exits `3`; inside
`--selftest` an unavailable engine/fixture is treated as broken and exits `2`.

## What it checks

Per viewport, configurable in `eyeball.config.json` (see
`eyeball.config.example.json`):

- **heroInViewport** — the headline is fully inside the first screen (catches the
  too-tall / past-the-fold headline).
- **noRevealOverHero** — no reveal element is pinned over the headline (catches
  text-on-text; the box test fires even while the reveal is still transparent,
  because it will collide the instant it shows).
- **noDraggableOnHero** — a draggable control's centroid is not on the headline.
- **noSignatureOverHero** — a foreground signature element does not cover the
  headline (a full-bleed, `aria-hidden`, z-behind background is exempt).
- **heroFontNotBanned** — the headline's **actually rendered** glyph face (read via
  CDP platform-fonts) is not Arial/Helvetica/system, so a webfont that fails at
  runtime is caught even though the source looks fine.
- **noConsoleErrors**, **requireGlobals**, **noXOverflow**, **heroMinOpacity**.

## The markup contract

`eyeball` finds elements by configurable selectors, preferring stable data
attributes and falling back to sensible defaults:

| role | default selectors |
|------|-------------------|
| `hero` | `[data-hero-h1]`, `h1` |
| `reveal` | `[data-reveal]`, `.truth` |
| `signature` | `[data-signature]` |
| `draggable` | `[data-draggable]` |

Tag those in your markup for stable, intentional measurement.

## Self-test

The gate is itself gated. `npm test` (or `eyeball --selftest`) renders the
committed fixtures and proves `eyeball` goes **red** on each defect class (fold,
overlap, draggable-on-hero, Arial) and **green** on the clean page. If the engine
is unavailable or any fixture misbehaves it exits `2` (broken), so a green
self-test is never a rubber stamp.

```bash
npm test
```

## Provenance

`eyeball` was extracted from the KTLYST store-site gate, where a string-only check
once passed five visibly broken sites green. The lesson, "a checker that encodes a
subset of the standard makes green a lie," is the reason it exists. The render
engine and assertions here are the general, project-agnostic core; project-specific
policy (brand fonts, copy rules, domain mapping) stays in your own config and
wrapper.

## License

MIT. See `LICENSE`.
