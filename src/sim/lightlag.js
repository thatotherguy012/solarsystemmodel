// Light-lag ("as seen from") geometry. An observer at r_obs(t) sees another object where it was when the light now
// arriving left it: at the retarded time t − τ, where τ solves τ = |r_obj(t − τ) − r_obs(t)| / c. This is what the
// observer's telescopes, radar returns and passive sensors show at time t, and it is the picture that tactics in a
// light-speed-limited setting have to work with. Straight-line light paths, no relativistic corrections (as the
// rest of the app).
import { LIGHT_S_PER_AU, DAY_S } from '../astro/constants.js';
import { vlen, vsub } from '../astro/vec3.js';
import { hasBody, getPosition, allBodies } from './ephemeris.js';
import { positionOf, existsAt } from './custom.js';

/** Speed of light in AU/day. */
export const C_AU_PER_DAY = DAY_S / LIGHT_S_PER_AU;
/** Fixed-point passes for the retarded-time solve (|v|/c ≲ 1e-3, so 4 passes converge to well below a millisecond). */
export const RETARDED_PASSES = 4;

/**
 * Solve the retarded time for a target seen by an observer.
 * @param {(jd:number)=>number[]|null} posAt target position (heliocentric AU) at a given JD
 * @param {number[]} rObs observer position at jd
 * @param {number} jd observation time
 * @param {number} [passes]
 * @returns {{tau:number, seconds:number, r:number[], distAu:number}|null} tau in days, r = retarded (apparent) position
 */
export function retardedPosition(posAt, rObs, jd, passes = RETARDED_PASSES) {
  let r = posAt(jd);
  if (!r) return null;
  let tau = vlen(vsub(r, rObs)) / C_AU_PER_DAY;
  for (let k = 0; k < passes; k++) {
    const rr = posAt(jd - tau);
    if (!rr) return null;
    r = rr;
    tau = vlen(vsub(r, rObs)) / C_AU_PER_DAY;
  }
  return { tau, seconds: tau * DAY_S, r, distAu: tau * C_AU_PER_DAY };
}

/** "4 min 12 s", "1 h 12 min", "5.2 h", "2.3 d" — light-time age of a sighting (seconds in). */
export function formatAge(seconds) {
  const s = Math.abs(seconds);
  if (!Number.isFinite(s)) return '—';
  if (s < 1e-3) return `${(s * 1e6).toFixed(0)} µs`;
  if (s < 1) return `${(s * 1000).toFixed(0)} ms`;
  if (s < 10) return `${s.toFixed(1)} s`;
  if (s < 60) return `${Math.round(s)} s`;
  if (s < 3600) {
    let m = Math.floor(s / 60), r = Math.round(s - m * 60);
    if (r === 60) { m += 1; r = 0; }
    return `${m} min ${r} s`;
  }
  if (s < 3 * 3600) {
    let h = Math.floor(s / 3600), m = Math.round((s - h * 3600) / 60);
    if (m === 60) { h += 1; m = 0; }
    return `${h} h ${m} min`;
  }
  if (s < 48 * 3600) return `${(s / 3600).toFixed(1)} h`;
  return `${(s / DAY_S).toFixed(1)} d`;
}

/** Planet ids (the eight planets) used by the "with planets" option. */
export function planetIds() {
  return allBodies().filter((b) => b.type === 'planet').map((b) => b.id);
}

/**
 * Light-lag sightings of `targets` from `observerId` at jd.
 * Custom objects are evaluated in a private context so the shared per-JD position memo of the app is not churned.
 * A custom object is reported only if it existed at the retarded time (a ship destroyed three minutes ago is still
 * "seen" by an observer 5 light-minutes away; one launched a minute ago is not seen yet).
 * @param {string} observerId
 * @param {string[]} targets ids (custom objects or natural bodies)
 * @param {number} jd
 * @param {import('./custom.js').CustomContext} ctx
 * @returns {{id:string, tau:number, seconds:number, rTrue:number[]|null, rSeen:number[], distAu:number, existsNow:boolean}[]}
 */
export function sightings(observerId, targets, jd, ctx, pctx = privateContext(ctx)) {
  const rObs = positionOf(observerId, jd, ctx);
  if (!rObs) return [];
  const out = [];
  for (const id of targets) {
    if (id === observerId) continue;
    const natural = hasBody(id);
    const obj = natural ? null : ctx.byId.get(id);
    if (!natural && !obj) continue;
    const posAt = natural ? (t) => getPosition(id, t) : (t) => positionOf(id, t, pctx);
    const sol = retardedPosition(posAt, rObs, jd);
    if (!sol || !(sol.seconds > 1e-3)) continue; // co-located with the observer: nothing to show
    if (obj && !existsAt(obj, jd - sol.tau)) continue;
    out.push({
      id, tau: sol.tau, seconds: sol.seconds, rSeen: sol.r, distAu: sol.distAu,
      rTrue: natural ? getPosition(id, jd) : positionOf(id, jd, ctx), existsNow: obj ? existsAt(obj, jd) : true,
    });
  }
  return out;
}

/** A private evaluation context sharing the objects (and leg caches) of `ctx` but with its own position memo. */
export function privateContext(ctx) {
  return { byId: ctx.byId, version: ctx.version, errors: new Map(), posCache: new Map() };
}
