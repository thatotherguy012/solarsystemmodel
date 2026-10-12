// Import (file → preview → merge/replace), new/example scenario, and export. §8, §9.
import { validateScenario, applyScenario, exportScenario, exampleScenario, emptyScenario, saveNow } from '../../sim/scenario.js';
import { store } from '../../sim/store.js';
import { formatJd } from '../../astro/time.js';
import { openModal, confirmModal, h } from '../modal.js';
import { esc } from '../format.js';

/** Export the current scenario and confirm with a toast. */
export function doExport(app) {
  try {
    const name = exportScenario();
    app.toast(`Exported ${name}`, 'success');
  } catch (err) {
    app.toast(`Export failed: ${err.message}`, 'error');
  }
}

/** @param {Object} app */
export function openImport(app) {
  const body = h(`<div class="import">
    <p>Load a scenario exported from this app (<code>*.solarsystem.json</code>).</p>
    <input type="file" accept=".json,application/json" data-f="file" aria-label="Scenario file">
    <div data-f="preview" class="preview"></div>
    <div class="section-title">Start over</div>
    <div class="inline">
      <button class="btn" data-a="new">New empty scenario…</button>
      <button class="btn" data-a="example">Load example scenario…</button>
    </div>
    <p class="muted small">Your work is autosaved in this browser. Export regularly to keep a copy you control.</p>
  </div>`);
  const foot = h(`<div class="btn-row"><span class="spacer"></span><button class="btn" data-a="close">Close</button>
    <button class="btn" data-a="merge" disabled>Merge into current</button><button class="btn primary" data-a="replace" disabled>Replace current</button></div>`);
  const modal = openModal({ title: 'Import scenario', body, footer: foot });
  let parsed = null;

  body.querySelector('[data-f=file]').addEventListener('change', async (ev) => {
    const file = ev.target.files?.[0];
    const prev = body.querySelector('[data-f=preview]');
    parsed = null;
    foot.querySelector('[data-a=merge]').disabled = foot.querySelector('[data-a=replace]').disabled = true;
    if (!file) { prev.innerHTML = ''; return; }
    try {
      const res = validateScenario(JSON.parse(await file.text()));
      if (!res.ok) { prev.innerHTML = res.errors.map((e) => `<div class="msg err">✕ ${esc(e)}</div>`).join(''); return; }
      parsed = res.scenario;
      const types = {};
      for (const o of parsed.objects) types[o.type] = (types[o.type] || 0) + 1;
      prev.innerHTML = `<dl class="kv">
        <dt>Name</dt><dd>${esc(parsed.name)}</dd>
        <dt>Objects</dt><dd>${parsed.objects.length}${parsed.objects.length ? ` <span class="muted">(${Object.entries(types).map(([k, v]) => `${v} ${k}`).join(', ')})</span>` : ''}</dd>
        <dt>Events</dt><dd>${parsed.events.length}</dd>
        ${parsed.view?.jd ? `<dt>Saved time</dt><dd>${formatJd(parsed.view.jd)}</dd>` : ''}
      </dl>${res.errors.map((e) => `<div class="msg warn">⚠ skipped: ${esc(e)}</div>`).join('')}`;
      foot.querySelector('[data-a=merge]').disabled = foot.querySelector('[data-a=replace]').disabled = false;
    } catch (err) {
      prev.innerHTML = `<div class="msg err">✕ Could not read JSON: ${esc(err.message)}</div>`;
    }
  });

  foot.querySelector('[data-a=close]').addEventListener('click', () => modal.close());
  foot.querySelector('[data-a=merge]').addEventListener('click', () => {
    if (!parsed) return;
    applyScenario(parsed, 'merge');
    saveNow();
    modal.close();
    app.toast(`Merged ${parsed.objects.length} objects and ${parsed.events.length} events`, 'success');
  });
  foot.querySelector('[data-a=replace]').addEventListener('click', async () => {
    if (!parsed) return;
    if (!(await confirmModal('Replace scenario', `Replace “${store.get().scenarioName}” with “${parsed.name}”? Unsaved work in the current scenario will be lost (export it first).`, 'Replace'))) return;
    applyScenario(parsed, 'replace');
    saveNow();
    app.afterScenarioLoad();
    modal.close();
    app.toast(`Loaded ${parsed.name}`, 'success');
  });
  body.querySelector('[data-a=new]').addEventListener('click', async () => {
    if (!(await confirmModal('New scenario', 'Clear all custom objects and events and start an empty scenario? (Export first if you want to keep the current one.)', 'Clear'))) return;
    applyScenario(emptyScenario(), 'replace');
    saveNow();
    app.afterScenarioLoad();
    modal.close();
    app.toast('Started a new empty scenario', 'success');
  });
  body.querySelector('[data-a=example]').addEventListener('click', async () => {
    if (!(await confirmModal('Load example', 'Replace the current scenario with the example scenario (dated relative to today)?', 'Load example'))) return;
    applyScenario(exampleScenario(), 'replace');
    saveNow();
    app.afterScenarioLoad();
    modal.close();
    app.toast('Loaded the example scenario', 'success');
  });
}
