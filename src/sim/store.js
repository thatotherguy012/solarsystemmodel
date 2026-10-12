// Tiny observable application state. The single source of mutable app state (DESIGN.md §10).
import { createContext } from './custom.js';
import { nowJd } from '../astro/time.js';

/** Default visibility toggles. */
export const DEFAULT_TOGGLES = { orbits: true, labels: true, grid: true, moons: true, asteroids: true, comets: true, custom: true };

/**
 * @typedef {Object} AppState
 * @property {number} jd            current simulation time (JD, UTC-ish)
 * @property {boolean} playing
 * @property {number} rate          sim seconds per real second (negative = reverse)
 * @property {number} stepDays      step size for the step buttons
 * @property {string} focus         id the camera is centred on
 * @property {string|null} selection id shown in the inspector
 * @property {Object} toggles       { orbits, labels, grid, moons, asteroids, comets, custom }
 * @property {number} markerPx      minimum on-screen body radius (0 = true scale)
 * @property {{a:string,b:string}|null} measure
 * @property {boolean} measureArmed next pick sets measure endpoint b
 * @property {Object[]} objects     custom objects (§5)
 * @property {import('./custom.js').CustomContext} ctx evaluation context derived from objects
 * @property {Object[]} events      story events { id, jd, title, notes, color }
 * @property {string} scenarioName
 * @property {string} search        object-browser filter text
 * @property {number|null} cameraDistance last known camera distance (AU), persisted in the scenario view
 * @property {string[]} hiddenIds   bodies / custom objects hidden individually (eye toggles in the object list)
 * @property {boolean} sidebarCollapsed   object browser collapsed to a strip
 * @property {boolean} inspectorCollapsed inspector collapsed to a strip
 * @property {number|null} timelineSpan   visible span of the timeline strip (days); null = fit the events
 */

function createStore(initial) {
  let state = initial;
  const subs = new Set();
  return {
    /** @returns {AppState} */
    get: () => state,
    /**
     * Shallow-merge `patch` into the state and notify subscribers with the list of changed keys.
     * @param {Partial<AppState>} patch
     */
    set(patch) {
      const changed = [];
      for (const k of Object.keys(patch)) if (state[k] !== patch[k]) changed.push(k);
      if (!changed.length) return;
      if (patch.objects && patch.objects !== state.objects && !patch.ctx) patch = { ...patch, ctx: createContext(patch.objects) };
      if (patch.ctx && !changed.includes('ctx')) changed.push('ctx');
      state = { ...state, ...patch };
      for (const fn of subs) fn(state, changed);
    },
    /**
     * Subscribe to changes. Returns an unsubscribe function.
     * @param {(state:AppState, changed:string[]) => void} fn
     */
    subscribe(fn) {
      subs.add(fn);
      return () => subs.delete(fn);
    },
  };
}

export const store = createStore({
  jd: nowJd(),
  playing: false,
  rate: 86400,
  stepDays: 1,
  focus: 'sun',
  selection: null,
  toggles: { ...DEFAULT_TOGGLES },
  markerPx: 4,
  measure: null,
  measureArmed: false,
  objects: [],
  ctx: createContext([]),
  events: [],
  scenarioName: 'Untitled scenario',
  search: '',
  cameraDistance: null,
  hiddenIds: [],
  sidebarCollapsed: false,
  inspectorCollapsed: false,
  timelineSpan: null,
});

// ------------------------------------------------------------------ per-object visibility

let hiddenArr = null;
let hiddenSet = new Set();

/** The individually hidden ids as a Set (memoized on the store array). */
export function hiddenSetOf(state = store.get()) {
  if (state.hiddenIds !== hiddenArr) { hiddenArr = state.hiddenIds; hiddenSet = new Set(hiddenArr); }
  return hiddenSet;
}

/** Hide (hidden = true) or show the given ids. */
export function setHidden(ids, hidden) {
  const set = new Set(store.get().hiddenIds);
  for (const id of ids) { if (hidden) set.add(id); else set.delete(id); }
  store.set({ hiddenIds: [...set] });
}

/** Toggle one id's individual visibility. */
export function toggleHidden(id) {
  setHidden([id], !hiddenSetOf().has(id));
}

// ------------------------------------------------------------------ actions

/** Generate a unique id. */
export function newId() {
  if (globalThis.crypto?.randomUUID) return crypto.randomUUID();
  return 'id-' + Math.random().toString(36).slice(2) + Date.now().toString(36);
}

/** Select an object and centre the camera on it (the single click behaviour). */
export function selectAndFocus(id) {
  if (!id) return;
  store.set({ selection: id, focus: id });
}

/** Insert or replace a custom object. */
export function upsertObject(obj) {
  const list = store.get().objects;
  const i = list.findIndex((o) => o.id === obj.id);
  const next = i >= 0 ? list.map((o) => (o.id === obj.id ? obj : o)) : [...list, obj];
  store.set({ objects: next });
}

/** Patch fields of a custom object without touching its motion (e.g. notes autosave). */
export function patchObject(id, patch) {
  const list = store.get().objects;
  store.set({ objects: list.map((o) => (o.id === id ? { ...o, ...patch } : o)) });
}

/** Delete a custom object; clears selection/focus/measure references to it. */
export function deleteObject(id) {
  const s = store.get();
  const patch = { objects: s.objects.filter((o) => o.id !== id) };
  if (s.selection === id) patch.selection = null;
  if (s.focus === id) patch.focus = 'sun';
  if (s.measure && (s.measure.a === id || s.measure.b === id)) patch.measure = null;
  if (s.hiddenIds.includes(id)) patch.hiddenIds = s.hiddenIds.filter((x) => x !== id);
  store.set(patch);
}

/** Insert or replace a story event (kept sorted by date). */
export function upsertEvent(ev) {
  const list = store.get().events.filter((e) => e.id !== ev.id);
  list.push(ev);
  list.sort((a, b) => a.jd - b.jd);
  store.set({ events: list });
}

export function deleteEvent(id) {
  store.set({ events: store.get().events.filter((e) => e.id !== id) });
}
