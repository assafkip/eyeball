# vendored engine (do not edit here)

`render.mjs` and `assert.mjs` are verbatim copies of `../../../src/render.mjs` and
`../../../src/assert.mjs` (the OSS eyeball engine). They are vendored so the `web/`
app is self-contained and deploys with Vercel root = `web/` (the function installs
`web/package.json` deps; the parent `src/` is outside that root).

Source of truth is `src/`. To re-sync after an engine change:

```
cp ../../../src/render.mjs render.mjs
cp ../../../src/assert.mjs assert.mjs
```

The OSS CLI keeps zero runtime deps; only this web app adds @sparticuz/chromium +
playwright-core.
