/* eyeball-web — api/config.mjs : public client config. Exposes only the Turnstile
   SITE key (public by design); the SECRET stays server-side. Null when captcha is
   not configured, so the frontend simply skips the widget. */
export default function handler(req, res) {
  res.setHeader("content-type", "application/json; charset=utf-8");
  res.setHeader("cache-control", "no-store");
  // Only advertise the site key when the SECRET is also set, so the frontend never
  // shows a captcha the backend won't actually enforce (no fail-open mismatch).
  const enabled = !!(process.env.TURNSTILE_SITEKEY && process.env.TURNSTILE_SECRET);
  res.end(JSON.stringify({ turnstileSiteKey: enabled ? process.env.TURNSTILE_SITEKEY : null }));
}
