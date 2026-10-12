// Events timeline strip in the bottom bar: coloured ticks for story events, current-time cursor. §8.
import { store, upsertEvent, newId } from '../sim/store.js';
import { formatJd, jdToCivil, civilToJd } from '../astro/time.js';
import { esc } from './format.js';

/** @param {Object} app */
export function initTimeline(app) {
  const host = document.getElementById('timeline');
  host.innerHTML = `
    <div class="tl-strip" data-f="strip" title="Story events (click a tick to jump; click empty space to set time)">
      <div class="tl-axis" data-f="axis"></div>
      <div class="tl-ticks" data-f="ticks"></div>
      <div class="tl-cursor" data-f="cursor"><span class="tl-cursor-label" data-f="cursorLabel"></span></div>
      <div class="tl-tip" data-f="tip" hidden></div>
    </div>
    <div class="tl-buttons">
      <button class="btn small" data-a="add" title="Add a story event at the current time">＋ event at current time</button>
      <button class="btn small" data-a="list" title="Open the events list">Events…</button>
    </div>`;
  const f = (k) => host.querySelector(`[data-f=${k}]`);
  const strip = f('strip'), axis = f('axis'), ticks = f('ticks'), cursor = f('cursor'), tip = f('tip');
  let range = [0, 1];

  function computeRange(s) {
    const jds = s.events.map((e) => e.jd);
    let lo = Math.min(s.jd, ...jds), hi = Math.max(s.jd, ...jds);
    if (!jds.length) { lo = s.jd - 180; hi = s.jd + 180; }
    let span = hi - lo;
    if (span < 30) { const c = (hi + lo) / 2; lo = c - 15; hi = c + 15; span = 30; }
    const margin = span * 0.06;
    return [lo - margin, hi + margin];
  }

  const xOf = (jd) => ((jd - range[0]) / (range[1] - range[0])) * 100;

  function renderAxis() {
    const span = range[1] - range[0];
    const c0 = jdToCivil(range[0]), c1 = jdToCivil(range[1]);
    let html = '';
    const maxLabels = Math.max(2, Math.floor((strip.clientWidth || 400) / 64));
    const years = span / 365.25;
    if (years > 1.5) {
      const stepY = [1, 2, 5, 10, 20, 50, 100, 200, 500, 1000].find((k) => years / k <= maxLabels) ?? 1000;
      for (let y = Math.ceil(c0.year / stepY) * stepY; y <= c1.year; y += stepY) {
        const x = xOf(civilToJd(y, 1, 1));
        if (x >= 0 && x <= 100) html += `<span class="tl-mark" style="left:${x}%"><span>${y}</span></span>`;
      }
    } else {
      const months = span / 30.44;
      const stepM = [1, 2, 3, 6, 12].find((k) => months / k <= maxLabels) ?? 12;
      let y = c0.year, m = c0.month + 1;
      if (m > 12) { m = 1; y++; }
      for (let guard = 0; guard < 40; guard++) {
        const jd = civilToJd(y, m, 1);
        if (jd > range[1]) break;
        if ((m - 1) % stepM === 0) {
          const x = xOf(jd);
          html += `<span class="tl-mark" style="left:${x}%"><span>${m === 1 ? y : `${y}-${String(m).padStart(2, '0')}`}</span></span>`;
        }
        m++;
        if (m > 12) { m = 1; y++; }
      }
    }
    axis.innerHTML = html;
  }

  function renderTicks(s) {
    ticks.innerHTML = s.events.map((e) => `<button class="tl-tick" data-ev="${esc(e.id)}" style="left:${xOf(e.jd)}%;--c:${esc(e.color || '#ffcc66')}" aria-label="${esc(e.title)} — ${formatJd(e.jd)}"></button>`).join('');
  }

  function renderCursor(s) {
    cursor.style.left = `${xOf(s.jd)}%`;
  }

  function full() {
    const s = store.get();
    range = computeRange(s);
    renderAxis();
    renderTicks(s);
    renderCursor(s);
  }

  let lastFull = 0;
  store.subscribe((s, changed) => {
    if (changed.includes('events')) { full(); return; }
    if (changed.includes('jd')) {
      const outside = s.jd < range[0] || s.jd > range[1];
      const now = performance.now();
      if (outside || (now - lastFull > 150 && !s.playing) || now - lastFull > 500) { lastFull = now; full(); }
      else renderCursor(s);
    }
  });
  full();
  new ResizeObserver(() => full()).observe(strip);

  strip.addEventListener('click', (ev) => {
    const t = ev.target.closest('.tl-tick');
    if (t) {
      const e = store.get().events.find((x) => x.id === t.dataset.ev);
      if (e) { store.set({ jd: e.jd }); app.toast(`${e.title} — ${formatJd(e.jd)}`); }
      return;
    }
    const r = strip.getBoundingClientRect();
    const u = (ev.clientX - r.left) / r.width;
    store.set({ jd: range[0] + u * (range[1] - range[0]) });
  });
  strip.addEventListener('mousemove', (ev) => {
    const t = ev.target.closest('.tl-tick');
    const r = strip.getBoundingClientRect();
    if (t) {
      const e = store.get().events.find((x) => x.id === t.dataset.ev);
      if (e) {
        tip.innerHTML = `<b>${esc(e.title)}</b><br>${formatJd(e.jd)}`;
        tip.hidden = false;
        tip.style.left = `${Math.min(r.width - 160, Math.max(0, ev.clientX - r.left - 80))}px`;
        return;
      }
    }
    const jd = range[0] + ((ev.clientX - r.left) / r.width) * (range[1] - range[0]);
    tip.textContent = formatJd(jd);
    tip.hidden = false;
    tip.style.left = `${Math.min(r.width - 160, Math.max(0, ev.clientX - r.left - 60))}px`;
  });
  strip.addEventListener('mouseleave', () => { tip.hidden = true; });

  host.querySelector('[data-a=add]').addEventListener('click', () => {
    const s = store.get();
    const ev = { id: newId(), jd: s.jd, title: `Event ${s.events.length + 1}`, notes: '', color: '#ffcc66' };
    upsertEvent(ev);
    app.openEvents({ editId: ev.id });
  });
  host.querySelector('[data-a=list]').addEventListener('click', () => app.openEvents());
}
