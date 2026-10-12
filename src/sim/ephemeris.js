// Ephemeris engine for natural bodies: heliocentric ecliptic J2000 states (AU, AU/day) for any catalog id
// at any JD, orbit elements/paths for drawing, and GM lookups. See DESIGN.md §4.
import { GM_SUN, gmToAuDay, kmToAu, DEG } from '../astro/constants.js';
import { vadd, vsub, vscale, vcross, vnorm } from '../astro/vec3.js';
import { elementsToState, stateToElements, solveKeplerElliptic, perifocalToReference, orbitPath, meanMotion } from '../astro/kepler.js';
import { planetState, planetElementsAt, earthState, moonGeocentric, equatorialToEcliptic, PLANET_ELEMENTS } from '../astro/planets.js';
import { soiRadius } from '../astro/nbody.js';

/** @type {Map<string, import('../data/catalog.js').BodyDescriptor>} */
const bodies = new Map();
/** id -> array of child moon ids */
const children = new Map();

// ---- memoization: small LRU of per-JD maps (render loop, inspector and custom objects share a JD) ----
const MAX_JD_CACHES = 24;
/** @type {Map<number, Map<string, {r:number[], v:number[]}>>} */
const stateCache = new Map();

function cacheFor(jd) {
  let m = stateCache.get(jd);
  if (m) return m;
  m = new Map();
  stateCache.set(jd, m);
  if (stateCache.size > MAX_JD_CACHES) stateCache.delete(stateCache.keys().next().value);
  return m;
}

/**
 * Register the catalog. Must be called once before any other function.
 * @param {import('../data/catalog.js').BodyDescriptor[]} list
 */
export function initEphemeris(list) {
  bodies.clear();
  children.clear();
  stateCache.clear();
  perturbers = null;
  for (const b of list) bodies.set(b.id, b);
  for (const b of list) {
    if (b.parent && b.type === 'moon') {
      if (!children.has(b.parent)) children.set(b.parent, []);
      children.get(b.parent).push(b.id);
    }
  }
}

/** @returns {import('../data/catalog.js').BodyDescriptor|undefined} */
export const getBody = (id) => bodies.get(id);
export const hasBody = (id) => bodies.has(id);
/** All natural bodies (insertion order: Sun, planets, small bodies, moons). */
export const allBodies = () => [...bodies.values()];
/** Moon ids orbiting `id`. */
export const moonsOf = (id) => children.get(id) ?? [];

/**
 * GM of a body in AU^3/day^2. When the GM is unknown it is estimated from the radius assuming a bulk density
 * of 2000 kg/m^3 (GM = G * 4/3 pi r^3 rho).
 */
export function getMu(id) {
  if (id === 'sun') return GM_SUN;
  const b = bodies.get(id);
  if (!b) return 0;
  if (b.gmKm3S2 != null && b.gmKm3S2 > 0) return gmToAuDay(b.gmKm3S2);
  const rM = b.radiusKm * 1000;
  const massKg = (4 / 3) * Math.PI * rM * rM * rM * 2000;
  const gmKm3S2 = 6.6743e-20 * massKg;
  return gmToAuDay(gmKm3S2);
}

/** True if the body's GM is an estimate from its size. */
export function isMuEstimated(id) {
  const b = bodies.get(id);
  return !!b && id !== 'sun' && !(b.gmKm3S2 > 0);
}

/**
 * Effective two-body mu for a Kepler body, chosen so velocities are consistent with the tabulated mean
 * motion (n^2 a^3, which equals G(M_parent + M_body) for a well-fitted orbit).
 */
function keplerMu(b) {
  const el = b.ephem.elements;
  return el.n * el.n * Math.abs(el.a * el.a * el.a);
}

function computeState(b, jd) {
  const eph = b.ephem;
  switch (eph.kind) {
    case 'sun':
      return { r: [0, 0, 0], v: [0, 0, 0] };
    case 'planet':
      return planetState(eph.key, jd);
    case 'earth':
      return earthState(jd);
    case 'moon-earth': {
      const e = getState('earth', jd);
      const g = moonGeocentric(jd).r;
      const h = 0.01;
      const gp = moonGeocentric(jd + h).r, gm = moonGeocentric(jd - h).r;
      const vrel = vscale(vsub(gp, gm), 1 / (2 * h));
      return { r: vadd(e.r, g), v: vadd(e.v, vrel) };
    }
    case 'kepler': {
      const rel = elementsToState(eph.elements, keplerMu(b), jd);
      if (eph.muKey === 'sun' || !b.parent || b.parent === 'sun') return rel;
      const p = getState(b.parent, jd);
      return { r: vadd(p.r, rel.r), v: vadd(p.v, rel.v) };
    }
    default:
      return { r: [0, 0, 0], v: [0, 0, 0] };
  }
}

/**
 * Heliocentric ecliptic J2000 state of a natural body.
 * @param {string} id
 * @param {number} jd
 * @returns {{r:number[], v:number[]}} AU, AU/day (shared cached object: do not mutate)
 */
export function getState(id, jd) {
  const cache = cacheFor(jd);
  let s = cache.get(id);
  if (s) return s;
  const b = bodies.get(id);
  if (!b) return { r: [0, 0, 0], v: [0, 0, 0] };
  s = computeState(b, jd);
  cache.set(id, s);
  return s;
}

/**
 * Like getState but bypassing the per-JD memo (for solvers that probe many distinct times, which would otherwise
 * evict the render loop's cache entries).
 */
export function getStateUncached(id, jd) {
  const b = bodies.get(id);
  if (!b) return { r: [0, 0, 0], v: [0, 0, 0] };
  if (b.ephem.kind === 'kepler' && b.parent && b.parent !== 'sun') {
    const rel = elementsToState(b.ephem.elements, keplerMu(b), jd);
    const p = getStateUncached(b.parent, jd);
    return { r: vadd(p.r, rel.r), v: vadd(p.v, rel.v) };
  }
  if (b.ephem.kind === 'moon-earth') {
    const e = earthState(jd);
    const g = moonGeocentric(jd).r;
    const h = 0.01;
    const vrel = vscale(vsub(moonGeocentric(jd + h).r, moonGeocentric(jd - h).r), 1 / (2 * h));
    return { r: vadd(e.r, g), v: vadd(e.v, vrel) };
  }
  return computeState(b, jd);
}

/** Heliocentric position (AU). */
export function getPosition(id, jd) {
  return getState(id, jd).r;
}

/** State relative to the body's parent (or the Sun). */
export function getRelativeState(id, jd) {
  const b = bodies.get(id);
  const s = getState(id, jd);
  if (!b || !b.parent || b.parent === 'sun') return { r: s.r, v: s.v, center: 'sun' };
  const p = getState(b.parent, jd);
  return { r: vsub(s.r, p.r), v: vsub(s.v, p.v), center: b.parent };
}

/** Unit normal of the secondary's orbit about its parent (ecliptic north for the Sun). */
export function getOrbitNormal(secondaryId, jd) {
  const rel = getRelativeState(secondaryId, jd);
  const n = vnorm(vcross(rel.r, rel.v));
  return n[0] === 0 && n[1] === 0 && n[2] === 0 ? [0, 0, 1] : n;
}

/**
 * Orbit elements used for drawing the orbit of `id` and the mu that goes with them.
 * Planets: Standish elements at jd (Earth: Earth-Moon barycenter orbit). Moon: osculating geocentric
 * elements (so the drawn ellipse passes through the Moon). Kepler bodies: their fixed elements.
 * @returns {{center:string, el:Object, mu:number}|null}
 */
export function getOrbitElements(id, jd) {
  const b = bodies.get(id);
  if (!b) return null;
  const eph = b.ephem;
  switch (eph.kind) {
    case 'planet':
      return { center: 'sun', el: planetElementsAt(eph.key, jd), mu: GM_SUN };
    case 'earth':
      return { center: 'sun', el: planetElementsAt('emb', jd), mu: GM_SUN };
    case 'moon-earth': {
      const rel = getRelativeState('moon', jd);
      const mu = getMu('earth') + getMu('moon');
      const el = stateToElements(rel.r, rel.v, mu, jd);
      return { center: 'earth', el, mu };
    }
    case 'kepler':
      return { center: b.parent ?? 'sun', el: eph.elements, mu: keplerMu(b) };
    default:
      return null;
  }
}

/** Mean anomaly of elements `el` at jd. */
export function meanAnomalyAt(el, mu, jd) {
  const n = el.n ?? meanMotion(el.a, mu);
  return el.M + n * (jd - el.epoch);
}

/**
 * Sample an orbit for drawing, with vertices concentrated around the body's current position so the line
 * passes through the body even when zoomed far in (one vertex sits exactly at the current anomaly).
 * @param {Object} el elements
 * @param {number} mu
 * @param {number} jd current time
 * @param {number} [segments]
 * @returns {{points:number[][], E:number}} points relative to the centre; E = eccentric anomaly of the body
 */
export function sampleOrbit(el, mu, jd, segments = 720) {
  const { a, e, i, om, w } = el;
  if (!(e < 1) || !(a > 0)) {
    const rMax = Math.min(2000, 1.5 * Math.abs(a) * (1 + e));
    return { points: orbitPath(el, mu, segments, Math.max(rMax, 1e-6)), E: 0 };
  }
  const E0 = solveKeplerElliptic(meanAnomalyAt(el, mu, jd), e);
  const b = a * Math.sqrt(1 - e * e);
  const pts = new Array(segments + 1);
  for (let k = 0; k <= segments; k++) {
    const s = (2 * k) / segments - 1; // -1..1
    const h = 0.12 * s + 0.88 * s * s * s; // dense near s = 0 (the body)
    const E = E0 + Math.PI * h;
    pts[k] = perifocalToReference([a * (Math.cos(E) - e), b * Math.sin(E), 0], i, om, w);
  }
  return { points: pts, E: E0 };
}

/**
 * Orbit path of a natural body: points in the parent's frame (AU, relative to `center`).
 * @returns {{center:string, points:number[][], el:Object, mu:number, E:number}|null}
 */
export function getOrbitPath(id, jd, segments = 720) {
  const o = getOrbitElements(id, jd);
  if (!o) return null;
  const s = sampleOrbit(o.el, o.mu, jd, segments);
  return { center: o.center, points: s.points, el: o.el, mu: o.mu, E: s.E };
}

/**
 * Inclination and node (radians, ecliptic J2000) of a body's equatorial plane, from its IAU pole.
 * Used for "equatorial" orbit presets (e.g. geostationary). Returns null when the pole is unknown.
 */
export function equatorialPlane(id) {
  const b = bodies.get(id);
  if (!b || !b.pole) return null;
  const ra = b.pole.ra * DEG, dec = b.pole.dec * DEG;
  const p = equatorialToEcliptic([Math.cos(dec) * Math.cos(ra), Math.cos(dec) * Math.sin(ra), Math.sin(dec)]);
  const i = Math.acos(Math.max(-1, Math.min(1, p[2])));
  let om = Math.atan2(p[0], -p[1]);
  if (om < 0) om += 2 * Math.PI;
  return { i, om, pole: p };
}

/** Clear all memoized states (e.g. after the catalog changes). */
export function clearEphemerisCache() {
  stateCache.clear();
}

// ------------------------------------------------------------------ N-body perturbers

/** The eight planet systems that perturb transfer trajectories: app body id -> Standish element key. */
const PERTURBER_KEYS = [
  ['mercury', 'mercury'], ['venus', 'venus'], ['earth', 'emb'], ['mars', 'mars'],
  ['jupiter', 'jupiter'], ['saturn', 'saturn'], ['uranus', 'uranus'], ['neptune', 'neptune'],
];
/** Ids of the perturbing planet systems. */
export const PERTURBER_IDS = new Set(PERTURBER_KEYS.map(([id]) => id));
/** @type {Object[]|null} */
let perturbers = null;

/**
 * Perturber set for src/astro/nbody.js (built once): the 8 planet systems with
 * `{ id, gm (AU^3/day^2), radiusAu, soiAu, state(jd) -> {r, v} }` (heliocentric).
 * Earth and the Moon act as one perturber with their combined GM at the Earth-Moon barycentre.
 */
export function getPerturbers() {
  if (perturbers) return perturbers;
  perturbers = PERTURBER_KEYS.map(([id, key]) => {
    const b = bodies.get(id);
    let gmKm = b.gmKm3S2;
    if (id === 'earth') gmKm += bodies.get('moon')?.gmKm3S2 ?? 4902.8;
    const gm = gmToAuDay(gmKm);
    return { id, gm, radiusAu: kmToAu(b.radiusKm), soiAu: soiRadius(PLANET_ELEMENTS[key].el[0], gm), state: (jd) => planetState(key, jd) };
  });
  return perturbers;
}

/** The perturber record for a planet id, or undefined. */
export const getPerturber = (id) => getPerturbers().find((p) => p.id === id);

/**
 * Map a route-stop reference to the perturber whose gravity is switched off near that endpoint
 * (patched-conic endpoint exclusion): a planet -> itself; a moon -> its planet; a custom object whose motion is an
 * orbit / co-location about X (or a Lagrange point of a pair, see below) -> X's perturber; small bodies, the Sun,
 * fixed points and anything else -> null. A Lagrange point maps to its planet: the secondary for Sun-planet pairs,
 * otherwise the primary (Earth-Moon L2 -> Earth).
 * @param {string|null} ref
 * @param {(id:string)=>Object|undefined} [lookupCustom] resolves custom-object ids (e.g. id => ctx.byId.get(id))
 * @returns {string|null}
 */
export function perturberIdFor(ref, lookupCustom = null, depth = 0) {
  if (!ref || depth > 4) return null;
  if (PERTURBER_IDS.has(ref)) return ref;
  const b = bodies.get(ref);
  if (b) return b.type === 'moon' && PERTURBER_IDS.has(b.parent) ? b.parent : null;
  const m = lookupCustom?.(ref)?.motion;
  if (!m) return null;
  if (m.kind === 'orbit' || m.kind === 'colocated') return perturberIdFor(m.parent, lookupCustom, depth + 1);
  if (m.kind === 'lagrange') return perturberIdFor(m.primary === 'sun' ? m.secondary : m.primary, lookupCustom, depth + 1);
  return null;
}
