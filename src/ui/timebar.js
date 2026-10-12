// Bottom-bar time controls (§7) and global keyboard shortcuts.
import { store } from '../sim/store.js';
import { RATE_PRESETS, STEP_PRESETS, togglePlay, step, setJd, setNow, toggleReverse, changeSpeed } from '../sim/clock.js';
import { formatJd, jdToInputValue, parseDateToJd, jdToCivil } from '../astro/time.js';
import { modalOpen } from './modal.js';

/** @param {Object} app */
export function initTimebar(app) {
  const host = document.getElementById('timebar');
  host.innerHTML = `
    <div class="tb-date">
      <div class="tb-date-main mono" data-f="date"></div>
      <div class="tb-date-sub mono"><span data-f="jd"></span> <span data-f="warn" class="tb-warn" hidden title="Planetary elements are valid 3000 BC – 3000 AD">⚠ outside ephemeris range</span></div>
    </div>
    <div class="tb-controls">
      <div class="btn-group">
        <button class="btn icon" data-a="back" title="Step back (,)" aria-label="Step back">⏮</button>
        <button class="btn icon play" data-a="play" title="Play / pause (Space)" aria-label="Play">▶</button>
        <button class="btn icon" data-a="fwd" title="Step forward (.)" aria-label="Step forward">⏭</button>
      </div>
      <label class="tb-field" title="Step size for ⏮ / ⏭">Step
        <select data-f="step">${STEP_PRESETS.map((p) => `<option value="${p.days}">${p.label}</option>`).join('')}</select>
      </label>
      <label class="tb-field" title="Playback rate ([ slower, ] faster)">Rate
        <select data-f="rate">${RATE_PRESETS.map((p) => `<option value="${p.rate}">${p.label}</option>`).join('')}</select>
      </label>
      <button class="btn small" data-a="reverse" title="Reverse the direction of time" aria-pressed="false">⇄ Reverse</button>
      <button class="btn small" data-a="now" title="Jump to the current date (N)">Now</button>
    </div>
    <div class="tb-inputs">
      <input type="text" class="date-text mono" data-f="text" spellcheck="false" autocomplete="off"
        title="Type a UTC date: YYYY-MM-DD or YYYY-MM-DD HH:MM (negative years allowed), then Enter" aria-label="Date (UTC)" />
      <input type="datetime-local" class="date-pick" data-f="picker" title="Pick a date (UTC, years 1–9999)" aria-label="Date picker (UTC)" />
    </div>`;
  const f = (k) => host.querySelector(`[data-f=${k}]`);
  const a = (k) => host.querySelector(`[data-a=${k}]`);
  const dateEl = f('date'), jdEl = f('jd'), warnEl = f('warn'), stepSel = f('step'), rateSel = f('rate');
  const text = f('text'), picker = f('picker');

  a('back').addEventListener('click', () => step(-1));
  a('fwd').addEventListener('click', () => step(1));
  a('play').addEventListener('click', () => togglePlay());
  a('reverse').addEventListener('click', () => toggleReverse());
  a('now').addEventListener('click', () => { setNow(); app.toast('Time set to now'); });
  stepSel.addEventListener('change', () => store.set({ stepDays: Number(stepSel.value) }));
  rateSel.addEventListener('change', () => {
    const sign = store.get().rate < 0 ? -1 : 1;
    store.set({ rate: sign * Number(rateSel.value) });
  });

  text.addEventListener('keydown', (ev) => {
    if (ev.key === 'Enter') {
      const jd = parseDateToJd(text.value);
      if (Number.isFinite(jd)) {
        text.classList.remove('invalid');
        setJd(jd);
        text.blur();
      } else {
        text.classList.add('invalid');
        app.toast('Unrecognised date. Use YYYY-MM-DD or YYYY-MM-DD HH:MM (UTC).', 'error');
      }
    } else if (ev.key === 'Escape') {
      text.classList.remove('invalid');
      text.value = formatJd(store.get().jd).replace(' UTC', '');
      text.blur();
    }
  });
  text.addEventListener('input', () => {
    const ok = Number.isFinite(parseDateToJd(text.value));
    text.classList.toggle('invalid', !ok && text.value.trim() !== '');
  });
  text.addEventListener('blur', () => { text.classList.remove('invalid'); render(true); });
  picker.addEventListener('change', () => {
    const jd = parseDateToJd(picker.value);
    if (Number.isFinite(jd)) setJd(jd);
  });

  let lastText = '';
  function render(force = false) {
    const s = store.get();
    const d = formatJd(s.jd);
    if (d !== lastText || force) {
      dateEl.textContent = d;
      lastText = d;
      if (document.activeElement !== text) text.value = d.replace(' UTC', '');
      const y = jdToCivil(s.jd).year;
      if (document.activeElement !== picker && y >= 1 && y <= 9999) picker.value = jdToInputValue(s.jd);
      warnEl.hidden = y >= -3000 && y <= 3000;
    }
    jdEl.textContent = `JD ${s.jd.toFixed(5)}`;
    const play = a('play');
    play.textContent = s.playing ? '⏸' : '▶';
    play.classList.toggle('active', s.playing);
    play.setAttribute('aria-label', s.playing ? 'Pause' : 'Play');
    rateSel.value = String(Math.abs(s.rate));
    stepSel.value = String(s.stepDays);
    a('reverse').setAttribute('aria-pressed', String(s.rate < 0));
    a('reverse').classList.toggle('active', s.rate < 0);
  }
  render(true);
  store.subscribe((_s, changed) => {
    if (changed.some((k) => k === 'jd' || k === 'playing' || k === 'rate' || k === 'stepDays')) render();
  });

  // ---- keyboard shortcuts
  document.addEventListener('keydown', (ev) => {
    if (ev.ctrlKey || ev.metaKey || ev.altKey) return;
    const tgt = ev.target;
    const typing = tgt instanceof HTMLElement && (tgt.isContentEditable || /^(INPUT|TEXTAREA|SELECT)$/.test(tgt.tagName));
    // Esc is handled centrally (src/ui/commandBar.js): menus, targeting, measuring, then deselect
    if (typing || modalOpen()) return;
    switch (ev.key) {
      case ' ': ev.preventDefault(); togglePlay(); break;
      case ',': step(-1); break;
      case '.': step(1); break;
      case '[': changeSpeed(-1); break;
      case ']': changeSpeed(1); break;
      case 'n': case 'N': setNow(); break;
      default: return;
    }
  });
}
