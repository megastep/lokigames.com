#!/usr/bin/env node

/** Download the public, page-referenced assets which wget skips inside the
 * legacy PHP fragments because the host serves them as non-HTML content. */
import { mkdir, readFile, readdir, stat, writeFile } from 'node:fs/promises';
import path from 'node:path';

const root = process.cwd();
const source = path.join(root, 'legacy-source', 'www.lokigames.com');
const origin = 'https://www.lokigames.com';
const assetPath = /\.(?:gif|jpe?g|png|webp|svg|ico|css|js|swf|mp3|wav|avi|mpg|mpeg|tgz|zip|gz|exe|bin)(?:$|[?#])/i;

const walk = async (directory) => (await Promise.all((await readdir(directory, { withFileTypes: true })).map(async (entry) => {
  const item = path.join(directory, entry.name);
  return entry.isDirectory() ? walk(item) : [item];
}))).flat();

const pages = (await walk(source)).filter((file) => file.endsWith('.html'));
const assets = new Set();
for (const file of pages) {
  const html = await readFile(file, 'utf8');
  for (const match of html.matchAll(/(?:src|href)\s*=\s*["']([^"']+)["']/gi)) {
    const value = match[1];
    if (!assetPath.test(value)) continue;
    const url = new URL(value, new URL(path.relative(source, file), `${origin}/`));
    if (url.origin === origin) assets.add(url);
  }
}

let downloaded = 0;
let skipped = 0;
const unavailable = [];
for (const url of assets) {
  const output = path.join(source, decodeURIComponent(url.pathname));
  try {
    await stat(output);
    skipped += 1;
    continue;
  } catch { /* asset is not present in the first mirror pass */ }
  const response = await fetch(url);
  if (!response.ok) {
    unavailable.push(`${response.status} ${url.pathname}`);
    continue;
  }
  await mkdir(path.dirname(output), { recursive: true });
  await writeFile(output, Buffer.from(await response.arrayBuffer()));
  downloaded += 1;
}
console.log(`Downloaded ${downloaded} missing assets; ${skipped} already present.`);
await writeFile(path.join(root, 'legacy-source', 'MISSING-ASSETS.txt'), unavailable.length
  ? `The live host returned the following assets as unavailable when this snapshot was refreshed:\n${unavailable.join('\n')}\n`
  : 'All referenced assets were available when this snapshot was refreshed.\n');
if (unavailable.length) console.log(`Recorded ${unavailable.length} unavailable legacy assets in legacy-source/MISSING-ASSETS.txt.`);
