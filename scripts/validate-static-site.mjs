#!/usr/bin/env node

import { access, readFile, readdir } from 'node:fs/promises';
import path from 'node:path';
import { hasServerSideRemnant, hasUnsafeLegacyJavaScript, isDirectoryListing, isNoIndexRoute, isTemplateFragment } from './archive-policy.mjs';

const root = path.resolve(process.argv[2] ?? 'docs');
const failures = [];

const walk = async (directory) => {
  const entries = await readdir(directory, { withFileTypes: true });
  const nested = await Promise.all(entries.map((entry) => {
    const file = path.join(directory, entry.name);
    return entry.isDirectory() ? walk(file) : [file];
  }));
  return nested.flat();
};

const isNoIndex = (file) => isNoIndexRoute(path.relative(root, file));
const isReachable = async (target) => access(target).then(() => true, () => false);
const isExternalReference = (value) => /^(?:[a-z][a-z0-9+.-]*:|\/\/|#|www\.[a-z0-9-]+(?:\.[a-z0-9-]+)+(?:[/?#]|$))/i.test(value);
const localReferences = /\b(href|src|action)\s*=\s*(?:"([^"]*)"|'([^']*)'|([^\s>]+))/gi;
const validateLocalReferences = async (file, html) => {
  for (const match of html.matchAll(localReferences)) {
    const attribute = match[1].toLowerCase();
    const value = match[2] ?? match[3] ?? match[4] ?? '';
    if (!value || isExternalReference(value)) continue;
    const pathname = decodeURI(value.split(/[?#]/, 1)[0]);
    if (!pathname) continue;
    const target = path.resolve(pathname.startsWith('/') ? root : path.dirname(file), pathname.replace(/^\/+/, ''));
    if (!target.startsWith(root)) {
      failures.push(`${path.relative(root, file)}: local ${attribute} escapes the archive: ${value}`);
      continue;
    }
    const candidates = attribute === 'href' ? [target, path.join(target, 'index.html'), `${target}.html`] : [target];
    if (!(await Promise.all(candidates.map(isReachable))).some(Boolean)) failures.push(`${path.relative(root, file)}: missing local ${attribute}: ${value}`);
  }
};
const files = await walk(root);
const htmlFiles = [];
const templateFiles = [];
for (const file of files.filter((item) => item.endsWith('.html'))) {
  const html = await readFile(file, 'utf8');
  if (/<html\b/i.test(html) && /<head\b/i.test(html)) htmlFiles.push(file);
  if (isTemplateFragment(html)) templateFiles.push(file);
}
const sitemap = await readFile(path.join(root, 'sitemap.xml'), 'utf8').catch(() => '');
const robots = await readFile(path.join(root, 'robots.txt'), 'utf8').catch(() => '');
const llms = await readFile(path.join(root, 'llms.txt'), 'utf8').catch(() => '');

if (!/Sitemap:\s+(?:https?:\/\/|\/)/.test(robots)) failures.push('robots.txt does not reference the generated sitemap URL.');
if (!sitemap.startsWith('<?xml')) failures.push('sitemap.xml is missing or invalid.');
if (!/^# Loki Entertainment Software Archive\b/m.test(llms) || !/## Key pages/.test(llms)) failures.push('llms.txt is missing its archive summary or key-page index.');
if (/megastep\.github\.io\/lokigames\.com/i.test(llms)) failures.push('llms.txt hardcodes a deployment URL.');
for (const file of templateFiles) {
  const relative = path.relative(root, file).split(path.sep).join('/');
  if (sitemap.includes(`/${relative}</loc>`)) failures.push(`${relative}: template fragment is present in sitemap.xml.`);
}
for (const file of files.filter((item) => item.endsWith('.html') && isNoIndex(item))) {
  const relative = path.relative(root, file).split(path.sep).join('/');
  if (sitemap.includes(`/${relative}</loc>`)) failures.push(`${relative}: noindex route is present in sitemap.xml.`);
}

for (const file of htmlFiles) {
  const html = await readFile(file, 'utf8');
  const relative = path.relative(root, file);
  const noindex = isNoIndex(file);
  if (isDirectoryListing(html)) failures.push(`${relative}: captured directory listing remains in deployment output.`);
  if (hasServerSideRemnant(html)) failures.push(`${relative}: server-side remnant remains in deployment output.`);
  if (hasUnsafeLegacyJavaScript(html)) failures.push(`${relative}: unsafe legacy JavaScript remains.`);
  if (relative === 'orders/index.html' && !/Loki Store has closed[\s\S]*resellers\.html/i.test(html)) {
    failures.push('orders/index.html: archived store-closure notice is missing.');
  }
  if (!noindex) {
    for (const pattern of [/<title\b[^>]*>/gi, /<meta\s+name="description"/gi, /<link\s+rel="canonical"/gi, /<meta\s+property="og:title"/gi, /<meta\s+name="twitter:card"/gi]) {
      if ((html.match(pattern) ?? []).length !== 1) failures.push(`${relative}: expected exactly one ${pattern}.`);
    }
    const canonical = html.match(/<link\s+rel="canonical"\s+href="([^"]+)"/i)?.[1];
    if (!canonical || !/^(?:https?:\/\/|\/)/.test(canonical)) failures.push(`${relative}: canonical URL is missing.`);
    if (canonical && !sitemap.includes(`<loc>${canonical}</loc>`)) failures.push(`${relative}: canonical URL is absent from sitemap.`);
  } else if (!/name="robots" content="noindex, nofollow"/i.test(html)) {
    failures.push(`${relative}: expected noindex metadata.`);
  }
  for (const picture of html.matchAll(/<picture>([\s\S]*?)<\/picture>/gi)) {
    const webp = picture[1].match(/<source\s+srcset="([^"]+)"\s+type="image\/webp">/i)?.[1];
    const fallback = picture[1].match(/<img\b/i);
    if (!webp || !fallback || !(await isReachable(path.resolve(path.dirname(file), webp)))) failures.push(`${relative}: invalid WebP picture fallback.`);
  }
  for (const table of html.matchAll(/<table\b[^>]*\bclass=(?:"[^"]*\blegacy-table\b[^"]*"|'[^']*\blegacy-table\b[^']*')[^>]*>([\s\S]*?)<\/table>/gi)) {
    if (/<tr\b[^>]*>\s*<tr\b/i.test(table[1])) failures.push(`${relative}: legacy table contains a nested row.`);
    for (const row of table[1].matchAll(/<tr\b[^>]*>([\s\S]*?)<\/tr>/gi)) {
      const opened = row[1].match(/<td\b[^>]*>/gi)?.length ?? 0;
      const closed = row[1].match(/<\/td>/gi)?.length ?? 0;
      if (opened !== closed) failures.push(`${relative}: legacy table has unbalanced cells.`);
    }
  }
  await validateLocalReferences(file, html);
}

if (failures.length) {
  console.error(failures.join('\n'));
  process.exitCode = 1;
} else {
  console.log(`Validated ${htmlFiles.length} HTML pages in ${root}.`);
}
