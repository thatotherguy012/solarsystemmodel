// Lambert's problem (universal variables, bisection on psi — Vallado Alg. 58) and
// universal-variable two-body propagation (Vallado Alg. 8). Units: AU, days, AU^3/day^2.
import { vsub, vscale, vadd, vdot, vcross, vlen } from './vec3.js';

function stumpff(psi) {
  if (psi > 1e-6) {
    const s = Math.sqrt(psi);
    return [(1 - Math.cos(s)) / psi, (s - Math.sin(s)) / Math.sqrt(psi * psi * psi)];
  } else if (psi < -1e-6) {
    const s = Math.sqrt(-psi);
    return [(1 - Math.cosh(s)) / psi, (Math.sinh(s) - s) / Math.sqrt(-psi * psi * psi)];
  }
  return [0.5, 1 / 6];
}

/**
 * Solve Lambert's problem: find v1, v2 such that an orbit about mu passes from r1 to r2 in dt days.
 * Short-way, zero-revolution. `prograde` picks the transfer direction relative to +z (ecliptic north).
 * Returns { v1, v2, ok, a, iterations } (v in AU/day). ok=false if no convergence / degenerate geometry.
 */
export function lambert(r1, r2, dt, mu, prograde = true) {
  const r1n = vlen(r1), r2n = vlen(r2);
  if (dt <= 0 || r1n === 0 || r2n === 0) return { ok: false };
  let cosDnu = vdot(r1, r2) / (r1n * r2n);
  cosDnu = Math.min(1, Math.max(-1, cosDnu));
  const cr = vcross(r1, r2);
  let sinDnu = Math.sqrt(Math.max(0, 1 - cosDnu * cosDnu));
  // direction: prograde if transfer angular momentum points +z
  const dirSign = (cr[2] >= 0) === prograde ? 1 : -1;
  sinDnu *= dirSign;
  if (Math.abs(sinDnu) < 1e-9) {
    // ~0 or ~180 deg transfer: plane undefined; nudge
    sinDnu = 1e-6 * (prograde ? 1 : -1);
  }
  const A = sinDnu * Math.sqrt(r1n * r2n / (1 - cosDnu));
  if (!isFinite(A) || A === 0) return { ok: false };

  let psi = 0, c2 = 0.5, c3 = 1 / 6;
  // psi in (psiLow, psiUp): zero-rev solutions have psi < 4*pi^2; very fast hyperbolic
  // transfers need strongly negative psi, so start the bracket wide.
  let psiUp = 4 * Math.PI * Math.PI, psiLow = -64 * Math.PI * Math.PI;
  let y = 0, dtn = 0, iter = 0;
  const sqrtMu = Math.sqrt(mu);
  for (iter = 0; iter < 300; iter++) {
    y = r1n + r2n + A * (psi * c3 - 1) / Math.sqrt(c2);
    if (A > 0 && y < 0) {
      // y < 0 is infeasible; since y increases with psi (A > 0), the solution lies above this psi.
      psiLow = psi;
      psi = (psiUp + psiLow) / 2;
      [c2, c3] = stumpff(psi);
      continue;
    }
    const chi = Math.sqrt(y / c2);
    dtn = (chi * chi * chi * c3 + A * Math.sqrt(y)) / sqrtMu;
    if (Math.abs(dtn - dt) < 1e-8 * Math.max(1, dt)) break;
    if (dtn <= dt) psiLow = psi; else psiUp = psi;
    psi = (psiUp + psiLow) / 2;
    [c2, c3] = stumpff(psi);
    if (psiUp - psiLow < 1e-15) break;
  }
  if (!isFinite(y) || y <= 0) return { ok: false };
  const f = 1 - y / r1n;
  const g = A * Math.sqrt(y / mu);
  const gdot = 1 - y / r2n;
  if (Math.abs(g) < 1e-14) return { ok: false };
  const v1 = vscale(vsub(r2, vscale(r1, f)), 1 / g);
  const v2 = vscale(vsub(vscale(r2, gdot), r1), 1 / g);
  const v1n2 = vdot(v1, v1);
  const energy = v1n2 / 2 - mu / r1n;
  const a = Math.abs(energy) > 1e-18 ? -mu / (2 * energy) : Infinity;
  return { v1, v2, ok: Math.abs(dtn - dt) < 1e-5 * Math.max(1, dt), a, iterations: iter, psi };
}

/**
 * Propagate state (r0 AU, v0 AU/day) by dt days under mu using universal variables. Handles all conics.
 * Returns { r, v }.
 */
export function propagateUniversal(r0, v0, dt, mu) {
  if (dt === 0) return { r: r0.slice(), v: v0.slice() };
  const r0n = vlen(r0), v0n2 = vdot(v0, v0);
  const sqrtMu = Math.sqrt(mu);
  const rdotv = vdot(r0, v0);
  const alpha = -v0n2 / mu + 2 / r0n; // 1/a
  let chi;
  if (alpha > 1e-6) {
    chi = sqrtMu * dt * alpha;
  } else if (Math.abs(alpha) < 1e-6) {
    const h = vcross(r0, v0);
    const p = vdot(h, h) / mu;
    const s = 0.5 * Math.atan(1 / (3 * Math.sqrt(mu / (p * p * p)) * dt));
    const w = Math.atan(Math.cbrt(Math.tan(s)));
    chi = Math.sqrt(p) * 2 / Math.tan(2 * w);
  } else {
    const a = 1 / alpha;
    const sgn = Math.sign(dt);
    const num = -2 * mu * alpha * dt;
    const den = rdotv + sgn * Math.sqrt(-mu * a) * (1 - r0n * alpha);
    chi = sgn * Math.sqrt(-a) * Math.log(num / den);
    if (!isFinite(chi)) chi = sgn * Math.sqrt(-a) * 2;
  }
  let r = r0n, psi = 0, c2 = 0.5, c3 = 1 / 6;
  for (let k = 0; k < 100; k++) {
    psi = chi * chi * alpha;
    [c2, c3] = stumpff(psi);
    r = chi * chi * c2 + (rdotv / sqrtMu) * chi * (1 - psi * c3) + r0n * (1 - psi * c2);
    const F = sqrtMu * dt - chi * chi * chi * c3 - (rdotv / sqrtMu) * chi * chi * c2 - r0n * chi * (1 - psi * c3);
    const dchi = F / r;
    chi += dchi;
    if (Math.abs(dchi) < 1e-12 * Math.max(1, Math.abs(chi))) break;
  }
  psi = chi * chi * alpha;
  [c2, c3] = stumpff(psi);
  r = chi * chi * c2 + (rdotv / sqrtMu) * chi * (1 - psi * c3) + r0n * (1 - psi * c2);
  const f = 1 - chi * chi * c2 / r0n;
  const g = dt - chi * chi * chi * c3 / sqrtMu;
  const gdot = 1 - chi * chi * c2 / r;
  const fdot = (sqrtMu / (r * r0n)) * chi * (psi * c3 - 1);
  return {
    r: vadd(vscale(r0, f), vscale(v0, g)),
    v: vadd(vscale(r0, fdot), vscale(v0, gdot)),
  };
}

/**
 * Brachistochrone (constant thrust, flip at midpoint) helpers for straight-line transfers.
 * Fraction of distance covered at normalized time tau in [0,1].
 */
export function brachistochroneFraction(tau) {
  if (tau <= 0) return 0;
  if (tau >= 1) return 1;
  return tau < 0.5 ? 2 * tau * tau : 1 - 2 * (1 - tau) * (1 - tau);
}
/** Required acceleration (AU/day^2) to cover distance D (AU) in time T (days) with a flip-and-burn profile. */
export function brachistochroneAccel(D, T) { return 4 * D / (T * T); }
/** Travel time (days) for distance D (AU) at acceleration a (AU/day^2). */
export function brachistochroneTime(D, a) { return 2 * Math.sqrt(D / a); }
/** Peak velocity (AU/day) reached at midpoint. */
export function brachistochronePeakV(D, T) { return 2 * D / T; }
