// Derived physics of route legs for display: hyperbolic excess speeds, parking-orbit / capture delta-v,
// closest planetary approaches and impacts (ballistic legs, from the N-body refinement), gravity audits
// (brachistochrone legs), constant-thrust maneuver summaries (thrust legs) and patched-conic flyby analysis at
// zero-dwell stops. All inputs in internal units (AU, days); outputs keep AU/day for speeds unless the name says
// otherwise.
import { AU_KM, G0_M_S2, kmToAu, auDayToKmS, auDay2ToMS2 } from '../astro/constants.js';
import { vsub, vlen } from '../astro/vec3.js';
import { parkingOrbitDeltaV, flybyAnalysis } from '../astro/nbody.js';
import { getBody, getMu, getState, isMuEstimated, perturberIdFor, getPerturber } from './ephemeris.js';
import { legData, legNbody, legAudit, legSpec, legSolution, thrustStatus, stopFrameBodyOf, isFlybyStop, isHold } from './custom.js';

const GAS_GIANTS = new Set(['jupiter', 'saturn', 'uranus', 'neptune']);

/** Gravity-audit thresholds on maxRatio = peak required engine acceleration / profile acceleration. */
export const AUDIT_OK = 1.1;
export const AUDIT_MARGINAL = 1.5;

/**
 * Default parking-orbit altitude (km) about a natural body: 300 km for rocky planets and major moons, 10% of the
 * radius for gas giants, max(5 km, 0.5 R) for small bodies (dwarf planets, asteroids, comets and moons under
 * 100 km radius). Null for the Sun (no parking orbit).
 */
export function defaultParkAltKm(body) {
  if (!body || body.type === 'star') return null;
  if (body.type === 'planet') return GAS_GIANTS.has(body.id) ? 0.1 * body.radiusKm : 300;
  if (body.type === 'moon' && body.radiusKm >= 100) return 300;
  return Math.max(5, 0.5 * body.radiusKm);
}

/**
 * Gravity context of a route stop for departure/capture burns.
 * @returns {{bodyId:string|null, gm:number, radiusKm?:number, parkAltKm?:number, parkRadiusAu?:number,
 *   source?:'stop'|'object'|'default', gmEstimated?:boolean}}
 *   gm = 0 means "no parking orbit": the burn is a straight velocity match (Δv = v∞).
 */
export function stopGravity(stop, ctx) {
  const bodyId = stopFrameBodyOf(stop, ctx);
  if (!bodyId || bodyId === 'sun') return { bodyId, gm: 0 };
  const b = getBody(bodyId);
  let altKm, source;
  const own = isHold(stop) ? stop.motion : stop?.ref && !getBody(stop.ref) ? ctx.byId.get(stop.ref)?.motion : null;
  if (stop.parkAltKm != null && Number.isFinite(stop.parkAltKm)) { altKm = stop.parkAltKm; source = 'stop'; }
  else if (own?.kind === 'orbit' && own.parent === bodyId && own.aKm > b.radiusKm) { altKm = own.aKm - b.radiusKm; source = 'object'; }
  else { altKm = defaultParkAltKm(b); source = 'default'; }
  return {
    bodyId, gm: getMu(bodyId), radiusKm: b.radiusKm, parkAltKm: altKm, parkRadiusAu: kmToAu(b.radiusKm + altKm),
    source, gmEstimated: isMuEstimated(bodyId),
  };
}

/**
 * Burn at one end of a ballistic leg.
 * @param {Object} stop route stop
 * @param {number} vinf hyperbolic excess speed (AU/day) relative to the stop's frame body
 * @param {boolean} flyby the stop is a zero-dwell flyby (no burn here; see routeFlybys)
 * @returns {{kind:'flyby'|'park'|'direct'|'intercept'|'cut', dv:number, g?:Object}}
 */
export function endBurn(stop, vinf, ctx, flyby) {
  if (flyby) return { kind: 'flyby', dv: 0 };
  const g = stopGravity(stop, ctx);
  if (!(g.gm > 0)) return { kind: 'direct', dv: vinf, g };
  return { kind: 'park', dv: parkingOrbitDeltaV(vinf, g.gm, g.parkRadiusAu), g };
}

/**
 * Display summary of a ballistic leg. Uses the N-body refinement when available (status 'nbody'), the two-body
 * Lambert solution otherwise ('pending' while computing, 'failed' when targeting did not converge). Intercept legs
 * have no arrival burn (the arrival v∞ is the closing speed); a leg cut short by a course change never reaches its
 * arrival burn.
 * @returns {null|{status:'nbody'|'pending'|'failed', vinfDep:number, vinfArr:number, dep:Object, arr:Object,
 *   totalDv:number, closest:Object[], impacts:Object[], correctionMS:number|null, missKm:number|null, ms:number|null}}
 */
export function ballisticSummary(leg, ctx) {
  if (leg?.profile !== 'ballistic' || !leg.ballistic) return null;
  const nb = legNbody(leg);
  const useNb = !!nb?.ok;
  const bl = leg.ballistic;
  const v0 = useNb ? nb.v0 : bl.v1, v1 = useNb ? nb.vEnd : bl.v2;
  const vinfDep = vlen(vsub(v0, bl.vFrameDep)), vinfArr = vlen(vsub(v1, bl.vFrameArr));
  const dep = endBurn(leg.fromStop, vinfDep, ctx, leg.depFlyby);
  const arr = leg.cut ? { kind: 'cut', dv: 0 } : leg.mode === 'intercept' ? { kind: 'intercept', dv: 0 } : endBurn(leg.toStop, vinfArr, ctx, leg.arrFlyby);
  return {
    status: useNb ? 'nbody' : nb ? 'failed' : 'pending',
    vinfDep, vinfArr, dep, arr, totalDv: dep.dv + arr.dv,
    closest: useNb ? nb.closest.slice(0, 3).map((c) => ({ ...c, close: c.distAu < 2 * c.soiAu })) : [],
    impacts: useNb ? nb.impacts : [],
    correctionMS: useNb ? auDayToKmS(nb.correctionAuDay) * 1000 : null,
    missKm: nb ? nb.missAu * AU_KM : null,
    ms: nb?.ms ?? null,
  };
}

/**
 * Peak speed (AU/day) along a maneuver solution: the solver's value, or the maximum over its integration samples / 128
 * evenly spaced states (intercept solutions do not report one). Cached on the solution object.
 */
export function solutionPeakSpeed(sol) {
  if (!sol) return NaN;
  if (Number.isFinite(sol.peakSpeed)) return sol.peakSpeed;
  if (sol._peak == null) {
    let peak = 0;
    if (sol.samples?.length) for (const s of sol.samples) peak = Math.max(peak, vlen(s.v));
    else for (let k = 0; k <= 128; k++) peak = Math.max(peak, vlen(sol.stateAt(sol.arriveJd - sol.T + (sol.T * k) / 128).v));
    sol._peak = peak;
  }
  return sol._peak;
}

/**
 * Summary of a constant-thrust (torch) leg, or null.
 * @returns {null|{mode:string, accelG:number, departJd:number, arriveJd:number, T:number, flipJd:number|null,
 *   peakSpeed:number, deltaV:number, closingSpeed:number|null, status:'pending'|'refined'|'approximate'|'none',
 *   failed:boolean, sol:Object|null}}
 */
export function thrustSummary(leg) {
  if (leg?.profile !== 'thrust') return null;
  const sol = legSolution(leg);
  const accelG = auDay2ToMS2(leg.thrust?.a ?? NaN) / G0_M_S2;
  if (!sol) return { mode: leg.mode, accelG, failed: true, status: 'none', sol: null };
  const flipJd = leg.mode === 'intercept' ? null : sol.flipJd ?? null;
  let closing = null;
  if (leg.mode === 'intercept') {
    if (Number.isFinite(sol.closingSpeed)) closing = sol.closingSpeed;
    else { const s = sol.stateAt(sol.arriveJd), t = leg.targetFn(sol.arriveJd); closing = vlen(vsub(s.v, t.v)); }
  }
  // a leg cut short by a course change burned only until the cut
  const flownT = leg.cut ? Math.max(0, Math.min(sol.T, leg.tEnd - leg.t0)) : sol.T;
  return {
    mode: leg.mode, accelG, departJd: leg.t0, arriveJd: sol.arriveJd, T: sol.T, flipJd, peakSpeed: solutionPeakSpeed(sol),
    deltaV: (leg.thrust.a ?? 0) * flownT, plannedDeltaV: sol.deltaV, closingSpeed: closing, status: thrustStatus(leg),
    failed: false, sol, refineFailure: null,
  };
}

/**
 * Gravity-audit summary of a brachistochrone leg, or { status: 'pending' }.
 * status: 'ok' (maxRatio <= 1.1) | 'marginal' (<= 1.5) | 'fail'.
 */
export function auditSummary(leg) {
  if (leg?.profile !== 'brachistochrone' || !leg.auditKey) return null;
  const r = legAudit(leg);
  if (!r) return { status: 'pending' };
  if (!r.ok) return { status: 'error', error: r.error };
  return auditFromResult(r);
}

/** Classify a raw brachistochroneGravityAudit result (with aProfile). */
export function auditFromResult(r) {
  const status = r.maxRatio <= AUDIT_OK ? 'ok' : r.maxRatio <= AUDIT_MARGINAL ? 'marginal' : 'fail';
  return {
    status, maxRatio: r.maxRatio, peakG: auDay2ToMS2(r.peakRequired) / G0_M_S2, profileG: auDay2ToMS2(r.aProfile) / G0_M_S2,
    dvEngine: r.deltaVEngine, dvIdeal: r.deltaVIdeal, lossPct: r.gravityLossFraction * 100, worstJd: r.worstJd,
  };
}

/**
 * Patched-conic analysis of every flyby (zero-dwell intermediate stop between two ballistic legs) on a route.
 * @returns {{stopIndex:number, jd:number, ref:string|null, bodyId:string|null, pending:boolean, fb?:Object,
 *   mismatchAuDay?:number, verdict:{level:'ok'|'warn'|'err'|'info', text:string}, dv:number}[]}
 */
export function routeFlybys(obj, ctx) {
  const m = obj?.motion;
  if (m?.kind !== 'route') return [];
  const out = [];
  for (let i = 1; i < m.stops.length - 1; i++) {
    if (!isFlybyStop(m.stops, i)) continue;
    if (legSpec(m, i - 1).profile !== 'ballistic' || legSpec(m, i).profile !== 'ballistic') continue;
    const stop = m.stops[i];
    const jd = stop.arriveJd;
    const legIn = legData(obj, i - 1, ctx), legOut = legData(obj, i, ctx);
    if (!legIn.ballistic || !legOut.ballistic) {
      out.push({ stopIndex: i, jd, ref: stop.ref, bodyId: null, pending: false, dv: NaN, verdict: { level: 'err', text: 'No ballistic solution on an adjacent leg' } });
      continue;
    }
    const nbIn = legNbody(legIn), nbOut = legNbody(legOut);
    const vIn = nbIn?.ok ? nbIn.vEnd : legIn.ballistic.v2;
    const vOut = nbOut?.ok ? nbOut.v0 : legOut.ballistic.v1;
    const pending = !nbIn || !nbOut;
    const planet = perturberIdFor(stop.ref, (id) => ctx.byId.get(id));
    if (!planet) {
      const dv = vlen(vsub(vOut, vIn));
      out.push({ stopIndex: i, jd, ref: stop.ref, bodyId: null, pending, mismatchAuDay: dv, dv,
        verdict: { level: 'info', text: `No gravity assist modelled here: Δv ≈ ${auDayToKmS(dv).toFixed(2)} km/s to change course` } });
      continue;
    }
    const pb = getBody(planet);
    const fb = flybyAnalysis(vIn, vOut, getState(planet, jd).v, getMu(planet), kmToAu(pb.radiusKm));
    let verdict, dv = 0;
    if (fb.turnTooSharp) verdict = { level: 'err', text: 'Turn too sharp: periapsis below the surface' };
    else if (fb.feasibleUnpowered) verdict = { level: 'ok', text: 'Unpowered gravity assist feasible' };
    else { dv = fb.poweredDeltaVAuDay; verdict = { level: 'warn', text: `Needs powered flyby: Δv ≈ ${auDayToKmS(dv).toFixed(2)} km/s` }; }
    out.push({ stopIndex: i, jd, ref: stop.ref, bodyId: planet, pending, fb, dv, verdict, soiAu: getPerturber(planet)?.soiAu });
  }
  return out;
}

/**
 * Whole-route delta-v totals for routes with ballistic or torch legs: ballistic burns, constant-thrust Δv (a × burn
 * time, only up to a course change for cut legs) and powered-flyby Δv. Brachistochrone and linear legs are not
 * counted (they have their own per-leg figures).
 * @returns {{total:number, legs:number, flybys:number, pending:boolean}|null}
 */
export function routeDeltaV(obj, ctx) {
  const m = obj?.motion;
  if (m?.kind !== 'route' || m.stops.length < 2) return null;
  let legs = 0, pending = false, counted = 0;
  for (let i = 0; i < m.stops.length - 1; i++) {
    if (m.stops[i].departJd == null || m.stops[i + 1].arriveJd == null) continue;
    const prof = legSpec(m, i).profile;
    if (prof === 'ballistic') {
      const s = ballisticSummary(legData(obj, i, ctx), ctx);
      if (!s) continue;
      legs += s.totalDv;
      counted++;
      if (s.status === 'pending') pending = true;
    } else if (prof === 'thrust') {
      const t = thrustSummary(legData(obj, i, ctx));
      if (!t || t.failed) continue;
      legs += t.deltaV;
      counted++;
      if (t.status === 'pending') pending = true;
    }
  }
  if (!counted) return null;
  let flybys = 0;
  for (const f of routeFlybys(obj, ctx)) { if (Number.isFinite(f.dv)) flybys += f.dv; if (f.pending) pending = true; }
  return { total: legs + flybys, legs, flybys, pending };
}
