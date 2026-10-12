// Custom objects (ships, fleets, stations, bases, probes): motion models and evaluation. DESIGN.md §5 (+ v2, v3).
//
// Motion kinds: orbit · colocated · lagrange · fixed · route.
// Route legs (v3: per leg) fly as: thrust (constant-thrust rendezvous / intercept from the actual departure state,
// src/astro/maneuver.js, refined under gravity) · ballistic (Lambert + N-body) · brachistochrone (legacy straight
// line) · linear · drift (engines off, N-body coast).
// Route stops: a body / custom object (`ref`), a fixed point (`ref: null`, x, y, z), a waypoint (`kind: 'waypoint'`,
// x, y, z, vx, vy, vz: a snapshot of the ship's state where a course change or engine cut happened; `aborted` keeps
// the stop the cut leg was originally flying to, so the ship's history is unchanged), or a hold (`kind: 'hold'`,
// `motion`: the object's previous non-route motion, first stop only).
// A stop's optional `leg` ({ profile, mode, accelG }) defines the leg arriving at it; otherwise the route's
// `profile` / `accelG` apply (v1/v2 routes).
// Everything is heliocentric ecliptic J2000, AU, days, radians internally.
import { AU_KM, DEG, GM_SUN, G0_M_S2, mS2ToAuDay2, auDay2ToMS2 } from '../astro/constants.js';
import { vadd, vsub, vscale, vlen, vdist, vlerp, vcross, vnorm } from '../astro/vec3.js';
import { elementsToState, stateToElements, meanMotion } from '../astro/kepler.js';
import { lambert, propagateUniversal, brachistochroneFraction, brachistochroneTime } from '../astro/lambert.js';
import { lagrangePoint } from '../astro/lagrange.js';
import { interpolateSamples } from '../astro/nbody.js';
import { solveRendezvous, solveIntercept } from '../astro/maneuver.js';
import { hasBody, getState, getStateUncached, getPosition, getMu, getBody, perturberIdFor } from './ephemeris.js';
import { requestTrajectory, peekTrajectory, isTrajectoryPending, computeTrajectoryNow, trajGeneration, trajectoryKey, stateKey } from './trajectory.js';

/** Maximum reference depth (object -> object -> ...) before declaring a cycle. */
export const MAX_DEPTH = 4;
/**
 * Half-step (days) for finite-difference velocities of custom objects (~8.6 s). The spec's 0.005 d would
 * under-read speeds in low orbits by ~4% (chord vs arc over a 56° arc of a 92-minute orbit).
 */
const FD_STEP = 1e-4;
/** How far ahead (days) the dashed drift path of a ship with its engines off is drawn. */
export const DRIFT_DRAW_DAYS = 3 * 365.25;

export const OBJECT_TYPES = ['ship', 'fleet', 'station', 'habitat', 'base', 'probe', 'other'];
export const TYPE_GLYPHS = { ship: '◆', fleet: '❖', station: '◎', habitat: '⊚', base: '⌂', probe: '✧', other: '●' };
export const MOTION_KINDS = ['orbit', 'colocated', 'lagrange', 'fixed', 'route'];
/** Object types that get a drive (and the command bar). */
export const DRIVE_TYPES = new Set(['ship', 'fleet', 'probe']);
export const DEFAULT_ACCEL_G = 0.3;
export const LEG_PROFILES = ['thrust', 'ballistic', 'brachistochrone', 'linear', 'drift'];

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

/** Display name of a route stop. */
export function nameOfStop(stop, ctx) {
  if (!stop) return '—';
  if (stop.ref) return nameOf(stop.ref, ctx);
  if (isWaypoint(stop)) return 'course change';
  if (isHold(stop)) return `start (${stop.motion ? motionSummary({ motion: stop.motion }, ctx).toLowerCase() : 'previous motion'})`;
  return 'point in space';
}

/** Whether a custom object exists (is shown) at jd. */
export function existsAt(obj, jd) {
  if (obj.existsFromJd != null && jd < obj.existsFromJd) return false;
  if (obj.existsUntilJd != null && jd > obj.existsUntilJd) return false;
  return true;
}

/**
 * The drive of an object: `{ kind: 'torch', accelG }` | `{ kind: 'coast' }` | null (stations, bases, habitats,
 * `drive: { kind: 'none' }`). Ships, fleets and probes saved before v3 infer it from their route
 * (brachistochrone at X g -> torch X g; ballistic -> coast; otherwise torch at 0.3 g).
 */
export function driveOf(obj) {
  if (!obj) return null;
  const d = obj.drive;
  if (d?.kind === 'torch') return { kind: 'torch', accelG: d.accelG > 0 ? d.accelG : DEFAULT_ACCEL_G };
  if (d?.kind === 'coast') return { kind: 'coast' };
  if (d?.kind === 'none' || !DRIVE_TYPES.has(obj.type)) return null;
  const m = obj.motion;
  if (m?.kind === 'route') {
    if (m.profile === 'ballistic') return { kind: 'coast' };
    if ((m.profile === 'brachistochrone' || m.profile === 'thrust') && m.accelG > 0) return { kind: 'torch', accelG: m.accelG };
  }
  return { kind: 'torch', accelG: DEFAULT_ACCEL_G };
}

// ------------------------------------------------------------------ stops

export const isWaypoint = (s) => s?.kind === 'waypoint';
export const isHold = (s) => s?.kind === 'hold';
const isZero = (v) => !v || (v[0] === 0 && v[1] === 0 && v[2] === 0);

/**
 * State of a waypoint stop at t: the stored snapshot at its epoch (arrival), propagated as a two-body coast for other
 * times (a waypoint with zero velocity holds its position).
 */
export function waypointState(s, t) {
  const r0 = [+s.x || 0, +s.y || 0, +s.z || 0], v0 = [+s.vx || 0, +s.vy || 0, +s.vz || 0];
  const t0 = s.arriveJd ?? s.departJd ?? t;
  if (t === t0 || isZero(v0)) return { r: r0, v: v0 };
  return propagateUniversal(r0, v0, t - t0, GM_SUN);
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
 * Heliocentric velocity (AU/day) of any id. Custom objects use analytic velocities where the motion has them
 * (orbits, co-location, route legs, drift) and a central finite difference otherwise.
 */
export function velocityOf(id, jd, ctx, depth = 0) {
  if (hasBody(id)) return getState(id, jd).v;
  const obj = ctx.byId.get(id);
  if (!obj || depth > MAX_DEPTH) return [0, 0, 0];
  if (obj.motion?.kind === 'route') return routeState(obj, jd, ctx, depth).v;
  return motionVelocity(obj.motion || {}, jd, ctx, depth, obj.id);
}

/** Velocity of a non-route motion. */
function motionVelocity(m, jd, ctx, depth, ownerId) {
  if (m.kind === 'orbit' && idExists(m.parent, ctx)) {
    const { el, mu } = orbitMotionElements(m);
    return vadd(velocityOf(m.parent, jd, ctx, depth + 1), elementsToState(el, mu, jd).v);
  }
  if (m.kind === 'colocated' && idExists(m.parent, ctx)) return velocityOf(m.parent, jd, ctx, depth + 1);
  if (m.kind === 'fixed') return [0, 0, 0];
  const o = { id: ownerId, motion: m };
  const a = computePosition(o, jd + FD_STEP, ctx, depth), b = computePosition(o, jd - FD_STEP, ctx, depth);
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
  if (isWaypoint(stop)) return waypointState(stop, t).r;
  if (isHold(stop)) return stop.motion ? computePosition({ id: ownerId, motion: stop.motion }, t, ctx, depth + 1) : [0, 0, 0];
  return [Number(stop.x) || 0, Number(stop.y) || 0, Number(stop.z) || 0];
}

function stopVelocity(stop, t, ctx, depth, ownerId = '') {
  if (stop.ref) return velocityOf(stop.ref, t, ctx, depth + 1);
  if (isWaypoint(stop)) return waypointState(stop, t).v;
  if (isHold(stop)) return stop.motion ? motionVelocity(stop.motion, t, ctx, depth + 1, ownerId) : [0, 0, 0];
  return [0, 0, 0];
}

/** Heliocentric state of a ship sitting at a route stop at time t: { r, v }. */
export function stopStateOf(stop, t, ctx, depth = 0, ownerId = '') {
  if (stop.ref && hasBody(stop.ref)) { const s = getState(stop.ref, t); return { r: s.r, v: s.v }; }
  if (isWaypoint(stop)) return waypointState(stop, t);
  return { r: stopPosition(stop, t, ctx, depth, ownerId), v: stopVelocity(stop, t, ctx, depth, ownerId) };
}

/**
 * Natural body whose frame (and gravity) a stop reference sits in: a natural body itself, or the body a custom
 * object orbits / is co-located with (followed through chains of custom objects). Null for Lagrange points,
 * fixed points, route-kind objects and anything else.
 * @returns {string|null}
 */
export function stopFrameBody(ref, ctx, depth = 0) {
  if (!ref || depth > MAX_DEPTH) return null;
  if (hasBody(ref)) return ref;
  const m = ctx.byId.get(ref)?.motion;
  if (m?.kind === 'orbit' || m?.kind === 'colocated') return stopFrameBody(m.parent, ctx, depth + 1);
  return null;
}

/** stopFrameBody for a whole stop (hold stops in orbit about / co-located with a body use that body). */
export function stopFrameBodyOf(stop, ctx) {
  if (!stop) return null;
  if (stop.ref) return stopFrameBody(stop.ref, ctx);
  const m = isHold(stop) ? stop.motion : null;
  if (m?.kind === 'orbit' || m?.kind === 'colocated') return stopFrameBody(m.parent, ctx);
  return null;
}

/**
 * Velocity that hyperbolic excess speeds are measured against at a stop: the frame body's heliocentric velocity
 * (so a station in low orbit reports v∞ relative to its planet, not to its own orbital motion), otherwise the
 * stop's own velocity (zero for a fixed point, the stored velocity for a waypoint).
 */
export function stopFrameVelocity(stop, t, ctx, depth = 0) {
  const b = stopFrameBodyOf(stop, ctx);
  if (b) return getState(b, t).v;
  return stopVelocity(stop, t, ctx, depth);
}

/** Perturber whose gravity is switched off near this stop (patched-conic endpoint), or null. */
export function stopPerturberId(stop, ctx) {
  const look = (id) => ctx.byId.get(id);
  if (stop?.ref) return perturberIdFor(stop.ref, look);
  const m = isHold(stop) ? stop.motion : null;
  if (!m) return null;
  if (m.kind === 'orbit' || m.kind === 'colocated') return perturberIdFor(m.parent, look);
  if (m.kind === 'lagrange') return perturberIdFor(m.primary === 'sun' ? m.secondary : m.primary, look);
  return null;
}

/** True when stop i of a route is a zero-dwell intermediate stop (arrival == departure) at a body: a flyby. */
export function isFlybyStop(stops, i) {
  const s = stops?.[i];
  return !!s && !isWaypoint(s) && !isHold(s) && i > 0 && i < stops.length - 1 && s.arriveJd != null && s.arriveJd === s.departJd;
}

/**
 * Target function { r, v } (heliocentric) of a destination stop for the maneuver solvers.
 * @returns {(jd:number) => {r:number[], v:number[]}}
 */
export function stopTargetFn(stop, ctx) {
  if (stop.ref && hasBody(stop.ref)) { const id = stop.ref; return (t) => getStateUncached(id, t); }
  if (stop.ref) { const id = stop.ref; return (t) => ({ r: positionOf(id, t, ctx) ?? [0, 0, 0], v: velocityOf(id, t, ctx) }); }
  if (isWaypoint(stop)) return (t) => waypointState(stop, t);
  const r = [Number(stop.x) || 0, Number(stop.y) || 0, Number(stop.z) || 0];
  return () => ({ r, v: [0, 0, 0] });
}

// ------------------------------------------------------------------ legs

/**
 * Definition of leg i (stop i -> stop i+1): { profile, mode: 'rendezvous'|'intercept', accelG }. The arriving stop's
 * `leg` (or, for a cut leg, the leg of the stop it was originally flying to) wins over the route defaults.
 */
export function legSpec(m, i) {
  const B = m.stops?.[i + 1];
  const L = (B?.aborted ?? B)?.leg;
  if (L?.profile && LEG_PROFILES.includes(L.profile)) {
    return { profile: L.profile, mode: L.mode === 'intercept' ? 'intercept' : 'rendezvous', accelG: L.accelG ?? m.accelG ?? null };
  }
  return { profile: m.profile ?? 'linear', mode: 'rendezvous', accelG: m.accelG ?? null };
}

/** True when a stop's position can change with other objects' trajectories (custom references). */
function stopDynamic(stop, ctx) {
  if (!stop) return false;
  if (stop.ref) return !hasBody(stop.ref);
  if (isHold(stop)) return (stop.motion?.parent && !hasBody(stop.motion.parent)) || false;
  return false;
}

/**
 * Constant-thrust leg setup: kinematic (gravity-free) solution from the departure state `dep` at t0 to stop B, and
 * the parameters of the gravity-refinement job (cache key built from the stop data).
 * @returns {{a:number, kin:Object, targetFn:Function, params:Object|null}}
 */
export function thrustSetup(dep, t0, B, spec, endpointIds, ctx) {
  const a = mS2ToAuDay2((spec.accelG > 0 ? spec.accelG : DEFAULT_ACCEL_G) * G0_M_S2);
  const targetFn = stopTargetFn(B, ctx);
  let kin;
  try {
    kin = spec.mode === 'intercept' ? solveIntercept(dep.r, dep.v, t0, targetFn, a) : solveRendezvous(dep.r, dep.v, t0, targetFn, a);
  } catch (err) {
    kin = { ok: false, reason: String(err?.message ?? err) };
  }
  if (!kin.ok || !(kin.T > 0)) return { a, kin: { ...kin, ok: false }, targetFn, params: null };
  let tgtKey;
  if (B.ref && hasBody(B.ref)) tgtKey = B.ref;
  else if (B.ref) tgtKey = `${B.ref}@${stateKey(targetFn(kin.arriveJd).r, [0, 0, 0])}`;
  else tgtKey = `pt:${stateKey(targetFn(t0).r, targetFn(t0).v)}`;
  const key = [t0.toFixed(7), stateKey(dep.r, dep.v), spec.mode, a.toPrecision(12), tgtKey, endpointIds.join('+')].join('|');
  return { a, kin, targetFn, params: { key, P0: dep.r, V0: dep.v, t0, a, mode: spec.mode, targetFn, Tkin: kin.T, endpointIds } };
}

/**
 * Solve a constant-thrust leg now (gravity-refined; synchronous, ~10-80 ms, cached): used when a command or the
 * route editor needs the arrival time.
 * @returns {{ok:boolean, arriveJd?:number, sol?:Object, kin?:Object, reason?:string}}
 */
export function solveThrustLegNow(fromStop, toStop, t0, spec, ctx) {
  const dep = stopStateOf(fromStop, t0, ctx, 0, '');
  const endpointIds = [...new Set([stopPerturberId(fromStop, ctx), stopPerturberId(toStop, ctx)].filter(Boolean))];
  const th = thrustSetup(dep, t0, toStop, spec, endpointIds, ctx);
  if (!th.params) return { ok: false, kin: th.kin, reason: th.kin.reason || 'the solver did not converge' };
  const res = computeTrajectoryNow('thrust', th.params);
  const sol = res?.ok ? res.sol : th.kin;
  return { ok: true, arriveJd: sol.arriveJd, sol, kin: th.kin, refined: !!res?.gravityRefined };
}

/** Leg cache: `${objId}#${legIndex}` -> { key, data } */
const legCache = new Map();

/**
 * Derived data for leg i of a route (from stop i to stop i+1). Ballistic legs carry the two-body Lambert solution
 * immediately and queue the N-body refinement (`nbodyKey`, see legNbody); brachistochrone legs queue a gravity
 * audit (`auditKey`); thrust legs carry the kinematic solution and queue the gravity refinement (`thrustKey`); drift
 * legs queue an N-body coast (`driftKey`). For a leg cut short by a course change, t1 is the planned arrival at the
 * original destination and tEnd the cut time.
 * @returns {Object} { i, t0, t1, tEnd, T, P0, V0, P1, D, profile, mode, accelG, cut, accel, vPeak, dv, ballistic?, thrust?,
 *   drift?, fallback, fromId, toId, fromStop, toStop, depFlyby, arrFlyby, endpointIds, nbodyKey?, auditKey?, thrustKey?, driftKey? }
 */
export function legData(obj, i, ctx, depth = 0) {
  const m = obj.motion;
  const A = m.stops[i], Bcut = m.stops[i + 1];
  const B = Bcut.aborted ?? Bcut;
  const spec = legSpec(m, i);
  const dynamic = spec.profile === 'drift' || stopDynamic(A, ctx) || stopDynamic(B, ctx);
  const prevKey = spec.profile === 'drift' && i > 0 ? JSON.stringify(m.stops[i - 1]) + JSON.stringify(legSpec(m, i - 1)) : '';
  const key = `${ctx.version}|${dynamic ? trajGeneration() : ''}|${JSON.stringify(spec)}|${m.stops.length}|${JSON.stringify(A)}|${JSON.stringify(Bcut)}|${prevKey}`;
  const ck = `${obj.id}#${i}`;
  const c = legCache.get(ck);
  if (c && c.key === key) return c.data;
  const t0 = A.departJd, tEnd = Bcut.arriveJd, t1 = B.arriveJd ?? tEnd;
  const endpointIds = [...new Set([stopPerturberId(A, ctx), stopPerturberId(B, ctx)].filter(Boolean))];
  const data = {
    i, t0, t1, tEnd, T: t1 - t0, P0: null, V0: null, P1: null, D: NaN, profile: spec.profile, mode: spec.mode, accelG: spec.accelG,
    cut: !!Bcut.aborted, fromId: A.ref ?? null, toId: B.ref ?? null, accel: NaN, vPeak: NaN, dv: NaN, vAvg: NaN, fallback: false,
    ballistic: null, thrust: null, drift: null, targetFn: null,
    fromStop: A, toStop: B, cutStop: Bcut.aborted ? Bcut : null, depFlyby: isFlybyStop(m.stops, i), arrFlyby: isFlybyStop(m.stops, i + 1), endpointIds,
    nbodyKey: null, nbodyParams: null, auditKey: null, auditParams: null, thrustKey: null, thrustParams: null, driftKey: null, driftParams: null,
    trajGroup: obj.trajGroup ?? 'route',
  };
  const T = data.T;
  if (spec.profile === 'drift') {
    const src = arrivalStateOf(obj, i, ctx, depth);
    data.drift = src;
    data.P0 = src.r; data.V0 = src.v;
    data.driftParams = driftParamsOf(src);
    data.driftKey = requestTrajectory('drift', data.driftParams, data.trajGroup).key;
    data.P1 = stopPosition(Bcut, tEnd, ctx, depth, obj.id);
    data.D = vdist(data.P0, data.P1);
  } else if (spec.profile === 'thrust') {
    const dep = stopStateOf(A, t0, ctx, depth, obj.id);
    data.P0 = dep.r; data.V0 = dep.v;
    const th = thrustSetup(dep, t0, B, spec, endpointIds, ctx);
    data.thrust = { a: th.a, kin: th.kin, mode: spec.mode };
    data.targetFn = th.targetFn;
    data.accel = th.a;
    if (th.params) {
      data.thrustParams = th.params;
      data.thrustKey = requestTrajectory('thrust', th.params, data.trajGroup).key;
      data.P1 = th.targetFn(th.kin.arriveJd).r;
    } else {
      data.fallback = true;
      data.P1 = stopPosition(B, t1, ctx, depth, obj.id);
    }
    data.D = vdist(data.P0, data.P1);
  } else {
    const P0 = stopPosition(A, t0, ctx, depth, obj.id), P1 = stopPosition(B, t1, ctx, depth, obj.id);
    const D = vdist(P0, P1);
    Object.assign(data, {
      P0, P1, D, V0: null,
      accel: T > 0 ? (4 * D) / (T * T) : NaN, vPeak: T > 0 ? (2 * D) / T : NaN, dv: T > 0 ? (4 * D) / T : NaN, vAvg: T > 0 ? D / T : NaN,
    });
    if (spec.profile === 'ballistic' && T > 0) {
      const sol = lambert(P0, P1, T, GM_SUN, true);
      if (sol.ok) {
        const vDep = stopFrameVelocity(A, t0, ctx, depth), vArr = stopFrameVelocity(B, t1, ctx, depth);
        const el = stateToElements(P0, sol.v1, GM_SUN, t0);
        data.ballistic = {
          v1: sol.v1, v2: sol.v2, vFrameDep: vDep, vFrameArr: vArr, vinfDep: vlen(vsub(sol.v1, vDep)), vinfArr: vlen(vsub(sol.v2, vArr)),
          a: el.a, e: el.e, rp: el.rp, iDeg: el.i / DEG,
        };
        data.nbodyParams = { P0, t0, P1, t1, v1: sol.v1, endpointIds };
        data.nbodyKey = requestTrajectory('ballistic', data.nbodyParams, data.trajGroup).key;
      } else {
        data.fallback = true; // no ballistic solution -> linear
      }
    } else if (spec.profile === 'brachistochrone' && T > 0 && D > 0) {
      data.auditParams = { P0, P1, t0, T, a: data.accel, endpointIds };
      data.auditKey = requestTrajectory('audit', data.auditParams, data.trajGroup).key;
    }
  }
  legCache.set(ck, { key, data });
  return data;
}

/** Cached result for a queued job key, re-requesting it if it was evicted. */
function peekOrRequest(key, kind, params, group) {
  if (!key) return null;
  const r = peekTrajectory(key);
  if (!r && !isTrajectoryPending(key)) requestTrajectory(kind, params, group);
  return r;
}

/**
 * N-body result of a ballistic leg ({ ok, v0, vEnd, samples, closest, impacts, correctionAuDay, ... }), or null
 * while it is being computed. Re-queues the job if the result was evicted from the cache.
 */
export function legNbody(leg) {
  return peekOrRequest(leg?.nbodyKey, 'ballistic', leg?.nbodyParams, leg?.trajGroup);
}

/** Gravity-audit result of a brachistochrone leg, or null while it is being computed. */
export function legAudit(leg) {
  return peekOrRequest(leg?.auditKey, 'audit', leg?.auditParams, leg?.trajGroup);
}

/** Gravity-refinement job result of a thrust leg ({ ok, sol, gravityRefined }), or null while it is computing. */
export function legThrustRefined(leg) {
  return peekOrRequest(leg?.thrustKey, 'thrust', leg?.thrustParams, leg?.trajGroup);
}

/**
 * The solution a thrust leg currently flies: the gravity-refined one when available, else the kinematic one.
 * @returns {Object|null} maneuver solution (arriveJd, T, stateAt, peakSpeed, deltaV, flipJd?, closingSpeed?, samples?)
 */
export function legSolution(leg) {
  if (leg?.profile !== 'thrust' || !leg.thrust) return null;
  const r = legThrustRefined(leg);
  if (r?.ok && r.sol) return r.sol;
  return leg.thrust.kin.ok ? leg.thrust.kin : null;
}

/** Status of a thrust leg's gravity refinement: 'pending' | 'refined' | 'approximate' | 'none'. */
export function thrustStatus(leg) {
  if (!leg?.thrustKey) return 'none';
  const r = peekTrajectory(leg.thrustKey);
  if (!r) return 'pending';
  return r.ok && r.gravityRefined ? 'refined' : 'approximate';
}

/** Arrival time actually flown on a leg (thrust legs: the solution's; otherwise the planned arrival). */
export function legArrival(leg) {
  const sol = legSolution(leg);
  return sol ? sol.arriveJd : leg.t1;
}

// ---- drift (engines off)

function driftParamsOf(src) {
  if (!src._params) src._params = { key: `${src.t.toFixed(7)}|${stateKey(src.r, src.v)}`, r0: src.r, v0: src.v, t0: src.t };
  return src._params;
}

/** N-body drift job result for a drift source, or null while computing. */
export function driftResult(src) {
  const p = driftParamsOf(src);
  return peekOrRequest(trajectoryKey('drift', p), 'drift', p, 'route');
}

/**
 * State of a ship coasting with its engines off from `src` ({ r, v, t }) at jd: N-body (Sun + 8 planets) while the
 * job's span covers jd, two-body beyond it (and while the job is still computing).
 */
export function driftState(src, jd) {
  if (!(jd > src.t)) return { r: src.r.slice(), v: src.v.slice() };
  const res = driftResult(src);
  if (res?.ok) {
    if (jd <= res.t1) return interpolateSamples(res.samples, jd);
    const last = res.samples[res.samples.length - 1];
    return propagateUniversal(last.r, last.v, jd - last.jd, GM_SUN);
  }
  return propagateUniversal(src.r, src.v, jd - src.t, GM_SUN);
}

/** End state { r, v, t } of an intercept-capable leg (thrust or ballistic), or null. */
export function legEndState(leg) {
  if (leg.profile === 'thrust') {
    const sol = legSolution(leg);
    if (!sol) return null;
    const s = sol.stateAt(sol.arriveJd);
    return { r: s.r, v: s.v, t: sol.arriveJd };
  }
  if (leg.profile === 'ballistic' && leg.ballistic) {
    const nb = legNbody(leg);
    if (nb?.ok) { const last = nb.samples[nb.samples.length - 1]; return { r: last.r, v: nb.vEnd, t: leg.t1 }; }
    return { r: leg.P1, v: leg.ballistic.v2, t: leg.t1 };
  }
  return null;
}

/**
 * The ship's state { r, v, t } on arrival at stop i: a waypoint's snapshot; the end of an intercept leg (the ship
 * flies through the target); otherwise the stop's own state at the arrival time.
 */
export function arrivalStateOf(obj, i, ctx, depth = 0) {
  const m = obj.motion, s = m.stops[i];
  const t = s.arriveJd ?? s.departJd;
  if (isWaypoint(s)) return { ...waypointState(s, t), t };
  if (i > 0 && !s.aborted) {
    const spec = legSpec(m, i - 1);
    if (spec.mode === 'intercept' && (spec.profile === 'thrust' || spec.profile === 'ballistic')) {
      const end = legEndState(legData(obj, i - 1, ctx, depth));
      if (end) return end;
    }
  }
  return { ...stopStateOf(s, t, ctx, depth, obj.id), t };
}

const driftCache = new WeakMap();

/**
 * Drift source { r, v, t } after the last stop of a route, or null: a route that ends at a waypoint with non-zero
 * velocity (engines cut) or with an intercept leg (the ship flies through the target) coasts on from there.
 */
export function terminalDrift(obj, ctx, depth = 0) {
  const m = obj?.motion;
  const n = m?.stops?.length ?? 0;
  if (m?.kind !== 'route' || n < 1) return null;
  const sig = `${ctx.version}|${trajGeneration()}`;
  const c = driftCache.get(obj);
  if (c && c.sig === sig && c.motion === m) return c.src;
  const last = m.stops[n - 1];
  let src = null;
  if (isWaypoint(last)) {
    if (!isZero([+last.vx || 0, +last.vy || 0, +last.vz || 0])) src = arrivalStateOf(obj, n - 1, ctx, depth);
  } else if (n >= 2 && last.arriveJd != null && m.stops[n - 2].departJd != null) {
    const spec = legSpec(m, n - 2);
    if (spec.mode === 'intercept' && (spec.profile === 'thrust' || spec.profile === 'ballistic')) {
      const end = legEndState(legData(obj, n - 2, ctx, depth));
      if (end) src = end;
    }
  }
  driftCache.set(obj, { sig, src, motion: m });
  return src;
}

// ---- state along a leg

function linearState(P0, P1, t0, T, jd) {
  const tau = T > 0 ? Math.min(1, Math.max(0, (jd - t0) / T)) : 1;
  return { r: vlerp(P0, P1, tau), v: T > 0 ? vscale(vsub(P1, P0), 1 / T) : [0, 0, 0] };
}

/** State { r, v } along a leg at time jd (t0 <= jd <= tEnd). */
export function legState(leg, jd) {
  const T = leg.T;
  switch (leg.profile) {
    case 'thrust': {
      const sol = legSolution(leg);
      if (!sol) return linearState(leg.P0, leg.P1, leg.t0, T, jd);
      if (jd < sol.arriveJd) return sol.stateAt(jd);
      const tg = leg.targetFn(jd);
      return { r: tg.r, v: tg.v };
    }
    case 'drift':
      return driftState(leg.drift, jd);
    case 'ballistic': {
      if (!leg.ballistic) return linearState(leg.P0, leg.P1, leg.t0, T, jd);
      const nb = legNbody(leg);
      if (nb?.ok) return interpolateSamples(nb.samples, jd);
      return propagateUniversal(leg.P0, leg.ballistic.v1, jd - leg.t0, GM_SUN);
    }
    case 'brachistochrone': {
      const tau = T > 0 ? (jd - leg.t0) / T : 1;
      const f = brachistochroneFraction(tau);
      const fd = tau <= 0 || tau >= 1 ? 0 : (tau < 0.5 ? 4 * tau : 4 * (1 - tau)) / T;
      return { r: vlerp(leg.P0, leg.P1, f), v: vscale(vsub(leg.P1, leg.P0), fd) };
    }
    default:
      return linearState(leg.P0, leg.P1, leg.t0, T, jd);
  }
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
    // at the instant of a zero-dwell intermediate stop (course change, flyby) the ship is already on the next leg
    const passThrough = i + 1 < n - 1 && B.departJd === B.arriveJd;
    if (jd < B.arriveJd || (jd === B.arriveJd && !passThrough)) return { kind: 'transit', leg: i };
  }
  return { kind: 'arrived', stop: n - 1 };
}

/** State { r, v } of a route object at jd. */
export function routeState(obj, jd, ctx, depth = 0) {
  const m = obj.motion;
  const ph = routePhase(m, jd);
  if (ph.kind === 'invalid') return { r: [0, 0, 0], v: [0, 0, 0] };
  if (ph.kind === 'transit') return legState(legData(obj, ph.leg, ctx, depth), jd);
  if (ph.kind === 'arrived') {
    const src = terminalDrift(obj, ctx, depth);
    if (src) return driftState(src, jd);
  }
  return stopStateOf(m.stops[ph.stop], jd, ctx, depth, obj.id);
}

/** The body / object a route ship is parked at (for the label offset), or null while moving or drifting. */
export function routeAnchor(obj, jd, ctx) {
  const m = obj.motion;
  const ph = routePhase(m, jd);
  if (ph.kind === 'transit' || ph.stop == null) return null;
  if (ph.kind === 'arrived' && terminalDrift(obj, ctx)) return null;
  const s = m.stops[ph.stop];
  if (s?.ref) return s.ref;
  if (isHold(s) && s.motion?.kind === 'colocated') return s.motion.parent;
  return null;
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
      return routeState(obj, jd, ctx, depth).r;
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
    } else if (ph.kind === 'arrived') {
      legInfo.drift = terminalDrift(obj, ctx);
    }
  }
  return { r, v, legInfo, error: ctx.errors.get(obj.id) ?? null };
}

// ------------------------------------------------------------------ drawing

/** Async status of a leg's background computations, used to detect when its drawn path is stale. */
function legStatusSig(leg) {
  const st = (key) => (key ? (peekTrajectory(key) ? 'k' : 'p') : '-');
  if (leg.profile === 'drift') return `d${st(leg.driftKey)}`;
  if (leg.profile === 'thrust') return `t${st(leg.thrustKey)}`;
  if (leg.profile === 'ballistic') return `b${st(leg.nbodyKey)}`;
  return '-';
}

/** Signature of a route's drawn path state (changes when a background trajectory for it arrives). */
export function pathSignature(obj, ctx) {
  const m = obj.motion;
  if (m?.kind !== 'route' || !m.stops || m.stops.length < 1) return '';
  const parts = [];
  for (let i = 0; i < m.stops.length - 1; i++) {
    const A = m.stops[i], B = m.stops[i + 1];
    if (A.departJd == null || B.arriveJd == null || !(B.arriveJd > A.departJd)) continue;
    parts.push(legStatusSig(legData(obj, i, ctx, 0)));
  }
  const d = terminalDrift(obj, ctx);
  if (d) parts.push(`e${d.t.toFixed(6)}${peekTrajectory(trajectoryKey('drift', driftParamsOf(d))) ? 'k' : 'p'}`);
  return parts.join(',');
}

/** Merge two sorted time lists (clipped to [t0, t1]), dropping near-duplicates. */
function mergeTimes(a, b, t0, t1) {
  const out = [];
  let i = 0, j = 0;
  while (i < a.length || j < b.length) {
    const t = j >= b.length || (i < a.length && a[i] <= b[j]) ? a[i++] : b[j++];
    if (t < t0 || t > t1) continue;
    if (!out.length || t - out[out.length - 1] > 1e-7) out.push(t);
  }
  return out;
}

const uniformTimes = (t0, t1, n) => Array.from({ length: n + 1 }, (_, k) => t0 + ((t1 - t0) * k) / n);

/**
 * Polylines for drawing a route: one per transfer leg (sampled over the time it is actually flown: a cut leg ends at
 * the course change), plus the dashed drift path after a route that ends with the engines off. Integrator steps of
 * N-body / gravity-refined legs are merged into the uniform grid (dense near planetary encounters). Points are stored
 * relative to `origin` (the leg's start point) to keep float32 precision on the GPU; `jds` holds the time of every
 * point (for the past/future split).
 * @returns {{leg:number|'drift', t0:number, t1:number, origin:number[], points:number[][], jds:number[], profile:string,
 *   style:'solid'|'drift', fallback:boolean, nbody:null|'pending'|'ok'|'failed'}[]}
 */
export function customPath(obj, ctx, samples = 256) {
  const m = obj.motion;
  if (!m || m.kind !== 'route' || !m.stops || m.stops.length < 1) return [];
  const out = [];
  for (let i = 0; i < m.stops.length - 1; i++) {
    const A = m.stops[i], B = m.stops[i + 1];
    if (A.departJd == null || B.arriveJd == null || !(B.arriveJd > A.departJd)) continue;
    const leg = legData(obj, i, ctx, 0);
    const tA = leg.t0;
    let tB = leg.tEnd;
    let extra = [];
    let nbody = null;
    if (leg.profile === 'ballistic' && leg.ballistic) {
      const nb = legNbody(leg);
      nbody = nb ? (nb.ok ? 'ok' : 'failed') : 'pending';
      if (nb?.ok) extra = nb.samples.map((s) => s.jd);
    } else if (leg.profile === 'thrust') {
      const sol = legSolution(leg);
      if (sol) { tB = Math.min(tB, Math.max(tA, sol.arriveJd)); if (sol.samples) extra = sol.samples.map((s) => s.jd); }
    } else if (leg.profile === 'drift') {
      const res = driftResult(leg.drift);
      if (res?.ok) extra = res.samples.map((s) => s.jd);
    }
    const jds = mergeTimes(uniformTimes(tA, tB, samples), extra, tA, tB);
    const origin = leg.P0;
    const pts = jds.map((t) => vsub(legState(leg, t).r, origin));
    out.push({
      leg: i, t0: tA, t1: tB, origin, points: pts, jds, profile: leg.profile, style: leg.profile === 'drift' ? 'drift' : 'solid',
      fallback: leg.fallback, nbody,
    });
  }
  const d = terminalDrift(obj, ctx);
  if (d) {
    const t1 = d.t + DRIFT_DRAW_DAYS;
    const res = driftResult(d);
    const jds = mergeTimes(uniformTimes(d.t, t1, samples * 2), res?.ok ? res.samples.map((s) => s.jd) : [], d.t, t1);
    const pts = jds.map((t) => vsub(driftState(d, t).r, d.r));
    out.push({ leg: 'drift', t0: d.t, t1, origin: d.r, points: pts, jds, profile: 'drift', style: 'drift', fallback: false, nbody: null });
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

/** Normalise a leg definition from the editor / a scenario file. */
export function normalizeLegDef(L) {
  if (!L || !LEG_PROFILES.includes(L.profile)) return null;
  const out = { profile: L.profile };
  if (L.profile === 'thrust' || L.profile === 'ballistic') out.mode = L.mode === 'intercept' ? 'intercept' : 'rendezvous';
  if (L.profile === 'thrust' || L.profile === 'brachistochrone') { const g = Number(L.accelG); if (g > 0) out.accelG = g; }
  return out;
}

/**
 * Resolve and validate a route draft. Draft stops carry raw strings `arriveStr`/`departStr` (or numbers
 * arriveJd/departJd), an optional per-leg definition `leg` ({ profile, mode, accelG }), or `raw` (a waypoint / hold
 * stop kept verbatim). Brachistochrone legs with an empty arrival are solved from `accelG`; thrust legs always have
 * their arrival solved (constant-thrust rendezvous / intercept from the departure state, refined under gravity).
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
    if (d.raw) {
      // course-change waypoint or start hold, recorded by a command: kept as is
      const stop = structuredClone(d.raw);
      if (isHold(stop) && i > 0) errors.push(`${label}: the start position can only be the first stop.`);
      const t = stop.arriveJd ?? stop.departJd;
      if (t != null && prevTime != null && !(t >= prevTime)) errors.push(`${label}: this course change (${nameOfStop(stop, ctx)}) happens before the previous time; remove it or fix the earlier times.`);
      prevTime = stop.departJd ?? stop.arriveJd ?? prevTime;
      prevValid = true;
      stops.push(stop);
      continue;
    }
    const stop = { ref: d.ref || null, arriveJd: null, departJd: null };
    const legDef = i > 0 ? normalizeLegDef(d.leg) : null;
    if (legDef) stop.leg = legDef;
    const profile = legDef?.profile ?? draft.profile;
    const flyby = !!d.flyby && i > 0 && i < n - 1;
    if (flyby) stop.flyby = true;
    // optional parking-orbit altitude (km) used for departure/capture delta-v at this stop
    const parkRaw = d.parkAltStr !== undefined ? String(d.parkAltStr).trim() : (d.parkAltKm != null ? String(d.parkAltKm) : '');
    if (parkRaw !== '') {
      const alt = Number(parkRaw);
      if (!Number.isFinite(alt) || alt < 0) errors.push(`${label}: parking altitude must be a non-negative number of km.`);
      else stop.parkAltKm = alt;
    }
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
      if (profile === 'thrust') {
        if (prevTime != null && valid && prevValid) {
          const prev = { ...stops[i - 1], departJd: prevTime };
          const spec = { profile: 'thrust', mode: legDef?.mode ?? 'rendezvous', accelG: legDef?.accelG ?? draft.accelG ?? DEFAULT_ACCEL_G };
          const res = solveThrustLegNow(prev, stop, prevTime, spec, ctx);
          if (res.ok) { stop.arriveJd = res.arriveJd; stop.solved = true; }
          else errors.push(`${label}: no constant-thrust solution from the previous stop (${res.reason}).`);
        } else errors.push(`${label}: the arrival is solved from the previous stop's departure; fix that first.`);
      } else {
        const p = d.arriveStr !== undefined ? parseStopTime(d.arriveStr, prevTime, parseDateToJd) : (d.arriveJd != null ? { jd: d.arriveJd } : { blank: true });
        const accelG = profile === 'brachistochrone' ? (legDef?.accelG ?? draft.accelG) : null;
        if (p.error) errors.push(`${label} arrival: ${p.error}.`);
        else if (p.blank) {
          const canSolve = profile === 'brachistochrone' && accelG > 0;
          if (canSolve && prevTime != null && valid && prevValid) {
            const T = solveBrachistochroneTime(stops[i - 1], stop, prevTime, accelG, ctx);
            stop.arriveJd = prevTime + T;
            stop.solved = true;
          } else if (canSolve) errors.push(`${label}: arrival cannot be solved until the previous stop and departure are valid.`);
          else errors.push(`${label}: arrival time required${profile === 'brachistochrone' ? ' (or set an acceleration to solve it)' : ''}.`);
        } else stop.arriveJd = p.jd;
      }
      if (stop.arriveJd != null && prevTime != null && !(stop.arriveJd > prevTime)) errors.push(`${label}: arrival must be after the previous departure.`);
      if (stop.arriveJd != null) prevTime = stop.arriveJd;
    }
    // departure (a flyby departs the instant it arrives)
    if (flyby) {
      if (stop.arriveJd == null) errors.push(`${label}: a flyby needs an arrival time.`);
      else stop.departJd = stop.arriveJd;
    } else if (i < n - 1) {
      const p = d.departStr !== undefined ? parseStopTime(d.departStr, prevTime, parseDateToJd) : (d.departJd != null ? { jd: d.departJd } : { blank: true });
      if (p.error) errors.push(`${label} departure: ${p.error}.`);
      else if (p.blank) errors.push(`${label}: departure time required.`);
      else {
        stop.departJd = p.jd;
        if (i > 0 && stop.arriveJd != null && !(stop.departJd >= stop.arriveJd)) errors.push(`${label}: departure must not be before arrival.`);
        prevTime = stop.departJd;
      }
    }
    prevValid = valid;
    stops.push(stop);
  }
  // legs summary (only when consistent)
  const legs = [];
  if (!errors.length && n >= 2) {
    const tmp = { id: `__draft_${Math.random()}`, motion: { kind: 'route', profile: draft.profile, accelG: draft.accelG ?? undefined, stops } };
    for (let i = 0; i < n - 1; i++) {
      if (stops[i].departJd == null || stops[i + 1].arriveJd == null) continue;
      const leg = legData(tmp, i, ctx, 0);
      legs.push(leg);
      const spec = legSpec(tmp.motion, i);
      if (spec.profile === 'brachistochrone') {
        const accelG = auDay2ToMS2(leg.accel) / G0_M_S2;
        const nominal = spec.accelG;
        if (nominal > 0 && !stops[i + 1].solved && !leg.cut && Math.abs(accelG / nominal - 1) > 0.01) {
          warnings.push(`Leg ${i + 1}: the explicit arrival time needs ${accelG.toPrecision(3)} g, not the nominal ${nominal} g (clear the arrival to solve it from the acceleration).`);
        }
        if (accelG < 0.01) warnings.push(`Leg ${i + 1}: ${accelG.toFixed(4)} g is below ~0.01 g; solar gravity is not negligible at this thrust.`);
      }
      if (spec.profile === 'thrust' && spec.accelG > 0 && spec.accelG < 0.003) warnings.push(`Leg ${i + 1}: below ~0.003 g the Sun's pull is a large fraction of the thrust; the solution is approximate.`);
      if (spec.profile === 'ballistic' && leg.fallback) warnings.push(`Leg ${i + 1}: no ballistic solution; drawn as a straight line.`);
      if (spec.profile === 'ballistic' && leg.ballistic && leg.ballistic.e >= 1) warnings.push(`Leg ${i + 1}: hyperbolic transfer (e = ${leg.ballistic.e.toFixed(2)}); very fast for a ballistic coast.`);
    }
    if (stops.some((st, i) => st.flyby && !(legSpec(tmp.motion, i - 1).profile === 'ballistic' && legSpec(tmp.motion, i).profile === 'ballistic'))) {
      warnings.push('Flyby stops get a gravity-assist analysis only between ballistic legs; elsewhere they are zero-dwell waypoints.');
    }
    for (let i = 0; i < n - 1; i++) legCache.delete(`${tmp.id}#${i}`);
  }
  return { stops, errors, warnings, legs };
}

const PROFILE_LABEL = { thrust: 'torch', ballistic: 'ballistic', brachistochrone: 'brachistochrone', linear: 'linear', drift: 'drift' };

/** Short human description of a motion. */
export function motionSummary(obj, ctx) {
  const m = obj.motion || {};
  switch (m.kind) {
    case 'orbit': return `Orbit about ${nameOf(m.parent, ctx)}`;
    case 'colocated': return `${m.label ? m.label + ' — ' : ''}at ${nameOf(m.parent, ctx)}`;
    case 'lagrange': return `${nameOf(m.primary, ctx)}–${nameOf(m.secondary, ctx)} ${m.point}`;
    case 'fixed': return 'Fixed heliocentric point';
    case 'route': {
      const profiles = new Set();
      for (let i = 0; i < m.stops.length - 1; i++) profiles.add(PROFILE_LABEL[legSpec(m, i).profile] ?? legSpec(m, i).profile);
      const prof = [...profiles].join(' + ') || PROFILE_LABEL[m.profile] || m.profile;
      const accel = m.profile === 'brachistochrone' && m.accelG && profiles.size === 1 ? `, ${m.accelG} g` : '';
      return `Route (${prof}${accel}): ${m.stops.map((s) => (s.ref ? nameOf(s.ref, ctx) : isWaypoint(s) ? '(course change)' : isHold(s) ? 'start' : 'point')).join(' → ')}`;
    }
    default: return 'Unknown motion';
  }
}

/** Ids referenced by an object's motion. */
export function referencedIds(obj) {
  const m = obj.motion || {};
  if (m.kind === 'orbit' || m.kind === 'colocated') return [m.parent];
  if (m.kind === 'lagrange') return [m.primary, m.secondary];
  if (m.kind === 'route') {
    const out = [];
    for (const s of m.stops) {
      if (s.ref) out.push(s.ref);
      if (s.aborted?.ref) out.push(s.aborted.ref);
      if (isHold(s) && s.motion) out.push(...referencedIds({ motion: s.motion }));
    }
    return out;
  }
  return [];
}
