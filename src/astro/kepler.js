// Two-body Keplerian mechanics. Units: AU, days, radians; mu in AU^3/day^2.
// Orbital elements object: { a, e, i, om (long. of ascending node), w (arg. of periapsis), M (mean anomaly at epoch), epoch (JD), n? (mean motion rad/day, optional) }
// For hyperbolic orbits a < 0 and e > 1.
import { wrapRad } from './constants.js';

/** Solve Kepler's equation M = E - e sin E (elliptic). Returns eccentric anomaly E (rad). */
export function solveKeplerElliptic(M, e) {
  M = wrapRad(M);
  let E = e < 0.8 ? M : Math.PI;
  for (let k = 0; k < 60; k++) {
    const f = E - e * Math.sin(E) - M;
    const fp = 1 - e * Math.cos(E);
    const dE = -f / fp;
    E += dE;
    if (Math.abs(dE) < 1e-13) break;
  }
  return E;
}

/** Solve hyperbolic Kepler equation M = e sinh H - H. Returns H. */
export function solveKeplerHyperbolic(M, e) {
  let H = Math.abs(M) > 1 ? Math.sign(M) * Math.log(2 * Math.abs(M) / e + 1.8) : M;
  for (let k = 0; k < 80; k++) {
    const f = e * Math.sinh(H) - H - M;
    const fp = e * Math.cosh(H) - 1;
    const dH = -f / fp;
    H += dH;
    if (Math.abs(dH) < 1e-13) break;
  }
  return H;
}

/** Mean motion (rad/day). */
export function meanMotion(a, mu) {
  return Math.sqrt(mu / Math.abs(a * a * a));
}

/** Orbital period in days (elliptic only; Infinity otherwise). */
export function periodDays(a, mu) {
  return a > 0 ? 2 * Math.PI * Math.sqrt(a * a * a / mu) : Infinity;
}

/** Rotate a perifocal-frame vector into the reference (ecliptic) frame: R3(om) R1(i) R3(w). */
export function perifocalToReference(p, i, om, w) {
  const cO = Math.cos(om), sO = Math.sin(om);
  const ci = Math.cos(i), si = Math.sin(i);
  const cw = Math.cos(w), sw = Math.sin(w);
  const x = p[0], y = p[1];
  // Standard rotation matrix (Vallado eq. 2-... / Curtis 4.49)
  const r11 = cO * cw - sO * sw * ci, r12 = -cO * sw - sO * cw * ci;
  const r21 = sO * cw + cO * sw * ci, r22 = -sO * sw + cO * cw * ci;
  const r31 = sw * si, r32 = cw * si;
  return [r11 * x + r12 * y, r21 * x + r22 * y, r31 * x + r32 * y];
}

/**
 * Position & velocity from elements at JD `jd`.
 * Returns { r: [x,y,z] (AU), v: [vx,vy,vz] (AU/day) } relative to the central body, ecliptic frame.
 */
export function elementsToState(el, mu, jd) {
  const { a, e, i, om, w } = el;
  const n = el.n ?? meanMotion(a, mu);
  const M = el.M + n * (jd - el.epoch);
  let px, py, vx, vy;
  if (e < 1) {
    const E = solveKeplerElliptic(M, e);
    const cE = Math.cos(E), sE = Math.sin(E);
    const r = a * (1 - e * cE);
    const b = a * Math.sqrt(1 - e * e);
    px = a * (cE - e);
    py = b * sE;
    const k = Math.sqrt(mu * a) / r;
    vx = -k * sE;
    vy = k * Math.sqrt(1 - e * e) * cE;
  } else {
    // Hyperbolic: a < 0
    const H = solveKeplerHyperbolic(M, e);
    const cH = Math.cosh(H), sH = Math.sinh(H);
    const r = a * (1 - e * cH); // positive since a<0 and e cosh H > 1
    px = a * (cH - e);
    py = -a * Math.sqrt(e * e - 1) * sH;
    const dHdt = n / (e * cH - 1);
    vx = a * sH * dHdt;
    vy = -a * Math.sqrt(e * e - 1) * cH * dHdt;
  }
  return {
    r: perifocalToReference([px, py, 0], i, om, w),
    v: perifocalToReference([vx, vy, 0], i, om, w),
  };
}

/** Position only (AU) from elements at JD. */
export function elementsToPosition(el, mu, jd) {
  return elementsToState(el, mu, jd).r;
}

/**
 * Sample the orbit path (closed ellipse, or hyperbolic arc out to rMax) as an array of [x,y,z] in the parent frame.
 * Elliptic: uniformly in eccentric anomaly (denser near periapsis in true anomaly terms where needed).
 */
export function orbitPath(el, mu, segments = 256, rMax = 100) {
  const { a, e, i, om, w } = el;
  const pts = [];
  if (e < 1) {
    const b = a * Math.sqrt(1 - e * e);
    for (let k = 0; k <= segments; k++) {
      const E = (k / segments) * 2 * Math.PI;
      pts.push(perifocalToReference([a * (Math.cos(E) - e), b * Math.sin(E), 0], i, om, w));
    }
  } else {
    // r = a(1 - e cosh H) -> cosh H = (1 - r/a)/e
    const Hmax = Math.acosh(Math.max(1, (1 - rMax / a) / e));
    for (let k = 0; k <= segments; k++) {
      const H = -Hmax + (2 * Hmax * k) / segments;
      pts.push(perifocalToReference([a * (Math.cosh(H) - e), -a * Math.sqrt(e * e - 1) * Math.sinh(H), 0], i, om, w));
    }
  }
  return pts;
}

/**
 * Classical elements from a state vector (r in AU, v in AU/day) at JD `jd`.
 * Returns { a, e, i, om, w, M, epoch, n, rp, ra, period, nu }.
 */
export function stateToElements(r, v, mu, jd) {
  const rn = Math.hypot(r[0], r[1], r[2]);
  const vn2 = v[0] * v[0] + v[1] * v[1] + v[2] * v[2];
  const h = [r[1] * v[2] - r[2] * v[1], r[2] * v[0] - r[0] * v[2], r[0] * v[1] - r[1] * v[0]];
  const hn = Math.hypot(h[0], h[1], h[2]);
  const nvec = [-h[1], h[0], 0];
  const nn = Math.hypot(nvec[0], nvec[1], nvec[2]);
  const rdotv = r[0] * v[0] + r[1] * v[1] + r[2] * v[2];
  const evec = [
    ((vn2 - mu / rn) * r[0] - rdotv * v[0]) / mu,
    ((vn2 - mu / rn) * r[1] - rdotv * v[1]) / mu,
    ((vn2 - mu / rn) * r[2] - rdotv * v[2]) / mu,
  ];
  const e = Math.hypot(evec[0], evec[1], evec[2]);
  const energy = vn2 / 2 - mu / rn;
  const a = Math.abs(energy) > 1e-16 ? -mu / (2 * energy) : Infinity;
  const i = Math.acos(Math.min(1, Math.max(-1, h[2] / hn)));
  let om = 0, w = 0, nu;
  const circular = e < 1e-10, equatorial = nn < 1e-12;
  if (!equatorial) {
    om = Math.atan2(nvec[1], nvec[0]);
    om = wrapRad(om);
  }
  if (!circular) {
    if (!equatorial) {
      const cw = (nvec[0] * evec[0] + nvec[1] * evec[1]) / (nn * e);
      w = Math.acos(Math.min(1, Math.max(-1, cw)));
      if (evec[2] < 0) w = 2 * Math.PI - w;
    } else {
      w = Math.atan2(evec[1], evec[0]);
      if (h[2] < 0) w = 2 * Math.PI - w;
      w = wrapRad(w);
    }
    const cnu = (evec[0] * r[0] + evec[1] * r[1] + evec[2] * r[2]) / (e * rn);
    nu = Math.acos(Math.min(1, Math.max(-1, cnu)));
    if (rdotv < 0) nu = 2 * Math.PI - nu;
  } else {
    // circular: measure from node (or x axis)
    if (!equatorial) {
      const c = (nvec[0] * r[0] + nvec[1] * r[1] + nvec[2] * r[2]) / (nn * rn);
      nu = Math.acos(Math.min(1, Math.max(-1, c)));
      if (r[2] < 0) nu = 2 * Math.PI - nu;
    } else {
      nu = Math.atan2(r[1], r[0]);
      if (h[2] < 0) nu = 2 * Math.PI - nu;
      nu = wrapRad(nu);
    }
  }
  let M;
  if (e < 1) {
    const E = 2 * Math.atan2(Math.sqrt(1 - e) * Math.sin(nu / 2), Math.sqrt(1 + e) * Math.cos(nu / 2));
    M = wrapRad(E - e * Math.sin(E));
  } else {
    const H = 2 * Math.atanh(Math.sqrt((e - 1) / (e + 1)) * Math.tan(nu / 2));
    M = e * Math.sinh(H) - H;
  }
  const n = meanMotion(a, mu);
  return {
    a, e, i, om, w, M, epoch: jd, n, nu,
    rp: a * (1 - e), ra: e < 1 ? a * (1 + e) : Infinity,
    period: periodDays(a, mu),
  };
}
