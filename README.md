# Loki Games static archive

This repository preserves the public pages of [lokigames.com](https://www.lokigames.com/) as a static site. It does not contain or execute legacy PHP.

## What is included

- `legacy-source/www.lokigames.com/` is the downloaded public snapshot (including original PHP source fragments exposed by the host).
- `site/` is the deployable output: PHP content fragments have been converted to ordinary HTML pages and the legacy assets are served locally.
- `scripts/build-static-site.mjs` rebuilds `site/` from the snapshot.

## Rebuild and preview

```sh
node scripts/download-referenced-assets.mjs
node scripts/build-static-site.mjs
python3 -m http.server 8080 --directory site
```

Then open `http://localhost:8080`. Any normal static hosting provider can publish `site/` directly.

The PHP that is still visible on the live legacy host is not executable there either. Its `.php3f` companion files contain the page bodies; the build script uses those bodies and wraps them in a local, asset-backed static layout.

`legacy-source/MISSING-ASSETS.txt` records references that the live host returned as 404 during the download. Those are historical omissions on the source host, not files omitted by the conversion.
