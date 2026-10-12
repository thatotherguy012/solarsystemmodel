// Plain-language status of a body or custom object at a time ("In orbit around Mars", "Under thrust toward Venus ·
// flip in 2.1 d · arrives 2187-05-14 (in 4.3 d) · 612 km/s now", "Engines off · drifting at 31 km/s").
import { vlen } from '../astro/vec3.js';
import { formatJd } from '../astro/time.js';
import { getBody } from '../sim/ephemeris.js';
import {
  nameOf, nameOfStop, routePhase, legData, terminalDrift, velocityOf, existsAt, isWaypoint, isHold, legSpec,
} from '../sim/custom.js';
import { thrustSummary } from '../sim/legPhysics.js';
import { fmtKmS, fmtDuration } from './format.js';

/** "2187-05-14" (or with the time when it is less than 3 days away). */
export function whenText(jd, nowJd) {
  return formatJd(jd, { time: Math.abs(jd - nowJd) < 3 }).replace(' UTC', '');
}

const inText = (jd, now) => (jd >= now ? `in ${fmtDuration(jd - now)}` : `${fmtDuration(now - jd)} ago`);

/** Status of a non-route motion. */
function motionText(m, ctx) {
  switch (m?.kind) {
    case 'orbit': return getBody(m.parent) ? `In orbit around ${nameOf(m.parent, ctx)}` : `Holding formation with ${nameOf(m.parent, ctx)}`;
    case 'colocated': {
      const at = nameOf(m.parent, ctx);
      if (m.label === 'Surface') return `On the surface of ${at}`;
      if (m.label === 'Docked') return `Docked at ${at}`;
      if (m.label === 'In orbit (unspecified)') return `In orbit around ${at}`;
      if (m.label === 'Nearby') return `Near ${at}`;
      return `At ${at}`;
    }
    case 'lagrange': return `Holding at ${nameOf(m.primary, ctx)}–${nameOf(m.secondary, ctx)} ${m.point}`;
    case 'fixed': return 'Holding position in space';
    default: return '';
  }
}

function stopText(stop, ctx) {
  if (stop.ref) return `Parked at ${nameOf(stop.ref, ctx)}`;
  if (isHold(stop)) return motionText(stop.motion, ctx);
  if (isWaypoint(stop)) return 'Holding at a course-change point';
  return 'Holding position in space';
}

/**
 * Status of any id at jd.
 * @returns {{text:string, kind:'body'|'static'|'parked'|'thrust'|'coast'|'drift'|'arrived'|'inactive'}}
 */
export function statusOf(id, jd, ctx) {
  const b = getBody(id);
  if (b) {
    if (b.type === 'star') return { text: 'The centre of the solar system', kind: 'body' };
    if (b.type === 'moon') return { text: `In orbit around ${nameOf(b.parent, ctx)}`, kind: 'body' };
    return { text: 'Orbiting the Sun', kind: 'body' };
  }
  const o = ctx.byId.get(id);
  if (!o) return { text: '', kind: 'static' };
  if (!existsAt(o, jd)) {
    return { text: o.existsFromJd != null && jd < o.existsFromJd ? `Does not exist yet (from ${whenText(o.existsFromJd, jd)})` : 'No longer exists', kind: 'inactive' };
  }
  const m = o.motion || {};
  if (m.kind !== 'route') return { text: motionText(m, ctx), kind: 'static' };
  const ph = routePhase(m, jd);
  const speed = () => fmtKmS(vlen(velocityOf(o.id, jd, ctx)));
  if (ph.kind === 'transit') {
    const leg = legData(o, ph.leg, ctx);
    const to = nameOfStop(leg.toStop, ctx);
    if (leg.profile === 'drift') return { text: `Engines off · drifting at ${speed()}`, kind: 'drift' };
    if (leg.profile === 'thrust') {
      const t = thrustSummary(leg);
      if (!t || t.failed) return { text: `En route to ${to} · no thrust solution`, kind: 'thrust' };
      const arr = `arrives ${whenText(t.arriveJd, jd)} (${inText(t.arriveJd, jd)})`;
      if (t.mode === 'intercept') {
        return { text: `Under thrust toward ${to} (intercept) · ${arr} · closing at ${fmtKmS(t.closingSpeed)} · ${speed()} now`, kind: 'thrust' };
      }
      if (t.flipJd != null && jd < t.flipJd) return { text: `Under thrust toward ${to} · flip in ${fmtDuration(t.flipJd - jd)} · ${arr} · ${speed()} now`, kind: 'thrust' };
      return { text: `Braking toward ${to} · ${arr} · ${speed()} now`, kind: 'thrust' };
    }
    const arr = `arrives ${whenText(leg.t1, jd)} (${inText(leg.t1, jd)})`;
    if (leg.profile === 'brachistochrone') {
      const flip = leg.t0 + leg.T / 2;
      if (jd < flip) return { text: `Under thrust toward ${to} · flip in ${fmtDuration(flip - jd)} · ${arr} · ${speed()} now`, kind: 'thrust' };
      return { text: `Braking toward ${to} · ${arr} · ${speed()} now`, kind: 'thrust' };
    }
    if (leg.profile === 'ballistic') return { text: `En route to ${to} (coasting) · ${arr}`, kind: 'coast' };
    return { text: `En route to ${to} · ${arr}`, kind: 'coast' };
  }
  if (ph.kind === 'arrived') {
    const d = terminalDrift(o, ctx);
    const last = m.stops[m.stops.length - 1];
    if (d) {
      const passed = last.ref && m.stops.length > 1 && legSpec(m, m.stops.length - 2).mode === 'intercept' ? ` · passed ${nameOf(last.ref, ctx)} ${whenText(d.t, jd)}` : '';
      return { text: `Engines off · drifting at ${speed()}${passed}`, kind: 'drift' };
    }
    return { text: stopText(last, ctx), kind: 'arrived' };
  }
  if (ph.kind === 'invalid') return { text: 'Route has no stops', kind: 'static' };
  const stop = m.stops[ph.stop];
  const next = stop.departJd != null && ph.stop < m.stops.length - 1 ? ` · departs ${whenText(stop.departJd, jd)} (${inText(stop.departJd, jd)})` : '';
  return { text: `${stopText(stop, ctx)}${next}`, kind: 'parked' };
}

/** ETA, peak speed and Δv of the current (or next) leg of a ship, for the Simple inspector. */
export function tripFacts(o, jd, ctx) {
  const m = o.motion;
  if (m?.kind !== 'route') return null;
  const ph = routePhase(m, jd);
  let i = null;
  if (ph.kind === 'transit') i = ph.leg;
  else if ((ph.kind === 'before' || ph.kind === 'parked') && ph.stop < m.stops.length - 1 && m.stops[ph.stop].departJd != null) i = ph.stop;
  if (i == null) return null;
  const leg = legData(o, i, ctx);
  const out = { to: nameOfStop(leg.toStop, ctx), profile: leg.profile, departJd: leg.t0, arriveJd: leg.t1, mode: leg.mode };
  if (leg.profile === 'thrust') {
    const t = thrustSummary(leg);
    if (t && !t.failed) Object.assign(out, { arriveJd: t.arriveJd, peak: t.peakSpeed, dv: t.deltaV, closing: t.closingSpeed, accelG: t.accelG });
  } else if (leg.profile === 'brachistochrone') {
    Object.assign(out, { peak: leg.vPeak, dv: leg.dv });
  }
  return out;
}
