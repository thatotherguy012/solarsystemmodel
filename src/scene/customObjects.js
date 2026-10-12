// Custom objects: fixed-screen-size markers, labels with type glyphs, orbit ellipses and route paths. §6.
import * as THREE from 'three';
import { CSS2DObject } from 'three/addons/renderers/CSS2DRenderer.js';
import { existsAt, positionOf, customPath, orbitMotionElements, referencedIds, routeAnchor, isFlybyStop, legSpec, pathSignature, TYPE_GLYPHS } from '../sim/custom.js';
import { sampleOrbit } from '../sim/ephemeris.js';
import { makeDynamicLine, setLinePoints, ringTexture } from './util.js';
import { esc } from '../ui/format.js';

const MARKER_PX = 5;
const PATH_SAMPLES = 256;
const FLYBY_RING_PX = 13;

/** Index of the last time in a sorted list that is <= jd (0 when before the start). */
function lastIndexAtOrBefore(jds, jd) {
  let lo = 0, hi = jds.length - 1;
  if (jd <= jds[0]) return 0;
  if (jd >= jds[hi]) return hi;
  while (hi - lo > 1) { const mid = (lo + hi) >> 1; if (jds[mid] <= jd) lo = mid; else hi = mid; }
  return lo;
}

const GEOMS = {
  octa: new THREE.OctahedronGeometry(1, 0),
  torus: new THREE.TorusGeometry(1, 0.34, 8, 28),
  disc: new THREE.CircleGeometry(1, 24),
  dot: new THREE.SphereGeometry(0.8, 12, 8),
};
const SHAPE_FOR_TYPE = { ship: 'octa', fleet: 'octa', probe: 'octa', station: 'torus', habitat: 'torus', base: 'disc', other: 'dot' };

/** Signature of the fields that affect rendering; a change triggers a rebuild of that object's visuals. */
function signature(o) {
  return JSON.stringify([o.name, o.type, o.color, o.showPath, o.motion]);
}

/**
 * @param {THREE.Scene} scene
 * @param {{ onLabelCreated?: (el:HTMLElement, id:string) => void }} opts
 */
export function createCustomObjects(scene, opts = {}) {
  const group = new THREE.Group();
  group.name = 'custom';
  const lineGroup = new THREE.Group();
  const labelGroup = new THREE.Group();
  scene.add(lineGroup, group, labelGroup);
  /** @type {Map<string, Object>} */
  const entries = new Map();
  let lastCtxVersion = -1;

  function disposeEntry(e) {
    group.remove(e.marker);
    e.marker.material.dispose();
    labelGroup.remove(e.label);
    e.labelEl.remove();
    if (e.orbitLine) { lineGroup.remove(e.orbitLine); e.orbitLine.geometry.dispose(); e.orbitLine.material.dispose(); }
    for (const p of e.paths) {
      lineGroup.remove(p.past, p.future);
      p.geom.dispose();
    }
    if (e.pathMats) e.pathMats.forEach((m) => m.dispose());
    disposeRings(e);
  }

  function disposeRings(e) {
    for (const r of e.rings || []) { group.remove(r.sprite); r.sprite.material.map.dispose(); r.sprite.material.dispose(); }
    e.rings = [];
  }

  function buildPaths(e, ctx) {
    for (const p of e.paths) { lineGroup.remove(p.past, p.future); p.geom.dispose(); }
    e.paths = [];
    disposeRings(e);
    e.pathSig = '';
    const o = e.obj;
    if (o.motion?.kind !== 'route') return;
    if (!e.pathMats) {
      e.pathMats = [
        new THREE.LineBasicMaterial({ color: o.color, transparent: true, opacity: 0.45, depthWrite: false }),
        new THREE.LineBasicMaterial({ color: o.color, transparent: true, opacity: 0.85, depthWrite: false }),
        // engines off (drift): dimmer and dashed
        new THREE.LineDashedMaterial({ color: o.color, transparent: true, opacity: 0.28, depthWrite: false, dashSize: 1, gapSize: 1 }),
        new THREE.LineDashedMaterial({ color: o.color, transparent: true, opacity: 0.55, depthWrite: false, dashSize: 1, gapSize: 1 }),
      ];
    } else {
      e.pathMats.forEach((m) => m.color.set(o.color));
    }
    const legs = customPath(o, ctx, PATH_SAMPLES);
    let driftLen = 0;
    for (const leg of legs) {
      const geom = new THREE.BufferGeometry();
      geom.setAttribute('position', new THREE.Float32BufferAttribute(leg.points.flat(), 3));
      const drift = leg.style === 'drift';
      const past = new THREE.Line(geom, e.pathMats[drift ? 2 : 0]);
      const future = new THREE.Line(geom, e.pathMats[drift ? 3 : 1]);
      if (drift) {
        past.computeLineDistances();
        const dist = geom.getAttribute('lineDistance');
        if (dist) driftLen = Math.max(driftLen, dist.array[dist.count - 1]);
      }
      past.frustumCulled = future.frustumCulled = false;
      lineGroup.add(past, future);
      const p = { geom, past, future, t0: leg.t0, t1: leg.t1, jds: leg.jds, origin: leg.origin, n: leg.points.length, pastRange: [0, 0], futureRange: [0, leg.points.length] };
      past.onBeforeRender = () => geom.setDrawRange(p.pastRange[0], p.pastRange[1]);
      future.onBeforeRender = () => geom.setDrawRange(p.futureRange[0], p.futureRange[1]);
      e.paths.push(p);
    }
    // dashes (per material) sized for the longest drift path of this object: ~160 dashes along it
    if (driftLen > 0) for (const k of [2, 3]) { e.pathMats[k].dashSize = driftLen / 160; e.pathMats[k].gapSize = driftLen / 200; }
    // the async state of each leg (N-body, gravity-refined thrust, drift): when it changes, the path is rebuilt
    e.pathSig = pathSignature(o, ctx);
    // flyby stops: a small ring at the stop's position at the flyby time (end of the inbound leg)
    const m = o.motion;
    {
      for (const leg of legs) {
        if (leg.leg === 'drift' || !isFlybyStop(m.stops, leg.leg + 1)) continue;
        if (legSpec(m, leg.leg).profile !== 'ballistic' || legSpec(m, leg.leg + 1).profile !== 'ballistic') continue;
        const last = leg.points[leg.points.length - 1];
        const pos = [leg.origin[0] + last[0], leg.origin[1] + last[1], leg.origin[2] + last[2]];
        const sprite = new THREE.Sprite(new THREE.SpriteMaterial({ map: ringTexture(o.color, 14), depthTest: false, depthWrite: false, transparent: true, sizeAttenuation: false }));
        sprite.renderOrder = 4;
        sprite.frustumCulled = false;
        group.add(sprite);
        e.rings.push({ sprite, pos });
      }
    }
  }

  function buildEntry(o, ctx) {
    const shape = SHAPE_FOR_TYPE[o.type] ?? 'dot';
    const marker = new THREE.Mesh(GEOMS[shape], new THREE.MeshBasicMaterial({ color: o.color, side: THREE.DoubleSide }));
    marker.frustumCulled = false;
    marker.renderOrder = 3;
    group.add(marker);
    const el = document.createElement('div');
    el.className = 'label label-custom';
    el.dataset.id = o.id;
    el.innerHTML = `<span class="glyph" style="color:${esc(o.color)}">${TYPE_GLYPHS[o.type] ?? '●'}</span><span class="label-text">${esc(o.name)}</span><span class="err-badge" hidden>⚠</span>`;
    const label = new CSS2DObject(el);
    label.center.set(0, 0.5);
    labelGroup.add(label);
    opts.onLabelCreated?.(el, o.id);
    const e = {
      id: o.id, obj: o, sig: signature(o), marker, shape, label, labelEl: el, errEl: el.querySelector('.err-badge'),
      labelW: 24 + o.name.length * 6.6, paths: [], rings: [], pathSig: '', orbitLine: null, orbitBuilt: null, marginPx: -1,
      refsCustom: referencedIds(o).some((id) => ctx.byId.has(id)),
    };
    if (o.motion?.kind === 'orbit') {
      const mat = new THREE.LineBasicMaterial({ color: o.color, transparent: true, opacity: 0.6, depthWrite: false });
      e.orbitLine = makeDynamicLine(361, mat);
      lineGroup.add(e.orbitLine);
    }
    buildPaths(e, ctx);
    return e;
  }

  /** Reconcile visuals with the store's object list. */
  function sync(objects, ctx) {
    const seen = new Set();
    for (const o of objects) {
      seen.add(o.id);
      const e = entries.get(o.id);
      const sig = signature(o);
      if (!e) entries.set(o.id, buildEntry(o, ctx));
      else if (e.sig !== sig) { disposeEntry(e); entries.set(o.id, buildEntry(o, ctx)); }
      else {
        e.obj = o;
        if (ctx.version !== lastCtxVersion && e.refsCustom) buildPaths(e, ctx);
      }
    }
    for (const [id, e] of entries) if (!seen.has(id)) { disposeEntry(e); entries.delete(id); }
    lastCtxVersion = ctx.version;
  }

  /** Rebuild the paths of routes whose legs gained (or lost) an N-body trajectory since they were drawn. */
  function refreshPaths(ctx) {
    for (const e of entries.values()) {
      if (e.obj.motion?.kind !== 'route') continue;
      if (pathSignature(e.obj, ctx) !== e.pathSig) buildPaths(e, ctx);
    }
  }

  const up = new THREE.Vector3();

  function update(fc) {
    const { jd, F, camPos, camera, pxPerRad, toggles, selection, focus, ctx, hidden } = fc;
    up.set(0, 1, 0).applyQuaternion(camera.quaternion);
    const stackCount = new Map();
    for (const e of entries.values()) {
      const o = e.obj;
      const pinned = o.id === selection || o.id === focus;
      let visible = !hidden.has(o.id) && (toggles.custom || pinned) && existsAt(o, jd);
      const W = positionOf(o.id, jd, ctx) ?? [0, 0, 0];
      let rel = [W[0] - F[0], W[1] - F[1], W[2] - F[2]];
      const m = o.motion || {};
      let camDist = Math.hypot(rel[0] - camPos.x, rel[1] - camPos.y, rel[2] - camPos.z);

      // anchor-proximity rules (orbiters hidden when their orbit is < 10 px, like moons)
      if (visible && !pinned && m.kind === 'orbit') {
        const p = fc.screen.get(m.parent);
        const pd = p ? p.camDist : camDist;
        if ((m.aKm / 149597870.7 / Math.max(pd, 1e-12)) * pxPerRad < 10) visible = false;
      }
      if (visible && !pinned && m.kind === 'lagrange' && m.primary !== 'sun') {
        const p = fc.screen.get(m.primary);
        const s = fc.project(rel[0], rel[1], rel[2]);
        if (p && !s.behind && Math.hypot(s.x - p.x, s.y - p.y) < 10) visible = false;
      }
      // co-located (or parked on a route): offset above the body in screen space so labels do not collide
      let anchor = null;
      if (m.kind === 'colocated') anchor = m.parent;
      else if (m.kind === 'route') anchor = routeAnchor(o, jd, ctx);
      if (anchor && fc.screen.has(anchor)) {
        const p = fc.screen.get(anchor);
        const idx = stackCount.get(anchor) ?? 0;
        stackCount.set(anchor, idx + 1);
        const offPx = Math.min(p.r, 300) + 14 + idx * 17;
        const s = (offPx / pxPerRad) * camDist;
        rel = [rel[0] + up.x * s, rel[1] + up.y * s, rel[2] + up.z * s];
        camDist = Math.hypot(rel[0] - camPos.x, rel[1] - camPos.y, rel[2] - camPos.z);
        // follow the anchor's automatic hiding (zoom rules, categories) but not an explicit per-body hide:
        // custom objects have their own visibility toggles
        if (p && !p.visible && !p.userHidden && !pinned) visible = false;
      }

      e.marker.visible = visible;
      if (visible) {
        e.marker.position.set(rel[0], rel[1], rel[2]);
        const sc = ((o.type === 'fleet' ? MARKER_PX * 1.35 : MARKER_PX) / pxPerRad) * camDist;
        e.marker.scale.setScalar(sc);
        if (e.shape !== 'octa') e.marker.quaternion.copy(camera.quaternion);
      }

      // orbit ellipse
      if (e.orbitLine) {
        const show = visible && toggles.orbits;
        e.orbitLine.visible = show;
        if (show) {
          const { el, mu } = orbitMotionElements(m);
          const n = el.n || 0;
          const b = e.orbitBuilt;
          const parent = fc.screen.get(m.parent);
          const pd = parent ? parent.camDist : camDist;
          if (!b || (n > 0 && (el.a * n * Math.abs(jd - b.jd)) / Math.max(0.05, 1 - el.e) > 0.0015 * Math.max(pd, camDist))) {
            setLinePoints(e.orbitLine, sampleOrbit(el, mu, jd, 360).points);
            e.orbitBuilt = { jd };
          }
          const pp = positionOf(m.parent, jd, ctx) ?? [0, 0, 0];
          e.orbitLine.position.set(pp[0] - F[0], pp[1] - F[1], pp[2] - F[2]);
          e.orbitLine.material.opacity = o.id === selection ? 0.95 : 0.6;
        }
      }

      // route paths: dim past, bright future
      const showPath = visible && o.showPath !== false && e.paths.length > 0;
      for (const p of e.paths) {
        p.past.visible = p.future.visible = showPath;
        if (!showPath) continue;
        p.past.position.set(p.origin[0] - F[0], p.origin[1] - F[1], p.origin[2] - F[2]);
        p.future.position.copy(p.past.position);
        const N = p.n - 1;
        const k = Math.min(N, lastIndexAtOrBefore(p.jds, jd));
        // Both lines share one geometry; their draw ranges are applied in onBeforeRender (see buildPaths).
        p.past.visible = k > 0;
        p.future.visible = k < N;
        p.pastRange[0] = 0; p.pastRange[1] = k + 1;
        p.futureRange[0] = k; p.futureRange[1] = N + 1 - k;
      }
      for (const r of e.rings) {
        r.sprite.visible = showPath;
        if (!showPath) continue;
        r.sprite.position.set(r.pos[0] - F[0], r.pos[1] - F[1], r.pos[2] - F[2]);
        r.sprite.scale.setScalar(FLYBY_RING_PX / pxPerRad);
      }

      // label
      e.label.position.set(rel[0], rel[1], rel[2]);
      const err = ctx.errors.get(o.id);
      e.errEl.hidden = !err;
      if (err) e.labelEl.title = err; else e.labelEl.removeAttribute('title');
      const scr = fc.project(rel[0], rel[1], rel[2]);
      const margin = MARKER_PX + 5;
      if (margin !== e.marginPx) { e.labelEl.style.marginLeft = `${margin}px`; e.marginPx = margin; }
      const item = {
        id: o.id, kind: 'custom', x: scr.x, y: scr.y, behind: scr.behind, r: MARKER_PX, visible,
        priority: 400 + (o.id === selection ? 1000 : 0) + (o.id === focus ? 800 : 0),
        label: e.label, labelEl: e.labelEl, labelW: e.labelW, wantLabel: visible && toggles.labels && !scr.behind,
        rel, camDist,
      };
      fc.items.push(item);
      fc.screen.set(o.id, item);
    }
  }

  return { sync, update, refreshPaths, entries };
}
