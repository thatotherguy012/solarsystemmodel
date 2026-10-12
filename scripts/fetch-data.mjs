// Fetch small-body and moon orbital data from JPL and bake it into src/data/*.json.
// Run: npm run fetch-data   (Node 22+, uses global fetch). Never used at runtime.
//
//   src/data/smallbodies.json  <- JPL SBDB API (osculating heliocentric elements + physical params)
//   src/data/moons.json        <- JPL Horizons API (osculating elements at J2000 relative to the parent)
//
// Requests are made sequentially, ~250 ms apart. Individual failures are logged and skipped (moons fall
// back to the physical table below); the script always writes whatever it obtained.
import { writeFile, mkdir } from 'node:fs/promises';
import { dirname, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';

const ROOT = resolve(dirname(fileURLToPath(import.meta.url)), '..');
const OUT_DIR = resolve(ROOT, 'src', 'data');
const DELAY_MS = 250;

const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

/** [sstr, display name] per category (DESIGN.md §3.1). */
const SMALL_BODIES = {
  dwarf: [
    ['Pluto', 'Pluto'], ['1', 'Ceres'], ['136199', 'Eris'], ['136108', 'Haumea'], ['136472', 'Makemake'],
    ['225088', 'Gonggong'], ['50000', 'Quaoar'], ['90377', 'Sedna'], ['90482', 'Orcus'],
  ],
  asteroid: [
    ['2', 'Pallas'], ['3', 'Juno'], ['4', 'Vesta'], ['5', 'Astraea'], ['6', 'Hebe'], ['7', 'Iris'], ['8', 'Flora'],
    ['9', 'Metis'], ['10', 'Hygiea'], ['15', 'Eunomia'], ['16', 'Psyche'], ['19', 'Fortuna'], ['21', 'Lutetia'],
    ['24', 'Themis'], ['29', 'Amphitrite'], ['31', 'Euphrosyne'], ['52', 'Europa'], ['65', 'Cybele'],
    ['87', 'Sylvia'], ['88', 'Thisbe'], ['107', 'Camilla'], ['121', 'Hermione'], ['216', 'Kleopatra'],
    ['243', 'Ida'], ['253', 'Mathilde'], ['324', 'Bamberga'], ['511', 'Davida'], ['532', 'Herculina'],
    ['704', 'Interamnia'], ['951', 'Gaspra'],
  ],
  trojan: [['588', 'Achilles'], ['624', 'Hektor'], ['617', 'Patroclus'], ['884', 'Priamus']],
  neo: [
    ['433', 'Eros'], ['1036', 'Ganymed'], ['1566', 'Icarus'], ['1862', 'Apollo'], ['1221', 'Amor'],
    ['3200', 'Phaethon'], ['3753', 'Cruithne'], ['4179', 'Toutatis'], ['25143', 'Itokawa'], ['65803', 'Didymos'],
    ['99942', 'Apophis'], ['101955', 'Bennu'], ['162173', 'Ryugu'], ['2062', 'Aten'],
  ],
  centaur: [['2060', 'Chiron'], ['10199', 'Chariklo'], ['944', 'Hidalgo'], ['5145', 'Pholus']],
  comet: [
    ['1P', 'Halley'], ['2P', 'Encke'], ['9P', 'Tempel 1'], ['67P', 'Churyumov-Gerasimenko'], ['81P', 'Wild 2'],
    ['103P', 'Hartley 2'], ['109P', 'Swift-Tuttle'], ['C/1995 O1', 'Hale-Bopp'], ['46P', 'Wirtanen'],
    ['55P', 'Tempel-Tuttle'], ['21P', 'Giacobini-Zinner'], ['19P', 'Borrelly'],
  ],
};

/** Moons: [Horizons id, name, parent Horizons center, parent app id] (DESIGN.md §3.2). */
const MOONS = [
  [401, 'Phobos', 499, 'mars'], [402, 'Deimos', 499, 'mars'],
  [501, 'Io', 599, 'jupiter'], [502, 'Europa', 599, 'jupiter'], [503, 'Ganymede', 599, 'jupiter'],
  [504, 'Callisto', 599, 'jupiter'], [505, 'Amalthea', 599, 'jupiter'], [506, 'Himalia', 599, 'jupiter'],
  [601, 'Mimas', 699, 'saturn'], [602, 'Enceladus', 699, 'saturn'], [603, 'Tethys', 699, 'saturn'],
  [604, 'Dione', 699, 'saturn'], [605, 'Rhea', 699, 'saturn'], [606, 'Titan', 699, 'saturn'],
  [607, 'Hyperion', 699, 'saturn'], [608, 'Iapetus', 699, 'saturn'], [609, 'Phoebe', 699, 'saturn'],
  [705, 'Miranda', 799, 'uranus'], [701, 'Ariel', 799, 'uranus'], [702, 'Umbriel', 799, 'uranus'],
  [703, 'Titania', 799, 'uranus'], [704, 'Oberon', 799, 'uranus'],
  [801, 'Triton', 899, 'neptune'], [802, 'Nereid', 899, 'neptune'], [808, 'Proteus', 899, 'neptune'],
  // Nix and Hydra orbit the Pluto-Charon barycenter (center code 9): Pluto-centric osculating elements
  // would be badly distorted by Charon (e ~0.2-0.37 instead of ~0.01), so they are fetched barycentric.
  [901, 'Charon', 999, 'pluto'], [902, 'Nix', 9, 'pluto'], [903, 'Hydra', 9, 'pluto'],
];

/** Fallback physical data for moons: name -> [radius km, GM km^3/s^2 | null] (DESIGN.md §3.4). */
const MOON_PHYS = {
  Phobos: [11.1, 0.0007], Deimos: [6.2, 0.0001], Io: [1821.6, 5959.9], Europa: [1560.8, 3202.7],
  Ganymede: [2634.1, 9887.8], Callisto: [2410.3, 7179.3], Amalthea: [83.5, null], Himalia: [85, null],
  Mimas: [198.2, 2.5], Enceladus: [252.1, 7.2], Tethys: [531.1, 41.2], Dione: [561.4, 73.1], Rhea: [763.8, 153.9],
  Titan: [2574.7, 8978.1], Hyperion: [135, null], Iapetus: [734.5, 120.5], Phoebe: [106.5, null],
  Miranda: [235.8, 4.4], Ariel: [578.9, 86.4], Umbriel: [584.7, 81.5], Titania: [788.4, 228.2], Oberon: [761.4, 192.4],
  Triton: [1353.4, 1427.6], Nereid: [170, null], Proteus: [210, null],
  Charon: [606, 105.9], Nix: [25, null], Hydra: [27, null],
};
/** Fallback physical data for small bodies that SBDB lacks. */
const SMALL_PHYS = { pluto: { radiusKm: 1188.3, gmKm3S2: 869.6 } };

/** "Tempel 1" -> "tempel-1" */
const slug = (s) => s.toLowerCase().replace(/[^a-z0-9]+/g, '-').replace(/^-+|-+$/g, '');

const num = (v) => {
  if (v === null || v === undefined || v === '') return null;
  const x = Number(v);
  return Number.isFinite(x) ? x : null;
};
const round = (x, digits) => (x === null ? null : Number(x.toPrecision(digits)));

async function fetchWithRetry(url, tries = 2) {
  let lastErr;
  for (let k = 0; k < tries; k++) {
    try {
      const res = await fetch(url, { headers: { 'User-Agent': 'solar-system-model/0.1 (fetch-data script)' } });
      if (!res.ok) throw new Error(`HTTP ${res.status}`);
      return await res.text();
    } catch (err) {
      lastErr = err;
      await sleep(1000);
    }
  }
  throw lastErr;
}

async function fetchSmallBody(sstr, name, category, usedIds) {
  const url = `https://ssd-api.jpl.nasa.gov/sbdb.api?sstr=${encodeURIComponent(sstr)}&phys-par=1&full-prec=1`;
  const json = JSON.parse(await fetchWithRetry(url));
  if (!json.orbit || !json.object) throw new Error(`unexpected response (${json.code || ''} ${json.message || 'no orbit'})`);
  const el = {};
  for (const e of json.orbit.elements) el[e.name] = num(e.value);
  const phys = {};
  for (const p of json.phys_par || []) phys[p.name] = p.value;

  let id = slug(name);
  if (usedIds.has(id)) id = slug(`${name} ${sstr}`); // e.g. asteroid 52 Europa vs. Jupiter's Europa
  const displayName = usedIds.has(slug(name)) ? `${name} (${sstr})` : name;
  usedIds.add(id);

  const H = num(phys.H) ?? num(phys.M2); // comets: nuclear magnitude as a proxy
  let albedo = num(phys.albedo);
  const diameter = num(phys.diameter);
  let radiusKm;
  if (diameter) radiusKm = diameter / 2;
  else if (H !== null) {
    const p = albedo ?? (category === 'comet' ? 0.04 : 0.10);
    radiusKm = (1329 / Math.sqrt(p)) * Math.pow(10, -H / 5) / 2;
  } else radiusKm = category === 'comet' ? 2 : 5;
  let gm = num(phys.GM);
  const fb = SMALL_PHYS[id];
  if (fb) {
    if (!diameter) radiusKm = fb.radiusKm;
    if (gm === null) gm = fb.gmKm3S2;
  }
  const periodDays = el.per ?? (el.n ? 360 / el.n : null);
  return {
    id,
    name: displayName,
    designation: json.object.fullname,
    category,
    orbitClass: json.object.orbit_class?.name ?? null,
    epochJd: num(json.orbit.epoch),
    elements: {
      a: el.a, e: el.e, iDeg: el.i, omDeg: el.om, wDeg: el.w, maDeg: el.ma,
      periodDays, q: el.q, tp: el.tp,
    },
    radiusKm: round(radiusKm, 5),
    gmKm3S2: gm,
    rotationHours: num(phys.rot_per),
    albedo,
    H,
  };
}

function horizonsUrl(id, center) {
  const p = {
    format: 'text', COMMAND: `'${id}'`, OBJ_DATA: "'YES'", MAKE_EPHEM: "'YES'", EPHEM_TYPE: "'ELEMENTS'",
    CENTER: `'500@${center}'`, START_TIME: "'2000-01-01 12:00'", STOP_TIME: "'2000-01-02'", STEP_SIZE: "'2d'",
    REF_PLANE: "'ECLIPTIC'", OUT_UNITS: "'KM-S'",
  };
  const qs = Object.entries(p).map(([k, v]) => `${k}=${encodeURIComponent(v)}`).join('&');
  return `https://ssd.jpl.nasa.gov/api/horizons.api?${qs}`;
}

async function fetchMoon([hid, name, center, parent]) {
  const text = await fetchWithRetry(horizonsUrl(hid, center));
  const soe = text.indexOf('$$SOE'), eoe = text.indexOf('$$EOE');
  if (soe < 0 || eoe < 0) throw new Error('no $$SOE block in Horizons response');
  const lines = text.slice(soe + 5, eoe).trim().split('\n');
  const epochJd = num(lines[0].trim().split(/\s+/)[0]); // "2451545.000000000 = A.D. 2000-Jan-01 12:00:00.0000 TDB"
  const vals = {};
  const re = /\b(EC|QR|IN|OM|W|Tp|N|MA|TA|A|AD|PR)\s*=\s*([-+0-9.E]+)/g;
  let m;
  const body = lines.slice(1).join('\n');
  while ((m = re.exec(body))) vals[m[1]] = Number(m[2]);
  for (const k of ['EC', 'IN', 'OM', 'W', 'N', 'MA', 'A']) {
    if (!Number.isFinite(vals[k])) throw new Error(`missing ${k} in Horizons elements`);
  }
  const header = text.slice(0, soe);
  // Radius: prefer "Mean radius (km) = x"; accept "Radius (km) = x" unless it is triaxial ("a x b x c").
  let radiusKm = null;
  const mr = header.match(/Mean radius \(km\)\s*=\s*([0-9.]+)/i);
  if (mr) radiusKm = Number(mr[1]);
  else {
    const r2 = header.match(/Radius \(km\)\s*=\s*([0-9.]+)(\s*x\s*[0-9.]+)?/i);
    if (r2 && !r2[2]) radiusKm = Number(r2[1]);
  }
  const gmMatch = header.match(/GM\s*\(km\^3\/s\^2\)\s*=\s*([0-9.]+(?:[eE][-+]?\d+)?)/);
  let gm = gmMatch ? Number(gmMatch[1]) : null;
  const fb = MOON_PHYS[name];
  if (!(radiusKm > 0)) radiusKm = fb ? fb[0] : 10;
  if (!(gm > 0)) gm = fb ? fb[1] : null;
  return {
    id: slug(name),
    name,
    parent,
    horizonsId: hid,
    epochJd: epochJd ?? 2451545.0,
    elements: {
      aKm: round(vals.A, 10), e: round(vals.EC, 8), iDeg: round(vals.IN, 8), omDeg: round(vals.OM, 8),
      wDeg: round(vals.W, 8), maDeg: round(vals.MA, 8), nDegPerDay: round(vals.N * 86400, 10),
    },
    radiusKm,
    gmKm3S2: gm,
  };
}

async function main() {
  await mkdir(OUT_DIR, { recursive: true });
  const failures = [];

  // Reserve ids used by natural bodies that are not small bodies so collisions get disambiguated.
  const usedIds = new Set(['sun', 'mercury', 'venus', 'earth', 'moon', 'mars', 'jupiter', 'saturn', 'uranus', 'neptune',
    ...MOONS.map((m) => slug(m[1]))]);

  console.log('--- Small bodies (JPL SBDB) ---');
  const small = [];
  for (const [category, list] of Object.entries(SMALL_BODIES)) {
    for (const [sstr, name] of list) {
      try {
        const rec = await fetchSmallBody(sstr, name, category, usedIds);
        small.push(rec);
        console.log(`ok   ${category.padEnd(8)} ${rec.id.padEnd(24)} a=${rec.elements.a?.toFixed(4)} e=${rec.elements.e?.toFixed(4)} R=${rec.radiusKm} km`);
      } catch (err) {
        failures.push(`${sstr} (${name}): ${err.message}`);
        console.log(`FAIL ${category.padEnd(8)} ${sstr} (${name}): ${err.message}`);
      }
      await sleep(DELAY_MS);
    }
  }

  console.log('--- Moons (JPL Horizons) ---');
  const moons = [];
  for (const def of MOONS) {
    try {
      const rec = await fetchMoon(def);
      moons.push(rec);
      console.log(`ok   ${rec.parent.padEnd(8)} ${rec.id.padEnd(10)} a=${rec.elements.aKm.toFixed(1)} km e=${rec.elements.e} R=${rec.radiusKm} km GM=${rec.gmKm3S2}`);
    } catch (err) {
      failures.push(`${def[0]} (${def[1]}): ${err.message}`);
      console.log(`FAIL ${def[0]} (${def[1]}): ${err.message}`);
    }
    await sleep(DELAY_MS);
  }

  const meta = { source: '', fetchedAt: new Date().toISOString() };
  await writeFile(resolve(OUT_DIR, 'smallbodies.json'), JSON.stringify({ ...meta, source: 'JPL SBDB API (https://ssd-api.jpl.nasa.gov/sbdb.api)', bodies: small }, null, 1) + '\n');
  await writeFile(resolve(OUT_DIR, 'moons.json'), JSON.stringify({ ...meta, source: 'JPL Horizons API (https://ssd.jpl.nasa.gov/api/horizons.api), osculating elements at J2000, ecliptic J2000 frame', moons }, null, 1) + '\n');
  console.log(`\nWrote ${small.length} small bodies and ${moons.length} moons to src/data/.`);
  if (failures.length) {
    console.log(`${failures.length} failure(s):\n  ${failures.join('\n  ')}`);
  }
}

main().catch((err) => {
  console.error(err);
  process.exit(1);
});
