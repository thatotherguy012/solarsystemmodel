// Top bar (scenario name, search, + Add, Scenario ▾, Tools ▾, Simple / Full switch, Help) and the view toolbar over
// the canvas (visibility chips, marker size, View menu with the rarely used layers, "Following: X" pill, first-run tip).
import { store, setDetail } from '../sim/store.js';
import { nameOf } from '../sim/custom.js';

const CHIPS = [
  ['orbits', 'Orbits', 'orbit lines'], ['labels', 'Labels', 'names'], ['moons', 'Moons', 'moons'],
  ['asteroids', 'Asteroids', 'named asteroids, near-Earth objects, Trojans and centaurs'], ['comets', 'Comets', 'comets'],
  ['custom', 'Custom', 'your ships, stations and bases'], ['belt', 'Belt', 'the asteroid-belt cloud (every asteroid larger than ~10 km)'],
];
const TIP_KEY = 'ssm.ui.tipDismissed';

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
  for (const [key, label, what] of CHIPS) {
    const b = document.createElement('button');
    b.className = 'chip';
    b.dataset.key = key;
    b.textContent = label;
    b.title = `Show or hide ${what}`;
    b.addEventListener('click', () => {
      const t = store.get().toggles;
      store.set({ toggles: { ...t, [key]: !t[key] } });
    });
    chips.appendChild(b);
  }

  // ---- marker size
  const slider = $('marker-size'), sliderVal = $('marker-size-val');
  const renderSlider = () => {
    const v = store.get().markerPx;
    slider.value = String(v);
    sliderVal.textContent = v === 0 ? 'true' : `${v}px`;
  };
  renderSlider();
  slider.addEventListener('input', () => store.set({ markerPx: Number(slider.value) }));

  // ---- drop-down menus (View, Scenario, Tools)
  const menus = [['view-menu-btn', 'view-menu'], ['scenario-menu-btn', 'scenario-menu'], ['tools-menu-btn', 'tools-menu']]
    .map(([b, m]) => ({ btn: $(b), menu: $(m) }));
  const closeMenus = () => {
    let any = false;
    for (const { btn, menu } of menus) {
      if (!menu.hidden) any = true;
      menu.hidden = true;
      btn.setAttribute('aria-expanded', 'false');
    }
    return any;
  };
  for (const { btn, menu } of menus) {
    btn.addEventListener('click', (ev) => {
      ev.stopPropagation();
      const open = menu.hidden;
      closeMenus();
      menu.hidden = !open;
      btn.setAttribute('aria-expanded', String(open));
    });
  }
  document.addEventListener('click', (ev) => {
    if (!menus.some(({ menu, btn }) => menu.contains(ev.target) || btn.contains(ev.target))) closeMenus();
  });
  app.closeMenus = closeMenus;

  $('view-menu').addEventListener('click', (ev) => {
    const tg = ev.target.closest('button[data-toggle]');
    if (tg) {
      const t = store.get().toggles;
      store.set({ toggles: { ...t, [tg.dataset.toggle]: !t[tg.dataset.toggle] } });
      return; // keep the menu open for further toggles
    }
    const b = ev.target.closest('button[data-view]');
    if (!b) return;
    app.view.setView(b.dataset.view);
    closeMenus();
  });
  $('scenario-menu').addEventListener('click', (ev) => {
    const a = ev.target.closest('button[data-act]')?.dataset.act;
    if (!a) return;
    closeMenus();
    if (a === 'import') app.openImport();
    else if (a === 'export') app.exportScenario();
    else if (a === 'new') app.newScenario();
    else if (a === 'example') app.loadExample();
  });
  $('tools-menu').addEventListener('click', (ev) => {
    const a = ev.target.closest('button[data-act]')?.dataset.act;
    if (!a) return;
    closeMenus();
    if (a === 'planner') app.openPlanner();
    else if (a === 'events') app.openEvents();
  });

  const renderToggles = () => {
    const t = store.get().toggles;
    for (const b of chips.children) b.setAttribute('aria-pressed', String(!!t[b.dataset.key]));
    for (const b of $('view-menu').querySelectorAll('[data-toggle]')) b.setAttribute('aria-checked', String(!!t[b.dataset.toggle]));
  };
  renderToggles();

  // ---- actions
  $('btn-add').addEventListener('click', () => app.openEditor(null));
  $('btn-help').addEventListener('click', () => app.openHelp());

  // ---- Simple / Full
  const sw = document.querySelector('.seg-switch');
  sw.addEventListener('click', (ev) => {
    const b = ev.target.closest('[data-detail]');
    if (b) setDetail(b.dataset.detail);
  });
  const renderDetail = () => {
    const d = store.get().detail;
    for (const b of sw.querySelectorAll('[data-detail]')) b.setAttribute('aria-pressed', String(b.dataset.detail === d));
    document.getElementById('app').dataset.detail = d;
  };
  renderDetail();

  // ---- "Following: X" pill
  const pill = $('follow-pill');
  const pillName = pill.querySelector('[data-f=name]');
  const sunBtn = pill.querySelector('[data-f=sun]'), reBtn = pill.querySelector('[data-f=recentre]');
  sunBtn.addEventListener('click', () => (store.get().focus === 'sun' ? app.view.recentre() : store.set({ focus: 'sun' })));
  reBtn.addEventListener('click', () => app.view.recentre());
  let lastPill = '';
  const renderPill = (panned = false) => {
    const s = store.get();
    const key = `${s.focus}|${panned}|${s.objects === lastObjs}`;
    if (key === lastPill) return;
    lastPill = key;
    lastObjs = s.objects;
    pillName.textContent = nameOf(s.focus, s.ctx);
    sunBtn.hidden = s.focus === 'sun' && !panned;
    sunBtn.textContent = s.focus === 'sun' ? 'Re-centre on the Sun' : 'Follow Sun';
    reBtn.hidden = !panned || s.focus === 'sun';
  };
  let lastObjs = null;
  renderPill();
  app.view.onFrame(({ panned }) => renderPill(panned));

  // ---- first-run tip strip
  const tipEl = $('tip-strip');
  let dismissed = false;
  try { dismissed = localStorage.getItem(TIP_KEY) === '1'; } catch { /* ignore */ }
  tipEl.hidden = dismissed;
  tipEl.querySelector('[data-f=dismiss]').addEventListener('click', () => {
    tipEl.hidden = true;
    try { localStorage.setItem(TIP_KEY, '1'); } catch { /* ignore */ }
  });

  store.subscribe((s, changed) => {
    if (changed.includes('scenarioName')) renderName();
    if (changed.includes('toggles')) renderToggles();
    if (changed.includes('markerPx')) renderSlider();
    if (changed.includes('detail')) renderDetail();
    if (changed.includes('focus') || changed.includes('objects')) { lastPill = ''; renderPill(); }
    if (changed.includes('search') && search.value !== s.search) search.value = s.search;
  });
}
