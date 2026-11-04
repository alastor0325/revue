# Vendored third-party files

| File | Source | Version | License |
|---|---|---|---|
| `highlight.min.js` | [`@highlightjs/cdn-assets`](https://www.npmjs.com/package/@highlightjs/cdn-assets) `es/highlight.min.js` (the "common" language bundle, ES module) | 11.12.0 | BSD-3-Clause (header in the file) |

Vendored rather than served from `node_modules` so the same `public/` tree works
for the local server and the static GitHub Pages demo (`docs/index.html`).
Update by copying `es/highlight.min.js` from a newer `@highlightjs/cdn-assets`.
