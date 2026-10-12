// Lagrange points of a two-body system in the inertial frame.
import { vadd, vsub, vscale, vcross, vlen } from './vec3.js';

/** Solve the collinear Lagrange point equation f(x)=0 in normalized units (R=1, barycenter at origin). */
function solveCollinear(muRatio, which) {
  const m1 = 1 - muRatio, m2 = muRatio;
  // primary at x=-m2, secondary at x=+m1
  const f = (x) => {
    const d1 = x + m2, d2 = x - m1;
    return x - m1 * d1 / Math.pow(Math.abs(d1), 3) - m2 * d2 / Math.pow(Math.abs(d2), 3);
  };
  let lo, hi;
  const eps = 1e-9;
  if (which === 'L1') { lo = -m2 + eps; hi = m1 - eps; }
  else if (which === 'L2') { lo = m1 + eps; hi = 3; }
  else { lo = -3; hi = -m2 - eps; }
  let flo = f(lo), fhi = f(hi);
  if (flo * fhi > 0) {
    // fall back to Hill-sphere approximations
    const hill = Math.cbrt(m2 / 3);
    if (which === 'L1') return m1 - hill;
    if (which === 'L2') return m1 + hill;
    return -m1 - (7 / 12) * m2;
  }
  for (let k = 0; k < 200; k++) {
    const mid = 0.5 * (lo + hi);
    const fm = f(mid);
    if (fm === 0 || (hi - lo) < 1e-14) return mid;
    if (fm * flo < 0) { hi = mid; fhi = fm; } else { lo = mid; flo = fm; }
  }
  return 0.5 * (lo + hi);
}

/**
 * Position of Lagrange point `point` ('L1'..'L5') for primary P (pos rP, GM gmP) and secondary S (pos rS, GM gmS).
 * `normal` is the unit orbit normal of S about P; L4 leads S in its motion, L5 trails.
 * If velocities are known pass normal = normalize(cross(rS-rP, vS-vP)). Default: ecliptic north.
 * Returns inertial position (same units as inputs).
 */
export function lagrangePoint(rP, gmP, rS, gmS, point, normal = [0, 0, 1]) {
  const d = vsub(rS, rP);
  const R = vlen(d);
  if (R === 0) return rP.slice();
  const u = vscale(d, 1 / R);
  const muRatio = gmS / (gmP + gmS);
  if (point === 'L4' || point === 'L5') {
    let w = vcross(normal, u); // direction of prograde motion of S
    const wl = vlen(w);
    w = wl > 0 ? vscale(w, 1 / wl) : [-u[1], u[0], 0];
    const s = point === 'L4' ? 1 : -1;
    return vadd(rP, vscale(vadd(vscale(u, 0.5), vscale(w, s * Math.sqrt(3) / 2)), R));
  }
  const x = solveCollinear(muRatio, point); // normalized, measured from barycenter along u
  const bary = vadd(rP, vscale(d, muRatio));
  return vadd(bary, vscale(u, x * R));
}
