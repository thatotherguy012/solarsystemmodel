// three.js setup, render loop, focus-relative origin, camera views/transitions, picking, label declutter. §6.
import * as THREE from 'three';
import { OrbitControls } from 'three/addons/controls/OrbitControls.js';
import { CSS2DRenderer } from 'three/addons/renderers/CSS2DRenderer.js';
import { AU_KM } from '../astro/constants.js';
import { store, hiddenSetOf } from '../sim/store.js';
import { tick } from '../sim/clock.js';
import { getBody, hasBody } from '../sim/ephemeris.js';
import { positionOf, routePhase, existsAt } from '../sim/custom.js';
import { createBodies, largestMoonOrbitAu } from './bodies.js';
import { createCustomObjects } from './customObjects.js';
import { createGrid } from './grid.js';
import { createStarfield } from './starfield.js';
import { createMeasure } from './measure.js';
import { ringTexture, easeOut } from './util.js';

const FOV = 50;
const TRANSITION_S = 0.6;
const PICK_PX = 14;
const DRAG_PX = 5;

/**
 * Camera distance (AU) to use when focusing an object (§6): max(6 R, 2.5 × largest moon orbit, 1e-5 AU),
 * with sensible choices for the Sun and custom objects.
 */
export function focusDistanceFor(id, jd, ctx, depth = 0) {
  if (id === 'sun') return 3.5;
  const b = getBody(id);
  if (b) return Math.max(6 * (b.radiusKm / AU_KM), 2.5 * largestMoonOrbitAu(id), 1e-5);
  const o = ctx.byId.get(id);
  if (!o || depth > 3) return 0.02;
  const m = o.motion || {};
  switch (m.kind) {
    case 'orbit': return Math.max(2.5 * (m.aKm / AU_KM) * (1 + (m.e || 0)), 1e-5);
    case 'colocated': return focusDistanceFor(m.parent, jd, ctx, depth + 1);
    case 'lagrange': {
      const p = positionOf(o.id, jd, ctx), s = positionOf(m.secondary, jd, ctx);
      return p && s ? Math.max(2.5 * Math.hypot(p[0] - s[0], p[1] - s[1], p[2] - s[2]), 1e-5) : 0.02;
    }
    case 'route': {
      const ph = routePhase(m, jd);
      if (ph.kind !== 'transit' && ph.stop != null && m.stops[ph.stop]?.ref) return focusDistanceFor(m.stops[ph.stop].ref, jd, ctx, depth + 1);
      return 0.05;
    }
    default: return 0.05;
  }
}

/**
 * Create the 3D view inside `container`.
 * @param {HTMLElement} container
 * @param {{ onPick:(id:string)=>void, onLabelCreated?:(el:HTMLElement,id:string)=>void }} opts
 */
export function createRenderer(container, opts) {
  const renderer = new THREE.WebGLRenderer({ antialias: true, logarithmicDepthBuffer: true });
  renderer.setPixelRatio(Math.min(window.devicePixelRatio || 1, 2));
  renderer.domElement.className = 'gl-canvas';
  container.appendChild(renderer.domElement);
  const labelRenderer = new CSS2DRenderer();
  labelRenderer.domElement.className = 'label-layer';
  container.appendChild(labelRenderer.domElement);

  const scene = new THREE.Scene();
  scene.background = new THREE.Color('#03050a');
  const camera = new THREE.PerspectiveCamera(FOV, 1, 1e-7, 1e7);
  camera.up.set(0, 0, 1);
  camera.position.set(0, -3.5 * Math.cos(35 * Math.PI / 180), 3.5 * Math.sin(35 * Math.PI / 180));
  camera.lookAt(0, 0, 0);

  const controls = new OrbitControls(camera, container);
  controls.enablePan = false;
  controls.enableDamping = true;
  controls.dampingFactor = 0.09;
  controls.zoomSpeed = 2.2;
  controls.rotateSpeed = 0.7;
  controls.minDistance = 2e-7;
  controls.maxDistance = 5000;
  controls.target.set(0, 0, 0);

  const sunLight = new THREE.PointLight(0xffffff, 3, 0, 0);
  scene.add(sunLight, new THREE.AmbientLight(0xffffff, 0.35));

  const starfield = createStarfield(scene);
  const grid = createGrid(scene);
  const bodies = createBodies(scene, { onLabelCreated: opts.onLabelCreated });
  const custom = createCustomObjects(scene, { onLabelCreated: opts.onLabelCreated });
  const measure = createMeasure(scene);

  const selRing = new THREE.Sprite(new THREE.SpriteMaterial({ map: ringTexture('#5aa9ff'), depthTest: false, depthWrite: false, transparent: true, sizeAttenuation: false }));
  selRing.renderOrder = 20;
  selRing.frustumCulled = false;
  scene.add(selRing);

  let width = 1, height = 1, pxPerRad = 1;
  function resize() {
    const r = container.getBoundingClientRect();
    width = Math.max(1, Math.floor(r.width));
    height = Math.max(1, Math.floor(r.height));
    renderer.setSize(width, height, false);
    renderer.domElement.style.width = `${width}px`;
    renderer.domElement.style.height = `${height}px`;
    labelRenderer.setSize(width, height);
    camera.aspect = width / height;
    camera.updateProjectionMatrix();
    pxPerRad = (height / 2) / Math.tan((FOV * Math.PI) / 360);
  }
  new ResizeObserver(resize).observe(container);
  resize();

  // ---------------------------------------------------------------- focus & camera transitions
  let displayedFocus = store.get().focus;
  /** @type {null | {fromPos:number[], toId:string, t0:number, d0:number, d1:number, dir0:THREE.Vector3, dir1:THREE.Vector3}} */
  let transition = null;
  let lastF = [0, 0, 0];

  function worldPos(id, jd, ctx) {
    return positionOf(id, jd, ctx) ?? [0, 0, 0];
  }

  /**
   * Start a camera move: to focus `id` (optional), to distance d1 (optional), to direction dir1 (optional).
   */
  function moveCamera({ id = null, distance = null, dir = null, animate = true } = {}) {
    const s = store.get();
    const d0 = camera.position.length();
    const dir0 = camera.position.clone().normalize();
    transition = {
      fromPos: lastF.slice(), toId: id ?? displayedFocus, t0: performance.now(), d0, d1: distance ?? d0,
      dir0, dir1: dir ? dir.clone().normalize() : dir0.clone(), dur: animate ? TRANSITION_S : 0,
    };
    displayedFocus = transition.toId;
    if (id && s.focus !== id) store.set({ focus: id });
  }

  store.subscribe((s, changed) => {
    if (changed.includes('focus') && s.focus !== displayedFocus) {
      moveCamera({ id: s.focus, distance: focusDistanceFor(s.focus, s.jd, s.ctx) });
    }
    if (changed.includes('objects') || changed.includes('ctx')) custom.sync(s.objects, s.ctx);
  });

  const dirFor = (elevDeg, fromDir) => {
    const az = Math.atan2(fromDir.y, fromDir.x);
    const el = (elevDeg * Math.PI) / 180;
    return new THREE.Vector3(Math.cos(el) * Math.cos(az), Math.cos(el) * Math.sin(az), Math.sin(el));
  };

  /** Apply a named view from the View menu. */
  function setView(name) {
    const s = store.get();
    const cur = camera.position.clone().normalize();
    if (Math.hypot(cur.x, cur.y) < 1e-3) cur.set(0, -1, 0);
    switch (name) {
      case 'top': moveCamera({ dir: new THREE.Vector3(0, -1e-4, 1) }); break;
      case 'oblique': moveCamera({ dir: dirFor(35, cur) }); break;
      case 'inner': moveCamera({ id: 'sun', distance: 3.5, dir: dirFor(35, cur) }); break;
      case 'outer': moveCamera({ id: 'sun', distance: 45, dir: dirFor(35, cur) }); break;
      case 'kuiper': moveCamera({ id: 'sun', distance: 110, dir: dirFor(35, cur) }); break;
      case 'frame': {
        const id = s.selection ?? s.focus;
        moveCamera({ id, distance: focusDistanceFor(id, s.jd, s.ctx) });
        break;
      }
      default: break;
    }
  }

  // ---------------------------------------------------------------- picking & hover
  let lastItems = [];
  let hoverId = null;
  const ndc = new THREE.Vector3();
  const view = new THREE.Vector3();

  function project(x, y, z) {
    view.set(x, y, z).applyMatrix4(camera.matrixWorldInverse);
    const behind = view.z >= 0;
    ndc.set(x, y, z).project(camera);
    return { x: (ndc.x + 1) * 0.5 * width, y: (1 - ndc.y) * 0.5 * height, behind };
  }

  /** Nearest visible object within PICK_PX of (x, y) (container coordinates). */
  function pickAt(x, y) {
    let best = null, bestD = Infinity;
    for (const it of lastItems) {
      if (!it.visible || !it.id || it.behind) continue;
      const d = Math.hypot(it.x - x, it.y - y) - Math.max(0, it.r);
      const score = d - it.priority * 1e-4;
      if (d <= PICK_PX && score < bestD) { bestD = score; best = it.id; }
    }
    return best;
  }

  function setHover(id) {
    if (id === hoverId) return;
    const prev = hoverId && lastItems.find((i) => i.id === hoverId);
    if (prev?.labelEl) prev.labelEl.classList.remove('hover');
    hoverId = id;
    const cur = id && lastItems.find((i) => i.id === id);
    if (cur?.labelEl) cur.labelEl.classList.add('hover');
    container.style.cursor = id ? 'pointer' : '';
  }

  let down = null;
  container.addEventListener('pointerdown', (ev) => {
    if (ev.button !== 0) return;
    // Remember a label under the pointer now: OrbitControls captures the pointer, so pointerup targets the container.
    down = { x: ev.clientX, y: ev.clientY, labelId: ev.target.closest?.('.label[data-id]')?.dataset.id ?? null };
  });
  container.addEventListener('pointerup', (ev) => {
    if (!down || ev.button !== 0) return;
    const moved = Math.hypot(ev.clientX - down.x, ev.clientY - down.y);
    const labelId = down.labelId;
    down = null;
    if (moved > DRAG_PX) return;
    let id = labelId ?? ev.target.closest?.('.label[data-id]')?.dataset.id ?? null;
    if (!id) {
      const r = container.getBoundingClientRect();
      id = pickAt(ev.clientX - r.left, ev.clientY - r.top);
    }
    if (id) opts.onPick(id);
  });
  container.addEventListener('pointermove', (ev) => {
    if (ev.buttons) return;
    const labelEl = ev.target.closest?.('.label[data-id]');
    if (labelEl) { setHover(labelEl.dataset.id); return; }
    const r = container.getBoundingClientRect();
    setHover(pickAt(ev.clientX - r.left, ev.clientY - r.top));
  });
  container.addEventListener('pointerleave', () => setHover(null));
  controls.addEventListener('end', () => store.set({ cameraDistance: camera.position.length() }));

  // ---------------------------------------------------------------- label declutter
  function declutter(items) {
    const cands = items.filter((it) => it.label);
    cands.sort((a, b) => b.priority - a.priority);
    const placed = [];
    for (const it of cands) {
      let show = it.wantLabel && !it.behind && it.x > -200 && it.x < width + 50 && it.y > -20 && it.y < height + 20;
      if (show) {
        const x0 = it.kind === 'grid' ? it.x : it.x + Math.min(it.r, 400) + 4;
        const rect = [x0, it.y - 8, x0 + it.labelW, it.y + 8];
        for (const p of placed) {
          if (rect[0] < p[2] && rect[2] > p[0] && rect[1] < p[3] && rect[3] > p[1]) { show = false; break; }
        }
        if (show) placed.push(rect);
      }
      it.label.visible = show;
    }
  }

  // ---------------------------------------------------------------- loop
  let lastT = performance.now();
  let selectedLabelId = null;
  const infoListeners = new Set();

  function frame() {
    const now = performance.now();
    const dt = (now - lastT) / 1000;
    lastT = now;
    tick(dt);
    const s = store.get();
    const { jd, ctx } = s;

    // camera transition (focus offset tween + distance/direction tween)
    let F;
    if (transition) {
      const u = transition.dur > 0 ? (now - transition.t0) / (transition.dur * 1000) : 1;
      const e = easeOut(u);
      const to = worldPos(transition.toId, jd, ctx);
      F = [0, 1, 2].map((k) => transition.fromPos[k] + (to[k] - transition.fromPos[k]) * e);
      const d = Math.exp(Math.log(transition.d0) + (Math.log(transition.d1) - Math.log(transition.d0)) * e);
      const dir = transition.dir0.clone().lerp(transition.dir1, e).normalize();
      camera.position.copy(dir.multiplyScalar(d));
      if (u >= 1) { transition = null; store.set({ cameraDistance: d }); }
    } else {
      F = worldPos(displayedFocus, jd, ctx);
    }
    lastF = F;
    // keep the camera outside the focused body
    const fb = getBody(displayedFocus);
    controls.minDistance = Math.max(2e-7, fb ? (fb.radiusKm / AU_KM) * 1.15 : 2e-7);
    if (!transition) controls.update();
    else camera.lookAt(0, 0, 0);
    camera.updateMatrixWorld();

    sunLight.position.set(-F[0], -F[1], -F[2]);
    const fc = {
      jd, F, ctx, camera, camPos: camera.position, pxPerRad, width, height, toggles: s.toggles, markerPx: s.markerPx,
      selection: s.selection, focus: displayedFocus, measure: s.measure, items: [], screen: new Map(), project,
      hidden: hiddenSetOf(s),
    };
    starfield.update(fc);
    grid.update(fc);
    bodies.update(fc);
    custom.update(fc);
    measure.update(fc);

    // selection ring
    const sel = s.selection && fc.screen.get(s.selection);
    selRing.visible = !!(sel && sel.visible && !sel.behind && sel.r < 40); // large discs need no ring
    if (selRing.visible) {
      selRing.position.set(sel.rel[0], sel.rel[1], sel.rel[2]);
      selRing.scale.setScalar(Math.max(20, 2 * Math.min(sel.r, 2000) + 12) / pxPerRad);
    }
    if (selectedLabelId !== s.selection) {
      for (const it of fc.items) if (it.labelEl) it.labelEl.classList.toggle('selected', it.id === s.selection);
      selectedLabelId = s.selection;
    }

    declutter(fc.items);
    renderer.render(scene, camera);
    labelRenderer.render(scene, camera);
    lastItems = fc.items;
    for (const fn of infoListeners) fn({ distance: camera.position.length(), focus: displayedFocus, jd });
    requestAnimationFrame(frame);
  }

  // initial sync & start
  custom.sync(store.get().objects, store.get().ctx);
  const initDist = store.get().cameraDistance ?? focusDistanceFor(displayedFocus, store.get().jd, store.get().ctx);
  camera.position.setLength(initDist);
  requestAnimationFrame(frame);

  return {
    setView,
    moveCamera,
    /** Subscribe to per-frame camera info ({distance, focus, jd}). */
    onFrame(fn) { infoListeners.add(fn); return () => infoListeners.delete(fn); },
    /** Re-sync custom-object visuals (e.g. after a bulk import). */
    syncCustom() { const s = store.get(); custom.sync(s.objects, s.ctx); },
    /** Redraw route paths whose N-body trajectories have arrived since they were built. */
    refreshPaths() { custom.refreshPaths(store.get().ctx); },
    isVisibleAt(id) { const it = lastItems.find((i) => i.id === id); return !!it?.visible; },
    get camera() { return camera; },
    get items() { return lastItems; },
    existsAt,
    _debug: { custom, bodies, scene },
    hasBody,
  };
}
