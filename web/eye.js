/* eyeball — the protagonist. A canvas eye that watches the cursor and blinks.
   Real kinetic motion (the brief's signature moment), not a CSS fade. Honors
   reduced-motion (static eye, no loop). No dependencies. */
(function () {
  "use strict";
  var c = document.getElementById("eye");
  if (!c || !c.getContext) return;
  var ctx = c.getContext("2d");
  var DPR = Math.min(2, window.devicePixelRatio || 1);
  var W = 116, H = 116, cx = W / 2, cy = H / 2;
  c.width = W * DPR; c.height = H * DPR;
  c.style.width = W + "px"; c.style.height = H + "px";
  ctx.scale(DPR, DPR);

  var INK = "#1d1a16", AMBER = "#c2761b";
  var target = { x: cx, y: cy }, pupil = { x: cx, y: cy };
  var rand = function (a, b) { return a + Math.random() * (b - a); };

  function draw(open) {
    ctx.clearRect(0, 0, W, H);
    var rx = 46, ry = Math.max(2, 30 * open);
    ctx.lineWidth = 2.4; ctx.lineCap = "round"; ctx.strokeStyle = AMBER;
    ctx.beginPath(); ctx.ellipse(cx, cy, rx, ry, 0, 0, Math.PI * 2); ctx.stroke();
    if (open < 0.22) return;                       // closed -> just the lid line
    ctx.save();
    ctx.beginPath(); ctx.ellipse(cx, cy, rx - 2, ry - 2, 0, 0, Math.PI * 2); ctx.clip();
    var ir = 18;
    ctx.fillStyle = "rgba(194,118,27,0.16)"; ctx.beginPath(); ctx.arc(pupil.x, pupil.y, ir, 0, Math.PI * 2); ctx.fill();
    ctx.lineWidth = 1.5; ctx.strokeStyle = AMBER; ctx.beginPath(); ctx.arc(pupil.x, pupil.y, ir, 0, Math.PI * 2); ctx.stroke();
    ctx.fillStyle = INK; ctx.beginPath(); ctx.arc(pupil.x, pupil.y, 7, 0, Math.PI * 2); ctx.fill();
    ctx.fillStyle = "rgba(255,255,255,0.85)"; ctx.beginPath(); ctx.arc(pupil.x - 2.5, pupil.y - 2.5, 2, 0, Math.PI * 2); ctx.fill();
    ctx.restore();
  }

  if (window.matchMedia && window.matchMedia("(prefers-reduced-motion: reduce)").matches) {
    draw(1); return;
  }

  window.addEventListener("mousemove", function (e) {
    var r = c.getBoundingClientRect();
    target.x = e.clientX - r.left; target.y = e.clientY - r.top;
  }, { passive: true });

  var last = performance.now() / 1000, blinkIn = rand(2.5, 5), blinking = false, bp = 0;
  function frame(now) {
    now /= 1000; var dt = Math.min(0.05, now - last); last = now;
    // pupil eases toward the cursor, clamped to a small travel radius
    var dx = target.x - cx, dy = target.y - cy, d = Math.hypot(dx, dy) || 1, m = 16;
    var tx = cx + dx / d * Math.min(m, d * 0.18), ty = cy + dy / d * Math.min(m, d * 0.18);
    pupil.x += (tx - pupil.x) * Math.min(1, dt * 8);
    pupil.y += (ty - pupil.y) * Math.min(1, dt * 8);
    // occasional blink
    var open = 1;
    if (!blinking) { blinkIn -= dt; if (blinkIn <= 0) { blinking = true; bp = 0; blinkIn = rand(2.8, 6); } }
    if (blinking) { bp += dt / 0.16; if (bp >= 1) blinking = false; else open = Math.abs(Math.cos(bp * Math.PI)); }
    draw(open);
    requestAnimationFrame(frame);
  }
  draw(1);
  requestAnimationFrame(frame);
})();
