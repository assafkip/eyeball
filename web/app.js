/* eyeball — submit a URL, render the AI-design report. No framework. XSS-safe (textContent only). */
(function () {
  "use strict";
  var form = document.getElementById("check-form");
  var input = document.getElementById("url");
  var go = document.getElementById("go");
  var result = document.getElementById("result");
  var quota = document.getElementById("quota");
  if (!form || !input || !result) return; // never throw on load

  function el(tag, cls, text) {
    var n = document.createElement(tag);
    if (cls) n.className = cls;
    if (text != null) n.textContent = text;   // textContent: never innerHTML with model/page output
    return n;
  }
  function setBusy(on) { go.disabled = on; go.textContent = on ? "Looking…" : "Score it"; }

  // 0 AI-score = human-crafted (good). 100 = peak slop (bad).
  function scoreClass(s) { return s <= 35 ? "score-good" : s <= 70 ? "score-warn" : "score-bad"; }

  function showQuota(left) {
    if (!quota || left == null) return;
    quota.textContent = left > 0
      ? left + " free check" + (left === 1 ? "" : "s") + " left. "
      : "Free checks used up. ";
  }

  function render(report) {
    result.hidden = false;
    result.innerHTML = "";

    var card = el("div", "verdict");
    var ring = el("div", "score-ring " + scoreClass(report.aiScore));
    ring.appendChild(document.createTextNode(String(report.aiScore)));
    ring.appendChild(el("small", null, "/100 AI"));
    card.appendChild(ring);

    var txt = el("div", "verdict-text");
    txt.appendChild(el("p", "verdict-band", report.band || ""));
    txt.appendChild(el("h3", null, report.verdict || ""));
    txt.appendChild(el("p", null, report.mode === "vision"
      ? "Claude looked at a screenshot of your homepage and judged the design."
      : "Quick scan from the rendered page. The full read adds Claude's eye and per-tell fixes."));
    card.appendChild(txt);
    result.appendChild(card);

    var tells = report.tells || [];
    if (!tells.length) {
      result.appendChild(el("div", "clean-note", "No obvious AI tells. This reads like a human made deliberate choices. Rare. Nice."));
    } else {
      var out = el("div", "tells-out");
      tells.forEach(function (t) {
        var c = el("div", "tell");
        c.appendChild(el("div", "tell-name", t.name || ""));
        if (t.evidence) c.appendChild(el("div", "tell-ev", t.evidence));
        if (t.fix) {
          var fix = el("p", "tell-fix");
          fix.appendChild(el("b", null, "fix "));
          fix.appendChild(document.createTextNode(t.fix));
          c.appendChild(fix);
        }
        out.appendChild(c);
      });
      result.appendChild(out);
    }
    result.appendChild(el("p", "scan-tag", report.mode === "vision" ? "Claude vision read" : "Free quick scan"));
    result.scrollIntoView({ behavior: "smooth", block: "start" });
  }

  function fail(msg) {
    result.hidden = false; result.innerHTML = "";
    var box = el("div", "clean-note"); box.style.color = "#e8443a";
    box.textContent = msg;
    result.appendChild(box);
  }

  // captcha (Cloudflare Turnstile): dormant until the server exposes a site key.
  // Only call the API over http(s); a file:// open would log a console error.
  var siteKey = null, captchaToken = null;
  var served = location.protocol === "http:" || location.protocol === "https:";
  if (served) fetch("/api/config").then(function (r) { return r.json(); }).then(function (cfg) {
    siteKey = cfg && cfg.turnstileSiteKey;
    if (cfg && typeof cfg.freeLeft === "number") showQuota(cfg.freeLeft);
    if (!siteKey) return;
    window.__eyeballTs = function () {
      if (window.turnstile) window.turnstile.render("#captcha", { sitekey: siteKey, callback: function (t) { captchaToken = t; } });
    };
    var s = document.createElement("script");
    s.src = "https://challenges.cloudflare.com/turnstile/v0/api.js?onload=__eyeballTs";
    s.async = true; s.defer = true;
    document.head.appendChild(s);
    var cap = document.getElementById("captcha"); if (cap) cap.hidden = false;
  }).catch(function () { /* config optional */ });

  form.addEventListener("submit", function (e) {
    e.preventDefault();
    var url = (input.value || "").trim();
    if (!url) return;
    if (!/^https?:\/\//i.test(url)) url = "https://" + url;
    if (siteKey && !captchaToken) { fail("Please complete the captcha first."); return; }
    setBusy(true);
    result.hidden = false; result.innerHTML = "";
    result.appendChild(el("p", "looking", "Rendering " + url + " and scoring the design…"));

    var q = "/api/check?url=" + encodeURIComponent(url) + (captchaToken ? "&cf-turnstile-response=" + encodeURIComponent(captchaToken) : "");
    fetch(q)
      .then(function (r) {
        return r.text().then(function (t) {
          var body; try { body = JSON.parse(t); } catch (e) { body = { error: "Unexpected response (HTTP " + r.status + ")." }; }
          return { status: r.status, ok: r.ok, body: body };
        });
      })
      .then(function (res) {
        if (typeof res.body.freeLeft === "number") showQuota(res.body.freeLeft);
        if (res.status === 402) { fail(res.body.error || "You've used your free checks. Paid checks are coming soon."); return; }
        if (res.status === 503) { fail(res.body.error || "We've hit today's limit. Try again tomorrow."); return; }
        if (!res.ok || res.body.error) { fail(res.body.error || "Could not score that URL."); return; }
        render(res.body);
      })
      .catch(function () { fail("Something went wrong reaching the scorer. Try again."); })
      .finally(function () {
        setBusy(false);
        captchaToken = null;   // Turnstile tokens are single-use
        if (siteKey && window.turnstile) { try { window.turnstile.reset("#captcha"); } catch (e) {} }
      });
  });
})();
