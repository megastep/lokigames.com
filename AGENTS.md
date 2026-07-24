# Loki Games archive

## Project layout

- `legacy-source/www.lokigames.com/` is the downloaded historical source snapshot. Do not edit it by hand.
- `scripts/build-static-site.mjs` converts that snapshot into the deployable Jekyll source.
- `docs/` is the generated Jekyll source used by GitHub Pages.
- `.github/workflows/deploy-pages.yml` builds and deploys `docs/` on pushes to `main`.

## Working on the site

1. If source content or conversion logic changes, rebuild with `node scripts/build-static-site.mjs`.
2. Validate with `jekyll build --source docs --destination /private/tmp/lokigames-jekyll-build`.
3. Preview locally with `jekyll serve --source docs --livereload`.

## Important constraints

- Preserve local, file-relative links so the archive works from a GitHub Pages project URL and when opened from disk.
- Keep legacy asset directories public. Jekyll excludes underscore-prefixed paths, so the build converts `_img`, `_global`, and `_bak` to `img`, `global`, and `bak`.
- Do not add executable PHP. The deployed site must remain static HTML and assets only.
- Treat `docs/` as generated output: make durable behavior changes in the build script, then rebuild.
