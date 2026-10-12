// Bootstrap: build the catalog, restore (or create) the scenario, start the 3D view and the UI.
import './styles.css';
import { buildCatalog } from './data/catalog.js';
import { initEphemeris, hasBody } from './sim/ephemeris.js';
import { store, selectAndFocus, deselect, toggleMultiSelect } from './sim/store.js';
import { nameOf } from './sim/custom.js';
import { loadFromStorage, applyScenario, exampleScenario, startAutosave, saveNow } from './sim/scenario.js';
import { createRenderer, focusDistanceFor } from './scene/renderer.js';
import { initTopbar } from './ui/topbar.js';
import { initSidebar } from './ui/sidebar.js';
import { initInspector } from './ui/inspector.js';
import { initTimebar } from './ui/timebar.js';
import { initTimeline } from './ui/timeline.js';
import { initPanels } from './ui/panels.js';
import { initCommandBar } from './ui/commandBar.js';
import { onTrajectoryUpdate } from './sim/trajectory.js';
import { toast } from './ui/toast.js';
import { openObjectEditor } from './ui/modals/objectEditor.js';
import { openPlanner } from './ui/modals/planner.js';
import { openEvents } from './ui/modals/events.js';
import { openImport, doExport, newScenario, loadExample } from './ui/modals/importExport.js';
import { openHelp } from './ui/modals/help.js';
import { openSetCourse } from './ui/modals/setCourse.js';
import { fmtAu, fmtKm } from './ui/format.js';
import { AU_KM } from './astro/constants.js';
import { initStoryTools } from './ui/storyTools.js';

initEphemeris(buildCatalog());

let firstRun = false;
if (!loadFromStorage()) {
  applyScenario(exampleScenario(), 'replace');
  firstRun = true;
}
// Guard against stale references in a restored view.
{
  const s = store.get();
  const valid = (id) => id && (hasBody(id) || s.ctx.byId.has(id));
  if (!valid(s.focus)) store.set({ focus: 'sun' });
  if (s.selection && !valid(s.selection)) store.set({ selection: null });
}
startAutosave();
if (firstRun) saveNow();

/** Application facade shared by UI modules. */
const app = {
  toast,
  view: null,
  sidebar: null,
  commands: null,
  /**
   * Click on an object anywhere: picks a command target while targeting, completes a pending measurement,
   * shift-click adds a custom object to the multi-selection, otherwise select + focus.
   */
  pick(id, ev = null) {
    const s = store.get();
    if (s.command && app.commands?.onPick(id)) return;
    if (s.measureArmed) {
      const a = s.measure?.a ?? s.selection;
      if (!a || a === id) { toast('Pick a different object to measure to.'); return; }
      store.set({ measure: { a, b: id }, measureArmed: false });
      toast(`Measuring ${nameOf(a, s.ctx)} ↔ ${nameOf(id, s.ctx)}`, 'success');
      return;
    }
    if (ev?.shiftKey && s.ctx.byId.has(id)) { toggleMultiSelect(id); return; }
    selectAndFocus(id);
  },
  /** Click on empty space: a point target while targeting, otherwise clear the selection. */
  emptyClick(ev) {
    if (store.get().command && app.commands?.onEmptyClick(ev)) return;
    if (store.get().measureArmed) return;
    if (!ev.shiftKey) deselect();
  },
  deselect,
  armMeasure() {
    const s = store.get();
    if (!s.selection) { toast('Select an object first.'); return; }
    store.set({ measure: { a: s.selection, b: null }, measureArmed: true });
  },
  openEditor: (id, prefill) => openObjectEditor(app, id, prefill),
  openPlanner: (init) => openPlanner(app, init),
  openEvents: (opts) => openEvents(app, opts),
  openImport: () => openImport(app),
  openHelp: () => openHelp(app),
  openSetCourse: (id) => openSetCourse(app, id),
  exportScenario: () => doExport(app),
  newScenario: () => newScenario(app),
  loadExample: () => loadExample(app),
  afterScenarioLoad() {
    const s = store.get();
    app.view.moveCamera({ id: s.focus, distance: s.cameraDistance ?? focusDistanceFor(s.focus, s.jd, s.ctx), recentre: true });
  },
};

app.view = createRenderer(document.getElementById('canvas-host'), {
  onPick: (id, ev) => app.pick(id, ev),
  onEmptyClick: (ev) => app.emptyClick(ev),
  onHover: (id, ev) => app.commands?.onHover(id, ev) ?? false,
});
// N-body trajectories arrive in the background: drop memoized custom-object positions (they were evaluated on the
// two-body arc) and redraw affected route paths. Registered before the UI so it runs before the inspector refresh.
onTrajectoryUpdate(() => {
  store.get().ctx.posCache.clear();
  app.view.refreshPaths();
});
initPanels(app);
app.sidebar = initSidebar(app);
initTopbar(app);
app.commands = initCommandBar(app);
initInspector(app);
initTimebar(app);
app.timeline = initTimeline(app);
// Story tools (auto milestones, situation report, light-lag view): see src/ui/storyTools.js
initStoryTools(app);

// ---- overlays: camera info + measurement banner
const camInfo = document.getElementById('camera-info');
let lastInfo = '', lastInfoT = 0;
app.view.onFrame(({ distance, panned }) => {
  const now = performance.now();
  if (now - lastInfoT < 200) return;
  lastInfoT = now;
  const d = distance < 0.01 ? fmtKm(distance * AU_KM) : fmtAu(distance);
  const txt = `camera ${d}${panned ? ' · panned (C re-centres)' : ''}`;
  if (txt !== lastInfo) { camInfo.textContent = txt; lastInfo = txt; }
});

const banner = document.getElementById('measure-banner');
function renderBanner() {
  const s = store.get();
  if (s.measureArmed) {
    banner.hidden = false;
    banner.innerHTML = `<span>Measuring from <b></b> — click the second object (Esc to cancel)</span><button class="icon-btn small" data-a="x" title="Cancel measuring" aria-label="Cancel">✕</button>`;
    banner.querySelector('b').textContent = nameOf(s.measure?.a, s.ctx);
  } else if (s.measure?.a && s.measure?.b) {
    banner.hidden = false;
    banner.innerHTML = `<span>Measure: <b data-f="a"></b> ↔ <b data-f="b"></b></span><button class="icon-btn small" data-a="x" title="Clear measurement" aria-label="Clear measurement">✕</button>`;
    banner.querySelector('[data-f=a]').textContent = nameOf(s.measure.a, s.ctx);
    banner.querySelector('[data-f=b]').textContent = nameOf(s.measure.b, s.ctx);
  } else banner.hidden = true;
}
banner.addEventListener('click', (ev) => { if (ev.target.closest('[data-a=x]')) store.set({ measure: null, measureArmed: false }); });
store.subscribe((_s, changed) => { if (changed.includes('measure') || changed.includes('measureArmed') || changed.includes('objects')) renderBanner(); });
renderBanner();

// Development-only handle for debugging from the browser console.
if (import.meta.env.DEV) window.__ssm = { store, app, applyScenario, exampleScenario };

if (firstRun) toast('Loaded the example scenario. Click any object to inspect it; press Help for controls.', 'info', 6000);
