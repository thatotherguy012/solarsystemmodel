// Travel planner: brachistochrone (given accel or duration) and ballistic Lambert transfers, with a
// duration scan for cheap ballistic windows. §8.
import { GM_SUN, G0_M_S2, LIGHT_S_PER_AU, mS2ToAuDay2, auDay2ToMS2, auDayToKmS } from '../../astro/constants.js';
import { vsub, vlen, vdist } from '../../astro/vec3.js';
import { lambert } from '../../astro/lambert.js';
import { stateToElements } from '../../astro/kepler.js';
import { formatJd, parseDateToJd } from '../../astro/time.js';
import { brachistochroneTime } from '../../astro/lambert.js';
import { store } from '../../sim/store.js';
import { positionOf, velocityOf, nameOf, solveBrachistochroneTime } from '../../sim/custom.js';
import { openModal, h } from '../modal.js';
import { refPicker } from '../components.js';
import { fmtDist, fmtKmS, fmtSpeedKmS, fmtG, fmtDuration, fmtLightTime, fmtAu, fmtMS2, esc } from '../format.js';

const SCAN_DAYS = [60, 90, 120, 150, 180, 210, 240, 300, 365, 450, 550, 730, 900, 1096];

/**
 * @param {Object} app
 * @param {{from?:string, to?:string}} [init]
 */
export function openPlanner(app, init = {}) {
  const s0 = store.get();
  const state = {
    from: init.from && init.from !== init.to ? init.from : 'earth',
    to: init.to ?? (init.from === 'mars' ? 'earth' : 'mars'),
    departStr: formatJd(s0.jd).replace(' UTC', ''),
    mode: 'accel', accelG: '0.3', durationDays: '120',
  };
  if (state.from === state.to) state.to = state.from === 'earth' ? 'mars' : 'earth';

  const body = h(`<div class="planner">
    <div class="form-grid">
      <div class="field"><span class="field-label">From</span><div data-f="from"></div></div>
      <div class="field"><span class="field-label">To</span><div data-f="to"></div></div>
      <label>Departure (UTC)<div class="inline"><input data-k="departStr" class="mono"><button type="button" class="btn small" data-f="nowbtn" title="Use the current simulation time">Sim time</button></div></label>
      <label>Mode<select data-k="mode">
        <option value="accel">Brachistochrone — given acceleration</option>
        <option value="duration">Brachistochrone — given duration</option>
        <option value="ballistic">Ballistic (Lambert) — given duration</option>
      </select></label>
      <label data-f="accelWrap">Acceleration (g)<input data-k="accelG" class="mono" inputmode="decimal"></label>
      <label data-f="durWrap">Duration (days)<input data-k="durationDays" class="mono" inputmode="decimal"></label>
    </div>
    <div class="planner-out" data-f="out" aria-live="polite"></div>
    <div data-f="scan"></div>
  </div>`);
  const foot = h(`<div class="btn-row"><span class="muted small">Brachistochrone ignores solar gravity; ballistic ignores planetary gravity (no capture burns).</span><span class="spacer"></span>
    <button class="btn" data-a="close">Close</button><button class="btn primary" data-a="create">Create ship from this plan</button></div>`);
  const modal = openModal({ title: 'Travel planner', body, footer: foot, wide: true });
  const q = (sel) => body.querySelector(sel);

  const fromP = refPicker({ value: state.from, ariaLabel: 'From', onChange: (v) => { state.from = v; compute(); } });
  const toP = refPicker({ value: state.to, ariaLabel: 'To', onChange: (v) => { state.to = v; compute(); } });
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

  function compute() {
    const out = q('[data-f=out]'), scan = q('[data-f=scan]');
    q('[data-f=accelWrap]').hidden = state.mode !== 'accel';
    q('[data-f=durWrap]').hidden = state.mode === 'accel';
    plan = null;
    foot.querySelector('[data-a=create]').disabled = true;
    const ctx = store.get().ctx;
    const t0 = parseDateToJd(state.departStr);
    const errs = [];
    if (!Number.isFinite(t0)) errs.push('Departure is not a valid date (YYYY-MM-DD HH:MM).');
    if (!state.from || !state.to) errs.push('Choose both endpoints.');
    if (state.from && state.from === state.to) errs.push('From and To must differ.');
    if (errs.length) { out.innerHTML = errs.map((e) => `<div class="msg err">✕ ${esc(e)}</div>`).join(''); scan.innerHTML = ''; return; }
    const P0 = positionOf(state.from, t0, ctx);
    const D0 = vdist(positionOf(state.to, t0, ctx), P0);
    let html = `<dl class="kv wide">
      ${row('Straight-line distance at departure', `${fmtDist(D0)}`)}
      ${row('One-way light time at departure', `${fmtLightTime(D0 * LIGHT_S_PER_AU)} <span class="muted">(round trip ${fmtLightTime(2 * D0 * LIGHT_S_PER_AU)})</span>`)}`;
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
      html += row('Δv (accelerate + decelerate)', fmtKmS(a * T));
      html += row('Naive time from departure distance', `<span class="muted">${fmtDuration(brachistochroneTime(D0, a))}</span>`);
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
        html += row('Δv (accelerate + decelerate)', fmtKmS(4 * D / T));
        plan = { profile: 'brachistochrone', accelG: auDay2ToMS2(a) / G0_M_S2, t0, t1: t0 + T, solved: false };
      } else {
        const res = ballistic(state.from, state.to, t0, T, ctx);
        if (!res) html += `</dl><div class="msg warn">⚠ No ballistic (single-revolution Lambert) solution for this geometry and duration.</div><dl class="kv wide">`;
        else {
          html += row('Departure excess speed v∞', `<b>${fmtSpeedKmS(res.vinfDep)}</b>`);
          html += row('Arrival excess speed v∞', `<b>${fmtSpeedKmS(res.vinfArr)}</b>`);
          html += row('Total excess Δv', fmtSpeedKmS(res.vinfDep + res.vinfArr));
          html += row('Transfer orbit', `a ${fmtAu(res.a)} · e ${res.e.toFixed(4)}${res.e >= 1 ? ' (hyperbolic)' : ''}`);
          html += row('Perihelion distance', fmtAu(res.rp));
          if (res.e < 1) html += row('Aphelion distance', fmtAu(res.ra));
          plan = { profile: 'ballistic', t0, t1: t0 + T };
        }
      }
    }
    html += '</dl>';
    out.innerHTML = html;
    foot.querySelector('[data-a=create]').disabled = !plan;

    if (state.mode === 'ballistic') {
      let rows = '', best = null;
      const results = SCAN_DAYS.map((days) => ({ days, r: ballistic(state.from, state.to, t0, days, ctx) }));
      for (const x of results) if (x.r && (!best || x.r.vinfDep + x.r.vinfArr < best.r.vinfDep + best.r.vinfArr)) best = x;
      for (const x of results) {
        const tot = x.r ? x.r.vinfDep + x.r.vinfArr : NaN;
        rows += `<tr data-days="${x.days}" class="${x === best ? 'best' : ''}"><td>${fmtDuration(x.days)}</td><td class="mono">${formatJd(t0 + x.days, { time: false })}</td>
          <td class="num">${x.r ? fmtSpeedKmS(x.r.vinfDep) : '—'}</td><td class="num">${x.r ? fmtSpeedKmS(x.r.vinfArr) : '—'}</td><td class="num"><b>${x.r ? fmtSpeedKmS(tot) : 'no solution'}</b></td></tr>`;
      }
      scan.innerHTML = `<div class="section-title">Duration scan (departing ${formatJd(t0, { time: false })}) — click a row to use it</div>
        <table class="scan-table"><thead><tr><th>Duration</th><th>Arrival</th><th class="num">Dep. v∞</th><th class="num">Arr. v∞</th><th class="num">Total</th></tr></thead><tbody>${rows}</tbody></table>`;
    } else scan.innerHTML = '';
  }

  function ballistic(from, to, t0, T, ctx) {
    const P0 = positionOf(from, t0, ctx), P1 = positionOf(to, t0 + T, ctx);
    const sol = lambert(P0, P1, T, GM_SUN, true);
    if (!sol.ok) return null;
    const v0 = velocityOf(from, t0, ctx), v1 = velocityOf(to, t0 + T, ctx);
    const el = stateToElements(P0, sol.v1, GM_SUN, t0);
    return {
      vinfDep: auDayToKmS(vlen(vsub(sol.v1, v0))), vinfArr: auDayToKmS(vlen(vsub(sol.v2, v1))),
      a: el.a, e: el.e, rp: el.rp, ra: el.ra,
    };
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
    const prefill = {
      name: `${fromName}–${toName} ship`, type: 'ship', kind: 'route',
      route: {
        profile: plan.profile,
        accelG: plan.profile === 'brachistochrone' ? String(+plan.accelG.toPrecision(4)) : '',
        stops: [
          { ref: state.from, x: '', y: '', z: '', arriveStr: '', departStr: jdStr(plan.t0) },
          { ref: state.to, x: '', y: '', z: '', arriveStr: plan.solved ? '' : jdStr(plan.t1), departStr: '' },
        ],
      },
    };
    modal.close();
    app.openEditor(null, prefill);
  });

  compute();
}
