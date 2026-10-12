// N-body cruise propagation with patched-conic endpoints, trajectory targeting, flyby analysis,
// parking-orbit delta-v, and gravity accounting for constant-thrust (brachistochrone) legs.
// Units: AU, days, AU/day, AU^3/day^2. Frame: heliocentric ecliptic J2000.
//
// Perturber interface: { id, gm, radiusAu, soiAu, state(jd) -> { r, v } }  (heliocentric).
import { GM_SUN } from './constants.js';
import { vsub, vadd, vscale, vlen, vdot, vnorm } from './vec3.js';
import { brachistochroneFraction } from './lambert.js';

/** Sphere-of-influence radius for a body of GM `gmBody` orbiting at distance `aAu` from a primary of `gmCentral`. */
export function soiRadius(aAu, gmBody, gmCentral = GM_SUN) {
  return aAu * Math.pow(gmBody / gmCentral, 0.4);
}

function smoothstep(e0, e1, x) {
  const t = Math.min(1, Math.max(0, (x - e0) / (e1 - e0)));
  return t * t * (3 - 2 * t);
}

/**
 * Pre-tabulate perturber states over [jd0, jd1] (cubic Hermite interpolation, step `dt` days).
 * Returns new perturber objects whose state(jd) is cheap. Error with dt = 1 day is ~1e-10 AU for planets.
 */
export function cachePerturbers(perturbers, jd0, jd1, dtMax = 1, centralGm = GM_SUN) {
  return perturbers.map((p) => {
    // Step size scaled to the body's orbital period (Mercury needs ~0.4 d, outer planets 1 d).
    const s0 = p.state(Math.min(jd0, jd1));
    const rn = vlen(s0.r), v2 = vdot(s0.v, s0.v);
    const aOrb = 1 / Math.max(1e-9, 2 / rn - v2 / centralGm);
    const period = 2 * Math.PI * Math.sqrt(Math.abs(aOrb * aOrb * aOrb) / centralGm);
    const dt = Math.min(dtMax, Math.max(0.25, period / 200));
    const lo = Math.min(jd0, jd1) - 2 * dt, hi = Math.max(jd0, jd1) + 2 * dt;
    const n = Math.max(2, Math.ceil((hi - lo) / dt) + 1);
    const R = new Float64Array(n * 3), V = new Float64Array(n * 3);
    for (let k = 0; k < n; k++) {
      const s = p.state(lo + k * dt);
      R[3 * k] = s.r[0]; R[3 * k + 1] = s.r[1]; R[3 * k + 2] = s.r[2];
      V[3 * k] = s.v[0]; V[3 * k + 1] = s.v[1]; V[3 * k + 2] = s.v[2];
    }
    const state = (jd) => {
      let x = (jd - lo) / dt;
      let i = Math.floor(x);
      if (i < 0) i = 0; else if (i > n - 2) i = n - 2;
      const s = x - i;
      const h00 = 2 * s * s * s - 3 * s * s + 1, h10 = s * s * s - 2 * s * s + s;
      const h01 = -2 * s * s * s + 3 * s * s, h11 = s * s * s - s * s;
      const d00 = 6 * s * s - 6 * s, d10 = 3 * s * s - 4 * s + 1, d01 = -6 * s * s + 6 * s, d11 = 3 * s * s - 2 * s;
      const r = [0, 0, 0], v = [0, 0, 0];
      for (let c = 0; c < 3; c++) {
        const r0 = R[3 * i + c], r1 = R[3 * (i + 1) + c], v0 = V[3 * i + c], v1 = V[3 * (i + 1) + c];
        r[c] = h00 * r0 + h10 * dt * v0 + h01 * r1 + h11 * dt * v1;
        v[c] = (d00 * r0) / dt + d10 * v0 + (d01 * r1) / dt + d11 * v1;
      }
      return { r, v };
    };
    return { id: p.id, gm: p.gm, radiusAu: p.radiusAu, soiAu: p.soiAu, state };
  });
}

/**
 * Build the acceleration function a(r, jd) for the Sun plus perturbers.
 * Perturbers listed in `endpointIds` (departure/arrival bodies) are treated patched-conic style: their
 * gravity is zero inside their sphere of influence and ramps smoothly to full strength by 2 SOI radii,
 * so a leg can start/end at the body's centre without a singularity. Other bodies act in full; inside
 * a body's radius the uniform-sphere interior field is used (no singularity; impacts are flagged elsewhere).
 */
export function makeAccel(perturbers, { endpointIds = [], centralGm = GM_SUN } = {}) {
  const eps = new Set(endpointIds);
  const list = perturbers.map((p) => ({ ...p, endpoint: eps.has(p.id) }));
  return function accel(r, jd) {
    const rn = Math.hypot(r[0], r[1], r[2]);
    const k = -centralGm / (rn * rn * rn);
    let ax = k * r[0], ay = k * r[1], az = k * r[2];
    for (const p of list) {
      const pp = p.state(jd).r;
      const dx = r[0] - pp[0], dy = r[1] - pp[1], dz = r[2] - pp[2];
      const d = Math.sqrt(dx * dx + dy * dy + dz * dz);
      let w = 1;
      if (p.endpoint) {
        w = smoothstep(p.soiAu, 2 * p.soiAu, d);
        if (w === 0) continue;
      }
      const f = (d < p.radiusAu ? -p.gm / (p.radiusAu * p.radiusAu * p.radiusAu) : -p.gm / (d * d * d)) * w;
      ax += f * dx; ay += f * dy; az += f * dz;
    }
    return [ax, ay, az];
  };
}

// Dormand-Prince 5(4) coefficients
const A21 = 1 / 5;
const A31 = 3 / 40, A32 = 9 / 40;
const A41 = 44 / 45, A42 = -56 / 15, A43 = 32 / 9;
const A51 = 19372 / 6561, A52 = -25360 / 2187, A53 = 64448 / 6561, A54 = -212 / 729;
const A61 = 9017 / 3168, A62 = -355 / 33, A63 = 46732 / 5247, A64 = 49 / 176, A65 = -5103 / 18656;
const B1 = 35 / 384, B3 = 500 / 1113, B4 = 125 / 192, B5 = -2187 / 6784, B6 = 11 / 84;
const E1 = 71 / 57600, E3 = -71 / 16695, E4 = 71 / 1920, E5 = -17253 / 339200, E6 = 22 / 525, E7 = -1 / 40;

/**
 * Integrate r'' = accel(r, t) from jd0 to jd1 (forward only) with adaptive Dormand-Prince 5(4).
 * opts: { rtol, atol, hMax, maxSteps, track: perturbers to monitor for closest approach / impact }
 * Returns { r, v, samples: [{jd, r, v}], closest: { id: { jd, distAu } }, impacts: [{ id, jd, distAu }], steps, rejected }.
 */
export function integrate(accel, r0, v0, jd0, jd1, opts = {}) {
  const { rtol = 1e-10, atol = 1e-13, hMax = 20, maxSteps = 400000, endpointIds = [] } = opts;
  const eps = new Set(endpointIds);
  const track = (opts.track || []).filter((p) => !eps.has(p.id)); // endpoints are never "impacted"
  const total = jd1 - jd0;
  if (!(total > 0)) return { r: r0.slice(), v: v0.slice(), samples: [{ jd: jd0, r: r0.slice(), v: v0.slice() }], closest: {}, impacts: [], steps: 0, rejected: 0 };
  let y = [r0[0], r0[1], r0[2], v0[0], v0[1], v0[2]];
  let t = jd0;
  let h = Math.min(hMax, total / 50, 0.5);
  const f = (tt, yy) => { const a = accel([yy[0], yy[1], yy[2]], tt); return [yy[3], yy[4], yy[5], a[0], a[1], a[2]]; };
  const closest = {}, impacts = [], impacted = new Set();
  const samples = [{ jd: t, r: [y[0], y[1], y[2]], v: [y[3], y[4], y[5]] }];
  const monitor = (tt, yy) => {
    for (const p of track) {
      const pr = p.state(tt).r;
      const d = Math.hypot(yy[0] - pr[0], yy[1] - pr[1], yy[2] - pr[2]);
      const c = closest[p.id];
      if (!c || d < c.distAu) closest[p.id] = { jd: tt, distAu: d };
      if (d < p.radiusAu && !impacted.has(p.id)) { impacted.add(p.id); impacts.push({ id: p.id, jd: tt, distAu: d }); }
    }
  };
  monitor(t, y);
  let k1 = f(t, y);
  let steps = 0, rejected = 0;
  const tmp = new Array(6);
  while (t < jd1 - 1e-12) {
    if (t + h > jd1) h = jd1 - t;
    for (let i = 0; i < 6; i++) tmp[i] = y[i] + h * A21 * k1[i];
    const k2 = f(t + h / 5, tmp);
    for (let i = 0; i < 6; i++) tmp[i] = y[i] + h * (A31 * k1[i] + A32 * k2[i]);
    const k3 = f(t + 3 * h / 10, tmp);
    for (let i = 0; i < 6; i++) tmp[i] = y[i] + h * (A41 * k1[i] + A42 * k2[i] + A43 * k3[i]);
    const k4 = f(t + 4 * h / 5, tmp);
    for (let i = 0; i < 6; i++) tmp[i] = y[i] + h * (A51 * k1[i] + A52 * k2[i] + A53 * k3[i] + A54 * k4[i]);
    const k5 = f(t + 8 * h / 9, tmp);
    for (let i = 0; i < 6; i++) tmp[i] = y[i] + h * (A61 * k1[i] + A62 * k2[i] + A63 * k3[i] + A64 * k4[i] + A65 * k5[i]);
    const k6 = f(t + h, tmp);
    const ynew = new Array(6);
    for (let i = 0; i < 6; i++) ynew[i] = y[i] + h * (B1 * k1[i] + B3 * k3[i] + B4 * k4[i] + B5 * k5[i] + B6 * k6[i]);
    const k7 = f(t + h, ynew);
    let err = 0;
    for (let i = 0; i < 6; i++) {
      const e = h * (E1 * k1[i] + E3 * k3[i] + E4 * k4[i] + E5 * k5[i] + E6 * k6[i] + E7 * k7[i]);
      const sc = atol + rtol * Math.max(Math.abs(y[i]), Math.abs(ynew[i]));
      err += (e / sc) * (e / sc);
    }
    err = Math.sqrt(err / 6);
    if (err <= 1 || h < 1e-7) {
      t += h; y = ynew; k1 = k7; // FSAL
      samples.push({ jd: t, r: [y[0], y[1], y[2]], v: [y[3], y[4], y[5]] });
      monitor(t, y);
      steps++;
    } else {
      rejected++;
    }
    const fac = err === 0 ? 5 : Math.min(5, Math.max(0.2, 0.9 * Math.pow(err, -0.2)));
    h = Math.min(hMax, h * fac);
    if (steps + rejected > maxSteps) break;
  }
  return { r: [y[0], y[1], y[2]], v: [y[3], y[4], y[5]], samples, closest, impacts, steps, rejected };
}

/** Cubic Hermite interpolation of an integration sample list (jd increasing). Returns { r, v }. */
export function interpolateSamples(samples, jd) {
  const n = samples.length;
  if (n === 0) return { r: [0, 0, 0], v: [0, 0, 0] };
  if (jd <= samples[0].jd) return { r: samples[0].r.slice(), v: samples[0].v.slice() };
  if (jd >= samples[n - 1].jd) return { r: samples[n - 1].r.slice(), v: samples[n - 1].v.slice() };
  let lo = 0, hi = n - 1;
  while (hi - lo > 1) { const mid = (lo + hi) >> 1; if (samples[mid].jd <= jd) lo = mid; else hi = mid; }
  const s0 = samples[lo], s1 = samples[hi];
  const h = s1.jd - s0.jd;
  if (h <= 0) return { r: s0.r.slice(), v: s0.v.slice() };
  const s = (jd - s0.jd) / h;
  const h00 = 2 * s * s * s - 3 * s * s + 1, h10 = s * s * s - 2 * s * s + s;
  const h01 = -2 * s * s * s + 3 * s * s, h11 = s * s * s - s * s;
  const d00 = 6 * s * s - 6 * s, d10 = 3 * s * s - 4 * s + 1, d01 = -6 * s * s + 6 * s, d11 = 3 * s * s - 2 * s;
  const r = [0, 0, 0], v = [0, 0, 0];
  for (let c = 0; c < 3; c++) {
    r[c] = h00 * s0.r[c] + h10 * h * s0.v[c] + h01 * s1.r[c] + h11 * h * s1.v[c];
    v[c] = (d00 * s0.r[c]) / h + d10 * s0.v[c] + (d01 * s1.r[c]) / h + d11 * s1.v[c];
  }
  return { r, v };
}

function solve3(J, b) {
  // Gaussian elimination with partial pivoting on a 3x3 system J x = b. Returns x or null.
  const M = [[J[0][0], J[0][1], J[0][2], b[0]], [J[1][0], J[1][1], J[1][2], b[1]], [J[2][0], J[2][1], J[2][2], b[2]]];
  for (let c = 0; c < 3; c++) {
    let p = c;
    for (let r = c + 1; r < 3; r++) if (Math.abs(M[r][c]) > Math.abs(M[p][c])) p = r;
    if (Math.abs(M[p][c]) < 1e-300) return null;
    [M[c], M[p]] = [M[p], M[c]];
    for (let r = c + 1; r < 3; r++) {
      const fct = M[r][c] / M[c][c];
      for (let k = c; k < 4; k++) M[r][k] -= fct * M[c][k];
    }
  }
  const x = [0, 0, 0];
  for (let r = 2; r >= 0; r--) {
    let s = M[r][3];
    for (let k = r + 1; k < 3; k++) s -= M[r][k] * x[k];
    x[r] = s / M[r][r];
  }
  return x;
}

/**
 * Differential-correction targeting: adjust the departure velocity so the N-body trajectory from r0 at jd0
 * reaches rTarget at jd1. `v0guess` is normally the two-body Lambert solution.
 * Returns { ok, v0, vEnd, samples, missAu, iterations, closest, impacts, steps }.
 */
export function targetTransfer(accel, r0, jd0, rTarget, jd1, v0guess, opts = {}) {
  const { maxIter = 8, tolAu = 1e-7, track = [], endpointIds = [], rtol = 1e-10, hMax = 20 } = opts;
  const run = (v) => integrate(accel, r0, v, jd0, jd1, { track, endpointIds, rtol, hMax });
  let v0 = v0guess.slice();
  let best = null, iterations = 0;
  const T = jd1 - jd0;
  for (let it = 0; it <= maxIter; it++) {
    iterations = it;
    const res = run(v0);
    const miss = vsub(res.r, rTarget);
    const missN = vlen(miss);
    if (!best || missN < best.missN) best = { v0: v0.slice(), res, missN };
    if (!isFinite(missN)) break;
    if (missN < tolAu || it === maxIter) break;
    // finite-difference Jacobian d(rEnd)/d(v0)
    const dv = Math.max(1e-7, Math.min(1e-5, missN / T));
    const J = [[0, 0, 0], [0, 0, 0], [0, 0, 0]];
    for (let k = 0; k < 3; k++) {
      const vk = v0.slice(); vk[k] += dv;
      const rk = integrate(accel, r0, vk, jd0, jd1, { rtol, hMax }).r;
      for (let c = 0; c < 3; c++) J[c][k] = (rk[c] - res.r[c]) / dv;
    }
    const step = solve3(J, [-miss[0], -miss[1], -miss[2]]);
    if (!step) break;
    const stepN = vlen(step), vN = vlen(v0);
    const damp = stepN > 0.5 * vN ? (0.5 * vN) / stepN : 1; // guard against wild Newton steps near flybys
    v0 = vadd(v0, vscale(step, damp));
  }
  return {
    ok: best.missN < 20 * tolAu, v0: best.v0, vEnd: best.res.v, samples: best.res.samples, missAu: best.missN,
    iterations, closest: best.res.closest, impacts: best.res.impacts, steps: best.res.steps,
  };
}

/**
 * Patched-conic flyby analysis at a planet for a zero-dwell stop.
 * vInHelio / vOutHelio: heliocentric arrival velocity of the inbound leg and departure velocity of the outbound leg (AU/day);
 * vBody: the body's heliocentric velocity; gmBody in AU^3/day^2; radiusAu the body radius.
 * Returns { vInfInAuDay, vInfOutAuDay, speedMismatchAuDay, turnAngleRad, rpRequiredAu, altitudeRequiredAu,
 *           feasibleUnpowered, poweredDeltaVAuDay }
 */
export function flybyAnalysis(vInHelio, vOutHelio, vBody, gmBody, radiusAu, { minAltitudeFactor = 0.05, speedTolerance = 0.03 } = {}) {
  const vinfIn = vsub(vInHelio, vBody), vinfOut = vsub(vOutHelio, vBody);
  const a = vlen(vinfIn), b = vlen(vinfOut);
  const cosT = a > 0 && b > 0 ? Math.min(1, Math.max(-1, vdot(vinfIn, vinfOut) / (a * b))) : 1;
  const turn = Math.acos(cosT);
  const vinf = 0.5 * (a + b);
  const sinHalf = Math.sin(turn / 2);
  const rp = sinHalf > 1e-12 && vinf > 0 ? (gmBody / (vinf * vinf)) * (1 / sinHalf - 1) : Infinity;
  const rpMin = radiusAu * (1 + minAltitudeFactor);
  const mismatch = Math.abs(b - a);
  // crude powered-flyby cost: the speed mismatch applied at periapsis is cheaper than |b-a|; use |b-a| as an upper bound
  const feasibleUnpowered = rp >= rpMin && mismatch <= speedTolerance * Math.max(a, b, 1e-12);
  return {
    vInfInAuDay: a, vInfOutAuDay: b, speedMismatchAuDay: mismatch, turnAngleRad: turn,
    rpRequiredAu: rp, altitudeRequiredAu: rp - radiusAu, rpMinAu: rpMin, feasibleUnpowered,
    poweredDeltaVAuDay: mismatch, turnTooSharp: rp < rpMin,
  };
}

/** Delta-v (AU/day) to go from a circular parking orbit of radius rParkAu to hyperbolic excess speed vInf, or to capture from it. */
export function parkingOrbitDeltaV(vInfAuDay, gmBody, rParkAu) {
  const vc = Math.sqrt(gmBody / rParkAu);
  const vp = Math.sqrt(vInfAuDay * vInfAuDay + 2 * gmBody / rParkAu);
  return vp - vc;
}

/**
 * Gravity accounting for a straight-line brachistochrone leg from P0 (at jd0) to P1 (at jd0+T) with
 * profile acceleration aProfile (AU/day^2). The engine must supply a_engine = a_profile*u - g(r, t).
 * Returns { peakRequired, meanRequired, deltaVEngine, deltaVIdeal, gravityLossFraction, maxRatio, holdsLine, worstJd }.
 * holdsLine is false when the required engine acceleration exceeds `limitFactor` x the profile acceleration anywhere
 * (default 1.1: a ship rated at the profile acceleration can realistically hold the line within a ~10% margin;
 * maxRatio > 1.5 means the straight-line model is no longer meaningful for this leg).
 */
export function brachistochroneGravityAudit(P0, P1, jd0, T, aProfile, accel, { samples = 240, limitFactor = 1.1 } = {}) {
  const D = vdist3(P0, P1);
  const u = D > 0 ? vnorm(vsub(P1, P0)) : [1, 0, 0];
  let peak = 0, worstJd = jd0, sum = 0, dvEngine = 0;
  const dt = T / samples;
  for (let k = 0; k <= samples; k++) {
    const tau = k / samples;
    const pos = vadd(P0, vscale(u, D * brachistochroneFraction(tau)));
    const jd = jd0 + tau * T;
    const sign = tau < 0.5 ? 1 : -1;
    const g = accel(pos, jd);
    const req = [aProfile * sign * u[0] - g[0], aProfile * sign * u[1] - g[1], aProfile * sign * u[2] - g[2]];
    const m = vlen(req);
    if (m > peak) { peak = m; worstJd = jd; }
    sum += m;
    const w = (k === 0 || k === samples) ? 0.5 : 1; // trapezoid
    dvEngine += w * m * dt;
  }
  const dvIdeal = aProfile * T;
  return {
    peakRequired: peak, meanRequired: sum / (samples + 1), deltaVEngine: dvEngine, deltaVIdeal: dvIdeal,
    gravityLossFraction: dvIdeal > 0 ? (dvEngine - dvIdeal) / dvIdeal : 0,
    maxRatio: aProfile > 0 ? peak / aProfile : Infinity, holdsLine: peak <= limitFactor * aProfile, worstJd,
  };
}

function vdist3(a, b) { return Math.hypot(a[0] - b[0], a[1] - b[1], a[2] - b[2]); }
