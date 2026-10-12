// Bottom-bar timeline: an interactive time axis with story-event ticks. §8 (v2).
//  - drag the blue cursor to scrub (jd follows every pointermove; scrubbing pauses playback)
//  - click the axis to set the time there; click an event tick to jump to it (hover shows its title)
//  - drag the axis background to pan; mouse wheel zooms about the pointer (1 day … 500 years)
//  - span presets and "Fit events"; tick labels adapt to the span (hours / days / months / years)
//  - while playing, the window follows the cursor unless the user is interacting with the strip
// The visible span is persisted in the scenario view (store.timelineSpan).
import { store, upsertEvent, newId } from '../sim/store.js';
import { setPlaying } from '../sim/clock.js';
import { formatJd, jdToCivil, civilToJd } from '../astro/time.js';
import { esc } from './format.js';

const YEAR = 365.25;
export const MIN_SPAN = 1;
export const MAX_SPAN = 500 * YEAR;
const PRESETS = [['1 d', 1], ['1 wk', 7], ['1 mo', 30.4375], ['1 yr', YEAR], ['10 yr', 10 * YEAR], ['100 yr', 100 * YEAR]];
const DRAG_PX = 4;          // pointer travel that turns a click into a drag
const CURSOR_HIT_PX = 6;    // grab tolerance around the cursor line
const IDLE_MS = 1500;       // auto-follow resumes this long after the last pan / zoom
const MONTHS = ['Jan', 'Feb', 'Mar', 'Apr', 'May', 'Jun', 'Jul', 'Aug', 'Sep', 'Oct', 'Nov', 'Dec'];
const UNIT_DAYS = { h: 1 / 24, d: 1, m: 30.44, y: YEAR };
const STEPS = [
  ['h', 1], ['h', 2], ['h', 3], ['h', 6], ['h', 12],
  ['d', 1], ['d', 2], ['d', 5], ['d', 10],
  ['m', 1], ['m', 2], ['m', 3], ['m', 6],
  ['y', 1], ['y', 2], ['y', 5], ['y', 10], ['y', 20], ['y', 25], ['y', 50], ['y', 100],
];

const clampSpan = (x) => Math.min(MAX_SPAN, Math.max(MIN_SPAN, x));
const pad2 = (n) => String(n).padStart(2, '0');

/**
 * Axis ticks for [start, end] on a strip `widthPx` wide: { jd, label, major }[]. The step is the smallest
 * calendar-aligned unit (hours, days, months, years) that leaves ~64 px per label.
 */
export function axisTicks(start, end, widthPx) {
  const span = end - start;
  const maxLabels = Math.max(2, Math.floor(widthPx / 64));
  const [unit, n] = STEPS.find(([u, k]) => span / (k * UNIT_DAYS[u]) <= maxLabels) ?? STEPS[STEPS.length - 1];
  const out = [];
  if (unit === 'h') {
    for (let h = Math.ceil(((start - 0.5) * 24) / n) * n; h / 24 + 0.5 <= end; h += n) {
      const jd = h / 24 + 0.5;
      const c = jdToCivil(jd + 1e-7);
      out.push(c.hour === 0 ? { jd, label: `${MONTHS[c.month - 1]} ${c.day}`, major: true } : { jd, label: `${pad2(c.hour)}:00`, major: false });
    }
  } else if (unit === 'd') {
    const DAYS = { 1: null, 2: null, 5: [1, 6, 11, 16, 21, 26], 10: [1, 11, 21] }[n];
    for (let jd = Math.ceil(start - 0.5) + 0.5; jd <= end; jd += 1) {
      const c = jdToCivil(jd + 1e-7);
      if (DAYS ? !DAYS.includes(c.day) : n === 2 && (jd - 0.5) % 2 !== 0) continue;
      if (c.day === 1) out.push({ jd, label: c.month === 1 ? String(c.year) : `${MONTHS[c.month - 1]} ${c.year}`, major: true });
      else out.push({ jd, label: `${MONTHS[c.month - 1]} ${c.day}`, major: false });
    }
  } else if (unit === 'm') {
    const c0 = jdToCivil(start);
    let y = c0.year, m = c0.month;
    for (let guard = 0; guard < 400; guard++) {
      const jd = civilToJd(y, m, 1);
      if (jd > end) break;
      if (jd >= start && (m - 1) % n === 0) out.push({ jd, label: m === 1 ? String(y) : MONTHS[m - 1], major: m === 1 });
      if (++m > 12) { m = 1; y++; }
    }
  } else {
    const y0 = Math.ceil(jdToCivil(start).year / n) * n;
    for (let y = y0, guard = 0; guard < 400; y += n, guard++) {
      const jd = civilToJd(y, 1, 1);
      if (jd > end) break;
      if (jd >= start) out.push({ jd, label: String(y), major: y % (n * 5) === 0 });
    }
  }
  return out;
}

/** Short label for a span in days ("1 d", "3.5 wk", "2.4 yr"). */
export function spanLabel(days) {
  if (days < 2) return `${(days * 24).toFixed(0)} h`;
  if (days < 14) return `${days.toFixed(days < 10 ? 1 : 0)} d`;
  if (days < 60) return `${(days / 7).toFixed(1)} wk`;
  if (days < 2 * YEAR) return `${(days / 30.4375).toFixed(1)} mo`;
  return `${(days / YEAR).toFixed(days < 20 * YEAR ? 1 : 0)} yr`;
}

/** @param {Object} app */
export function initTimeline(app) {
  const host = document.getElementById('timeline');
  host.innerHTML = `
    <div class="tl-top">
      <div class="tl-presets" role="group" aria-label="Timeline span">
        ${PRESETS.map(([l, d]) => `<button class="seg" data-span="${d}" title="Show ${l} around the cursor">${l}</button>`).join('')}
        <button class="seg" data-a="fit" title="Zoom to show every story event and the current time">Fit events</button>
      </div>
      <span class="tl-range mono" data-f="range"></span>
      <button class="btn tiny" data-a="add" title="Add a story event at the current time">＋ Event</button>
      <button class="btn tiny" data-a="list" title="Open the events list">Events…</button>
    </div>
    <div class="tl-strip" data-f="strip" title="Click: set the time · drag the blue cursor: scrub · drag the background: pan · wheel: zoom">
      <div class="tl-axis" data-f="axis"></div>
      <div class="tl-ticks" data-f="ticks"></div>
      <span class="tl-edge left" data-f="edgeL" hidden></span><span class="tl-edge right" data-f="edgeR" hidden></span>
      <div class="tl-cursor" data-f="cursor"><div class="tl-handle"></div></div>
      <div class="tl-tip" data-f="tip" hidden></div>
    </div>`;
  const f = (k) => host.querySelector(`[data-f=${k}]`);
  const strip = f('strip'), axis = f('axis'), ticks = f('ticks'), cursor = f('cursor'), tip = f('tip');
  const rangeEl = f('range'), edgeL = f('edgeL'), edgeR = f('edgeR');

  // ---- window state
  let span = 0, start = 0;
  let width = 400;
  let drag = null;            // { id, x0, start0, mode: 'scrub'|'press'|'pan', tick, moved }
  let lastInteract = -Infinity;

  function fitWindow(s) {
    const jds = s.events.map((e) => e.jd);
    if (!jds.length) return { span: YEAR, start: s.jd - YEAR / 2 };
    const lo = Math.min(s.jd, ...jds), hi = Math.max(s.jd, ...jds);
    const sp = clampSpan(Math.max(30, (hi - lo) * 1.12));
    return { span: sp, start: (lo + hi) / 2 - sp / 2 };
  }

  function initWindow() {
    const s = store.get();
    if (Number.isFinite(s.timelineSpan) && s.timelineSpan > 0) {
      span = clampSpan(s.timelineSpan);
      start = s.jd - span * 0.5;
    } else {
      ({ span, start } = fitWindow(s));
    }
  }

  const xToJd = (clientX) => {
    const r = strip.getBoundingClientRect();
    return start + ((clientX - r.left) / Math.max(1, r.width)) * span;
  };
  const pct = (jd) => ((jd - start) / span) * 100;
  const interacting = () => !!drag || performance.now() - lastInteract < IDLE_MS;
  const persistSpan = () => { if (store.get().timelineSpan !== span) store.set({ timelineSpan: span }); };

  // ---- rendering
  function renderAxis() {
    const end = start + span;
    axis.innerHTML = axisTicks(start, end, width)
      .map((t) => `<span class="tl-mark${t.major ? ' major' : ''}" style="left:${pct(t.jd).toFixed(3)}%"><span>${t.label}</span></span>`).join('');
    const withTime = span <= 3;
    rangeEl.textContent = `${spanLabel(span)} · ${formatJd(start, { time: withTime }).replace(' UTC', '')} → ${formatJd(end, { time: withTime })}`;
    rangeEl.title = `Visible span ${rangeEl.textContent}`;
    for (const b of host.querySelectorAll('[data-span]')) b.setAttribute('aria-pressed', String(Math.abs(Number(b.dataset.span) / span - 1) < 0.01));
  }

  function renderEvents() {
    const s = store.get();
    const end = start + span;
    let before = 0, after = 0, html = '';
    for (const e of s.events) {
      if (e.jd < start) { before++; continue; }
      if (e.jd > end) { after++; continue; }
      html += `<button class="tl-tick" data-ev="${esc(e.id)}" style="left:${pct(e.jd).toFixed(3)}%;--c:${esc(e.color || '#ffcc66')}" aria-label="${esc(e.title)} — ${formatJd(e.jd)}"></button>`;
    }
    ticks.innerHTML = html;
    edgeL.hidden = !before; edgeL.textContent = `◂ ${before}`; edgeL.title = `${before} event${before === 1 ? '' : 's'} earlier`;
    edgeR.hidden = !after; edgeR.textContent = `${after} ▸`; edgeR.title = `${after} event${after === 1 ? '' : 's'} later`;
  }

  function renderCursor() {
    const u = (store.get().jd - start) / span;
    const inside = u >= 0 && u <= 1;
    cursor.hidden = !inside;
    if (inside) cursor.style.left = `${(u * 100).toFixed(4)}%`;
  }

  function renderAll() {
    renderAxis();
    renderEvents();
    renderCursor();
  }

  /** Keep the cursor in view when time changes (auto-follow while playing; recentre after jumps). */
  function followTime(s) {
    if (!interacting()) {
      const u = (s.jd - start) / span;
      if (s.playing) {
        const fwd = s.rate >= 0;
        if (u < 0 || u > 1 || (fwd && u > 0.95) || (!fwd && u < 0.05)) {
          start = s.jd - (fwd ? 0.1 : 0.9) * span;
          renderAll();
          return;
        }
      } else if (u < 0 || u > 1) {
        start = s.jd - span / 2;
        renderAll();
        return;
      }
    }
    renderCursor();
  }

  // ---- tooltip
  function showTip(html, clientX) {
    const r = strip.getBoundingClientRect();
    tip.innerHTML = html;
    tip.hidden = false;
    const w = tip.offsetWidth || 140;
    tip.style.left = `${Math.min(r.width - w, Math.max(0, clientX - r.left - w / 2))}px`;
  }

  function hover(ev) {
    const t = ev.target.closest?.('.tl-tick');
    if (t) {
      const e = store.get().events.find((x) => x.id === t.dataset.ev);
      if (e) { showTip(`<b>${esc(e.title)}</b><br>${formatJd(e.jd)}`, ev.clientX); return; }
    }
    const onCursor = ev.target.closest?.('.tl-cursor');
    showTip(onCursor ? `${formatJd(store.get().jd)} <span class="muted">· drag to scrub</span>` : formatJd(xToJd(ev.clientX)), ev.clientX);
  }

  // ---- pointer interaction
  strip.addEventListener('pointerdown', (ev) => {
    if (ev.button !== 0 || drag) return;
    const r = strip.getBoundingClientRect();
    const u = (store.get().jd - start) / span;
    const cursorX = u >= 0 && u <= 1 ? u * r.width : null;
    const onCursor = !!ev.target.closest('.tl-cursor') || (cursorX != null && Math.abs(ev.clientX - r.left - cursorX) <= CURSOR_HIT_PX);
    const tick = onCursor ? null : ev.target.closest('.tl-tick');
    drag = { id: ev.pointerId, x0: ev.clientX, start0: start, mode: onCursor ? 'scrub' : 'press', tick: tick?.dataset.ev ?? null, moved: false };
    strip.setPointerCapture(ev.pointerId);
    ev.preventDefault();
    if (onCursor) {
      if (store.get().playing) setPlaying(false);
      strip.classList.add('scrubbing');
      showTip(formatJd(store.get().jd), ev.clientX);
    }
  });

  strip.addEventListener('pointermove', (ev) => {
    if (!drag) { hover(ev); return; }
    if (ev.pointerId !== drag.id) return;
    const dx = ev.clientX - drag.x0;
    if (drag.mode === 'scrub') {
      const jd = Math.min(start + span, Math.max(start, xToJd(ev.clientX)));
      store.set({ jd });
      showTip(formatJd(jd), ev.clientX);
      return;
    }
    if (drag.mode === 'press' && Math.abs(dx) > DRAG_PX) {
      drag.mode = 'pan';
      strip.classList.add('panning');
      tip.hidden = true;
    }
    if (drag.mode === 'pan') {
      start = drag.start0 - (dx / Math.max(1, strip.clientWidth)) * span;
      lastInteract = performance.now();
      renderAll();
    }
  });

  function endDrag(ev, cancelled) {
    if (!drag || ev.pointerId !== drag.id) return;
    const d = drag;
    drag = null;
    strip.classList.remove('scrubbing', 'panning');
    lastInteract = performance.now();
    if (cancelled || d.mode !== 'press') return;
    if (d.tick) {
      const e = store.get().events.find((x) => x.id === d.tick);
      if (e) { store.set({ jd: e.jd }); app.toast(`${e.title} — ${formatJd(e.jd)}`); }
    } else {
      store.set({ jd: xToJd(ev.clientX) });
    }
  }
  strip.addEventListener('pointerup', (ev) => endDrag(ev, false));
  strip.addEventListener('pointercancel', (ev) => endDrag(ev, true));
  strip.addEventListener('pointerleave', () => { if (!drag) tip.hidden = true; });
  // keyboard activation of an event tick (pointer clicks are handled above)
  strip.addEventListener('click', (ev) => {
    if (ev.detail !== 0) return;
    const t = ev.target.closest('.tl-tick');
    const e = t && store.get().events.find((x) => x.id === t.dataset.ev);
    if (e) { store.set({ jd: e.jd }); app.toast(`${e.title} — ${formatJd(e.jd)}`); }
  });

  // wheel: zoom about the pointer (horizontal trackpad scrolling pans)
  strip.addEventListener('wheel', (ev) => {
    ev.preventDefault();
    const r = strip.getBoundingClientRect();
    const k = ev.deltaMode === 1 ? 33 : ev.deltaMode === 2 ? 400 : 1;
    const dx = ev.deltaX * k, dy = ev.deltaY * k;
    if (Math.abs(dx) > Math.abs(dy)) {
      start += (dx / Math.max(1, r.width)) * span;
    } else {
      const u = (ev.clientX - r.left) / Math.max(1, r.width);
      const at = start + u * span;
      span = clampSpan(span * Math.exp(dy * 0.0015));
      start = at - u * span;
      persistSpan();
    }
    lastInteract = performance.now();
    renderAll();
    if (!tip.hidden) hover(ev);
  }, { passive: false });

  // ---- presets & buttons
  host.querySelector('.tl-presets').addEventListener('click', (ev) => {
    const b = ev.target.closest('button');
    if (!b) return;
    const s = store.get();
    if (b.dataset.a === 'fit') {
      ({ span, start } = fitWindow(s));
    } else {
      const next = clampSpan(Number(b.dataset.span));
      const u = (s.jd - start) / span;
      start = u >= 0 && u <= 1 ? s.jd - u * next : s.jd - next / 2; // zoom about the cursor
      span = next;
    }
    persistSpan();
    renderAll();
  });
  host.querySelector('[data-a=add]').addEventListener('click', () => {
    const s = store.get();
    const ev = { id: newId(), jd: s.jd, title: `Event ${s.events.length + 1}`, notes: '', color: '#ffcc66' };
    upsertEvent(ev);
    app.openEvents({ editId: ev.id });
  });
  host.querySelector('[data-a=list]').addEventListener('click', () => app.openEvents());

  // ---- store
  store.subscribe((s, changed) => {
    if (changed.includes('timelineSpan') && s.timelineSpan !== span) {
      // set from outside (scenario load / import)
      if (Number.isFinite(s.timelineSpan) && s.timelineSpan > 0) { span = clampSpan(s.timelineSpan); start = s.jd - span / 2; }
      else ({ span, start } = fitWindow(s));
      renderAll();
      return;
    }
    if (changed.includes('events')) renderEvents();
    if (changed.includes('jd') || changed.includes('playing')) followTime(s);
  });

  initWindow();
  new ResizeObserver(() => {
    width = strip.clientWidth || width;
    renderAll();
  }).observe(strip);
  width = strip.clientWidth || width;
  renderAll();

  return {
    /** Current visible window { start, span } (days). */
    get window() { return { start, span }; },
  };
}
