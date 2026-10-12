// Object editor modal: create/edit custom objects with all five motion kinds and live route validation. §8.
import { AU_KM, DEG, G0_M_S2, auDay2ToMS2 } from '../../astro/constants.js';
import { formatJd, parseDateToJd } from '../../astro/time.js';
import { periodDays } from '../../astro/kepler.js';
import { vdist } from '../../astro/vec3.js';
import { store, newId, upsertObject, deleteObject, selectAndFocus } from '../../sim/store.js';
import { getBody, equatorialPlane, getPosition } from '../../sim/ephemeris.js';
import { OBJECT_TYPES, TYPE_GLYPHS, resolveRoute, positionOf, muOf, nameOf, idExists } from '../../sim/custom.js';
import { onTrajectoryUpdate } from '../../sim/trajectory.js';
import { ballisticSummary, auditSummary, stopGravity } from '../../sim/legPhysics.js';
import { openModal, confirmModal, h } from '../modal.js';
import { refPicker, FIXED_REF } from '../components.js';
import { fmtKm, fmtDist, fmtKmS, fmtG, fmtDuration, fmtSpeedKmS, fmtAu, fmtMkm, esc } from '../format.js';
import { ballisticHtml, auditHtml, flybysHtml, routeDeltaVHtml, fmtPct } from '../legInfo.js';
import { auDayToKmS } from '../../astro/constants.js';

const PALETTE = ['#ff8a3d', '#e8d44d', '#4fd18b', '#5aa9ff', '#7fe3ff', '#b48cff', '#ff6b6b', '#ff7fd1', '#d6a35c', '#cfd6e0'];
const TYPE_COLORS = { ship: '#ff8a3d', fleet: '#4fd18b', station: '#5aa9ff', habitat: '#b48cff', base: '#ff6b6b', probe: '#7fe3ff', other: '#cfd6e0' };
const KIND_LABELS = { orbit: 'Orbit', colocated: 'Co-located', lagrange: 'Lagrange point', fixed: 'Fixed point', route: 'Route' };

/** Orbit presets; `parent: '*'` applies to any body. */
const ORBIT_PRESETS = [
  { id: 'leo', label: 'LEO — 400 km altitude', parent: 'earth', altKm: 400 },
  { id: 'meo', label: 'MEO (GPS-like) — 20,200 km alt., equatorial', parent: 'earth', altKm: 20200, equatorial: true },
  { id: 'geo', label: 'Geostationary — a = 42,164 km, equatorial', parent: 'earth', aKm: 42164, equatorial: true },
  { id: 'lunar100', label: 'Low lunar orbit — 100 km', parent: 'moon', altKm: 100 },
  { id: 'nrho', label: 'Lunar high orbit — 10,000 km alt.', parent: 'moon', altKm: 10000 },
  { id: 'lmo', label: 'Low Mars orbit — 400 km', parent: 'mars', altKm: 400 },
  { id: 'areo', label: 'Areostationary — 17,032 km alt., equatorial', parent: 'mars', altKm: 17032, equatorial: true },
  { id: 'low', label: 'Low orbit — altitude 10% of radius', parent: '*', altFrac: 0.1 },
  { id: 'loweq', label: 'Low equatorial orbit — altitude 10% of radius', parent: '*', altFrac: 0.1, equatorial: true, needsPole: true },
  { id: 'high', label: 'High orbit — 10 radii', parent: '*', aFrac: 10 },
];
const LAGRANGE_PAIRS = [['sun', 'earth'], ['earth', 'moon'], ['sun', 'mars'], ['sun', 'jupiter']];

const jdStr = (jd) => (jd == null ? '' : formatJd(jd).replace(' UTC', ''));
const num = (v, d = 0) => { const x = parseFloat(v); return Number.isFinite(x) ? x : d; };

/** Build an editable draft from an object (or defaults). */
function toDraft(o, s) {
  const sel = s.selection && getBody(s.selection) && s.selection !== 'sun' ? s.selection : 'earth';
  const base = o ?? {
    id: newId(), name: '', type: 'ship', color: TYPE_COLORS.ship, notes: '', tags: [], existsFromJd: null, existsUntilJd: null,
    showPath: true, motion: null,
  };
  const d = {
    isNew: !o, id: base.id, name: base.name, type: base.type, color: base.color, notes: base.notes ?? '',
    tagsStr: (base.tags || []).join(', '), fromStr: jdStr(base.existsFromJd), untilStr: jdStr(base.existsUntilJd),
    showPath: base.showPath !== false, kind: base.motion?.kind ?? 'orbit',
    orbit: { parent: sel, aKm: '', altKm: '', e: '0', iDeg: '0', omDeg: '0', wDeg: '0', m0Deg: '0', epochStr: jdStr(s.jd) },
    colocated: { parent: sel, label: 'Surface' },
    lagrange: { primary: 'sun', secondary: 'earth', point: 'L2' },
    fixed: { x: '', y: '', z: '', unit: 'AU' },
    route: { profile: 'brachistochrone', accelG: '0.3', stops: [
      { ref: 'earth', x: '', y: '', z: '', arriveStr: '', departStr: jdStr(s.jd), parkAltStr: '', flyby: false },
      { ref: 'mars', x: '', y: '', z: '', arriveStr: '', departStr: '', parkAltStr: '', flyby: false },
    ] },
  };
  const R = getBody(sel)?.radiusKm ?? 6371;
  d.orbit.altKm = sel === 'earth' ? '400' : String(Math.round(R * 0.1));
  d.orbit.aKm = String(Number(d.orbit.altKm) + R);
  const m = base.motion;
  if (m?.kind === 'orbit') {
    const Rp = getBody(m.parent)?.radiusKm ?? 0;
    d.orbit = { parent: m.parent, aKm: String(m.aKm), altKm: String(+(m.aKm - Rp).toFixed(3)), e: String(m.e ?? 0), iDeg: String(m.iDeg ?? 0),
      omDeg: String(m.omDeg ?? 0), wDeg: String(m.wDeg ?? 0), m0Deg: String(m.m0Deg ?? 0), epochStr: jdStr(m.epochJd) };
  } else if (m?.kind === 'colocated') d.colocated = { parent: m.parent, label: m.label ?? '' };
  else if (m?.kind === 'lagrange') d.lagrange = { primary: m.primary, secondary: m.secondary, point: m.point };
  else if (m?.kind === 'fixed') d.fixed = { x: String(m.x), y: String(m.y), z: String(m.z), unit: 'AU' };
  else if (m?.kind === 'route') {
    d.route = {
      profile: m.profile, accelG: m.accelG != null ? String(m.accelG) : '',
      stops: m.stops.map((st, i) => {
        const flyby = !!st.flyby || (i > 0 && i < m.stops.length - 1 && st.arriveJd != null && st.arriveJd === st.departJd);
        return {
          ref: st.ref ?? FIXED_REF, x: st.ref ? '' : String(st.x), y: st.ref ? '' : String(st.y), z: st.ref ? '' : String(st.z),
          arriveStr: st.solved && m.profile === 'brachistochrone' && m.accelG ? '' : jdStr(st.arriveJd), departStr: flyby ? '' : jdStr(st.departJd),
          parkAltStr: st.parkAltKm != null ? String(st.parkAltKm) : '', flyby,
        };
      }),
    };
  }
  return d;
}

/**
 * Open the editor.
 * @param {Object} app
 * @param {string|null} id object id to edit, or null for a new object
 * @param {Object} [prefill] partial draft overrides (used by the planner: { name, type, kind, route })
 */
export function openObjectEditor(app, id = null, prefill = null) {
  const s = store.get();
  const existing = id ? s.ctx.byId.get(id) : null;
  const d = toDraft(existing, s);
  if (prefill) Object.assign(d, prefill, { route: prefill.route ? { ...d.route, ...prefill.route } : d.route });

  const body = h(`<div class="editor">
    <div class="form-grid">
      <label>Name<input data-k="name" maxlength="80" placeholder="e.g. ISV Kestrel"></label>
      <label>Type<select data-k="type">${OBJECT_TYPES.map((t) => `<option value="${t}">${TYPE_GLYPHS[t]} ${t[0].toUpperCase() + t.slice(1)}</option>`).join('')}</select></label>
      <div class="field"><span class="field-label">Colour</span><div class="swatches">${PALETTE.map((c) => `<button type="button" class="swatch" data-color="${c}" style="background:${c}" aria-label="Colour ${c}"></button>`).join('')}<input type="color" data-k="color" aria-label="Custom colour"></div></div>
      <label>Tags <span class="muted">(comma-separated)</span><input data-k="tagsStr" placeholder="Navy, Act 2"></label>
      <label>Exists from <span class="muted">(optional, UTC)</span><input data-k="fromStr" class="mono" placeholder="YYYY-MM-DD"></label>
      <label>Exists until <span class="muted">(optional)</span><input data-k="untilStr" class="mono" placeholder="YYYY-MM-DD"></label>
      <label class="check"><input type="checkbox" data-k="showPath"> Show route path</label>
    </div>
    <label class="block">Notes<textarea data-k="notes" rows="2" placeholder="Free text"></textarea></label>
    <div class="section-title">Motion</div>
    <div class="tabs kind-tabs" role="tablist">${Object.entries(KIND_LABELS).map(([k, l]) => `<button type="button" role="tab" class="tab" data-kind="${k}">${l}</button>`).join('')}</div>
    <div class="kind-body" data-f="kind"></div>
    <div class="summary" data-f="summary" aria-live="polite"></div>
  </div>`);
  const foot = h(`<div class="btn-row">
    ${existing ? '<button class="btn danger" data-a="delete">Delete</button>' : ''}
    <span class="spacer"></span>
    <button class="btn" data-a="cancel">Cancel</button>
    <button class="btn primary" data-a="save">${existing ? 'Save' : 'Create'}</button>
  </div>`);
  // N-body legs / audits finishing in the background refresh the summary while the editor is open
  let unsubTraj = () => {};
  const modal = openModal({ title: existing ? `Edit — ${existing.name}` : 'New object', body, footer: foot, wide: true, onClose: () => unsubTraj() });
  unsubTraj = onTrajectoryUpdate(() => { if (d.kind === 'route') runValidate(); });

  // ---- general fields
  const q = (sel) => body.querySelector(sel);
  for (const inp of body.querySelectorAll('.form-grid [data-k], textarea[data-k]')) {
    const k = inp.dataset.k;
    if (inp.type === 'checkbox') inp.checked = !!d[k]; else inp.value = d[k] ?? '';
    inp.addEventListener('input', () => {
      d[k] = inp.type === 'checkbox' ? inp.checked : inp.value;
      if (k === 'type' && d.isNew && PALETTE.includes(d.color)) { d.color = TYPE_COLORS[d.type]; q('[data-k=color]').value = d.color; markSwatch(); }
      if (k === 'color') markSwatch();
      validate();
    });
    if (inp.type === 'checkbox' || inp.tagName === 'SELECT') inp.addEventListener('change', () => { d[k] = inp.type === 'checkbox' ? inp.checked : inp.value; validate(); });
  }
  const markSwatch = () => { for (const sw of body.querySelectorAll('.swatch')) sw.classList.toggle('on', sw.dataset.color.toLowerCase() === d.color.toLowerCase()); };
  body.querySelector('.swatches').addEventListener('click', (ev) => {
    const sw = ev.target.closest('.swatch');
    if (!sw) return;
    d.color = sw.dataset.color;
    q('[data-k=color]').value = d.color;
    markSwatch();
  });
  markSwatch();

  // ---- motion tabs
  const kindHost = q('[data-f=kind]');
  body.querySelector('.kind-tabs').addEventListener('click', (ev) => {
    const t = ev.target.closest('[data-kind]');
    if (!t) return;
    d.kind = t.dataset.kind;
    renderKind();
  });

  function field(label, key, obj, attrs = '') {
    return `<label>${label}<input data-m="${key}" value="${esc(obj[key])}" ${attrs}></label>`;
  }

  function bindInputs(obj) {
    for (const inp of kindHost.querySelectorAll('[data-m]')) {
      inp.addEventListener('input', () => {
        obj[inp.dataset.m] = inp.type === 'checkbox' ? inp.checked : inp.value;
        if (d.kind === 'orbit' && (inp.dataset.m === 'altKm' || inp.dataset.m === 'aKm')) syncAlt(inp.dataset.m);
        validate();
      });
    }
  }

  function syncAlt(changed) {
    const R = getBody(d.orbit.parent)?.radiusKm ?? 0;
    if (changed === 'altKm') {
      const a = num(d.orbit.altKm, NaN) + R;
      d.orbit.aKm = Number.isFinite(a) ? String(+a.toFixed(3)) : '';
      const el = kindHost.querySelector('[data-m=aKm]');
      if (el) el.value = d.orbit.aKm;
    } else {
      const alt = num(d.orbit.aKm, NaN) - R;
      d.orbit.altKm = Number.isFinite(alt) ? String(+alt.toFixed(3)) : '';
      const el = kindHost.querySelector('[data-m=altKm]');
      if (el) el.value = d.orbit.altKm;
    }
  }

  function renderKind() {
    for (const t of body.querySelectorAll('.kind-tabs .tab')) t.setAttribute('aria-selected', String(t.dataset.kind === d.kind));
    kindHost.innerHTML = '';
    if (d.kind === 'orbit') renderOrbit();
    else if (d.kind === 'colocated') renderColocated();
    else if (d.kind === 'lagrange') renderLagrange();
    else if (d.kind === 'fixed') renderFixed();
    else renderRoute();
    validate();
  }

  function renderOrbit() {
    const o = d.orbit;
    const wrap = h(`<div>
      <div class="form-grid">
        <div class="field"><span class="field-label">Orbits</span><div data-f="parent"></div></div>
        <div class="field"><span class="field-label">Preset</span><div class="inline"><select data-f="preset"></select><button type="button" class="btn small" data-f="apply">Apply</button></div></div>
        ${field('Altitude (km)', 'altKm', o, 'class="mono" inputmode="decimal"')}
        ${field('Semi-major axis a (km)', 'aKm', o, 'class="mono" inputmode="decimal"')}
        ${field('Eccentricity e', 'e', o, 'class="mono" inputmode="decimal"')}
        ${field('Inclination i (°, to ecliptic)', 'iDeg', o, 'class="mono"')}
        ${field('Asc. node Ω (°)', 'omDeg', o, 'class="mono"')}
        ${field('Arg. of periapsis ω (°)', 'wDeg', o, 'class="mono"')}
        ${field('Mean anomaly M₀ at epoch (°)', 'm0Deg', o, 'class="mono"')}
        ${field('Epoch (UTC)', 'epochStr', o, 'class="mono"')}
      </div>
      <p class="muted small">Angles are in the ecliptic J2000 frame relative to the parent. “Equatorial” presets set i/Ω to the parent's equator (IAU pole). A custom-object parent has no gravity: the object then keeps a fixed offset (formation flying).</p>
    </div>`);
    kindHost.appendChild(wrap);
    const picker = refPicker({ value: o.parent, excludeId: d.id, ariaLabel: 'Orbit parent', onChange: (v) => { o.parent = v; syncAlt('altKm'); fillPresets(); validate(); } });
    wrap.querySelector('[data-f=parent]').appendChild(picker.el);
    const presetSel = wrap.querySelector('[data-f=preset]');
    const fillPresets = () => {
      const pole = equatorialPlane(o.parent);
      const list = ORBIT_PRESETS.filter((p) => (p.parent === o.parent || p.parent === '*') && (!p.needsPole || pole) && getBody(o.parent));
      presetSel.innerHTML = list.length ? list.map((p) => `<option value="${p.id}">${esc(p.label)}</option>`).join('') : '<option value="">(none for this parent)</option>';
    };
    fillPresets();
    wrap.querySelector('[data-f=apply]').addEventListener('click', () => {
      const p = ORBIT_PRESETS.find((x) => x.id === presetSel.value);
      const b = getBody(o.parent);
      if (!p || !b) return;
      const R = b.radiusKm;
      const a = p.aKm ?? (p.altKm != null ? R + p.altKm : p.altFrac != null ? R * (1 + p.altFrac) : R * p.aFrac);
      o.aKm = String(+a.toFixed(3));
      o.altKm = String(+(a - R).toFixed(3));
      o.e = '0';
      o.wDeg = '0';
      const pole = p.equatorial ? equatorialPlane(o.parent) : null;
      o.iDeg = pole ? (pole.i / DEG).toFixed(4) : '0';
      o.omDeg = pole ? (pole.om / DEG).toFixed(4) : '0';
      renderKind();
    });
    bindInputs(o);
  }

  function renderColocated() {
    const c = d.colocated;
    const wrap = h(`<div><div class="form-grid">
      <div class="field"><span class="field-label">Located at</span><div data-f="parent"></div></div>
      <label>Label<select data-m="label">${['Surface', 'In orbit (unspecified)', 'Docked', 'Nearby'].map((x) => `<option ${x === c.label ? 'selected' : ''}>${x}</option>`).join('')}</select></label>
    </div><p class="muted small">Shares the parent's position (a surface base, colony, or “in orbit somewhere”). Drawn just above the body so labels do not collide.</p></div>`);
    kindHost.appendChild(wrap);
    const picker = refPicker({ value: c.parent, excludeId: d.id, ariaLabel: 'Parent', onChange: (v) => { c.parent = v; validate(); } });
    wrap.querySelector('[data-f=parent]').appendChild(picker.el);
    wrap.querySelector('[data-m=label]').addEventListener('change', (ev) => { c.label = ev.target.value; });
  }

  function renderLagrange() {
    const L = d.lagrange;
    const wrap = h(`<div>
      <div class="inline pairs">${LAGRANGE_PAIRS.map(([p, s2]) => `<button type="button" class="btn tiny" data-pair="${p},${s2}">${nameOf(p)}–${nameOf(s2)}</button>`).join('')}</div>
      <div class="form-grid">
        <div class="field"><span class="field-label">Primary</span><div data-f="primary"></div></div>
        <div class="field"><span class="field-label">Secondary</span><div data-f="secondary"></div></div>
        <label>Point<select data-m="point">${['L1', 'L2', 'L3', 'L4', 'L5'].map((x) => `<option ${x === L.point ? 'selected' : ''}>${x}</option>`).join('')}</select></label>
      </div>
      <p class="muted small">L1 between the bodies, L2 beyond the secondary, L3 opposite, L4 leads the secondary by 60°, L5 trails.</p></div>`);
    kindHost.appendChild(wrap);
    const pp = refPicker({ value: L.primary, includeCustom: false, ariaLabel: 'Primary', onChange: (v) => { L.primary = v; validate(); } });
    const sp = refPicker({ value: L.secondary, includeCustom: false, ariaLabel: 'Secondary', onChange: (v) => { L.secondary = v; validate(); } });
    wrap.querySelector('[data-f=primary]').appendChild(pp.el);
    wrap.querySelector('[data-f=secondary]').appendChild(sp.el);
    wrap.querySelector('[data-m=point]').addEventListener('change', (ev) => { L.point = ev.target.value; validate(); });
    wrap.querySelector('.pairs').addEventListener('click', (ev) => {
      const b = ev.target.closest('[data-pair]');
      if (!b) return;
      [L.primary, L.secondary] = b.dataset.pair.split(',');
      pp.value = L.primary; sp.value = L.secondary;
      validate();
    });
  }

  function renderFixed() {
    const f = d.fixed;
    const wrap = h(`<div><div class="form-grid">
      ${field('x', 'x', f, 'class="mono"')}${field('y', 'y', f, 'class="mono"')}${field('z', 'z', f, 'class="mono"')}
      <label>Unit<select data-m="unit"><option ${f.unit === 'AU' ? 'selected' : ''}>AU</option><option ${f.unit === 'km' ? 'selected' : ''}>km</option></select></label>
      <div class="field"><span class="field-label">Copy current position of</span><div class="inline"><div data-f="copy"></div><button type="button" class="btn small" data-f="copybtn">Copy</button></div></div>
    </div><p class="muted small">Heliocentric ecliptic J2000 coordinates; the point does not move.</p></div>`);
    kindHost.appendChild(wrap);
    const cp = refPicker({ value: 'earth', excludeId: d.id, ariaLabel: 'Copy position from' });
    wrap.querySelector('[data-f=copy]').appendChild(cp.el);
    wrap.querySelector('[data-f=copybtn]').addEventListener('click', () => {
      const p = positionOf(cp.value, store.get().jd, store.get().ctx);
      if (!p) return;
      const k = f.unit === 'km' ? AU_KM : 1;
      f.x = String(+(p[0] * k).toPrecision(10)); f.y = String(+(p[1] * k).toPrecision(10)); f.z = String(+(p[2] * k).toPrecision(10));
      renderKind();
    });
    wrap.querySelector('[data-m=unit]').addEventListener('change', (ev) => {
      const to = ev.target.value;
      if (to !== f.unit) {
        const k = to === 'km' ? AU_KM : 1 / AU_KM;
        for (const c of ['x', 'y', 'z']) if (f[c] !== '' && Number.isFinite(+f[c])) f[c] = String(+(+f[c] * k).toPrecision(10));
        f.unit = to;
        renderKind();
      }
    });
    bindInputs(f);
  }

  function renderRoute() {
    const r = d.route;
    const wrap = h(`<div>
      <div class="form-grid">
        <label>Profile<select data-m="profile">
          <option value="brachistochrone">Brachistochrone (constant thrust, flip at midpoint)</option>
          <option value="ballistic">Ballistic (coast through the Sun's and planets' gravity)</option>
          <option value="linear">Linear (constant speed, straight line)</option>
        </select></label>
        <label data-f="accelWrap">Acceleration (g) <span class="muted">— blank arrivals are solved from this</span><input data-m="accelG" class="mono" value="${esc(r.accelG)}" inputmode="decimal" placeholder="e.g. 0.3"></label>
      </div>
      <table class="stops"><thead><tr><th>#</th><th>Stop</th><th>Arrive (UTC)</th><th>Depart (UTC)</th><th></th></tr></thead><tbody data-f="stops"></tbody></table>
      <div class="inline"><button type="button" class="btn small" data-f="addstop">＋ Add stop</button>
      <span class="muted small">Dates: <code>YYYY-MM-DD HH:MM</code> or <code>+N</code> days after the previous time (<code>+12h</code>, <code>+1y</code>). Brachistochrone: leave an arrival blank to solve it. Ballistic: tick <i>flyby</i> on an intermediate planet for a gravity assist; parking altitudes set the departure/capture burns.</span></div>
    </div>`);
    kindHost.appendChild(wrap);
    const prof = wrap.querySelector('[data-m=profile]');
    prof.value = r.profile;
    const accelWrap = wrap.querySelector('[data-f=accelWrap]');
    accelWrap.hidden = r.profile !== 'brachistochrone';
    prof.addEventListener('change', () => { r.profile = prof.value; accelWrap.hidden = r.profile !== 'brachistochrone'; renderStops(); validate(); });
    wrap.querySelector('[data-m=accelG]').addEventListener('input', (ev) => { r.accelG = ev.target.value; validate(); });
    const tbody = wrap.querySelector('[data-f=stops]');
    /** Placeholder for a stop's parking-altitude field: the default for its body, or n/a. */
    const parkPlaceholder = (ref) => {
      if (!ref || ref === FIXED_REF) return 'n/a';
      const g = stopGravity({ ref }, store.get().ctx);
      return g.gm > 0 ? `${+g.parkAltKm.toFixed(1)}` : 'n/a';
    };
    const renderStops = () => {
      tbody.innerHTML = '';
      const ballistic = r.profile === 'ballistic';
      r.stops.forEach((st, i) => {
        const first = i === 0, last = i === r.stops.length - 1;
        const mid = !first && !last;
        if (!mid) st.flyby = false;
        const fly = mid && st.flyby;
        const tr = h(`<tr>
          <td class="muted">${i + 1}</td>
          <td><div data-f="ref"></div>
            <div class="xyz" ${st.ref === FIXED_REF ? '' : 'hidden'}>
              <input data-s="x" placeholder="x AU" value="${esc(st.x)}" class="mono"><input data-s="y" placeholder="y AU" value="${esc(st.y)}" class="mono"><input data-s="z" placeholder="z AU" value="${esc(st.z)}" class="mono">
            </div>
            ${ballistic && !fly ? `<div class="stop-opts"><label title="Circular parking-orbit altitude used for the departure / capture burn at this stop (blank = default for the body)">Parking alt. <input data-s="parkAltStr" class="mono" value="${esc(st.parkAltStr ?? '')}" placeholder="${esc(parkPlaceholder(st.ref))}" inputmode="decimal"> km</label></div>` : ''}</td>
          <td>${first ? '<span class="muted">start</span>' : `<input data-s="arriveStr" class="mono" value="${esc(st.arriveStr)}" placeholder="${r.profile === 'brachistochrone' ? 'blank = solve' : 'YYYY-MM-DD HH:MM'}">`}<div class="solved muted small" data-f="solved"></div></td>
          <td>${last ? '<span class="muted">end</span>' : fly ? '<span class="flyby-note">departs on arrival (flyby)</span>' : `<input data-s="departStr" class="mono" value="${esc(st.departStr)}" placeholder="${first ? 'YYYY-MM-DD HH:MM' : '+N days'}">`}
            ${mid ? `<div class="stop-opts"><label title="Pass the body without stopping (arrival = departure). On ballistic routes this gets a patched-conic gravity-assist analysis."><input type="checkbox" data-s="flyby" ${fly ? 'checked' : ''}> flyby (no stop)</label></div>` : ''}</td>
          <td class="row-btns">
            <button type="button" class="icon-btn small" data-mv="-1" title="Move up" ${first ? 'disabled' : ''}>↑</button>
            <button type="button" class="icon-btn small" data-mv="1" title="Move down" ${last ? 'disabled' : ''}>↓</button>
            <button type="button" class="icon-btn small" data-rm title="Remove stop" ${r.stops.length <= 2 ? 'disabled' : ''}>✕</button>
          </td></tr>`);
        const rp = refPicker({ value: st.ref, excludeId: d.id, allowFixed: true, ariaLabel: `Stop ${i + 1}`, onChange: (v) => {
          st.ref = v;
          tr.querySelector('.xyz').hidden = v !== FIXED_REF;
          const park = tr.querySelector('[data-s=parkAltStr]');
          if (park) park.placeholder = parkPlaceholder(v);
          validate();
        } });
        tr.querySelector('[data-f=ref]').appendChild(rp.el);
        for (const inp of tr.querySelectorAll('[data-s]')) {
          if (inp.type === 'checkbox') inp.addEventListener('change', () => { st[inp.dataset.s] = inp.checked; renderStops(); validate(); });
          else inp.addEventListener('input', () => { st[inp.dataset.s] = inp.value; validate(); });
        }
        tr.querySelector('[data-mv="-1"]').addEventListener('click', () => { [r.stops[i - 1], r.stops[i]] = [r.stops[i], r.stops[i - 1]]; renderStops(); validate(); });
        tr.querySelector('[data-mv="1"]').addEventListener('click', () => { [r.stops[i + 1], r.stops[i]] = [r.stops[i], r.stops[i + 1]]; renderStops(); validate(); });
        tr.querySelector('[data-rm]').addEventListener('click', () => { r.stops.splice(i, 1); renderStops(); validate(); });
        tbody.appendChild(tr);
      });
    };
    renderStops();
    wrap.querySelector('[data-f=addstop]').addEventListener('click', () => {
      const lastStop = r.stops[r.stops.length - 1];
      if (lastStop && !lastStop.departStr) lastStop.departStr = '+7';
      r.stops.push({ ref: 'earth', x: '', y: '', z: '', arriveStr: '', departStr: '', parkAltStr: '', flyby: false });
      renderStops();
      validate();
    });
  }

  // ---- validation & build
  let built = null;
  function buildMotion(ctx) {
    const errors = [], warnings = [], info = [];
    let motion = null;
    if (d.kind === 'orbit') {
      const o = d.orbit;
      const aKm = num(o.aKm, NaN), e = num(o.e, NaN);
      const epochJd = parseDateToJd(o.epochStr);
      if (!o.parent || !idExists(o.parent, ctx)) errors.push('Choose what it orbits.');
      if (o.parent === d.id) errors.push('An object cannot orbit itself.');
      if (!(aKm > 0)) errors.push('Semi-major axis must be a positive number of km.');
      if (!(e >= 0 && e < 1)) errors.push('Eccentricity must be in [0, 1).');
      if (!Number.isFinite(epochJd)) errors.push('Epoch must be a date (YYYY-MM-DD HH:MM).');
      for (const k of ['iDeg', 'omDeg', 'wDeg', 'm0Deg']) if (!Number.isFinite(parseFloat(o[k]))) errors.push(`${k.replace('Deg', '')} must be a number (degrees).`);
      const b = getBody(o.parent);
      if (b && aKm * (1 - (e || 0)) < b.radiusKm) errors.push(`Periapsis (${fmtKm(aKm * (1 - e))} from centre) is inside ${b.name} (radius ${fmtKm(b.radiusKm)}).`);
      if (!errors.length) {
        motion = { kind: 'orbit', parent: o.parent, aKm, e, iDeg: num(o.iDeg), omDeg: num(o.omDeg), wDeg: num(o.wDeg), m0Deg: num(o.m0Deg), epochJd };
        const mu = muOf(o.parent);
        if (mu > 0) {
          const P = periodDays(aKm / AU_KM, mu);
          info.push(`Period ${fmtDuration(P)} · circular speed ${fmtSpeedKmS(Math.sqrt((mu * AU_KM ** 3) / 86400 ** 2 / aKm))}`);
          if (b) info.push(`Periapsis altitude ${fmtKm(aKm * (1 - e) - b.radiusKm)} · apoapsis altitude ${fmtKm(aKm * (1 + e) - b.radiusKm)}`);
          if (b && b.type !== 'star') {
            const hill = getHill(o.parent);
            if (hill && aKm > hill) warnings.push(`a exceeds ${b.name}'s Hill sphere (~${fmtKm(hill)}); the orbit would not be stable.`);
          }
        } else info.push('Parent is a custom object (no gravity): fixed offset, no orbital motion.');
      }
    } else if (d.kind === 'colocated') {
      if (!d.colocated.parent || !idExists(d.colocated.parent, ctx)) errors.push('Choose a parent.');
      if (d.colocated.parent === d.id) errors.push('An object cannot be co-located with itself.');
      motion = { kind: 'colocated', parent: d.colocated.parent, label: d.colocated.label };
    } else if (d.kind === 'lagrange') {
      const L = d.lagrange;
      if (!getBody(L.primary) || !getBody(L.secondary)) errors.push('Primary and secondary must be natural bodies.');
      if (L.primary === L.secondary) errors.push('Primary and secondary must differ.');
      const sb = getBody(L.secondary);
      if (sb && sb.parent !== L.primary) warnings.push(`${sb.name} does not orbit ${nameOf(L.primary)} in this model; the point is still computed from their positions.`);
      motion = { kind: 'lagrange', primary: L.primary, secondary: L.secondary, point: L.point };
      if (!errors.length) {
        const tmp = { id: '__tmp', motion };
        const c2 = { ...ctx, byId: new Map([...ctx.byId, ['__tmp', tmp]]), posCache: new Map(), errors: new Map() };
        const p = positionOf('__tmp', store.get().jd, c2);
        info.push(`Now ${fmtDist(vdist(p, getPosition(L.secondary, store.get().jd)))} from ${nameOf(L.secondary)}, ${fmtDist(vdist(p, getPosition(L.primary, store.get().jd)))} from ${nameOf(L.primary)}.`);
      }
    } else if (d.kind === 'fixed') {
      const f = d.fixed;
      const k = f.unit === 'km' ? 1 / AU_KM : 1;
      const v = [f.x, f.y, f.z].map((x) => parseFloat(x));
      if (!v.every(Number.isFinite)) errors.push('x, y and z must be numbers.');
      else motion = { kind: 'fixed', x: v[0] * k, y: v[1] * k, z: v[2] * k };
      if (motion) info.push(`${fmtAu(Math.hypot(motion.x, motion.y, motion.z))} from the Sun.`);
    } else {
      const r = d.route;
      const accelG = num(r.accelG, NaN);
      if (r.profile === 'brachistochrone' && r.accelG.trim() !== '' && !(accelG > 0)) errors.push('Acceleration must be a positive number of g.');
      const draft = {
        profile: r.profile, accelG: r.profile === 'brachistochrone' && accelG > 0 ? accelG : null,
        stops: r.stops.map((st, i) => ({
          ref: st.ref === FIXED_REF ? null : st.ref, x: st.x, y: st.y, z: st.z, arriveStr: st.arriveStr, departStr: st.departStr,
          parkAltStr: r.profile === 'ballistic' && !(st.flyby && i > 0 && i < r.stops.length - 1) ? (st.parkAltStr ?? '') : '',
          flyby: !!st.flyby,
        })),
      };
      for (const st of draft.stops) if (st.ref === d.id) errors.push('A route cannot stop at the object itself.');
      const res = resolveRoute(draft, ctx, parseDateToJd);
      errors.push(...res.errors);
      warnings.push(...res.warnings);
      if (!errors.length) {
        motion = { kind: 'route', profile: r.profile, stops: res.stops };
        if (draft.accelG) motion.accelG = draft.accelG;
        built = { legs: res.legs, stops: res.stops };
      } else built = null;
      // show solved times in the table
      const solvedEls = kindHost.querySelectorAll('[data-f=solved]');
      res.stops.forEach((st, i) => { if (solvedEls[i]) solvedEls[i].textContent = st.solved ? `solved: ${formatJd(st.arriveJd)}` : ''; });
      if (res.legs.length) info.push(legTable(res.legs, ctx, motion));
    }
    // general
    const from = d.fromStr.trim() ? parseDateToJd(d.fromStr) : null;
    const until = d.untilStr.trim() ? parseDateToJd(d.untilStr) : null;
    if (from !== null && !Number.isFinite(from)) errors.push('“Exists from” is not a valid date.');
    if (until !== null && !Number.isFinite(until)) errors.push('“Exists until” is not a valid date.');
    if (Number.isFinite(from) && Number.isFinite(until) && until <= from) errors.push('“Exists until” must be after “exists from”.');
    if (!d.name.trim()) errors.push('Name is required.');
    return { motion, errors, warnings, info, from, until };
  }

  function getHill(parentId) {
    const b = getBody(parentId);
    if (!b || !b.parent) return null;
    const pb = getBody(b.parent);
    const jd = store.get().jd;
    const dist = vdist(getPosition(parentId, jd), getPosition(b.parent, jd)) * AU_KM;
    const m = b.gmKm3S2 ?? 0, M = pb.gmKm3S2 ?? 0;
    return m > 0 && M > 0 ? dist * Math.cbrt(m / (3 * M)) : null;
  }

  /** Leg summary: a compact table plus per-leg physics notes (N-body status, approaches, audits, flybys). */
  function legTable(legs, ctx, motion) {
    let t = '<table class="legs-table"><thead><tr><th>Leg</th><th>Distance</th><th>Duration</th>';
    const prof = d.route.profile;
    const kms = (v) => fmtSpeedKmS(auDayToKmS(v));
    if (prof === 'brachistochrone') t += '<th>Accel</th><th>Peak v</th><th>Δv</th><th>Gravity audit</th>';
    else if (prof === 'ballistic') t += '<th>Dep. v∞</th><th>Arr. v∞</th><th>Dep. burn</th><th>Arr. burn</th><th>Total Δv</th>';
    else t += '<th>Speed</th>';
    t += '</tr></thead><tbody>';
    let notes = '';
    legs.forEach((L, i) => {
      const label = `${i + 1}. ${esc(nameOf(L.fromId, ctx))} → ${esc(nameOf(L.toId, ctx))}`;
      t += `<tr><td>${label}</td><td>${fmtDist(L.D)}</td><td>${fmtDuration(L.T)}</td>`;
      if (prof === 'brachistochrone') {
        const a = auditSummary(L);
        const cell = !a ? '<td>—</td>'
          : a.status === 'pending' ? '<td class="muted">computing…</td>'
          : a.status === 'ok' ? `<td class="ok">OK · peak ${fmtG(a.peakG)} · loss ${fmtPct(a.lossPct)}</td>`
          : a.status === 'marginal' ? `<td class="warn">Marginal · +${((a.maxRatio - 1) * 100).toFixed(0)} % thrust</td>`
          : a.status === 'fail' ? `<td class="err">Cannot hold the line (×${a.maxRatio.toFixed(1)})</td>` : '<td>—</td>';
        t += `<td>${fmtG(auDay2ToMS2(L.accel) / G0_M_S2)}</td><td>${fmtKmS(L.vPeak)}</td><td>${fmtKmS(L.dv)}</td>${cell}`;
        const ah = auditHtml(L);
        if (ah && a?.status !== 'ok' && a?.status !== 'pending') notes += `<div class="leg-label">Leg ${i + 1}</div>${ah.notes}`;
      } else if (prof === 'ballistic') {
        const sm = ballisticSummary(L, ctx);
        if (sm) {
          const tb = sm.status === 'nbody' ? '' : '<span class="muted">*</span>';
          const burn = (b) => (b.kind === 'flyby' ? '<span class="muted">flyby</span>' : kms(b.dv));
          t += `<td>${kms(sm.vinfDep)}${tb}</td><td>${kms(sm.vinfArr)}${tb}</td><td>${burn(sm.dep)}</td><td>${burn(sm.arr)}</td><td><b>${kms(sm.totalDv)}</b></td>`;
          const bh = ballisticHtml(L, ctx);
          const approaches = sm.closest.map((c) => `${esc(nameOf(c.id, ctx))} ${fmtMkm(c.distAu * 149597870.7)} (${formatJd(c.jd, { time: false })})${c.close ? ' <b class="warn-text">close</b>' : ''}`).join(' · ');
          notes += `<div class="leg-label">Leg ${i + 1}</div>${approaches ? `<div class="small">Closest approaches: ${approaches}</div>` : ''}${bh.notes}`;
        } else t += '<td colspan="5" class="warn">no ballistic solution (linear)</td>';
      } else t += `<td>${fmtKmS(L.vAvg)}</td>`;
      t += '</tr>';
    });
    t += '</tbody></table>';
    if (prof === 'ballistic') t += '<div class="muted small">* two-body value while the N-body refinement runs. Burns: departure from / capture into a circular parking orbit (altitude per stop).</div>';
    if (prof === 'ballistic' && motion) {
      const tmp = { id: '__editor_draft', motion };
      notes += flybysHtml(tmp, ctx) + routeDeltaVHtml(tmp, ctx);
    }
    return t + (notes ? `<div class="leg-notes">${notes}</div>` : '');
  }

  let lastResult = null;
  let vTimer = null;
  function validate() {
    clearTimeout(vTimer);
    vTimer = setTimeout(runValidate, 120);
  }
  function runValidate() {
    const ctx = store.get().ctx;
    lastResult = buildMotion(ctx);
    const sum = q('[data-f=summary]');
    const { errors, warnings, info } = lastResult;
    sum.innerHTML = `
      ${errors.map((e) => `<div class="msg err">✕ ${esc(e)}</div>`).join('')}
      ${warnings.map((w) => `<div class="msg warn">⚠ ${esc(w)}</div>`).join('')}
      ${info.map((x) => (x.startsWith('<') ? x : `<div class="msg info">${esc(x)}</div>`)).join('')}`;
    foot.querySelector('[data-a=save]').disabled = errors.length > 0;
  }

  renderKind();
  runValidate();
  q('[data-k=name]').focus();

  foot.querySelector('[data-a=cancel]').addEventListener('click', () => modal.close());
  foot.querySelector('[data-a=save]').addEventListener('click', () => {
    runValidate();
    const r = lastResult;
    if (r.errors.length) { app.toast('Fix the errors before saving.', 'error'); return; }
    const obj = {
      id: d.id, name: d.name.trim(), type: d.type, color: d.color, notes: d.notes,
      tags: d.tagsStr.split(',').map((t) => t.trim()).filter(Boolean),
      existsFromJd: Number.isFinite(r.from) ? r.from : null, existsUntilJd: Number.isFinite(r.until) ? r.until : null,
      showPath: !!d.showPath, motion: r.motion,
    };
    upsertObject(obj);
    modal.close();
    app.toast(`${d.isNew ? 'Created' : 'Saved'} ${obj.name}`, 'success');
    if (d.isNew) selectAndFocus(obj.id);
  });
  foot.querySelector('[data-a=delete]')?.addEventListener('click', async () => {
    if (await confirmModal('Delete object', `Delete “${existing.name}”? This cannot be undone.`, 'Delete')) {
      deleteObject(existing.id);
      modal.close();
      app.toast(`Deleted ${existing.name}`, 'success');
    }
  });
}
