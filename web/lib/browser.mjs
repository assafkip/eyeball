/* eyeball-web — lib/browser.mjs : resolve a chromium-class browser already on
   disk (local dev / the gate CLI). Serverless uses @sparticuz instead. This is
   all the web app still needs from the old vendored engine. No download. */

import { existsSync, readdirSync } from "node:fs";
import { homedir, platform } from "node:os";
import { join } from "node:path";

export const INSTALL_HINT =
  "eyeball: no chromium-class browser found. Install one of: " +
  "`npx playwright install chromium`, `npx puppeteer browsers install chrome`, " +
  "Google Chrome in the OS default location, or set $CHROME_PATH.";

/* Order: explicit env, the Playwright cache, the Puppeteer cache, then system Chrome.
   Walks caches for executable BASENAMES (layouts vary by platform + version). */
export function findBrowser() {
  const cands = [];
  const env = process.env.CHROME_PATH || process.env.PUPPETEER_EXECUTABLE_PATH;
  if (env) cands.push(env);

  const home = homedir();
  const EXE = new Set(["chrome", "chromium", "Chromium", "Google Chrome", "chrome-headless-shell", "headless_shell"]);
  const walkForExe = (dir, depth) => {
    if (depth > 6) return;
    let entries = [];
    try { entries = readdirSync(dir, { withFileTypes: true }); } catch { return; }
    entries.sort((a, b) => (a.name < b.name ? 1 : -1));   // higher version dirs first
    for (const e of entries) {
      const p = join(dir, e.name);
      if (e.isDirectory()) walkForExe(p, depth + 1);
      else if (EXE.has(e.name)) cands.push(p);
    }
  };
  const caches = [
    join(home, "Library/Caches/ms-playwright"),
    join(home, ".cache/ms-playwright"),
    process.env.PLAYWRIGHT_BROWSERS_PATH || "",
    join(home, ".cache/puppeteer"),
    process.env.PUPPETEER_CACHE_DIR || "",
  ].filter(Boolean);
  for (const c of caches) if (existsSync(c)) walkForExe(c, 0);

  if (platform() === "darwin") {
    cands.push("/Applications/Google Chrome.app/Contents/MacOS/Google Chrome");
    cands.push("/Applications/Chromium.app/Contents/MacOS/Chromium");
  } else if (platform() === "win32") {
    cands.push("C:/Program Files/Google/Chrome/Application/chrome.exe");
    cands.push("C:/Program Files (x86)/Google/Chrome/Application/chrome.exe");
  } else {
    cands.push("/usr/bin/google-chrome", "/usr/bin/google-chrome-stable",
      "/usr/bin/chromium", "/usr/bin/chromium-browser", "/snap/bin/chromium");
  }
  return cands.find((p) => { try { return existsSync(p); } catch { return false; } }) || null;
}
