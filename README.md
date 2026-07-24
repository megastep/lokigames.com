# Loki Games Jekyll archive

This repository preserves the public pages of [lokigames.com](https://www.lokigames.com/) as a Jekyll site for GitHub Pages. It does not contain or execute legacy PHP.

## What is included

- `legacy-source/www.lokigames.com/` is the downloaded public snapshot (including original PHP source fragments exposed by the host).
- `docs/` is the Jekyll source and GitHub Pages deployment input: PHP content fragments have been converted to ordinary HTML pages and the legacy assets are served locally.
- `docs/_config.yml` is the GitHub Pages Jekyll configuration. The conversion flattens legacy underscore-prefixed asset directories so Jekyll publishes them normally.
- `scripts/build-static-site.mjs` rebuilds `docs/` from the snapshot.
- `.github/workflows/deploy-pages.yml` builds and deploys the site on each push to `main`.

## Rebuild and preview

```sh
node scripts/download-referenced-assets.mjs
node scripts/build-static-site.mjs
jekyll serve --source docs --livereload
```

Then open `http://127.0.0.1:4000`. For GitHub Pages, set **Settings → Pages → Build and deployment → Source** to **GitHub Actions**, then push `main`.

The PHP that is still visible on the live legacy host is not executable there either. Its `.php3f` companion files contain the page bodies; the build script uses those bodies and wraps them in a local, asset-backed static layout.

`legacy-source/MISSING-ASSETS.txt` records references that the live host returned as 404 during the download. Those are historical omissions on the source host, not files omitted by the conversion.
