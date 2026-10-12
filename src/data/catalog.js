// Unified natural-body catalog: hard-coded Sun & planets (DESIGN.md §3.3) merged with the generated
// small-body (SBDB) and moon (Horizons) data. Produces one array of body descriptors (§4).
import { AU_KM, DEG } from '../astro/constants.js';
import smallBodyData from './smallbodies.json' with { type: 'json' };
import moonData from './moons.json' with { type: 'json' };

/**
 * @typedef {Object} BodyDescriptor
 * @property {string} id
 * @property {string} name
 * @property {'star'|'planet'|'moon'|'dwarf'|'asteroid'|'trojan'|'neo'|'centaur'|'comet'} type
 * @property {string|null} parent
 * @property {number} radiusKm
 * @property {number|null} gmKm3S2
 * @property {string} color
 * @property {string} [designation]
 * @property {string} [orbitClass]
 * @property {number|null} [rotationHours]
 * @property {{ra:number, dec:number}} [pole]  IAU spin-pole RA/Dec (deg, ICRF) for equatorial orbit presets
 * @property {Object} ephem  { kind:'sun' } | { kind:'planet', key } | { kind:'earth' } | { kind:'moon-earth' } | { kind:'kepler', elements, muKey }
 */

/** Sun & planets (radius km, GM km^3/s^2, display colour). Poles: IAU WGCCRE 2015 (J2000). */
const PLANETS = [
  { id: 'sun', name: 'Sun', type: 'star', radiusKm: 695700, gmKm3S2: 1.32712440018e11, color: '#fff1c9', rotationHours: 609.12, pole: { ra: 286.13, dec: 63.87 }, ephem: { kind: 'sun' } },
  { id: 'mercury', name: 'Mercury', radiusKm: 2439.7, gmKm3S2: 22031.78, color: '#9c9088', rotationHours: 1407.6, pole: { ra: 281.0103, dec: 61.4155 }, key: 'mercury' },
  { id: 'venus', name: 'Venus', radiusKm: 6051.8, gmKm3S2: 324858.6, color: '#e6c89c', rotationHours: -5832.5, pole: { ra: 272.76, dec: 67.16 }, key: 'venus' },
  { id: 'earth', name: 'Earth', radiusKm: 6371.0, gmKm3S2: 398600.4418, color: '#4f8fd9', rotationHours: 23.9345, pole: { ra: 0, dec: 90 }, ephem: { kind: 'earth' } },
  { id: 'moon', name: 'Moon', type: 'moon', parent: 'earth', radiusKm: 1737.4, gmKm3S2: 4902.8, color: '#b8b8b8', rotationHours: 655.72, pole: { ra: 266.86, dec: 65.64 }, ephem: { kind: 'moon-earth' } },
  { id: 'mars', name: 'Mars', radiusKm: 3389.5, gmKm3S2: 42828.37, color: '#d1693f', rotationHours: 24.6229, pole: { ra: 317.269, dec: 54.433 }, key: 'mars' },
  { id: 'jupiter', name: 'Jupiter', radiusKm: 69911, gmKm3S2: 126686534, color: '#d8b48a', rotationHours: 9.925, pole: { ra: 268.057, dec: 64.495 }, key: 'jupiter' },
  { id: 'saturn', name: 'Saturn', radiusKm: 58232, gmKm3S2: 37931187, color: '#e3d1a0', rotationHours: 10.656, pole: { ra: 40.589, dec: 83.537 }, key: 'saturn',
    rings: [ // km; C, B, A rings (Cassini division between B and A)
      { inner: 74500, outer: 92000, opacity: 0.22 },
      { inner: 92000, outer: 117580, opacity: 0.62 },
      { inner: 122170, outer: 136780, opacity: 0.45 },
    ] },
  { id: 'uranus', name: 'Uranus', radiusKm: 25362, gmKm3S2: 5793939, color: '#9fd7e3', rotationHours: -17.24, pole: { ra: 257.311, dec: -15.175 }, key: 'uranus' },
  { id: 'neptune', name: 'Neptune', radiusKm: 24622, gmKm3S2: 6836529, color: '#4b70dd', rotationHours: 16.11, pole: { ra: 299.36, dec: 43.46 }, key: 'neptune' },
];

/** Moon display colours (muted greys/tans; a few distinctive ones per §3.4). */
const MOON_COLORS = {
  phobos: '#8f8478', deimos: '#9c9284', io: '#d9c27a', europa: '#d8d2c4', ganymede: '#a99c8a', callisto: '#7f766b',
  amalthea: '#a5735a', himalia: '#8b8580', mimas: '#bcbab4', enceladus: '#eeeeee', tethys: '#d6d4cf', dione: '#c9c6bf',
  rhea: '#c2bfb8', titan: '#d9a066', hyperion: '#b09e88', iapetus: '#9d927f', phoebe: '#6f6a64', miranda: '#b5b2ac',
  ariel: '#c4c1bb', umbriel: '#8a8782', titania: '#b8afa4', oberon: '#a39a8f', triton: '#c8b8b0', nereid: '#9a958f',
  proteus: '#85817c', charon: '#a8a19a', nix: '#c9c6c1', hydra: '#c2c0bc',
};

/** Body colours per small-body category. */
export const CATEGORY_COLORS = {
  dwarf: '#c9b79c', asteroid: '#a39b80', trojan: '#b0a774', neo: '#c49274', centaur: '#93ad9f', comet: '#8fdde6',
};

/** Orbit-line colours per category (planets use a tint of their own colour, custom objects their colour). */
export const ORBIT_COLORS = {
  moon: '#7d838f', dwarf: '#8c7d5f', asteroid: '#77733f', trojan: '#7f7a3e', neo: '#8a5f48', centaur: '#5e7d70', comet: '#2fa7b8',
};

/** Human-readable category labels. */
export const TYPE_LABELS = {
  star: 'Star', planet: 'Planet', moon: 'Moon', dwarf: 'Dwarf planet', asteroid: 'Main-belt asteroid',
  trojan: 'Jupiter trojan', neo: 'Near-Earth object', centaur: 'Centaur', comet: 'Comet',
};

/**
 * Build the list of natural body descriptors.
 * @returns {BodyDescriptor[]}
 */
export function buildCatalog() {
  /** @type {BodyDescriptor[]} */
  const list = [];
  for (const p of PLANETS) {
    list.push({
      id: p.id, name: p.name, type: p.type ?? 'planet', parent: p.parent ?? (p.id === 'sun' ? null : 'sun'),
      radiusKm: p.radiusKm, gmKm3S2: p.gmKm3S2, color: p.color, rotationHours: p.rotationHours ?? null,
      pole: p.pole, rings: p.rings,
      ephem: p.ephem ?? { kind: 'planet', key: p.key },
    });
  }
  for (const b of smallBodyData.bodies) {
    const el = b.elements;
    const periodDays = el.periodDays ?? (2 * Math.PI) / Math.sqrt(2.9591220828e-4 / Math.abs(el.a ** 3));
    list.push({
      id: b.id, name: b.name, type: b.category, parent: 'sun', radiusKm: b.radiusKm, gmKm3S2: b.gmKm3S2 ?? null,
      color: CATEGORY_COLORS[b.category] ?? '#aaaaaa', designation: b.designation, orbitClass: b.orbitClass,
      rotationHours: b.rotationHours ?? null, albedo: b.albedo ?? null, H: b.H ?? null, epochJd: b.epochJd,
      pole: b.id === 'pluto' ? { ra: 132.993, dec: -6.163 } : undefined,
      ephem: {
        kind: 'kepler', muKey: 'sun',
        elements: {
          a: el.a, e: el.e, i: el.iDeg * DEG, om: el.omDeg * DEG, w: el.wDeg * DEG, M: el.maDeg * DEG,
          epoch: b.epochJd, n: (2 * Math.PI) / periodDays,
        },
      },
    });
  }
  for (const m of moonData.moons) {
    const el = m.elements;
    list.push({
      id: m.id, name: m.name, type: 'moon', parent: m.parent, radiusKm: m.radiusKm, gmKm3S2: m.gmKm3S2 ?? null,
      color: MOON_COLORS[m.id] ?? '#a8a49c', designation: `${m.name} (${m.horizonsId})`, rotationHours: null,
      epochJd: m.epochJd,
      ephem: {
        kind: 'kepler', muKey: m.parent,
        elements: {
          a: el.aKm / AU_KM, e: el.e, i: el.iDeg * DEG, om: el.omDeg * DEG, w: el.wDeg * DEG, M: el.maDeg * DEG,
          epoch: m.epochJd, n: el.nDegPerDay * DEG,
        },
      },
    });
  }
  return list;
}

/** Data provenance for the Help panel. */
export const DATA_INFO = {
  smallBodiesFetchedAt: smallBodyData.fetchedAt,
  moonsFetchedAt: moonData.fetchedAt,
  smallBodyCount: smallBodyData.bodies.length,
  moonCount: moonData.moons.length,
};
