// HTML fragments describing route-leg physics (shared by the inspector and the route editor): ballistic legs
// (v∞, parking-orbit burns, total Δv, closest approaches, impacts, N-body status), brachistochrone gravity
// audits, and flyby analyses.
import { AU_KM, auDayToKmS } from '../astro/constants.js';
import { formatJd } from '../astro/time.js';
import { getBody } from '../sim/ephemeris.js';
import { nameOf } from '../sim/custom.js';
import { ballisticSummary, auditSummary, routeFlybys, routeDeltaV, thrustSummary } from '../sim/legPhysics.js';
import { fmtSpeedKmS, fmtKmS, fmtG, fmtMkm, fmtAu, fmtNum, fmtDeg, fmtDuration, esc } from './format.js';

const kms = (auDay) => fmtSpeedKmS(auDayToKmS(auDay));
const row = (k, v) => `<dt>${k}</dt><dd>${v}</dd>`;
const date = (jd) => formatJd(jd, { time: false });

/** Signed percentage with a true minus sign ("−0.05 %", "413 %"). */
export function fmtPct(p) {
  if (!Number.isFinite(p)) return '—';
  const a = Math.abs(p);
  return `${p < 0 ? '−' : ''}${a.toFixed(a < 10 ? 2 : 0)} %`;
}

/** Altitude in km for display ("300 km", "6,991 km", "12.5 km"). */
export function fmtAlt(km) {
  if (!Number.isFinite(km)) return '—';
  return Math.abs(km) >= 100 ? `${fmtNum(km, 0)} km` : `${+km.toFixed(1)} km`;
}

function frameName(stop, burn, ctx) {
  if (burn.g?.bodyId) return nameOf(burn.g.bodyId, ctx);
  if (stop?.kind === 'waypoint') return 'the course before the burn';
  return stop?.ref ? nameOf(stop.ref, ctx) : 'fixed point';
}

/**
 * Constant-thrust (torch) leg rows: mode, acceleration, arrival, flip, peak speed, Δv, closing speed (intercept), and
 * the gravity-refinement status. @returns {{rows:string, notes:string, summary:Object}|null}
 */
export function thrustHtml(leg) {
  const t = thrustSummary(leg);
  if (!t) return null;
  if (t.failed) return { rows: '', notes: '<div class="msg warn">⚠ No constant-thrust solution for this leg; drawn as a straight line.</div>', summary: t };
  let rows = '';
  rows += row('Profile', t.mode === 'intercept'
    ? 'Torch intercept <span class="muted">(burn toward the target all the way; arrives at speed)</span>'
    : 'Torch rendezvous <span class="muted">(burn, flip, brake; arrives matching the target’s velocity)</span>');
  rows += row('Acceleration', fmtG(t.accelG));
  rows += row('Arrival', `${formatJd(t.arriveJd)} <span class="muted">(${fmtDuration(t.T)} after departure)</span>`);
  if (t.flipJd != null) rows += row('Flip', formatJd(t.flipJd));
  rows += row('Peak speed', fmtKmS(t.peakSpeed));
  rows += row('delta-v (Δv)', `${fmtKmS(t.deltaV)}${leg.cut ? ` <span class="muted">burned before the course change (planned ${fmtKmS(t.plannedDeltaV)})</span>` : ''}`);
  if (t.closingSpeed != null) rows += row('Closing speed at arrival', `<b>${fmtKmS(t.closingSpeed)}</b>`);
  let notes = '';
  if (t.status === 'pending') notes = '<div class="muted small">Refining under the gravity of the Sun and the 8 planets… (gravity-free solution shown)</div>';
  else if (t.status === 'refined') notes = '<div class="muted small">Steering solved under the gravity of the Sun and the 8 planets (constant thrust, one flip).</div>';
  else notes = '<div class="msg warn">⚠ Gravity refinement did not converge; the gravity-free solution is shown (fine above ~0.01 g).</div>';
  return { rows, notes, summary: t };
}

function burnText(burn, departing) {
  if (burn.kind === 'flyby') return '<span class="muted">none — flyby (see below)</span>';
  if (burn.kind === 'intercept') return '<span class="muted">none — intercept (the ship flies through)</span>';
  if (burn.kind === 'cut') return '<span class="muted">none — leg cut short by a course change</span>';
  if (burn.kind === 'direct') return `${kms(burn.dv)} <span class="muted">${departing ? 'velocity change at departure' : 'velocity match on arrival'} (no parking orbit)</span>`;
  const g = burn.g;
  const orbit = g.source === 'object' ? `${fmtAlt(g.parkAltKm)} orbit (the stop's own orbit)` : `${fmtAlt(g.parkAltKm)} parking orbit`;
  return `${kms(burn.dv)} <span class="muted">${departing ? 'from' : 'into'} ${orbit}${g.gmEstimated ? ', GM estimated' : ''}</span>`;
}

/**
 * Ballistic-leg details: definition-list rows plus notes/badges below.
 * @returns {{rows:string, notes:string, summary:Object}|null}
 */
export function ballisticHtml(leg, ctx) {
  const s = ballisticSummary(leg, ctx);
  if (!s) return null;
  const twoBody = s.status !== 'nbody' ? ' <span class="muted">(two-body)</span>' : '';
  let rows = '';
  rows += row('Departure excess speed (v∞)', `${kms(s.vinfDep)}${twoBody} <span class="muted">rel. ${esc(frameName(leg.fromStop, s.dep, ctx))}</span>`);
  rows += row(leg.mode === 'intercept' ? 'Closing speed at arrival' : 'Arrival excess speed (v∞)', `${kms(s.vinfArr)}${twoBody} <span class="muted">rel. ${esc(frameName(leg.toStop, s.arr, ctx))}</span>`);
  rows += row('Departure burn', burnText(s.dep, true));
  rows += row(s.arr.kind === 'park' ? 'Capture burn' : 'Arrival burn', burnText(s.arr, false));
  rows += row('Total delta-v (Δv), leg', `<b>${kms(s.totalDv)}</b>`);
  const bl = leg.ballistic;
  rows += row('Transfer orbit', `a ${fmtAu(bl.a)} · e ${bl.e.toFixed(4)} · q ${fmtAu(bl.rp)} <span class="muted">(two-body)</span>`);
  if (s.closest.length) {
    rows += row('Closest approaches', s.closest.map((c) => `${esc(nameOf(c.id, ctx))} ${fmtMkm(c.distAu * AU_KM)} · ${date(c.jd)}${c.close ? ' <span class="badge badge-warn">close approach</span>' : ''}`).join('<br>'));
  }
  let notes = '';
  for (const im of s.impacts) notes += `<span class="badge badge-impact">IMPACTS ${esc(nameOf(im.id, ctx))} on ${date(im.jd)}</span> `;
  if (s.status === 'pending') notes += '<div class="msg info">Refining with N-body (Sun + 8 planets)… two-body values shown meanwhile.</div>';
  else if (s.status === 'failed') notes += '<div class="msg warn">⚠ N-body targeting failed, showing two-body arc</div>';
  else notes += `<div class="muted small">N-body (Sun + 8 planets, patched-conic ends): correction vs two-body ${fmtNum(s.correctionMS, s.correctionMS < 10 ? 1 : 0)} m/s at departure · end miss ${fmtNum(s.missKm, 1)} km</div>`;
  return { rows, notes, summary: s };
}

/** Brachistochrone gravity-audit rows and status line. @returns {{rows:string, notes:string, summary:Object}|null} */
export function auditHtml(leg) {
  const a = auditSummary(leg);
  if (!a) return null;
  if (a.status === 'pending') return { rows: '', notes: '<div class="muted small">Gravity audit (Sun + 8 planets) computing…</div>', summary: a };
  if (a.status === 'error') return { rows: '', notes: `<div class="msg warn">Gravity audit failed: ${esc(a.error)}</div>`, summary: a };
  let rows = '';
  rows += row('Peak engine accel.', `${fmtG(a.peakG)} <span class="muted">incl. gravity (profile ${fmtG(a.profileG)})</span>`);
  rows += row('delta-v (Δv) incl. gravity', fmtKmS(a.dvEngine));
  rows += row('Gravity loss', fmtPct(a.lossPct));
  return { rows, notes: auditStatusHtml(a), summary: a };
}

/** The coloured status line of an audit summary. */
export function auditStatusHtml(a) {
  if (a.status === 'ok') return `<div class="msg ok">✓ Gravity audit OK: the engine holds the straight line (peak ${a.maxRatio.toFixed(3)}× the profile acceleration)</div>`;
  if (a.status === 'marginal') return `<div class="msg warn">⚠ Marginal: engine needs ${((a.maxRatio - 1) * 100).toFixed(0)}% more thrust than rated</div>`;
  return '<div class="msg err">✕ Cannot hold a straight line at this thrust: gravity exceeds the thrust margin; use a higher acceleration or a ballistic leg</div>';
}

/** Flyby analyses of a ballistic route, or ''. */
export function flybysHtml(obj, ctx) {
  const list = routeFlybys(obj, ctx);
  if (!list.length) return '';
  let html = '';
  for (const f of list) {
    const where = nameOf(f.ref, ctx);
    const via = f.bodyId && f.bodyId !== f.ref ? ` <span class="muted">(gravity of ${esc(nameOf(f.bodyId, ctx))})</span>` : '';
    html += `<div class="flyby-block"><div class="flyby-title"><span class="flyby-ring" aria-hidden="true"></span>Flyby of ${esc(where)} · ${formatJd(f.jd)}${via}</div>`;
    if (f.fb) {
      const fb = f.fb;
      const body = getBody(f.bodyId);
      html += '<dl class="kv">';
      html += row('v∞ in / out', `${kms(fb.vInfInAuDay)} / ${kms(fb.vInfOutAuDay)}`);
      html += row('Turn angle', fmtDeg(fb.turnAngleRad, 1));
      const altKm = fb.altitudeRequiredAu * AU_KM;
      html += row('Periapsis altitude', Number.isFinite(altKm)
        ? `${altKm < 0 ? '<span class="warn-text">' : ''}${fmtAlt(altKm)}${altKm < 0 ? ' (below the surface)</span>' : ''} <span class="muted">required (radius ${fmtAlt(body.radiusKm)})</span>`
        : '— <span class="muted">(no turn needed)</span>');
      html += '</dl>';
    }
    const cls = { ok: 'ok', warn: 'warn', err: 'err', info: 'info' }[f.verdict.level];
    html += `<div class="msg ${cls}">${f.verdict.level === 'ok' ? '✓ ' : f.verdict.level === 'err' ? '✕ ' : f.verdict.level === 'warn' ? '⚠ ' : ''}${esc(f.verdict.text)}${f.pending ? ' <span class="muted">(two-body estimate; N-body refining…)</span>' : ''}</div>`;
    html += '</div>';
  }
  html += '<p class="muted small">Patched conic: the heliocentric path is continuous in position but turns (kinks) in velocity at the flyby; the hyperbola inside the planet\'s sphere of influence is not drawn.</p>';
  return html;
}

/** Route-level Δv line for ballistic routes, or ''. */
export function routeDeltaVHtml(obj, ctx) {
  const t = routeDeltaV(obj, ctx);
  if (!t) return '';
  return `<dl class="kv">${row('Route total delta-v (Δv)', `<b>${kms(t.total)}</b> <span class="muted">burns ${kms(t.legs)}${t.flybys > 0 ? ` + powered flybys ${kms(t.flybys)}` : ''}${t.pending ? ' · refining…' : ''}</span>`)}</dl>`;
}
