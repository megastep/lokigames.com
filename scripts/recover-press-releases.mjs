#!/usr/bin/env node

/**
 * Downloads the complete HTML captures of Loki press releases from the
 * Internet Archive. The legacy site only retains the PHP page templates, not
 * the release bodies. The generated source is consumed by build-static-site.
 */
import { access, mkdir, writeFile } from 'node:fs/promises';
import path from 'node:path';

const captures = [
  ['01042001', '20010607185830'], ['01182000', '20000530084249'],
  ['01261999', '20001031063028'], ['02082000', '20000423180525'],
  ['04112001', '20010421052430'], ['05162001', '20010602061038'],
  ['05171999', '20010616083027'], ['05212000', '20001212042000'],
  ['06022000', '20000621022530'], ['06192001', '20010627100020'],
  ['06202000', '20010417223240'], ['06222000', '20010417223541'],
  ['06282001', '20010803050453'], ['07062000', '20001205170200'],
  ['07141999', '20000118194629'], ['07271999', '20010601134328'],
  ['08012000', '20010806020004'], ['08102001', '20010819025529'],
  ['08152000', '20010529111612'], ['08272001', '20020406040717'],
  ['09062000', '20001031152127'], ['09081999', '20000116163400'],
  ['09082000', '20001031153526'], ['09152000', '20001031075519'],
  ['09171999', '20020126211359'], ['10082001', '20011201212818'],
  ['10111999', '20000120005440'], ['10151999', '20000124124440'],
  ['11011999', '20010601140819'], ['11031999', '20000229043303'],
  ['11041999', '20000526123924'], ['11092000', '20001212070300'],
  ['12021999', '20000229063112'], ['12081998', '20010601141906'],
];

const destination = path.join(process.cwd(), 'recovered-source', 'press');
await mkdir(destination, { recursive: true });

for (const [id, timestamp] of captures) {
  const output = path.join(destination, `${id}.html`);
  try {
    await access(output);
    continue;
  } catch { /* Recover the missing source capture. */ }
  const original = `http://www.lokigames.com:80/press/archive.php3?${id}`;
  const url = `https://web.archive.org/web/${timestamp}id_/${original}`;
  const response = await fetch(url);
  if (!response.ok) throw new Error(`Could not recover ${id}: ${response.status} ${response.statusText}`);
  const html = await response.text();
  if (!/Loki Software|Loki Entertainment/i.test(html)) {
    throw new Error(`Recovered ${id} did not contain a Loki press release.`);
  }
  await writeFile(output, html);
  console.log(`Recovered ${id}.html`);
}
