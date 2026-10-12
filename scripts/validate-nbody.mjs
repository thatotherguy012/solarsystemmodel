// Validation of src/astro/nbody.js: integrator accuracy, perturber cache, targeting, flyby and delta-v helpers,
// brachistochrone gravity audit. Run: node scripts/validate-nbody.mjs
import { planetState, earthState, PLANET_ELEMENTS } from '../src/astro/planets.js';
import { elementsToState, stateToElements } from '../src/astro/kepler.js';
import { lambert, propagateUniversal, brachistochroneAccel } from '../src/astro/lambert.js';
import {
  soiRadius, cachePerturbers, makeAccel, integrate, interpolateSamples, targetTransfer,
  flybyAnalysis, parkingOrbitDeltaV, brachistochroneGravityAudit,
} from '../src/astro/nbody.js';
import { GM_SUN, AU_KM, DEG, gmToAuDay, kmToAu, auDayToKmS, kmSToAuDay, mS2ToAuDay2, auDay2ToMS2, G0_M_S2 } from '../src/astro/constants.js';
import { vsub, vlen, vdist, vadd, vscale } from '../src/astro/vec3.js';

let failures = 0;
function check(name, ok, detail = '') {
  console.log(`${ok ? 'PASS' : 'FAIL'}  ${name}${detail ? '  ' + detail : ''}`);
  if (!ok) failures++;
}
const ms = () => performance.now();

// ---- Perturber set from the planetary ephemeris ----
const PHYS = {
  mercury: [2439.7, 22031.78], venus: [6051.8, 324858.6], emb: [6371.0, 398600.4418 + 4902.8], mars: [3389.5, 42828.37],
  jupiter: [69911, 126686534], saturn: [58232, 37931187], uranus: [25362, 5793939], neptune: [24622, 6836529],
};
const perturbers = Object.keys(PHYS).map((key) => {
  const gm = gmToAuDay(PHYS[key][1]);
  return { id: key === 'emb' ? 'earth' : key, gm, radiusAu: kmToAu(PHYS[key][0]), soiAu: soiRadius(PLANET_ELEMENTS[key].el[0], gm), state: (jd) => planetState(key, jd) };
});

console.log('--- Integrator: Sun only vs Kepler ---');
{
  const el = { a: 1.3, e: 0.2, i: 3 * DEG, om: 1, w: 2, M: 0.5, epoch: 2461324.5 };
  const s0 = elementsToState(el, GM_SUN, el.epoch);
  const accel = makeAccel([]);
  const t0 = ms();
  const res = integrate(accel, s0.r, s0.v, el.epoch, el.epoch + 500);
  const dt = ms() - t0;
  const ref = propagateUniversal(s0.r, s0.v, 500, GM_SUN);
  check('500-day two-body integration', vdist(res.r, ref.r) < 1e-8, `err ${(vdist(res.r, ref.r) * AU_KM).toFixed(3)} km, ${res.steps} steps (${res.rejected} rejected), ${dt.toFixed(1)} ms`);
  const mid = interpolateSamples(res.samples, el.epoch + 123.456);
  const refMid = propagateUniversal(s0.r, s0.v, 123.456, GM_SUN);
  check('Hermite interpolation of samples', vdist(mid.r, refMid.r) < 1e-8 && vdist(mid.v, refMid.v) < 1e-7, `err ${(vdist(mid.r, refMid.r) * AU_KM).toFixed(3)} km, ${(auDayToKmS(vdist(mid.v, refMid.v)) * 1000).toFixed(4)} m/s`);
}

console.log('--- Perturber cache ---');
{
  const cached = cachePerturbers(perturbers, 2461324.5, 2461324.5 + 400, 1);
  let worstR = 0, worstV = 0;
  for (let k = 0; k < 50; k++) {
    const jd = 2461324.5 + Math.random() * 400;
    for (let i = 0; i < perturbers.length; i++) {
      const a = perturbers[i].state(jd), b = cached[i].state(jd);
      worstR = Math.max(worstR, vdist(a.r, b.r));
      worstV = Math.max(worstV, vdist(a.v, b.v));
    }
  }
  check('cache position vs direct ephemeris', worstR < 1e-8, `worst ${(worstR * AU_KM).toFixed(3)} km (velocity worst ${(auDayToKmS(worstV) * 1000).toFixed(3)} m/s, unused by the integrator)`);
}

console.log('--- Targeting: Sun only (should converge immediately) ---');
{
  const jd0 = 2461324.5, jd1 = jd0 + 260;
  const r0 = earthState(jd0).r, r1 = planetState('mars', jd1).r;
  const lam = lambert(r0, r1, 260, GM_SUN, true);
  const accel = makeAccel([]);
  const tgt = targetTransfer(accel, r0, jd0, r1, jd1, lam.v1);
  check('sun-only targeting', tgt.ok && tgt.iterations <= 1, `miss ${(tgt.missAu * AU_KM).toFixed(2)} km after ${tgt.iterations} iter`);
}

console.log('--- Targeting: Earth -> Mars with all planets ---');
{
  const jd0 = 2461324.5, jd1 = jd0 + 260;
  const r0 = earthState(jd0).r, r1 = planetState('mars', jd1).r;
  const lam = lambert(r0, r1, 260, GM_SUN, true);
  const cached = cachePerturbers(perturbers, jd0, jd1, 1);
  const accel = makeAccel(cached, { endpointIds: ['earth', 'mars'] });
  const t0 = ms();
  const tgt = targetTransfer(accel, r0, jd0, r1, jd1, lam.v1, { track: cached, endpointIds: ['earth', 'mars'] });
  const dt = ms() - t0;
  const dv = auDayToKmS(vdist(tgt.v0, lam.v1)) * 1000;
  check('targeting converges', tgt.ok, `miss ${(tgt.missAu * AU_KM).toFixed(2)} km, ${tgt.iterations} iter, ${tgt.steps} steps, ${dt.toFixed(0)} ms`);
  check('correction vs two-body is small', dv < 200, `|v0 - vLambert| = ${dv.toFixed(2)} m/s`);
  const ca = Object.entries(tgt.closest).sort((a, b) => a[1].distAu - b[1].distAu).slice(0, 3).map(([id, c]) => `${id} ${(c.distAu * AU_KM / 1e6).toFixed(2)} Mkm`).join(', ');
  console.log('      closest approaches:', ca, '| impacts:', tgt.impacts.length);
  check('no impacts', tgt.impacts.length === 0);
}

console.log('--- Targeting: Earth -> Jupiter -> Saturn with flyby analysis ---');
{
  const jd0 = 2461324.5, jdJ = jd0 + 2.6 * 365.25, jdS = jdJ + 3.2 * 365.25;
  const r0 = earthState(jd0).r, rJ = planetState('jupiter', jdJ).r, rS = planetState('saturn', jdS).r;
  const cached = cachePerturbers(perturbers, jd0, jdS, 1);
  const lam1 = lambert(r0, rJ, jdJ - jd0, GM_SUN, true);
  const lam2 = lambert(rJ, rS, jdS - jdJ, GM_SUN, true);
  const t0 = ms();
  const leg1 = targetTransfer(makeAccel(cached, { endpointIds: ['earth', 'jupiter'] }), r0, jd0, rJ, jdJ, lam1.v1, { track: cached, endpointIds: ['earth', 'jupiter'] });
  const leg2 = targetTransfer(makeAccel(cached, { endpointIds: ['jupiter', 'saturn'] }), rJ, jdJ, rS, jdS, lam2.v1, { track: cached, endpointIds: ['jupiter', 'saturn'] });
  const dt = ms() - t0;
  check('leg 1 Earth->Jupiter converges', leg1.ok, `miss ${(leg1.missAu * AU_KM).toFixed(1)} km, ${leg1.iterations} iter, ${leg1.steps} steps`);
  check('leg 2 Jupiter->Saturn converges', leg2.ok, `miss ${(leg2.missAu * AU_KM).toFixed(1)} km, ${leg2.iterations} iter, ${leg2.steps} steps, total ${dt.toFixed(0)} ms`);
  const jup = planetState('jupiter', jdJ);
  const fb = flybyAnalysis(leg1.vEnd, leg2.v0, jup.v, perturbers.find((p) => p.id === 'jupiter').gm, kmToAu(69911));
  console.log(`      flyby: vinf in ${auDayToKmS(fb.vInfInAuDay).toFixed(2)} km/s, out ${auDayToKmS(fb.vInfOutAuDay).toFixed(2)} km/s, turn ${(fb.turnAngleRad / DEG).toFixed(1)} deg, rp ${(fb.rpRequiredAu * AU_KM).toExponential(3)} km, unpowered feasible: ${fb.feasibleUnpowered}`);
  check('flyby analysis finite', isFinite(fb.turnAngleRad) && isFinite(fb.rpRequiredAu));
}

console.log('--- Flyby and parking-orbit formulas ---');
{
  const gmJ = gmToAuDay(126686534);
  const v = kmSToAuDay(10);
  const fb = flybyAnalysis([v, 0, 0], [0, v, 0], [0, 0, 0], gmJ, kmToAu(69911));
  const rpKm = fb.rpRequiredAu * AU_KM;
  check('90-deg turn at 10 km/s needs rp ~ 524,700 km', Math.abs(rpKm - 524700) < 2000, `${rpKm.toFixed(0)} km`);
  check('mismatch zero, feasible', fb.speedMismatchAuDay < 1e-12 && fb.feasibleUnpowered);
  const dv = auDayToKmS(parkingOrbitDeltaV(kmSToAuDay(2.94), gmToAuDay(398600.4418), kmToAu(6678)));
  check('LEO departure dv for vinf 2.94 km/s ~ 3.59 km/s', Math.abs(dv - 3.589) < 0.01, `${dv.toFixed(3)} km/s`);
  const dvCap = auDayToKmS(parkingOrbitDeltaV(0, gmToAuDay(398600.4418), kmToAu(6678)));
  check('vinf 0 capture into LEO = escape - circular ~ 3.20 km/s', Math.abs(dvCap - 3.200) < 0.01, `${dvCap.toFixed(3)} km/s`);
}

console.log('--- Brachistochrone gravity audit ---');
{
  const jd0 = 2461324.5;
  const r0 = earthState(jd0).r;
  const cached = cachePerturbers(perturbers, jd0, jd0 + 400, 1);
  const accel = makeAccel(cached, { endpointIds: ['earth', 'mars'] });
  for (const [g, Tguess] of [[0.3, 7], [0.01, 40], [0.0005, 180]]) {
    const a = mS2ToAuDay2(g * G0_M_S2);
    // solve arrival iteratively (same scheme as the app)
    let T = Tguess;
    for (let k = 0; k < 15; k++) { const D = vdist(planetState('mars', jd0 + T).r, r0); T = 2 * Math.sqrt(D / a); }
    const P1 = planetState('mars', jd0 + T).r;
    const audit = brachistochroneGravityAudit(r0, P1, jd0, T, a, accel);
    console.log(`      ${g} g: T=${T.toFixed(2)} d, maxRatio ${audit.maxRatio.toFixed(4)}, gravity loss ${(audit.gravityLossFraction * 100).toFixed(3)} %, holdsLine ${audit.holdsLine}, peak ${(auDay2ToMS2(audit.peakRequired) / G0_M_S2).toFixed(5)} g`);
    if (g === 0.3) check('0.3 g holds the line with <1% loss', audit.holdsLine && Math.abs(audit.gravityLossFraction) < 0.01);
    if (g === 0.0005) check('0.0005 g cannot hold the line', !audit.holdsLine && audit.maxRatio > 1.5);
  }
}

console.log('--- Interior softening (no singularity inside a body) ---');
{
  const jd0 = 2461324.5;
  const cached = cachePerturbers(perturbers, jd0, jd0 + 2, 1);
  const accel = makeAccel(cached);
  const jup = planetState('jupiter', jd0).r;
  const a = accel(vadd(jup, [kmToAu(1000), 0, 0]), jd0);
  check('finite acceleration 1000 km from Jupiter centre', a.every(isFinite) && vlen(a) < 1, `|a| = ${vlen(a).toExponential(3)} AU/day^2`);
}

console.log(failures === 0 ? '\nALL NBODY CHECKS PASSED' : `\n${failures} CHECK(S) FAILED`);
process.exit(failures ? 1 : 0);
