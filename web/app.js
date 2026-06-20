/* eyeball-web — app.js : submit a URL, render the report. No framework. */
(function () {
  "use strict";
  var form = document.getElementById("check-form");
  var input = document.getElementById("url");
  var go = document.getElementById("go");
  var result = document.getElementById("result");
  if (!form || !input || !result) return; // never throw on load (the gate renders this page)

  function el(tag, cls, text) {
    var n = document.createElement(tag);
    if (cls) n.className = cls;
    if (text != null) n.textContent = text;
    return n;
  }

  function setBusy(on) {
    go.disabled = on;
    go.textContent = on ? "Looking…" : "Look";
  }

  function scoreClass(score) { return score >= 90 ? "good" : score >= 60 ? "warn" : "bad"; }

  function render(report) {
    result.hidden = false;
    result.innerHTML = "";

    var verdict = el("div", "verdict " + (report.ok ? "good" : scoreClass(report.score)));
    var big = el("div", "score", report.ok ? "Clean" : String(report.score));
    if (!report.ok) big.appendChild(el("span", "outof", "/100"));
    verdict.appendChild(big);
    verdict.appendChild(el("p", "summary", report.summary));
    result.appendChild(verdict);

    var cols = el("div", "cols");
    (report.viewports || []).forEach(function (vp) {
      var col = el("div", "col");
      col.appendChild(el("h3", null, vp.name));
      if (!vp.defects || !vp.defects.length) {
        col.appendChild(el("p", "clean", "No render issues."));
      } else {
        vp.defects.forEach(function (d) {
          var card = el("div", "defect");
          card.appendChild(el("div", "rule", d.rule));
          card.appendChild(el("div", "detail", d.detail));
          card.appendChild(el("div", "fix", d.fix));
          col.appendChild(card);
        });
      }
      cols.appendChild(col);
    });
    result.appendChild(cols);
    result.scrollIntoView({ behavior: "smooth", block: "start" });
  }

  function fail(msg) {
    result.hidden = false;
    result.innerHTML = "";
    var box = el("div", "verdict bad");
    box.appendChild(el("p", "summary", msg));
    result.appendChild(box);
  }

  // captcha (Cloudflare Turnstile): dormant until the server exposes a site key.
  // Only call the API over http(s); on a file:// open (the eyeball gate renders the
  // page locally) a fetch would log a console error and fail our own gate.
  var siteKey = null, captchaToken = null;
  var served = location.protocol === "http:" || location.protocol === "https:";
  if (served) fetch("/api/config").then(function (r) { return r.json(); }).then(function (cfg) {
    siteKey = cfg && cfg.turnstileSiteKey;
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
    result.hidden = false;
    result.innerHTML = "";
    result.appendChild(el("p", "looking", "Rendering " + url + " in a real browser…"));

    var q = "/api/check?url=" + encodeURIComponent(url) + (captchaToken ? "&cf-turnstile-response=" + encodeURIComponent(captchaToken) : "");
    fetch(q)
      .then(function (r) {
        return r.text().then(function (t) {
          var body;
          try { body = JSON.parse(t); } catch (e) { body = { error: "The renderer returned an unexpected response (HTTP " + r.status + ")." }; }
          return { ok: r.ok, body: body };
        });
      })
      .then(function (res) {
        if (!res.ok || res.body.error) { fail(res.body.error || "Could not render that URL."); return; }
        render(res.body);
      })
      .catch(function () { fail("Something went wrong reaching the renderer. Try again."); })
      .finally(function () {
        setBusy(false);
        captchaToken = null;   // Turnstile tokens are single-use
        if (siteKey && window.turnstile) { try { window.turnstile.reset("#captcha"); } catch (e) {} }
      });
  });
})();
