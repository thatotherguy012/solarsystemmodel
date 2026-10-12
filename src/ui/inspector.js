// Right sidebar: inspector for the selection. A plain-language status line on top; Simple mode then shows the key
// facts (distances, signal delay, speed, trip) with the technical tabs (Overview · Distances · Orbit) behind a
// "Details" expander; Full mode shows the tabs directly. Ships with a drive mirror the command bar's buttons. §8, v3.
import { AU_KM, LIGHT_S_PER_AU, GM_SUN, auDay2ToMS2, G0_M_S2 } from '../astro/constants.js';
import { vsub, vlen } from '../astro/vec3.js';
import { stateToElements } from '../astro/kepler.js';
import { formatJd } from '../astro/time.js';
import { store, patchObject, deleteObject } from '../sim/store.js';
import { getBody, getState, getMu, isMuEstimated, moonsOf, allBodies } from '../sim/ephemeris.js';
import {
  customState, existsAt, nameOf, nameOfStop, motionSummary, positionOf, velocityOf, muOf, routePhase, legData, isFlybyStop,
  isWaypoint, driveOf, driftResult, TYPE_GLYPHS,
} from '../sim/custom.js';
import { onTrajectoryUpdate } from '../sim/trajectory.js';
import { ballisticSummary } from '../sim/legPhysics.js';
import { TYPE_LABELS } from '../data/catalog.js';
import { fmtAu, fmtKm, fmtMkm, fmtDist, fmtKmS, fmtSpeedKmS, fmtLightTime, fmtG, fmtDeg, fmtDuration, fmtNum, esc } from './format.js';
import { ballisticHtml, auditHtml, flybysHtml, routeDeltaVHtml, thrustHtml } from './legInfo.js';
import { statusOf, tripFacts, whenText } from './status.js';
import { commandableIds } from './commandBar.js';
import { confirmModal } from './modal.js';

const TABS = [['overview', 'Overview'], ['distances', 'Distances'], ['orbit', 'Orbit']];
/** Throttle for live refreshes (fast enough to follow timeline scrubbing). */
const REFRESH_MS = 100;
const DETAILS_KEY = 'ssm.ui.detailsOpen';

/** State (r, v) of any id at jd. */
function stateOf(id, jd, ctx) {
  if (getBody(id)) return getState(id, jd);
  const o = ctx.byId.get(id);
  if (!o) return null;
  return { r: positionOf(id, jd, ctx), v: velocityOf(id, jd, ctx) };
}

/** Parent id used for relative quantities. */
function parentOf(id, ctx) {
  const b = getBody(id);
  if (b) return b.parent;
  const o = ctx.byId.get(id);
  const m = o?.motion;
  if (m?.kind === 'orbit' || m?.kind === 'colocated') return m.parent;
  return 'sun';
}

/** @param {Object} app */
export function initInspector(app) {
  const host = document.getElementById('inspector-body');
  let tab = 'overview';
  try { tab = localStorage.getItem('ssm.ui.inspectorTab') || 'overview'; } catch { /* ignore */ }
  let detailsOpen = false;
  try { detailsOpen = localStorage.getItem(DETAILS_KEY) === '1'; } catch { /* ignore */ }
  let sortKey = 'dist', sortDir = 1;
  let builtFor = undefined;
  let lastRefresh = 0, pending = null;

  const simple = () => store.get().detail !== 'full';

  function shell(s) {
    const id = s.selection;
    if (!id) {
      host.innerHTML = `
        <div class="insp-empty">
          <p>Click a body or object (in the view or the list) to inspect it.</p>
          <p class="muted">Drag to rotate · right-drag to pan · wheel to zoom · Esc or a click on empty space clears the selection.</p>
          <p class="muted">Select a ship and press <kbd>G</kbd> to send it somewhere, <kbd>T</kbd> to intercept something.</p>
        </div>`;
      return;
    }
    const b = getBody(id);
    const o = b ? null : s.ctx.byId.get(id);
    if (!b && !o) { host.innerHTML = '<div class="insp-empty">Selection no longer exists.</div>'; return; }
    const color = b ? b.color : o.color;
    const name = b ? b.name : o.name;
    const sub = b ? (TYPE_LABELS[b.type] ?? b.type) : `${o.type[0].toUpperCase()}${o.type.slice(1)} · custom object`;
    const drive = o ? driveOf(o) : null;
    const extra = s.multiSelection.filter((x) => x !== id).length;
    host.innerHTML = `
      <div class="insp-head">
        <span class="dot big" style="background:${esc(color)}"></span>
        <div class="insp-title">
          <div class="insp-name">${o ? `<span class="glyph" style="color:${esc(color)}">${TYPE_GLYPHS[o.type] ?? ''}</span> ` : ''}${esc(name)}</div>
          <div class="insp-sub">${esc(sub)}${drive ? ` · ${drive.kind === 'torch' ? `torch drive ${fmtG(drive.accelG)}` : 'coast drive'}` : ''}</div>
        </div>
      </div>
      <p class="status-line" data-f="status"></p>
      ${extra ? `<p class="multi-note">+ ${extra} more selected (shift-click) — commands apply to all</p>` : ''}
      ${drive ? `<div class="insp-actions cmd-row" role="toolbar" aria-label="Ship commands">
        <button class="btn small" data-cmd="goto" title="Send to a destination and match its speed (G)">Go to</button>
        <button class="btn small" data-cmd="intercept" title="Reach a target as fast as possible without matching its speed (T)">Intercept</button>
        <button class="btn small" data-cmd="cut" title="Stop thrusting now: the ship coasts on its current velocity">Cut engines</button>
        <button class="btn small" data-cmd="drive" title="Change the drive">Drive ✎</button>
        <button class="btn small" data-cmd="course" title="Detailed course: arrival date, ballistic duration, intercept or rendezvous">Set course…</button>
      </div>` : ''}
      <div class="insp-badges" data-f="badges"></div>
      <div class="insp-actions">
        <button class="btn small" data-act="focus" title="Make the camera follow this object">Follow</button>
        <button class="btn small" data-act="measure" title="Measure from this object to the next one you click">Measure to…</button>
        <button class="btn small" data-act="plan" title="Open the travel planner from here">Plan trip</button>
        ${o ? '<button class="btn small" data-act="edit" title="Edit name, type, drive, motion and route">Edit</button>' : ''}
      </div>
      ${simple() ? `<div class="simple-card" data-f="simple"></div>
        ${o ? '<div class="section-title">Notes</div><textarea class="notes" data-notes rows="4" placeholder="Notes (saved automatically)"></textarea>' : ''}
        <details class="insp-details" data-f="details" ${detailsOpen ? 'open' : ''}><summary>Details</summary>
          <div class="tabs" role="tablist">${TABS.map(([k, l]) => `<button role="tab" class="tab" data-tab="${k}" aria-selected="${k === tab}">${l}</button>`).join('')}</div>
          <div class="tab-body" data-f="body"></div>
        </details>`
      : `<div class="tabs" role="tablist">${TABS.map(([k, l]) => `<button role="tab" class="tab" data-tab="${k}" aria-selected="${k === tab}">${l}</button>`).join('')}</div>
        <div class="tab-body" data-f="body"></div>`}`;
    if (simple() && o) bindNotes(host.querySelector('textarea[data-notes]'), o);
    host.querySelector('details[data-f=details]')?.addEventListener('toggle', (ev) => {
      detailsOpen = ev.target.open;
      try { localStorage.setItem(DETAILS_KEY, detailsOpen ? '1' : '0'); } catch { /* ignore */ }
      if (detailsOpen) refresh(true);
    });
    renderTab(s);
  }

  function bindNotes(ta, o) {
    if (!ta) return;
    ta.value = o.notes || '';
    ta.addEventListener('input', () => patchObject(o.id, { notes: ta.value }));
  }

  function renderTab(s) {
    const body = host.querySelector('[data-f=body]');
    if (!body) return;
    for (const t of host.querySelectorAll('.tab')) t.setAttribute('aria-selected', String(t.dataset.tab === tab));
    const id = s.selection;
    const o = getBody(id) ? null : s.ctx.byId.get(id);
    if (tab === 'overview') body.innerHTML = overviewSkeleton(id, o, s);
    else if (tab === 'distances') body.innerHTML = '<div data-f="dist"></div>';
    else body.innerHTML = '<div data-f="orbit"></div>';
    if (tab === 'overview' && o && !simple()) bindNotes(body.querySelector('textarea[data-notes]'), o);
    refresh(true);
  }

  function overviewSkeleton(id, o, s) {
    const b = getBody(id);
    let staticRows = '';
    if (b) {
      const muNote = isMuEstimated(id) ? ' <span class="muted">(estimated, ρ = 2000 kg/m³)</span>' : '';
      const gm = b.gmKm3S2 > 0 ? b.gmKm3S2 : getMu(id) * AU_KM ** 3 / 86400 ** 2;
      staticRows += row('Type', esc(TYPE_LABELS[b.type] ?? b.type));
      if (b.parent) staticRows += row('Parent', `<a href="#" data-goto="${b.parent}">${esc(nameOf(b.parent))}</a>`);
      staticRows += row('Radius', `${fmtKm(b.radiusKm)}`);
      staticRows += row('GM', `${gm >= 1000 ? fmtNum(gm, 0) : gm.toPrecision(4)} km³/s²${muNote}`);
      staticRows += row('Mass', `${(gm / 6.6743e-20).toPrecision(4)} kg`);
      if (b.radiusKm > 0 && gm > 0) staticRows += row('Surface gravity', `${fmtG((gm / (b.radiusKm ** 2)) * 1000 / G0_M_S2)} · escape ${fmtSpeedKmS(Math.sqrt(2 * gm / b.radiusKm))}`);
      if (b.rotationHours) staticRows += row('Rotation', `${Math.abs(b.rotationHours) > 72 ? `${(Math.abs(b.rotationHours) / 24).toFixed(2)} d` : `${Math.abs(b.rotationHours).toFixed(3)} h`}${b.rotationHours < 0 ? ' (retrograde)' : ''}`);
      if (b.designation) staticRows += row('Designation', esc(b.designation));
      if (b.orbitClass) staticRows += row('Orbit class', esc(b.orbitClass));
      if (b.epochJd) staticRows += row('Elements epoch', `${formatJd(b.epochJd, { time: false })} <span class="muted">(${b.type === 'moon' ? 'Horizons' : 'SBDB'})</span>`);
    } else {
      staticRows += row('Motion', esc(motionSummary(o, s.ctx)));
      const d = driveOf(o);
      if (d) staticRows += row('Drive', d.kind === 'torch' ? `torch, ${fmtG(d.accelG)} <span class="muted">(${(d.accelG * G0_M_S2).toFixed(2)} m/s²)</span>` : 'coast (ballistic transfers, impulsive burns)');
      if (o.tags?.length) staticRows += row('Tags', o.tags.map((t) => `<span class="tag">${esc(t)}</span>`).join(' '));
      if (o.existsFromJd != null || o.existsUntilJd != null) {
        staticRows += row('Exists', `${o.existsFromJd != null ? formatJd(o.existsFromJd) : '—'} → ${o.existsUntilJd != null ? formatJd(o.existsUntilJd) : '—'}`);
      }
    }
    return `
      <dl class="kv">${staticRows}</dl>
      ${o?.motion?.kind === 'route' ? '<div class="section-title">Route</div><div data-f="route"></div>' : ''}
      <div class="section-title">State at <span data-f="when"></span></div>
      <dl class="kv" data-f="state"></dl>
      ${o && !simple() ? `<div class="section-title">Notes</div><textarea class="notes" data-notes rows="5" placeholder="Notes (saved automatically)"></textarea>` : ''}
      ${o ? '<div class="insp-actions end"><button class="btn small danger" data-act="delete" title="Delete this object (cannot be undone)">Delete object</button></div>' : ''}`;
  }

  function row(k, v, cls = '') {
    return `<dt>${k}</dt><dd class="${cls}">${v}</dd>`;
  }

  // ------------------------------------------------------------------ dynamic content

  function refresh(force = false) {
    const now = performance.now();
    if (!force && now - lastRefresh < REFRESH_MS) {
      if (!pending) pending = setTimeout(() => { pending = null; refresh(true); }, REFRESH_MS - (now - lastRefresh));
      return;
    }
    lastRefresh = now;
    const s = store.get();
    const id = s.selection;
    if (!id) return;
    const o = getBody(id) ? null : s.ctx.byId.get(id);
    if (!getBody(id) && !o) return;
    renderBadges(s, id, o);
    renderStatus(s, id);
    if (simple()) refreshSimple(s, id, o);
    const details = host.querySelector('details[data-f=details]');
    if (details && !details.open) return;
    if (tab === 'overview') refreshOverview(s, id, o);
    else if (tab === 'distances') refreshDistances(s, id);
    else refreshOrbit(s, id, o);
  }

  function renderStatus(s, id) {
    const el = host.querySelector('[data-f=status]');
    if (!el) return;
    const st = statusOf(id, s.jd, s.ctx);
    const html = `<span class="status-dot status-${st.kind}"></span>${esc(st.text)}`;
    if (el.dataset.html !== html) { el.innerHTML = html; el.dataset.html = html; }
  }

  function setHtml(el, html) {
    if (el && el.dataset.html !== html) { el.innerHTML = html; el.dataset.html = html; }
  }

  function refreshSimple(s, id, o) {
    const el = host.querySelector('[data-f=simple]');
    if (!el) return;
    const st = stateOf(id, s.jd, s.ctx);
    if (!st) return;
    const r = st.r;
    const dSun = vlen(r);
    const two = (au) => `${fmtAu(au)} · ${fmtMkm(au * AU_KM)}`;
    let html = '<dl class="kv simple">';
    if (id !== 'sun') html += row('From the Sun', two(dSun));
    const b = getBody(id);
    if (id !== 'earth') {
      const dE = vlen(vsub(r, getState('earth', s.jd).r));
      if (dE * AU_KM < 2 * 6371) html += row('From Earth', 'at Earth <span class="muted">(no signal delay)</span>');
      else {
        html += row('From Earth', dE < 0.01 ? fmtKm(dE * AU_KM) : two(dE));
        html += row('Signal delay to Earth', `${fmtLightTime(dE * LIGHT_S_PER_AU)} <span class="muted">one way · ${fmtLightTime(2 * dE * LIGHT_S_PER_AU)} reply</span>`);
      }
    }
    const m = s.measure;
    if (m?.a && m?.b && (m.a === id || m.b === id)) {
      const other = m.a === id ? m.b : m.a;
      const p = positionOf(other, s.jd, s.ctx);
      if (p) {
        const d = vlen(vsub(p, r));
        html += row(`Signal delay to ${esc(nameOf(other, s.ctx))}`, `${fmtLightTime(d * LIGHT_S_PER_AU)} <span class="muted">(${d < 0.01 ? fmtKm(d * AU_KM) : two(d)})</span>`);
      }
    }
    html += row('Speed', `${fmtKmS(vlen(st.v))} <span class="muted">relative to the Sun</span>`);
    const parent = parentOf(id, s.ctx);
    if (parent && parent !== 'sun') {
      const ps = stateOf(parent, s.jd, s.ctx);
      const pb = getBody(parent);
      if (ps) {
        const d = vlen(vsub(r, ps.r)) * AU_KM;
        html += row(`Above ${esc(nameOf(parent, s.ctx))}`, pb ? `${fmtKm(Math.max(0, d - pb.radiusKm))} <span class="muted">altitude</span>` : fmtKm(d));
      }
    }
    if (b) html += row('Size', `${fmtKm(b.radiusKm)} radius`);
    html += '</dl>';
    if (o) {
      const t = tripFacts(o, s.jd, s.ctx);
      if (t) {
        html += `<div class="section-title">${t.departJd > s.jd ? 'Next trip' : 'This trip'}</div><dl class="kv simple">`;
        html += row('Destination', esc(t.to) + (t.mode === 'intercept' ? ' <span class="muted">(intercept)</span>' : ''));
        if (t.departJd > s.jd) html += row('Departs', `${whenText(t.departJd, s.jd)} <span class="muted">(in ${fmtDuration(t.departJd - s.jd)})</span>`);
        html += row('ETA', `${whenText(t.arriveJd, s.jd)} <span class="muted">(${t.arriveJd >= s.jd ? `in ${fmtDuration(t.arriveJd - s.jd)}` : 'arrived'})</span>`);
        if (t.peak != null) html += row('Peak speed', fmtKmS(t.peak));
        if (t.dv != null) html += row('delta-v (Δv)', fmtKmS(t.dv));
        if (t.closing != null) html += row('Closing speed', fmtKmS(t.closing));
        if (t.profile === 'ballistic') {
          const ph = routePhase(o.motion, s.jd);
          const i = ph.kind === 'transit' ? ph.leg : ph.stop;
          const sm = ballisticSummary(legData(o, i, s.ctx), s.ctx);
          if (sm) {
            html += row('Departure burn', fmtKmS(sm.dep.dv));
            if (sm.arr.kind === 'park' || sm.arr.kind === 'direct') html += row('Arrival burn', fmtKmS(sm.arr.dv));
            html += row('delta-v (Δv)', `${fmtKmS(sm.totalDv)}${sm.status === 'pending' ? ' <span class="muted">(refining…)</span>' : ''}`);
          }
        }
        html += '</dl>';
      }
    }
    setHtml(el, html);
  }

  function renderBadges(s, id, o) {
    const el = host.querySelector('[data-f=badges]');
    if (!el) return;
    const badges = [];
    if (o) {
      if (!existsAt(o, s.jd)) badges.push(['warn', o.existsFromJd != null && s.jd < o.existsFromJd ? 'Not yet exists' : 'No longer exists']);
      const err = s.ctx.errors.get(o.id);
      if (err) badges.push(['err', `⚠ ${err}`]);
    }
    if (s.focus === id) badges.push(['plain', 'Camera follows']);
    if (s.measure && (s.measure.a === id || s.measure.b === id)) badges.push(['measure', 'Measured']);
    const html = badges.map(([k, t]) => `<span class="badge badge-${k}">${esc(t)}</span>`).join('');
    if (el.innerHTML !== html) el.innerHTML = html;
  }

  function refreshOverview(s, id, o) {
    const when = host.querySelector('[data-f=when]');
    if (when) when.textContent = formatJd(s.jd);
    const st = stateOf(id, s.jd, s.ctx);
    const el = host.querySelector('[data-f=state]');
    if (!st || !el) return;
    const r = st.r, v = st.v;
    const dSun = vlen(r);
    let html = '';
    html += row('Position x', `${r[0].toFixed(6)} AU`, 'mono');
    html += row('Position y', `${r[1].toFixed(6)} AU`, 'mono');
    html += row('Position z', `${r[2].toFixed(6)} AU`, 'mono');
    html += row('From Sun', `${fmtAu(dSun)} · ${fmtMkm(dSun * AU_KM)}<br><span class="muted">signal delay ${fmtLightTime(dSun * LIGHT_S_PER_AU)}</span>`);
    html += row('Speed', `${fmtKmS(vlen(v))} <span class="muted">heliocentric</span>`);
    const parent = parentOf(id, s.ctx);
    if (parent && parent !== 'sun') {
      const ps = stateOf(parent, s.jd, s.ctx);
      if (ps) {
        const rel = vsub(r, ps.r);
        const pb = getBody(parent);
        const d = vlen(rel) * AU_KM;
        const alt = pb ? ` · altitude ${fmtKm(d - pb.radiusKm)}` : '';
        html += row(`From ${esc(nameOf(parent, s.ctx))}`, `${fmtKm(d)}${alt}<br><span class="muted">relative speed ${fmtKmS(vlen(vsub(v, ps.v)))}</span>`);
      }
    }
    if (id !== 'earth' && parent !== 'earth') {
      const e = getState('earth', s.jd).r;
      const d = vlen(vsub(r, e));
      html += row('From Earth', `${fmtDist(d)}<br><span class="muted">signal delay ${fmtLightTime(d * LIGHT_S_PER_AU)} one-way</span>`);
    }
    if (el.innerHTML !== html) el.innerHTML = html;
    if (o?.motion?.kind === 'route') refreshRoute(s, o);
  }

  function legSummary(leg, s) {
    const from = nameOfStop(leg.fromStop, s.ctx), to = nameOfStop(leg.toStop, s.ctx);
    let t = `<dl class="kv">`;
    const prof = { thrust: 'torch', drift: 'engines off', ballistic: 'ballistic', brachistochrone: 'brachistochrone', linear: 'linear' }[leg.profile] ?? leg.profile;
    t += row('Leg', `${esc(from)} → ${esc(to)} <span class="muted">(${prof}${leg.fallback ? ', no solution — straight line' : ''})</span>`);
    t += row('Departs', formatJd(leg.t0));
    if (leg.cut) t += row('Course changed', `${formatJd(leg.tEnd)} <span class="muted">(after ${fmtDuration(leg.tEnd - leg.t0)}; planned arrival ${formatJd(leg.t1)})</span>`);
    let notes = '';
    if (leg.profile === 'thrust') {
      const th = thrustHtml(leg);
      if (th) { t += th.rows; notes = th.notes; }
      t += row('Distance', `${fmtDist(leg.D)} <span class="muted">(start to meeting point)</span>`);
    } else if (leg.profile === 'drift') {
      t += row('Until', `${formatJd(leg.tEnd)} <span class="muted">(${fmtDuration(leg.tEnd - leg.t0)})</span>`);
      t += row('Speed at engine cut', fmtKmS(vlen(leg.V0)));
      notes = '<div class="muted small">Coasting in the gravity of the Sun and the 8 planets.</div>';
    } else {
      if (!leg.cut) t += row('Arrives', `${formatJd(leg.t1)} <span class="muted">(${fmtDuration(leg.T)})</span>`);
      t += row('Distance', fmtDist(leg.D));
      if (leg.profile === 'brachistochrone') {
        t += row('Acceleration', `${fmtG(auDay2ToMS2(leg.accel) / G0_M_S2)} <span class="muted">(${auDay2ToMS2(leg.accel).toFixed(3)} m/s²)</span>`);
        t += row('Peak velocity', fmtKmS(leg.vPeak));
        t += row('delta-v (Δv)', `${fmtKmS(leg.dv)} <span class="muted">(gravity-free)</span>`);
        const au = auditHtml(leg);
        if (au) { t += au.rows; notes = au.notes; }
      } else if (leg.profile === 'ballistic' && leg.ballistic) {
        const bh = ballisticHtml(leg, s.ctx);
        t += bh.rows;
        notes = bh.notes;
      } else {
        t += row('Average speed', fmtKmS(leg.vAvg));
      }
    }
    return t + '</dl>' + notes;
  }

  function refreshRoute(s, o) {
    const el = host.querySelector('[data-f=route]');
    if (!el) return;
    const st = customState(o, s.jd, s.ctx);
    const li = st.legInfo;
    const m = o.motion;
    let html = '';
    if (li?.phase.kind === 'transit') {
      const leg = li.leg;
      html += `<div class="progress"><div style="width:${(Math.min(1, Math.max(0, li.tau)) * 100).toFixed(1)}%"></div></div>`;
      html += legSummary(leg, s);
    } else if (li?.next) {
      html += legSummary(li.next, s);
    } else if (li?.phase.kind === 'arrived') {
      const last = m.stops[m.stops.length - 1];
      if (li.drift) {
        const res = driftResult(li.drift);
        html += `<p class="route-now">Engines off since ${formatJd(li.drift.t)} at ${fmtKmS(vlen(li.drift.v))}.</p>`;
        if (res?.impacts?.length) html += res.impacts.map((im) => `<span class="badge badge-impact">DRIFT HITS ${esc(nameOf(im.id, s.ctx).toUpperCase())} on ${formatJd(im.jd, { time: false })}</span>`).join(' ');
        html += '<div class="muted small">Dashed line: the coast for the next three years (Sun + 8 planets N-body).</div>';
      } else html += `<p class="route-now">Arrived at ${esc(nameOfStop(last, s.ctx))} on ${formatJd(last.arriveJd)}.</p>`;
    }
    // itinerary
    html += '<table class="itin"><thead><tr><th>#</th><th>Stop</th><th>Arrive</th><th>Depart</th></tr></thead><tbody>';
    m.stops.forEach((st2, i) => {
      const fly = isFlybyStop(m.stops, i);
      const label = isWaypoint(st2) ? `<span class="muted">course change${st2.aborted ? ` (was bound for ${esc(nameOfStop(st2.aborted, s.ctx))})` : ''}</span>`
        : st2.ref ? esc(nameOf(st2.ref, s.ctx)) : st2.kind === 'hold' ? esc(nameOfStop(st2, s.ctx)) : `(${(+st2.x).toFixed(3)}, ${(+st2.y).toFixed(3)}, ${(+st2.z).toFixed(3)}) AU`;
      html += `<tr><td>${i + 1}</td><td>${label}</td>
        <td class="mono">${st2.arriveJd != null ? formatJd(st2.arriveJd) : '—'}</td><td class="mono">${fly ? '<span class="muted">flyby</span>' : st2.departJd != null ? formatJd(st2.departJd) : '—'}</td></tr>`;
    });
    html += '</tbody></table>';
    html += flybysHtml(o, s.ctx);
    html += routeDeltaVHtml(o, s.ctx);
    if (m.stops.length > 2) {
      html += '<details class="legs"><summary>All legs</summary>';
      for (let i = 0; i < m.stops.length - 1; i++) {
        if (m.stops[i].departJd == null || m.stops[i + 1].arriveJd == null || !(m.stops[i + 1].arriveJd > m.stops[i].departJd)) continue;
        html += `<div class="leg-block"><div class="muted">Leg ${i + 1}</div>${legSummary(legData(o, i, s.ctx), s)}</div>`;
      }
      html += '</details>';
    }
    if (el.dataset.html !== html) {
      const open = el.querySelector('details.legs')?.open;
      el.innerHTML = html;
      el.dataset.html = html;
      if (open) el.querySelector('details.legs').open = true;
    }
  }

  function refreshDistances(s, id) {
    const el = host.querySelector('[data-f=dist]');
    if (!el) return;
    const me = stateOf(id, s.jd, s.ctx);
    if (!me) return;
    const ids = ['sun', ...allBodies().filter((b) => b.type === 'planet').map((b) => b.id), 'moon'];
    const b = getBody(id);
    const parent = parentOf(id, s.ctx);
    if (parent && !ids.includes(parent)) ids.push(parent);
    if (b?.type === 'moon') for (const m of moonsOf(b.parent)) if (!ids.includes(m)) ids.push(m);
    if (b && moonsOf(id).length) for (const m of moonsOf(id)) if (!ids.includes(m)) ids.push(m);
    for (const o of s.objects) ids.push(o.id);
    const rowsData = [];
    for (const tid of ids) {
      if (tid === id) continue;
      const p = positionOf(tid, s.jd, s.ctx);
      if (!p) continue;
      const d = vlen(vsub(p, me.r));
      const o = s.ctx.byId.get(tid);
      rowsData.push({ id: tid, name: nameOf(tid, s.ctx), d, custom: !!o, inactive: o ? !existsAt(o, s.jd) : false, color: o ? o.color : getBody(tid).color });
    }
    rowsData.sort((a, c) => (sortKey === 'name' ? a.name.localeCompare(c.name) : a.d - c.d) * sortDir);
    const arrow = (k) => (sortKey === k ? (sortDir > 0 ? ' ▲' : ' ▼') : '');
    let html = `
      <div class="insp-actions">
        <button class="btn small" data-act="measure" title="Draw a measuring line to the next object you click">Measure to…</button>
        ${s.measure ? '<button class="btn small" data-act="clear-measure" title="Remove the measuring line">Clear measurement</button>' : ''}
      </div>
      <p class="muted small">From <b>${esc(nameOf(id, s.ctx))}</b> at ${formatJd(s.jd)}. Signal delay is straight-line distance / speed of light.</p>
      <table class="dist-table"><thead><tr>
        <th data-sort="name">Object${arrow('name')}</th><th data-sort="dist" class="num">AU${arrow('dist')}</th><th class="num">M km</th><th class="num" title="One-way signal (light) delay">Signal</th><th class="num" title="Round-trip signal delay">Reply</th>
      </tr></thead><tbody>`;
    const auCell = (d) => (d === 0 ? '0' : d < 0.001 ? d.toPrecision(3) : d.toFixed(d < 10 ? 4 : 2));
    const mkmCell = (km) => (km === 0 ? '0' : km < 1e5 ? (km / 1e6).toPrecision(3) : fmtNum(km / 1e6, km < 1e7 ? 3 : 1));
    for (const r of rowsData) {
      const lt = r.d * LIGHT_S_PER_AU;
      const km = r.d * AU_KM;
      html += `<tr data-goto="${esc(r.id)}" class="${r.inactive ? 'inactive' : ''}" title="${esc(r.name)}: ${esc(fmtDist(r.d))}${r.inactive ? ' — does not exist at this time' : ''}">
        <td><span class="dot" style="background:${esc(r.color)}"></span>${esc(r.name)}</td>
        <td class="num mono">${auCell(r.d)}</td>
        <td class="num mono">${mkmCell(km)}</td>
        <td class="num">${r.d === 0 ? '0 s' : fmtLightTime(lt)}</td><td class="num">${r.d === 0 ? '0 s' : fmtLightTime(2 * lt)}</td></tr>`;
    }
    html += '</tbody></table>';
    if (el.dataset.html !== html) { el.innerHTML = html; el.dataset.html = html; }
  }

  function refreshOrbit(s, id, o) {
    const el = host.querySelector('[data-f=orbit]');
    if (!el) return;
    const b = getBody(id);
    if (id === 'sun') { el.innerHTML = '<p class="muted">The Sun is the origin of the heliocentric frame.</p>'; return; }
    if (o?.motion?.kind === 'colocated') {
      el.innerHTML = `<p class="muted">Co-located with ${esc(nameOf(o.motion.parent, s.ctx))}; its heliocentric motion is that body's.</p>`;
      return;
    }
    let center = 'sun';
    if (b) center = b.parent || 'sun';
    else if (o?.motion?.kind === 'orbit') center = o.motion.parent;
    const me = stateOf(id, s.jd, s.ctx);
    const c = stateOf(center, s.jd, s.ctx);
    if (!me || !c) return;
    let mu = center === 'sun' ? GM_SUN : muOf(center);
    if (b) mu += getMu(id); // two-body: relative motion feels G(M + m)
    if (!(mu > 0)) {
      el.innerHTML = `<p class="muted">${esc(nameOf(center, s.ctx))} has no gravity in this model (custom object): the object holds a fixed offset.</p>`;
      return;
    }
    const rr = vsub(me.r, c.r), vv = vsub(me.v, c.v);
    const el2 = stateToElements(rr, vv, mu, s.jd);
    const cb = getBody(center);
    const toKm = (au) => au * AU_KM;
    const dist = (au) => (Math.abs(au) < 0.01 ? fmtKm(toKm(au)) : `${fmtAu(au)} (${fmtMkm(toKm(au))})`);
    const alt = (au) => (cb && center !== 'sun' ? ` · alt ${fmtKm(toKm(au) - cb.radiusKm)}` : '');
    const hyper = !(el2.e < 1);
    let html = `<p class="muted small">Osculating elements about <b>${esc(nameOf(center, s.ctx))}</b> at ${formatJd(s.jd)}, ecliptic J2000, μ = ${fmtNum(mu * AU_KM ** 3 / 86400 ** 2, mu * AU_KM ** 3 / 86400 ** 2 >= 100 ? 0 : 4)} km³/s².${o?.motion?.kind === 'route' ? ' For a ship under thrust these are the orbit it would follow if the engines stopped now.' : ''}</p><dl class="kv">`;
    html += row('Semi-major axis a', hyper ? `${dist(el2.a)} <span class="muted">(hyperbolic)</span>` : dist(el2.a));
    html += row('Eccentricity e', el2.e.toFixed(6), 'mono');
    html += row('Inclination i', fmtDeg(el2.i, 4));
    html += row('Long. of asc. node Ω', fmtDeg(el2.om, 4));
    html += row('Arg. of periapsis ω', fmtDeg(el2.w, 4));
    html += row('Mean anomaly M', hyper ? `${el2.M.toFixed(4)} rad` : fmtDeg(el2.M, 4));
    html += row('True anomaly ν', fmtDeg(el2.nu, 4));
    html += row('Period', hyper ? '— (unbound)' : fmtDuration(el2.period));
    html += row('Periapsis', `${dist(el2.rp)}${alt(el2.rp)}`);
    html += row('Apoapsis', hyper ? '—' : `${dist(el2.ra)}${alt(el2.ra)}`);
    html += row('Current distance', `${dist(vlen(rr))}${alt(vlen(rr))}`);
    html += row('Orbital speed', fmtKmS(vlen(vv)));
    html += '</dl>';
    if (b?.ephem.kind === 'kepler') html += `<p class="muted small">Model: fixed Kepler elements (epoch ${formatJd(b.ephem.elements.epoch, { time: false })}).</p>`;
    if (b?.ephem.kind === 'planet' || b?.id === 'earth') html += '<p class="muted small">Model: JPL/Standish mean elements (valid 3000 BC – 3000 AD).</p>';
    if (el.dataset.html !== html) { el.innerHTML = html; el.dataset.html = html; }
  }

  // ------------------------------------------------------------------ events

  host.addEventListener('click', async (ev) => {
    const t = ev.target;
    const tabBtn = t.closest('.tab[data-tab]');
    if (tabBtn) {
      tab = tabBtn.dataset.tab;
      try { localStorage.setItem('ssm.ui.inspectorTab', tab); } catch { /* ignore */ }
      renderTab(store.get());
      return;
    }
    const sortTh = t.closest('th[data-sort]');
    if (sortTh) {
      const k = sortTh.dataset.sort;
      if (sortKey === k) sortDir = -sortDir; else { sortKey = k; sortDir = 1; }
      refresh(true);
      return;
    }
    const go = t.closest('[data-goto]');
    if (go) { ev.preventDefault(); app.pick(go.dataset.goto); return; }
    const cmd = t.closest('[data-cmd]');
    if (cmd) {
      // the inspector's command buttons act on the selection like the command bar
      if (!commandableIds().length) return;
      app.commands.runCommand(cmd.dataset.cmd, cmd);
      return;
    }
    const act = t.closest('[data-act]')?.dataset.act;
    const s = store.get();
    if (!act) return;
    if (act === 'focus') store.set({ focus: s.selection });
    else if (act === 'measure') app.armMeasure();
    else if (act === 'clear-measure') store.set({ measure: null, measureArmed: false });
    else if (act === 'plan') app.openPlanner({ from: s.selection });
    else if (act === 'edit') app.openEditor(s.selection);
    else if (act === 'delete') {
      const o = s.ctx.byId.get(s.selection);
      if (o && await confirmModal('Delete object', `Delete “${o.name}”? This cannot be undone (export first if unsure).`, 'Delete')) {
        deleteObject(o.id);
        app.toast(`Deleted ${o.name}`, 'success');
      }
    }
  });

  store.subscribe((s, changed) => {
    const notesTyping = document.activeElement?.matches?.('#inspector textarea[data-notes]');
    if (changed.includes('selection') || changed.includes('multiSelection') || changed.includes('detail') || (changed.includes('objects') && !notesTyping) || builtFor === undefined) {
      builtFor = s.selection;
      shell(s);
      return;
    }
    if (changed.some((k) => k === 'jd' || k === 'measure' || k === 'focus' || k === 'ctx')) refresh();
  });
  // N-body legs / gravity audits finishing in the background
  onTrajectoryUpdate(() => refresh(true));
  shell(store.get());
  builtFor = store.get().selection;
}
