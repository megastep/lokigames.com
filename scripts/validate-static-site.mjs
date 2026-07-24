#!/usr/bin/env node

import { access, readFile, readdir } from 'node:fs/promises';
import path from 'node:path';

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

const isNoIndex = (file) => /(?:^|\/)(?:_?bak|icons|downloads?|img)(?:\/|$)|(?:legacy-services|form_response|contact_form)\.html$/i.test(path.relative(root, file));
const isReachable = async (target) => access(target).then(() => true, () => false);
const files = await walk(root);
const htmlFiles = [];
for (const file of files.filter((item) => item.endsWith('.html'))) {
  const html = await readFile(file, 'utf8');
  if (/<html\b/i.test(html) && /<head\b/i.test(html)) htmlFiles.push(file);
}
const sitemap = await readFile(path.join(root, 'sitemap.xml'), 'utf8').catch(() => '');
const robots = await readFile(path.join(root, 'robots.txt'), 'utf8').catch(() => '');

if (!/Sitemap:\s+(?:https?:\/\/|\/)/.test(robots)) failures.push('robots.txt does not reference the generated sitemap URL.');
if (!sitemap.startsWith('<?xml')) failures.push('sitemap.xml is missing or invalid.');

for (const file of htmlFiles) {
  const html = await readFile(file, 'utf8');
  const relative = path.relative(root, file);
  const noindex = isNoIndex(file);
  if (relative === 'index.html' && (/javascript:|\beval\(|document\.(?:all|layers)/i.test(html))) failures.push(`${relative}: unsafe legacy JavaScript remains.`);
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
}

if (failures.length) {
  console.error(failures.join('\n'));
  process.exitCode = 1;
} else {
  console.log(`Validated ${htmlFiles.length} HTML pages in ${root}.`);
}
