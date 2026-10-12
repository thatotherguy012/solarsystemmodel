// Launch-window maths for the travel planner's "Launch windows" tab:
//  - ballistic porkchop grids: two-body Lambert transfers (Sun only, prograde, zero revolutions) over a grid of
//    departure dates x flight times, with departure / arrival excess speeds and the parking-orbit burns used by
//    route legs (legPhysics.stopGravity + nbody.parkingOrbitDeltaV, so the defaults are identical);
//  - launch-window detection: local minima of the cheapest transfer per departure date, at most one per synodic
//    period, refined by a small pattern search on the continuous (departure, flight time) problem;
//  - torch-ship window curves: gravity-free constant-thrust rendezvous / intercept trip times
//    (astro/maneuver.js) for departures sampled across the span.
// Pure computation plus a tiny time-sliced scheduler (runChunked); no DOM. Internal units: AU, days, AU/day, JD.
import { GM_SUN, auDayToKmS } from '../astro/constants.js';
import { vsub, vlen, vdot, vcross } from '../astro/vec3.js';
import { lambert } from '../astro/lambert.js';
import { parkingOrbitDeltaV } from '../astro/nbody.js';
import { solveRendezvous, solveIntercept } from '../astro/maneuver.js';
import { hasBody, getBody, getState } from './ephemeris.js';
import { positionOf, velocityOf, stopFrameBody, stopFrameVelocity } from './custom.js';
import { stopGravity } from './legPhysics.js';

/** Default porkchop parameters (span and flight times in days). */
export const PORKCHOP_DEFAULTS = Object.freeze({ spanDays: 730.5, tofMin: 60, tofMax: 600, nx: 72, ny: 60 });

/** Departure-span choices (days, label). */
export const SPAN_CHOICES = Object.freeze([
  [182.625, '6 months'], [365.25, '1 year'], [547.875, '18 months'], [730.5, '2 years'],
  [1095.75, '3 years'], [1461, '4 years'], [1826.25, '5 years'],
]);

/** Grid-resolution choices: [departure columns, flight-time rows]. */
export const RESOLUTION_CHOICES = Object.freeze([[36, 30], [72, 60], [108, 90], [144, 120], [216, 180], [288, 240]]);

/** Transfers whose transfer angle is within this of 180 degrees are left blank (the transfer plane is undefined). */
export const RIDGE_HALF_WIDTH_RAD = 2 * Math.PI / 180;

/**
 * Colour-scale metrics of a porkchop cell. `value(vinfDep, vinfArr, burns)` takes AU/day and returns AU/day.
 * @type {Record<string, {label:string, short:string, value:(vd:number, va:number, b:Burns)=>number}>}
 */
export const METRICS = Object.freeze({
  total: { label: 'Total Δv (departure burn + capture)', short: 'total Δv', value: (vd, va, b) => b.dep.dv(vd) + b.arr.dv(va) },
  vinfDep: { label: 'Departure v∞', short: 'dep. v∞', value: (vd) => vd },
  vinfArr: { label: 'Arrival v∞', short: 'arr. v∞', value: (_vd, va) => va },
  depBurn: { label: 'Departure burn only', short: 'dep. burn', value: (vd, _va, b) => b.dep.dv(vd) },
});

/**
 * @typedef {{kind:'park'|'direct', g:Object, dv:(vinf:number)=>number}} Burn
 * @typedef {{dep:Burn, arr:Burn}} Burns
 * @typedef {(jd:number)=>{r:number[], vFrame:number[]}} Sampler
 */

/**
 * Heliocentric position and the velocity v∞ is measured against (the stop's frame body, exactly as route legs do:
 * a station in low orbit reports v∞ relative to its planet) of any natural body or custom object.
 * @param {string} ref
 * @param {import('./custom.js').CustomContext} ctx
 * @returns {Sampler}
 */
export function endpointSampler(ref, ctx) {
  if (hasBody(ref)) return (jd) => { const s = getState(ref, jd); return { r: s.r, vFrame: s.v }; };
  return (jd) => ({ r: positionOf(ref, jd, ctx) ?? [0, 0, 0], vFrame: stopFrameVelocity({ ref }, jd, ctx) });
}

/** Full heliocentric state { r, v } of any natural body or custom object. */
export function endpointState(ref, jd, ctx) {
  if (hasBody(ref)) return getState(ref, jd);
  return { r: positionOf(ref, jd, ctx) ?? [0, 0, 0], v: velocityOf(ref, jd, ctx) };
}

/**
 * Departure or capture burn at an endpoint: from / into a circular parking orbit (legPhysics defaults: 300 km for
 * rocky planets and large moons, 10% of R for gas giants, max(5 km, R/2) for small bodies, a station's own orbit),
 * or a straight velocity match (Δv = v∞) where there is no parking orbit (Sun, Lagrange and fixed points).
 * @param {string} ref
 * @param {number|null} parkAltKm override (null = default)
 * @returns {Burn}
 */
export function burnModel(ref, parkAltKm, ctx) {
  const g = stopGravity({ ref, ...(parkAltKm != null && Number.isFinite(parkAltKm) ? { parkAltKm } : {}) }, ctx);
  if (!(g.gm > 0)) return { kind: 'direct', g, dv: (vinf) => vinf };
  return { kind: 'park', g, dv: (vinf) => parkingOrbitDeltaV(vinf, g.gm, g.parkRadiusAu) };
}

/** Burns at both ends. */
export function burnsFor(fromRef, toRef, parkDep, parkArr, ctx) {
  return { dep: burnModel(fromRef, parkDep, ctx), arr: burnModel(toRef, parkArr, ctx) };
}

/** Transfer angle (radians, 0..2pi) swept by a prograde (+z angular momentum) transfer from r1 to r2. */
export function transferAngle(r1, r2) {
  const c = vdot(r1, r2) / (vlen(r1) * vlen(r2));
  const th = Math.acos(Math.min(1, Math.max(-1, c)));
  return vcross(r1, r2)[2] >= 0 ? th : 2 * Math.PI - th;
}

/**
 * Two-body Lambert transfer between two endpoint states (Sun only, prograde, single revolution).
 * @param {{r:number[], vFrame:number[]}} dep endpoint at departure
 * @param {{r:number[], vFrame:number[]}} arr endpoint at arrival
 * @param {number} tof flight time (days)
 * @returns {null|{vinfDep:number, vinfArr:number, v1:number[], v2:number[], theta:number}} null = no solution, or
 *   the transfer angle is within RIDGE_HALF_WIDTH_RAD of 180 degrees
 */
export function transferCell(dep, arr, tof) {
  if (!(tof > 0) || !(vlen(dep.r) > 0) || !(vlen(arr.r) > 0)) return null;
  const theta = transferAngle(dep.r, arr.r);
  if (Math.abs(theta - Math.PI) < RIDGE_HALF_WIDTH_RAD) return null;
  const sol = lambert(dep.r, arr.r, tof, GM_SUN, true);
  if (!sol.ok) return null;
  const vinfDep = vlen(vsub(sol.v1, dep.vFrame)), vinfArr = vlen(vsub(sol.v2, arr.vFrame));
  if (!Number.isFinite(vinfDep) || !Number.isFinite(vinfArr)) return null;
  return { vinfDep, vinfArr, v1: sol.v1, v2: sol.v2, theta };
}

/**
 * Departure dates and flight times of a porkchop grid (grid nodes; the plot spans the first to the last node).
 * @param {{t0:number, spanDays:number, tofMin:number, tofMax:number, nx:number, ny:number}} p
 */
export function porkchopAxes(p) {
  const dep = new Float64Array(p.nx), tof = new Float64Array(p.ny);
  for (let i = 0; i < p.nx; i++) dep[i] = p.t0 + (p.spanDays * i) / Math.max(1, p.nx - 1);
  for (let j = 0; j < p.ny; j++) tof[j] = p.tofMin + ((p.tofMax - p.tofMin) * j) / Math.max(1, p.ny - 1);
  return { dep, tof };
}

/**
 * Validate porkchop parameters; returns a list of human-readable problems (empty when fine).
 * @param {{t0:number, spanDays:number, tofMin:number, tofMax:number, nx:number, ny:number}} p
 */
export function porkchopParamErrors(p) {
  const errs = [];
  if (!Number.isFinite(p.t0)) errs.push('Window start is not a valid date (YYYY-MM-DD).');
  if (!(p.spanDays > 0)) errs.push('Choose a departure span.');
  if (!(p.tofMin > 0) || !(p.tofMax > 0)) errs.push('Flight times must be positive numbers of days.');
  else if (!(p.tofMax > p.tofMin)) errs.push('The longest flight time must exceed the shortest.');
  else if (p.tofMax > 20000) errs.push('Flight times above 20,000 days are not supported.');
  if (!(p.nx >= 2 && p.ny >= 2)) errs.push('The grid needs at least 2 × 2 cells.');
  return errs;
}

/**
 * Empty porkchop result for a parameter set. Cells are stored column-major: index = i * ny + j (departure i,
 * flight time j); NaN = blank (no Lambert solution or too close to a 180-degree transfer).
 */
export function createPorkchop(p, fromRef, toRef) {
  const { dep, tof } = porkchopAxes(p);
  const n = p.nx * p.ny;
  return {
    params: { ...p }, fromRef, toRef, dep, tof, nx: p.nx, ny: p.ny,
    vinfDep: new Float64Array(n).fill(NaN), vinfArr: new Float64Array(n).fill(NaN),
    columnsDone: 0, complete: false, cancelled: false, ms: 0,
  };
}

/**
 * Fill porkchop column i (all flight times for departure date i).
 * @param {ReturnType<typeof createPorkchop>} res
 * @param {number} i
 * @param {Sampler} fromS
 * @param {Sampler} toS
 */
export function solvePorkchopColumn(res, i, fromS, toS) {
  const t0 = res.dep[i];
  const d = fromS(t0);
  const dep = { r: d.r.slice(), vFrame: d.vFrame.slice() }; // samplers may return shared cached objects
  for (let j = 0; j < res.ny; j++) {
    const T = res.tof[j];
    const c = transferCell(dep, toS(t0 + T), T);
    const k = i * res.ny + j;
    if (c) { res.vinfDep[k] = c.vinfDep; res.vinfArr[k] = c.vinfArr; }
  }
  res.columnsDone = i + 1;
}

/** Synchronous porkchop (for scripts and tests). */
export function computePorkchopSync(p, fromRef, toRef, ctx) {
  const res = createPorkchop(p, fromRef, toRef);
  const fromS = endpointSampler(fromRef, ctx), toS = endpointSampler(toRef, ctx);
  const t = now();
  for (let i = 0; i < res.nx; i++) solvePorkchopColumn(res, i, fromS, toS);
  res.complete = true;
  res.ms = now() - t;
  return res;
}

/**
 * Time-sliced porkchop computation (keeps the UI responsive): columns are solved in slices of ~`budgetMs`, yielding
 * to the event loop between slices.
 * @returns {{result:Object, cancel:()=>void}}
 */
export function computePorkchopChunked(p, fromRef, toRef, ctx, { onProgress, onDone, budgetMs = 14 } = {}) {
  const res = createPorkchop(p, fromRef, toRef);
  const fromS = endpointSampler(fromRef, ctx), toS = endpointSampler(toRef, ctx);
  const t = now();
  const job = runChunked(res.nx, (i) => solvePorkchopColumn(res, i, fromS, toS), {
    budgetMs,
    onProgress: (done, total) => onProgress?.(res, done, total),
    onDone: () => { res.complete = true; res.ms = now() - t; onDone?.(res); },
  });
  return { result: res, cancel: () => { if (!res.complete) { res.cancelled = true; job.cancel(); } } };
}

/**
 * Metric values (km/s) of every cell; NaN where blank or not yet computed.
 * @param {ReturnType<typeof createPorkchop>} res
 * @param {keyof METRICS} metric
 * @param {Burns} burns
 */
export function metricGrid(res, metric, burns) {
  const f = (METRICS[metric] ?? METRICS.total).value;
  const out = new Float64Array(res.nx * res.ny);
  for (let k = 0; k < out.length; k++) {
    const vd = res.vinfDep[k], va = res.vinfArr[k];
    out[k] = Number.isFinite(vd) ? auDayToKmS(f(vd, va, burns)) : NaN;
  }
  return out;
}

/** Every number of one cell (km/s), or null when blank. */
export function cellDetails(res, i, j, burns) {
  const k = i * res.ny + j;
  const vd = res.vinfDep[k], va = res.vinfArr[k];
  if (!Number.isFinite(vd)) return null;
  const depDv = burns.dep.dv(vd), arrDv = burns.arr.dv(va);
  return {
    i, j, depJd: res.dep[i], tof: res.tof[j], arrJd: res.dep[i] + res.tof[j],
    vinfDep: auDayToKmS(vd), vinfArr: auDayToKmS(va), depBurn: auDayToKmS(depDv), arrBurn: auDayToKmS(arrDv),
    total: auDayToKmS(depDv + arrDv),
  };
}

/** Index and value of the smallest finite entry, or null. */
export function gridMinimum(values, ny) {
  let best = -1;
  for (let k = 0; k < values.length; k++) if (Number.isFinite(values[k]) && (best < 0 || values[k] < values[best])) best = k;
  return best < 0 ? null : { k: best, i: Math.floor(best / ny), j: best % ny, value: values[best] };
}

/**
 * Continuous cost (km/s) of a transfer departing at t with flight time T, for a metric. Infinity when blank.
 * @returns {(t:number, T:number)=>number}
 */
export function transferCost(fromRef, toRef, ctx, burns, metric = 'total') {
  const fromS = endpointSampler(fromRef, ctx), toS = endpointSampler(toRef, ctx);
  const f = (METRICS[metric] ?? METRICS.total).value;
  return (t, T) => {
    const d = fromS(t);
    const c = transferCell({ r: d.r.slice(), vFrame: d.vFrame.slice() }, toS(t + T), T);
    return c ? auDayToKmS(f(c.vinfDep, c.vinfArr, burns)) : Infinity;
  };
}

/**
 * Every number (km/s) of the two-body transfer departing at t with flight time T, or null when blank.
 * @returns {null|{depJd:number, tof:number, arrJd:number, vinfDep:number, vinfArr:number, depBurn:number,
 *   arrBurn:number, total:number}}
 */
export function transferDetailsAt(fromRef, toRef, ctx, burns, t, T) {
  const d = endpointSampler(fromRef, ctx)(t);
  const c = transferCell({ r: d.r.slice(), vFrame: d.vFrame.slice() }, endpointSampler(toRef, ctx)(t + T), T);
  if (!c) return null;
  const depDv = burns.dep.dv(c.vinfDep), arrDv = burns.arr.dv(c.vinfArr);
  return {
    depJd: t, tof: T, arrJd: t + T, vinfDep: auDayToKmS(c.vinfDep), vinfArr: auDayToKmS(c.vinfArr),
    depBurn: auDayToKmS(depDv), arrBurn: auDayToKmS(arrDv), total: auDayToKmS(depDv + arrDv),
  };
}

/**
 * Pattern (compass) search for a local minimum of cost(t, T) inside a box, starting at (t, T) with steps (dt, dT),
 * halving the steps down to `minStep` days. Typically 60-200 cost evaluations.
 * @returns {{t:number, T:number, value:number}|null}
 */
export function refineMinimum(cost, t, T, { dt, dT, box, minStep = 0.02, maxEvals = 400 } = {}) {
  const clampT = (x) => Math.min(box.t1, Math.max(box.t0, x));
  const clampF = (x) => Math.min(box.T1, Math.max(box.T0, x));
  let best = cost(t, T);
  if (!Number.isFinite(best)) return null;
  let st = dt, sT = dT, evals = 1;
  const dirs = [[1, 0], [-1, 0], [0, 1], [0, -1], [1, 1], [-1, -1], [1, -1], [-1, 1]];
  while ((st > minStep || sT > minStep) && evals < maxEvals) {
    let moved = false;
    for (const [a, b] of dirs) {
      const nt = clampT(t + a * st), nT = clampF(T + b * sT);
      if (nt === t && nT === T) continue;
      const c = cost(nt, nT);
      evals++;
      if (c < best) { best = c; t = nt; T = nT; moved = true; break; }
    }
    if (!moved) { st /= 2; sT /= 2; }
  }
  return { t, T, value: best, evals };
}

/** Natural body whose heliocentric orbit an endpoint follows (a moon -> its planet; a station -> its body), or null. */
export function heliocentricRoot(ref, ctx) {
  let id = hasBody(ref) ? ref : stopFrameBody(ref, ctx);
  for (let k = 0; id && k < 6; k++) {
    const b = getBody(id);
    if (!b || !b.parent || b.parent === 'sun') break;
    id = b.parent;
  }
  return id ?? null;
}

/** Osculating heliocentric orbital period (days) of an endpoint's root body (Infinity for the Sun, fixed points or escape orbits). */
export function heliocentricPeriod(ref, ctx, jd) {
  const root = heliocentricRoot(ref, ctx);
  if (root === 'sun') return Infinity;
  const s = root ? getState(root, jd) : endpointState(ref, jd, ctx);
  const rn = vlen(s.r), v2 = vdot(s.v, s.v);
  if (!(rn > 0)) return Infinity;
  const inv = 2 / rn - v2 / GM_SUN;
  if (!(inv > 1e-9)) return Infinity;
  const a = 1 / inv;
  return 2 * Math.PI * Math.sqrt((a * a * a) / GM_SUN);
}

/**
 * Synodic period (days) of two endpoints: how often their relative geometry, and so a launch window, repeats.
 * Infinity when it cannot be defined (same orbit, the Sun, fixed points).
 */
export function synodicPeriod(fromRef, toRef, ctx, jd) {
  const p1 = heliocentricPeriod(fromRef, ctx, jd), p2 = heliocentricPeriod(toRef, ctx, jd);
  const d = Math.abs(1 / p1 - 1 / p2);
  return d > 1e-7 ? 1 / d : Infinity;
}

/**
 * Cheapest flight time for every departure column.
 * @returns {{value:Float64Array, j:Int32Array}} value NaN where the whole column is blank
 */
export function columnMinima(values, nx, ny) {
  const value = new Float64Array(nx).fill(NaN), j = new Int32Array(nx).fill(-1);
  for (let i = 0; i < nx; i++) {
    for (let jj = 0; jj < ny; jj++) {
      const v = values[i * ny + jj];
      if (Number.isFinite(v) && !(v >= value[i])) { value[i] = v; j[i] = jj; }
    }
  }
  return { value, j };
}

/**
 * Launch windows: local minima (over +-2 columns) of the per-departure cheapest transfer, keeping at most one per
 * `minSeparation` days (default 0.6 x the synodic period; only the global best when the period is undefined).
 * A minimum on the first or last column is flagged `edge` (the window may continue outside the span).
 * @returns {{i:number, j:number, value:number, edge:'start'|'end'|null}[]} sorted by departure date
 */
export function findWindows(values, res, synodicDays) {
  const { value, j } = columnMinima(values, res.nx, res.ny);
  const w = 2;
  const cands = [];
  for (let i = 0; i < res.nx; i++) {
    const v = value[i];
    if (!Number.isFinite(v)) continue;
    let isMin = true;
    for (let k = Math.max(0, i - w); k <= Math.min(res.nx - 1, i + w) && isMin; k++) {
      if (k === i || !Number.isFinite(value[k])) continue;
      if (value[k] < v || (value[k] === v && k < i)) isMin = false;
    }
    if (isMin) cands.push({ i, j: j[i], value: v, edge: i === 0 ? 'start' : i === res.nx - 1 ? 'end' : null });
  }
  cands.sort((a, b) => a.value - b.value);
  const sep = Number.isFinite(synodicDays) ? 0.6 * synodicDays : Infinity;
  const picked = [];
  for (const c of cands) if (picked.every((p) => Math.abs(res.dep[p.i] - res.dep[c.i]) >= sep)) picked.push(c);
  return picked.sort((a, b) => a.i - b.i);
}

/** Search box of a porkchop (departure span x flight-time range). */
export const porkchopBox = (res) => ({ t0: res.dep[0], t1: res.dep[res.nx - 1], T0: res.tof[0], T1: res.tof[res.ny - 1] });

/** Grid spacing (days) of a porkchop: { dt, dT }. */
export const porkchopStep = (res) => ({
  dt: res.nx > 1 ? res.dep[1] - res.dep[0] : 1, dT: res.ny > 1 ? res.tof[1] - res.tof[0] : 1,
});

// ------------------------------------------------------------------ torch ships

/**
 * Gravity-free constant-thrust trip from `fromRef` (departing with its heliocentric velocity) to `toRef`.
 * mode 'rendezvous' matches the target's position and velocity (flip-and-burn); 'intercept' only reaches its
 * position (burn all the way). Returns null when the solver fails.
 * @param {number} a acceleration (AU/day^2)
 * @returns {null|{jd0:number, T:number, arriveJd:number, peakSpeed:number, deltaV:number, flipJd:number|null}}
 *   speeds in AU/day (peakSpeed heliocentric)
 */
export function torchTrip(fromRef, toRef, ctx, jd0, a, mode = 'rendezvous') {
  const P = endpointState(fromRef, jd0, ctx);
  const P0 = P.r.slice(), V0 = P.v.slice();
  const targetFn = (jd) => endpointState(toRef, jd, ctx);
  const sol = mode === 'intercept' ? solveIntercept(P0, V0, jd0, targetFn, a) : solveRendezvous(P0, V0, jd0, targetFn, a);
  if (!sol?.ok || !(sol.T > 0)) return null;
  const peakSpeed = mode === 'intercept' ? vlen(sol.stateAt(sol.arriveJd).v) : sol.peakSpeed;
  return { jd0, T: sol.T, arriveJd: sol.arriveJd, peakSpeed, deltaV: sol.deltaV, flipJd: sol.flipJd ?? null };
}

/**
 * Departure dates sampled every `stepDays` across [t0, t0 + spanDays] (always including both ends).
 * @returns {number[]}
 */
export function torchSampleDates(t0, spanDays, stepDays) {
  const n = Math.max(1, Math.round(spanDays / stepDays));
  const out = [];
  for (let k = 0; k <= n; k++) out.push(t0 + (spanDays * k) / n);
  return out;
}

/**
 * Time-sliced torch-ship curve: one kinematic solve (~1 ms) per sampled departure.
 * @returns {{result:{dates:number[], trips:(Object|null)[], done:number, complete:boolean, cancelled:boolean,
 *   mode:string, a:number, fromRef:string, toRef:string}, cancel:()=>void}}
 */
export function computeTorchCurveChunked({ fromRef, toRef, t0, spanDays, stepDays, a, mode }, ctx, { onProgress, onDone, budgetMs = 14 } = {}) {
  const dates = torchSampleDates(t0, spanDays, stepDays);
  const res = { dates, trips: new Array(dates.length).fill(null), done: 0, complete: false, cancelled: false, mode, a, fromRef, toRef, ms: 0 };
  const t = now();
  const job = runChunked(dates.length, (k) => {
    try { res.trips[k] = torchTrip(fromRef, toRef, ctx, dates[k], a, mode); } catch { res.trips[k] = null; }
    res.done = k + 1;
  }, {
    budgetMs,
    onProgress: (done, total) => onProgress?.(res, done, total),
    onDone: () => { res.complete = true; res.ms = now() - t; onDone?.(res); },
  });
  return { result: res, cancel: () => { if (!res.complete) { res.cancelled = true; job.cancel(); } } };
}

// ------------------------------------------------------------------ scheduling

const now = () => (globalThis.performance ? performance.now() : Date.now());

/**
 * Run step(0..total-1) in time slices of about `budgetMs`, yielding to the event loop (setTimeout 0) between
 * slices so input, rendering and other timers keep running. onProgress(done, total) after each slice.
 * @returns {{cancel:()=>void, readonly running:boolean}}
 */
export function runChunked(total, step, { budgetMs = 14, onProgress, onDone } = {}) {
  let i = 0, cancelled = false, timer = null;
  const tick = () => {
    timer = null;
    if (cancelled) return;
    const start = now();
    do { step(i++); } while (i < total && now() - start < budgetMs);
    onProgress?.(i, total);
    if (i >= total) { onDone?.(); return; }
    timer = setTimeout(tick, 0);
  };
  if (total > 0) timer = setTimeout(tick, 0);
  else setTimeout(() => { if (!cancelled) { onProgress?.(0, 0); onDone?.(); } }, 0);
  return {
    cancel() { cancelled = true; if (timer) clearTimeout(timer); timer = null; },
    get running() { return !cancelled && i < total; },
  };
}
