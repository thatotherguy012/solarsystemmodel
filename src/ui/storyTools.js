// Story tools: automatic route milestones on the timeline, the situation report, and the light-lag "as seen from"
// view. One entry point (initStoryTools) wires them into the app; each feature lives in its own module:
//   src/sim/milestones.js + src/ui/timelineMilestones.js + src/ui/milestonesSection.js (Events dialog)
//   src/sim/report.js + src/ui/modals/report.js
//   src/sim/lightlag.js + src/scene/lightlag.js
// The controls add themselves to the existing DOM (a chip group in the view toolbar, a toggle next to the
// timeline's event buttons); the situation report is an item of the Tools menu.
import '../styles-story-tools.css';
import { store } from '../sim/store.js';
import { positionOf, nameOf } from '../sim/custom.js';
import { startMilestones } from '../sim/milestones.js';
import { createLightLagView } from '../scene/lightlag.js';
import { initTimelineMilestones } from './timelineMilestones.js';
import { openReport } from './modals/report.js';

const LL_KEY = 'ssm.ui.lightLag';
const LL_PLANETS_KEY = 'ssm.ui.lightLagPlanets';

const getFlag = (k, dflt) => { try { const v = localStorage.getItem(k); return v == null ? dflt : v === '1'; } catch { return dflt; } };
const setFlag = (k, v) => { try { localStorage.setItem(k, v ? '1' : '0'); } catch { /* ignore */ } };

/**
 * Wire the story tools into the app. Call once, after the renderer, top bar and timeline exist.
 * @param {Object} app application facade from main.js (needs view, timeline, toast)
 */
export function initStoryTools(app) {
  startMilestones();
  app.timelineMilestones = initTimelineMilestones(app);
  app.openReport = () => openReport(app);
  addReportButton(app);
  app.lightLag = initLightLag(app);
}

// ------------------------------------------------------------------ situation report entry

function addReportButton(app) {
  // v3 layout: the entry is a static item of the Tools menu (index.html, handled by topbar.js)
  if (document.querySelector('#tools-menu [data-act=report]')) return;
  const btn = document.createElement('button');
  btn.id = 'btn-report';
  btn.className = 'btn';
  btn.type = 'button';
  btn.textContent = 'Situation report…';
  btn.title = 'Situation report: status, positions, distances, signal delays and upcoming milestones as Markdown';
  btn.addEventListener('click', () => app.openReport());
  const events = document.getElementById('btn-events');
  if (events) events.after(btn);
  else document.querySelector('#topbar .actions')?.appendChild(btn);
}

// ------------------------------------------------------------------ light-lag view

function initLightLag(app) {
  const scene = app.view?._debug?.scene;
  const canvasHost = document.getElementById('canvas-host');
  if (!scene || !canvasHost) return null;
  // The renderer places everything relative to the focus F and puts the Sun's light at -F every frame; read F back
  // from that light (fallback: the focused object's position, exact except during the 0.6 s focus transition).
  const light = scene.children.find((c) => c.isPointLight);
  const focusOffset = () => {
    if (light) return [-light.position.x, -light.position.y, -light.position.z];
    const s = store.get();
    return positionOf(s.focus, s.jd, s.ctx) ?? [0, 0, 0];
  };
  // view size from a ResizeObserver (reading clientWidth every frame would force a synchronous layout)
  const size = { width: canvasHost.clientWidth || 1, height: canvasHost.clientHeight || 1 };
  new ResizeObserver(() => { size.width = canvasHost.clientWidth || 1; size.height = canvasHost.clientHeight || 1; }).observe(canvasHost);
  const view = createLightLagView({
    scene,
    camera: () => app.view.camera,
    viewport: () => size,
    getState: () => store.get(),
    focusOffset,
    isVisible: (id) => app.view.isVisibleAt(id),
    // the app's visible labels (last frame), as placed by the renderer's declutter: text right of the marker
    labelObstacles: () => (app.view.items || []).filter((it) => it.label?.visible && it.labelW).map((it) => {
      const x0 = it.kind === 'grid' ? it.x : it.x + Math.min(it.r || 0, 400) + 4;
      return [x0, it.y - 5, x0 + it.labelW, it.y + 5];
    }),
  });

  // chip group in the view toolbar
  const wrap = document.createElement('div');
  wrap.className = 'chips ll-chips';
  wrap.setAttribute('role', 'group');
  wrap.setAttribute('aria-label', 'Light-lag view');
  wrap.innerHTML = `
    <button class="chip" type="button" data-ll="main" title="Light-lag view: show where the selected object's sensors see every other object now — each ghost marks a position the light left minutes or hours ago">Light-lag view</button>
    <button class="chip" type="button" data-ll="planets" title="Also show light-lag ghosts of the eight planets">+ planets</button>
    <span class="ll-caption" data-ll="caption"></span>`;
  // v3 layout: in the view toolbar row, before the "Following: X" pill (the tip strip wraps below)
  const overlay = canvasHost.parentElement?.querySelector('.overlay-top');
  const pill = overlay?.querySelector('#follow-pill');
  if (pill) pill.before(wrap);
  else (overlay ?? canvasHost.parentElement ?? document.body).appendChild(wrap);
  const mainChip = wrap.querySelector('[data-ll=main]');
  const planetsChip = wrap.querySelector('[data-ll=planets]');
  const caption = wrap.querySelector('[data-ll=caption]');

  let on = getFlag(LL_KEY, false);
  let planets = getFlag(LL_PLANETS_KEY, false);

  function renderCaption() {
    const s = store.get();
    caption.hidden = !on;
    if (!on) return;
    caption.textContent = s.selection ? `as seen from ${nameOf(s.selection, s.ctx)}` : 'select an observer';
    caption.classList.toggle('warn', !s.selection);
  }
  function apply() {
    mainChip.setAttribute('aria-pressed', String(on));
    planetsChip.setAttribute('aria-pressed', String(planets));
    planetsChip.hidden = !on;
    view.setEnabled(on);
    view.setPlanets(planets);
    renderCaption();
  }
  mainChip.addEventListener('click', () => {
    on = !on;
    setFlag(LL_KEY, on);
    apply();
    if (on && !store.get().selection) app.toast('Light-lag view: select the observer (a ship, station or body).');
  });
  planetsChip.addEventListener('click', () => {
    planets = !planets;
    setFlag(LL_PLANETS_KEY, planets);
    apply();
  });
  store.subscribe((_s, changed) => { if (changed.includes('selection') || changed.includes('objects')) renderCaption(); });
  apply();
  return view;
}

// ------------------------------------------------------------------ help text

/** Help-dialog section describing the story tools (HTML). */
export function storyToolsHelpHtml() {
  return `<section>
        <h3>Story tools</h3>
        <ul>
          <li><b>Auto milestones</b>: departures, arrivals (intercepts with their closing speed), flips (turnover of brachistochrone legs at the midpoint, of torch legs at the computed flip), flybys, close approaches inside two sphere-of-influence radii, impacts, course changes and engine cuts are derived from every route and drawn as hollow ticks in the object's colour below the story events on the timeline (hover for details, click to jump). The <b>Auto milestones</b> button next to the timeline's event buttons hides them. They are listed under <b>Derived milestones</b> in the Events dialog; they update when routes change and are never saved.</li>
          <li><b>Tools ▾ → Situation report…</b> writes a Markdown report for any date: each object's status in plain language (“En route Earth → Mars, arrives … (in 4.2 d), 612 km/s”), its position, distance from the Sun and Earth and signal delay to Earth, a table of distances and one-way signal delays between everything included, and the milestones and story events coming up. Copy it or download it as a <code>.md</code> file.</li>
          <li><b>Light-lag view</b> (chip above the view): select an observer and every other visible object gets a dashed ghost marker at its <i>retarded</i> position — where it was when the light now reaching the observer left it (τ = |r(t − τ) − r<sub>obs</sub>(t)| / c) — joined to its true position and labelled “seen 4 min 12 s ago”; <b>+ planets</b> adds the planets. This is what the observer's telescopes and sensors show right now, and the picture any hard-SF commander has to fight with: the enemy is never where you see it.</li>
        </ul>
      </section>`;
}
