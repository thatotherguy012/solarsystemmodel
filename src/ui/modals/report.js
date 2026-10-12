// Situation report dialog: pick a date, the custom objects and natural bodies to include and the units; preview the
// Markdown live; copy it to the clipboard or download it as a .md file. The report itself is built by src/sim/report.js.
import { formatJd, parseDateToJd } from '../../astro/time.js';
import { store } from '../../sim/store.js';
import { getBody, allBodies } from '../../sim/ephemeris.js';
import { TYPE_GLYPHS } from '../../sim/custom.js';
import { buildReport, defaultSelection, sortBodies } from '../../sim/report.js';
import { openModal, h } from '../modal.js';
import { refPicker } from '../components.js';
import { esc } from '../format.js';

const PREFS_KEY = 'ssm.ui.reportPrefs';

function loadPrefs() {
  try { return JSON.parse(localStorage.getItem(PREFS_KEY) || '{}') || {}; } catch { return {}; }
}
function savePrefs(p) {
  try { localStorage.setItem(PREFS_KEY, JSON.stringify(p)); } catch { /* ignore */ }
}

/** Copy text to the clipboard (async Clipboard API, falling back to a hidden textarea + execCommand). */
export async function copyText(text) {
  try {
    if (navigator.clipboard?.writeText) { await navigator.clipboard.writeText(text); return true; }
  } catch { /* fall through */ }
  const ta = document.createElement('textarea');
  ta.value = text;
  ta.setAttribute('readonly', '');
  ta.style.position = 'fixed';
  ta.style.opacity = '0';
  (document.querySelector('dialog[open]') || document.body).appendChild(ta);
  ta.select();
  let ok = false;
  try { ok = document.execCommand('copy'); } catch { ok = false; }
  ta.remove();
  return ok;
}

/** Offer `text` as a download. */
export function downloadText(text, fileName, type = 'text/markdown;charset=utf-8') {
  const url = URL.createObjectURL(new Blob([text], { type }));
  const a = document.createElement('a');
  a.href = url;
  a.download = fileName;
  document.body.appendChild(a);
  a.click();
  a.remove();
  setTimeout(() => URL.revokeObjectURL(url), 5000);
}

/**
 * Open the situation report dialog.
 * @param {Object} app application facade (toast)
 */
export function openReport(app) {
  const s0 = store.get();
  const prefs = loadPrefs();
  let jd = s0.jd;
  const def = defaultSelection(s0, jd);
  const selObjects = new Set(def.objectIds);
  const selBodies = new Set(def.bodyIds);
  // bodies offered as checkboxes: Sun, planets, Moon, the defaults, and anything added with the picker
  let offered = sortBodies(['sun', ...allBodies().filter((b) => b.type === 'planet').map((b) => b.id), 'moon', ...def.bodyIds]);

  const body = h(`<div class="rp">
    <div class="rp-opts">
      <div class="rp-grid">
        <label class="field">Date (UTC)
          <span class="inline"><input data-f="date" class="mono" spellcheck="false" aria-label="Report date"><button class="btn small" data-a="now" title="Use the current simulation time">Sim time</button></span>
        </label>
        <label class="field">Look ahead (days)<input data-f="days" type="number" min="1" max="36525" step="1"></label>
        <label class="field">Distances
          <select data-f="dist"><option value="mkm">AU + million km</option><option value="km">AU + km</option><option value="au">AU only</option></select>
        </label>
        <label class="field">Speeds
          <select data-f="speed"><option value="kms">km/s</option><option value="ms">m/s</option><option value="c">% of light speed</option></select>
        </label>
        <label class="field">Pair table
          <select data-f="pairs"><option value="all">All pairs</option><option value="custom">Only pairs with a custom object</option></select>
        </label>
        <label class="check"><input type="checkbox" data-f="events"> Story events in the window</label>
      </div>
      <fieldset class="rp-set">
        <legend>Custom objects <button class="icon-btn small" data-a="obj-all">all</button><button class="icon-btn small" data-a="obj-none">none</button></legend>
        <div class="rp-checks" data-f="objects"></div>
      </fieldset>
      <fieldset class="rp-set">
        <legend>Natural bodies <button class="icon-btn small" data-a="body-none">none</button></legend>
        <div class="rp-checks" data-f="bodies"></div>
        <div class="rp-add"><span class="muted small">Add</span><span data-f="picker"></span></div>
      </fieldset>
    </div>
    <div class="rp-out">
      <div class="rp-out-head"><span class="muted small" data-f="stats"></span></div>
      <textarea class="rp-preview mono" data-f="preview" readonly wrap="off" spellcheck="false" aria-label="Report preview (Markdown)"></textarea>
    </div>
  </div>`);
  const foot = h(`<div class="btn-row">
    <button class="btn primary" data-a="copy">Copy to clipboard</button>
    <button class="btn" data-a="download">Download .md</button>
    <span class="spacer"></span>
    <button class="btn" data-a="close">Close</button></div>`);
  const modal = openModal({ title: 'Situation report', body, footer: foot, wide: true, className: 'report-modal', onClose: () => unsub() });
  const f = (k) => body.querySelector(`[data-f=${k}]`);
  const dateIn = f('date'), daysIn = f('days'), distSel = f('dist'), speedSel = f('speed'), pairsSel = f('pairs'), evChk = f('events');
  const preview = f('preview'), stats = f('stats');

  dateIn.value = formatJd(jd).replace(' UTC', '');
  daysIn.value = String(Number.isFinite(prefs.windowDays) ? prefs.windowDays : 30);
  distSel.value = prefs.distUnit || 'mkm';
  speedSel.value = prefs.speedUnit || 'kms';
  pairsSel.value = prefs.pairs || 'all';
  evChk.checked = prefs.includeEvents !== false;

  function renderObjects() {
    const s = store.get();
    const el = f('objects');
    if (!s.objects.length) { el.innerHTML = '<span class="muted small">No custom objects in this scenario.</span>'; return; }
    el.innerHTML = s.objects.map((o) => `<label class="check" title="${esc(o.name)}"><input type="checkbox" data-obj="${esc(o.id)}" ${selObjects.has(o.id) ? 'checked' : ''}>
      <span class="glyph" style="color:${esc(o.color)}">${TYPE_GLYPHS[o.type] ?? '●'}</span><span class="rp-name">${esc(o.name)}</span></label>`).join('');
  }
  function renderBodies() {
    f('bodies').innerHTML = offered.map((id) => {
      const b = getBody(id);
      return `<label class="check"><input type="checkbox" data-body="${esc(id)}" ${selBodies.has(id) ? 'checked' : ''}>
        <span class="dot" style="background:${esc(b?.color ?? '#999')}"></span><span class="rp-name">${esc(b?.name ?? id)}</span></label>`;
    }).join('');
  }

  const picker = refPicker({ includeCustom: false, ariaLabel: 'Natural body to add' });
  f('picker').appendChild(picker.el);
  const addBtn = h('<button class="btn small" data-a="body-add" title="Add the chosen body to the report">Add</button>');
  f('picker').appendChild(addBtn);

  let current = { markdown: '', fileName: 'report.md' };
  let timer = null;
  function generate() {
    timer = null;
    const p = parseDateToJd(dateIn.value);
    dateIn.classList.toggle('invalid', !Number.isFinite(p));
    if (Number.isFinite(p)) jd = p;
    const windowDays = Math.max(1, Number(daysIn.value) || 30);
    const opts = {
      jd, objectIds: store.get().objects.map((o) => o.id).filter((id) => selObjects.has(id)), bodyIds: [...selBodies],
      distUnit: distSel.value, speedUnit: speedSel.value, windowDays, includeEvents: evChk.checked, pairs: pairsSel.value,
    };
    savePrefs({ windowDays, distUnit: opts.distUnit, speedUnit: opts.speedUnit, includeEvents: opts.includeEvents, pairs: opts.pairs });
    try {
      current = buildReport(store.get(), opts);
    } catch (err) {
      console.error(err);
      current = { markdown: `Could not build the report: ${err?.message ?? err}`, fileName: 'report.md' };
    }
    const top = preview.scrollTop;
    preview.value = current.markdown;
    preview.scrollTop = top;
    const lines = current.markdown.split('\n').length;
    stats.textContent = `${opts.objectIds.length} object${opts.objectIds.length === 1 ? '' : 's'} · ${opts.bodyIds.length} bod${opts.bodyIds.length === 1 ? 'y' : 'ies'} · ${lines} lines · Markdown`;
  }
  function schedule() {
    clearTimeout(timer);
    timer = setTimeout(generate, 120);
  }

  body.addEventListener('change', (ev) => {
    const t = ev.target;
    if (t.dataset.obj) { if (t.checked) selObjects.add(t.dataset.obj); else selObjects.delete(t.dataset.obj); }
    if (t.dataset.body) { if (t.checked) selBodies.add(t.dataset.body); else selBodies.delete(t.dataset.body); }
    schedule();
  });
  dateIn.addEventListener('input', schedule);
  dateIn.addEventListener('keydown', (ev) => { if (ev.key === 'Enter') generate(); });
  daysIn.addEventListener('input', schedule);
  body.addEventListener('click', (ev) => {
    const a = ev.target.closest('[data-a]')?.dataset.a;
    if (!a) return;
    if (a === 'now') { dateIn.value = formatJd(store.get().jd).replace(' UTC', ''); generate(); }
    else if (a === 'obj-all') { for (const o of store.get().objects) selObjects.add(o.id); renderObjects(); schedule(); }
    else if (a === 'obj-none') { selObjects.clear(); renderObjects(); schedule(); }
    else if (a === 'body-none') { selBodies.clear(); renderBodies(); schedule(); }
    else if (a === 'body-add') {
      const id = picker.value;
      if (!id || !getBody(id)) { app.toast('Choose a body in the list first'); return; }
      if (!offered.includes(id)) offered = sortBodies([...offered, id]);
      selBodies.add(id);
      renderBodies();
      schedule();
    }
  });
  foot.addEventListener('click', async (ev) => {
    const a = ev.target.closest('[data-a]')?.dataset.a;
    if (!a) return;
    if (timer) { clearTimeout(timer); generate(); }
    if (a === 'copy') {
      const ok = await copyText(current.markdown);
      app.toast(ok ? 'Report copied to the clipboard' : 'Could not copy: select the text and copy it manually', ok ? 'success' : 'error');
    } else if (a === 'download') {
      downloadText(current.markdown, current.fileName);
      app.toast(`Downloaded ${current.fileName}`, 'success');
    } else if (a === 'close') modal.close();
  });

  // keep the object list current if the scenario changes while the dialog is open
  const unsub = store.subscribe((_s, changed) => {
    if (changed.includes('objects')) {
      for (const id of [...selObjects]) if (!store.get().ctx.byId.has(id)) selObjects.delete(id);
      renderObjects();
      schedule();
    } else if (changed.includes('events')) schedule();
  });

  renderObjects();
  renderBodies();
  generate();
  return modal;
}
