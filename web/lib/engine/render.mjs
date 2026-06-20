/* ═══════════════════════════════════════════════════════════════════════════
   eyeball — render.mjs : the dependency-free render engine.

   Renders a page in a real headless browser and emits layout/render FACTS as JSON.
   No npm dependency: it resolves a chromium-class browser already on disk and
   drives it over the Chrome DevTools Protocol using Node's built-in WebSocket
   (Node >= 22). It only MEASURES; src/assert.mjs decides pass/fail.

   Why this exists: a string/grep CI gate cannot see a headline pushed past the
   fold, text printed over the headline, a control sitting on the headline, or a
   webfont that silently fell back to Arial. Those are render facts. eyeball puts a
   real browser in your gate without making you install Playwright or Puppeteer.
   ═══════════════════════════════════════════════════════════════════════════ */

import { spawn } from "node:child_process";
import { existsSync, readFileSync, readdirSync, mkdtempSync, rmSync } from "node:fs";
import { tmpdir, homedir, platform } from "node:os";
import { join } from "node:path";
import { pathToFileURL } from "node:url";

export const INSTALL_HINT =
  "eyeball: no chromium-class browser found. Install one of: " +
  "`npx playwright install chromium`, `npx puppeteer browsers install chrome`, " +
  "Google Chrome in the OS default location, or set $CHROME_PATH. " +
  "eyeball uses a browser already on disk and adds no npm dependency.";

const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

/* ── resolve a chromium-class executable from disk (no download). Order: explicit
   env, the Playwright cache (mac+linux), the Puppeteer cache, then system Chrome.
   First hit wins; returns null if none is present. */
export function findBrowser() {
  const cands = [];
  const env = process.env.CHROME_PATH || process.env.PUPPETEER_EXECUTABLE_PATH;
  if (env) cands.push(env);

  const home = homedir();
  // Walk the known browser caches for executable BASENAMES instead of guessing
  // exact nested layouts (those vary by platform + Playwright/Puppeteer version
  // and a wrong join silently misses a present browser). Newest version dir first.
  const EXE = new Set(["chrome", "chromium", "Chromium", "Google Chrome", "chrome-headless-shell", "headless_shell"]);
  const walkForExe = (dir, depth) => {
    if (depth > 6) return;
    let entries = [];
    try { entries = readdirSync(dir, { withFileTypes: true }); } catch { return; }
    entries.sort((a, b) => (a.name < b.name ? 1 : -1));   // higher version numbers first
    for (const e of entries) {
      const p = join(dir, e.name);
      if (e.isDirectory()) walkForExe(p, depth + 1);
      else if (EXE.has(e.name)) cands.push(p);
    }
  };
  const caches = [
    join(home, "Library/Caches/ms-playwright"),           // macOS Playwright
    join(home, ".cache/ms-playwright"),                    // Linux Playwright
    process.env.PLAYWRIGHT_BROWSERS_PATH || "",
    join(home, ".cache/puppeteer"),                        // Puppeteer
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

function noBrowserError() {
  const e = new Error(INSTALL_HINT);
  e.code = "NO_BROWSER";
  return e;
}

function launch(browser, extraArgs = [], pipe = false, env = undefined) {
  const udd = mkdtempSync(join(tmpdir(), "eyeball-"));
  const isShell = /headless[-_]shell/.test(browser);
  const args = [
    `--user-data-dir=${udd}`,
    "--no-first-run", "--no-default-browser-check", "--disable-extensions",
    "--disable-gpu", "--hide-scrollbars", "--mute-audio",
    "--disable-background-networking", "--disable-sync", "--no-sandbox",
    ...extraArgs,                                          // e.g. serverless chromium flags
  ];
  // CDP transport: a debugging PIPE (fd 3/4) works under serverless single-process
  // chromium, where the debugging PORT never binds (DevToolsActivePort never gets
  // written -> hang). The port is the zero-config local default. (scar: @sparticuz
  // on Lambda needs --single-process, which is incompatible with the port.)
  args.push(pipe ? "--remote-debugging-pipe" : "--remote-debugging-port=0");
  // don't double-add headless if the binary is a headless shell or the caller's
  // extraArgs already set a headless mode (serverless chromium passes its own).
  const hasHeadless = isShell || extraArgs.some((a) => String(a).startsWith("--headless"));
  if (!hasHeadless) args.push("--headless=new");
  const stdio = pipe ? ["ignore", "ignore", "pipe", "pipe", "pipe"] : ["ignore", "pipe", "pipe"];
  const child = spawn(browser, args, env ? { stdio, env } : { stdio });
  child.on("error", () => {});
  return { child, udd };
}

async function wsEndpoint(udd, timeoutMs = 12000) {
  const portFile = join(udd, "DevToolsActivePort");
  const deadline = Date.now() + timeoutMs;
  while (Date.now() < deadline) {
    if (existsSync(portFile)) {
      const raw = readFileSync(portFile, "utf8").split("\n");
      const port = (raw[0] || "").trim();
      const path = (raw[1] || "").trim();
      if (port && path) return `ws://127.0.0.1:${port}${path}`;
    }
    await sleep(80);
  }
  throw new Error("eyeball: browser did not expose a CDP endpoint (DevToolsActivePort)");
}

/* ── CDP transports. WsTransport drives the debugging PORT (local default);
   PipeTransport drives fd 3 (write) / fd 4 (read) with NUL-delimited JSON, which is
   what serverless single-process chromium supports. CDP is transport-agnostic. */
class WsTransport {
  constructor(ws) {
    this.ws = ws; this.onmessage = null; this.onclose = null;
    ws.addEventListener("message", (e) => this.onmessage && this.onmessage(e.data));
    ws.addEventListener("close", () => this.onclose && this.onclose());
    ws.addEventListener("error", () => this.onclose && this.onclose());
  }
  send(str) { this.ws.send(str); }
  close() { try { this.ws.close(); } catch { /* already closed */ } }
}

class PipeTransport {
  constructor(writable, readable) {
    this.writable = writable; this.onmessage = null; this.onclose = null;
    let buf = "";
    readable.on("data", (chunk) => {
      buf += chunk.toString("utf8");
      let i;
      while ((i = buf.indexOf("\0")) !== -1) {
        const msg = buf.slice(0, i); buf = buf.slice(i + 1);
        if (this.onmessage) this.onmessage(msg);
      }
    });
    readable.on("close", () => this.onclose && this.onclose());
    readable.on("error", () => this.onclose && this.onclose());
  }
  send(str) { this.writable.write(str + "\0"); }
  close() { try { this.writable.end(); } catch { /* already closed */ } }
}

class CDP {
  constructor(transport) {
    this.t = transport; this.id = 0; this.pending = new Map(); this.handlers = []; this.closed = false;
    // if the browser dies or the transport drops, reject every in-flight command so
    // the gate FAILS CLOSED instead of hanging CI forever (no silent deadlock).
    transport.onclose = () => {
      this.closed = true;
      for (const { reject } of this.pending.values()) reject(new Error("eyeball: CDP connection closed (browser exited?)"));
      this.pending.clear();
    };
    transport.onmessage = (data) => {
      let m; try { m = JSON.parse(data); } catch { return; }
      if (m.id && this.pending.has(m.id)) {
        const { resolve: res, reject: rej } = this.pending.get(m.id);
        this.pending.delete(m.id);
        m.error ? rej(new Error(m.error.message)) : res(m.result);
      } else if (m.method) {
        for (const h of this.handlers) h(m);
      }
    };
  }
  send(method, params = {}, sessionId) {
    if (this.closed) return Promise.reject(new Error("eyeball: CDP connection is closed"));
    const id = ++this.id;
    const msg = { id, method, params };
    if (sessionId) msg.sessionId = sessionId;
    return new Promise((res, rej) => {
      const timer = setTimeout(() => {
        if (this.pending.has(id)) { this.pending.delete(id); rej(new Error(`eyeball: CDP command timed out: ${method}`)); }
      }, 30000);
      this.pending.set(id, {
        resolve: (v) => { clearTimeout(timer); res(v); },
        reject: (e) => { clearTimeout(timer); rej(e); },
      });
      try { this.t.send(JSON.stringify(msg)); }
      catch (e) { clearTimeout(timer); this.pending.delete(id); rej(e); }
    });
  }
  on(fn) { this.handlers.push(fn); }
}

function connect(url) {
  return new Promise((res, rej) => {
    const ws = new WebSocket(url);
    ws.addEventListener("open", () => res(ws));
    ws.addEventListener("error", (e) => rej(new Error("eyeball: CDP WebSocket failed: " + (e.message || "error"))));
  });
}

/* in-page measurement; the selector contract + requested globals are injected. */
export function measureExpr(selectors, requireGlobals) {
  return `(() => {
    const SEL = ${JSON.stringify(selectors)};
    const GLOBALS = ${JSON.stringify(requireGlobals || [])};
    const q = (s) => document.querySelector(s);
    const pick = (list) => { for (const s of (list || [])) { const el = q(s); if (el) return { el, selector: s }; } return { el: null, selector: null }; };
    const rectOf = (el) => { const r = el.getBoundingClientRect(); return { x: r.x, y: r.y, width: r.width, height: r.height, top: r.top, right: r.right, bottom: r.bottom, left: r.left }; };
    const isBg = (el) => { if (!el) return false; const cs = getComputedStyle(el); const z = parseInt(cs.zIndex) || 0; const r = el.getBoundingClientRect(); const ariaHidden = el.getAttribute('aria-hidden') === 'true'; const full = r.width >= innerWidth * 0.9 && r.height >= innerHeight * 0.9; return ariaHidden && (cs.position === 'fixed' || cs.position === 'absolute') && z <= 0 && full; };
    const hero = pick(SEL.hero), reveal = pick(SEL.reveal), sig = pick(SEL.signature), drag = pick(SEL.draggable);
    const globals = {}; for (const g of GLOBALS) globals[g] = typeof window[g] !== 'undefined';
    return {
      globals: globals,
      hero: hero.el ? { found: true, selector: hero.selector, opacity: parseFloat(getComputedStyle(hero.el).opacity), rect: rectOf(hero.el) } : { found: false },
      reveal: reveal.el ? { found: true, selector: reveal.selector, rect: rectOf(reveal.el) } : { found: false },
      signature: sig.el ? { found: true, selector: sig.selector, isBackground: isBg(sig.el), rect: rectOf(sig.el) } : { found: false },
      draggable: drag.el ? { found: true, selector: drag.selector, rect: rectOf(drag.el) } : { found: false },
      innerWidth: innerWidth, innerHeight: innerHeight, scrollWidth: document.documentElement.scrollWidth,
    };
  })()`;
}

export const SCROLL_FIRE_EXPR = `(async () => {
  const h = document.documentElement.scrollHeight || 0;
  for (const f of [0.2, 0.4, 0.6, 0.8, 1]) { window.scrollTo(0, h * f); await new Promise(r => setTimeout(r, 120)); }
  window.scrollTo(0, 0); await new Promise(r => setTimeout(r, 200));
})()`;

async function heroFont(S, hero) {
  if (!hero || !hero.found || !hero.selector) return null;
  try {
    const doc = await S("DOM.getDocument", { depth: 0 });
    const { nodeId } = await S("DOM.querySelector", { nodeId: doc.root.nodeId, selector: hero.selector });
    if (!nodeId) return null;
    const pf = await S("CSS.getPlatformFontsForNode", { nodeId });
    const fonts = (pf.fonts || []).slice().sort((a, b) => (b.glyphCount || 0) - (a.glyphCount || 0));
    return fonts.length ? fonts[0].familyName : null;
  } catch { return null; }
}

/* ── render a target at every configured viewport; return { viewports: [facts] }.
   Throws (fail-closed) on no browser, nav timeout, or a measure-script error. */
export async function render(target, config) {
  const viewportsCfg = (config && config.viewports) || [{ name: "desktop", w: 1440, h: 900 }];
  const selectors = (config && config.selectors) || {};
  const requireGlobals = (config && config.checks && config.checks.requireGlobals) || [];
  const settle = (config && config.settleMs) != null ? config.settleMs : 2000;
  const scrollFire = !config || config.scrollFire !== false;
  // SSRF defense (web app): an async (host) => boolean that, when provided, makes
  // the engine intercept EVERY browser request (initial/redirect/subresource/
  // iframe/fetch/ws) and abort any whose host is blocked. Unset = CLI default.
  const blockHost = config && config.blockHost;

  // cdpEndpoint: connect to a browser someone else launched (e.g. the web app
  // launches @sparticuz chromium via puppeteer-core, which sets up its shared libs
  // + env correctly, then hands us its CDP ws). Otherwise launch one ourselves.
  const cdpEndpoint = config && config.cdpEndpoint;
  const pipe = !cdpEndpoint && !!(config && (config.pipe || ((config.browserArgs || []).includes("--remote-debugging-pipe"))));
  let child = null, udd = null, stderrTail = "";
  if (!cdpEndpoint) {
    const browser = (config && config.browserPath) || findBrowser();
    if (!browser) throw noBrowserError();
    ({ child, udd } = launch(browser, (config && config.browserArgs) || [], pipe, config && config.browserEnv));
    // capture chromium's stderr so a launch crash surfaces its reason. stdio[2].
    const errStream = child.stdio && child.stdio[2];
    if (errStream && errStream.on) errStream.on("data", (d) => { stderrTail = (stderrTail + d.toString()).slice(-1500); });
  }
  let transport;
  try {
    transport = cdpEndpoint
      ? new WsTransport(await connect(cdpEndpoint))
      : pipe
        ? new PipeTransport(child.stdio[3], child.stdio[4])
        : new WsTransport(await connect(await wsEndpoint(udd)));
    const cdp = new CDP(transport);
    const { targetId } = await cdp.send("Target.createTarget", { url: "about:blank" });
    const { sessionId } = await cdp.send("Target.attachToTarget", { targetId, flatten: true });
    const S = (m, p) => cdp.send(m, p, sessionId);
    await S("Page.enable"); await S("Runtime.enable"); await S("Log.enable");
    await S("DOM.enable"); await S("CSS.enable");
    if (blockHost) {
      await S("Fetch.enable", { patterns: [{ urlPattern: "*" }] });
      await S("Page.setDownloadBehavior", { behavior: "deny" }).catch(() => {});
    }

    let consoleErrors = [];
    let loadResolver = null;
    cdp.on((m) => {
      if (m.sessionId !== sessionId) return;
      if (m.method === "Page.loadEventFired" && loadResolver) { loadResolver("load"); loadResolver = null; }
      if (m.method === "Runtime.exceptionThrown") {
        const d = m.params.exceptionDetails || {};
        consoleErrors.push("exception: " + ((d.exception && d.exception.description) || d.text || "unknown"));
      }
      if (m.method === "Runtime.consoleAPICalled" && m.params.type === "error") {
        consoleErrors.push("console.error: " + (m.params.args || []).map((a) => a.value || a.description || "").join(" ").slice(0, 200));
      }
      if (m.method === "Log.entryAdded" && m.params.entry.level === "error") {
        consoleErrors.push("log: " + (m.params.entry.text || "").slice(0, 200));
      }
      if (blockHost && m.method === "Fetch.requestPaused") {
        const rid = m.params.requestId;
        (async () => {
          let blocked = true; // FAIL CLOSED: any parse/guard/DNS error blocks the request
          try { blocked = await blockHost(new URL(m.params.request.url).hostname); } catch { blocked = true; }
          try {
            if (blocked) await S("Fetch.failRequest", { requestId: rid, errorReason: "Aborted" });
            else await S("Fetch.continueRequest", { requestId: rid });
          } catch { /* request already gone */ }
        })();
      }
    });

    const url = /^[a-z]+:\/\//i.test(target) ? target : pathToFileURL(target).href;
    const expr = measureExpr(selectors, requireGlobals);
    const viewports = [];
    for (const vp of viewportsCfg) {
      await S("Emulation.setDeviceMetricsOverride", { width: vp.w, height: vp.h, deviceScaleFactor: 1, mobile: !!vp.mobile });
      consoleErrors = [];
      const loaded = new Promise((r) => { loadResolver = r; });
      const navRes = await S("Page.navigate", { url });
      if (navRes && navRes.errorText) throw new Error(`eyeball: navigation failed (${vp.name}): ${navRes.errorText} for ${url}`);
      const nav = await Promise.race([loaded, sleep(15000).then(() => "timeout")]);
      if (nav === "timeout") throw new Error(`eyeball: navigation timed out (${vp.name}) for ${url}`);
      await sleep(settle);
      if (scrollFire) { try { await S("Runtime.evaluate", { expression: SCROLL_FIRE_EXPR, awaitPromise: true }); } catch {} }
      const ev = await S("Runtime.evaluate", { expression: expr, returnByValue: true, awaitPromise: true });
      if (ev.exceptionDetails) {
        const d = ev.exceptionDetails;
        throw new Error("eyeball: measure script threw: " + ((d.exception && d.exception.description) || d.text || "unknown"));
      }
      const facts = ev.result && ev.result.value;
      if (!facts || typeof facts !== "object") throw new Error(`eyeball: measure returned no facts (${vp.name})`);
      facts.renderedFont = await heroFont(S, facts.hero);
      facts.consoleErrors = consoleErrors.slice();
      facts.viewport = { name: vp.name || `${vp.w}x${vp.h}`, w: vp.w, h: vp.h, mobile: !!vp.mobile };
      viewports.push(facts);
    }
    return { viewports };
  } catch (e) {
    if (stderrTail) e.message += " | chromium: " + stderrTail.replace(/\s+/g, " ").trim().slice(-500);
    throw e;
  } finally {
    try { if (transport) transport.close(); } catch {}
    try { if (child) child.kill("SIGKILL"); } catch {}
    try { if (udd) rmSync(udd, { recursive: true, force: true }); } catch {}
  }
}

export function doctor() {
  const browser = findBrowser();
  if (!browser) { process.stdout.write("DOCTOR FAIL: " + INSTALL_HINT + "\n"); return 3; }
  if (typeof WebSocket !== "function") { process.stdout.write("DOCTOR FAIL: Node built-in WebSocket missing (need Node >= 22)\n"); return 4; }
  process.stdout.write("OK " + browser + "\n");
  return 0;
}
