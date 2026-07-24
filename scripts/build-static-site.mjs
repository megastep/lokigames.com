#!/usr/bin/env node

/**
 * Converts the publicly exposed Loki site snapshot into a deployment-ready
 * static site. The old host serves PHP 3 source files and their `php3f`
 * content fragments, so this deliberately never executes legacy PHP.
 */
import { cp, mkdir, readFile, readdir, rename, rm, stat, unlink, writeFile } from 'node:fs/promises';
import path from 'node:path';

const root = process.cwd();
const source = path.join(root, 'legacy-source', 'www.lokigames.com');
const destination = path.join(root, 'docs');
const legacyHost = /(?:https?:)?\/\/(?:www\.)?lokigames\.com(?=[:/?#]|["'\s<])/gi;
const legacySubdomain = /(?:https?|ftp|news):\/\/([a-z0-9-]+)\.lokigames\.com(?=[:/?#]|["'\s<])/gi;

const walk = async (directory) => {
  const entries = await readdir(directory, { withFileTypes: true });
  const nested = await Promise.all(entries.map(async (entry) => {
    const item = path.join(directory, entry.name);
    return entry.isDirectory() ? walk(item) : [item];
  }));
  return nested.flat();
};

const staticName = (name) => ({
  _global: 'global',
  _img: 'img',
  _bak: 'bak',
}[name] ?? `legacy-${name.slice(1)}`);

const renameHiddenLegacyPaths = async (directory) => {
  for (const entry of await readdir(directory, { withFileTypes: true })) {
    const item = path.join(directory, entry.name);
    if (entry.isDirectory()) await renameHiddenLegacyPaths(item);
    if (!entry.name.startsWith('_') || entry.name === '_config.yml') continue;
    const target = path.join(directory, staticName(entry.name));
    try {
      await stat(target);
      // A rendered fragment can recreate a legacy directory after its copied
      // assets have already been renamed. Merge it into the public directory.
      await cp(item, target, { recursive: entry.isDirectory(), force: true });
      await rm(item, { recursive: entry.isDirectory(), force: true });
    } catch {
      await rename(item, target);
    }
  }
};

const titleFor = async (fragmentPath) => {
  const sourcePath = fragmentPath.replace(/\.php3f\.html$/, '.php3.html');
  try {
    const php = await readFile(sourcePath, 'utf8');
    return php.match(/\$title\s*=\s*'([^']+)'/)?.[1] ?? 'Loki Entertainment Software';
  } catch {
    return 'Loki Entertainment Software';
  }
};

const renderFragment = (fragment) => {
  const replacements = [
    [/&lt;\?php/g, '<?php'],
    [/<\?php\s+echo\s+\$text_normal\s*\?>/gi, '<div class="normal">'],
    [/<\?php\s+echo\s+\$_text_normal\s*\?>/gi, '</div>'],
    [/<\?php\s+echo\s+\$text_small\s*\?>/gi, '<div class="small">'],
    [/<\?php\s+echo\s+\$_text_small\s*\?>/gi, '</div>'],
    [/<\?php\s+echo\s+\$text_small_nop\s*\?>/gi, '<span class="small">'],
    [/<\?php\s+echo\s+\$_text_small_nop\s*\?>/gi, '</span>'],
    [/<\?php\s+echo\s+\$subhead\s*\?>/gi, '<h2>'],
    [/<\?php\s+echo\s+\$_subhead\s*\?>/gi, '</h2>'],
    [/<\?php\s+echo\s+\$table_cp4\s*\?>/gi, '<table class="legacy-table">'],
    [/<\?php\s+tabcell_special\('head',\s*(\d+),\s*\d+\);\s*\?>/gi, '<th colspan="$1">'],
    [/<\?php\s+tabcell\('(dark|light)'\);\s*\?>/gi, '<td class="$1">'],
    [/<\?php\s+tabcell\('end'\);\s*\?>/gi, '</td>'],
    [/<\?php[\s\S]*?\?>/gi, ''],
    [/\.php3f?(?:\.html)?(?=["'#?])/gi, '.html'],
  ];

  return replacements.reduce((html, [pattern, replacement]) => html.replace(pattern, replacement), fragment)
    .replace(/<\/TABLE>(?!\s*<\/table>)/gi, '</table>');
};

const pageShell = (title, content) => `<!doctype html>
<html lang="en">
<head>
  <meta charset="utf-8">
  <meta name="viewport" content="width=device-width, initial-scale=1">
  <title>${title.replaceAll('&', '&amp;')}</title>
  <link rel="stylesheet" href="/_global/legacy.css">
</head>
<body>
  <header class="site-header">
    <a href="/" aria-label="Loki home"><img src="/home/_img/lokilogo2.gif" alt="Loki Entertainment Software" width="403" height="77"></a>
    <nav aria-label="Primary"><a href="/products/">Products</a><a href="/orders/">Orders</a><a href="/support/">Support</a><a href="/development/">Development</a><a href="/press/">Press</a><a href="/news/">News</a><a href="/about/">About Loki</a></nav>
  </header>
  <main class="content">${content}</main>
  <footer><a href="/products/">Products</a> | <a href="/orders/">Order</a> | <a href="/support/">Support</a> | <a href="/development/">Development</a> | <a href="/press/">Press</a> | <a href="/news/">News</a> | <a href="/about/">About Loki</a><br>© 2000 Loki Software, Inc.</footer>
</body>
</html>
`;

const localizeLegacyLinks = async (html, output) => {
  // This also catches the one URL used by the original menu JavaScript.
  let localized = html
    .replace(legacyHost, '')
    .replace(legacySubdomain, (_match, service) => `/legacy-services.html#${service.toLowerCase()}`);
  const attribute = /\b(href|src|action)\s*=\s*(?:"([^"]*)"|'([^']*)'|([^\s>]+))/gi;

  localized = await (async () => {
    const matches = [...localized.matchAll(attribute)].reverse();
    for (const match of matches) {
      const original = match[2] ?? match[3] ?? match[4] ?? '';
      // Fragments occasionally used _global as if it were rooted; make that
      // intent explicit before calculating a file-relative URL.
      const requested = original.startsWith('_global/') ? `/${original}` : original;
      if (!requested.startsWith('/')) continue;

      const [pathname, suffix = ''] = requested.match(/^([^?#]*)(.*)$/).slice(1);
      const safePath = pathname.replace(/^\/+/, '');
      const base = path.resolve(destination, safePath);
      if (!base.startsWith(destination)) continue;
      // Prefer an index page for a legacy directory route. Some snapshots also
      // contain a same-named Apache listing (for example, orders.html), which
      // is not the page that the original /orders/ URL served.
      const candidates = [base, path.join(base, 'index.html'), `${base}.html`];
      let target;
      for (const candidate of candidates) {
        try {
          if ((await stat(candidate)).isFile()) {
            target = candidate;
            break;
          }
        } catch { /* try the next static-file form */ }
      }
      // Keep even unavailable historical paths portable: they should remain a
      // relative link in the archive rather than become a root-domain URL.
      target ??= base;

      const relativeTarget = path.relative(path.dirname(output), target).split(path.sep).join('/');
      const isIndex = relativeTarget === 'index.html' || relativeTarget.endsWith('/index.html');
      const localPath = isIndex
        ? relativeTarget.replace(/index\.html$/, '') || './'
        : relativeTarget;
      // Query strings were PHP routing inputs; static routes do not need them.
      const fragment = suffix.startsWith('#') ? suffix : suffix.includes('#') ? `#${suffix.split('#')[1]}` : '';
      const replacement = `${match[1]}="${localPath}${fragment}"`;
      localized = `${localized.slice(0, match.index)}${replacement}${localized.slice(match.index + match[0].length)}`;
    }
    return localized;
  })();
  return localized;
};

await rm(destination, { recursive: true, force: true });
await cp(source, destination, { recursive: true });
await renameHiddenLegacyPaths(destination);
await mkdir(path.join(destination, 'global'), { recursive: true });
await writeFile(path.join(destination, 'global', 'legacy.css'), `
body { margin: 0; min-height: 100vh; background: #000 url('img/back_stripe_blur3.gif') repeat-y; color: #ccc; font: 16px Arial, Helvetica, sans-serif; }
.site-header, .content, footer { width: min(900px, calc(100% - 32px)); margin: 0 auto; }
.site-header { padding: 26px 0 12px; } .site-header img { max-width: 100%; height: auto; }
nav { display: flex; flex-wrap: wrap; gap: 0; margin-top: 16px; border-block: 1px solid #66503e; } nav a { padding: 9px 12px; color: #fff; font-weight: bold; }
.content { box-sizing: border-box; min-height: 440px; padding: 28px 24px; background: rgba(0,0,0,.48); } a { color: #b08f6f; } h1, h2 { color: #fff; } h1 { font-size: 1.5rem; } h2 { font-size: 1.15rem; } .normal { margin: 0 0 18px; line-height: 1.45; } .small { margin: 0 0 14px; font-size: .9rem; line-height: 1.45; }
.legacy-table { border-collapse: collapse; width: 100%; margin: 18px 0; } .legacy-table td, .legacy-table th { padding: 8px; border: 1px solid #564334; text-align: left; } .legacy-table .dark { background: #251b14; } .legacy-table .light { background: #3a2c20; }
img { max-width: 100%; } footer { padding: 24px 0 38px; font-size: .8rem; line-height: 1.8; } @media (max-width: 600px) { .content { padding: 20px 14px; } nav a { padding: 8px; } }
`);
await writeFile(path.join(destination, '_config.yml'), `title: Loki Entertainment Software Archive
description: The Games that Linux People Play
markdown: kramdown
`);
await writeFile(path.join(destination, 'legacy-services.html'), pageShell('Loki legacy services', `
  <h1>Legacy Loki services</h1>
  <div class="normal">This static archive includes the public Loki Games website. Its historical store, update, FAQ, news, FTP, and bug-tracking subdomains were separate services and are not part of this snapshot.</div>
  <div class="small">Links to those retired services remain within this local archive and lead here instead of to a live external Loki domain.</div>
`));

const fragments = (await walk(source)).filter((file) => file.endsWith('.php3f.html'));
for (const fragmentPath of fragments) {
  const fragment = await readFile(fragmentPath, 'utf8');
  const relative = path.relative(source, fragmentPath).replace(/\.php3f\.html$/, '.html');
  const output = path.join(destination, relative);
  await mkdir(path.dirname(output), { recursive: true });
  await writeFile(output, pageShell(await titleFor(fragmentPath), renderFragment(fragment)));
}

// A few PHP fragments themselves live under legacy underscore directories.
// Rename those generated pages as well before Jekyll reads the site.
await renameHiddenLegacyPaths(destination);

for (const file of await walk(destination)) {
  if (file.endsWith('.php3.html') || file.endsWith('.php3f.html') || file.includes('.php3?') || file.includes('?C=')) {
    await unlink(file);
    continue;
  }
  if (file.endsWith('.html')) {
    const html = await readFile(file, 'utf8');
    const staticHtml = await localizeLegacyLinks(
      html
        .replace(/\.php3f?(?:\.html)?(?=["'#?\s>])/gi, '.html')
        .replaceAll('_global/', 'global/')
        .replaceAll('_img/', 'img/')
        .replaceAll('_bak/', 'bak/'),
      file,
    );
    if (html !== staticHtml) await writeFile(file, staticHtml);
  }
}

const staticFiles = await walk(destination);
if (staticFiles.some((file) => file.endsWith('.php') || file.endsWith('.php3.html') || file.endsWith('.php3f.html'))) {
  throw new Error('Static conversion left PHP files in the deployment output.');
}
const jekyllExcludedPaths = staticFiles.filter((file) => path.relative(destination, file).split(path.sep).some((part) => part.startsWith('_') && part !== '_config.yml'));
if (jekyllExcludedPaths.length) {
  throw new Error(`Static conversion left Jekyll-excluded legacy paths in the deployment output: ${jekyllExcludedPaths.join(', ')}`);
}
for (const file of staticFiles.filter((item) => item.endsWith('.html'))) {
  if (/(?:https?|ftp|news):\/\/(?:[a-z0-9-]+\.)?lokigames\.com(?=[:/?#]|["'\s<])/i.test(await readFile(file, 'utf8'))) {
    throw new Error(`Static conversion left an absolute Loki Games URL in ${file}.`);
  }
}

console.log(`Built ${fragments.length} converted PHP pages and ${staticFiles.length} static files in docs/.`);
