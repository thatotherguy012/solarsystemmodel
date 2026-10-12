// Command mode: a compact bar at the bottom centre of the 3D view for the selected ship(s) — Go to (G), Intercept (T),
// Cut engines, Drive quick-edit, Set course… — and the targeting controller: crosshair cursor, live preview path and
// tooltip while hovering a body / ship / station or a point on the ecliptic plane, click to apply (with Undo), Esc to
// cancel. Shift-click adds ships to the selection; a command then applies to each of them.
import { store, selectedIds } from '../sim/store.js';
import { driveOf, nameOf, TYPE_GLYPHS, DEFAULT_ACCEL_G } from '../sim/custom.js';
import { planCourse, planCutEngines } from '../sim/commands.js';
import { modalOpen } from './modal.js';
import { whenText } from './status.js';
import { fmtKmS, fmtDuration, fmtG, esc } from './format.js';

/** Custom objects in the selection that have a drive. */
export function commandableIds(s = store.get()) {
  return selectedIds(s).filter((id) => {
    const o = s.ctx.byId.get(id);
    return o && driveOf(o);
  });
}

/** One-line summary of a planned course for tooltips and toasts. */
export function planText(plan, jd, { withTarget = true } = {}) {
  if (!plan?.ok) return plan?.reason ?? 'no solution';
  const parts = [];
  if (withTarget) parts.push(plan.targetName);
  if (plan.kind === 'torch') {
    parts.push(`arrive ${whenText(plan.arriveJd, jd)}`, fmtDuration(plan.T), `peak ${fmtKmS(plan.peakSpeed)}`, `Δv ${fmtKmS(plan.deltaV)}`);
    if (plan.mode === 'intercept') parts.push(`closing ${fmtKmS(plan.closingSpeed)}`);
    return parts.join(' · ');
  }
  const head = `Burn now ${fmtKmS(plan.burnNow)}`;
  const rest = [`arrive ${whenText(plan.arriveJd, jd)}`, fmtDuration(plan.T)];
  if (plan.mode === 'intercept') rest.push(`closing ${fmtKmS(plan.closingSpeed)}`);
  else rest.push(`arrival burn ${fmtKmS(plan.arrivalBurn)}`);
  return [withTarget ? plan.targetName : null, head, ...rest].filter(Boolean).join(' · ');
}

/**
 * Apply new motions to ships with one Undo for all of them.
 * @param {Object} app
 * @param {{id:string, motion:Object}[]} changes
 * @param {string} message toast text
 */
export function applyMotions(app, changes, message) {
  if (!changes.length) return;
  const s = store.get();
  const before = new Map();
  const next = s.objects.map((o) => {
    const c = changes.find((x) => x.id === o.id);
    if (!c) return o;
    before.set(o.id, o);
    return { ...o, motion: c.motion };
  });
  store.set({ objects: next });
  app.toast(message, 'success', 9000, {
    label: 'Undo',
    title: 'Restore the previous course',
    onClick: () => {
      const cur = store.get().objects;
      store.set({ objects: cur.map((o) => before.get(o.id) ?? o) });
      app.toast('Course change undone', 'info');
    },
  });
}

/** @param {Object} app */
export function initCommandBar(app) {
  const viewport = document.getElementById('viewport');
  const bar = document.createElement('div');
  bar.id = 'command-bar';
  bar.className = 'command-bar';
  bar.setAttribute('role', 'toolbar');
  bar.setAttribute('aria-label', 'Ship commands');
  bar.hidden = true;
  viewport.appendChild(bar);
  const pop = document.createElement('div');
  pop.className = 'drive-pop';
  pop.hidden = true;
  viewport.appendChild(pop);

  // ---------------------------------------------------------------- bar rendering
  function driveLabel(ids, s) {
    const drives = ids.map((id) => driveOf(s.ctx.byId.get(id)));
    const txt = (d) => (d.kind === 'torch' ? `${+d.accelG.toPrecision(3)} g` : 'coast');
    const set = new Set(drives.map(txt));
    return set.size === 1 ? [...set][0] : 'mixed';
  }

  function render() {
    const s = store.get();
    const ids = commandableIds(s);
    if (!ids.length && !s.command) { bar.hidden = true; pop.hidden = true; return; }
    bar.hidden = false;
    if (s.command?.mode === 'place') {
      bar.innerHTML = `<span class="cb-prompt"><b>Place</b> — click a body or a point on the ecliptic for <b>${esc(placeLabel)}</b></span>
        <button class="btn small" data-c="cancel" title="Cancel (Esc)">Cancel</button>`;
      return;
    }
    if (s.command) {
      const names = s.command.ids.map((id) => nameOf(id, s.ctx));
      const verb = s.command.mode === 'intercept' ? 'Intercept' : 'Go to';
      const who = names.length === 1 ? names[0] : `${names.length} ships`;
      bar.innerHTML = `<span class="cb-prompt"><b>${verb}</b> — click a body, ship or station, or a point on the ecliptic, as the destination for <b>${esc(who)}</b></span>
        <button class="btn small" data-c="cancel" title="Cancel (Esc)">Cancel</button>`;
      return;
    }
    const o = s.ctx.byId.get(ids[0]);
    const who = ids.length === 1
      ? `<span class="glyph" style="color:${esc(o.color)}">${TYPE_GLYPHS[o.type] ?? '◆'}</span> ${esc(o.name)}`
      : `${ids.length} ships`;
    bar.innerHTML = `<span class="cb-who" title="${esc(ids.map((id) => nameOf(id, s.ctx)).join(', '))}">${who}</span>
      <button class="btn small" data-c="goto" title="Send to a destination and match its speed (G)">Go to <kbd>G</kbd></button>
      <button class="btn small" data-c="intercept" title="Reach a target as fast as possible, without matching its speed (T)">Intercept <kbd>T</kbd></button>
      <button class="btn small" data-c="cut" title="Stop thrusting now: the ship coasts on its current velocity">Cut engines</button>
      <button class="btn small" data-c="drive" title="Change the drive (torch acceleration or coast)">Drive: ${esc(driveLabel(ids, s))} ✎</button>
      ${ids.length === 1 ? '<button class="btn small" data-c="course" title="Detailed course: arrival date, ballistic duration, intercept or rendezvous">Set course…</button>' : ''}`;
  }

  bar.addEventListener('click', (ev) => {
    const c = ev.target.closest('[data-c]')?.dataset.c;
    if (!c) return;
    runCommand(c, ev.target.closest('[data-c]'));
  });

  /** Run a command button (also used by the inspector's mirrored buttons). */
  function runCommand(c, anchorEl) {
    if (c === 'cancel') cancel();
    else if (c === 'goto') start('goto');
    else if (c === 'intercept') start('intercept');
    else if (c === 'cut') cutEngines();
    else if (c === 'drive') openDrive(anchorEl);
    else if (c === 'course') app.openSetCourse(commandableIds()[0]);
  }

  // ---------------------------------------------------------------- targeting
  let hoverKey = '', pendingHover = null, rafId = 0, lastTipHtml = '';
  let placeCb = null, placeLabel = '';

  /** "Click on map" for the object form: pick a body or an ecliptic point, then call back with { ref } | { point } | null. */
  function startPlacing(label, cb) {
    placeCb = cb;
    placeLabel = label;
    pop.hidden = true;
    store.set({ command: { mode: 'place', ids: [] } });
    hoverKey = '';
  }

  function finishPlace(loc) {
    const cb = placeCb;
    placeCb = null;
    store.set({ command: null });
    clearPreview();
    cb?.(loc);
  }

  function start(mode) {
    const ids = commandableIds();
    if (!ids.length) { app.toast('Select a ship, fleet or probe with a drive first.'); return; }
    pop.hidden = true;
    store.set({ command: { mode, ids } });
    hoverKey = '';
    app.view.rehover();
  }

  function cancel() {
    if (!store.get().command) return;
    if (store.get().command.mode === 'place') { finishPlace(null); return; }
    store.set({ command: null });
    clearPreview();
  }

  function clearPreview() {
    hoverKey = '';
    app.view.setPreview(null);
    app.view.showTip(null);
  }

  /** Plans for every commanded ship toward `target`. */
  function plansFor(target) {
    const s = store.get();
    const cmd = s.command;
    return cmd.ids.map((id) => {
      const o = s.ctx.byId.get(id);
      if (!o) return { ok: false, reason: 'missing' };
      try {
        return planCourse(o, target, { mode: cmd.mode === 'intercept' ? 'intercept' : 'rendezvous' }, s.jd, s.ctx);
      } catch (err) {
        return { ok: false, reason: String(err?.message ?? err) };
      }
    });
  }

  /** Renderer hover hook: returns true while targeting (the command bar owns the tooltip). */
  function onHover(id, ev) {
    const s = store.get();
    if (!s.command) return false;
    pendingHover = { id, ev };
    if (!rafId) rafId = requestAnimationFrame(processHover);
    return true;
  }

  function processHover() {
    rafId = 0;
    const s = store.get();
    const h = pendingHover;
    if (!s.command || !h) return;
    if (!h.ev) { clearPreview(); return; }
    const r = document.getElementById('canvas-host').getBoundingClientRect();
    const x = h.ev.clientX - r.left, y = h.ev.clientY - r.top;
    let target = null, key;
    if (h.id && !s.command.ids.includes(h.id)) {
      target = { ref: h.id };
      key = `${h.id}|${s.jd}`;
    } else if (!h.id) {
      const p = app.view.eclipticPointAt(h.ev.clientX, h.ev.clientY);
      if (p) { target = { point: p }; key = `${p[0].toFixed(4)},${p[1].toFixed(4)}|${s.jd}`; }
    }
    if (s.command.mode === 'place') {
      const p = h.id ? null : app.view.eclipticPointAt(h.ev.clientX, h.ev.clientY);
      app.view.setPreview(p ? { paths: [], marker: p } : null);
      app.view.showTip(h.id ? `Place at <b>${esc(nameOf(h.id, s.ctx))}</b>` : p ? `Place at this point <span class="muted">(${p[0].toFixed(3)}, ${p[1].toFixed(3)}) AU</span>` : '<span class="muted">Point at a body or the ecliptic plane</span>', x, y);
      return;
    }
    if (!target) { app.view.setPreview(null); app.view.showTip(h.id ? '<span class="muted">That is one of the ships being commanded</span>' : '<span class="muted">Point at a body, ship or the ecliptic plane</span>', x, y); hoverKey = ''; return; }
    if (key === hoverKey) { app.view.showTip(lastTipHtml, x, y); return; }
    hoverKey = key;
    const plans = plansFor(target);
    const paths = plans.filter((p) => p.ok).map((p) => ({ points: p.preview, color: '#ffd166' }));
    app.view.setPreview({ paths, marker: target.point ?? null });
    const head = target.ref ? esc(nameOf(target.ref, s.ctx)) : 'Point on the ecliptic';
    let html = `<b>${head}</b>`;
    if (plans.length === 1) html += `<br>${esc(planText(plans[0], s.jd, { withTarget: false }))}`;
    else {
      plans.forEach((p, k) => { html += `<br><span class="muted">${esc(nameOf(s.command.ids[k], s.ctx))}:</span> ${esc(planText(p, s.jd, { withTarget: false }))}`; });
    }
    html += '<br><span class="muted small">Click to set course · Esc to cancel</span>';
    lastTipHtml = html;
    app.view.showTip(html, x, y);
  }

  /** Apply the active command toward a target. */
  function applyTarget(target) {
    const s = store.get();
    const cmd = s.command;
    if (!cmd) return;
    const changes = [], fails = [], etas = [];
    for (const id of cmd.ids) {
      const o = s.ctx.byId.get(id);
      if (!o) continue;
      let plan;
      try { plan = planCourse(o, target, { mode: cmd.mode === 'intercept' ? 'intercept' : 'rendezvous' }, s.jd, s.ctx); }
      catch (err) { plan = { ok: false, reason: String(err?.message ?? err) }; }
      if (!plan.ok) { fails.push(`${o.name}: ${plan.reason}`); continue; }
      const motion = plan.apply(true);
      changes.push({ id, motion });
      etas.push(motion.stops[motion.stops.length - 1].arriveJd);
    }
    store.set({ command: null });
    clearPreview();
    const name = target.ref ? nameOf(target.ref, s.ctx) : 'point in space';
    if (changes.length) {
      const eta = etas.map((t) => whenText(t, s.jd)).join(' / ');
      const who = changes.length > 1 ? ` for ${changes.length} ships` : '';
      applyMotions(app, changes, `Course set${who}: ${name}, ETA ${eta}`);
    }
    if (fails.length) app.toast(`No course: ${fails.join('; ')}`, 'error', 6000);
  }

  /** Renderer pick hook while targeting. Returns true when handled. */
  function onPick(id) {
    const s = store.get();
    if (!s.command) return false;
    if (s.command.mode === 'place') { finishPlace({ ref: id }); return true; }
    if (s.command.ids.includes(id)) { app.toast('Pick a destination other than the ship itself.'); return true; }
    applyTarget({ ref: id });
    return true;
  }

  /** Renderer empty-space click while targeting: a point on the ecliptic plane. */
  function onEmptyClick(ev) {
    if (!store.get().command) return false;
    const p = app.view.eclipticPointAt(ev.clientX, ev.clientY);
    if (!p) { app.toast('That point is not on the ecliptic plane (try tilting the view).'); return true; }
    if (store.get().command.mode === 'place') { finishPlace({ point: p }); return true; }
    applyTarget({ point: p });
    return true;
  }

  // ---------------------------------------------------------------- cut engines
  function cutEngines() {
    const s = store.get();
    const ids = commandableIds(s);
    const changes = [], msgs = [], fails = [];
    for (const id of ids) {
      const o = s.ctx.byId.get(id);
      const r = planCutEngines(o, s.jd, s.ctx);
      if (!r.ok) { fails.push(r.reason); continue; }
      changes.push({ id, motion: r.motion });
      msgs.push(`${o.name} drifting at ${fmtKmS(r.speed)}`);
    }
    if (changes.length) applyMotions(app, changes, `Engines cut: ${msgs.join(', ')}`);
    if (fails.length) app.toast(fails.join('; '), changes.length ? 'info' : 'error', 5000);
  }

  // ---------------------------------------------------------------- drive quick edit
  function openDrive(anchor) {
    const s = store.get();
    const ids = commandableIds(s);
    if (!ids.length) return;
    const d0 = driveOf(s.ctx.byId.get(ids[0]));
    pop.innerHTML = `<div class="drive-pop-title">Drive${ids.length > 1 ? ` (${ids.length} ships)` : ''}</div>
      <label class="check"><input type="radio" name="dk" value="torch" ${d0.kind === 'torch' ? 'checked' : ''}> Torch (constant thrust)</label>
      <label class="dp-accel">Acceleration <input data-f="accel" class="mono" inputmode="decimal" value="${d0.kind === 'torch' ? +d0.accelG.toPrecision(4) : DEFAULT_ACCEL_G}"> g</label>
      <label class="check"><input type="radio" name="dk" value="coast" ${d0.kind === 'coast' ? 'checked' : ''}> Coast (chemical / ballistic burns)</label>
      <label class="check"><input type="radio" name="dk" value="none"> No drive</label>
      <div class="muted small">Changes future commands only; courses already flown keep their numbers.</div>
      <div class="btn-row"><span class="spacer"></span><button class="btn small" data-p="cancel">Cancel</button><button class="btn small primary" data-p="save">Save</button></div>`;
    pop.hidden = false;
    const br = anchor?.getBoundingClientRect?.(), vr = viewport.getBoundingClientRect();
    if (br) {
      pop.style.left = `${Math.max(8, Math.min(br.left - vr.left, vr.width - 260))}px`;
      pop.style.bottom = `${vr.bottom - br.top + 6}px`;
      pop.style.top = '';
    }
    const accel = pop.querySelector('[data-f=accel]');
    accel.focus();
    accel.select();
    const save = () => {
      const kind = pop.querySelector('input[name=dk]:checked')?.value ?? 'torch';
      const g = Number(accel.value);
      if (kind === 'torch' && !(g > 0)) { accel.classList.add('invalid'); return; }
      const drive = kind === 'torch' ? { kind: 'torch', accelG: g } : { kind };
      const set = new Set(ids);
      store.set({ objects: store.get().objects.map((o) => (set.has(o.id) ? { ...o, drive } : o)) });
      pop.hidden = true;
      app.toast(`Drive set: ${kind === 'torch' ? `torch ${fmtG(g)}` : kind === 'coast' ? 'coast' : 'none'}`, 'success');
    };
    pop.querySelector('[data-p=save]').addEventListener('click', save);
    pop.querySelector('[data-p=cancel]').addEventListener('click', () => { pop.hidden = true; });
    accel.addEventListener('keydown', (ev) => { if (ev.key === 'Enter') save(); });
  }
  document.addEventListener('pointerdown', (ev) => {
    if (!pop.hidden && !pop.contains(ev.target) && !ev.target.closest?.('[data-c=drive]')) pop.hidden = true;
  });

  // ---------------------------------------------------------------- keyboard
  document.addEventListener('keydown', (ev) => {
    if (ev.ctrlKey || ev.metaKey || ev.altKey) return;
    const t = ev.target;
    const typing = t instanceof HTMLElement && (t.isContentEditable || /^(INPUT|TEXTAREA|SELECT)$/.test(t.tagName));
    if (modalOpen()) return;
    if (ev.key === 'Escape') {
      if (typing) return;
      if (app.closeMenus?.()) return;
      if (!pop.hidden) { pop.hidden = true; return; }
      if (store.get().command) { cancel(); return; }
      if (store.get().measureArmed) { store.set({ measureArmed: false, measure: null }); return; }
      if (store.get().selection || store.get().multiSelection.length) app.deselect();
      return;
    }
    if (typing) return;
    const k = ev.key.toLowerCase();
    if (k === 'g' || k === 't') {
      if (!commandableIds().length) return;
      ev.preventDefault();
      start(k === 'g' ? 'goto' : 'intercept');
    } else if (k === 'c') {
      ev.preventDefault();
      app.view.recentre();
    }
  });

  store.subscribe((s, changed) => {
    if (changed.some((k) => k === 'selection' || k === 'multiSelection' || k === 'command' || k === 'objects')) {
      if (s.command && changed.includes('objects')) {
        // the commanded ships must still exist
        const ids = s.command.ids.filter((id) => s.ctx.byId.has(id));
        if (ids.length !== s.command.ids.length) { store.set({ command: ids.length ? { ...s.command, ids } : null }); return; }
      }
      if (!s.command && changed.includes('command')) clearPreview();
      render();
    }
    if (s.command && changed.includes('jd')) { hoverKey = ''; if (pendingHover) onHover(pendingHover.id, pendingHover.ev); }
  });
  render();

  return { onHover, onPick, onEmptyClick, start, cancel, runCommand, cutEngines, render, startPlacing };
}

