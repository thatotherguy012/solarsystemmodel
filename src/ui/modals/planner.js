// Travel planner: brachistochrone (given acceleration or duration) with a gravity audit, and ballistic transfers
// refined in the Sun + 8 planets N-body field (patched-conic endpoints) with parking-orbit burns, plus a duration
// scan for cheap ballistic windows. §8 (v2). Plans are evaluated as temporary one-leg routes so the numbers are
// exactly those a ship created from the plan will show.
import { G0_M_S2, LIGHT_S_PER_AU, AU_KM, mS2ToAuDay2, auDay2ToMS2, auDayToKmS } from '../../astro/constants.js';
import { vdist } from '../../astro/vec3.js';
import { formatJd, parseDateToJd } from '../../astro/time.js';
import { brachistochroneTime } from '../../astro/lambert.js';
import { store } from '../../sim/store.js';
import { positionOf, nameOf, solveBrachistochroneTime, legData } from '../../sim/custom.js';
import { onTrajectoryUpdate, cancelGroup } from '../../sim/trajectory.js';
import { ballisticSummary, stopGravity } from '../../sim/legPhysics.js';
import { openModal, h } from '../modal.js';
import { refPicker } from '../components.js';
import { ballisticHtml, auditHtml } from '../legInfo.js';
import { fmtDist, fmtKmS, fmtSpeedKmS, fmtG, fmtDuration, fmtLightTime, fmtAu, fmtMS2, fmtMkm, esc } from '../format.js';
import { createLaunchWindowsTab } from './launchWindows.js';

const SCAN_DAYS = [60, 90, 120, 150, 180, 210, 240, 300, 365, 450, 550, 730, 900, 1096];
const GROUP = 'planner';

/**
 * @param {Object} app
 * @param {{from?:string, to?:string, tab?:'plan'|'windows'}} [init] tab: open on the "Launch windows" tab
 */
export function openPlanner(app, init = {}) {
  const s0 = store.get();
  const state = {
    from: init.from && init.from !== init.to ? init.from : 'earth',
    to: init.to ?? (init.from === 'mars' ? 'earth' : 'mars'),
    departStr: formatJd(s0.jd).replace(' UTC', ''),
    mode: 'accel', accelG: '0.3', durationDays: '120', depParkStr: '', arrParkStr: '',
  };
  if (state.from === state.to) state.to = state.from === 'earth' ? 'mars' : 'earth';

  const body = h(`<div class="planner">
    <div class="tabs planner-tabs" role="tablist" aria-label="Planner views"><button type="button" class="tab" role="tab" data-tab="plan" aria-selected="true">Plan a trip</button><button type="button" class="tab" role="tab" data-tab="windows" aria-selected="false">Launch windows</button></div>
    <div data-pane="plan">
    <div class="form-grid">
      <div class="field"><span class="field-label">From</span><div data-f="from"></div></div>
      <div class="field"><span class="field-label">To</span><div data-f="to"></div></div>
      <label>Departure (UTC)<div class="inline"><input data-k="departStr" class="mono"><button type="button" class="btn small" data-f="nowbtn" title="Use the current simulation time">Sim time</button></div></label>
      <label>Mode<select data-k="mode">
        <option value="accel">Brachistochrone — given acceleration</option>
        <option value="duration">Brachistochrone — given duration</option>
        <option value="ballistic">Ballistic (N-body) — given duration</option>
      </select></label>
      <label data-f="accelWrap">Acceleration (g)<input data-k="accelG" class="mono" inputmode="decimal"></label>
      <label data-f="durWrap">Duration (days)<input data-k="durationDays" class="mono" inputmode="decimal"></label>
      <label data-f="depParkWrap" title="Circular parking orbit the departure burn starts from (blank = default for the body)">Departure parking altitude (km)<input data-k="depParkStr" class="mono" inputmode="decimal"></label>
      <label data-f="arrParkWrap" title="Circular orbit the capture burn ends in (blank = default for the body)">Arrival parking altitude (km)<input data-k="arrParkStr" class="mono" inputmode="decimal"></label>
    </div>
    <div class="planner-out" data-f="out" aria-live="polite"></div>
    <div data-f="scan"></div>
    </div>
    <div data-pane="windows" hidden></div>
  </div>`);
  const foot = h(`<div class="btn-row"><span class="muted small">Ballistic: Sun + 8 planets N-body, patched-conic ends. Brachistochrone: straight line with a gravity audit.</span><span class="spacer"></span>
    <button class="btn" data-a="close">Close</button><button class="btn primary" data-a="create">Create ship from this plan</button></div>`);
  let unsub = () => {};
  /** "Launch windows" tab (created below) and the active tab. */
  let windows = null, activeTab = 'plan';
  const modal = openModal({ title: 'Travel planner', body, footer: foot, wide: true, onClose: () => { unsub(); cancelGroup(GROUP); windows?.destroy(); } });
  const q = (sel) => body.querySelector(sel);

  const fromP = refPicker({ value: state.from, ariaLabel: 'From', onChange: (v) => { state.from = v; windows?.inputsChanged(); compute(); } });
  const toP = refPicker({ value: state.to, ariaLabel: 'To', onChange: (v) => { state.to = v; windows?.inputsChanged(); compute(); } });
  q('[data-f=from]').appendChild(fromP.el);
  q('[data-f=to]').appendChild(toP.el);
  for (const inp of body.querySelectorAll('[data-k]')) {
    inp.value = state[inp.dataset.k];
    const ev = inp.tagName === 'SELECT' ? 'change' : 'input';
    inp.addEventListener(ev, () => { state[inp.dataset.k] = inp.value; compute(); });
  }
  q('[data-f=nowbtn]').addEventListener('click', () => {
    state.departStr = formatJd(store.get().jd).replace(' UTC', '');
    q('[data-k=departStr]').value = state.departStr;
    compute();
  });

  let plan = null;

  function row(k, v) { return `<dt>${k}</dt><dd>${v}</dd>`; }

  /** Parking altitude from a field: number, null (blank = default) or NaN (invalid). */
  const parkVal = (str) => (String(str).trim() === '' ? null : Number(str) >= 0 ? Number(str) : NaN);

  /** A temporary one-leg route evaluated with the same code as real ships (cached by geometry). */
  function tmpLeg(id, profile, t0, t1, parkDep, parkArr) {
    const stops = [
      { ref: state.from, arriveJd: null, departJd: t0, ...(parkDep != null ? { parkAltKm: parkDep } : {}) },
      { ref: state.to, arriveJd: t1, departJd: null, ...(parkArr != null ? { parkAltKm: parkArr } : {}) },
    ];
    const obj = { id, trajGroup: GROUP, motion: { kind: 'route', profile, stops } };
    return legData(obj, 0, store.get().ctx);
  }

  function renderParkPlaceholders() {
    const ctx = store.get().ctx;
    for (const [key, ref] of [['depParkStr', state.from], ['arrParkStr', state.to]]) {
      const g = stopGravity({ ref }, ctx);
      const el = q(`[data-k=${key}]`);
      el.placeholder = g.gm > 0 ? `default ${+g.parkAltKm.toFixed(1)} (${nameOf(g.bodyId, ctx)})` : 'n/a (no parking orbit)';
    }
  }

  function compute() {
    const out = q('[data-f=out]'), scan = q('[data-f=scan]');
    const ballisticMode = state.mode === 'ballistic';
    q('[data-f=accelWrap]').hidden = state.mode !== 'accel';
    q('[data-f=durWrap]').hidden = state.mode === 'accel';
    q('[data-f=depParkWrap]').hidden = q('[data-f=arrParkWrap]').hidden = !ballisticMode;
    renderParkPlaceholders();
    cancelGroup(GROUP);
    plan = null;
    foot.querySelector('[data-a=create]').disabled = true;
    const ctx = store.get().ctx;
    const t0 = parseDateToJd(state.departStr);
    const parkDep = parkVal(state.depParkStr), parkArr = parkVal(state.arrParkStr);
    const errs = [];
    if (!Number.isFinite(t0)) errs.push('Departure is not a valid date (YYYY-MM-DD HH:MM).');
    if (!state.from || !state.to) errs.push('Choose both endpoints.');
    if (state.from && state.from === state.to) errs.push('From and To must differ.');
    if (ballisticMode && (Number.isNaN(parkDep) || Number.isNaN(parkArr))) errs.push('Parking altitudes must be non-negative numbers of km (or blank for the default).');
    if (errs.length) { out.innerHTML = errs.map((e) => `<div class="msg err">✕ ${esc(e)}</div>`).join(''); scan.innerHTML = ''; return; }
    const P0 = positionOf(state.from, t0, ctx);
    const D0 = vdist(positionOf(state.to, t0, ctx), P0);
    let html = `<dl class="kv wide">
      ${row('Straight-line distance at departure', `${fmtDist(D0)}`)}
      ${row('One-way light time at departure', `${fmtLightTime(D0 * LIGHT_S_PER_AU)} <span class="muted">(round trip ${fmtLightTime(2 * D0 * LIGHT_S_PER_AU)})</span>`)}`;
    let notes = '';
    let T = NaN;
    if (state.mode === 'accel') {
      const g = parseFloat(state.accelG);
      if (!(g > 0)) { out.innerHTML = html + '</dl><div class="msg err">✕ Acceleration must be a positive number of g.</div>'; scan.innerHTML = ''; return; }
      const a = mS2ToAuDay2(g * G0_M_S2);
      T = solveBrachistochroneTime({ ref: state.from }, { ref: state.to }, t0, g, ctx);
      const D = vdist(positionOf(state.to, t0 + T, ctx), P0);
      html += row('Duration', `<b>${fmtDuration(T)}</b>`);
      html += row('Arrival', `<b>${formatJd(t0 + T)}</b>`);
      html += row('Distance flown (to where the target will be)', fmtDist(D));
      html += row('Acceleration', `${fmtG(g)} <span class="muted">(${fmtMS2(a)})</span>`);
      html += row('Peak velocity (midpoint)', fmtKmS(a * T / 2));
      html += row('Δv (accelerate + decelerate, gravity-free)', fmtKmS(a * T));
      html += row('Naive time from departure distance', `<span class="muted">${fmtDuration(brachistochroneTime(D0, a))}</span>`);
      const au = auditHtml(tmpLeg('__planner_main', 'brachistochrone', t0, t0 + T));
      if (au) { html += au.rows; notes += au.notes; }
      plan = { profile: 'brachistochrone', accelG: g, t0, t1: t0 + T, solved: true };
    } else {
      T = parseFloat(state.durationDays);
      if (!(T > 0)) { out.innerHTML = html + '</dl><div class="msg err">✕ Duration must be a positive number of days.</div>'; scan.innerHTML = ''; return; }
      const P1 = positionOf(state.to, t0 + T, ctx);
      const D = vdist(P1, P0);
      html += row('Arrival', `<b>${formatJd(t0 + T)}</b>`);
      html += row('Distance flown', fmtDist(D));
      if (state.mode === 'duration') {
        const a = 4 * D / (T * T);
        html += row('Required acceleration', `<b>${fmtG(auDay2ToMS2(a) / G0_M_S2)}</b> <span class="muted">(${fmtMS2(a)})</span>`);
        html += row('Peak velocity (midpoint)', fmtKmS(2 * D / T));
        html += row('Δv (accelerate + decelerate, gravity-free)', fmtKmS(4 * D / T));
        const au = auditHtml(tmpLeg('__planner_main', 'brachistochrone', t0, t0 + T));
        if (au) { html += au.rows; notes += au.notes; }
        plan = { profile: 'brachistochrone', accelG: auDay2ToMS2(a) / G0_M_S2, t0, t1: t0 + T, solved: false };
      } else {
        // scan rows are requested first so the main plan (requested last) is computed first (Plan tab only)
        if (activeTab === 'plan') renderScan(t0, parkDep, parkArr);
        const leg = tmpLeg('__planner_main', 'ballistic', t0, t0 + T, parkDep, parkArr);
        if (!leg.ballistic) html += '</dl><div class="msg warn">⚠ No ballistic (single-revolution Lambert) solution for this geometry and duration.</div><dl class="kv wide">';
        else {
          const bh = ballisticHtml(leg, ctx);
          html += bh.rows;
          html += row('Perihelion / aphelion', `${fmtAu(leg.ballistic.rp)}${leg.ballistic.e < 1 ? ` / ${fmtAu(leg.ballistic.a * (1 + leg.ballistic.e))}` : ' <span class="muted">(hyperbolic)</span>'}`);
          notes += bh.notes;
          plan = { profile: 'ballistic', t0, t1: t0 + T };
        }
      }
    }
    html += '</dl>' + notes;
    out.innerHTML = html;
    // on the Launch windows tab the plan only counts once a cell / torch departure has been picked there
    foot.querySelector('[data-a=create]').disabled = !plan || (activeTab === 'windows' && !windows?.hasSelection());
    if (!ballisticMode) scan.innerHTML = '';
  }

  function renderScan(t0, parkDep, parkArr) {
    const scan = q('[data-f=scan]');
    const ctx = store.get().ctx;
    const results = SCAN_DAYS.map((days) => {
      const leg = tmpLeg(`__planner_scan_${days}`, 'ballistic', t0, t0 + days, parkDep, parkArr);
      return { days, s: leg.ballistic ? ballisticSummary(leg, ctx) : null };
    });
    let best = null, done = 0;
    for (const x of results) {
      if (!x.s) continue;
      if (x.s.status !== 'pending') done++;
      if (!best || x.s.totalDv < best.s.totalDv) best = x;
    }
    const kms = (v) => fmtSpeedKmS(auDayToKmS(v));
    let rows = '';
    for (const x of results) {
      const s = x.s;
      const star = s && s.status !== 'nbody' ? '<span class="muted">*</span>' : '';
      const ca = s?.closest?.[0];
      rows += `<tr data-days="${x.days}" class="${x === best ? 'best' : ''}"><td>${fmtDuration(x.days)}</td><td class="mono">${formatJd(t0 + x.days, { time: false })}</td>
        <td class="num">${s ? kms(s.vinfDep) + star : '—'}</td><td class="num">${s ? kms(s.vinfArr) + star : '—'}</td>
        <td class="num">${s ? kms(s.dep.dv) : '—'}</td><td class="num">${s ? kms(s.arr.dv) : '—'}</td>
        <td class="num"><b>${s ? kms(s.totalDv) : 'no solution'}</b>${s?.impacts?.length ? ' <span class="badge badge-impact">IMPACT</span>' : ''}</td>
        <td>${ca ? `${esc(nameOf(ca.id, ctx))} ${fmtMkm(ca.distAu * AU_KM)}${ca.close ? ' <b class="warn-text">close</b>' : ''}` : s?.status === 'failed' ? '<span class="warn-text">N-body failed</span>' : '<span class="muted">…</span>'}</td></tr>`;
    }
    const total = results.filter((x) => x.s).length;
    scan.innerHTML = `<div class="section-title">Duration scan (departing ${formatJd(t0, { time: false })}) — click a row to use it</div>
      <table class="scan-table"><thead><tr><th>Duration</th><th>Arrival</th><th class="num">Dep. v∞</th><th class="num">Arr. v∞</th><th class="num">Dep. burn</th><th class="num">Capture</th><th class="num">Total Δv</th><th>Closest approach</th></tr></thead><tbody>${rows}</tbody></table>
      <div class="muted small">${done < total ? `N-body refinement ${done}/${total} done; * = two-body value until refined. ` : ''}Burns from / into circular parking orbits (altitudes above).</div>`;
  }

  q('[data-f=scan]').addEventListener('click', (ev) => {
    const tr = ev.target.closest('tr[data-days]');
    if (!tr) return;
    state.durationDays = tr.dataset.days;
    q('[data-k=durationDays]').value = state.durationDays;
    compute();
  });

  foot.querySelector('[data-a=close]').addEventListener('click', () => modal.close());
  foot.querySelector('[data-a=create]').addEventListener('click', () => {
    if (!plan) return;
    const jdStr = (jd) => formatJd(jd).replace(' UTC', '');
    const fromName = nameOf(state.from, store.get().ctx), toName = nameOf(state.to, store.get().ctx);
    const ballistic = plan.profile === 'ballistic';
    const prefill = {
      name: `${fromName}–${toName} ship`, type: 'ship', kind: 'route',
      route: {
        profile: plan.profile,
        accelG: plan.profile === 'brachistochrone' ? String(+plan.accelG.toPrecision(4)) : '',
        stops: [
          { ref: state.from, x: '', y: '', z: '', arriveStr: '', departStr: jdStr(plan.t0), parkAltStr: ballistic ? state.depParkStr.trim() : '', flyby: false },
          { ref: state.to, x: '', y: '', z: '', arriveStr: plan.solved ? '' : jdStr(plan.t1), departStr: '', parkAltStr: ballistic ? state.arrParkStr.trim() : '', flyby: false },
        ],
      },
    };
    modal.close();
    app.openEditor(null, prefill);
  });

  // ---- "Launch windows" tab (porkchop plot + torch-ship curve, ./launchWindows.js). It borrows the From/To pickers
  // and the result block while shown, and sets the plan through applyPlan() when a cell or a departure is picked.
  /** Set plan fields (state keys of the Plan tab's inputs, e.g. mode, departStr, durationDays), sync the inputs, recompute. */
  function applyPlan(patch) {
    Object.assign(state, patch);
    for (const inp of q('[data-pane=plan]').querySelectorAll('[data-k]')) if (inp.dataset.k in patch) inp.value = state[inp.dataset.k];
    compute();
  }
  windows = createLaunchWindowsTab(app, { state, fromPicker: fromP, toPicker: toP, outEl: q('[data-f=out]'), applyPlan });
  q('[data-pane=windows]').appendChild(windows.el);

  /** Switch between the "Plan a trip" ('plan') and "Launch windows" ('windows') tabs. */
  function selectTab(name) {
    if (name === activeTab) return;
    activeTab = name;
    for (const b of body.querySelectorAll('[data-tab]')) b.setAttribute('aria-selected', String(b.dataset.tab === name));
    q('[data-pane=plan]').hidden = name !== 'plan';
    q('[data-pane=windows]').hidden = name !== 'windows';
    if (name === 'windows') windows.show();
    else {
      windows.hide();
      q('[data-f=from]').appendChild(fromP.el);
      q('[data-f=to]').appendChild(toP.el);
      q('[data-f=scan]').before(q('[data-f=out]'));
    }
    compute();
  }
  q('.planner-tabs').addEventListener('click', (ev) => { const b = ev.target.closest('[data-tab]'); if (b) selectTab(b.dataset.tab); });

  // background N-body results: refresh the ballistic numbers and the scan; audits for the brachistochrone modes
  unsub = onTrajectoryUpdate(() => compute());
  compute();
  if (init.tab === 'windows') selectTab('windows');
}
