// Light-lag "as seen from" view: for the selected observer, a ghost marker at every other visible custom object's
// (and optionally every planet's) retarded position — where the observer's sensors see it now — joined to the true
// position by a faint line and labelled "seen 4 min 12 s ago". Self-contained: it adds and removes its own THREE
// objects and CSS2D labels, and updates them from the scene's onBeforeRender hook (after the app has placed
// everything for the frame, before anything is drawn), so ghosts use the same focus-relative origin as the rest of
// the scene and follow time every frame.
import * as THREE from 'three';
import { CSS2DObject } from 'three/addons/renderers/CSS2DRenderer.js';
import { sightings, privateContext, formatAge, planetIds } from '../sim/lightlag.js';
import { existsAt } from '../sim/custom.js';
import { getBody } from '../sim/ephemeris.js';
import { hiddenSetOf } from '../sim/store.js';

const GHOST_PX = 16;
const LABEL_H = 15;

const texCache = new Map();
/** Broken ring (four arcs) with a centre pip: a "sensor contact" marker in the given colour. */
function ghostTexture(color) {
  let t = texCache.get(color);
  if (t) return t;
  const c = document.createElement('canvas');
  c.width = c.height = 64;
  const g = c.getContext('2d');
  g.strokeStyle = color;
  g.fillStyle = color;
  g.lineWidth = 6;
  g.lineCap = 'round';
  for (let k = 0; k < 4; k++) {
    const a = (k * Math.PI) / 2 + Math.PI / 4;
    g.beginPath();
    g.arc(32, 32, 25, a - 0.48, a + 0.48);
    g.stroke();
  }
  g.beginPath();
  g.arc(32, 32, 5.5, 0, Math.PI * 2);
  g.fill();
  t = new THREE.CanvasTexture(c);
  t.colorSpace = THREE.SRGBColorSpace;
  texCache.set(color, t);
  return t;
}

/**
 * @param {Object} o
 * @param {THREE.Scene} o.scene
 * @param {() => THREE.PerspectiveCamera} o.camera
 * @param {() => {width:number, height:number}} o.viewport  size of the 3D view in CSS px
 * @param {() => import('../sim/store.js').AppState} o.getState
 * @param {() => number[]} o.focusOffset  heliocentric position F subtracted from everything this frame
 * @param {(id:string) => boolean} o.isVisible  whether the app currently draws this object / body
 * @param {() => number[][]} [o.labelObstacles]  screen rects [x0, y0, x1, y1] of the app's own visible labels and
 *   markers; ghost labels move above the ghost, or hide, rather than cover them
 */
export function createLightLagView(o) {
  const group = new THREE.Group();
  group.name = 'light-lag';
  o.scene.add(group);
  /** @type {Map<string, Object>} id -> ghost visuals */
  const ghosts = new Map();
  let enabled = false;
  let withPlanets = false;
  let memo = { key: '', list: [] };
  let pctx = null;
  let lastInfo = { observer: null, count: 0 };
  const v = new THREE.Vector3();

  function makeGhost(id, color) {
    const sprite = new THREE.Sprite(new THREE.SpriteMaterial({ map: ghostTexture(color), depthTest: false, depthWrite: false, transparent: true, opacity: 0.95, sizeAttenuation: false }));
    sprite.renderOrder = 7;
    sprite.frustumCulled = false;
    const geom = new THREE.BufferGeometry();
    geom.setAttribute('position', new THREE.BufferAttribute(new Float32Array(6), 3));
    const line = new THREE.Line(geom, new THREE.LineBasicMaterial({ color, transparent: true, opacity: 0.45, depthTest: false, depthWrite: false }));
    line.renderOrder = 6;
    line.frustumCulled = false;
    const el = document.createElement('div');
    el.className = 'label ll-label';
    el.style.color = color;
    const label = new CSS2DObject(el);
    label.center.set(0.5, -0.7);
    group.add(line, sprite, label);
    const g = { id, color, sprite, line, label, el, text: '' };
    ghosts.set(id, g);
    return g;
  }

  function disposeGhost(g) {
    group.remove(g.sprite, g.line, g.label);
    g.sprite.material.dispose();
    g.line.geometry.dispose();
    g.line.material.dispose();
    g.el.remove();
    ghosts.delete(g.id);
  }

  function setColor(g, color) {
    if (g.color === color) return;
    g.color = color;
    g.sprite.material.map = ghostTexture(color);
    g.sprite.material.needsUpdate = true;
    g.line.material.color.set(color);
    g.el.style.color = color;
  }

  function hideAll() {
    for (const g of ghosts.values()) g.sprite.visible = g.line.visible = g.label.visible = false;
  }

  /** Ids to show ghosts for: visible custom objects (and planets), never the observer. */
  function targetsFor(s, observer) {
    const hidden = hiddenSetOf(s);
    const out = [];
    for (const obj of s.objects) {
      if (obj.id === observer || hidden.has(obj.id) || !s.toggles.custom) continue;
      // drawn now (category, zoom rules), or gone now but possibly still "seen" (decided after the solve)
      if (existsAt(obj, s.jd) ? o.isVisible(obj.id) : true) out.push(obj.id);
    }
    if (withPlanets) for (const id of planetIds()) if (id !== observer && !hidden.has(id) && o.isVisible(id)) out.push(id);
    return out;
  }

  function update() {
    if (!enabled) return;
    const s = o.getState();
    const observer = s.selection;
    const obsObj = observer ? s.ctx.byId.get(observer) : null;
    if (!observer || (!getBody(observer) && !obsObj) || (obsObj && !existsAt(obsObj, s.jd))) {
      hideAll();
      lastInfo = { observer: null, count: 0 };
      return;
    }
    const targets = targetsFor(s, observer);
    const key = `${s.jd}|${observer}|${s.ctx.version}|${targets.join(',')}`;
    if (memo.key !== key) {
      if (!pctx || pctx.version !== s.ctx.version || pctx.byId !== s.ctx.byId) pctx = privateContext(s.ctx);
      memo = { key, list: sightings(observer, targets, s.jd, s.ctx, pctx) };
    }
    const list = memo.list;
    lastInfo = { observer, count: list.length };
    const F = o.focusOffset();
    const cam = o.camera();
    const { width, height } = o.viewport();
    const pxPerRad = (height / 2) / Math.tan((cam.fov * Math.PI) / 360);
    const seen = new Set();
    const placed = [];
    const obstacles = o.labelObstacles ? o.labelObstacles() : [];
    const hits = (rect, list) => list.some((p) => rect[0] < p[2] && rect[2] > p[0] && rect[1] < p[3] && rect[3] > p[1]);
    // custom objects first (they matter most), then planets; nearer sightings first within each group
    const ordered = [...list].sort((a, b) => (getBody(a.id) ? 1 : 0) - (getBody(b.id) ? 1 : 0) || a.seconds - b.seconds);
    for (const sg of ordered) {
      const obj = s.ctx.byId.get(sg.id);
      const color = obj ? obj.color || '#ff8800' : getBody(sg.id)?.color || '#cccccc';
      const g = ghosts.get(sg.id) ?? makeGhost(sg.id, color);
      setColor(g, color);
      seen.add(sg.id);
      const gx = sg.rSeen[0] - F[0], gy = sg.rSeen[1] - F[1], gz = sg.rSeen[2] - F[2];
      g.sprite.visible = true;
      g.sprite.position.set(gx, gy, gz);
      g.sprite.scale.setScalar(GHOST_PX / pxPerRad);
      // faint line from the sighting to the true position (local offsets keep float32 precision)
      const showLine = !!sg.rTrue && sg.existsNow;
      g.line.visible = showLine;
      if (showLine) {
        g.line.position.set(sg.rTrue[0] - F[0], sg.rTrue[1] - F[1], sg.rTrue[2] - F[2]);
        const arr = g.line.geometry.getAttribute('position').array;
        arr[0] = arr[1] = arr[2] = 0;
        arr[3] = sg.rSeen[0] - sg.rTrue[0];
        arr[4] = sg.rSeen[1] - sg.rTrue[1];
        arr[5] = sg.rSeen[2] - sg.rTrue[2];
        g.line.geometry.getAttribute('position').needsUpdate = true;
      }
      const text = `seen ${formatAge(sg.seconds)} ago${sg.existsNow ? '' : ' (gone since)'}`;
      if (text !== g.text) {
        g.el.textContent = text;
        g.text = text;
        g.el.title = `${obj ? obj.name : getBody(sg.id)?.name}: where the observer's sensors show it now (the light left it ${formatAge(sg.seconds)} ago)`;
      }
      g.label.position.set(gx, gy, gz);
      // label declutter: below the ghost, else above it, else hidden (never over another ghost label or app label)
      v.set(gx, gy, gz).project(cam);
      const x = (v.x + 1) * 0.5 * width, y = (1 - v.y) * 0.5 * height;
      const w = 8 + text.length * 5.6;
      let show = v.z < 1 && x > -w && x < width + w && y > -20 && y < height + 20;
      if (show) {
        const below = [x - w / 2, y + 9, x + w / 2, y + 9 + LABEL_H];
        const above = [x - w / 2, y - 9 - LABEL_H, x + w / 2, y - 9];
        const free = (r) => !hits(r, placed) && !hits(r, obstacles);
        const rect = free(below) ? below : free(above) ? above : null;
        show = !!rect;
        if (rect) {
          placed.push(rect);
          g.label.center.set(0.5, rect === below ? -0.7 : 1.7);
        }
      }
      g.label.visible = show;
    }
    for (const g of [...ghosts.values()]) {
      if (seen.has(g.id)) continue;
      if (!s.ctx.byId.has(g.id) && !getBody(g.id)) disposeGhost(g);
      else g.sprite.visible = g.line.visible = g.label.visible = false;
    }
    group.updateMatrixWorld(true);
  }

  // Run after the app positioned everything for this frame (scene.updateMatrixWorld has already run) and before
  // the render list is built; chain any existing hook.
  const prev = o.scene.onBeforeRender;
  o.scene.onBeforeRender = function (...args) {
    if (typeof prev === 'function') prev.apply(this, args);
    try { update(); } catch (err) { console.error('light-lag view:', err); enabled = false; hideAll(); }
  };

  return {
    /** Turn the view on or off. */
    setEnabled(on) {
      enabled = !!on;
      group.visible = enabled;
      if (!enabled) hideAll();
      memo = { key: '', list: [] };
    },
    /** Include the eight planets. */
    setPlanets(on) { withPlanets = !!on; memo = { key: '', list: [] }; },
    get enabled() { return enabled; },
    /** Last frame's observer id (null when there is none) and number of ghosts. */
    get info() { return lastInfo; },
    /** The last computed sightings (for tests and tooling). */
    get sightings() { return memo.list; },
    dispose() {
      for (const g of [...ghosts.values()]) disposeGhost(g);
      o.scene.remove(group);
      o.scene.onBeforeRender = prev;
    },
  };
}
