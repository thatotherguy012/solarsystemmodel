// Custom objects (ships, fleets, stations, bases, probes): motion models and evaluation. DESIGN.md §5.
//
// Motion kinds: orbit · colocated · lagrange · fixed · route (brachistochrone | ballistic | linear legs).
// Everything is heliocentric ecliptic J2000, AU, days, radians internally.
import { AU_KM, DEG, GM_SUN, G0_M_S2, mS2ToAuDay2, auDay2ToMS2 } from '../astro/constants.js';
import { vadd, vsub, vscale, vlen, vdist, vlerp, vcross, vnorm } from '../astro/vec3.js';
import { elementsToState, stateToElements, meanMotion } from '../astro/kepler.js';
import { lambert, propagateUniversal, brachistochroneFraction, brachistochroneTime } from '../astro/lambert.js';
import { lagrangePoint } from '../astro/lagrange.js';
import { hasBody, getState, getPosition, getMu, getBody } from './ephemeris.js';

/** Maximum reference depth (object -> object -> ...) before declaring a cycle. */
export const MAX_DEPTH = 4;
/**
 * Half-step (days) for finite-difference velocities of custom objects (~8.6 s). The spec's 0.005 d would
 * under-read speeds in low orbits by ~4% (chord vs arc over a 56° arc of a 92-minute orbit).
 */
const FD_STEP = 1e-4;

export const OBJECT_TYPES = ['ship', 'fleet', 'station', 'habitat', 'base', 'probe', 'other'];
export const TYPE_GLYPHS = { ship: '◆', fleet: '❖', station: '◎', habitat: '⊚', base: '⌂', probe: '✧', other: '●' };
export const MOTION_KINDS = ['orbit', 'colocated', 'lagrange', 'fixed', 'route'];

let versionCounter = 0;

/**
 * @typedef {Object} CustomContext
 * @property {Map<string, Object>} byId   custom objects by id
 * @property {number} version            bumps whenever the object set changes (invalidates leg caches)
 * @property {Map<string, string>} errors object id -> error message (cycles, missing references)
 * @property {Map<number, Map<string, number[]>>} posCache
 */

/**
 * Create an evaluation context for a set of custom objects.
 * @param {Object[]} objects
 * @returns {CustomContext}
 */
export function createContext(objects) {
  return { byId: new Map(objects.map((o) => [o.id, o])), version: ++versionCounter, errors: new Map(), posCache: new Map() };
}

function jdCache(ctx, jd) {
  let m = ctx.posCache.get(jd);
  if (!m) {
    m = new Map();
    ctx.posCache.set(jd, m);
    if (ctx.posCache.size > 32) ctx.posCache.delete(ctx.posCache.keys().next().value);
  }
  return m;
}

/** True if `id` names a natural body or a custom object in ctx. */
export function idExists(id, ctx) {
  return hasBody(id) || ctx.byId.has(id);
}

/** Display name for any id. */
export function nameOf(id, ctx) {
  if (id == null) return 'fixed point';
  const b = getBody(id);
  if (b) return b.name;
  const o = ctx?.byId.get(id);
  return o ? o.name : `(missing: ${id})`;
}

/** Whether a custom object exists (is shown) at jd. */
export function existsAt(obj, jd) {
  if (obj.existsFromJd != null && jd < obj.existsFromJd) return false;
  if (obj.existsUntilJd != null && jd > obj.existsUntilJd) return false;
  return true;
}

/**
 * Heliocentric position of any id (natural body or custom object).
 * @returns {number[]|null}
 */
export function positionOf(id, jd, ctx, depth = 0) {
  if (hasBody(id)) return getPosition(id, jd);
  const obj = ctx.byId.get(id);
  if (!obj) return null;
  return customPosition(obj, jd, ctx, depth);
}

/**
 * Heliocentric velocity (AU/day) of any id. Custom objects in `orbit`/`colocated` motion use the analytic
 * velocity (parent velocity + Kepler velocity); everything else a central finite difference.
 */
export function velocityOf(id, jd, ctx, depth = 0) {
  if (hasBody(id)) return getState(id, jd).v;
  const obj = ctx.byId.get(id);
  if (!obj || depth > MAX_DEPTH) return [0, 0, 0];
  const m = obj.motion || {};
  if (m.kind === 'orbit' && idExists(m.parent, ctx)) {
    const { el, mu } = orbitMotionElements(m);
    return vadd(velocityOf(m.parent, jd, ctx, depth + 1), elementsToState(el, mu, jd).v);
  }
  if (m.kind === 'colocated' && idExists(m.parent, ctx)) return velocityOf(m.parent, jd, ctx, depth + 1);
  if (m.kind === 'fixed') return [0, 0, 0];
  const a = customPosition(obj, jd + FD_STEP, ctx, depth), b = customPosition(obj, jd - FD_STEP, ctx, depth);
  return vscale(vsub(a, b), 1 / (2 * FD_STEP));
}

/** GM (AU^3/day^2) usable as an orbit centre. Custom objects have negligible gravity (0). */
export function muOf(id) {
  return hasBody(id) ? getMu(id) : 0;
}

/** Kepler elements object for an `orbit` motion. */
export function orbitMotionElements(m) {
  const mu = muOf(m.parent);
  const a = m.aKm / AU_KM;
  return {
    el: { a, e: m.e ?? 0, i: (m.iDeg ?? 0) * DEG, om: (m.omDeg ?? 0) * DEG, w: (m.wDeg ?? 0) * DEG, M: (m.m0Deg ?? 0) * DEG,
      epoch: m.epochJd ?? 2451545.0, n: mu > 0 ? meanMotion(a, mu) : 0 },
    mu,
  };
}

function flag(ctx, id, msg) {
  if (!ctx.errors.has(id)) ctx.errors.set(id, msg);
}

/** Position of a route stop at time t. */
function stopPosition(stop, t, ctx, depth, ownerId) {
  if (stop.ref) {
    const p = positionOf(stop.ref, t, ctx, depth + 1);
    if (!p) { flag(ctx, ownerId, `Route stop references a missing object (${stop.ref})`); return [0, 0, 0]; }
    if (ctx.errors.has(stop.ref) && !hasBody(stop.ref)) flag(ctx, ownerId, `Depends on ${nameOf(stop.ref, ctx)}, which has an error`);
    return p;
  }
  return [Number(stop.x) || 0, Number(stop.y) || 0, Number(stop.z) || 0];
}

function stopVelocity(stop, t, ctx, depth) {
  if (!stop.ref) return [0, 0, 0];
  return velocityOf(stop.ref, t, ctx, depth + 1);
}

// ------------------------------------------------------------------ route legs

/** Leg cache: `${objId}#${legIndex}` -> { key, data } */
const legCache = new Map();

/**
 * Derived data for leg i of a route (from stop i to stop i+1).
 * @returns {Object} { i, t0, t1, T, P0, P1, D, profile, accel, vPeak, dv, ballistic?, fallback, fromId, toId }
 */
export function legData(obj, i, ctx, depth = 0) {
  const m = obj.motion;
  const A = m.stops[i], B = m.stops[i + 1];
  const key = `${ctx.version}|${m.profile}|${JSON.stringify(A)}|${JSON.stringify(B)}`;
  const ck = `${obj.id}#${i}`;
  const c = legCache.get(ck);
  if (c && c.key === key) return c.data;
  const t0 = A.departJd, t1 = B.arriveJd, T = t1 - t0;
  const P0 = stopPosition(A, t0, ctx, depth, obj.id), P1 = stopPosition(B, t1, ctx, depth, obj.id);
  const D = vdist(P0, P1);
  const data = {
    i, t0, t1, T, P0, P1, D, profile: m.profile, fromId: A.ref ?? null, toId: B.ref ?? null,
    accel: T > 0 ? (4 * D) / (T * T) : NaN, vPeak: T > 0 ? (2 * D) / T : NaN, dv: T > 0 ? (4 * D) / T : NaN,
    vAvg: T > 0 ? D / T : NaN, fallback: false, ballistic: null,
  };
  if (m.profile === 'ballistic' && T > 0) {
    const sol = lambert(P0, P1, T, GM_SUN, true);
    if (sol.ok) {
      const vDep = stopVelocity(A, t0, ctx, depth), vArr = stopVelocity(B, t1, ctx, depth);
      const el = stateToElements(P0, sol.v1, GM_SUN, t0);
      data.ballistic = {
        v1: sol.v1, v2: sol.v2, vinfDep: vlen(vsub(sol.v1, vDep)), vinfArr: vlen(vsub(sol.v2, vArr)),
        a: el.a, e: el.e, rp: el.rp, iDeg: el.i / DEG,
      };
    } else {
      data.fallback = true; // no ballistic solution -> linear
    }
  }
  legCache.set(ck, { key, data });
  return data;
}

/** Position along a leg at time jd (t0 <= jd <= t1). */
function legPosition(leg, jd) {
  const T = leg.T;
  const tau = T > 0 ? (jd - leg.t0) / T : 1;
  if (leg.profile === 'ballistic' && leg.ballistic) {
    return propagateUniversal(leg.P0, leg.ballistic.v1, jd - leg.t0, GM_SUN).r;
  }
  if (leg.profile === 'brachistochrone') return vlerp(leg.P0, leg.P1, brachistochroneFraction(tau));
  return vlerp(leg.P0, leg.P1, Math.min(1, Math.max(0, tau)));
}

/**
 * Locate jd on a route. Returns { kind: 'before'|'parked'|'transit'|'arrived', stop?, leg? }.
 */
export function routePhase(m, jd) {
  const stops = m.stops || [];
  const n = stops.length;
  if (n === 0) return { kind: 'invalid' };
  if (n === 1) return { kind: 'parked', stop: 0 };
  if (stops[0].departJd == null || jd < stops[0].departJd) return { kind: 'before', stop: 0 };
  for (let i = 0; i < n - 1; i++) {
    const A = stops[i], B = stops[i + 1];
    if (A.departJd == null) return { kind: 'parked', stop: i };
    if (jd < A.departJd) return { kind: 'parked', stop: i };
    if (B.arriveJd == null) return { kind: 'parked', stop: i };
    if (jd <= B.arriveJd) return { kind: 'transit', leg: i };
  }
  return { kind: 'arrived', stop: n - 1 };
}

function routePosition(obj, jd, ctx, depth) {
  const m = obj.motion;
  const ph = routePhase(m, jd);
  if (ph.kind === 'invalid') return [0, 0, 0];
  if (ph.kind === 'transit') return legPosition(legData(obj, ph.leg, ctx, depth), jd);
  return stopPosition(m.stops[ph.stop], jd, ctx, depth, obj.id);
}

// ------------------------------------------------------------------ evaluation

function computePosition(obj, jd, ctx, depth) {
  const m = obj.motion || {};
  switch (m.kind) {
    case 'orbit': {
      const pp = positionOf(m.parent, jd, ctx, depth + 1);
      if (!pp) { flag(ctx, obj.id, `Orbit parent is missing (${m.parent})`); return [0, 0, 0]; }
      const { el, mu } = orbitMotionElements(m);
      return vadd(pp, elementsToState(el, mu, jd).r);
    }
    case 'colocated': {
      const pp = positionOf(m.parent, jd, ctx, depth + 1);
      if (!pp) { flag(ctx, obj.id, `Parent is missing (${m.parent})`); return [0, 0, 0]; }
      return pp;
    }
    case 'lagrange': {
      if (!hasBody(m.primary) || !hasBody(m.secondary)) { flag(ctx, obj.id, 'Lagrange primary/secondary must be natural bodies'); return [0, 0, 0]; }
      const P = getState(m.primary, jd), S = getState(m.secondary, jd);
      const normal = vnorm(vcross(vsub(S.r, P.r), vsub(S.v, P.v)));
      return lagrangePoint(P.r, getMu(m.primary), S.r, getMu(m.secondary), m.point || 'L1',
        normal[0] || normal[1] || normal[2] ? normal : [0, 0, 1]);
    }
    case 'fixed':
      return [Number(m.x) || 0, Number(m.y) || 0, Number(m.z) || 0];
    case 'route':
      return routePosition(obj, jd, ctx, depth);
    default:
      return [0, 0, 0];
  }
}

/**
 * Heliocentric position of a custom object (memoized per ctx and jd). Guards reference cycles.
 * @returns {number[]}
 */
export function customPosition(obj, jd, ctx, depth = 0) {
  if (depth > MAX_DEPTH) {
    flag(ctx, obj.id, 'Reference cycle (or chain deeper than 4 levels): treated as fixed at the Sun');
    return [0, 0, 0];
  }
  const cache = jdCache(ctx, jd);
  const hit = cache.get(obj.id);
  if (hit) return hit;
  const r = computePosition(obj, jd, ctx, depth);
  for (const ref of referencedIds(obj)) {
    if (ref !== obj.id && ctx.errors.has(ref) && !hasBody(ref)) flag(ctx, obj.id, `Depends on ${nameOf(ref, ctx)}, which has an error`);
    if (ref === obj.id) flag(ctx, obj.id, 'References itself');
  }
  if (!ctx.errors.has(obj.id) || depth === 0) cache.set(obj.id, r);
  return r;
}

/**
 * Full state of a custom object for the inspector.
 * @returns {{r:number[], v:number[], legInfo:Object|null, error:string|null}}
 */
export function customState(obj, jd, ctx) {
  const r = customPosition(obj, jd, ctx, 0);
  const v = velocityOf(obj.id, jd, ctx, 0);
  let legInfo = null;
  if (obj.motion?.kind === 'route') {
    const ph = routePhase(obj.motion, jd);
    legInfo = { phase: ph };
    if (ph.kind === 'transit') {
      const leg = legData(obj, ph.leg, ctx, 0);
      legInfo.leg = leg;
      legInfo.tau = leg.T > 0 ? (jd - leg.t0) / leg.T : 1;
    } else if (ph.kind === 'before' && obj.motion.stops.length > 1) {
      legInfo.next = legData(obj, 0, ctx, 0);
    } else if (ph.kind === 'parked' && ph.stop < obj.motion.stops.length - 1 && obj.motion.stops[ph.stop].departJd != null) {
      legInfo.next = legData(obj, ph.stop, ctx, 0);
    }
  }
  return { r, v, legInfo, error: ctx.errors.get(obj.id) ?? null };
}

/**
 * Polylines for drawing a route: one per transfer leg, sampled uniformly in time.
 * Points are stored relative to `origin` (the leg's start point) to keep float32 precision on the GPU.
 * @returns {{leg:number, t0:number, t1:number, origin:number[], points:number[][], profile:string, fallback:boolean}[]}
 */
export function customPath(obj, ctx, samples = 192) {
  const m = obj.motion;
  if (!m || m.kind !== 'route' || !m.stops || m.stops.length < 2) return [];
  const out = [];
  for (let i = 0; i < m.stops.length - 1; i++) {
    const A = m.stops[i], B = m.stops[i + 1];
    if (A.departJd == null || B.arriveJd == null || !(B.arriveJd > A.departJd)) continue;
    const leg = legData(obj, i, ctx, 0);
    const pts = [];
    for (let k = 0; k <= samples; k++) {
      const t = leg.t0 + (leg.T * k) / samples;
      pts.push(vsub(legPosition(leg, t), leg.P0));
    }
    out.push({ leg: i, t0: leg.t0, t1: leg.t1, origin: leg.P0, points: pts, profile: m.profile, fallback: leg.fallback });
  }
  return out;
}

// ------------------------------------------------------------------ route solving / validation

/**
 * Brachistochrone travel time (days) from `fromStop` departing at t0 to a (possibly moving) `toStop` at
 * constant acceleration accelG (g), iterating T <- t(|S1(t0+T) - S0(t0)|) 12 times (§5).
 */
export function solveBrachistochroneTime(fromStop, toStop, t0, accelG, ctx) {
  const a = mS2ToAuDay2(accelG * G0_M_S2);
  const P0 = stopPosition(fromStop, t0, ctx, 0, '');
  let T = brachistochroneTime(vdist(stopPosition(toStop, t0, ctx, 0, ''), P0), a);
  for (let k = 0; k < 12; k++) T = brachistochroneTime(vdist(stopPosition(toStop, t0 + T, ctx, 0, ''), P0), a);
  return T;
}

/**
 * Parse a stop time field. Accepts absolute dates (parseDateToJd syntax), "+N" / "+Nd" / "+Nh" relative to
 * `baseJd`, or a raw number (JD). Returns { jd } | { blank:true } | { error }.
 */
export function parseStopTime(str, baseJd, parseDateToJd) {
  if (str == null) return { blank: true };
  const s = String(str).trim();
  if (!s) return { blank: true };
  const rel = s.match(/^\+\s*([0-9]*\.?[0-9]+)\s*(d|days?|h|hours?|y|yr|years?)?$/i);
  if (rel) {
    if (baseJd == null || !Number.isFinite(baseJd)) return { error: 'relative time needs a previous time' };
    let v = parseFloat(rel[1]);
    const u = (rel[2] || 'd').toLowerCase();
    if (u.startsWith('h')) v /= 24;
    else if (u.startsWith('y')) v *= 365.25;
    return { jd: baseJd + v };
  }
  if (/^\d{7}(\.\d+)?$/.test(s)) return { jd: parseFloat(s) };
  const jd = parseDateToJd(s);
  if (Number.isFinite(jd)) return { jd };
  return { error: 'unrecognised date' };
}

/**
 * Resolve and validate a route draft. Draft stops carry raw strings `arriveStr`/`departStr` (or numbers
 * arriveJd/departJd). Brachistochrone legs with an empty arrival are solved from `accelG`.
 * @returns {{ stops:Object[], errors:string[], warnings:string[], legs:Object[] }}
 */
export function resolveRoute(draft, ctx, parseDateToJd) {
  const errors = [], warnings = [];
  const stops = [];
  const n = draft.stops.length;
  if (n < 2) errors.push('A route needs at least two stops.');
  let prevTime = null;
  let prevValid = true;
  for (let i = 0; i < n; i++) {
    const d = draft.stops[i];
    const label = `Stop ${i + 1}`;
    const stop = { ref: d.ref || null, arriveJd: null, departJd: null };
    let valid = true;
    if (!stop.ref) {
      const x = Number(d.x), y = Number(d.y), z = Number(d.z);
      if (![x, y, z].every(Number.isFinite) || [d.x, d.y, d.z].some((v) => v === '' || v == null)) {
        errors.push(`${label}: fixed point needs numeric x, y, z.`);
        valid = false;
      }
      stop.x = x || 0; stop.y = y || 0; stop.z = z || 0;
    } else if (!idExists(stop.ref, ctx)) { errors.push(`${label}: unknown object "${stop.ref}".`); valid = false; }
    // arrival
    if (i > 0) {
      const p = d.arriveStr !== undefined ? parseStopTime(d.arriveStr, prevTime, parseDateToJd) : (d.arriveJd != null ? { jd: d.arriveJd } : { blank: true });
      if (p.error) errors.push(`${label} arrival: ${p.error}.`);
      else if (p.blank) {
        const canSolve = draft.profile === 'brachistochrone' && draft.accelG > 0;
        if (canSolve && prevTime != null && valid && prevValid) {
          const T = solveBrachistochroneTime(stops[i - 1], stop, prevTime, draft.accelG, ctx);
          stop.arriveJd = prevTime + T;
          stop.solved = true;
        } else if (canSolve) errors.push(`${label}: arrival cannot be solved until the previous stop and departure are valid.`);
        else errors.push(`${label}: arrival time required${draft.profile === 'brachistochrone' ? ' (or set an acceleration to solve it)' : ''}.`);
      } else stop.arriveJd = p.jd;
      if (stop.arriveJd != null && prevTime != null && !(stop.arriveJd > prevTime)) errors.push(`${label}: arrival must be after the previous departure.`);
      if (stop.arriveJd != null) prevTime = stop.arriveJd;
    }
    // departure
    if (i < n - 1) {
      const p = d.departStr !== undefined ? parseStopTime(d.departStr, prevTime, parseDateToJd) : (d.departJd != null ? { jd: d.departJd } : { blank: true });
      if (p.error) errors.push(`${label} departure: ${p.error}.`);
      else if (p.blank) errors.push(`${label}: departure time required.`);
      else {
        stop.departJd = p.jd;
        if (i > 0 && stop.arriveJd != null && !(stop.departJd > stop.arriveJd)) errors.push(`${label}: departure must be after arrival.`);
        prevTime = stop.departJd;
      }
    }
    prevValid = valid;
    stops.push(stop);
  }
  // legs summary (only when consistent)
  const legs = [];
  if (!errors.length && n >= 2) {
    const tmp = { id: `__draft_${Math.random()}`, motion: { kind: 'route', profile: draft.profile, stops } };
    for (let i = 0; i < n - 1; i++) {
      const leg = legData(tmp, i, ctx, 0);
      legs.push(leg);
      const accelG = auDay2ToMS2(leg.accel) / G0_M_S2;
      if (draft.profile === 'brachistochrone' && draft.accelG > 0 && !stops[i + 1].solved && Math.abs(accelG / draft.accelG - 1) > 0.01) {
        warnings.push(`Leg ${i + 1}: the explicit arrival time needs ${accelG.toPrecision(3)} g, not the nominal ${draft.accelG} g (clear the arrival to solve it from the acceleration).`);
      }
      if (draft.profile === 'brachistochrone' && accelG < 0.01) warnings.push(`Leg ${i + 1}: ${accelG.toFixed(4)} g is below ~0.01 g; solar gravity is not negligible at this thrust.`);
      if (draft.profile === 'ballistic' && leg.fallback) warnings.push(`Leg ${i + 1}: no ballistic solution; drawn as a straight line.`);
      if (draft.profile === 'ballistic' && leg.ballistic && leg.ballistic.e >= 1) warnings.push(`Leg ${i + 1}: hyperbolic transfer (e = ${leg.ballistic.e.toFixed(2)}); very fast for a ballistic coast.`);
    }
    for (let i = 0; i < n - 1; i++) legCache.delete(`${tmp.id}#${i}`);
  }
  return { stops, errors, warnings, legs };
}

/** Short human description of a motion. */
export function motionSummary(obj, ctx) {
  const m = obj.motion || {};
  switch (m.kind) {
    case 'orbit': return `Orbit about ${nameOf(m.parent, ctx)}`;
    case 'colocated': return `${m.label ? m.label + ' — ' : ''}at ${nameOf(m.parent, ctx)}`;
    case 'lagrange': return `${nameOf(m.primary, ctx)}–${nameOf(m.secondary, ctx)} ${m.point}`;
    case 'fixed': return 'Fixed heliocentric point';
    case 'route': return `Route (${m.profile}${m.profile === 'brachistochrone' && m.accelG ? `, ${m.accelG} g` : ''}): ${m.stops.map((s) => nameOf(s.ref, ctx)).join(' → ')}`;
    default: return 'Unknown motion';
  }
}

/** Ids referenced by an object's motion. */
export function referencedIds(obj) {
  const m = obj.motion || {};
  if (m.kind === 'orbit' || m.kind === 'colocated') return [m.parent];
  if (m.kind === 'lagrange') return [m.primary, m.secondary];
  if (m.kind === 'route') return m.stops.map((s) => s.ref).filter(Boolean);
  return [];
}
