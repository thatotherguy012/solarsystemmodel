// "Launch windows" tab of the travel planner (src/ui/modals/planner.js):
//  1. a ballistic porkchop plot (two-body Lambert over departure date x flight time, computed in time slices with a
//     progress bar and Cancel), a metric selector, hover read-out, click-to-select (the planner then evaluates that
//     one case with its N-body targeted solution and the usual "Create ship from this plan" flow), and a list of the
//     next launch windows (one per synodic period) with Jump-to-date / Use buttons;
//  2. a torch-ship curve: constant-thrust rendezvous / intercept trip time and peak speed against departure date;
//  3. a plain-language explanation of both.
// The tab shares the planner's From/To pickers, plan state and result block through the `planner` handle.
import { G0_M_S2, mS2ToAuDay2, auDayToKmS } from '../../astro/constants.js';
import { formatJd, parseDateToJd } from '../../astro/time.js';
import { store } from '../../sim/store.js';
import { nameOf } from '../../sim/custom.js';
import {
  PORKCHOP_DEFAULTS, SPAN_CHOICES, RESOLUTION_CHOICES, METRICS, computePorkchopChunked, metricGrid, gridMinimum,
  burnsFor, cellDetails, transferCost, transferDetailsAt, refineMinimum, porkchopBox, porkchopStep, findWindows,
  columnMinima, synodicPeriod, heliocentricRoot, porkchopParamErrors, computeTorchCurveChunked,
} from '../../sim/porkchop.js';
import { createPorkchopChart, createLineChart } from '../porkchop.js';
import { h } from '../modal.js';
import { fmtDuration, fmtSpeedKmS, fmtNum, esc } from '../format.js';

/** Settings remembered between planner openings (not persisted). */
const memory = {
  span: String(PORKCHOP_DEFAULTS.spanDays), tofMin: String(PORKCHOP_DEFAULTS.tofMin), tofMax: String(PORKCHOP_DEFAULTS.tofMax),
  res: `${PORKCHOP_DEFAULTS.nx}x${PORKCHOP_DEFAULTS.ny}`, metric: 'total', torchG: '0.3', torchMode: 'rendezvous', torchStep: '',
};

const day = (jd) => formatJd(jd, { time: false });
const kms = (v) => fmtSpeedKmS(v);
const days = (T) => `${fmtNum(T, T < 10 ? 2 : 0)} d`;
/** Parking altitude from a field: number, null (blank = default) or NaN (invalid). */
const parkVal = (str) => (String(str ?? '').trim() === '' ? null : Number(str) >= 0 ? Number(str) : NaN);
const roundHour = (jd) => Math.round((jd - 0.5) * 24) / 24 + 0.5;
const roundDay = (jd) => Math.round(jd - 0.5) + 0.5;
const jdStr = (jd) => formatJd(jd).replace(' UTC', '');

/**
 * @param {Object} app
 * @param {{state:Object, fromPicker:{el:HTMLElement}, toPicker:{el:HTMLElement}, outEl:HTMLElement,
 *   applyPlan:(patch:Object)=>void}} planner
 * @returns {{el:HTMLElement, show:()=>void, hide:()=>void, inputsChanged:()=>void, hasSelection:()=>boolean,
 *   destroy:()=>void}}
 */
export function createLaunchWindowsTab(app, planner) {
  const { state } = planner;
  const ui = { ...memory, startStr: day(store.get().jd) };
  const spanOpts = SPAN_CHOICES.map(([d, l]) => `<option value="${d}">${l}</option>`).join('');
  const resOpts = RESOLUTION_CHOICES.map(([nx, ny]) => `<option value="${nx}x${ny}">${nx} × ${ny}${nx === PORKCHOP_DEFAULTS.nx && ny === PORKCHOP_DEFAULTS.ny ? ' (default)' : ''}</option>`).join('');
  const metricOpts = Object.entries(METRICS).map(([k, m]) => `<option value="${k}">${m.label}</option>`).join('');

  const el = h(`<div class="lw">
    <div class="form-grid">
      <div class="field"><span class="field-label">From</span><div data-slot="from"></div></div>
      <div class="field"><span class="field-label">To</span><div data-slot="to"></div></div>
      <label>Departures from (UTC)<div class="inline"><input data-w="startStr" class="mono" spellcheck="false"><button type="button" class="btn small" data-a="simtime" title="Start the departure window at the current simulation date">Sim time</button></div></label>
      <label>Departure span<select data-w="span">${spanOpts}</select></label>
      <label title="Shortest and longest flight time plotted">Flight time (days)<div class="inline lw-range"><input data-w="tofMin" class="mono" inputmode="decimal" aria-label="Shortest flight time (days)"><span class="muted">to</span><input data-w="tofMax" class="mono" inputmode="decimal" aria-label="Longest flight time (days)"></div></label>
      <label>Grid (departures × flight times)<select data-w="res">${resOpts}</select></label>
      <label title="Circular parking orbit the departure burn starts from (blank = default for the body; shared with the Plan tab)">Departure parking altitude (km)<input data-w="depPark" class="mono" inputmode="decimal"></label>
      <label title="Circular orbit the capture burn ends in (blank = default for the body; shared with the Plan tab)">Arrival parking altitude (km)<input data-w="arrPark" class="mono" inputmode="decimal"></label>
    </div>
    <details class="lw-help">
      <summary>What is this plot? (launch windows in plain language)</summary>
      <p>Each point of the <b>porkchop plot</b> is one possible coasting trip: leave on the date along the bottom, fall
      freely around the Sun for the flight time on the left, and arrive. Its colour is what the trip costs, <b>dark = cheap</b>.
      The cost is the total Δv: the burn that throws the ship out of a circular parking orbit at the start, plus the burn
      that captures it into a parking orbit at the destination (v∞ is the leftover speed relative to a planet once far from it).</p>
      <p>Cheap trips bunch up into dark islands, the <b>launch windows</b>. They come back every <b>synodic period</b>, the
      time the two planets take to return to the same positions relative to each other: about every 26 months for Earth and
      Mars, about every 13 months for Earth and Jupiter (Jupiter moves so slowly that Earth laps it every year and a month).
      Between windows a coasting ship either waits or pays far more. A window usually has two lobes: short trips that go
      less than halfway round the Sun and long trips that go more than halfway. Trips of almost exactly half an orbit
      (180°) are left grey: their path's plane is undefined and they would need a huge plane change.</p>
      <p><b>Speed versus accuracy:</b> to compute thousands of trips in a moment the plot uses two-body transfers (the Sun's
      gravity only). When you click a point, that one trip is refined with the full model (the Sun and all eight planets,
      targeted to arrive on time), so the selected numbers can differ slightly from the colour under the cursor.</p>
      <p><b>Torch ships</b> (constant thrust) hardly care: they cross the inner solar system in days, so the planets barely
      move during the trip and nothing needs to line up. The second chart shows how little their trip time changes.</p>
    </details>

    <div class="section-title">Ballistic transfers (coasting ships)</div>
    <div class="lw-toolbar">
      <label class="lw-metric">Colour by <select data-w="metric">${metricOpts}</select></label>
      <span class="lw-best" data-f="pcBest" aria-live="polite"></span>
      <span class="spacer"></span>
      <div class="lw-progress" data-f="pcProg" hidden><div></div></div>
      <span class="lw-status muted small" data-f="pcStatus" aria-live="polite"></span>
      <button type="button" class="btn small" data-a="pcCancel" hidden>Cancel</button>
      <button type="button" class="btn small" data-a="pcRun" title="Compute the plot again">Recompute</button>
    </div>
    <div data-f="pcMsgs"></div>
    <div data-f="pcChart"></div>
    <div class="lw-readout" data-f="pcReadout"></div>
    <div class="lw-sel" data-slot="selPc"></div>

    <div class="section-title">Next windows <span class="lw-sub" data-f="synodic"></span></div>
    <div data-f="windows"></div>

    <div class="section-title">Torch ships (constant thrust)</div>
    <div class="form-grid">
      <label>Acceleration (g)<input data-w="torchG" class="mono" inputmode="decimal"></label>
      <label>Arrival<select data-w="torchMode">
        <option value="rendezvous">Rendezvous: flip and brake to match the target</option>
        <option value="intercept">Intercept: burn all the way, arrive at speed</option>
      </select></label>
      <label title="Spacing of the sampled departure dates (blank = automatic)">Sample every (days)<input data-w="torchStep" class="mono" inputmode="decimal"></label>
    </div>
    <p class="lw-oneliner" data-f="torchNote"></p>
    <div class="lw-toolbar">
      <span class="spacer"></span>
      <div class="lw-progress" data-f="tcProg" hidden><div></div></div>
      <span class="lw-status muted small" data-f="tcStatus" aria-live="polite"></span>
      <button type="button" class="btn small" data-a="tcCancel" hidden>Cancel</button>
    </div>
    <div data-f="tcMsgs"></div>
    <div data-f="tcChart"></div>
    <div class="lw-readout" data-f="tcReadout"></div>
    <div class="lw-sel" data-slot="selTorch"></div>
  </div>`);
  const q = (s) => el.querySelector(s);

  // ------------------------------------------------------------------ widgets
  const pcChart = createPorkchopChart({ height: 380, onHover: renderPcReadout, onClick: (c) => clickCell(c) });
  q('[data-f=pcChart]').appendChild(pcChart.el);
  const tcChart = createLineChart({ height: 220, onHover: renderTcReadout, onClick: (k) => selectTorch(k) });
  q('[data-f=tcChart]').appendChild(tcChart.el);

  // inputs
  const inputs = {};
  for (const inp of el.querySelectorAll('[data-w]')) {
    inputs[inp.dataset.w] = inp;
    const k = inp.dataset.w;
    if (k === 'depPark' || k === 'arrPark') continue;
    inp.value = ui[k];
    inp.addEventListener(inp.tagName === 'SELECT' ? 'change' : 'input', () => {
      ui[k] = inp.value;
      if (k in memory) memory[k] = inp.value;
      if (k === 'metric') { deriveFromResult(); return; }
      if (k.startsWith('torch')) { scheduleTorch(); return; }
      schedulePorkchop();
      scheduleTorch();
    });
  }
  const syncParkInputs = () => { inputs.depPark.value = state.depParkStr; inputs.arrPark.value = state.arrParkStr; renderParkPlaceholders(); };
  for (const [k, key] of [['depPark', 'depParkStr'], ['arrPark', 'arrParkStr']]) {
    inputs[k].addEventListener('input', () => {
      const v = inputs[k].value;
      inputs[k].classList.toggle('invalid', Number.isNaN(parkVal(v)));
      planner.applyPlan({ [key]: v });
      // burns only: no Lambert recomputation unless the plot is missing or an altitude is invalid (error shown)
      if (!pcRes || Number.isNaN(parkVal(state.depParkStr)) || Number.isNaN(parkVal(state.arrParkStr))) schedulePorkchop(250);
      else deriveFromResult();
    });
  }
  function renderParkPlaceholders() {
    const b = safeBurns();
    if (!b) return;
    const ph = (burn) => (burn.kind === 'park' ? `default ${+burn.g.parkAltKm.toFixed(1)} (${nameOf(burn.g.bodyId, ctx())})` : 'n/a (no parking orbit)');
    const dflt = burnsFor(state.from, state.to, null, null, ctx());
    inputs.depPark.placeholder = ph(dflt.dep);
    inputs.arrPark.placeholder = ph(dflt.arr);
  }

  el.addEventListener('click', (ev) => {
    const a = ev.target.closest('[data-a]')?.dataset.a;
    if (!a) return;
    if (a === 'simtime') { ui.startStr = day(store.get().jd); inputs.startStr.value = ui.startStr; runPorkchop(); runTorch(); }
    else if (a === 'pcRun') runPorkchop();
    else if (a === 'pcCancel') cancelPorkchop(true);
    else if (a === 'tcCancel') cancelTorch(true);
    else if (a === 'jump' || a === 'use') {
      const w = wins[Number(ev.target.closest('[data-n]')?.dataset.n)];
      if (!w) return;
      if (a === 'jump') { store.set({ jd: w.t }); app.toast(`Jumped to the launch window: ${day(w.t)}`); }
      else selectBallistic(w.t, w.T, 'window');
    } else if (a === 'jumpSel' && sel) { store.set({ jd: sel.t }); app.toast(`Jumped to ${jdStr(sel.t)} UTC`); }
  });

  // ------------------------------------------------------------------ state
  const ctx = () => store.get().ctx;
  let pcJob = null, pcRes = null, values = null, burns = null, best = null, wins = [], synodic = Infinity;
  let tcJob = null, tcRes = null;
  let sel = null; // { kind:'ballistic'|'torch', t, T, departStr, durationDays?, accelG?, k?, src? }
  let visible = false, pcDirty = true, tcDirty = true;
  let pcTimer = null, tcTimer = null;

  function safeBurns() {
    if (!state.from || !state.to) return null;
    const pd = parkVal(state.depParkStr), pa = parkVal(state.arrParkStr);
    return burnsFor(state.from, state.to, Number.isNaN(pd) ? null : pd, Number.isNaN(pa) ? null : pa, ctx());
  }

  function params() {
    const [nx, ny] = ui.res.split('x').map(Number);
    return { t0: parseDateToJd(ui.startStr), spanDays: Number(ui.span), tofMin: parseFloat(ui.tofMin), tofMax: parseFloat(ui.tofMax), nx, ny };
  }

  function endpointErrors() {
    const errs = [];
    if (!state.from || !state.to) errs.push('Choose both endpoints.');
    else if (state.from === state.to) errs.push('From and To must differ.');
    return errs;
  }

  // ------------------------------------------------------------------ porkchop computation
  function schedulePorkchop(delay = 450) {
    pcDirty = true;
    clearTimeout(pcTimer);
    if (visible) pcTimer = setTimeout(runPorkchop, delay);
  }

  function cancelPorkchop(byUser = false) {
    clearTimeout(pcTimer);
    if (!pcJob) return;
    const job = pcJob;
    pcJob = null;
    job.cancel();
    showProgress('pc', null);
    if (byUser && pcRes && !pcRes.complete) {
      const pct = Math.round((100 * pcRes.columnsDone) / pcRes.nx);
      q('[data-f=pcStatus]').textContent = `Cancelled at ${pct}% — partial plot shown (Recompute to finish)`;
      deriveFromResult();
    }
  }

  function runPorkchop() {
    clearTimeout(pcTimer);
    cancelPorkchop();
    pcDirty = false;
    const p = params();
    const errs = [...endpointErrors(), ...porkchopParamErrors(p)];
    const pd = parkVal(state.depParkStr), pa = parkVal(state.arrParkStr);
    if (Number.isNaN(pd) || Number.isNaN(pa)) errs.push('Parking altitudes must be non-negative numbers of km (or blank for the default).');
    const msgs = q('[data-f=pcMsgs]');
    if (errs.length) {
      msgs.innerHTML = errs.map((e) => `<div class="msg err">✕ ${esc(e)}</div>`).join('');
      pcRes = null; values = null; best = null; wins = [];
      pcChart.setData(null); pcChart.setBest(null); pcChart.setWindows([]);
      q('[data-f=pcStatus]').textContent = '';
      q('[data-f=pcBest]').textContent = '';
      renderWindows(); renderTorchNote();
      return;
    }
    msgs.innerHTML = endpointNotes(p);
    synodic = synodicPeriod(state.from, state.to, ctx(), p.t0);
    renderParkPlaceholders();
    best = null; wins = [];
    q('[data-f=pcBest]').textContent = '';
    pcChart.setBest(null); pcChart.setWindows([]);
    q('[data-f=pcStatus]').textContent = 'Computing…';
    showProgress('pc', 0);
    let lastDraw = 0;
    pcJob = computePorkchopChunked(p, state.from, state.to, ctx(), {
      onProgress: (res, done, total) => {
        showProgress('pc', done / total);
        const t = performance.now();
        if (done < total && t - lastDraw > 60) { lastDraw = t; drawPartial(res); }
      },
      onDone: (res) => {
        pcJob = null;
        showProgress('pc', null);
        q('[data-f=pcStatus]').textContent = `${fmtNum(res.nx * res.ny, 0)} transfers in ${fmtNum(res.ms, 0)} ms`;
        deriveFromResult();
        renderTorchNote();
      },
    });
    pcRes = pcJob.result;
    drawPartial(pcRes);
  }

  /** Progressive draw while computing (colour scale of what is known so far). */
  function drawPartial(res) {
    burns = safeBurns();
    values = metricGrid(res, ui.metric, burns);
    pcChart.setData(chartData(res));
  }

  const chartData = (res) => ({ dep: res.dep, tof: res.tof, nx: res.nx, ny: res.ny, values, colsDone: res.columnsDone, unit: 'km/s' });

  /** Metric values, the refined minimum and the windows from the current result (no Lambert recomputation). */
  function deriveFromResult() {
    if (!pcRes) { renderWindows(); return; }
    burns = safeBurns();
    if (!burns) return;
    values = metricGrid(pcRes, ui.metric, burns);
    pcChart.setData(chartData(pcRes));
    const m = gridMinimum(values, pcRes.ny);
    const box = porkchopBox(pcRes), st = porkchopStep(pcRes);
    best = null;
    if (m) {
      const cost = transferCost(state.from, state.to, ctx(), burns, ui.metric);
      const r = refineMinimum(cost, pcRes.dep[m.i], pcRes.tof[m.j], { ...st, box }) ?? { t: pcRes.dep[m.i], T: pcRes.tof[m.j], value: m.value };
      best = r;
      const text = `${pcRes.complete ? 'best' : 'best so far'}: ${day(r.t)}, ${Math.round(r.T)} d, ${kms(r.value)}`;
      pcChart.setBest({ t: r.t, T: r.T, text });
      q('[data-f=pcBest]').innerHTML = `${pcRes.complete ? 'Best' : 'Best so far'} ${esc(METRICS[ui.metric]?.short ?? '')}: <b>${kms(r.value)}</b> — depart ${day(r.t)}, ${Math.round(r.T)} d`;
    } else { pcChart.setBest(null); q('[data-f=pcBest]').textContent = ''; }
    // launch windows always rank the total Δv
    const total = ui.metric === 'total' ? values : metricGrid(pcRes, 'total', burns);
    const costT = transferCost(state.from, state.to, ctx(), burns, 'total');
    wins = findWindows(total, pcRes, synodic).map((w) => {
      const r = refineMinimum(costT, pcRes.dep[w.i], pcRes.tof[w.j], { ...st, box }) ?? { t: pcRes.dep[w.i], T: pcRes.tof[w.j] };
      // round to whole days for a clean plan; keep inside the plotted box
      const t = Math.min(box.t1, Math.max(box.t0, roundDay(r.t))), T = Math.min(box.T1, Math.max(box.T0, Math.round(r.T)));
      const d = transferDetailsAt(state.from, state.to, ctx(), burns, t, T) ?? transferDetailsAt(state.from, state.to, ctx(), burns, r.t, r.T);
      return d ? { t: d.depJd, T: d.tof, d, edge: w.edge } : null;
    }).filter(Boolean);
    pcChart.setWindows(wins);
    if (sel?.kind === 'ballistic') pcChart.setSelected({ t: sel.t, T: sel.T });
    renderWindows();
    renderSelInfo();
    renderTorchNote();
  }

  function endpointNotes(p) {
    let html = '';
    const ra = heliocentricRoot(state.from, ctx()), rb = heliocentricRoot(state.to, ctx());
    if (ra && ra === rb && ra !== 'sun') html += `<div class="msg warn">⚠ Both endpoints travel round the Sun with ${esc(nameOf(ra, ctx()))}: a Sun-centred porkchop plot says little about trips inside one planet's system.</div>`;
    if (state.from === 'sun' || state.to === 'sun') html += '<div class="msg warn">⚠ A transfer cannot start or end at the Sun\'s centre: the plot stays blank.</div>';
    if (p.t0 < 625673.5 || p.t0 + p.spanDays > 2816787.5) html += '<div class="msg warn">⚠ Outside the planetary ephemeris range (3000 BC – 3000 AD).</div>';
    return html;
  }

  function showProgress(which, frac) {
    const bar = q(`[data-f=${which}Prog]`), btn = q(`[data-a=${which}Cancel]`);
    bar.hidden = frac == null;
    btn.hidden = frac == null;
    if (frac != null) bar.firstElementChild.style.width = `${Math.round(frac * 100)}%`;
  }

  // ------------------------------------------------------------------ read-outs, windows list, selection
  function renderPcReadout(c) {
    const box = q('[data-f=pcReadout]');
    if (!c || !pcRes || !burns) { box.innerHTML = '<span class="muted">Hover over the plot for the numbers of a transfer; click to evaluate it with the full N-body model.</span>'; return; }
    const d = cellDetails(pcRes, c.i, c.j, burns);
    const T = pcRes.tof[c.j], t = pcRes.dep[c.i];
    if (!d) { box.innerHTML = `<b>${day(t)}</b> + ${days(T)} → ${day(t + T)} · <span class="muted">no two-body solution (no Lambert solution or a transfer of ~180°)</span>`; return; }
    box.innerHTML = `Depart <b>${day(d.depJd)}</b> · arrive <b>${day(d.arrJd)}</b> · flight <b>${days(d.tof)}</b> · dep. v∞ ${kms(d.vinfDep)} · arr. v∞ ${kms(d.vinfArr)} · burns ${kms(d.depBurn)} + ${kms(d.arrBurn)} · total Δv <b>${kms(d.total)}</b>`;
  }

  function renderWindows() {
    const box = q('[data-f=windows]');
    q('[data-f=synodic]').textContent = Number.isFinite(synodic) && pcRes
      ? `— synodic period ${fmtNum(synodic, 0)} d (${(synodic / 30.4375).toFixed(1)} months): expect one window per period`
      : '';
    if (!pcRes) { box.innerHTML = ''; return; }
    if (!wins.length) { box.innerHTML = `<div class="muted small">${pcRes.complete ? 'No ballistic transfer in this range.' : 'Waiting for the plot…'}</div>`; return; }
    const ctxx = ctx();
    const rows = wins.map((w, n) => `<tr>
        <td><span class="lw-num">${n + 1}</span></td>
        <td class="mono">${day(w.t)}${w.edge ? ` <span class="badge badge-warn" title="The cheapest departure is at the ${w.edge === 'start' ? 'start' : 'end'} of the span: the window probably continues ${w.edge === 'start' ? 'before' : 'after'} it">${w.edge === 'start' ? 'span start' : 'span end'}</span>` : ''}</td>
        <td class="mono">${day(w.t + w.T)}</td><td class="num">${days(w.T)}</td>
        <td class="num">${kms(w.d.vinfDep)}</td><td class="num">${kms(w.d.vinfArr)}</td><td class="num"><b>${kms(w.d.total)}</b></td>
        <td class="row-btns" data-n="${n}"><button type="button" class="btn tiny" data-a="jump" title="Set the simulation date to this departure">Jump to date</button> <button type="button" class="btn tiny" data-a="use" title="Evaluate this transfer with the N-body model">Use</button></td></tr>`).join('');
    box.innerHTML = `<table class="lw-table"><thead><tr><th>#</th><th>Departure</th><th>Arrival</th><th class="num">Flight</th><th class="num">Dep. v∞</th><th class="num">Arr. v∞</th><th class="num">Total Δv</th><th></th></tr></thead><tbody>${rows}</tbody></table>
      <div class="muted small">Cheapest ${esc(nameOf(state.from, ctxx))} → ${esc(nameOf(state.to, ctxx))} transfer of each window (two-body, whole days). Burns from / into the parking orbits above.</div>`;
  }

  function clickCell(c) {
    if (!pcRes) return;
    const d = cellDetails(pcRes, c.i, c.j, burns);
    if (!d) { app.toast('No ballistic solution for that cell (grey): pick a coloured one.'); return; }
    selectBallistic(pcRes.dep[c.i], pcRes.tof[c.j], 'cell');
  }

  /** Select a ballistic transfer: the planner switches to its N-body ballistic mode with this departure and duration. */
  function selectBallistic(t, T, src) {
    const tR = roundHour(t), TR = Math.round(T * 10) / 10;
    const departStr = jdStr(tR), durationDays = String(TR);
    sel = { kind: 'ballistic', t: parseDateToJd(departStr), T: TR, departStr, durationDays, src };
    pcChart.setSelected({ t: sel.t, T: sel.T });
    tcChart.setSelected(null);
    placeOut();
    renderSelInfo();
    planner.applyPlan({ mode: 'ballistic', departStr, durationDays });
  }

  /** Select a torch-ship departure: the planner switches to "Brachistochrone — given acceleration". */
  function selectTorch(k) {
    const trip = tcRes?.trips[k];
    if (!trip) { app.toast('No constant-thrust solution for that date.'); return; }
    const tR = roundHour(trip.jd0);
    const departStr = jdStr(tR), accelG = String(tcRes.g);
    sel = { kind: 'torch', k, t: parseDateToJd(departStr), T: trip.T, departStr, accelG, trip };
    tcChart.setSelected(k);
    pcChart.setSelected(null);
    placeOut();
    renderSelInfo();
    planner.applyPlan({ mode: 'accel', departStr, accelG });
  }

  function clearSelection() {
    sel = null;
    pcChart.setSelected(null);
    tcChart.setSelected(null);
    placeOut();
    renderSelInfo();
  }

  /** Put the planner's result block under the chart the selection came from (hidden without a selection). */
  function placeOut() {
    if (!visible) return;
    const out = planner.outEl;
    const slot = q(sel?.kind === 'torch' ? '[data-slot=selTorch]' : '[data-slot=selPc]');
    slot.appendChild(out);
    out.hidden = !sel;
  }

  function renderSelInfo() {
    for (const s of el.querySelectorAll('.lw-selinfo')) s.remove();
    if (!sel || !visible) return;
    const info = document.createElement('div');
    info.className = 'lw-selinfo';
    const ctxx = ctx();
    const route = `${esc(nameOf(state.from, ctxx))} → ${esc(nameOf(state.to, ctxx))}`;
    if (sel.kind === 'ballistic') {
      const d = burns ? transferDetailsAt(state.from, state.to, ctxx, burns, sel.t, sel.T) : null;
      info.innerHTML = `<div class="lw-selhead"><b>Selected coasting transfer</b> ${route}: depart ${esc(sel.departStr)} UTC, ${days(sel.T)}, arrive ${day(sel.t + sel.T)}
        <button type="button" class="btn tiny" data-a="jumpSel" title="Set the simulation date to the departure">Jump to date</button></div>
        <div class="muted small">Porkchop (two-body) estimate: total Δv ${d ? kms(d.total) : '—'}${d ? ` (v∞ ${kms(d.vinfDep)} / ${kms(d.vinfArr)})` : ''}. The numbers below are the N-body refinement (Sun + 8 planets) used by ships; <b>Create ship from this plan</b> turns it into a route.</div>`;
    } else {
      const tr = sel.trip;
      const mode = tcRes?.mode === 'intercept' ? 'Intercept' : 'Rendezvous';
      info.innerHTML = `<div class="lw-selhead"><b>Selected torch departure</b> ${route} at ${esc(sel.accelG)} g: depart ${esc(sel.departStr)} UTC
        <button type="button" class="btn tiny" data-a="jumpSel" title="Set the simulation date to the departure">Jump to date</button></div>
        <div class="muted small">${mode} (gravity-free, starting with ${esc(nameOf(state.from, ctxx))}'s velocity): ${fmtDuration(tr.T)}, arrive ${jdStr(tr.arriveJd)} UTC, Δv ${kms(auDayToKmS(tr.deltaV))}, peak speed ${kms(auDayToKmS(tr.peakSpeed))}.
        A ship created from this plan flies the planner's straight-line flip-and-burn profile shown below (with its gravity audit).</div>`;
    }
    planner.outEl.before(info);
  }

  // ------------------------------------------------------------------ torch curve
  function scheduleTorch(delay = 450) {
    tcDirty = true;
    clearTimeout(tcTimer);
    if (visible) tcTimer = setTimeout(runTorch, delay);
  }

  function cancelTorch(byUser = false) {
    clearTimeout(tcTimer);
    if (!tcJob) return;
    const job = tcJob;
    tcJob = null;
    job.cancel();
    showProgress('tc', null);
    if (byUser && tcRes) { q('[data-f=tcStatus]').textContent = `Cancelled after ${tcRes.done} of ${tcRes.dates.length} departures`; drawTorch(); renderTorchNote(); }
  }

  function torchStepDays(spanDays) {
    const s = parseFloat(ui.torchStep);
    if (s > 0) return Math.max(spanDays / 3000, s);
    return Math.min(30, Math.max(1, Math.round(spanDays / 360)));
  }

  function runTorch() {
    clearTimeout(tcTimer);
    cancelTorch();
    tcDirty = false;
    const p = params();
    const g = parseFloat(ui.torchG);
    const errs = [...endpointErrors()];
    if (!Number.isFinite(p.t0)) errs.push('Departure window start is not a valid date.');
    if (!(g > 0)) errs.push('Acceleration must be a positive number of g.');
    const step = torchStepDays(p.spanDays);
    inputs.torchStep.placeholder = `auto (${step} d)`;
    const msgs = q('[data-f=tcMsgs]');
    if (errs.length) {
      msgs.innerHTML = errs.map((e) => `<div class="msg err">✕ ${esc(e)}</div>`).join('');
      tcRes = null; tcChart.setData(null); renderTorchNote(); q('[data-f=tcStatus]').textContent = '';
      return;
    }
    msgs.innerHTML = g < 0.01 ? '<div class="msg warn">⚠ Below ~0.01 g the Sun\'s gravity is comparable to the thrust; these gravity-free trip times are only indicative.</div>' : '';
    const a = mS2ToAuDay2(g * G0_M_S2);
    q('[data-f=tcStatus]').textContent = 'Computing…';
    showProgress('tc', 0);
    let lastDraw = 0;
    tcJob = computeTorchCurveChunked({ fromRef: state.from, toRef: state.to, t0: p.t0, spanDays: p.spanDays, stepDays: step, a, mode: ui.torchMode }, ctx(), {
      onProgress: (res, done, total) => {
        showProgress('tc', done / total);
        const t = performance.now();
        if (done < total && t - lastDraw > 60) { lastDraw = t; drawTorch(); }
      },
      onDone: (res) => {
        tcJob = null;
        showProgress('tc', null);
        const ok = res.trips.filter(Boolean).length;
        q('[data-f=tcStatus]').textContent = `${ok} of ${res.dates.length} departures solved in ${fmtNum(res.ms, 0)} ms`;
        drawTorch();
        renderTorchNote();
        if (sel?.kind === 'torch') tcChart.setSelected(null); // the selected index may point elsewhere now
      },
    });
    tcRes = tcJob.result;
    tcRes.g = g;
    drawTorch();
  }

  function drawTorch() {
    if (!tcRes) { tcChart.setData(null); return; }
    const T = tcRes.trips.map((x) => (x ? x.T : NaN));
    const v = tcRes.trips.map((x) => (x ? auDayToKmS(x.peakSpeed) : NaN));
    tcChart.setData({
      xs: tcRes.dates, done: tcRes.done,
      series: [
        { values: T, color: '#5aa9ff', axis: 'left', label: 'Trip time (days)', unit: 'd', width: 2 },
        { values: v, color: '#f0b44c', axis: 'right', dash: [5, 4], label: tcRes.mode === 'intercept' ? 'Arrival speed (km/s, heliocentric)' : 'Peak speed (km/s, heliocentric)', unit: 'km/s', width: 1.5 },
      ],
    });
  }

  function renderTcReadout(k) {
    const box = q('[data-f=tcReadout]');
    const tr = k != null ? tcRes?.trips[k] : null;
    if (k == null || !tcRes) { box.innerHTML = '<span class="muted">Hover over the curve for a departure date; click to plan that torch flight.</span>'; return; }
    if (!tr) { box.innerHTML = `${day(tcRes.dates[k])} · <span class="muted">no solution</span>`; return; }
    box.innerHTML = `Depart <b>${day(tr.jd0)}</b> · trip <b>${fmtDuration(tr.T)}</b> · arrive ${jdStr(tr.arriveJd)} UTC${tr.flipJd ? ` · flip ${jdStr(tr.flipJd)}` : ''} · Δv ${kms(auDayToKmS(tr.deltaV))} · ${tcRes.mode === 'intercept' ? 'arrival' : 'peak'} speed ${kms(auDayToKmS(tr.peakSpeed))}`;
  }

  /** The one-line "torch vs coasting" comparison under the torch inputs. */
  function renderTorchNote() {
    const box = q('[data-f=torchNote]');
    const g = parseFloat(ui.torchG);
    const Ts = tcRes ? tcRes.trips.slice(0, tcRes.done).filter(Boolean).map((x) => x.T) : [];
    let coast = '';
    if (pcRes && burns && pcRes.columnsDone > 1) {
      const cm = columnMinima(metricGrid(pcRes, 'total', burns), pcRes.nx, pcRes.ny).value.filter(Number.isFinite);
      if (cm.length) coast = ` while the cheapest coasting transfer swings between <b>${kms(Math.min(...cm))}</b> and <b>${kms(Math.max(...cm))}</b> of Δv depending on the departure date`;
    }
    if (!Ts.length) {
      box.innerHTML = '<b>Why windows barely matter for torch ships:</b> at constant thrust the trip takes days, so the planets hardly move on the way and the ship never waits for them to line up.';
      return;
    }
    const lo = Math.min(...Ts), hi = Math.max(...Ts);
    box.innerHTML = `<b>Why windows barely matter for torch ships:</b> at ${esc(String(g))} g the trip takes <b>${fmtNum(lo, 1)}–${fmtNum(hi, 1)} days</b> whenever it leaves (the spread is just the changing distance)${coast}.`;
  }

  // ------------------------------------------------------------------ tab lifecycle
  function show() {
    visible = true;
    q('[data-slot=from]').appendChild(planner.fromPicker.el);
    q('[data-slot=to]').appendChild(planner.toPicker.el);
    syncParkInputs();
    // the Plan tab may have changed the plan since the selection was made
    if (sel && (state.departStr !== sel.departStr || (sel.kind === 'ballistic' ? state.mode !== 'ballistic' || state.durationDays !== sel.durationDays : state.mode !== 'accel' || state.accelG !== sel.accelG))) sel = null;
    pcChart.setSelected(sel?.kind === 'ballistic' ? { t: sel.t, T: sel.T } : null);
    tcChart.setSelected(sel?.kind === 'torch' ? sel.k : null);
    placeOut();
    renderSelInfo();
    renderPcReadout(null);
    renderTcReadout(null);
    if (pcDirty) runPorkchop(); else deriveFromResult();
    if (tcDirty) runTorch();
  }

  function hide() {
    visible = false;
    clearTimeout(pcTimer); clearTimeout(tcTimer);
    for (const s of el.querySelectorAll('.lw-selinfo')) s.remove();
    planner.outEl.hidden = false;
  }

  /** From / To changed (the shared pickers): the selection no longer applies and both plots are stale. */
  function inputsChanged() {
    if (sel) clearSelection();
    schedulePorkchop(250);
    scheduleTorch(250);
    if (visible) renderParkPlaceholders();
  }

  function destroy() {
    visible = false;
    cancelPorkchop(); cancelTorch();
    clearTimeout(pcTimer); clearTimeout(tcTimer);
    pcChart.destroy(); tcChart.destroy();
  }

  return { el, show, hide, inputsChanged, hasSelection: () => !!sel, destroy };
}
