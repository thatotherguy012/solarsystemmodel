// "Set course…": the detailed leg editor for one ship, starting from where it is at the current simulation time.
// Destination (body, ship, station or a point), rendezvous or intercept, torch (by acceleration, or by arrival date
// via solveRendezvousForTime) or a ballistic coast (duration chosen from a scan, or typed). A live preview path is
// drawn in the 3D view; Apply truncates the route at the current time exactly like the command bar (with Undo).
import { parseDateToJd } from '../../astro/time.js';
import { store } from '../../sim/store.js';
import { driveOf, nameOf, DEFAULT_ACCEL_G } from '../../sim/custom.js';
import { planCourse } from '../../sim/commands.js';
import { openModal, h } from '../modal.js';
import { refPicker, FIXED_REF } from '../components.js';
import { applyMotions, planText } from '../commandBar.js';
import { statusOf, whenText } from '../status.js';
import { fmtKmS, fmtDuration, fmtG, esc } from '../format.js';

/**
 * @param {Object} app
 * @param {string} id ship id
 */
export function openSetCourse(app, id) {
  const s0 = store.get();
  const obj = s0.ctx.byId.get(id);
  if (!obj) return;
  const drive = driveOf(obj) ?? { kind: 'torch', accelG: DEFAULT_ACCEL_G };
  const st = {
    target: obj.motion?.kind === 'route' ? (obj.motion.stops[obj.motion.stops.length - 1]?.ref ?? 'mars') : 'mars',
    x: '', y: '', z: '0', mode: 'rendezvous', propulsion: drive.kind === 'coast' ? 'coast' : 'torch', method: 'accel',
    accelG: String(drive.kind === 'torch' ? +drive.accelG.toPrecision(4) : DEFAULT_ACCEL_G), arriveStr: '', durationStr: '',
  };
  if (st.target === id) st.target = 'mars';

  const body = h(`<div class="set-course">
    <p class="status-line"><b>${esc(obj.name)}</b> — ${esc(statusOf(id, s0.jd, s0.ctx).text)}</p>
    <p class="muted small">The new course starts now (${esc(whenText(s0.jd, s0.jd + 10))}, the current simulation time) from the ship's actual position and velocity. Everything before stays as it was.</p>
    <div class="form-grid">
      <div class="field"><span class="field-label">Destination</span><div data-f="target"></div>
        <div class="xyz" data-f="xyz" hidden><input data-k="x" placeholder="x AU" class="mono"><input data-k="y" placeholder="y AU" class="mono"><input data-k="z" placeholder="z AU" class="mono"></div></div>
      <div class="field"><span class="field-label">Arrival</span>
        <label class="check"><input type="radio" name="mode" value="rendezvous"> Rendezvous — arrive matching its speed</label>
        <label class="check"><input type="radio" name="mode" value="intercept"> Intercept — reach it fast, fly through</label></div>
      <div class="field"><span class="field-label">Propulsion</span>
        <label class="check"><input type="radio" name="prop" value="torch"> Torch (constant thrust, flip and burn)</label>
        <label class="check"><input type="radio" name="prop" value="coast"> Coast (one burn now, ballistic transfer)</label></div>
      <div class="field" data-f="torchOpts"><span class="field-label">Torch</span>
        <label class="check"><input type="radio" name="method" value="accel"> Acceleration <input data-k="accelG" class="mono short" inputmode="decimal"> g</label>
        <label class="check"><input type="radio" name="method" value="arrive"> Arrive by <input data-k="arriveStr" class="mono" placeholder="YYYY-MM-DD HH:MM"></label></div>
      <label data-f="coastOpts">Transfer duration (days) <span class="muted">— blank = cheapest of the scan</span><input data-k="durationStr" class="mono" inputmode="decimal" placeholder="auto"></label>
    </div>
    <div class="summary" data-f="out" aria-live="polite"></div>
    <div data-f="scan"></div>
  </div>`);
  const foot = h(`<div class="btn-row"><span class="muted small">The preview is the gravity-free (torch) or two-body (coast) solution; Apply refines it under the Sun's and planets' gravity.</span><span class="spacer"></span>
    <button class="btn" data-a="cancel">Cancel</button><button class="btn primary" data-a="apply">Set course</button></div>`);
  const modal = openModal({ title: `Set course — ${obj.name}`, body, footer: foot, wide: true, onClose: () => app.view.setPreview(null) });
  const q = (sel) => body.querySelector(sel);

  const picker = refPicker({ value: st.target, excludeId: id, allowFixed: true, ariaLabel: 'Destination', onChange: (v) => { st.target = v; q('[data-f=xyz]').hidden = v !== FIXED_REF; recompute(); } });
  q('[data-f=target]').appendChild(picker.el);
  for (const inp of body.querySelectorAll('[data-k]')) {
    inp.value = st[inp.dataset.k];
    inp.addEventListener('input', () => { st[inp.dataset.k] = inp.value; recompute(); });
  }
  const radios = (name, key) => {
    for (const r of body.querySelectorAll(`input[name=${name}]`)) {
      r.checked = r.value === st[key];
      r.addEventListener('change', () => { if (r.checked) { st[key] = r.value; recompute(); } });
    }
  };
  radios('mode', 'mode');
  radios('prop', 'propulsion');
  radios('method', 'method');

  let plan = null;
  let timer = null;
  function recompute() { clearTimeout(timer); timer = setTimeout(compute, 120); }

  function compute() {
    const s = store.get();
    const o = s.ctx.byId.get(id);
    const out = q('[data-f=out]'), scanEl = q('[data-f=scan]');
    q('[data-f=torchOpts]').hidden = st.propulsion !== 'torch';
    q('[data-f=coastOpts]').hidden = st.propulsion !== 'coast';
    plan = null;
    foot.querySelector('[data-a=apply]').disabled = true;
    const errs = [];
    let target;
    if (st.target === FIXED_REF) {
      const v = [st.x, st.y, st.z].map(Number);
      if (!v.every(Number.isFinite) || st.x.trim() === '' || st.y.trim() === '') errs.push('A point needs numeric x, y (and z) in AU.');
      target = { point: v };
    } else target = { ref: st.target };
    const opts = { mode: st.mode };
    if (st.propulsion === 'torch') {
      const g = Number(st.accelG);
      opts.drive = { kind: 'torch', accelG: g > 0 ? g : DEFAULT_ACCEL_G };
      if (st.method === 'arrive') {
        const jd = parseDateToJd(st.arriveStr);
        if (!Number.isFinite(jd)) errs.push('Arrive by: enter a date (YYYY-MM-DD HH:MM, UTC).');
        else if (st.mode === 'intercept') errs.push('Arrive-by is solved for rendezvous; for an intercept the arrival follows from the acceleration.');
        else opts.arriveByJd = jd;
      } else if (!(g > 0)) errs.push('Acceleration must be a positive number of g.');
    } else {
      opts.drive = { kind: 'coast' };
      if (st.durationStr.trim() !== '') {
        const d = Number(st.durationStr);
        if (!(d > 0)) errs.push('Duration must be a positive number of days.');
        else opts.durationDays = d;
      }
    }
    if (errs.length) { out.innerHTML = errs.map((e) => `<div class="msg err">✕ ${esc(e)}</div>`).join(''); scanEl.innerHTML = ''; app.view.setPreview(null); return; }
    let p;
    try { p = planCourse(o, target, opts, s.jd, s.ctx); } catch (err) { p = { ok: false, reason: String(err?.message ?? err) }; }
    if (!p.ok) { out.innerHTML = `<div class="msg err">✕ ${esc(p.reason)}</div>`; scanEl.innerHTML = ''; app.view.setPreview(null); return; }
    plan = p;
    foot.querySelector('[data-a=apply]').disabled = false;
    app.view.setPreview({ paths: [{ points: p.preview, color: '#ffd166' }], marker: target.point ?? null });
    const rows = [];
    const row = (k, v) => rows.push(`<dt>${k}</dt><dd>${v}</dd>`);
    row('Destination', esc(p.targetName));
    row('Arrives', `${esc(whenText(p.arriveJd, s.jd))} <span class="muted">(in ${fmtDuration(p.T)})</span>`);
    if (p.kind === 'torch') {
      row('Acceleration', `${fmtG(p.accelG)}${opts.arriveByJd != null ? ' <span class="muted">(solved for the arrival date)</span>' : ''}`);
      if (p.flipJd != null) row('Flip', `${esc(whenText(p.flipJd, s.jd))} <span class="muted">(in ${fmtDuration(p.flipJd - s.jd)})</span>`);
      row('Peak speed', fmtKmS(p.peakSpeed));
      row('delta-v (Δv)', fmtKmS(p.deltaV));
      if (p.closingSpeed != null) row('Closing speed at arrival', `<b>${fmtKmS(p.closingSpeed)}</b>`);
      row('Speed now', fmtKmS(p.startSpeed));
    } else {
      row('Burn now', `<b>${fmtKmS(p.burnNow)}</b> <span class="muted">${p.depBurnKind === 'park' ? '(from a parking orbit)' : '(velocity change)'}</span>`);
      if (p.mode === 'intercept') row('Closing speed at arrival', fmtKmS(p.closingSpeed));
      else row('Arrival burn', fmtKmS(p.arrivalBurn));
      row('Hohmann-like time', `<span class="muted">${fmtDuration(p.hohmannDays)}</span>`);
    }
    out.innerHTML = `<dl class="kv">${rows.join('')}</dl><div class="muted small">${esc(planText(p, s.jd))}</div>`;
    if (p.kind === 'coast' && p.scan) {
      const best = p.scan.filter((x) => x.ok).reduce((a, b) => (!a || b.cost < a.cost ? b : a), null);
      scanEl.innerHTML = `<div class="section-title">Duration scan — click a row to use it</div>
        <table class="scan-table"><thead><tr><th>Duration</th><th>Arrival</th><th class="num">Burn now</th><th class="num">${p.mode === 'intercept' ? 'Closing speed' : 'Arrival burn'}</th><th class="num">Total</th></tr></thead><tbody>
        ${p.scan.map((x) => `<tr data-days="${x.T.toFixed(2)}" class="${x === best ? 'best' : ''}"><td>${fmtDuration(x.T)}</td><td class="mono">${esc(whenText(s.jd + x.T, s.jd + 100))}</td>
          <td class="num">${x.ok ? fmtKmS(x.burnNow) : '—'}</td><td class="num">${x.ok ? fmtKmS(p.mode === 'intercept' ? x.closing : x.arrivalBurn) : '—'}</td><td class="num"><b>${x.ok ? fmtKmS(x.cost) : 'no solution'}</b></td></tr>`).join('')}
        </tbody></table>`;
    } else scanEl.innerHTML = '';
  }

  q('[data-f=scan]').addEventListener('click', (ev) => {
    const tr = ev.target.closest('tr[data-days]');
    if (!tr) return;
    st.durationStr = tr.dataset.days;
    q('[data-k=durationStr]').value = st.durationStr;
    compute();
  });
  foot.querySelector('[data-a=cancel]').addEventListener('click', () => modal.close());
  foot.querySelector('[data-a=apply]').addEventListener('click', () => {
    if (!plan) return;
    const s = store.get();
    const motion = plan.apply(true);
    const eta = motion.stops[motion.stops.length - 1].arriveJd;
    modal.close();
    applyMotions(app, [{ id, motion }], `Course set: ${plan.targetName}, ETA ${whenText(eta, s.jd)}`);
  });
  compute();
}
