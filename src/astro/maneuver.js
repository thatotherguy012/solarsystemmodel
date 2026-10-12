// Constant-thrust maneuver planning for torch ships: rendezvous (match target position AND velocity)
// and intercept (reach the target position, any velocity), from an arbitrary initial state (position and
// velocity) to a moving target. Solved first in a gravity-free model with a two-phase constant-thrust
// profile (burn along u1 for t1, flip, burn along u2 for t2), then optionally refined by shooting under a
// real gravity field using the N-body integrator. Units: AU, days, AU/day, AU/day^2.
//
// targetFn(jd) -> { r, v } heliocentric state of the target at jd (body or another ship).
import { vadd, vsub, vscale, vlen, vnorm } from './vec3.js';
import { integrate, interpolateSamples } from './nbody.js';

// ---------- small dense linear algebra ----------
function solveLinear(A, b) {
  const n = b.length;
  const M = A.map((row, i) => [...row, b[i]]);
  for (let c = 0; c < n; c++) {
    let p = c;
    for (let r = c + 1; r < n; r++) if (Math.abs(M[r][c]) > Math.abs(M[p][c])) p = r;
    if (Math.abs(M[p][c]) < 1e-300) return null;
    [M[c], M[p]] = [M[p], M[c]];
    for (let r = c + 1; r < n; r++) {
      const f = M[r][c] / M[c][c];
      if (f === 0) continue;
      for (let k = c; k <= n; k++) M[r][k] -= f * M[c][k];
    }
  }
  const x = new Array(n).fill(0);
  for (let r = n - 1; r >= 0; r--) {
    let s = M[r][n];
    for (let k = r + 1; k < n; k++) s -= M[r][k] * x[k];
    x[r] = s / M[r][r];
  }
  return x;
}

const norm = (v) => Math.sqrt(v.reduce((s, x) => s + x * x, 0));

/**
 * Damped Newton with finite-difference Jacobian. F: x (array n) -> residual (array n).
 * Returns { x, ok, iterations, residual }.
 */
function newton(F, x0, { maxIter = 40, tol = 1e-10, fdStep = 1e-6 } = {}) {
  let x = x0.slice();
  let f = F(x);
  if (!f || f.some((v) => !isFinite(v))) return { x, ok: false, iterations: 0, residual: Infinity };
  let fn = norm(f);
  let it = 0;
  for (it = 0; it < maxIter && fn > tol; it++) {
    const n = x.length;
    const J = Array.from({ length: n }, () => new Array(n).fill(0));
    for (let k = 0; k < n; k++) {
      const xk = x.slice();
      const h = fdStep * Math.max(1, Math.abs(x[k]));
      xk[k] += h;
      const fk = F(xk);
      if (!fk || fk.some((v) => !isFinite(v))) return { x, ok: false, iterations: it, residual: fn };
      for (let r = 0; r < n; r++) J[r][k] = (fk[r] - f[r]) / h;
    }
    const dx = solveLinear(J, f.map((v) => -v));
    if (!dx) break;
    // backtracking line search
    let lambda = 1, accepted = false;
    for (let ls = 0; ls < 12; ls++) {
      const xt = x.map((v, i) => v + lambda * dx[i]);
      const ft = F(xt);
      if (ft && ft.every(isFinite)) {
        const ftn = norm(ft);
        if (ftn < fn) { x = xt; f = ft; fn = ftn; accepted = true; break; }
      }
      lambda *= 0.5;
    }
    if (!accepted) break;
  }
  return { x, ok: fn <= tol * 100, iterations: it, residual: fn };
}

// ---------- gravity-free two-phase kinematics ----------
/** State along a two-phase constant-thrust profile at elapsed time t (gravity-free). */
function twoPhaseState(P0, V0, a, u1, t1, u2, t, tEnd) {
  if (t <= t1) {
    return { r: vadd(vadd(P0, vscale(V0, t)), vscale(u1, 0.5 * a * t * t)), v: vadd(V0, vscale(u1, a * t)) };
  }
  const r1 = vadd(vadd(P0, vscale(V0, t1)), vscale(u1, 0.5 * a * t1 * t1));
  const v1 = vadd(V0, vscale(u1, a * t1));
  const tau = Math.min(t, tEnd) - t1;
  return { r: vadd(vadd(r1, vscale(v1, tau)), vscale(u2, 0.5 * a * tau * tau)), v: vadd(v1, vscale(u2, a * tau)) };
}

function unpackW(w, a) {
  const w1 = [w[0], w[1], w[2]], w2 = [w[3], w[4], w[5]];
  const n1 = vlen(w1), n2 = vlen(w2);
  const t1 = n1 / a, t2 = n2 / a;
  return { w1, w2, t1, t2, T: t1 + t2, u1: n1 > 0 ? vscale(w1, 1 / n1) : [1, 0, 0], u2: n2 > 0 ? vscale(w2, 1 / n2) : [-1, 0, 0] };
}

/** Initial guess: classic flip-and-burn toward where the target will be, split the velocity change between phases. */
function rendezvousGuess(P0, V0, jd0, targetFn, a) {
  let T = 1;
  for (let k = 0; k < 20; k++) {
    const D = vlen(vsub(targetFn(jd0 + T).r, P0));
    const Tn = 2 * Math.sqrt(Math.max(D, 1e-12) / a);
    if (Math.abs(Tn - T) < 1e-9) { T = Tn; break; }
    T = Tn;
  }
  const tgt = targetFn(jd0 + T);
  const u = vnorm(vsub(tgt.r, P0));
  const dv = vsub(tgt.v, V0);
  const w1 = vadd(vscale(u, a * T / 2), vscale(dv, 0.5));
  const w2 = vadd(vscale(u, -a * T / 2), vscale(dv, 0.5));
  return [...w1, ...w2];
}

/**
 * Two-phase constant-thrust rendezvous, gravity-free. Finds (u1, t1, u2, t2) so the ship starting at (P0, V0)
 * at jd0 meets the target's position and velocity at jd0 + t1 + t2 with acceleration magnitude `a`.
 * Returns { ok, T, t1, t2, u1, u2, arriveJd, deltaV, peakSpeed, stateAt(jd), residual, iterations }.
 */
export function solveRendezvous(P0, V0, jd0, targetFn, a, opts = {}) {
  if (!(a > 0)) return { ok: false, reason: 'acceleration must be positive' };
  const F = (w) => {
    const { w1, w2, t1, t2, T } = unpackW(w, a);
    if (!isFinite(T) || T > 1e6) return null;
    const tgt = targetFn(jd0 + T);
    const rEnd = vadd(vadd(P0, vscale(V0, T)), vadd(vscale(w1, t1 / 2 + t2), vscale(w2, t2 / 2)));
    const vEnd = vadd(V0, vadd(w1, w2));
    const dr = vsub(rEnd, tgt.r), dv = vsub(vEnd, tgt.v);
    return [dr[0], dr[1], dr[2], dv[0], dv[1], dv[2]];
  };
  const x0 = opts.guess || rendezvousGuess(P0, V0, jd0, targetFn, a);
  const sol = newton(F, x0, { maxIter: 60, tol: 1e-10 });
  const { t1, t2, T, u1, u2 } = unpackW(sol.x, a);
  const stateAt = (jd) => twoPhaseState(P0, V0, a, u1, t1, u2, Math.min(Math.max(jd - jd0, 0), T), T);
  let peak = vlen(V0);
  for (let k = 0; k <= 100; k++) peak = Math.max(peak, vlen(stateAt(jd0 + (k / 100) * T).v));
  return {
    ok: sol.ok && isFinite(T) && T > 0, T, t1, t2, u1, u2, arriveJd: jd0 + T, deltaV: a * T, accel: a,
    peakSpeed: peak, stateAt, residual: sol.residual, iterations: sol.iterations, flipJd: jd0 + t1,
    thrustAt: (jd) => (jd - jd0 < t1 ? vscale(u1, a) : vscale(u2, a)),
  };
}

/**
 * Single-phase constant-thrust intercept, gravity-free: reach the target's position (any velocity) as soon as possible
 * by thrusting along a fixed direction. Returns { ok, T, u, arriveJd, deltaV, closingSpeed, stateAt(jd) }.
 */
export function solveIntercept(P0, V0, jd0, targetFn, a, opts = {}) {
  if (!(a > 0)) return { ok: false, reason: 'acceleration must be positive' };
  const F = (w) => {
    const T = vlen(w) / a;
    if (!isFinite(T) || T > 1e6) return null;
    const tgt = targetFn(jd0 + T);
    const rEnd = vadd(vadd(P0, vscale(V0, T)), vscale(w, T / 2)); // 0.5 a u T^2 = w T / 2
    return vsub(rEnd, tgt.r);
  };
  let T = 1;
  for (let k = 0; k < 20; k++) {
    const D = vlen(vsub(vsub(targetFn(jd0 + T).r, P0), vscale(V0, T)));
    const Tn = Math.sqrt(2 * Math.max(D, 1e-12) / a);
    if (Math.abs(Tn - T) < 1e-9) { T = Tn; break; }
    T = Tn;
  }
  const guess = opts.guess || vscale(vsub(vsub(targetFn(jd0 + T).r, P0), vscale(V0, T)), 2 / T);
  const sol = newton(F, guess, { maxIter: 60, tol: 1e-10 });
  const w = sol.x, Tf = vlen(w) / a, u = Tf > 0 ? vscale(w, 1 / (a * Tf)) : [1, 0, 0];
  const stateAt = (jd) => {
    const t = Math.min(Math.max(jd - jd0, 0), Tf);
    return { r: vadd(vadd(P0, vscale(V0, t)), vscale(u, 0.5 * a * t * t)), v: vadd(V0, vscale(u, a * t)) };
  };
  const tgt = targetFn(jd0 + Tf);
  return {
    ok: sol.ok && isFinite(Tf) && Tf > 0, T: Tf, u, arriveJd: jd0 + Tf, deltaV: a * Tf, accel: a,
    closingSpeed: vlen(vsub(stateAt(jd0 + Tf).v, tgt.v)), stateAt, residual: sol.residual, iterations: sol.iterations,
    thrustAt: () => vscale(u, a),
  };
}

/**
 * Rendezvous arriving at a prescribed time: find the acceleration a such that the two-phase solution takes
 * exactly T days (T decreases monotonically with a). Bisection on log(a). Returns the solveRendezvous result for that a
 * (or { ok: false }).
 */
export function solveRendezvousForTime(P0, V0, jd0, targetFn, T, opts = {}) {
  if (!(T > 0)) return { ok: false, reason: 'time must be positive' };
  const solveFor = (a) => { const s = solveRendezvous(P0, V0, jd0, targetFn, a); return s.ok ? s : null; };
  // start from the straight-line estimate a = 4D/T^2 and bracket geometrically
  const D0 = vlen(vsub(targetFn(jd0 + T).r, P0));
  const a0 = Math.max(1e-9, 4 * D0 / (T * T));
  const s0 = solveFor(a0);
  if (!s0) return { ok: false, reason: 'no solution near the straight-line estimate' };
  let aLo = a0, aHi = a0, sLo = s0, sHi = s0;
  for (let k = 0; k < 60 && sLo.T < T; k++) { const s = solveFor(aLo / 1.5); if (!s) break; aLo /= 1.5; sLo = s; }
  for (let k = 0; k < 60 && sHi.T > T; k++) { const s = solveFor(aHi * 1.5); if (!s) break; aHi *= 1.5; sHi = s; }
  if (sLo.T < T) return { ok: false, reason: 'requested time too long for a constant-thrust rendezvous' };
  if (sHi.T > T) return { ok: false, reason: 'requested time too short' };
  let lo = Math.log(aLo), hi = Math.log(aHi);
  let best = Math.abs(sLo.T - T) < Math.abs(sHi.T - T) ? sLo : sHi;
  for (let k = 0; k < 60; k++) {
    const mid = 0.5 * (lo + hi);
    const s = solveFor(Math.exp(mid));
    if (!s) { hi = mid; continue; }
    if (Math.abs(s.T - T) < Math.abs(best.T - T)) best = s;
    if (Math.abs(s.T - T) < 1e-7 * T) break;
    if (s.T > T) lo = mid; else hi = mid;
  }
  return best;
}

// ---------- refinement under gravity (shooting with the N-body integrator) ----------
/**
 * Refine a gravity-free two-phase rendezvous so that, integrated under `gravity(r, jd)` plus the thrust profile,
 * the ship still meets the target. Unknowns are the same w1, w2. Returns a solution object like solveRendezvous
 * with `samples` (integration samples) and stateAt() based on them, plus `peakThrustRatio` (always 1 here, the thrust
 * magnitude is fixed) and `ok`. Falls back to ok=false if shooting does not converge.
 */
export function refineRendezvousWithGravity(P0, V0, jd0, targetFn, a, gravity, kinematicSolution, opts = {}) {
  const { rtol = 1e-9 } = opts;
  const guess = [...vscale(kinematicSolution.u1, a * kinematicSolution.t1), ...vscale(kinematicSolution.u2, a * kinematicSolution.t2)];
  let lastRun = null;
  const run = (w) => {
    const { t1, t2, T, u1, u2 } = unpackW(w, a);
    if (!isFinite(T) || T <= 0 || T > 1e6) return null;
    const acc1 = (r, jd) => vadd(gravity(r, jd), vscale(u1, a));
    const acc2 = (r, jd) => vadd(gravity(r, jd), vscale(u2, a));
    const s1 = integrate(acc1, P0, V0, jd0, jd0 + t1, { rtol, hMax: 2 });
    const s2 = integrate(acc2, s1.r, s1.v, jd0 + t1, jd0 + T, { rtol, hMax: 2 });
    const samples = s1.samples.concat(s2.samples.slice(1));
    return { r: s2.r, v: s2.v, samples, t1, t2, T, u1, u2 };
  };
  const F = (w) => {
    const res = run(w);
    if (!res) return null;
    lastRun = res;
    const tgt = targetFn(jd0 + res.T);
    const dr = vsub(res.r, tgt.r), dv = vsub(res.v, tgt.v);
    return [dr[0], dr[1], dr[2], dv[0], dv[1], dv[2]];
  };
  const sol = newton(F, guess, { maxIter: 25, tol: 1e-9, fdStep: 1e-5 });
  const res = run(sol.x);
  if (!res) return { ok: false, reason: 'integration failed' };
  const samples = res.samples;
  const stateAt = (jd) => interpolateSamples(samples, jd);
  let peak = 0;
  for (const s of samples) peak = Math.max(peak, vlen(s.v));
  return {
    ok: sol.ok, T: res.T, t1: res.t1, t2: res.t2, u1: res.u1, u2: res.u2, arriveJd: jd0 + res.T, deltaV: a * res.T, accel: a,
    peakSpeed: peak, stateAt, samples, residual: sol.residual, iterations: sol.iterations, flipJd: jd0 + res.t1,
    thrustAt: (jd) => (jd - jd0 < res.t1 ? vscale(res.u1, a) : vscale(res.u2, a)),
  };
}

/** Same refinement for a single-phase intercept. */
export function refineInterceptWithGravity(P0, V0, jd0, targetFn, a, gravity, kinematicSolution, opts = {}) {
  const { rtol = 1e-9 } = opts;
  const guess = vscale(kinematicSolution.u, a * kinematicSolution.T);
  const run = (w) => {
    const T = vlen(w) / a;
    if (!isFinite(T) || T <= 0 || T > 1e6) return null;
    const u = vscale(w, 1 / (a * T));
    const acc = (r, jd) => vadd(gravity(r, jd), vscale(u, a));
    const s = integrate(acc, P0, V0, jd0, jd0 + T, { rtol, hMax: 2 });
    return { r: s.r, v: s.v, samples: s.samples, T, u };
  };
  const F = (w) => { const res = run(w); if (!res) return null; return vsub(res.r, targetFn(jd0 + res.T).r); };
  const sol = newton(F, guess, { maxIter: 25, tol: 1e-9, fdStep: 1e-5 });
  const res = run(sol.x);
  if (!res) return { ok: false, reason: 'integration failed' };
  const stateAt = (jd) => interpolateSamples(res.samples, jd);
  const tgt = targetFn(jd0 + res.T);
  return {
    ok: sol.ok, T: res.T, u: res.u, arriveJd: jd0 + res.T, deltaV: a * res.T, accel: a,
    closingSpeed: vlen(vsub(res.v, tgt.v)), stateAt, samples: res.samples, residual: sol.residual, iterations: sol.iterations,
    thrustAt: () => vscale(res.u, a),
  };
}

/**
 * Convenience: plan a torch-ship maneuver. mode 'rendezvous' | 'intercept'. If `gravity` is given, the kinematic
 * solution is refined under it; if refinement fails the kinematic solution is returned with `approximate: true`.
 */
export function planManeuver(mode, P0, V0, jd0, targetFn, a, gravity = null) {
  const kin = mode === 'intercept' ? solveIntercept(P0, V0, jd0, targetFn, a) : solveRendezvous(P0, V0, jd0, targetFn, a);
  if (!kin.ok) return { ...kin, mode, approximate: true };
  if (!gravity) return { ...kin, mode, approximate: false, gravityRefined: false };
  const ref = mode === 'intercept'
    ? refineInterceptWithGravity(P0, V0, jd0, targetFn, a, gravity, kin)
    : refineRendezvousWithGravity(P0, V0, jd0, targetFn, a, gravity, kin);
  if (ref.ok) return { ...ref, mode, approximate: false, gravityRefined: true, kinematic: kin };
  return { ...kin, mode, approximate: true, gravityRefined: false, refineFailure: ref.reason || 'shooting did not converge' };
}
