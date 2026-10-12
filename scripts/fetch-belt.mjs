// Fetch orbital elements of every asteroid brighter than absolute magnitude H = 13 (diameter larger than about
// 10 km for a typical albedo of 0.1) from the JPL SBDB Query API and bake the asteroid-belt region into
// src/data/belt.json for the "Belt" point cloud. Run: npm run fetch-belt (Node 22+, global fetch). Never used at
// runtime.
//
// The query also returns several thousand trans-Neptunian objects (a > 30 AU); the cloud keeps the inner solar
// system up to and including the Jupiter Trojans (a < 6 AU): Mars-crossers, the main belt, the Cybele and Hilda
// groups and both Trojan clouds.
//
// Output (compact, 6 significant digits):
//   { source, query, fetchedAt, count, epoch, fields: ['a','e','i','om','w','ma','H'],
//     names: ['Ceres', ...], data: [[a, e, iDeg, omDeg, wDeg, maDeg, H, epoch?], ...] }
// a in AU, angles in degrees (ecliptic J2000), ma = mean anomaly at the epoch. The 8th element is present only
// when the record's epoch differs from the common `epoch`.
import { writeFile, mkdir, stat } from 'node:fs/promises';
import { dirname, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';

const ROOT = resolve(dirname(fileURLToPath(import.meta.url)), '..');
const OUT = resolve(ROOT, 'src', 'data', 'belt.json');
const H_MAX = 13;
const A_MAX = 6;

const sig = (x, d = 6) => Number(Number(x).toPrecision(d));

/** "     1 Ceres (A801 AA)" -> "Ceres"; " 12345 (1993 FA)" -> "12345 (1993 FA)"; "       (2025 OQ737)" -> "2025 OQ737". */
function shortName(full) {
  const s = String(full).trim();
  const m = s.match(/^(\d+)\s+([^(]+?)\s*(\([^)]*\))?$/);
  if (m) return m[2].trim();                 // numbered and named
  const n = s.match(/^(\d+)\s*\(([^)]+)\)$/);
  if (n) return `${n[1]} (${n[2]})`;        // numbered, unnamed
  const p = s.match(/^\(([^)]+)\)$/);
  if (p) return p[1];                        // provisional designation only
  return s;
}

async function main() {
  const cdata = JSON.stringify({ AND: [`H|LT|${H_MAX}`] });
  const url = `https://ssd-api.jpl.nasa.gov/sbdb_query.api?fields=full_name,a,e,i,om,w,ma,epoch,H&sb-kind=a&full-prec=true&sb-cdata=${encodeURIComponent(cdata)}`;
  console.log(`GET ${url}`);
  const res = await fetch(url, { headers: { 'User-Agent': 'solar-system-model/0.3 (fetch-belt script)' } });
  if (!res.ok) throw new Error(`HTTP ${res.status}`);
  const json = await res.json();
  const f = Object.fromEntries(json.fields.map((k, i) => [k, i]));
  console.log(`SBDB returned ${json.data.length} asteroids with H < ${H_MAX}.`);

  // most common epoch -> stored once
  const epochCount = new Map();
  for (const r of json.data) epochCount.set(r[f.epoch], (epochCount.get(r[f.epoch]) || 0) + 1);
  const commonEpoch = Number([...epochCount.entries()].sort((a, b) => b[1] - a[1])[0][0]);

  const names = [], data = [];
  let skipped = 0, beyond = 0;
  for (const r of json.data) {
    const a = Number(r[f.a]), e = Number(r[f.e]);
    const vals = [a, e, r[f.i], r[f.om], r[f.w], r[f.ma]].map(Number);
    if (!vals.every(Number.isFinite) || !(a > 0) || !(e < 1)) { skipped++; continue; }
    if (a >= A_MAX) { beyond++; continue; }
    const row = [sig(a), sig(e), sig(r[f.i]), sig(r[f.om]), sig(r[f.w]), sig(r[f.ma]), Number(Number(r[f.H]).toFixed(1))];
    const ep = Number(r[f.epoch]);
    if (ep !== commonEpoch) row.push(ep);
    names.push(shortName(r[f.full_name]));
    data.push(row);
  }
  const doc = {
    source: 'JPL SBDB Query API (https://ssd-api.jpl.nasa.gov/sbdb_query.api)',
    query: `sb-kind=a, H < ${H_MAX}, kept a < ${A_MAX} AU`,
    fetchedAt: new Date().toISOString(),
    count: data.length,
    epoch: commonEpoch,
    fields: ['a', 'e', 'i', 'om', 'w', 'ma', 'H'],
    names,
    data,
  };
  await mkdir(dirname(OUT), { recursive: true });
  // one record per line keeps diffs readable and the file compact
  const text = '{\n' + Object.entries(doc).map(([k, v]) => {
    if (k === 'data') return ` "data": [\n${v.map((row) => JSON.stringify(row)).join(',\n')}\n ]`;
    return ` ${JSON.stringify(k)}: ${JSON.stringify(v)}`;
  }).join(',\n') + '\n}\n';
  await writeFile(OUT, text);
  const size = (await stat(OUT)).size;
  console.log(`Wrote ${data.length} asteroids (a < ${A_MAX} AU) to src/data/belt.json (${(size / 1024).toFixed(0)} KB); ` +
    `${beyond} trans-Jovian objects left out, ${skipped} without a usable elliptic orbit. Common epoch JD ${commonEpoch}.`);
}

main().catch((err) => {
  console.error(err);
  process.exit(1);
});
