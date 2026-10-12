// Validation of src/astro/maneuver.js (torch-ship rendezvous / intercept planning, with and without gravity).
// Run: node scripts/validate-maneuver.mjs
import { planetState, earthState, PLANET_ELEMENTS } from '../src/astro/planets.js';
import { solveRendezvous, solveIntercept, solveRendezvousForTime, planManeuver } from '../src/astro/maneuver.js';
import { soiRadius, cachePerturbers, makeAccel } from '../src/astro/nbody.js';
import { brachistochroneTime } from '../src/astro/lambert.js';
import { AU_KM, gmToAuDay, kmToAu, auDayToKmS, mS2ToAuDay2, G0_M_S2, DEG } from '../src/astro/constants.js';
import { vsub, vlen, vdist, vadd, vscale, vdot } from '../src/astro/vec3.js';

let failures = 0;
function check(name, ok, detail = '') {
  console.log(`${ok ? 'PASS' : 'FAIL'}  ${name}${detail ? '  ' + detail : ''}`);
  if (!ok) failures++;
}
const ms = () => performance.now();
const g = (x) => mS2ToAuDay2(x * G0_M_S2);
const kms = (v) => auDayToKmS(v).toFixed(2) + ' km/s';

const PHYS = {
  mercury: [2439.7, 22031.78], venus: [6051.8, 324858.6], emb: [6371.0, 403503.2], mars: [3389.5, 42828.37],
  jupiter: [69911, 126686534], saturn: [58232, 37931187], uranus: [25362, 5793939], neptune: [24622, 6836529],
};
const perturbers = Object.keys(PHYS).map((key) => {
  const gm = gmToAuDay(PHYS[key][1]);
  return { id: key === 'emb' ? 'earth' : key, gm, radiusAu: kmToAu(PHYS[key][0]), soiAu: soiRadius(PLANET_ELEMENTS[key].el[0], gm), state: (jd) => planetState(key, jd) };
});
const jd0 = 2461324.5;

console.log('--- Static target, ship at rest: must reproduce the classic brachistochrone ---');
{
  const P0 = [1, 0, 0], V0 = [0, 0, 0];
  const target = { r: [1.5, 0.3, 0.02], v: [0, 0, 0] };
  const a = g(0.3);
  const s = solveRendezvous(P0, V0, jd0, () => target, a);
  const D = vdist(P0, target.r), Tref = brachistochroneTime(D, a);
  check('converged', s.ok, `iter ${s.iterations}, residual ${s.residual.toExponential(2)}`);
  check('T equals 2*sqrt(D/a)', Math.abs(s.T - Tref) < 1e-8 * Tref, `T=${s.T.toFixed(6)} d vs ${Tref.toFixed(6)} d`);
  check('symmetric phases, opposite directions', Math.abs(s.t1 - s.t2) < 1e-8 && vdot(s.u1, s.u2) < -0.999999);
  const end = s.stateAt(s.arriveJd);
  check('arrives at rest on target', vdist(end.r, target.r) < 1e-9 && vlen(end.v) < 1e-9);
}

console.log('--- Earth -> Mars at 0.3 g with real body velocities ---');
{
  const e = earthState(jd0);
  const a = g(0.3);
  const t0 = ms();
  const s = solveRendezvous(e.r, e.v, jd0, (jd) => planetState('mars', jd), a);
  const dt = ms() - t0;
  check('converged', s.ok, `T=${s.T.toFixed(3)} d, iter ${s.iterations}, ${dt.toFixed(1)} ms`);
  const m = planetState('mars', s.arriveJd);
  const end = s.stateAt(s.arriveJd);
  check('matches Mars position and velocity', vdist(end.r, m.r) < 1e-8 && vdist(end.v, m.v) < 1e-9, `dr ${(vdist(end.r, m.r) * AU_KM).toFixed(3)} km, dv ${(auDayToKmS(vdist(end.v, m.v)) * 1000).toFixed(3)} m/s`);
  // compare with the straight-line estimate (ignores the ~8 km/s body velocity difference)
  let T = 7; for (let k = 0; k < 20; k++) { T = brachistochroneTime(vdist(planetState('mars', jd0 + T).r, e.r), a); }
  check('close to straight-line estimate', Math.abs(s.T - T) / T < 0.05, `two-phase ${s.T.toFixed(3)} d vs straight ${T.toFixed(3)} d, peak ${kms(s.peakSpeed)}, dv ${kms(s.deltaV)}`);
}

console.log('--- Mid-course retarget: ship at peak speed diverts to Venus ---');
{
  const e = earthState(jd0);
  const a = g(0.3);
  const leg = solveRendezvous(e.r, e.v, jd0, (jd) => planetState('mars', jd), a);
  const tMid = leg.flipJd; // at the flip, moving at peak speed
  const mid = leg.stateAt(tMid);
  const t0 = ms();
  const s = solveRendezvous(mid.r, mid.v, tMid, (jd) => planetState('venus', jd), a);
  const dt = ms() - t0;
  const v = planetState('venus', s.arriveJd);
  const end = s.stateAt(s.arriveJd);
  check('converged from a moving start', s.ok, `start speed ${kms(vlen(mid.v))}, new T=${s.T.toFixed(3)} d, iter ${s.iterations}, ${dt.toFixed(1)} ms`);
  check('rendezvous with Venus', vdist(end.r, v.r) < 1e-8 && vdist(end.v, v.v) < 1e-9);
  check('phase 1 kills most of the old velocity', vdot(s.u1, vsub(mid.v, v.v)) < 0, `u1.v = ${vdot(s.u1, vsub(mid.v, v.v)).toExponential(2)}`);
}

console.log('--- Intercept (no velocity match) ---');
{
  const e = earthState(jd0);
  const a = g(0.3);
  const s = solveIntercept(e.r, e.v, jd0, (jd) => planetState('mars', jd), a);
  const rdv = solveRendezvous(e.r, e.v, jd0, (jd) => planetState('mars', jd), a);
  const m = planetState('mars', s.arriveJd);
  check('converged', s.ok, `T=${s.T.toFixed(3)} d, closing ${kms(s.closingSpeed)}, iter ${s.iterations}`);
  check('reaches Mars position', vdist(s.stateAt(s.arriveJd).r, m.r) < 1e-8);
  check('faster than rendezvous', s.T < rdv.T, `${s.T.toFixed(2)} < ${rdv.T.toFixed(2)} d`);
}

console.log('--- Rendezvous for a prescribed arrival time ---');
{
  const e = earthState(jd0);
  const s = solveRendezvousForTime(e.r, e.v, jd0, (jd) => planetState('mars', jd), 12);
  check('finds acceleration for 12-day trip', s.ok && Math.abs(s.T - 12) < 1e-4, `a = ${(s.accel / g(1)).toFixed(4)} g, T=${s.T?.toFixed(5)} d`);
}

console.log('--- Gravity-refined planning ---');
{
  const e = earthState(jd0);
  const cached = cachePerturbers(perturbers, jd0, jd0 + 120, 1);
  const gravity = makeAccel(cached, { endpointIds: ['earth', 'mars'] });
  for (const gg of [0.3, 0.01]) {
    const a = g(gg);
    const t0 = ms();
    const p = planManeuver('rendezvous', e.r, e.v, jd0, (jd) => planetState('mars', jd), a, gravity);
    const dt = ms() - t0;
    const m = planetState('mars', p.arriveJd);
    const end = p.stateAt(p.arriveJd);
    check(`${gg} g rendezvous refined under gravity`, p.ok && p.gravityRefined, `T=${p.T.toFixed(3)} d (kinematic ${p.kinematic?.T.toFixed(3)}), iter ${p.iterations}, ${dt.toFixed(0)} ms, samples ${p.samples?.length}`);
    check(`${gg} g end state on Mars`, vdist(end.r, m.r) < 1e-7 && vdist(end.v, m.v) < 1e-8, `dr ${(vdist(end.r, m.r) * AU_KM).toFixed(2)} km, dv ${(auDayToKmS(vdist(end.v, m.v)) * 1000).toFixed(2)} m/s`);
  }
  const t0 = ms();
  const pi = planManeuver('intercept', e.r, e.v, jd0, (jd) => planetState('mars', jd), g(0.3), gravity);
  const dt = ms() - t0;
  check('intercept refined under gravity', pi.ok && pi.gravityRefined, `T=${pi.T.toFixed(3)} d, closing ${kms(pi.closingSpeed)}, ${dt.toFixed(0)} ms`);
  // low thrust: refinement should either converge or fail gracefully, never hang
  const t1 = ms();
  const low = planManeuver('rendezvous', e.r, e.v, jd0, (jd) => planetState('mars', jd), g(0.0005), gravity);
  const dt1 = ms() - t1;
  check('0.0005 g returns gracefully', dt1 < 20000 && typeof low.ok === 'boolean', `ok=${low.ok} gravityRefined=${low.gravityRefined} approximate=${low.approximate} T=${low.T?.toFixed(1)} d, ${dt1.toFixed(0)} ms`);
}

console.log('--- Chasing another ship (moving target with its own thrust profile) ---');
{
  const e = earthState(jd0);
  const a = g(0.3);
  const quarry = solveRendezvous(e.r, e.v, jd0, (jd) => planetState('mars', jd), a); // target ship bound for Mars
  const hunter0 = { r: vadd(e.r, [0.002, 0.001, 0]), v: e.v }; // hunter starts 300,000 km away
  const s = solveIntercept(hunter0.r, hunter0.v, jd0 + 0.5, (jd) => quarry.stateAt(jd), g(0.5));
  const q = quarry.stateAt(s.arriveJd);
  check('intercepts a thrusting ship', s.ok && vdist(s.stateAt(s.arriveJd).r, q.r) < 1e-8, `T=${(s.T * 24).toFixed(2)} h, closing ${kms(s.closingSpeed)}`);
}

console.log(failures === 0 ? '\nALL MANEUVER CHECKS PASSED' : `\n${failures} CHECK(S) FAILED`);
process.exit(failures ? 1 : 0);
