// Validation of src/sim/porkchop.js (launch-window porkchop grids, window detection, torch-ship curves).
// Run: node scripts/validate-porkchop.mjs
import { buildCatalog } from '../src/data/catalog.js';
import { initEphemeris } from '../src/sim/ephemeris.js';
import { createContext } from '../src/sim/custom.js';
import { civilToJd, formatJd } from '../src/astro/time.js';
import { mS2ToAuDay2, G0_M_S2, auDayToKmS } from '../src/astro/constants.js';
import {
  computePorkchopSync, metricGrid, gridMinimum, burnsFor, findWindows, synodicPeriod, transferCost, refineMinimum,
  porkchopBox, porkchopStep, torchTrip, torchSampleDates, cellDetails, PORKCHOP_DEFAULTS,
} from '../src/sim/porkchop.js';

initEphemeris(buildCatalog());
const ctx = createContext([]);
let failures = 0;
function check(name, ok, detail = '') {
  console.log(`${ok ? 'PASS' : 'FAIL'}  ${name}${detail ? '  ' + detail : ''}`);
  if (!ok) failures++;
}
const day = (jd) => formatJd(jd, { time: false });

console.log('--- Synodic periods ---');
{
  const jd = civilToJd(2027, 1, 1);
  const sEM = synodicPeriod('earth', 'mars', ctx, jd), sEJ = synodicPeriod('earth', 'jupiter', ctx, jd);
  check('Earth–Mars synodic period ~780 d', Math.abs(sEM - 780) < 30, `${sEM.toFixed(0)} d`);
  check('Earth–Jupiter synodic period ~399 d', Math.abs(sEJ - 399) < 15, `${sEJ.toFixed(0)} d`);
  check('Earth–Moon synodic period undefined (same heliocentric orbit)', !Number.isFinite(synodicPeriod('earth', 'moon', ctx, jd)));
}

console.log('--- Earth -> Mars porkchop, departures 2027-01-01 + 3 years, 60-600 d ---');
let res, burns;
{
  const p = { ...PORKCHOP_DEFAULTS, t0: civilToJd(2027, 1, 1), spanDays: 1095.75 };
  res = computePorkchopSync(p, 'earth', 'mars', ctx);
  const cells = res.nx * res.ny;
  let blank = 0;
  for (let k = 0; k < cells; k++) if (!Number.isFinite(res.vinfDep[k])) blank++;
  console.log(`      ${cells} cells in ${res.ms.toFixed(0)} ms (${(1000 * res.ms / cells).toFixed(1)} µs/cell), ${blank} blank`);
  check('most cells have a Lambert solution', blank < 0.15 * cells, `${blank} blank`);
  burns = burnsFor('earth', 'mars', null, null, ctx);
  check('default parking orbits 300 km at Earth and Mars', burns.dep.g.parkAltKm === 300 && burns.arr.g.parkAltKm === 300);
  const total = metricGrid(res, 'total', burns);
  const m = gridMinimum(total, res.ny);
  const d = cellDetails(res, m.i, m.j, burns);
  console.log(`      grid best: ${day(d.depJd)}, ${d.tof.toFixed(0)} d, total ${d.total.toFixed(2)} km/s (v∞ ${d.vinfDep.toFixed(2)} / ${d.vinfArr.toFixed(2)})`);
  check('minimum total Δv 5.5–6.5 km/s (LEO 300 km -> 300 km Mars orbit)', d.total > 5.5 && d.total < 6.5, `${d.total.toFixed(2)} km/s`);
  check('minimum near the late-2028 window (2028-09 .. 2029-02)', d.depJd > civilToJd(2028, 9, 1) && d.depJd < civilToJd(2029, 2, 1), day(d.depJd));
  const cost = transferCost('earth', 'mars', ctx, burns, 'total');
  const st = porkchopStep(res);
  const r = refineMinimum(cost, d.depJd, d.tof, { ...st, box: porkchopBox(res) });
  console.log(`      refined: ${day(r.t)}, ${r.T.toFixed(1)} d, ${r.value.toFixed(3)} km/s (${r.evals} evaluations)`);
  check('refinement does not increase the cost', r.value <= d.total + 1e-9);
  // two-lobe structure: in the best departure column, the cheapest short (type I) and long (type II) transfers are
  // separated by a costlier band (the 180-degree ridge)
  const col = [];
  for (let j = 0; j < res.ny; j++) col.push({ T: res.tof[j], v: total[m.i * res.ny + j] });
  const lobes = [];
  for (let j = 1; j < col.length - 1; j++) {
    const v = col[j].v;
    if (Number.isFinite(v) && !(col[j - 1].v < v) && !(col[j + 1].v < v)) lobes.push(col[j]);
  }
  console.log(`      local minima along flight time in the best column: ${lobes.map((x) => `${x.T.toFixed(0)} d ${x.v.toFixed(2)} km/s`).join(', ')}`);
  // windows
  const syn = synodicPeriod('earth', 'mars', ctx, res.dep[0]);
  const wins = findWindows(total, res, syn);
  console.log(`      windows: ${wins.map((w) => `${day(res.dep[w.i])} ${res.tof[w.j].toFixed(0)} d ${w.value.toFixed(2)} km/s${w.edge ? ` (${w.edge} edge)` : ''}`).join(' | ')}`);
  const interior = wins.filter((w) => !w.edge);
  check('one interior window in a 3-year span (synodic 26 months)', interior.length === 1, `${interior.length}`);
  // blank ridge exists somewhere (transfer angle ~180 deg)
  let ridge = 0;
  for (let k = 0; k < res.vinfDep.length; k++) if (!Number.isFinite(res.vinfDep[k])) ridge++;
  check('some cells blank near 180-degree transfers', ridge > 0, `${ridge}`);
}

console.log('--- Earth -> Jupiter windows over 3 years ---');
{
  const p = { ...PORKCHOP_DEFAULTS, t0: civilToJd(2027, 1, 1), spanDays: 1095.75, tofMin: 400, tofMax: 1400 };
  const rj = computePorkchopSync(p, 'earth', 'jupiter', ctx);
  const bj = burnsFor('earth', 'jupiter', null, null, ctx);
  const total = metricGrid(rj, 'total', bj);
  const wins = findWindows(total, rj, synodicPeriod('earth', 'jupiter', ctx, rj.dep[0]));
  console.log(`      windows: ${wins.map((w) => `${day(rj.dep[w.i])} ${rj.tof[w.j].toFixed(0)} d ${w.value.toFixed(2)} km/s${w.edge ? ` (${w.edge} edge)` : ''}`).join(' | ')}`);
  const interior = wins.filter((w) => !w.edge);
  check('2-3 Earth–Jupiter windows in 3 years (synodic ~13 months)', interior.length >= 2 && interior.length <= 3, `${interior.length}`);
  const gaps = interior.slice(1).map((w, k) => rj.dep[w.i] - rj.dep[interior[k].i]);
  check('windows ~1 synodic period apart', gaps.every((g) => Math.abs(g - 399) < 60), gaps.map((g) => g.toFixed(0)).join(', '));
}

console.log('--- Torch ship Earth -> Mars, 0.3 g rendezvous, every 10 d across 2 years ---');
{
  const a = mS2ToAuDay2(0.3 * G0_M_S2);
  const dates = torchSampleDates(civilToJd(2027, 1, 1), 730.5, 10);
  const t = performance.now();
  const trips = dates.map((jd) => torchTrip('earth', 'mars', ctx, jd, a, 'rendezvous'));
  const ms = performance.now() - t;
  const ok = trips.filter(Boolean);
  const Ts = ok.map((x) => x.T);
  const lo = Math.min(...Ts), hi = Math.max(...Ts);
  console.log(`      ${trips.length} solves in ${ms.toFixed(0)} ms (${(ms / trips.length).toFixed(2)} ms each); trip ${lo.toFixed(2)}–${hi.toFixed(2)} d, peak ${auDayToKmS(Math.max(...ok.map((x) => x.peakSpeed))).toFixed(0)} km/s`);
  check('all rendezvous solves converge', ok.length === trips.length, `${ok.length}/${trips.length}`);
  // straight-line flip-and-burn estimate 2*sqrt(D/a): 0.5 AU (opposition) -> 3.7 d, 2.5 AU (conjunction) -> 8.3 d
  check('0.3 g trip time between ~3.5 and ~9 days', lo > 3.5 && hi < 9, `${lo.toFixed(2)}–${hi.toFixed(2)} d`);
  check('0.3 g trip time varies by only a few days across the span', hi - lo < 4, `${(hi - lo).toFixed(2)} d`);
  const it = torchTrip('earth', 'mars', ctx, dates[0], a, 'intercept');
  check('intercept is faster than rendezvous', it && it.T < trips[0].T, it ? `${it.T.toFixed(2)} d vs ${trips[0].T.toFixed(2)} d` : 'failed');
}

console.log(failures ? `\n${failures} PORKCHOP CHECK(S) FAILED` : '\nALL PORKCHOP CHECKS PASSED');
process.exit(failures ? 1 : 0);
