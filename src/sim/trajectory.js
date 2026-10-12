// Lazy N-body trajectory work for route legs and the travel planner (src/astro/nbody.js): ballistic-leg targeting
// and brachistochrone gravity audits. Jobs run one at a time in idle time (requestIdleCallback, falling back to
// setTimeout) so interaction stays smooth, and results are cached in memory keyed by the leg geometry (so editing an
// object's notes, colour, or anything else that does not move the endpoints never recomputes a leg).
import { vsub, vlen } from '../astro/vec3.js';
import { cachePerturbers, makeAccel, targetTransfer, brachistochroneGravityAudit, integrate } from '../astro/nbody.js';
import { planManeuver } from '../astro/maneuver.js';
import { getPerturbers } from './ephemeris.js';

const MAX_RESULTS = 400;
const MAX_JOBS = 96;

/** key -> result (Map order = LRU order) */
const results = new Map();
/** key -> { kind, params, group } (Map order = request order; the most recent request runs first) */
const jobs = new Map();
const listeners = new Set();
let scheduled = false;
let notifyPending = false;
/** Bumps whenever a result is stored: legs that depend on other objects' trajectories include it in their cache key. */
let generation = 0;

/** Current result generation (see above). */
export const trajGeneration = () => generation;

const fx = (a, d) => a.map((x) => x.toFixed(d)).join(',');

/**
 * Cache key for a trajectory job: the leg geometry (times to ~0.1 s, positions to ~1.5 m) and endpoint set.
 * Thrust and drift jobs carry their own key (`p.key`, built by the caller from the stop data).
 * @param {'ballistic'|'audit'|'thrust'|'drift'} kind
 */
export function trajectoryKey(kind, p) {
  if (p.key) return `${kind}|${p.key}`;
  const t1 = p.t1 ?? p.t0 + p.T;
  return [kind, p.t0.toFixed(6), t1.toFixed(6), fx(p.P0, 11), fx(p.P1, 11), (p.endpointIds || []).join('+'), p.a != null ? p.a.toPrecision(10) : ''].join('|');
}

/** Key fragment for a state vector (position ~1.5 m, velocity ~2e-9 m/s resolution). */
export const stateKey = (r, v) => `${fx(r, 11)}|${fx(v, 13)}`;

/**
 * Ballistic leg in the Sun + 8 planets field with patched-conic endpoints: differential-correction targeting from
 * the two-body Lambert guess `v1`.
 * @param {{P0:number[], t0:number, P1:number[], t1:number, v1:number[], endpointIds:string[]}} p
 */
export function computeBallistic(p) {
  const t = now();
  const cached = cachePerturbers(getPerturbers(), p.t0, p.t1);
  const accel = makeAccel(cached, { endpointIds: p.endpointIds });
  const tgt = targetTransfer(accel, p.P0, p.t0, p.P1, p.t1, p.v1, { track: cached, endpointIds: p.endpointIds });
  const soi = new Map(cached.map((c) => [c.id, c.soiAu]));
  const closest = Object.entries(tgt.closest)
    .map(([id, c]) => ({ id, jd: c.jd, distAu: c.distAu, soiAu: soi.get(id) }))
    .sort((a, b) => a.distAu - b.distAu);
  return {
    kind: 'ballistic', ok: !!tgt.ok, v0: tgt.v0, vEnd: tgt.vEnd, samples: tgt.ok ? tgt.samples : null,
    missAu: tgt.missAu, iterations: tgt.iterations, steps: tgt.steps, closest, impacts: tgt.impacts,
    correctionAuDay: vlen(vsub(tgt.v0, p.v1)), ms: now() - t,
  };
}

/**
 * Gravity audit of a straight-line brachistochrone leg (profile acceleration `a`, AU/day^2) in the same field.
 * @param {{P0:number[], P1:number[], t0:number, T:number, a:number, endpointIds:string[]}} p
 */
export function computeAudit(p) {
  const t = now();
  const cached = cachePerturbers(getPerturbers(), p.t0, p.t0 + p.T);
  const accel = makeAccel(cached, { endpointIds: p.endpointIds });
  const r = brachistochroneGravityAudit(p.P0, p.P1, p.t0, p.T, p.a, accel);
  return { kind: 'audit', ok: true, ...r, aProfile: p.a, ms: now() - t };
}

/**
 * Constant-thrust maneuver (torch ship) from an arbitrary state to a moving target, refined under the gravity of the
 * Sun and the 8 planets (src/astro/maneuver.js planManeuver). The perturber table spans 1.5x the kinematic trip time.
 * @param {{P0:number[], V0:number[], t0:number, a:number, mode:'rendezvous'|'intercept', targetFn:(jd:number)=>{r:number[],v:number[]},
 *   Tkin:number, endpointIds:string[]}} p
 * @returns {{kind:'thrust', ok:boolean, sol:Object|null, gravityRefined:boolean, ms:number}}
 */
export function computeThrust(p) {
  const t = now();
  const span = Math.max(1.5 * p.Tkin, p.Tkin + 1);
  const cached = cachePerturbers(getPerturbers(), p.t0, p.t0 + span);
  const gravity = makeAccel(cached, { endpointIds: p.endpointIds });
  const sol = planManeuver(p.mode, p.P0, p.V0, p.t0, p.targetFn, p.a, gravity);
  const ok = !!sol.ok || (sol.approximate && Number.isFinite(sol.T));
  return { kind: 'thrust', ok, sol: ok ? sol : null, gravityRefined: !!sol.gravityRefined, refineFailure: sol.refineFailure ?? null, ms: now() - t };
}

/** Days of N-body drift computed for a ship with its engines off (beyond that, two-body propagation). */
export const DRIFT_SPAN_DAYS = 4 * 365.25;

/**
 * Engines-off coast in the Sun + 8 planets field (no endpoint exclusion) from a state, for DRIFT_SPAN_DAYS.
 * @param {{r0:number[], v0:number[], t0:number, span?:number}} p
 */
export function computeDrift(p) {
  const t = now();
  const span = p.span ?? DRIFT_SPAN_DAYS;
  const cached = cachePerturbers(getPerturbers(), p.t0, p.t0 + span);
  const accel = makeAccel(cached, {});
  const res = integrate(accel, p.r0, p.v0, p.t0, p.t0 + span, { rtol: 1e-10, hMax: 5, maxSteps: 40000, track: cached });
  const samples = res.samples;
  return { kind: 'drift', ok: samples.length > 1, samples, t1: samples[samples.length - 1].jd, impacts: res.impacts, ms: now() - t };
}

function compute(kind, params) {
  if (kind === 'ballistic') return computeBallistic(params);
  if (kind === 'thrust') return computeThrust(params);
  if (kind === 'drift') return computeDrift(params);
  return computeAudit(params);
}

/**
 * Return the cached result for a job, or queue it and return null. Re-requesting a queued job moves it to the
 * front of the queue (the most recently needed leg is computed first).
 * @param {'ballistic'|'audit'} kind
 * @param {Object} params see computeBallistic / computeAudit
 * @param {string} [group] tag used by cancelGroup()
 * @returns {{key:string, result:Object|null}}
 */
export function requestTrajectory(kind, params, group = 'route') {
  const key = trajectoryKey(kind, params);
  const r = results.get(key);
  if (r) return { key, result: r };
  if (jobs.has(key)) jobs.delete(key);
  jobs.set(key, { kind, params, group });
  while (jobs.size > MAX_JOBS) jobs.delete(jobs.keys().next().value);
  schedule();
  return { key, result: null };
}

/** Compute (or fetch from the cache) synchronously. */
export function computeTrajectoryNow(kind, params) {
  const key = trajectoryKey(kind, params);
  let r = results.get(key);
  if (!r) { r = safeCompute(kind, params); remember(key, r); jobs.delete(key); }
  return r;
}

/** Cached result for `key`, or null. */
export function peekTrajectory(key) {
  return key ? results.get(key) ?? null : null;
}

/** True while a job for `key` is queued. */
export function isTrajectoryPending(key) {
  return !!key && jobs.has(key);
}

/** Drop queued (not yet started) jobs with this group tag, e.g. stale planner scans. */
export function cancelGroup(group) {
  for (const [k, j] of jobs) if (j.group === group) jobs.delete(k);
}

/** Number of queued jobs. */
export const pendingTrajectoryCount = () => jobs.size;

/** Subscribe to "new results available" notifications (coalesced to at most one per frame). */
export function onTrajectoryUpdate(fn) {
  listeners.add(fn);
  return () => listeners.delete(fn);
}

function remember(key, r) {
  generation++;
  results.delete(key);
  results.set(key, r);
  while (results.size > MAX_RESULTS) results.delete(results.keys().next().value);
}

function safeCompute(kind, params) {
  try {
    return compute(kind, params);
  } catch (err) {
    return { kind, ok: false, error: String(err?.message ?? err) };
  }
}

const now = () => (globalThis.performance ? performance.now() : Date.now());
const idle = typeof globalThis.requestIdleCallback === 'function'
  ? (fn) => globalThis.requestIdleCallback(fn, { timeout: 250 })
  : (fn) => setTimeout(fn, 30);
/** Next animation frame, or 100 ms later if frames are paused (hidden tab): whichever comes first, once. */
const nextFrame = (fn) => {
  let done = false;
  const once = () => { if (!done) { done = true; fn(); } };
  if (typeof globalThis.requestAnimationFrame === 'function') globalThis.requestAnimationFrame(once);
  setTimeout(once, typeof globalThis.requestAnimationFrame === 'function' ? 100 : 0);
};

function schedule() {
  if (scheduled || !jobs.size) return;
  scheduled = true;
  idle(runOne);
}

/** Run the most recently requested job (one per idle slot: a job takes ~5-60 ms). */
function runOne() {
  scheduled = false;
  if (!jobs.size) return;
  let key = null;
  for (const k of jobs.keys()) key = k;
  const job = jobs.get(key);
  jobs.delete(key);
  remember(key, safeCompute(job.kind, job.params));
  notify();
  schedule();
}

function notify() {
  if (notifyPending) return;
  notifyPending = true;
  nextFrame(() => {
    notifyPending = false;
    for (const fn of listeners) fn();
  });
}
