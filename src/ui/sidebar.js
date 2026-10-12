// Left sidebar: object browser with collapsible groups, moons nested under planets, search filter. §8.
import { store, deleteObject } from '../sim/store.js';
import { allBodies, moonsOf, getBody } from '../sim/ephemeris.js';
import { TYPE_GLYPHS, existsAt } from '../sim/custom.js';
import { confirmModal } from './modal.js';
import { esc } from './format.js';

const GROUPS = [
  { key: 'custom', title: 'Custom objects' },
  { key: 'planets', title: 'Sun & planets', types: ['star', 'planet'] },
  { key: 'dwarf', title: 'Dwarf planets', types: ['dwarf'] },
  { key: 'asteroids', title: 'Asteroids', types: ['asteroid', 'trojan'] },
  { key: 'neo', title: 'Near-Earth objects', types: ['neo'] },
  { key: 'centaur', title: 'Centaurs', types: ['centaur'] },
  { key: 'comet', title: 'Comets', types: ['comet'] },
];
const UI_KEY = 'ssm.ui.sidebar';

/** @param {Object} app */
export function initSidebar(app) {
  const host = document.getElementById('object-list');
  let ui = { collapsed: { neo: true, centaur: true, comet: true, asteroids: false }, expanded: { earth: true } };
  try { ui = { ...ui, ...JSON.parse(localStorage.getItem(UI_KEY) || '{}') }; } catch { /* ignore */ }
  const saveUi = () => { try { localStorage.setItem(UI_KEY, JSON.stringify(ui)); } catch { /* ignore */ } };

  const bodies = allBodies();
  /** row elements by id for highlight / filter */
  let rows = new Map();

  function bodyRow(b, depth = 0) {
    const moons = moonsOf(b.id);
    const hasMoons = moons.length > 0;
    const exp = !!ui.expanded[b.id];
    const extra = b.type === 'trojan' ? '<span class="row-tag">Trojan</span>' : '';
    return `
      <div class="row-wrap" data-wrap="${b.id}">
        <div class="row depth-${depth}" data-id="${b.id}" role="button" tabindex="0" title="${esc(b.designation || b.name)}">
          ${hasMoons ? `<button class="twisty" data-twisty="${b.id}" aria-label="Toggle moons" aria-expanded="${exp}">${exp ? '▾' : '▸'}</button>` : '<span class="twisty-pad"></span>'}
          <span class="dot" style="background:${b.color}"></span>
          <span class="row-name">${esc(b.name)}</span>${extra}
          ${hasMoons ? `<span class="row-count">${moons.length}</span>` : ''}
        </div>
        ${hasMoons ? `<div class="children" ${exp ? '' : 'hidden'}>${moons.map((m) => bodyRow(getBody(m), depth + 1)).join('')}</div>` : ''}
      </div>`;
  }

  function customRows(objects) {
    if (!objects.length) return '<div class="empty">No custom objects yet.</div>';
    return objects.map((o) => `
      <div class="row-wrap" data-wrap="${esc(o.id)}">
        <div class="row custom" data-id="${esc(o.id)}" role="button" tabindex="0" title="${esc(o.name)}${o.tags?.length ? ' — ' + esc(o.tags.join(', ')) : ''}">
          <span class="twisty-pad"></span>
          <span class="dot" style="background:${esc(o.color)}"></span>
          <span class="glyph" style="color:${esc(o.color)}">${TYPE_GLYPHS[o.type] ?? '●'}</span>
          <span class="row-name">${esc(o.name)}</span>
          <span class="row-actions">
            <button class="icon-btn small" data-edit="${esc(o.id)}" title="Edit" aria-label="Edit ${esc(o.name)}">✎</button>
            <button class="icon-btn small" data-del="${esc(o.id)}" title="Delete" aria-label="Delete ${esc(o.name)}">🗑</button>
          </span>
        </div>
      </div>`).join('');
  }

  const listSig = (objects) => JSON.stringify(objects.map((o) => [o.id, o.name, o.color, o.type, o.tags]));
  let lastSig = '';

  function render() {
    const s = store.get();
    lastSig = listSig(s.objects);
    let html = '';
    for (const g of GROUPS) {
      const collapsed = !!ui.collapsed[g.key];
      let inner, count;
      if (g.key === 'custom') {
        inner = customRows(s.objects);
        count = s.objects.length;
      } else {
        const list = bodies.filter((b) => g.types.includes(b.type));
        inner = list.map((b) => bodyRow(b)).join('');
        count = list.length;
      }
      html += `
        <section class="group" data-group="${g.key}">
          <div class="group-head">
            <button class="group-toggle" data-group-toggle="${g.key}" aria-expanded="${!collapsed}">
              <span class="caret">${collapsed ? '▸' : '▾'}</span>${g.title}<span class="group-count">${count}</span>
            </button>
            ${g.key === 'custom' ? '<button class="btn tiny" data-new>＋ new</button>' : ''}
          </div>
          <div class="group-body" ${collapsed ? 'hidden' : ''}>${inner}</div>
        </section>`;
    }
    host.innerHTML = html;
    rows = new Map([...host.querySelectorAll('.row[data-id]')].map((r) => [r.dataset.id, r]));
    highlight();
    applyFilter();
    updateExistence();
  }

  function highlight() {
    const { selection, focus } = store.get();
    for (const [id, r] of rows) {
      r.classList.toggle('selected', id === selection);
      r.classList.toggle('focused', id === focus);
    }
  }

  function matches(id, q) {
    const b = getBody(id);
    if (b) return b.name.toLowerCase().includes(q) || (b.designation || '').toLowerCase().includes(q);
    const o = store.get().ctx.byId.get(id);
    return !!o && (o.name.toLowerCase().includes(q) || (o.tags || []).some((t) => t.toLowerCase().includes(q)) || o.type.includes(q));
  }

  /** Apply the search filter: show matching rows and their ancestors; expand groups while searching. */
  function applyFilter() {
    const q = store.get().search.trim().toLowerCase();
    const searching = q.length > 0;
    host.classList.toggle('searching', searching);
    for (const wrap of host.querySelectorAll('.row-wrap')) wrap.hidden = false;
    for (const sec of host.querySelectorAll('.group')) {
      const body = sec.querySelector('.group-body');
      body.hidden = searching ? false : !!ui.collapsed[sec.dataset.group];
      for (const ch of sec.querySelectorAll('.children')) ch.hidden = searching ? false : !ui.expanded[ch.parentElement.dataset.wrap];
    }
    if (!searching) { for (const sec of host.querySelectorAll('.group')) sec.hidden = false; return; }
    // bottom-up: a wrap is visible if it matches or any descendant does
    const wraps = [...host.querySelectorAll('.row-wrap')].reverse();
    for (const w of wraps) {
      const self = matches(w.dataset.wrap, q);
      const childVisible = [...w.querySelectorAll(':scope > .children > .row-wrap')].some((c) => !c.hidden);
      w.hidden = !(self || childVisible);
    }
    for (const sec of host.querySelectorAll('.group')) {
      sec.hidden = ![...sec.querySelectorAll('.row-wrap')].some((w) => !w.hidden);
    }
  }

  function updateExistence() {
    const { objects, jd } = store.get();
    for (const o of objects) rows.get(o.id)?.classList.toggle('inactive', !existsAt(o, jd));
  }

  host.addEventListener('click', async (ev) => {
    const t = ev.target;
    const tw = t.closest('[data-twisty]');
    if (tw) {
      ev.stopPropagation();
      const id = tw.dataset.twisty;
      ui.expanded[id] = !ui.expanded[id];
      saveUi();
      tw.textContent = ui.expanded[id] ? '▾' : '▸';
      tw.setAttribute('aria-expanded', String(!!ui.expanded[id]));
      const ch = tw.closest('.row-wrap').querySelector(':scope > .children');
      if (ch && !store.get().search.trim()) ch.hidden = !ui.expanded[id];
      return;
    }
    const gt = t.closest('[data-group-toggle]');
    if (gt) {
      const k = gt.dataset.groupToggle;
      ui.collapsed[k] = !ui.collapsed[k];
      saveUi();
      gt.querySelector('.caret').textContent = ui.collapsed[k] ? '▸' : '▾';
      gt.setAttribute('aria-expanded', String(!ui.collapsed[k]));
      if (!store.get().search.trim()) gt.closest('.group').querySelector('.group-body').hidden = !!ui.collapsed[k];
      return;
    }
    if (t.closest('[data-new]')) { app.openEditor(null); return; }
    const ed = t.closest('[data-edit]');
    if (ed) { ev.stopPropagation(); app.openEditor(ed.dataset.edit); return; }
    const del = t.closest('[data-del]');
    if (del) {
      ev.stopPropagation();
      const o = store.get().ctx.byId.get(del.dataset.del);
      if (o && await confirmModal('Delete object', `Delete “${o.name}”? This cannot be undone (export first if unsure).`, 'Delete')) {
        deleteObject(o.id);
        app.toast(`Deleted ${o.name}`, 'success');
      }
      return;
    }
    const row = t.closest('.row[data-id]');
    if (row) app.pick(row.dataset.id);
  });
  host.addEventListener('keydown', (ev) => {
    const row = ev.target.closest('.row[data-id]');
    if (row && (ev.key === 'Enter' || ev.key === ' ') && ev.target === row) {
      ev.preventDefault();
      app.pick(row.dataset.id);
    }
  });

  let lastExistUpdate = 0;
  store.subscribe((s, changed) => {
    if (changed.includes('objects') && listSig(s.objects) !== lastSig) render();
    else {
      if (changed.includes('selection') || changed.includes('focus')) {
        const b = s.selection && getBody(s.selection);
        if (changed.includes('selection') && b?.type === 'moon' && !ui.expanded[b.parent]) {
          ui.expanded[b.parent] = true;
          saveUi();
          const tw = host.querySelector(`[data-twisty="${b.parent}"]`);
          if (tw) { tw.textContent = '▾'; tw.setAttribute('aria-expanded', 'true'); }
          applyFilter();
        }
        highlight();
        const r = rows.get(s.selection);
        if (r && changed.includes('selection')) r.scrollIntoView({ block: 'nearest' });
      }
      if (changed.includes('search')) applyFilter();
    }
    if (changed.includes('jd') || changed.includes('objects')) {
      const now = performance.now();
      if (changed.includes('objects') || now - lastExistUpdate > 400) { lastExistUpdate = now; updateExistence(); }
    }
  });

  render();

  return {
    /** First row matching the current search, in display order. */
    firstMatch() {
      const q = store.get().search.trim().toLowerCase();
      if (!q) return null;
      const exact = [...rows.keys()].find((id) => {
        const b = getBody(id);
        const name = b ? b.name : store.get().ctx.byId.get(id)?.name;
        return name?.toLowerCase() === q;
      });
      if (exact) return exact;
      for (const [id, r] of rows) if (!r.closest('.row-wrap').hidden && matches(id, q)) return id;
      return null;
    },
  };
}
