// Scenario persistence: serialize/validate/apply, localStorage autosave, JSON export, example scenario. §9.
import { store, newId, DEFAULT_TOGGLES } from './store.js';
import { createContext, resolveRoute, MOTION_KINDS, OBJECT_TYPES } from './custom.js';
import { nowJd, parseDateToJd } from '../astro/time.js';

export const STORAGE_KEY = 'ssm.scenario.v1';
export const SCENARIO_VERSION = 1;

/** Serialize the current state into a scenario document. */
export function serializeScenario(state = store.get()) {
  return {
    version: SCENARIO_VERSION,
    name: state.scenarioName,
    savedAt: new Date().toISOString(),
    objects: state.objects,
    events: state.events,
    view: {
      jd: state.jd, focus: state.focus, selection: state.selection, toggles: state.toggles,
      markerPx: state.markerPx, cameraDistance: state.cameraDistance ?? null,
      hiddenIds: state.hiddenIds, sidebarCollapsed: state.sidebarCollapsed, inspectorCollapsed: state.inspectorCollapsed,
      timelineSpan: state.timelineSpan ?? null,
    },
  };
}

/**
 * Validate a parsed scenario document.
 * @returns {{ok:boolean, errors:string[], scenario?:Object}}
 */
export function validateScenario(doc) {
  const errors = [];
  if (!doc || typeof doc !== 'object') return { ok: false, errors: ['Not a JSON object.'] };
  if (doc.version !== SCENARIO_VERSION) errors.push(`Unsupported scenario version ${JSON.stringify(doc.version)} (expected ${SCENARIO_VERSION}).`);
  if (!Array.isArray(doc.objects)) errors.push('"objects" must be an array.');
  if (doc.events !== undefined && !Array.isArray(doc.events)) errors.push('"events" must be an array.');
  if (errors.length) return { ok: false, errors };
  const objects = [];
  doc.objects.forEach((o, i) => {
    if (!o || typeof o !== 'object') { errors.push(`objects[${i}] is not an object.`); return; }
    if (!o.motion || !MOTION_KINDS.includes(o.motion.kind)) { errors.push(`objects[${i}] (${o.name ?? 'unnamed'}): unknown motion kind.`); return; }
    if (o.motion.kind === 'route' && !Array.isArray(o.motion.stops)) { errors.push(`objects[${i}] (${o.name ?? 'unnamed'}): route without stops.`); return; }
    objects.push({
      id: String(o.id ?? newId()), name: String(o.name ?? 'Unnamed'), type: OBJECT_TYPES.includes(o.type) ? o.type : 'other',
      color: typeof o.color === 'string' ? o.color : '#ff8800', notes: String(o.notes ?? ''),
      tags: Array.isArray(o.tags) ? o.tags.map(String) : [],
      existsFromJd: Number.isFinite(o.existsFromJd) ? o.existsFromJd : null,
      existsUntilJd: Number.isFinite(o.existsUntilJd) ? o.existsUntilJd : null,
      showPath: o.showPath !== false, motion: o.motion,
      ...(validDrive(o.drive) ? { drive: validDrive(o.drive) } : {}),
    });
  });
  const events = [];
  (doc.events ?? []).forEach((e, i) => {
    if (!e || !Number.isFinite(e.jd)) { errors.push(`events[${i}] has no numeric jd.`); return; }
    events.push({ id: String(e.id ?? newId()), jd: e.jd, title: String(e.title ?? 'Event'), notes: String(e.notes ?? ''), color: typeof e.color === 'string' ? e.color : '#ffcc66' });
  });
  return { ok: true, errors, scenario: { version: SCENARIO_VERSION, name: String(doc.name ?? 'Imported scenario'), objects, events, view: doc.view ?? null } };
}

/** A drive record { kind: 'torch', accelG } | { kind: 'coast' } | { kind: 'none' }, or null when invalid / absent. */
function validDrive(d) {
  if (!d || typeof d !== 'object') return null;
  if (d.kind === 'torch') return { kind: 'torch', accelG: Number(d.accelG) > 0 ? Number(d.accelG) : 0.3 };
  if (d.kind === 'coast' || d.kind === 'none') return { kind: d.kind };
  return null;
}

function remapRefs(motion, map) {
  const m = structuredClone(motion);
  const r = (id) => (id != null && map.has(id) ? map.get(id) : id);
  if (m.kind === 'orbit' || m.kind === 'colocated') m.parent = r(m.parent);
  if (m.kind === 'route') {
    m.stops = m.stops.map((s) => {
      const out = { ...s, ref: r(s.ref) };
      if (s.aborted) out.aborted = { ...s.aborted, ref: r(s.aborted.ref) };
      if (s.kind === 'hold' && s.motion) out.motion = remapRefs(s.motion, map);
      return out;
    });
  }
  return m;
}

/**
 * Apply a validated scenario to the store.
 * @param {Object} sc validated scenario
 * @param {'replace'|'merge'} mode
 */
export function applyScenario(sc, mode = 'replace') {
  const s = store.get();
  if (mode === 'merge') {
    const used = new Set([...s.objects.map((o) => o.id), ...s.events.map((e) => e.id)]);
    const map = new Map();
    for (const o of sc.objects) if (used.has(o.id)) map.set(o.id, newId());
    const objects = sc.objects.map((o) => ({ ...o, id: map.get(o.id) ?? o.id, motion: remapRefs(o.motion, map) }));
    const events = sc.events.map((e) => (used.has(e.id) ? { ...e, id: newId() } : e));
    store.set({ objects: [...s.objects, ...objects], events: [...s.events, ...events].sort((a, b) => a.jd - b.jd) });
    return;
  }
  const v = sc.view || {};
  const objects = sc.objects;
  let legacyLeft = false; // the left-panel state used to live in localStorage only
  try { legacyLeft = localStorage.getItem('ssm.ui.leftCollapsed') === '1'; } catch { /* ignore */ }
  store.set({
    scenarioName: sc.name,
    objects,
    ctx: createContext(objects),
    events: [...sc.events].sort((a, b) => a.jd - b.jd),
    jd: Number.isFinite(v.jd) ? v.jd : s.jd,
    focus: typeof v.focus === 'string' ? v.focus : 'sun',
    selection: typeof v.selection === 'string' ? v.selection : null,
    toggles: { ...DEFAULT_TOGGLES, ...(v.toggles || {}) },
    markerPx: Number.isFinite(v.markerPx) ? v.markerPx : 4,
    cameraDistance: Number.isFinite(v.cameraDistance) ? v.cameraDistance : null,
    hiddenIds: Array.isArray(v.hiddenIds) ? v.hiddenIds.filter((x) => typeof x === 'string') : [],
    // panel layout: keep the current layout when the document does not specify one (new / example scenario)
    sidebarCollapsed: typeof v.sidebarCollapsed === 'boolean' ? v.sidebarCollapsed : (s.sidebarCollapsed || legacyLeft),
    inspectorCollapsed: typeof v.inspectorCollapsed === 'boolean' ? v.inspectorCollapsed : s.inspectorCollapsed,
    timelineSpan: Number.isFinite(v.timelineSpan) && v.timelineSpan > 0 ? v.timelineSpan : null,
    measure: null,
    measureArmed: false,
    playing: false,
    multiSelection: [],
    command: null,
  });
}

/** Load the autosaved scenario, if any. Returns true when one was applied. */
export function loadFromStorage() {
  let raw = null;
  try { raw = localStorage.getItem(STORAGE_KEY); } catch { return false; }
  if (!raw) return false;
  try {
    const res = validateScenario(JSON.parse(raw));
    if (!res.ok) return false;
    applyScenario(res.scenario, 'replace');
    return true;
  } catch {
    return false;
  }
}

/** Write the current scenario to localStorage now. */
export function saveNow() {
  try {
    localStorage.setItem(STORAGE_KEY, JSON.stringify(serializeScenario()));
    return true;
  } catch {
    return false;
  }
}

const SAVE_KEYS = new Set(['objects', 'events', 'jd', 'focus', 'selection', 'toggles', 'markerPx', 'scenarioName', 'cameraDistance',
  'hiddenIds', 'sidebarCollapsed', 'inspectorCollapsed', 'timelineSpan']);

/** Debounced (500 ms, max wait 3 s) autosave on any persisted change. */
export function startAutosave() {
  let timer = null, firstPending = 0;
  store.subscribe((_s, changed) => {
    if (!changed.some((k) => SAVE_KEYS.has(k))) return;
    const now = performance.now();
    if (!timer) firstPending = now;
    clearTimeout(timer);
    const wait = now - firstPending > 3000 ? 0 : 500;
    timer = setTimeout(() => { timer = null; saveNow(); }, wait);
  });
  window.addEventListener('beforeunload', () => { if (timer) saveNow(); });
}

/** File name for exports: "<name>.solarsystem.json". */
export function exportFileName(name) {
  const base = (name || 'scenario').trim().replace(/[\\/:*?"<>|]+/g, '-').replace(/\s+/g, ' ') || 'scenario';
  return `${base}.solarsystem.json`;
}

/** Trigger a download of the current scenario as pretty-printed JSON. Returns the file name. */
export function exportScenario() {
  const doc = serializeScenario();
  const blob = new Blob([JSON.stringify(doc, null, 2)], { type: 'application/json' });
  const url = URL.createObjectURL(blob);
  const a = document.createElement('a');
  a.href = url;
  a.download = exportFileName(doc.name);
  document.body.appendChild(a);
  a.click();
  a.remove();
  setTimeout(() => URL.revokeObjectURL(url), 5000);
  return a.download;
}

/** An empty scenario document. */
export function emptyScenario() {
  return { version: SCENARIO_VERSION, name: 'Untitled scenario', objects: [], events: [], view: { jd: nowJd(), focus: 'sun', cameraDistance: 3.5 } };
}

/**
 * Example scenario relative to today (00:00 UTC). Route arrivals are solved with the §5 solver so the
 * example is self-consistent.
 */
export function exampleScenario() {
  const t = Math.floor(nowJd() - 0.5) + 0.5; // today 00:00 UTC
  const ctx = createContext([]);
  const solve = (profile, accelG, stops) => {
    const res = resolveRoute({ profile, accelG, stops }, ctx, parseDateToJd);
    // Round solved times to the minute for tidy display.
    return res.stops.map((s) => ({
      ...s,
      arriveJd: s.arriveJd == null ? null : Math.round(s.arriveJd * 1440) / 1440,
      departJd: s.departJd == null ? null : Math.round(s.departJd * 1440) / 1440,
    }));
  };
  const ardentStops = solve('brachistochrone', 0.3, [
    { ref: 'earth', departStr: String(t + 10) },
    { ref: 'mars', arriveStr: '', departStr: '+20' },
    { ref: 'ceres', arriveStr: '' },
  ]);
  const farStops = solve('brachistochrone', 0.01, [
    { ref: 'earth', departStr: String(t + 60) },
    { ref: 'neptune', arriveStr: '' },
  ]);
  const base = { notes: '', tags: [], existsFromJd: null, existsUntilJd: null, showPath: true };
  const objects = [
    { ...base, id: 'ex-gateway', name: 'Gateway Station', type: 'station', color: '#5aa9ff', tags: ['Civil'],
      notes: 'Geostationary-altitude transfer hub (drawn in the ecliptic plane).',
      motion: { kind: 'orbit', parent: 'earth', aKm: 42164, e: 0, iDeg: 0, omDeg: 0, wDeg: 0, m0Deg: 0, epochJd: t } },
    { ...base, id: 'ex-yards', name: 'Tsiolkovsky Yards', type: 'habitat', color: '#b48cff', tags: ['Industry'],
      notes: 'Shipyard at Earth–Moon L2.', motion: { kind: 'lagrange', primary: 'earth', secondary: 'moon', point: 'L2' } },
    { ...base, id: 'ex-ardent', name: 'Ardent', type: 'ship', color: '#ff8a3d', tags: ['Navy', 'Act 1'], drive: { kind: 'torch', accelG: 0.3 },
      notes: 'Fast courier. 0.3 g torch drive, flip-and-burn.', motion: { kind: 'route', profile: 'brachistochrone', accelG: 0.3, stops: ardentStops } },
    { ...base, id: 'ex-hermes', name: 'Hermes', type: 'ship', color: '#e8d44d', tags: ['Freight'], drive: { kind: 'coast' },
      notes: 'Slow freighter, Hohmann-ish.',
      motion: { kind: 'route', profile: 'ballistic', stops: [
        { ref: 'earth', arriveJd: null, departJd: t + 30 },
        { ref: 'mars', arriveJd: t + 30 + 240, departJd: null },
      ] } },
    { ...base, id: 'ex-olympus', name: 'Olympus Base', type: 'base', color: '#ff6b6b', tags: ['Colony'],
      notes: 'Surface settlement on the flank of Olympus Mons.', motion: { kind: 'colocated', parent: 'mars', label: 'Surface' } },
    { ...base, id: 'ex-perimeter', name: 'Perimeter Watch', type: 'fleet', color: '#4fd18b', tags: ['Navy'], drive: { kind: 'torch', accelG: 0.5 },
      notes: 'Picket squadron just outside Callisto’s orbit.',
      motion: { kind: 'orbit', parent: 'jupiter', aKm: 1.9e6, e: 0, iDeg: 2, omDeg: 0, wDeg: 0, m0Deg: 0, epochJd: t } },
    { ...base, id: 'ex-farhorizon', name: 'Far Horizon', type: 'probe', color: '#7fe3ff', tags: ['Science'], drive: { kind: 'torch', accelG: 0.01 },
      notes: 'Uncrewed 0.01 g fusion probe to Neptune.', motion: { kind: 'route', profile: 'brachistochrone', accelG: 0.01, stops: farStops } },
    { ...base, id: 'ex-vesta', name: 'Vesta Mining Camp', type: 'base', color: '#d6a35c', tags: ['Industry'],
      notes: 'Regolith processing outpost.', motion: { kind: 'colocated', parent: 'vesta', label: 'Surface' } },
  ];
  const events = [
    { id: 'ev-ardent-dep', jd: t + 10, title: 'Ardent departs Earth', notes: '', color: '#ff8a3d' },
    { id: 'ev-ardent-arr', jd: ardentStops[1].arriveJd, title: 'Ardent arrives Mars', notes: '', color: '#ff8a3d' },
    { id: 'ev-hermes-dep', jd: t + 30, title: 'Hermes departs', notes: '', color: '#e8d44d' },
    { id: 'ev-opposition', jd: t + 400, title: 'Opposition watch', notes: '', color: '#5aa9ff' },
  ];
  return {
    version: SCENARIO_VERSION, name: 'Example scenario', objects, events,
    view: { jd: t, focus: 'sun', selection: null, toggles: { ...DEFAULT_TOGGLES }, markerPx: 4, cameraDistance: 3.5 },
  };
}
