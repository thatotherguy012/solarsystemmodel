// Planetary ephemeris: JPL/Standish Keplerian elements (Table 2a/2b, valid 3000 BC - 3000 AD),
// heliocentric, mean ecliptic & equinox of J2000. Plus a truncated Meeus lunar series for the Moon.
// Source: https://ssd.jpl.nasa.gov/planets/approx_pos.html (verified against the live page, 2026-10).
import { DEG, GM_SUN, wrapRad } from './constants.js';
import { solveKeplerElliptic, perifocalToReference } from './kepler.js';
import { jdToT } from './time.js';
import { vsub, vscale, rotX } from './vec3.js';

// [a, e, I, L, longPeri, longNode] and per-century rates; optional [b, c, s, f] extra terms for M.
export const PLANET_ELEMENTS = {
  mercury: { el: [0.38709843, 0.20563661, 7.00559432, 252.25166724, 77.45771895, 48.33961819], rate: [0.00000000, 0.00002123, -0.00590158, 149472.67486623, 0.15940013, -0.12214182] },
  venus:   { el: [0.72332102, 0.00676399, 3.39777545, 181.97970850, 131.76755713, 76.67261496], rate: [-0.00000026, -0.00005107, 0.00043494, 58517.81560260, 0.05679648, -0.27274174] },
  emb:     { el: [1.00000018, 0.01673163, -0.00054346, 100.46691572, 102.93005885, -5.11260389], rate: [-0.00000003, -0.00003661, -0.01337178, 35999.37306329, 0.31795260, -0.24123856] },
  mars:    { el: [1.52371243, 0.09336511, 1.85181869, -4.56813164, -23.91744784, 49.71320984], rate: [0.00000097, 0.00009149, -0.00724757, 19140.29934243, 0.45223625, -0.26852431] },
  jupiter: { el: [5.20248019, 0.04853590, 1.29861416, 34.33479152, 14.27495244, 100.29282654], rate: [-0.00002864, 0.00018026, -0.00322699, 3034.90371757, 0.18199196, 0.13024619], extra: [-0.00012452, 0.06064060, -0.35635438, 38.35125000] },
  saturn:  { el: [9.54149883, 0.05550825, 2.49424102, 50.07571329, 92.86136063, 113.63998702], rate: [-0.00003065, -0.00032044, 0.00451969, 1222.11494724, 0.54179478, -0.25015002], extra: [0.00025899, -0.13434469, 0.87320147, 38.35125000] },
  uranus:  { el: [19.18797948, 0.04685740, 0.77298127, 314.20276625, 172.43404441, 73.96250215], rate: [-0.00020455, -0.00001550, -0.00180155, 428.49512595, 0.09266985, 0.05739699], extra: [0.00058331, -0.97731848, 0.17689245, 7.67025000] },
  neptune: { el: [30.06952752, 0.00895439, 1.77005520, 304.22289287, 46.68158724, 131.78635853], rate: [0.00006447, 0.00000818, 0.00022400, 218.46515314, 0.01009938, -0.00606302], extra: [-0.00041348, 0.68346318, -0.10162547, 7.67025000] },
};

/**
 * Elements (radians, AU) for a planet key ('mercury','venus','emb','mars',...,'neptune') at JD.
 * M is already evaluated at `jd` (n = 0, epoch = jd), suitable for elementsToState/orbitPath.
 */
export function planetElementsAt(key, jd) {
  const P = PLANET_ELEMENTS[key];
  const T = jdToT(jd);
  const a = P.el[0] + P.rate[0] * T;
  const e = P.el[1] + P.rate[1] * T;
  const I = (P.el[2] + P.rate[2] * T) * DEG;
  const L = (P.el[3] + P.rate[3] * T) * DEG;
  const lp = (P.el[4] + P.rate[4] * T) * DEG;
  const ln = (P.el[5] + P.rate[5] * T) * DEG;
  const w = lp - ln;
  let M = L - lp;
  if (P.extra) {
    const [b, c, s, f] = P.extra;
    const fT = f * T * DEG;
    M += (b * T * T + c * Math.cos(fT) + s * Math.sin(fT)) * DEG;
  }
  return { a, e, i: I, om: wrapRad(ln), w: wrapRad(w), M: wrapRad(M), epoch: jd, n: 0 };
}

/** Heliocentric ecliptic J2000 position (AU) of planet (or 'emb') at JD. */
export function planetPosition(key, jd) {
  const el = planetElementsAt(key, jd);
  const { a, e, i, om, w, M } = el;
  const E = solveKeplerElliptic(M, e);
  const cE = Math.cos(E), sE = Math.sin(E);
  const px = a * (cE - e), py = a * Math.sqrt(1 - e * e) * sE;
  return perifocalToReference([px, py, 0], i, om, w);
}

const VEL_STEP_DAYS = 0.02;

/**
 * Heliocentric ecliptic J2000 state of planet (or 'emb') at JD. Returns { r (AU), v (AU/day) }.
 * Velocity is a central finite difference of the position so that it includes the time-derivative of the
 * secular element rates and the Jupiter-Neptune periodic terms (the pure two-body velocity is off by a few m/s).
 */
export function planetState(key, jd) {
  const r = planetPosition(key, jd);
  const rp = planetPosition(key, jd + VEL_STEP_DAYS), rm = planetPosition(key, jd - VEL_STEP_DAYS);
  const k = 1 / (2 * VEL_STEP_DAYS);
  return { r, v: [(rp[0] - rm[0]) * k, (rp[1] - rm[1]) * k, (rp[2] - rm[2]) * k] };
}

// ---------------- Moon (geocentric), truncated Meeus Ch. 47 series ----------------
// Terms: [D, M, M', F, lonCoeff (1e-6 deg), distCoeff (1e-3 km)].
const LR_TERMS = [
  [0, 0, 1, 0, 6288774, -20905355], [2, 0, -1, 0, 1274027, -3699111], [2, 0, 0, 0, 658314, -2955968],
  [0, 0, 2, 0, 213618, -569925], [0, 1, 0, 0, -185116, 48888], [0, 0, 0, 2, -114332, -3149],
  [2, 0, -2, 0, 58793, 246158], [2, -1, -1, 0, 57066, -152138], [2, 0, 1, 0, 53322, -170733],
  [2, -1, 0, 0, 45758, -204586], [0, 1, -1, 0, -40923, -129620], [1, 0, 0, 0, -34720, 108743],
  [0, 1, 1, 0, -30383, 104755], [2, 0, 0, -2, 15327, 10321], [0, 0, 1, 2, -12528, 0],
  [0, 0, 1, -2, 10980, 79661], [4, 0, -1, 0, 10675, -34782], [0, 0, 3, 0, 10034, -23210],
  [4, 0, -2, 0, 8548, -21636], [2, 1, -1, 0, -7888, 24208], [2, 1, 0, 0, -6766, 30824],
  [1, 0, -1, 0, -5163, -8379], [1, 1, 0, 0, 4987, -16675], [2, -1, 1, 0, 4036, -12831],
  [2, 0, 2, 0, 3994, -10445], [4, 0, 0, 0, 3861, -11650], [2, 0, -3, 0, 3665, 14403],
  [0, 1, -2, 0, -2689, -7003], [2, 0, -1, 2, -2602, 0], [2, -1, -2, 0, 2390, 10056],
  [1, 0, 1, 0, -2348, 6322], [2, -2, 0, 0, 2236, -9884], [0, 1, 2, 0, -2120, 5751],
  [0, 2, 0, 0, -2069, 0], [2, -2, -1, 0, 2048, -4950], [2, 0, 1, -2, -1773, 4130],
  [2, 0, 0, 2, -1595, 0], [4, -1, -1, 0, 1215, -3958], [0, 0, 2, 2, -1110, 0],
  [3, 0, -1, 0, -892, 3258], [2, 1, 1, 0, -810, 2616], [4, -1, -2, 0, 759, -1897],
  [0, 2, -1, 0, -713, -2117], [2, 2, -1, 0, -700, 2354], [2, 1, -2, 0, 691, 0],
  [2, -1, 0, -2, 596, 0], [4, 0, 1, 0, 549, -1423], [0, 0, 4, 0, 537, -1117],
  [4, -1, 0, 0, 520, -1571], [1, 0, -2, 0, -487, -1739], [2, 1, 0, -2, -399, 0],
  [0, 0, 2, -2, -381, -4421], [1, 1, 1, 0, 351, 0], [3, 0, -2, 0, -340, 0],
  [4, 0, -3, 0, 330, 0], [2, -1, 2, 0, 327, 0], [0, 2, 1, 0, -323, 1165],
  [1, 1, -1, 0, 299, 0], [2, 0, 3, 0, 294, 0], [2, 0, -1, -2, 0, 8752],
];
// Terms: [D, M, M', F, latCoeff (1e-6 deg)].
const B_TERMS = [
  [0, 0, 0, 1, 5128122], [0, 0, 1, 1, 280602], [0, 0, 1, -1, 277693], [2, 0, 0, -1, 173237],
  [2, 0, -1, 1, 55413], [2, 0, -1, -1, 46271], [2, 0, 0, 1, 32573], [0, 0, 2, 1, 17198],
  [2, 0, 1, -1, 9266], [0, 0, 2, -1, 8822], [2, -1, 0, -1, 8216], [2, 0, -2, -1, 4324],
  [2, 0, 1, 1, 4200], [2, 1, 0, -1, -3359], [2, -1, -1, 1, 2463], [2, -1, 0, 1, 2211],
  [2, -1, -1, -1, 2065], [0, 1, -1, -1, -1870], [4, 0, -1, -1, 1828], [0, 1, 0, 1, -1794],
  [0, 0, 0, 3, -1749], [0, 1, -1, 1, -1565], [1, 0, 0, 1, -1491], [0, 1, 1, 1, -1475],
  [0, 1, 1, -1, -1410], [0, 1, 0, -1, -1344], [1, 0, 0, -1, -1335], [0, 0, 3, 1, 1107],
  [4, 0, 0, -1, 1021], [4, 0, -1, 1, 833], [0, 0, 1, -3, 777], [4, 0, -2, 1, 671],
  [2, 0, 0, -3, 607], [2, 0, 2, -1, 596], [2, -1, 1, -1, 491], [2, 0, -2, 1, -451],
  [0, 0, 3, -1, 439], [2, 0, 2, 1, 422], [2, 0, -3, -1, 421], [2, 1, -1, 1, -366],
  [2, 1, 0, 1, -351], [4, 0, 0, 1, 331], [2, -1, 1, 1, 315], [2, -2, 0, -1, -283],
  [1, 1, 0, -1, -229],
];

/**
 * Geocentric position of the Moon in the ecliptic J2000 frame (AU), accuracy ~0.01-0.05 deg.
 * Returns { r: [x,y,z] AU, lonDeg, latDeg, distKm } (lon/lat are of-date values).
 */
export function moonGeocentric(jd) {
  const T = jdToT(jd);
  const Lp = (218.3164477 + 481267.88123421 * T - 0.0015786 * T * T + T * T * T / 538841) * DEG;
  const D = (297.8501921 + 445267.1114034 * T - 0.0018819 * T * T + T * T * T / 545868) * DEG;
  const M = (357.5291092 + 35999.0502909 * T - 0.0001536 * T * T + T * T * T / 24490000) * DEG;
  const Mp = (134.9633964 + 477198.8675055 * T + 0.0087414 * T * T + T * T * T / 69699) * DEG;
  const F = (93.2720950 + 483202.0175233 * T - 0.0036539 * T * T - T * T * T / 3526000) * DEG;
  const A1 = (119.75 + 131.849 * T) * DEG;
  const A2 = (53.09 + 479264.290 * T) * DEG;
  const A3 = (313.45 + 481266.484 * T) * DEG;
  const E = 1 - 0.002516 * T - 0.0000074 * T * T;
  const E2 = E * E;
  let sl = 0, sr = 0, sb = 0;
  for (const t of LR_TERMS) {
    const arg = t[0] * D + t[1] * M + t[2] * Mp + t[3] * F;
    const ef = Math.abs(t[1]) === 2 ? E2 : (Math.abs(t[1]) === 1 ? E : 1);
    sl += t[4] * ef * Math.sin(arg);
    sr += t[5] * ef * Math.cos(arg);
  }
  for (const t of B_TERMS) {
    const arg = t[0] * D + t[1] * M + t[2] * Mp + t[3] * F;
    const ef = Math.abs(t[1]) === 2 ? E2 : (Math.abs(t[1]) === 1 ? E : 1);
    sb += t[4] * ef * Math.sin(arg);
  }
  sl += 3958 * Math.sin(A1) + 1962 * Math.sin(Lp - F) + 318 * Math.sin(A2);
  sb += -2235 * Math.sin(Lp) + 382 * Math.sin(A3) + 175 * Math.sin(A1 - F) + 175 * Math.sin(A1 + F) + 127 * Math.sin(Lp - Mp) - 115 * Math.sin(Lp + Mp);
  const lonDate = Lp / DEG + sl / 1e6; // deg, mean equinox of date
  const latDeg = sb / 1e6;
  const distKm = 385000.56 + sr / 1000;
  // Approximate precession from equinox of date back to J2000 (general precession in longitude ~1.3969713 deg/century).
  const lonJ2000 = lonDate - 1.3969713 * T;
  const lam = lonJ2000 * DEG, bet = latDeg * DEG;
  const dAu = distKm / 149597870.7;
  return {
    r: [dAu * Math.cos(bet) * Math.cos(lam), dAu * Math.cos(bet) * Math.sin(lam), dAu * Math.sin(bet)],
    lonDeg: lonDate, latDeg, distKm,
  };
}

/** Mean lunar orbital elements (for drawing the orbit ellipse): a (AU), e, i, om, w, M (rad), n (rad/day) at JD. */
export function moonMeanElements(jd) {
  const T = jdToT(jd);
  const Lp = 218.3164477 + 481267.88123421 * T;
  const Mp = 134.9633964 + 477198.8675055 * T;
  const Om = 125.0445479 - 1934.1362891 * T;
  const varpi = Lp - Mp;
  return {
    a: 384400 / 149597870.7, e: 0.0549, i: 5.145 * DEG,
    om: wrapRad((Om - 1.3969713 * T) * DEG), w: wrapRad((varpi - Om) * DEG),
    M: wrapRad(Mp * DEG), epoch: jd, n: 13.0649929509 * DEG,
  };
}

/** Earth/Moon mass ratio used to offset Earth from the Earth-Moon barycenter. */
export const EARTH_MOON_MASS_RATIO = 81.30056907;

/** Heliocentric ecliptic J2000 state of Earth itself (barycenter corrected). */
export function earthState(jd) {
  const emb = planetState('emb', jd);
  const moon = moonGeocentric(jd).r;
  const f = 1 / (1 + EARTH_MOON_MASS_RATIO);
  return { r: vsub(emb.r, vscale(moon, f)), v: emb.v };
}

/** Equatorial (ICRF/J2000) -> ecliptic J2000 rotation of a vector. */
export function equatorialToEcliptic(v) { return rotX(v, -23.4392911 * DEG); }
/** Ecliptic J2000 -> equatorial (ICRF/J2000). */
export function eclipticToEquatorial(v) { return rotX(v, 23.4392911 * DEG); }
