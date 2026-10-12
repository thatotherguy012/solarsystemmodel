// Derived route milestones on the timeline strip: hollow ticks in each object's colour in a row below the story-event
// ticks, with hover tooltips (every milestone near the pointer) and click-to-jump; an "Auto milestones" toggle next
// to the event buttons (persisted, default on). Self-contained: it adds its own layer to the strip and follows the
// timeline's visible window through its public `window` getter (polled once per animation frame), so the timeline
// module needs no changes.
import { store } from '../sim/store.js';
import { formatJd } from '../astro/time.js';
import { getMilestones, onMilestonesChange, startMilestones, MILESTONE_KINDS } from '../sim/milestones.js';
import { esc } from './format.js';

const PREF_KEY = 'ssm.ui.autoMilestones';
const NEAR_PX = 5;      // milestones within this distance of the pointer are listed together in the tooltip
const MAX_TICKS = 600;  // rendering cap for very dense windows
const MAX_TIP = 6;

/** Whether auto milestones are shown on the timeline (persisted, default on). */
export function autoMilestonesOn() {
  try { return localStorage.getItem(PREF_KEY) !== '0'; } catch { return true; }
}

/**
 * @param {Object} app application facade: needs `app.timeline.window` ({start, span}) and `app.toast`
 */
export function initTimelineMilestones(app) {
  const host = document.getElementById('timeline');
  const strip = host?.querySelector('.tl-strip');
  if (!strip || !app.timeline) return null;
  startMilestones();
  const tip = strip.querySelector('.tl-tip');
  let on = autoMilestonesOn();

  // ---- layer (inserted before the cursor so the cursor stays on top)
  const layer = document.createElement('div');
  layer.className = 'tl-ms-layer';
  layer.title = ''; // suppress the strip's own tooltip over milestone ticks
  strip.insertBefore(layer, strip.querySelector('.tl-cursor'));

  // ---- toggle next to the event buttons
  const toggle = document.createElement('button');
  toggle.className = 'btn tiny tl-ms-toggle';
  toggle.type = 'button';
  toggle.innerHTML = '<span class="ms-icon" aria-hidden="true">◇</span><span class="ms-label">Auto milestones</span>';
  toggle.setAttribute('aria-label', 'Auto milestones');
  toggle.title = 'Show departures, arrivals, flips, flybys and close approaches derived from the routes (hollow ticks below the story events)';
  const listBtn = host.querySelector('.tl-top [data-a=list]');
  if (listBtn) listBtn.after(toggle); else host.querySelector('.tl-top')?.appendChild(toggle);

  let list = [];        // milestones currently rendered (index = data-i)
  let drawn = '';       // window signature of the last render
  let dirty = true;     // milestones changed since the last render
  let down = null;      // { i, pointerId }

  function apply() {
    toggle.setAttribute('aria-pressed', String(on));
    if (!on) strip.classList.remove('has-ms');
    layer.hidden = !on;
    dirty = true;
  }

  function render() {
    if (!on) return;
    const { start, span } = app.timeline.window;
    const sig = `${start}|${span}`;
    if (!dirty && sig === drawn) return;
    dirty = false;
    drawn = sig;
    const end = start + span;
    const all = getMilestones();
    strip.classList.toggle('has-ms', all.length > 0); // the extra row only when there is something to show
    list = all.filter((m) => m.jd >= start && m.jd <= end).slice(0, MAX_TICKS);
    layer.innerHTML = list.map((m, i) =>
      `<button class="tl-ms" type="button" data-i="${i}" data-kind="${m.kind}" style="left:${(((m.jd - start) / span) * 100).toFixed(3)}%;--c:${esc(m.color)}" aria-label="${esc(m.title)} — ${formatJd(m.jd)}"></button>`).join('');
  }

  function near(clientX) {
    const r = strip.getBoundingClientRect();
    const { start, span } = app.timeline.window;
    const x = (m) => r.left + ((m.jd - start) / span) * r.width;
    return list.filter((m) => Math.abs(x(m) - clientX) <= NEAR_PX).sort((a, b) => a.jd - b.jd);
  }

  function showTip(target, clientX) {
    if (!tip) return;
    const m = list[Number(target.dataset.i)];
    if (!m) return;
    const others = near(clientX).filter((x) => x !== m);
    const line = (x, main) => `<span class="tl-ms-swatch" data-kind="${x.kind}" style="--c:${esc(x.color)}"></span>${main ? `<b>${esc(x.title)}</b>` : esc(x.title)} <span class="muted">· ${formatJd(x.jd)}</span>`;
    let html = `${line(m, true)}<br><span class="muted">${esc(MILESTONE_KINDS[m.kind] ?? m.kind)} · ${esc(m.detail)}</span>`;
    for (const x of others.slice(0, MAX_TIP - 1)) html += `<br>${line(x, false)}`;
    if (others.length > MAX_TIP - 1) html += `<br><span class="muted">+${others.length - (MAX_TIP - 1)} more</span>`;
    html += '<br><span class="muted small">derived from the route · click to jump</span>';
    const r = strip.getBoundingClientRect();
    tip.innerHTML = html;
    tip.hidden = false;
    const w = tip.offsetWidth || 200;
    tip.style.left = `${Math.min(r.width - w, Math.max(0, clientX - r.left - w / 2))}px`;
  }

  function jump(m) {
    store.set({ jd: m.jd });
    app.toast(`${m.title} — ${formatJd(m.jd)}`);
  }

  // Pointer events on the ticks are handled here and stopped, so the strip does not start a pan / time-set.
  layer.addEventListener('pointerdown', (ev) => {
    const t = ev.target.closest('.tl-ms');
    if (!t || ev.button !== 0) return;
    ev.stopPropagation();
    ev.preventDefault();
    down = { i: Number(t.dataset.i), pointerId: ev.pointerId };
  });
  layer.addEventListener('pointerup', (ev) => {
    const t = ev.target.closest('.tl-ms');
    if (!t) return;
    ev.stopPropagation();
    const d = down;
    down = null;
    if (d && d.pointerId === ev.pointerId && d.i === Number(t.dataset.i) && list[d.i]) jump(list[d.i]);
  });
  layer.addEventListener('pointermove', (ev) => {
    const t = ev.target.closest('.tl-ms');
    if (!t) return;
    ev.stopPropagation();
    showTip(t, ev.clientX);
  });
  // keyboard activation (Enter / Space on a focused tick)
  layer.addEventListener('click', (ev) => {
    if (ev.detail !== 0) return;
    const t = ev.target.closest('.tl-ms');
    if (t && list[Number(t.dataset.i)]) jump(list[Number(t.dataset.i)]);
  });
  layer.addEventListener('focusin', (ev) => {
    const t = ev.target.closest('.tl-ms');
    if (t) showTip(t, t.getBoundingClientRect().left + t.offsetWidth / 2);
  });
  layer.addEventListener('focusout', () => { if (tip) tip.hidden = true; });

  toggle.addEventListener('click', () => {
    on = !on;
    try { localStorage.setItem(PREF_KEY, on ? '1' : '0'); } catch { /* ignore */ }
    apply();
    render();
  });

  onMilestonesChange(() => { dirty = true; });
  // follow the timeline window (pan, zoom, presets, auto-follow) without hooking into the timeline module
  const loop = () => { render(); requestAnimationFrame(loop); };
  apply();
  requestAnimationFrame(loop);

  return {
    /** Milestones currently drawn on the strip. */
    get visible() { return list; },
    get enabled() { return on; },
  };
}
