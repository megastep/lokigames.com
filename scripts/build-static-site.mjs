#!/usr/bin/env node

/**
 * Converts the publicly exposed Loki site snapshot into a deployment-ready
 * static site. The old host serves PHP 3 source files and their `php3f`
 * content fragments, so this deliberately never executes legacy PHP.
 */
import { cp, mkdir, readFile, readdir, rename, rm, stat, unlink, writeFile } from 'node:fs/promises';
import path from 'node:path';
import sharp from 'sharp';
import { isDirectoryListing, isNoIndexRoute, isTemplateFragment, sanitizeUnsafeLegacyJavaScript } from './archive-policy.mjs';

const root = process.cwd();
const source = path.join(root, 'legacy-source', 'www.lokigames.com');
const recoveredPressSource = path.join(root, 'recovered-source', 'press');
const destination = path.join(root, 'docs');
const legacyHost = /(?:https?:)?\/\/(?:www\.)?lokigames\.com(?=[:/?#]|["'\s<])/gi;
const legacySubdomain = /(?:https?|ftp|news):\/\/([a-z0-9-]+)\.lokigames\.com(?=[:/?#]|["'\s<])/gi;
const archiveTitle = 'Loki Entertainment Software Archive';
const archiveDescription = 'An archival copy of the Loki Entertainment Software website, preserving the games that Linux people played.';

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
    [/<\?php\s+echo\s+\$_table_cp4\s*\?>/gi, '</table>'],
    [/<\?php\s+tabcell_special\('(head|dark|light)',\s*(\d+),\s*\d+\);\s*\?>/gi, '<td class="$1" colspan="$2">'],
    [/<\?php\s+tabcell\('(dark|light)'\);\s*\?>/gi, '<td class="$1">'],
    [/<\?php\s+tabcell\('end'\);\s*\?>/gi, '</td>'],
    [/<\?php[\s\S]*?\?>/gi, ''],
    [/\.php3f?(?:\.html)?(?=["'#?])/gi, '.html'],
  ];

  return replacements.reduce((html, [pattern, replacement]) => html.replace(pattern, replacement), fragment)
    .replace(/<\/TABLE>(?!\s*<\/table>)/gi, '</table>')
    .replace(/<\/input>/gi, '')
    .replace(/\s+textwrap=(?:"[^"]*"|'[^']*'|[^\s>]+)/gi, '');
};

const escapeHtml = (value) => value.replaceAll('&', '&amp;').replaceAll('"', '&quot;').replaceAll('<', '&lt;').replaceAll('>', '&gt;');
const pagePrefix = (output) => {
  const relative = path.relative(path.dirname(output), destination).split(path.sep).join('/');
  return relative ? `${relative}/` : './';
};
const canonicalPath = (output) => {
  const relative = path.relative(destination, output).split(path.sep).join('/');
  if (relative === 'index.html') return '/';
  return relative.endsWith('/index.html') ? `/${relative.slice(0, -'index.html'.length)}` : `/${relative}`;
};
const frontMatter = (fields) => `---\n${Object.entries(fields).map(([key, value]) => `${key}: ${JSON.stringify(value)}`).join('\n')}\n---\n`;
const isNoIndex = (output) => isNoIndexRoute(path.relative(destination, output));
const plainText = (html) => html.replace(/<script\b[\s\S]*?<\/script>/gi, ' ').replace(/<style\b[\s\S]*?<\/style>/gi, ' ').replace(/<!--[^]*?-->/g, ' ').replace(/<[^>]+>/g, ' ').replace(/&nbsp;/gi, ' ').replace(/&amp;/gi, '&').replace(/\s+/g, ' ').trim();
const descriptionFor = (html, title) => {
  const existing = html.match(/<meta\s+name=["']description["']\s+content=["']([^"']+)["']/i)?.[1];
  const candidate = existing || plainText(html).replace(title, '').trim() || archiveDescription;
  if (candidate.length <= 160) return candidate;
  return candidate.slice(0, 160).replace(/\s+\S*$/, '').trim() || archiveDescription;
};
const titleFromHtml = (html, fallback) => html.match(/<title[^>]*>([\s\S]*?)<\/title>/i)?.[1].replace(/\s+/g, ' ').trim() || html.match(/<TITLE[^>]*>([\s\S]*?)<\/TITLE>/i)?.[1].replace(/\s+/g, ' ').trim() || fallback;
const titleForOutput = (output) => {
  const relative = canonicalPath(output).replace(/^\/+|\/$/g, '');
  return relative ? `${relative.split('/').pop().replace(/[-_]/g, ' ')} | ${archiveTitle}` : archiveTitle;
};

const localizeLegacyLinks = async (html, output) => {
  // This also catches the one URL used by the original menu JavaScript.
  let localized = html
    .replace(legacyHost, '')
    .replace(legacySubdomain, (_match, service) => `/legacy-services.html#${service.toLowerCase()}`);
  const attribute = /\b(href|src|action)\s*=\s*(?:"([^"]*)"|'([^']*)'|([^\s>]+))/gi;

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
};

const rewriteInternalPhpLinks = async (html, output) => {
  const attribute = /\b(href|src|action)\s*=\s*(?:"([^"]*)"|'([^']*)'|([^\s>]+))/gi;
  let rewritten = html;

  for (const match of [...rewritten.matchAll(attribute)].reverse()) {
    const original = match[2] ?? match[3] ?? match[4] ?? '';
    if (/^(?:[a-z][a-z0-9+.-]*:|\/\/|#)/i.test(original)) continue;

    const decoded = original.replace(/%3f/gi, '?').replace(/%252f/gi, '/');
    if (!/\.php3?f?\b/i.test(decoded)) continue;

    const [pathname, suffix = ''] = decoded.match(/^([^?#]*)(.*)$/).slice(1);
    const pathFromPage = (relativePath) => path.resolve(path.dirname(output), relativePath);
    let target;

    // The mirror encoded dynamic monthly archive routes as archive.php3%3FMMYYYY.html.
    const archiveRoute = decoded.match(/^(.*\/)?archive\.php3\?([^/?#]+?)(?:\.html)?(?:#.*)?$/i);
    if (archiveRoute) {
      const archiveId = archiveRoute[2].replace(/\.html$/i, '');
      const candidate = pathFromPage(`${archiveRoute[1] ?? ''}archive/${archiveId}.html`);
      try {
        if ((await stat(candidate)).isFile()) target = candidate;
      } catch { /* Press releases were not present as individual static files. */ }
      if (!target && /(^|\/)press\//i.test(path.relative(destination, output))) {
        target = path.join(destination, 'press', 'index.html');
      }
    } else {
      const staticPath = pathname.replace(/\.php3?f?(?:\.bak)?$/i, '.html');
      for (const candidate of [pathFromPage(staticPath), pathFromPage(`${staticPath}/index.html`)]) {
        try {
          if ((await stat(candidate)).isFile()) {
            target = candidate;
            break;
          }
        } catch { /* try the next static-file form */ }
      }
    }

    // Avoid retaining a server-side URL even when the historic endpoint did
    // not have a captured response. Link back to the closest local index.
    target ??= path.join(path.dirname(output), 'index.html');
    const relativeTarget = path.relative(path.dirname(output), target).split(path.sep).join('/');
    const fragment = suffix.includes('#') ? `#${suffix.split('#')[1]}` : '';
    const replacement = `${match[1]}="${relativeTarget || './'}${fragment}"`;
    rewritten = `${rewritten.slice(0, match.index)}${replacement}${rewritten.slice(match.index + match[0].length)}`;
  }

  return rewritten;
};

const redirectRetiredMail = (html, output) => html.replace(/\bhref\s*=\s*(["'])(mailto:[^"']*@lokigames\.com[^"']*)\1/gi, () => {
  const target = path.join(destination, 'legacy-services.html');
  return `href="${path.relative(path.dirname(output), target).split(path.sep).join('/')}#email"`;
});

const localAttribute = /\b(href|src|action)\s*=\s*(?:"([^"]*)"|'([^']*)'|([^\s>]+))/gi;
const isExternalReference = (value) => /^(?:[a-z][a-z0-9+.-]*:|\/\/|#|\{\{|\{%|www\.[a-z0-9-]+(?:\.[a-z0-9-]+)+(?:[/?#]|$))/i.test(value);
const relativeReference = (output, target) => {
  const relative = path.relative(path.dirname(output), target).split(path.sep).join('/');
  return relative === 'index.html' ? './' : relative.endsWith('/index.html') ? relative.slice(0, -'index.html'.length) : relative;
};
const firstExistingFile = async (candidates) => {
  for (const candidate of candidates) {
    try {
      if ((await stat(candidate)).isFile()) return candidate;
    } catch { /* try the next archive fallback */ }
  }
};
const repairUnavailableLocalReferences = async (html, output) => {
  let repaired = html;
  for (const match of [...repaired.matchAll(localAttribute)].reverse()) {
    const attribute = match[1].toLowerCase();
    const original = match[2] ?? match[3] ?? match[4] ?? '';
    if (!original || isExternalReference(original)) continue;
    const decoded = original.replace(/%3f/gi, '?').replace(/&amp;/gi, '&');
    const [pathname, suffix = ''] = decoded.match(/^([^?#]*)(.*)$/).slice(1);
    if (!pathname) continue;
    const target = path.resolve(pathname.startsWith('/') ? destination : path.dirname(output), pathname.replace(/^\/+/, ''));
    if (!target.startsWith(destination)) continue;
    const routeCandidates = [target, path.join(target, 'index.html'), `${target}.html`];
    if (attribute === 'href' && pathname.endsWith('.html')) {
      const directory = target.slice(0, -'.html'.length);
      routeCandidates.push(path.join(directory, 'index.html'));
      if (/\/(?:faq3|myth2?faq)\.html$/i.test(target)) routeCandidates.push(path.join(path.dirname(target), 'faq.html'));
    }
    const available = await firstExistingFile(routeCandidates);
    let replacement;
    if (available) {
      const fragment = suffix.includes('#') ? `#${suffix.split('#')[1]}` : '';
      replacement = relativeReference(output, available) + fragment;
    } else if (attribute === 'src') {
      replacement = relativeReference(output, path.join(destination, 'global', 'img', 'pixel.gif'));
    } else {
      replacement = relativeReference(output, path.join(destination, 'archive-unavailable.html'));
    }
    repaired = `${repaired.slice(0, match.index)}${attribute}="${replacement}"${repaired.slice(match.index + match[0].length)}`;
  }
  return repaired;
};

const seoTags = ({ title, description, noindex }) => `
  <meta charset="utf-8">
  <meta name="viewport" content="width=device-width, initial-scale=1">
  <title>${escapeHtml(title)}</title>
  <meta name="description" content="${escapeHtml(description)}">
  <meta name="robots" content="${noindex ? 'noindex, nofollow' : 'index, follow'}">
  {% assign canonical_origin = site.github.url | default: site.url %}
  <link rel="canonical" href="{{ canonical_origin }}{{ page.url }}">
  <meta property="og:title" content="${escapeHtml(title)}">
  <meta property="og:description" content="${escapeHtml(description)}">
  <meta property="og:url" content="{{ canonical_origin }}{{ page.url }}">
  <meta property="og:type" content="website">
  <meta name="twitter:card" content="summary">
`;

const injectSeo = (html, output) => {
  if (!/<head\b[^>]*>/i.test(html)) return html;
  const title = titleFromHtml(html, titleForOutput(output));
  const description = descriptionFor(html, title);
  const noindex = isNoIndex(output);
  const cleaned = html
    .replace(/\s*<meta\s+(?:name=["'](?:description|robots)["']|property=["']og:[^"']+["']|name=["']twitter:card["'])[^>]*>/gi, '')
    .replace(/\s*<link\s+rel=["']canonical["'][^>]*>/gi, '')
    .replace(/\s*<meta\s+charset=[^>]*>/gi, '')
    .replace(/\s*<meta\s+name=["']viewport["'][^>]*>/gi, '')
    .replace(/\s*<(title|TITLE)[^>]*>[\s\S]*?<\/(?:title|TITLE)>/i, '');
  return cleaned.replace(/<head\b[^>]*>/i, (head) => `${head}${seoTags({ title, description, noindex })}`);
};

const homepageScript = `const menus = ['products', 'orders', 'support', 'development', 'press', 'about', 'news'];
const menuElement = (name) => document.getElementById(\`menu\${name}\`);
const setImage = (name, state) => {
  const image = document.images[name];
  if (image) image.src = \`home/img/nav/\${name}_\${state}.gif\`;
};
const setPortal = (name = '') => {
  const portal = document.images.portal;
  if (portal) portal.src = name ? \`home/img/portal/\${name}.gif\` : 'home/img/portal/blank.gif';
};
const hideMenus = () => {
  for (const name of menus) {
    const menu = menuElement(name);
    if (menu) menu.style.visibility = 'hidden';
    setImage(name, 'off');
  }
  const back = document.getElementById('menuback');
  if (back) back.style.visibility = 'hidden';
  setPortal();
};
const showMenu = (name) => {
  hideMenus();
  const menu = menuElement(name);
  const back = document.getElementById('menuback');
  if (menu) menu.style.visibility = 'visible';
  if (back) back.style.visibility = 'visible';
  setImage(name, 'on');
  setPortal(name);
};
document.addEventListener('DOMContentLoaded', () => {
  document.querySelectorAll('[data-menu]').forEach((link) => {
    const name = link.dataset.menu;
    link.addEventListener('click', (event) => { event.preventDefault(); showMenu(name); });
    link.addEventListener('pointerenter', () => { setImage(name, 'on'); setPortal(name); });
    link.addEventListener('pointerleave', () => { setImage(name, 'off'); setPortal(); });
    link.addEventListener('focus', () => showMenu(name));
  });
  document.addEventListener('keydown', (event) => { if (event.key === 'Escape') hideMenus(); });
});
`;

const modernizeHomePage = async (output) => {
  let html = await readFile(output, 'utf8');
  const style = html.match(/<style[^>]*>([\s\S]*?)<\/style>/i)?.[1] ?? '';
  const css = `${style.replace(/<!--|-->/g, '').replace(/url\((?:_global\/)?global\/img\//gi, "url('img/").replace(/\.gif\)/gi, ".gif')")}

/* This image-driven header is one fixed-width composition. Preventing table
   reflow keeps its historical slices aligned on narrow viewports. */
#home-composite { position: relative; width: 541px; height: 257px; min-width: 541px; }
#home-composite img { position: absolute; display: block; max-width: none; }
#home-top-left { left: 0; top: 0; width: 255px; height: 69px; }
#home-portal { left: 255px; top: 0; width: 286px; height: 69px; }
#home-logo { left: 0; top: 69px; width: 366px; height: 116px; }
#home-bottom-left { left: 0; top: 185px; width: 313px; height: 72px; }
#home-composite .home-nav { position: absolute; z-index: 1; text-align: left; line-height: 0; }
#home-primary-nav { left: 366px; top: 69px; }
#home-secondary-nav { left: 313px; top: 185px; }
#home-composite .home-nav img { position: static; }
`;
  const composite = `<div id="home-composite">
  <img id="home-top-left" src="home/img/topleft.gif" alt="" width="255" height="69" ismap usemap="#standardsmap">
  <img id="home-portal" src="home/img/portal/blank.gif" alt="" width="286" height="69" name="portal">
  <img id="home-logo" src="home/img/lokilogo2.gif" alt="Loki Entertainment Software" width="366" height="116">
  <div id="home-primary-nav" class="home-nav"><a href="products/" data-menu="products"><img src="home/img/nav/products_out.gif" alt="Products" width="130" height="21" name="products"></a><br><a href="orders/" data-menu="orders"><img src="home/img/nav/orders_out.gif" alt="Orders" width="106" height="24" name="orders"></a><br><a href="support/" data-menu="support"><img src="home/img/nav/support_out.gif" alt="Support" width="103" height="25" name="support"></a><br><a href="development/" data-menu="development"><img src="home/img/nav/development_out.gif" alt="Development" width="116" height="27" name="development"></a><br><a href="press/" data-menu="press"><img src="home/img/nav/press_out.gif" alt="Press" width="67" height="19" name="press"></a></div>
  <img id="home-bottom-left" src="home/img/bottom_left.gif" alt="" width="313" height="72">
  <div id="home-secondary-nav" class="home-nav"><a href="about/" data-menu="about"><img src="home/img/nav/about_out.gif" alt="About Loki" width="112" height="24" name="about"></a><br><a href="news/" data-menu="news"><img src="home/img/nav/news_out.gif" alt="Newsstand" width="89" height="35" name="news"></a></div>
</div>`;
  html = html
    .replace(/<!DOCTYPE[^>]*>/i, '<!doctype html>')
    .replace(/<HTML>/i, '<html lang="en">')
    .replace(/<TABLE BORDER="0" CELLPADDING="0" CELLSPACING="0">[\s\S]*?<\/TABLE>/i, composite)
    .replace(/<style[^>]*>[\s\S]*?<\/style>/i, '<link rel="stylesheet" href="global/homepage.css">')
    .replace(/<script[^>]*>[\s\S]*?<\/script>/i, '<script src="global/homepage.js" defer></script>')
    .replace(/\s+onLoad=("[^"]*"|'[^']*')/i, '')
    .replace(/href="javascript:showLayer\(\d+,1\),flipNav\('([^']+)',1\)"\s+onMouseOver=("[^"]*"|'[^']*')\s+onMouseOut=("[^"]*"|'[^']*')/gi, (_match, name) => `href="${name}/" data-menu="${name}"`);
  await writeFile(path.join(destination, 'global', 'homepage.css'), css);
  await writeFile(path.join(destination, 'global', 'homepage.js'), homepageScript);
  await writeFile(output, html);
};

const removeDirectoryListings = async () => {
  for (const file of (await walk(destination)).filter((item) => item.endsWith('.html'))) {
    if (isDirectoryListing(await readFile(file, 'utf8'))) await unlink(file);
  }
};

const optimizeImages = async () => {
  const htmlFiles = (await walk(destination)).filter((file) => file.endsWith('.html') && !file.includes(`${path.sep}_`));
  const generated = new Map();
  for (const file of htmlFiles) {
    let html = await readFile(file, 'utf8');
    const matches = [...html.matchAll(/<img\b[^>]*\bsrc\s*=\s*(?:"([^"]+)"|'([^']+)'|([^\s>]+))[^>]*>/gi)].reverse();
    for (const match of matches) {
      const tag = match[0];
      const src = match[1] ?? match[2] ?? match[3];
      if (/^(?:[a-z][a-z0-9+.-]*:|\/|#)/i.test(src) || /\b(?:usemap|ismap|name)\s*=/i.test(tag)) continue;
      const imagePath = path.resolve(path.dirname(file), src);
      if (!imagePath.startsWith(destination) || !/\.(?:jpe?g|gif)$/i.test(imagePath)) continue;
      let metadata, imageStat;
      try {
        [metadata, imageStat] = await Promise.all([sharp(imagePath, { animated: true }).metadata(), stat(imagePath)]);
      } catch { continue; }
      if (imageStat.size < 16 * 1024 || (metadata.format === 'gif' && (metadata.pages ?? 1) > 1)) continue;
      const webpPath = imagePath.replace(/\.(?:jpe?g|gif)$/i, '.webp');
      if (!generated.has(imagePath)) {
        await sharp(imagePath, { animated: false }).webp({ quality: 82 }).toFile(webpPath);
        generated.set(imagePath, { webpPath, metadata });
      }
      const { metadata: dimensions } = generated.get(imagePath);
      const webpRelative = path.relative(path.dirname(file), webpPath).split(path.sep).join('/');
      const sizedTag = /\bwidth\s*=/.test(tag) || !dimensions.width || !dimensions.height
        ? tag : tag.replace(/<img\b/i, `<img width="${dimensions.width}" height="${dimensions.height}"`);
      const enrichedTag = /\bloading\s*=/.test(sizedTag) || (path.relative(destination, file) === 'index.html' && /\bid="home-logo"/i.test(sizedTag))
        ? sizedTag.replace(/<img\b/i, '<img decoding="async"')
        : sizedTag.replace(/<img\b/i, '<img loading="lazy" decoding="async"');
      const picture = `<picture><source srcset="${webpRelative}" type="image/webp">${enrichedTag}</picture>`;
      html = `${html.slice(0, match.index)}${picture}${html.slice(match.index + tag.length)}`;
    }
    await writeFile(file, html);
  }
  return generated.size;
};

await rm(destination, { recursive: true, force: true });
await cp(source, destination, { recursive: true });
// The original server now exposes only PHP template stubs for press releases.
// Archived full-page captures are stored separately so the source snapshot stays
// untouched while the resulting static archive preserves the release bodies.
try {
  await cp(recoveredPressSource, path.join(destination, 'press', 'archive'), { recursive: true });
} catch (error) {
  if (error.code !== 'ENOENT') throw error;
}
await renameHiddenLegacyPaths(destination);
await mkdir(path.join(destination, 'global'), { recursive: true });
await writeFile(path.join(destination, 'global', 'legacy.css'), `
body { margin: 0; min-height: 100vh; background: #000 url('img/back_stripe_blur3.gif') repeat-y; color: #ccc; font: 16px Arial, Helvetica, sans-serif; }
.site-header, .content, footer { width: min(900px, calc(100% - 32px)); margin: 0 auto; }
.site-header { padding: 26px 0 12px; } .site-header img { max-width: 100%; height: auto; }
nav { display: flex; flex-wrap: wrap; gap: 0; margin-top: 16px; border-block: 1px solid #66503e; } nav a { padding: 9px 12px; color: #fff; font-weight: bold; }
.content { box-sizing: border-box; min-height: 440px; padding: 28px 24px; background: rgba(0,0,0,.48); } a { color: #b08f6f; } h1, h2 { color: #fff; } h1 { font-size: 1.5rem; } h2 { font-size: 1.15rem; } .normal { margin: 0 0 18px; line-height: 1.45; } .small { margin: 0 0 14px; font-size: .9rem; line-height: 1.45; }
.legacy-table { border-collapse: collapse; width: 100%; margin: 18px 0; } .legacy-table td, .legacy-table th { padding: 8px; border: 1px solid #564334; text-align: left; } .legacy-table .dark { background: #251b14; } .legacy-table .light { background: #3a2c20; }
img { max-width: 100%; } picture { display: contents; } footer { padding: 24px 0 38px; font-size: .8rem; line-height: 1.8; } @media (max-width: 600px) { .content { padding: 20px 14px; } nav a { padding: 8px; } }
`);
await writeFile(path.join(destination, '_config.yml'), `title: ${archiveTitle}
description: The Games that Linux People Play
markdown: kramdown
`);
await mkdir(path.join(destination, '_layouts'), { recursive: true });
await mkdir(path.join(destination, '_includes'), { recursive: true });
await writeFile(path.join(destination, '_includes', 'seo.html'), `<meta charset="utf-8">
<meta name="viewport" content="width=device-width, initial-scale=1">
<title>{{ page.title | escape }}</title>
<meta name="description" content="{{ page.description | escape }}">
<meta name="robots" content="{% if page.noindex %}noindex, nofollow{% else %}index, follow{% endif %}">
{% assign canonical_origin = site.github.url | default: site.url %}
<link rel="canonical" href="{{ canonical_origin }}{{ page.url }}">
<meta property="og:title" content="{{ page.title | escape }}">
<meta property="og:description" content="{{ page.description | escape }}">
<meta property="og:url" content="{{ canonical_origin }}{{ page.url }}">
<meta property="og:type" content="website">
<meta name="twitter:card" content="summary">
`);
await writeFile(path.join(destination, '_includes', 'site-header.html'), `<header class="site-header">
  <a href="{{ page.prefix }}" aria-label="Loki home"><img src="{{ page.prefix }}home/img/lokilogo2.gif" alt="Loki Entertainment Software" width="403" height="77"></a>
  <nav aria-label="Primary"><a href="{{ page.prefix }}products/">Products</a><a href="{{ page.prefix }}orders/">Orders</a><a href="{{ page.prefix }}support/">Support</a><a href="{{ page.prefix }}development/">Development</a><a href="{{ page.prefix }}press/">Press</a><a href="{{ page.prefix }}news/">News</a><a href="{{ page.prefix }}about/">About Loki</a></nav>
</header>
`);
await writeFile(path.join(destination, '_includes', 'site-footer.html'), `<footer><a href="{{ page.prefix }}products/">Products</a> | <a href="{{ page.prefix }}orders/">Order</a> | <a href="{{ page.prefix }}support/">Support</a> | <a href="{{ page.prefix }}development/">Development</a> | <a href="{{ page.prefix }}press/">Press</a> | <a href="{{ page.prefix }}news/">News</a> | <a href="{{ page.prefix }}about/">About Loki</a><br>© 2000 Loki Software, Inc.</footer>
`);
await writeFile(path.join(destination, '_layouts', 'legacy.html'), `<!doctype html>
<html lang="en">
<head>{% include seo.html %}<link rel="stylesheet" href="{{ page.prefix }}global/legacy.css"></head>
<body>{% include site-header.html %}<main class="content">{{ content }}</main>{% include site-footer.html %}</body>
</html>
`);

const writeLegacyPage = async (output, title, content, noindex = false) => {
  const description = descriptionFor(content, title);
  await mkdir(path.dirname(output), { recursive: true });
  await writeFile(output, `${frontMatter({ layout: 'legacy', title, description, prefix: pagePrefix(output), noindex })}${content}`);
};
await writeLegacyPage(path.join(destination, 'legacy-services.html'), 'Loki legacy services', `
  <h1>Legacy Loki services</h1>
  <div class="normal">This static archive includes the public Loki Games website. Its historical store, update, FAQ, news, FTP, and bug-tracking subdomains were separate services and are not part of this snapshot.</div>
  <div class="small">Links to those retired services remain within this local archive and lead here instead of to a live external Loki domain.</div>
  <h2 id="email">Retired email</h2>
  <div class="small">Historical Loki email addresses are preserved as archival text, but they no longer accept messages.</div>
`, true);
await writeLegacyPage(path.join(destination, 'archive-unavailable.html'), 'Archived Loki resource unavailable', `
  <h1>Archived resource unavailable</h1>
  <div class="normal">This historical link or asset was not included in the captured Loki Games website snapshot.</div>
  <div class="small">The original link text is preserved where it appears in the archive.</div>
`, true);

const fragments = (await walk(source)).filter((file) => file.endsWith('.php3f.html'));
for (const fragmentPath of fragments) {
  const fragment = await readFile(fragmentPath, 'utf8');
  const relative = path.relative(source, fragmentPath).replace(/\.php3f\.html$/, '.html');
  const output = path.join(destination, relative);
  let content = renderFragment(fragment);
  if (relative === 'about/form_response.html') content = `<div class="normal">This archived contact form is no longer delivered because Loki Entertainment Software is no longer operating.</div>${content}`;
  await writeLegacyPage(output, await titleFor(fragmentPath), content, isNoIndex(output));
}

// A few PHP fragments themselves live under legacy underscore directories.
// Rename those generated pages as well before Jekyll reads the site.
await renameHiddenLegacyPaths(destination);
await rename(path.join(destination, 'legacy-layouts'), path.join(destination, '_layouts'));
await rename(path.join(destination, 'legacy-includes'), path.join(destination, '_includes'));
await removeDirectoryListings();

for (const file of await walk(destination)) {
  if (file.endsWith('.php3.html') || file.endsWith('.php3f.html') || file.includes('?')) {
    await unlink(file);
    continue;
  }
  if (file.endsWith('.html')) {
    const html = await readFile(file, 'utf8');
    let staticHtml = await rewriteInternalPhpLinks(await localizeLegacyLinks(
      html
        .replace(/\.php3f?(?:\.html)?(?=["'#?\s>])/gi, '.html')
        .replaceAll('_global/', 'global/')
        .replaceAll('_img/', 'img/')
        .replaceAll('_bak/', 'bak/')
        .replace(/<\?(?:php)?[\s\S]*?\?>/gi, ''),
      file,
    ), file);
    staticHtml = redirectRetiredMail(staticHtml, file);
    staticHtml = await repairUnavailableLocalReferences(staticHtml, file);
    if (file !== path.join(destination, 'index.html')) staticHtml = sanitizeUnsafeLegacyJavaScript(staticHtml);
    if (!file.includes(`${path.sep}_layouts${path.sep}`) && !file.includes(`${path.sep}_includes${path.sep}`) && !staticHtml.startsWith('---\n')) {
      staticHtml = `${frontMatter({ noindex: isNoIndex(file) || isTemplateFragment(staticHtml) })}${injectSeo(staticHtml, file)}`;
    }
    if (html !== staticHtml) await writeFile(file, staticHtml);
  }
}

await modernizeHomePage(path.join(destination, 'index.html'));
const optimizedImages = await optimizeImages();

const sitemap = `---\n---\n<?xml version="1.0" encoding="UTF-8"?>\n{% assign canonical_origin = site.github.url | default: site.url %}<urlset xmlns="http://www.sitemaps.org/schemas/sitemap/0.9">{% for page in site.html_pages %}{% unless page.noindex %}\n  <url><loc>{{ canonical_origin }}{{ page.url }}</loc></url>{% endunless %}{% endfor %}\n</urlset>\n`;
await writeFile(path.join(destination, 'sitemap.xml'), sitemap);
await writeFile(path.join(destination, 'robots.txt'), `---\n---\nUser-agent: *\nDisallow: /i-am+so+british-like-ck/\nSitemap: {{ site.github.url | default: site.url }}/sitemap.xml\n`);

const staticFiles = await walk(destination);
if (staticFiles.some((file) => file.endsWith('.php') || file.endsWith('.php3.html') || file.endsWith('.php3f.html'))) {
  throw new Error('Static conversion left PHP files in the deployment output.');
}
const jekyllExcludedPaths = staticFiles.filter((file) => path.relative(destination, file).split(path.sep).some((part) => part.startsWith('_') && !['_config.yml', '_layouts', '_includes'].includes(part)));
if (jekyllExcludedPaths.length) {
  throw new Error(`Static conversion left Jekyll-excluded legacy paths in the deployment output: ${jekyllExcludedPaths.join(', ')}`);
}
for (const file of staticFiles.filter((item) => item.endsWith('.html'))) {
  if (/(?:https?|ftp|news):\/\/(?:[a-z0-9-]+\.)?lokigames\.com(?=[:/?#]|["'\s<])/i.test(await readFile(file, 'utf8'))) {
    throw new Error(`Static conversion left an absolute Loki Games URL in ${file}.`);
  }
}

console.log(`Built ${fragments.length} converted PHP pages, ${optimizedImages} WebP derivatives, and ${staticFiles.length} static files in docs/.`);
