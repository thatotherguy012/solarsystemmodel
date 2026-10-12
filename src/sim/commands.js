// Ship commands (v3 command mode): send a ship somewhere from wherever it is right now (rendezvous or intercept, torch
// or coast drive), and cut its engines. A command never rewrites the ship's past: the route is truncated at the
// current simulation time and the new course starts from the ship's actual state there.
//
//   parked at a stop        -> depart from that stop now (body state; parking-orbit burns for coast ships)
//   on a leg                -> the leg is cut at t_now (a waypoint stop records the state and keeps the original
//                              destination as `aborted`, so the flown part of the leg is unchanged)
//   drifting (engines off)  -> the drift so far becomes a 'drift' leg into a waypoint snapshot
//   not on a route          -> a 'hold' first stop keeps the old motion (orbit, Lagrange point, …) until t_now
import { GM_SUN, G0_M_S2, auDay2ToMS2 } from '../astro/constants.js';
import { vsub, vlen } from '../astro/vec3.js';
import { lambert, propagateUniversal } from '../astro/lambert.js';
import { solveRendezvousForTime } from '../astro/maneuver.js';
import { hasBody } from './ephemeris.js';
import { computeTrajectoryNow } from './trajectory.js';
import {
  routePhase, routeState, terminalDrift, legData, isWaypoint, stopStateOf, stopTargetFn, stopFrameVelocity, stopPerturberId,
  thrustSetup, driveOf, nameOf, customPosition, velocityOf, DEFAULT_ACCEL_G,
} from './custom.js';
import { endBurn, solutionPeakSpeed } from './legPhysics.js';

const clone = (x) => structuredClone(x);

/** Waypoint stop recording a ship state at jd. */
function waypointAt(st, jd, extra = {}) {
  return { ref: null, kind: 'waypoint', x: st.r[0], y: st.r[1], z: st.r[2], vx: st.v[0], vy: st.v[1], vz: st.v[2], arriveJd: jd, departJd: jd, ...extra };
}

/** A stop's planned destination without nested course-change data. */
function plannedStop(B) {
  const s = clone(B.aborted ?? B);
  delete s.aborted;
  return s;
}

/**
 * Where a new course starts: the stops to keep (history) and the stop the new leg departs from at jd.
 * @param {Object} obj custom object
 * @param {number} jd
 * @param {import('./custom.js').CustomContext} ctx
 * @param {{forceWaypoint?:boolean}} [opt] always end with a waypoint snapshot (cutting the engines)
 * @returns {{stops:Object[], dep:Object, state:{r:number[], v:number[]}, phase:string}}
 */
export function courseBase(obj, jd, ctx, opt = {}) {
  const m = obj.motion || {};
  if (m.kind !== 'route' || !m.stops?.length) {
    const st = { r: customPosition(obj, jd, ctx), v: velocityOf(obj.id, jd, ctx) };
    if (opt.forceWaypoint) {
      const hold = { ref: null, kind: 'hold', motion: clone(m), arriveJd: null, departJd: jd };
      return { stops: [hold, waypointAt(st, jd, { leg: { profile: 'drift' } })], dep: null, state: st, phase: 'static' };
    }
    if (m.kind === 'colocated' && hasBody(m.parent)) {
      const s = { ref: m.parent, arriveJd: null, departJd: jd };
      return { stops: [s], dep: s, state: stopStateOf(s, jd, ctx), phase: 'static' };
    }
    const hold = { ref: null, kind: 'hold', motion: clone(m), arriveJd: null, departJd: jd };
    return { stops: [hold], dep: hold, state: st, phase: 'static' };
  }
  const stops = m.stops;
  const ph = routePhase(m, jd);
  if (ph.kind === 'transit') {
    const i = ph.leg;
    const keep = stops.slice(0, i + 1).map(clone);
    if (jd <= stops[i].departJd && !opt.forceWaypoint) {
      keep[i].departJd = jd;
      return { stops: keep, dep: keep[i], state: stopStateOf(keep[i], jd, ctx, 0, obj.id), phase: 'transit' };
    }
    const st = routeState(obj, jd, ctx);
    const wp = waypointAt(st, jd, { aborted: plannedStop(stops[i + 1]) });
    return { stops: [...keep, wp], dep: wp, state: st, phase: 'transit' };
  }
  const k = ph.stop ?? 0;
  const keep = stops.slice(0, k + 1).map(clone);
  const drift = ph.kind === 'arrived' ? terminalDrift(obj, ctx) : null;
  if (drift || opt.forceWaypoint) {
    const st = routeState(obj, jd, ctx);
    if (drift) keep[k].departJd = keep[k].arriveJd ?? jd; // the drift so far becomes a drift leg
    else keep[k].departJd = jd;
    delete keep[k].flyby;
    const wp = waypointAt(st, jd, { leg: { profile: 'drift' } });
    return { stops: [...keep, wp], dep: wp, state: st, phase: drift ? 'drift' : 'parked' };
  }
  keep[k].departJd = jd;
  if (keep[k].arriveJd != null && keep[k].arriveJd > jd) keep[k].arriveJd = jd;
  delete keep[k].flyby;
  return { stops: keep, dep: keep[k], state: stopStateOf(keep[k], jd, ctx, 0, obj.id), phase: ph.kind };
}

/** Destination stop for a target: { ref } (body or custom object) or { point: [x, y, z] } (heliocentric AU). */
function destStopFor(target) {
  if (target.ref) return { ref: target.ref, arriveJd: null, departJd: null };
  const [x, y, z] = target.point;
  return { ref: null, x, y, z, arriveJd: null, departJd: null };
}

/** Days for a Hohmann-like transfer between the radii of two heliocentric points. */
export function hohmannDays(r1, r2) {
  const a = (vlen(r1) + vlen(r2)) / 2;
  return Math.PI * Math.sqrt((a * a * a) / GM_SUN);
}

/**
 * Plan a course for one ship (kinematic / two-body preview). Call `.apply(refine)` on the result for the new motion.
 * @param {Object} obj ship (custom object with a drive)
 * @param {{ref?:string, point?:number[]}} target
 * @param {{mode?:'rendezvous'|'intercept', drive?:Object, arriveByJd?:number, durationDays?:number}} opts
 * @param {number} jd current simulation time
 * @param {import('./custom.js').CustomContext} ctx
 * @returns {Object} { ok, reason?, kind:'torch'|'coast', mode, t0, arriveJd, T, peakSpeed?, deltaV?, closingSpeed?,
 *   burnNow?, arrivalBurn?, accelG?, preview:number[][] (heliocentric points), scan?, apply:(refine?:boolean)=>Object }
 */
export function planCourse(obj, target, opts, jd, ctx) {
  const mode = opts.mode === 'intercept' ? 'intercept' : 'rendezvous';
  const drive = opts.drive ?? driveOf(obj);
  if (!drive) return { ok: false, reason: `${obj.name} has no drive` };
  if (target.ref === obj.id) return { ok: false, reason: 'A ship cannot target itself' };
  const base = courseBase(obj, jd, ctx);
  const dest = destStopFor(target);
  const dep = base.dep;
  const t0 = jd;
  const depState = stopStateOf(dep, t0, ctx, 0, obj.id);
  const targetFn = stopTargetFn(dest, ctx);
  const endpointIds = [...new Set([stopPerturberId(dep, ctx), stopPerturberId(dest, ctx)].filter(Boolean))];
  const targetName = target.ref ? nameOf(target.ref, ctx) : 'point in space';

  if (drive.kind === 'torch') {
    let accelG = opts.accelG ?? drive.accelG ?? DEFAULT_ACCEL_G;
    if (opts.arriveByJd != null) {
      const T = opts.arriveByJd - t0;
      if (!(T > 0)) return { ok: false, reason: 'The arrival must be after the current time' };
      const s = solveRendezvousForTime(depState.r, depState.v, t0, targetFn, T);
      if (!s.ok) return { ok: false, reason: s.reason || 'no constant-thrust solution for that arrival time' };
      accelG = auDay2ToMS2(s.accel) / G0_M_S2;
    }
    const spec = { profile: 'thrust', mode, accelG };
    const th = thrustSetup(depState, t0, dest, spec, endpointIds, ctx);
    if (!th.params) return { ok: false, reason: `no constant-thrust solution to ${targetName}` };
    const kin = th.kin;
    const preview = [];
    for (let k = 0; k <= 96; k++) preview.push(kin.stateAt(t0 + (kin.T * k) / 96).r);
    let closing = null;
    if (mode === 'intercept') closing = kin.closingSpeed;
    return {
      ok: true, kind: 'torch', mode, t0, targetName, arriveJd: kin.arriveJd, T: kin.T, deltaV: kin.deltaV,
      closingSpeed: closing, flipJd: kin.flipJd ?? null, accelG, startSpeed: vlen(depState.v), preview, base,
      peakSpeed: solutionPeakSpeed(kin),
      apply(refine = true) {
        let arriveJd = kin.arriveJd;
        if (refine) {
          const res = computeTrajectoryNow('thrust', th.params);
          if (res?.ok && res.sol) arriveJd = res.sol.arriveJd;
        }
        const stop = { ...dest, arriveJd, leg: { profile: 'thrust', mode, accelG: +accelG.toPrecision(6) } };
        return newRouteMotion(obj, base.stops, stop, drive);
      },
    };
  }

  // coast drive: two-body Lambert, minimum-burn duration over a scan (N-body targeting refines it after apply)
  const TH = hohmannDays(depState.r, targetFn(t0).r);
  const durations = opts.durationDays > 0 ? [opts.durationDays]
    : Array.from({ length: 8 }, (_, k) => 0.3 * TH * Math.pow(2.5 / 0.3, k / 7));
  const vFrameDep = stopFrameVelocity(dep, t0, ctx);
  const scan = [];
  for (const T of durations) {
    const t1 = t0 + T;
    const tg = targetFn(t1);
    const sol = lambert(depState.r, tg.r, T, GM_SUN, true);
    if (!sol.ok) { scan.push({ T, ok: false }); continue; }
    const vinfDep = vlen(vsub(sol.v1, vFrameDep));
    const depBurn = endBurn(dep, vinfDep, ctx, false);
    const vArrFrame = dest.ref ? stopFrameVelocity(dest, t1, ctx) : tg.v;
    const vinfArr = vlen(vsub(sol.v2, vArrFrame));
    const arrBurn = mode === 'intercept' ? { kind: 'intercept', dv: 0 } : endBurn(dest, vinfArr, ctx, false);
    scan.push({ T, ok: true, v1: sol.v1, burnNow: depBurn.dv, depBurn, arrivalBurn: arrBurn.dv, arrBurn, closing: vlen(vsub(sol.v2, tg.v)),
      cost: mode === 'intercept' ? depBurn.dv : depBurn.dv + arrBurn.dv });
  }
  const okRows = scan.filter((s) => s.ok);
  if (!okRows.length) return { ok: false, reason: `no ballistic (Lambert) solution to ${targetName}` };
  const best = okRows.reduce((a, b) => (b.cost < a.cost ? b : a));
  const preview = [];
  for (let k = 0; k <= 128; k++) preview.push(propagateUniversal(depState.r, best.v1, (best.T * k) / 128, GM_SUN).r);
  return {
    ok: true, kind: 'coast', mode, t0, targetName, arriveJd: t0 + best.T, T: best.T, burnNow: best.burnNow, arrivalBurn: best.arrivalBurn,
    closingSpeed: mode === 'intercept' ? best.closing : null, depBurnKind: best.depBurn.kind, hohmannDays: TH, scan, preview, base,
    apply() {
      const stop = { ...dest, arriveJd: t0 + best.T, leg: { profile: 'ballistic', mode } };
      return newRouteMotion(obj, base.stops, stop, drive);
    },
  };
}

/** The ship's new motion: kept stops + the new destination, keeping the route defaults of the old legs. */
function newRouteMotion(obj, stops, dest, drive) {
  const m = obj.motion || {};
  if (m.kind === 'route') return { ...m, stops: [...stops, dest] };
  return drive.kind === 'torch'
    ? { kind: 'route', profile: 'thrust', accelG: drive.accelG ?? DEFAULT_ACCEL_G, stops: [...stops, dest] }
    : { kind: 'route', profile: 'ballistic', stops: [...stops, dest] };
}

/**
 * Cut a ship's engines at jd: the route is truncated there and ends at a waypoint with the ship's current velocity,
 * so it coasts on (N-body drift).
 * @returns {{ok:boolean, reason?:string, motion?:Object, speed?:number}}
 */
export function planCutEngines(obj, jd, ctx) {
  const m = obj.motion;
  if (m?.kind !== 'route') return { ok: false, reason: `${obj.name} is not under way (no route)` };
  const ph = routePhase(m, jd);
  if (ph.kind !== 'transit') {
    if (ph.kind === 'arrived' && terminalDrift(obj, ctx)) return { ok: false, reason: `${obj.name}'s engines are already off` };
    return { ok: false, reason: `${obj.name} is parked at ${nameOf(m.stops[ph.stop]?.ref, ctx)}; nothing to cut` };
  }
  const leg = legData(obj, ph.leg, ctx);
  if (leg.profile === 'drift') return { ok: false, reason: `${obj.name}'s engines are already off` };
  const base = courseBase(obj, jd, ctx, { forceWaypoint: true });
  const last = base.stops[base.stops.length - 1];
  if (!isWaypoint(last)) return { ok: false, reason: 'could not record the current state' };
  return { ok: true, motion: { ...m, stops: base.stops }, speed: vlen(base.state.v) };
}
