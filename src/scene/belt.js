// Asteroid-belt point cloud: every asteroid with H < 13 (larger than about 10 km) inside 6 AU from the JPL SBDB
// (src/data/belt.json, scripts/fetch-belt.mjs), moved along its Kepler orbit on the CPU whenever the simulation time
// changes, plus optional labelled rings at the main Kirkwood gaps.
import * as THREE from 'three';
import { CSS2DObject } from 'three/addons/renderers/CSS2DRenderer.js';
import { GM_SUN, DEG } from '../astro/constants.js';

/** Main Kirkwood gaps (mean-motion resonances with Jupiter): [a in AU, resonance]. */
export const KIRKWOOD_GAPS = [[2.06, '4:1'], [2.50, '3:1'], [2.82, '5:2'], [2.95, '7:3'], [3.27, '2:1']];

/** Belt zones by semi-major axis, with display colours. */
export const BELT_ZONES = [
  { key: 'inner', label: 'Inner belt (< 2.5 AU)', test: (a) => a < 2.5, color: '#9fb2c9' },
  { key: 'middle', label: 'Middle belt (2.5–2.82 AU)', test: (a) => a < 2.82, color: '#c9bd98' },
  { key: 'outer', label: 'Outer belt (> 2.82 AU)', test: (a) => a < 3.7, color: '#c99a78' },
  { key: 'hilda', label: 'Hildas (~4 AU, 3:2 with Jupiter)', test: (a) => a < 4.6, color: '#86c7a5' },
  { key: 'trojan', label: 'Jupiter Trojans (5.2 AU)', test: () => true, color: '#c99ad6' },
];

const POINT_PX = 1.5;
const OPACITY = 0.7;
const HOVER_PX = 6;

/**
 * @param {THREE.Scene} scene
 * @returns {{update:(fc:Object)=>void, pickAt:(x:number, y:number)=>{name:string, a:number, H:number, zone:string}|null,
 *   ready:()=>boolean, count:()=>number}}
 */
export function createBelt(scene) {
  const group = new THREE.Group();
  group.name = 'belt';
  scene.add(group);

  // ---- Kirkwood gap rings (static, Sun-centred)
  const gapGroup = new THREE.Group();
  gapGroup.visible = false;
  group.add(gapGroup);
  const gapMat = new THREE.LineDashedMaterial({ color: '#ff7a59', transparent: true, opacity: 0.85, dashSize: 0.05, gapSize: 0.035, depthWrite: false });
  const gapLabels = [];
  for (const [a, res] of KIRKWOOD_GAPS) {
    const pts = [];
    for (let k = 0; k <= 360; k++) { const t = (k / 360) * Math.PI * 2; pts.push(new THREE.Vector3(a * Math.cos(t), a * Math.sin(t), 0)); }
    const line = new THREE.Line(new THREE.BufferGeometry().setFromPoints(pts), gapMat);
    line.computeLineDistances();
    line.frustumCulled = false;
    gapGroup.add(line);
    const el = document.createElement('div');
    el.className = 'label label-gap';
    el.textContent = `${res} gap · ${a.toFixed(2)} AU`;
    const lab = new CSS2DObject(el);
    lab.center.set(0.5, 0.5);
    // labels alternate between the +y and -y side of the rings so neighbouring gaps do not collide
    const side = gapLabels.length % 2 === 0 ? 1 : -1;
    lab.center.set(0.5, side > 0 ? 1.15 : -0.15);
    lab.position.set(0, side * a, 0);
    gapGroup.add(lab);
    gapLabels.push({ label: lab, el, a });
  }

  // ---- point cloud (filled once the data chunk has loaded)
  let n = 0;
  let el = null;         // Float64Array: per object [n, M0, epoch, e, Pa(3), Qb(3)] (10 numbers)
  let names = [], aArr = null, hArr = null, zoneIdx = null;
  let points = null, posAttr = null;
  let lastJd = NaN, frameNo = 0;
  const origin = [0, 0, 0];   // heliocentric point the float32 positions are relative to
  const helio = { arr: null }; // Float64 heliocentric positions (for hover picking)
  let loaded = false;

  import('../data/belt.json').then((mod) => {
    const doc = mod.default ?? mod;
    build(doc);
  }).catch((err) => console.error('belt data failed to load', err));

  function build(doc) {
    const rows = doc.data;
    n = rows.length;
    names = doc.names;
    el = new Float64Array(n * 10);
    aArr = new Float32Array(n);
    hArr = new Float32Array(n);
    zoneIdx = new Uint8Array(n);
    const col = new Float32Array(n * 3);
    const c = new THREE.Color();
    const zoneColors = BELT_ZONES.map((z) => new THREE.Color(z.color));
    for (let k = 0; k < n; k++) {
      const [a, e, iDeg, omDeg, wDeg, maDeg, H, epoch] = rows[k];
      const i = iDeg * DEG, om = omDeg * DEG, w = wDeg * DEG;
      const cO = Math.cos(om), sO = Math.sin(om), cI = Math.cos(i), sI = Math.sin(i), cw = Math.cos(w), sw = Math.sin(w);
      // perifocal unit vectors P (to periapsis) and Q in the ecliptic frame
      const P = [cO * cw - sO * sw * cI, sO * cw + cO * sw * cI, sw * sI];
      const Q = [-cO * sw - sO * cw * cI, -sO * sw + cO * cw * cI, cw * sI];
      const b = a * Math.sqrt(1 - e * e);
      const o = k * 10;
      el[o] = Math.sqrt(GM_SUN / (a * a * a));
      el[o + 1] = maDeg * DEG;
      el[o + 2] = epoch ?? doc.epoch;
      el[o + 3] = e;
      el[o + 4] = a * P[0]; el[o + 5] = a * P[1]; el[o + 6] = a * P[2];
      el[o + 7] = b * Q[0]; el[o + 8] = b * Q[1]; el[o + 9] = b * Q[2];
      aArr[k] = a;
      hArr[k] = H;
      const z = BELT_ZONES.findIndex((zz) => zz.test(a));
      zoneIdx[k] = z;
      c.copy(zoneColors[z]);
      // slight brightness by size (H): big asteroids a little brighter
      c.multiplyScalar(0.75 + 0.35 * Math.min(1, Math.max(0, (13 - H) / 6)));
      col[3 * k] = c.r; col[3 * k + 1] = c.g; col[3 * k + 2] = c.b;
    }
    const geom = new THREE.BufferGeometry();
    posAttr = new THREE.BufferAttribute(new Float32Array(n * 3), 3);
    posAttr.setUsage(THREE.DynamicDrawUsage);
    geom.setAttribute('position', posAttr);
    geom.setAttribute('color', new THREE.BufferAttribute(col, 3));
    const mat = new THREE.PointsMaterial({ size: POINT_PX, sizeAttenuation: false, vertexColors: true, transparent: true, opacity: OPACITY, depthWrite: false });
    points = new THREE.Points(geom, mat);
    points.frustumCulled = false;
    points.renderOrder = 1;
    group.add(points);
    helio.arr = new Float64Array(n * 3);
    loaded = true;
    lastJd = NaN;
  }

  /**
   * Recompute every asteroid's heliocentric position at jd (Kepler's equation by Newton iteration). With `mean`, each
   * asteroid is drawn at its semi-major axis (average distance) in the direction where it really is: the Kirkwood gaps
   * are gaps in semi-major axis, which orbital eccentricity smears out in a snapshot of true positions.
   */
  function compute(jd, F, mean) {
    const arr = posAttr.array, h = helio.arr;
    origin[0] = F[0]; origin[1] = F[1]; origin[2] = F[2];
    for (let k = 0; k < n; k++) {
      const o = k * 10;
      const e = el[o + 3];
      let M = (el[o + 1] + el[o] * (jd - el[o + 2])) % (2 * Math.PI);
      if (M < 0) M += 2 * Math.PI;
      let E = e < 0.8 ? M : Math.PI;
      for (let it = 0; it < 12; it++) {
        const dE = (E - e * Math.sin(E) - M) / (1 - e * Math.cos(E));
        E -= dE;
        if (Math.abs(dE) < 1e-10) break;
      }
      const x = Math.cos(E) - e, y = Math.sin(E);
      let hx = el[o + 4] * x + el[o + 7] * y, hy = el[o + 5] * x + el[o + 8] * y, hz = el[o + 6] * x + el[o + 9] * y;
      if (mean) { const f = aArr[k] / Math.hypot(hx, hy, hz); hx *= f; hy *= f; hz *= f; }
      h[3 * k] = hx; h[3 * k + 1] = hy; h[3 * k + 2] = hz;
      arr[3 * k] = hx - origin[0]; arr[3 * k + 1] = hy - origin[1]; arr[3 * k + 2] = hz - origin[2];
    }
    posAttr.needsUpdate = true;
  }

  let lastFc = null, lastMean = false;

  function update(fc) {
    lastFc = fc;
    const show = !!fc.toggles.belt;
    group.visible = show || !!fc.toggles.kirkwood;
    gapGroup.visible = !!fc.toggles.kirkwood;
    group.position.set(-fc.F[0], -fc.F[1], -fc.F[2]);
    if (gapGroup.visible) {
      const sunDist = Math.hypot(fc.F[0] + fc.camPos.x, fc.F[1] + fc.camPos.y, fc.F[2] + fc.camPos.z);
      for (const l of gapLabels) {
        const px = (l.a / Math.max(sunDist, 1e-9)) * fc.pxPerRad;
        const p = l.label.position;
        const scr = fc.project(p.x - fc.F[0], p.y - fc.F[1], p.z - fc.F[2]);
        const want = fc.toggles.labels && px > 60 && px < 6 * fc.height && !scr.behind;
        fc.items.push({ id: null, kind: 'grid', x: scr.x - 48, y: scr.y + (p.y > 0 ? -9 : 9), r: 0, visible: false, priority: 60, label: l.label, labelEl: l.el, labelW: 96, wantLabel: want });
      }
    }
    if (!loaded || !points) return;
    points.visible = show;
    if (!show) { lastJd = NaN; return; }
    frameNo++;
    const fast = fc.playing && Math.abs(fc.rate) >= 86400;
    const mean = !!fc.toggles.beltMean;
    if (mean !== lastMean) { lastMean = mean; lastJd = NaN; }
    if (fc.jd !== lastJd && (!fast || frameNo % 2 === 0 || !Number.isFinite(lastJd))) {
      compute(fc.jd, fc.F, mean);
      lastJd = fc.jd;
    }
    // positions are stored relative to `origin` (the focus when they were computed)
    points.position.set(origin[0], origin[1], origin[2]);
  }

  /** Nearest belt asteroid within a few pixels of (x, y) in the last frame, or null. */
  function pickAt(x, y) {
    if (!loaded || !points?.visible || !lastFc || !helio.arr) return null;
    const fc = lastFc;
    const m = fc.camera.matrixWorldInverse.elements, p = fc.camera.projectionMatrix.elements;
    let best = -1, bestD = HOVER_PX * HOVER_PX;
    const F = fc.F, h = helio.arr;
    for (let k = 0; k < n; k++) {
      const wx = h[3 * k] - F[0], wy = h[3 * k + 1] - F[1], wz = h[3 * k + 2] - F[2];
      const vx = m[0] * wx + m[4] * wy + m[8] * wz + m[12];
      const vy = m[1] * wx + m[5] * wy + m[9] * wz + m[13];
      const vz = m[2] * wx + m[6] * wy + m[10] * wz + m[14];
      if (vz >= 0) continue;
      const cx = p[0] * vx + p[8] * vz, cy = p[5] * vy + p[9] * vz, cw = -vz;
      const sx = (cx / cw + 1) * 0.5 * fc.width, sy = (1 - cy / cw) * 0.5 * fc.height;
      const d = (sx - x) * (sx - x) + (sy - y) * (sy - y);
      if (d < bestD) { bestD = d; best = k; }
    }
    if (best < 0) return null;
    return { name: names[best], a: aArr[best], H: hArr[best], zone: BELT_ZONES[zoneIdx[best]].label };
  }

  return { update, pickAt, ready: () => loaded, count: () => n };
}
