// Ecliptic reference grid centred on the Sun: distance rings, radial spokes, AU labels. §6.
import * as THREE from 'three';
import { CSS2DObject } from 'three/addons/renderers/CSS2DRenderer.js';

const RADII = [0.39, 0.72, 1, 1.52, 2, 3, 5, 10, 20, 30, 50, 100];
/** Rings near planetary distances are drawn a little brighter. */
const PLANETARY = new Set([0.39, 0.72, 1, 1.52, 5, 10, 20, 30]);
const LABEL_ANGLE = -32 * Math.PI / 180;

/** @param {THREE.Scene} scene */
export function createGrid(scene) {
  const group = new THREE.Group();
  group.name = 'grid';
  scene.add(group);
  const faint = new THREE.LineBasicMaterial({ color: '#3a4a5e', transparent: true, opacity: 0.28, depthWrite: false });
  const bright = new THREE.LineBasicMaterial({ color: '#4d6380', transparent: true, opacity: 0.45, depthWrite: false });
  const labels = [];
  for (const r of RADII) {
    const pts = [];
    const seg = 256;
    for (let k = 0; k < seg; k++) {
      const a = (k / seg) * Math.PI * 2;
      pts.push(new THREE.Vector3(r * Math.cos(a), r * Math.sin(a), 0));
    }
    const loop = new THREE.LineLoop(new THREE.BufferGeometry().setFromPoints(pts), PLANETARY.has(r) ? bright : faint);
    loop.frustumCulled = false;
    group.add(loop);
    const el = document.createElement('div');
    el.className = 'label label-grid';
    el.textContent = `${r} AU`;
    const lab = new CSS2DObject(el);
    lab.center.set(0.5, 0.5);
    lab.position.set(r * Math.cos(LABEL_ANGLE), r * Math.sin(LABEL_ANGLE), 0);
    group.add(lab);
    labels.push({ r, label: lab, el });
  }
  const spokePts = [];
  for (let k = 0; k < 12; k++) {
    const a = (k / 12) * Math.PI * 2;
    spokePts.push(new THREE.Vector3(0.39 * Math.cos(a), 0.39 * Math.sin(a), 0), new THREE.Vector3(100 * Math.cos(a), 100 * Math.sin(a), 0));
  }
  const spokes = new THREE.LineSegments(new THREE.BufferGeometry().setFromPoints(spokePts), faint);
  spokes.frustumCulled = false;
  group.add(spokes);

  function update(fc) {
    const show = fc.toggles.grid;
    group.visible = show;
    if (!show) return;
    group.position.set(-fc.F[0], -fc.F[1], -fc.F[2]);
    const sunDist = Math.hypot(fc.F[0] + fc.camPos.x, fc.F[1] + fc.camPos.y, fc.F[2] + fc.camPos.z);
    for (const l of labels) {
      const px = (l.r / Math.max(sunDist, 1e-9)) * fc.pxPerRad;
      const rel = [l.label.position.x - fc.F[0], l.label.position.y - fc.F[1], l.label.position.z - fc.F[2]];
      const scr = fc.project(rel[0], rel[1], rel[2]);
      const want = fc.toggles.labels && px > 40 && px < 4 * fc.height && !scr.behind;
      fc.items.push({ id: null, kind: 'grid', x: scr.x - 18, y: scr.y, r: 0, visible: false, priority: 50 - l.r * 0.01, label: l.label, labelEl: l.el, labelW: 40, wantLabel: want });
    }
  }
  return { update };
}
