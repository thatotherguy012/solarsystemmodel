// Validation of the astro modules against JPL Horizons reference vectors (fetched 2026-10-11) and
// self-consistency checks for the Kepler / Lambert / universal-propagation code.
// Run: node scripts/validate-astro.mjs
import { planetState, earthState, moonGeocentric } from '../src/astro/planets.js';
import { elementsToState, stateToElements, periodDays, orbitPath } from '../src/astro/kepler.js';
import { lambert, propagateUniversal } from '../src/astro/lambert.js';
import { lagrangePoint } from '../src/astro/lagrange.js';
import { GM_SUN, AU_KM, auDayToKmS, gmToAuDay, DEG } from '../src/astro/constants.js';
import { civilToJd, jdToCivil, formatJd, parseDateToJd } from '../src/astro/time.js';
import { vsub, vlen, vdist } from '../src/astro/vec3.js';

let failures = 0;
function check(name, ok, detail = '') {
  console.log(`${ok ? 'PASS' : 'FAIL'}  ${name}${detail ? '  ' + detail : ''}`);
  if (!ok) failures++;
}

// ---- Horizons reference (heliocentric ecliptic J2000, AU, AU/day) ----
const JD1 = 2461324.5, JD2 = 2506000.5;
const REF = {
  earth: { [JD1]: [9.532077524921290E-01, 2.973601025864422E-01, -2.162156759955049E-05], [JD2]: [-6.751790016409424E-01, 7.179281022689594E-01, -2.242390649044257E-04] },
  mars: { [JD1]: [-7.227630149399285E-03, 1.570046147944983E+00, 3.307963746710238E-02], [JD2]: [-3.068468369920235E-01, 1.564123925914192E+00, 4.028593525872461E-02] },
  jupiter: { [JD1]: [-3.547863102982571E+00, 3.950543020955445E+00, 6.296808385066710E-02], [JD2]: [-3.075434353940683E+00, -4.422479629376350E+00, 8.735348930458478E-02] },
  neptune: { [JD1]: [2.983584144378461E+01, 1.411670323825096E+00, -7.166294753042702E-01], [JD2]: [-7.915360140443019E-02, -3.025244938954159E+01, 6.247531144948814E-01] },
};
const REF_V = {
  earth: { [JD1]: [-5.404979527976692E-03, 1.636589697030130E-02, -5.664805323428614E-07] },
  jupiter: { [JD1]: [-5.706888192296862E-03, -4.693858596463294E-03, 1.471952664182520E-04] },
};
const MOON_REF = { [JD1]: [-2.414704695650409E-03, -9.457470735988285E-04, -1.849407416625242E-04], [JD2]: [-5.260332958534525E-04, -2.576891724980260E-03, 1.619113364626110E-04] };

console.log('--- Planet positions vs Horizons (error in km and arcmin as seen from Sun) ---');
for (const key of Object.keys(REF)) {
  for (const jd of [JD1, JD2]) {
    const mine = key === 'earth' ? earthState(jd).r : planetState(key, jd).r;
    const ref = REF[key][jd];
    const errKm = vdist(mine, ref) * AU_KM;
    const angArcmin = Math.acos(Math.min(1, (mine[0] * ref[0] + mine[1] * ref[1] + mine[2] * ref[2]) / (vlen(mine) * vlen(ref)))) / DEG * 60;
    const tol = key === 'neptune' ? 20 : 10; // arcmin
    check(`${key} @ JD ${jd}`, angArcmin < tol, `err ${errKm.toFixed(0)} km, ${angArcmin.toFixed(2)} arcmin`);
  }
}
for (const key of Object.keys(REF_V)) {
  const mine = key === 'earth' ? earthState(JD1).v : planetState(key, JD1).v;
  const ref = REF_V[key][JD1];
  const errKmS = vdist(mine, ref) * AU_KM / 86400;
  check(`${key} velocity @ JD1`, errKmS < 0.05, `err ${errKmS.toFixed(4)} km/s (|v|=${auDayToKmS(vlen(mine)).toFixed(3)} km/s)`);
}

console.log('--- Moon geocentric vs Horizons ---');
for (const jd of [JD1, JD2]) {
  const mine = moonGeocentric(jd).r;
  const ref = MOON_REF[jd];
  const errKm = vdist(mine, ref) * AU_KM;
  const ang = Math.acos(Math.min(1, (mine[0] * ref[0] + mine[1] * ref[1] + mine[2] * ref[2]) / (vlen(mine) * vlen(ref)))) / DEG;
  check(`moon @ JD ${jd}`, ang < 0.1, `err ${errKm.toFixed(0)} km, ${ang.toFixed(4)} deg, dist mine ${(vlen(mine) * AU_KM).toFixed(0)} ref ${(vlen(ref) * AU_KM).toFixed(0)} km`);
}

console.log('--- Kepler: elements -> state -> elements round trip ---');
{
  const el = { a: 2.77, e: 0.0797, i: 10.59 * DEG, om: 80.25 * DEG, w: 73.29 * DEG, M: 274.4 * DEG, epoch: 2461200.5 };
  const st = elementsToState(el, GM_SUN, el.epoch + 123.4);
  const back = stateToElements(st.r, st.v, GM_SUN, el.epoch + 123.4);
  const fwd = elementsToState(back, GM_SUN, el.epoch + 123.4);
  check('round trip a', Math.abs(back.a - el.a) < 1e-9, `a=${back.a}`);
  check('round trip e', Math.abs(back.e - el.e) < 1e-9);
  check('round trip i/om/w', Math.abs(back.i - el.i) < 1e-9 && Math.abs(back.om - el.om) < 1e-9 && Math.abs(back.w - el.w) < 1e-9);
  check('round trip position', vdist(fwd.r, st.r) < 1e-10);
  check('period Ceres ~1680 d', Math.abs(periodDays(el.a, GM_SUN) - 1680) < 5, `${periodDays(el.a, GM_SUN).toFixed(1)} d`);
  // hyperbolic
  const hel = { a: -1.3, e: 1.2, i: 5 * DEG, om: 10 * DEG, w: 20 * DEG, M: 0.3, epoch: 2451545 };
  const hs = elementsToState(hel, GM_SUN, 2451545 + 50);
  const hb = stateToElements(hs.r, hs.v, GM_SUN, 2451545 + 50);
  check('hyperbolic round trip', Math.abs(hb.a - hel.a) < 1e-9 && Math.abs(hb.e - hel.e) < 1e-9, `a=${hb.a} e=${hb.e}`);
  check('orbitPath closed ellipse', orbitPath(el, GM_SUN, 64).length === 65);
}

console.log('--- Universal propagation vs Kepler ---');
{
  const el = { a: 1.5237, e: 0.0934, i: 1.85 * DEG, om: 49.7 * DEG, w: 286.5 * DEG, M: 1.0, epoch: 2451545 };
  const s0 = elementsToState(el, GM_SUN, el.epoch);
  for (const dt of [10, 300, -200, 2000]) {
    const sK = elementsToState(el, GM_SUN, el.epoch + dt);
    const sU = propagateUniversal(s0.r, s0.v, dt, GM_SUN);
    check(`propagate dt=${dt}`, vdist(sK.r, sU.r) < 1e-9 && vdist(sK.v, sU.v) < 1e-11, `dr=${vdist(sK.r, sU.r).toExponential(2)}`);
  }
  // hyperbolic propagation
  const hel = { a: -2.0, e: 1.5, i: 0.1, om: 0.2, w: 0.3, M: -0.5, epoch: 2451545 };
  const h0 = elementsToState(hel, GM_SUN, hel.epoch);
  const hK = elementsToState(hel, GM_SUN, hel.epoch + 400);
  const hU = propagateUniversal(h0.r, h0.v, 400, GM_SUN);
  check('hyperbolic propagate', vdist(hK.r, hU.r) < 1e-9, `dr=${vdist(hK.r, hU.r).toExponential(2)}`);
}

console.log('--- Lambert: Hohmann-like Earth->Mars ---');
{
  const r1 = [1, 0, 0], r2n = 1.5237;
  const aT = (1 + r2n) / 2;
  const tof = Math.PI * Math.sqrt(aT ** 3 / GM_SUN); // half period of transfer ellipse
  const ang = 179.5 * DEG; // near 180 deg
  const r2 = [r2n * Math.cos(ang), r2n * Math.sin(ang), 0];
  const sol = lambert(r1, r2, tof, GM_SUN, true);
  const v1 = auDayToKmS(vlen(sol.v1));
  const vcirc = auDayToKmS(Math.sqrt(GM_SUN / 1));
  check('lambert converged', sol.ok, `iter=${sol.iterations}`);
  check('lambert v1 ~ 32.7 km/s', Math.abs(v1 - 32.73) < 0.3, `v1=${v1.toFixed(3)} km/s, vcirc=${vcirc.toFixed(3)}, a=${sol.a.toFixed(4)} AU`);
  check('lambert prograde (h_z>0)', (r1[0] * sol.v1[1] - r1[1] * sol.v1[0]) > 0);
  // propagate and verify we reach r2 at tof
  const end = propagateUniversal(r1, sol.v1, tof, GM_SUN);
  check('lambert arc reaches r2', vdist(end.r, r2) < 1e-6, `miss=${(vdist(end.r, r2) * AU_KM).toFixed(1)} km`);
  check('lambert v2 matches propagation', vdist(end.v, sol.v2) < 1e-9);
  // fast (hyperbolic) transfer: 60 days
  const r2b = [0, r2n, 0];
  const fast = lambert(r1, r2b, 60, GM_SUN, true);
  const endb = propagateUniversal(r1, fast.v1, 60, GM_SUN);
  check('lambert fast transfer', fast.ok && vdist(endb.r, r2b) < 1e-6, `v1=${auDayToKmS(vlen(fast.v1)).toFixed(2)} km/s a=${fast.a.toFixed(3)} miss=${(vdist(endb.r, r2b) * AU_KM).toFixed(1)} km`);
  // real geometry: Earth->Jupiter 2.5 yr
  const e0 = earthState(JD1).r, j1 = planetState('jupiter', JD1 + 913).r;
  const sj = lambert(e0, j1, 913, GM_SUN, true);
  const ej = propagateUniversal(e0, sj.v1, 913, GM_SUN);
  check('lambert Earth->Jupiter', sj.ok && vdist(ej.r, j1) < 1e-6, `vinf_dep~${(auDayToKmS(vlen(vsub(sj.v1, earthState(JD1).v)))).toFixed(2)} km/s`);
}

console.log('--- Lagrange points ---');
{
  const gmE = gmToAuDay(398600.4418), gmS = GM_SUN;
  const rS = [0, 0, 0], rE = [1, 0, 0];
  const l1 = lagrangePoint(rS, gmS, rE, gmE, 'L1');
  const l2 = lagrangePoint(rS, gmS, rE, gmE, 'L2');
  const l3 = lagrangePoint(rS, gmS, rE, gmE, 'L3');
  const l4 = lagrangePoint(rS, gmS, rE, gmE, 'L4');
  check('L1 ~1.49e6 km sunward', Math.abs((1 - l1[0]) * AU_KM - 1.4911e6) < 2e4, `${((1 - l1[0]) * AU_KM).toExponential(4)} km`);
  check('L2 ~1.50e6 km anti-sun', Math.abs((l2[0] - 1) * AU_KM - 1.5017e6) < 2e4, `${((l2[0] - 1) * AU_KM).toExponential(4)} km`);
  check('L3 ~ -1 AU', Math.abs(l3[0] + 1) < 1e-3 && Math.abs(l3[1]) < 1e-9, `${l3[0]}`);
  check('L4 leads by 60 deg', Math.abs(l4[0] - 0.5) < 1e-9 && Math.abs(l4[1] - Math.sqrt(3) / 2) < 1e-9);
}

console.log('--- Time ---');
{
  check('J2000 civil', civilToJd(2000, 1, 1, 12) === 2451545.0);
  const c = jdToCivil(2461324.5);
  check('jdToCivil 2026-10-11', c.year === 2026 && c.month === 10 && c.day === 11 && c.hour === 0, JSON.stringify(c));
  check('parse/format', formatJd(parseDateToJd('2187-03-14 06:42')) === '2187-03-14 06:42 UTC', formatJd(parseDateToJd('2187-03-14 06:42')));
  check('year 12000', jdToCivil(civilToJd(12000, 7, 4, 1, 2, 3)).year === 12000);
}

console.log(failures === 0 ? '\nALL CHECKS PASSED' : `\n${failures} CHECK(S) FAILED`);
process.exit(failures ? 1 : 0);
