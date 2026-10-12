// Top bar (scenario name, search, actions) and the view toolbar over the canvas (toggles, marker size, View menu).
import { store } from '../sim/store.js';

const CHIPS = [
  ['orbits', 'Orbits'], ['labels', 'Labels'], ['grid', 'Grid'], ['moons', 'Moons'],
  ['asteroids', 'Asteroids'], ['comets', 'Comets'], ['custom', 'Custom'],
];

/**
 * @param {Object} app application facade (see main.js)
 */
export function initTopbar(app) {
  const $ = (id) => document.getElementById(id);

  // ---- scenario name (click to edit)
  const nameBtn = $('scenario-name');
  const renderName = () => { nameBtn.textContent = store.get().scenarioName || 'Untitled scenario'; };
  renderName();
  nameBtn.addEventListener('click', () => {
    const input = document.createElement('input');
    input.className = 'scenario-name-input';
    input.value = store.get().scenarioName;
    input.maxLength = 80;
    nameBtn.replaceWith(input);
    input.focus();
    input.select();
    let done = false;
    const finish = (commit) => {
      if (done) return;
      done = true;
      const v = input.value.trim();
      if (commit && v) store.set({ scenarioName: v });
      input.replaceWith(nameBtn);
      renderName();
    };
    input.addEventListener('keydown', (ev) => {
      if (ev.key === 'Enter') finish(true);
      else if (ev.key === 'Escape') { ev.stopPropagation(); finish(false); }
    });
    input.addEventListener('blur', () => finish(true));
  });

  // ---- search
  const search = $('search');
  search.addEventListener('input', () => store.set({ search: search.value }));
  search.addEventListener('keydown', (ev) => {
    if (ev.key === 'Enter') {
      const id = app.sidebar.firstMatch();
      if (id) app.pick(id);
    } else if (ev.key === 'Escape') {
      search.value = '';
      store.set({ search: '' });
      search.blur();
    }
  });

  // ---- visibility chips
  const chips = $('toggle-chips');
  for (const [key, label] of CHIPS) {
    const b = document.createElement('button');
    b.className = 'chip';
    b.dataset.key = key;
    b.textContent = label;
    b.title = `Show/hide ${label.toLowerCase()}`;
    b.addEventListener('click', () => {
      const t = store.get().toggles;
      store.set({ toggles: { ...t, [key]: !t[key] } });
    });
    chips.appendChild(b);
  }
  const renderChips = () => {
    const t = store.get().toggles;
    for (const b of chips.children) b.setAttribute('aria-pressed', String(!!t[b.dataset.key]));
  };
  renderChips();

  // ---- marker size
  const slider = $('marker-size'), sliderVal = $('marker-size-val');
  const renderSlider = () => {
    const v = store.get().markerPx;
    slider.value = String(v);
    sliderVal.textContent = v === 0 ? 'true' : `${v}px`;
  };
  renderSlider();
  slider.addEventListener('input', () => store.set({ markerPx: Number(slider.value) }));

  // ---- View menu
  const menuBtn = $('view-menu-btn'), menu = $('view-menu');
  const closeMenu = () => { menu.hidden = true; menuBtn.setAttribute('aria-expanded', 'false'); };
  menuBtn.addEventListener('click', (ev) => {
    ev.stopPropagation();
    menu.hidden = !menu.hidden;
    menuBtn.setAttribute('aria-expanded', String(!menu.hidden));
  });
  menu.addEventListener('click', (ev) => {
    const b = ev.target.closest('button[data-view]');
    if (!b) return;
    app.view.setView(b.dataset.view);
    closeMenu();
  });
  document.addEventListener('click', (ev) => { if (!menu.hidden && !menu.contains(ev.target)) closeMenu(); });
  document.addEventListener('keydown', (ev) => { if (ev.key === 'Escape') closeMenu(); });

  // ---- actions
  $('btn-add').addEventListener('click', () => app.openEditor(null));
  $('btn-planner').addEventListener('click', () => app.openPlanner());
  $('btn-events').addEventListener('click', () => app.openEvents());
  $('btn-import').addEventListener('click', () => app.openImport());
  $('btn-export').addEventListener('click', () => app.exportScenario());
  $('btn-help').addEventListener('click', () => app.openHelp());

  // ---- sidebar collapse
  const appEl = $('app');
  const setCollapsed = (c) => {
    appEl.classList.toggle('left-collapsed', c);
    $('expand-left').hidden = !c;
    try { localStorage.setItem('ssm.ui.leftCollapsed', c ? '1' : '0'); } catch { /* ignore */ }
  };
  $('collapse-left').addEventListener('click', () => setCollapsed(true));
  $('expand-left').addEventListener('click', () => setCollapsed(false));
  try { if (localStorage.getItem('ssm.ui.leftCollapsed') === '1') setCollapsed(true); } catch { /* ignore */ }

  store.subscribe((s, changed) => {
    if (changed.includes('scenarioName')) renderName();
    if (changed.includes('toggles')) renderChips();
    if (changed.includes('markerPx')) renderSlider();
    if (changed.includes('search') && search.value !== s.search) search.value = s.search;
  });
}
