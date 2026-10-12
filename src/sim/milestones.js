// Automatic route milestones, derived from every custom object's route and its computed leg physics:
// departures, arrivals, flips (turnover of constant-thrust legs), flybys, close planetary approaches (inside two
// sphere-of-influence radii) and impacts. Milestones are derived data: they are recomputed (debounced) whenever the
// scenario or a background N-body result changes and are never saved to the scenario.
import { AU_KM, auDayToKmS, auDay2ToMS2, G0_M_S2 } from '../astro/constants.js';
import { vlen, vsub } from '../astro/vec3.js';
import { store } from './store.js';
import { onTrajectoryUpdate } from './trajectory.js';
import { legData, nameOf, positionOf } from './custom.js';
import { ballisticSummary, routeFlybys } from './legPhysics.js';
import { getBody, getPerturbers } from './ephemeris.js';

/** Milestone kinds with display labels (order = typical order along a leg). */
export const MILESTONE_KINDS = {
  depart: 'Departure',
  flip: 'Flip (turnover)',
  approach: 'Close approach',
  impact: 'Impact',
  flyby: 'Flyby',
  arrive: 'Arrival',
};

/** Samples per leg when searching straight / thrust legs for planetary approaches (refined afterwards). */
const APPROACH_SAMPLES = 240;
const DEBOUNCE_MS = 250;

/**
 * @typedef {Object} Milestone
 * @property {string} id       stable id (object id, kind, leg index, extra)
 * @property {number} jd
 * @property {keyof MILESTONE_KINDS} kind
 * @property {string} objId
 * @property {string} objName
 * @property {string} color    the object's colour
 * @property {string} title    e.g. "Ardent departs Earth"
 * @property {string} detail   one-line detail ("for Mars · brachistochrone 0.30 g · 4.62 d")
 * @property {number} leg      leg index (0-based)
 * @property {string|null} [bodyId] body involved (approaches, impacts, flybys)
 */

const kms = (auDay) => {
  const v = auDayToKmS(auDay);
  return `${v >= 100 ? Math.round(v).toLocaleString('en-US') : v.toFixed(v >= 10 ? 1 : 2)} km/s`;
};
const gOf = (aAuDay2) => auDay2ToMS2(aAuDay2) / G0_M_S2;
const fmtGShort = (g) => (g >= 0.01 ? `${g.toFixed(2)} g` : `${g.toPrecision(2)} g`);
const days = (d) => (d < 1 ? `${(d * 24).toFixed(1)} h` : d < 100 ? `${d.toFixed(2)} d` : `${Math.round(d)} d`);
function dist(au) {
  const km = au * AU_KM;
  if (km < 1e6) return `${Math.round(km).toLocaleString('en-US')} km`;
  return `${(km / 1e6).toFixed(km < 1e7 ? 2 : 1)} M km`;
}

/** Display name of a route stop (body / object name, or the fixed point's coordinates). */
export function stopName(stop, ctx) {
  if (!stop) return '?';
  if (stop.ref) return nameOf(stop.ref, ctx);
  const f = (x) => (Number(x) || 0).toFixed(2);
  return `waypoint (${f(stop.x)}, ${f(stop.y)}, ${f(stop.z)} AU)`;
}

/** Time of the flip of a constant-thrust leg: an explicit `flipJd` when the leg model provides one, else the midpoint. */
export function legFlipJd(leg) {
  if (Number.isFinite(leg?.flipJd)) return leg.flipJd;
  if (leg?.profile === 'brachistochrone' && leg.T > 0) return leg.t0 + leg.T / 2;
  return null;
}

// ------------------------------------------------------------------ close approaches on non-ballistic legs

/** leg data object -> approaches (leg data objects are replaced whenever the leg changes, so this never goes stale) */
const approachCache = new WeakMap();

/**
 * Closest approach of a leg to every planet system that is not one of its endpoints, by sampling the object's own
 * position along the leg and refining the minimum with a golden-section search. Works for any leg profile.
 * Uses a private evaluation context so the shared position memo of the app is not churned.
 * @returns {{id:string, jd:number, distAu:number, soiAu:number, radiusAu:number}[]}
 */
function sampledApproaches(obj, leg, ctx) {
  const hit = approachCache.get(leg);
  if (hit) return hit;
  const pctx = { byId: ctx.byId, version: ctx.version, errors: new Map(), posCache: new Map() };
  const exclude = new Set(leg.endpointIds || []);
  const planets = getPerturbers().filter((p) => !exclude.has(p.id));
  const t0 = leg.t0, t1 = leg.t1;
  const pos = (t) => positionOf(obj.id, Math.min(t1, Math.max(t0, t)), pctx) ?? [0, 0, 0];
  const n = APPROACH_SAMPLES;
  const ts = [], ps = [];
  for (let k = 0; k <= n; k++) { const t = t0 + ((t1 - t0) * k) / n; ts.push(t); ps.push(pos(t)); }
  const out = [];
  for (const p of planets) {
    let kMin = 0, dMin = Infinity;
    for (let k = 0; k <= n; k++) {
      const d = vlen(vsub(ps[k], p.state(ts[k]).r));
      if (d < dMin) { dMin = d; kMin = k; }
    }
    // golden-section refinement around the coarse minimum
    let a = ts[Math.max(0, kMin - 1)], b = ts[Math.min(n, kMin + 1)];
    const f = (t) => vlen(vsub(pos(t), p.state(t).r));
    const g = (Math.sqrt(5) - 1) / 2;
    let c = b - g * (b - a), d = a + g * (b - a), fc = f(c), fd = f(d);
    for (let it = 0; it < 40 && b - a > 1e-7; it++) {
      if (fc < fd) { b = d; d = c; fd = fc; c = b - g * (b - a); fc = f(c); }
      else { a = c; c = d; fc = fd; d = a + g * (b - a); fd = f(d); }
    }
    const tm = fc < fd ? c : d, dm = Math.min(fc, fd);
    if (dm < dMin) { dMin = dm; out.push({ id: p.id, jd: tm, distAu: dm, soiAu: p.soiAu, radiusAu: p.radiusAu }); }
    else out.push({ id: p.id, jd: ts[kMin], distAu: dMin, soiAu: p.soiAu, radiusAu: p.radiusAu });
  }
  out.sort((x, y) => x.distAu - y.distAu);
  approachCache.set(leg, out);
  return out;
}

// ------------------------------------------------------------------ derivation

/**
 * Derive the milestones of every custom object with a route.
 * @param {Object[]} objects custom objects
 * @param {import('./custom.js').CustomContext} ctx
 * @returns {Milestone[]} sorted by date
 */
export function computeMilestones(objects, ctx) {
  const out = [];
  for (const o of objects) {
    const m = o.motion;
    if (m?.kind !== 'route' || !Array.isArray(m.stops) || m.stops.length < 2) continue;
    try {
      routeMilestones(o, ctx, out);
    } catch (err) {
      // a broken route must never take the timeline down
      if (import.meta.env?.DEV) console.warn('milestones:', o.name, err);
    }
  }
  out.sort((a, b) => a.jd - b.jd || a.objName.localeCompare(b.objName));
  return out;
}

function routeMilestones(o, ctx, out) {
  const m = o.motion;
  const base = { objId: o.id, objName: o.name, color: o.color || '#ff8800' };
  const push = (kind, leg, jd, title, detail, extra = {}) => {
    if (!Number.isFinite(jd)) return;
    out.push({ ...base, id: `${o.id}:${kind}:${leg}${extra.bodyId ? `:${extra.bodyId}` : ''}`, kind, leg, jd, title, detail, bodyId: null, ...extra });
  };
  const flybys = m.profile === 'ballistic' ? new Map(routeFlybys(o, ctx).map((f) => [f.stopIndex, f])) : new Map();
  for (let i = 0; i < m.stops.length - 1; i++) {
    const A = m.stops[i], B = m.stops[i + 1];
    if (A.departJd == null || B.arriveJd == null || !(B.arriveJd > A.departJd)) continue;
    const leg = legData(o, i, ctx, 0);
    const from = stopName(A, ctx), to = stopName(B, ctx);
    const prof = leg.profile === 'brachistochrone' && leg.accel > 0 ? `brachistochrone ${fmtGShort(gOf(leg.accel))}`
      : leg.fallback ? 'linear (no ballistic solution)' : leg.profile;

    const sum = leg.profile === 'ballistic' && leg.ballistic ? ballisticSummary(leg, ctx) : null;
    if (!leg.depFlyby) {
      push('depart', i, leg.t0, `${o.name} departs ${from}`,
        `for ${to} · ${prof} · ${days(leg.T)} · ${dist(leg.D)}${sum ? ` · v∞ ${kms(sum.vinfDep)}, burn ${kms(sum.dep.dv)}` : ''}`, { bodyId: A.ref ?? null });
    }

    const flip = legFlipJd(leg);
    if (flip != null) {
      push('flip', i, flip, `${o.name} flips (turnover)`, `${from} → ${to} · peak ${kms(leg.vPeak)} · then decelerates for ${days(leg.t1 - flip)}`);
    }

    // close approaches and impacts: the N-body result for ballistic legs, sampled geometry for everything else
    let approaches = [], impacts = [];
    if (sum) {
      if (sum.status === 'nbody') {
        approaches = sum.closest.filter((c) => c.close).map((c) => ({ ...c, radiusAu: (getBody(c.id)?.radiusKm ?? 0) / AU_KM }));
        impacts = sum.impacts.map((x) => ({ ...x, radiusAu: (getBody(x.id)?.radiusKm ?? 0) / AU_KM }));
      } else if (sum.status === 'failed') {
        const s = sampledApproaches(o, leg, ctx);
        approaches = s.filter((c) => c.distAu < 2 * c.soiAu && c.distAu >= c.radiusAu);
        impacts = s.filter((c) => c.distAu < c.radiusAu);
      }
    } else if (leg.T > 0) {
      const s = sampledApproaches(o, leg, ctx);
      approaches = s.filter((c) => c.distAu < 2 * c.soiAu && c.distAu >= c.radiusAu);
      impacts = s.filter((c) => c.distAu < c.radiusAu);
    }
    const impacted = new Set(impacts.map((x) => x.id));
    for (const c of approaches) {
      if (impacted.has(c.id)) continue;
      push('approach', i, c.jd, `${o.name} passes ${nameOf(c.id, ctx)}`,
        `${dist(c.distAu)} from the centre (altitude ${dist(c.distAu - c.radiusAu)}) · inside 2 SOI radii · ${from} → ${to}`, { bodyId: c.id });
    }
    for (const x of impacts) {
      push('impact', i, x.jd, `${o.name} IMPACTS ${nameOf(x.id, ctx)}`, `the path enters the planet (${from} → ${to}); change the route`, { bodyId: x.id });
    }

    if (leg.arrFlyby) {
      const fb = flybys.get(i + 1);
      const detail = fb ? `${fb.verdict.text}${fb.fb ? ` · v∞ ${kms(fb.fb.vInfInAuDay)}` : ''}` : `zero-dwell waypoint · ${from} → ${stopName(m.stops[i + 2], ctx)}`;
      push('flyby', i, leg.t1, `${o.name} flies by ${to}`, detail, { bodyId: B.ref ?? null });
    } else {
      const dv = leg.profile === 'brachistochrone' ? ` · Δv ${kms(leg.dv)}` : sum ? ` · v∞ ${kms(sum.vinfArr)}, capture ${kms(sum.arr.dv)}` : '';
      push('arrive', i, leg.t1, `${o.name} arrives at ${to}`, `from ${from} after ${days(leg.T)}${dv}`, { bodyId: B.ref ?? null });
    }
  }
}

// ------------------------------------------------------------------ live service (debounced, store-driven)

let current = [];
let version = 0;
let started = false;
let timer = null;
const listeners = new Set();

function recompute() {
  timer = null;
  const s = store.get();
  current = computeMilestones(s.objects, s.ctx);
  version++;
  for (const fn of listeners) {
    try { fn(current); } catch (err) { console.error(err); }
  }
}

function schedule() {
  clearTimeout(timer);
  timer = setTimeout(recompute, DEBOUNCE_MS);
}

/**
 * Start keeping the milestone list up to date (idempotent): recomputes on scenario changes and when background
 * N-body results arrive, debounced.
 */
export function startMilestones() {
  if (started) return;
  started = true;
  store.subscribe((_s, changed) => { if (changed.includes('objects') || changed.includes('ctx')) schedule(); });
  onTrajectoryUpdate(schedule);
  recompute();
}

/** The current milestone list (sorted by date). */
export function getMilestones() {
  if (!started) startMilestones();
  return current;
}

/** Increments whenever the list is recomputed. */
export const milestonesVersion = () => version;

/** Subscribe to recomputations. Returns an unsubscribe function. */
export function onMilestonesChange(fn) {
  listeners.add(fn);
  return () => listeners.delete(fn);
}

/** Milestones with jd in [jd0, jd1], optionally limited to a set of object ids. */
export function milestonesBetween(jd0, jd1, objIds = null) {
  const set = objIds ? new Set(objIds) : null;
  return getMilestones().filter((x) => x.jd >= jd0 && x.jd <= jd1 && (!set || set.has(x.objId)));
}
