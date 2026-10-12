// Measurement line between two objects with a mid-point distance / light-time label. §6.
import * as THREE from 'three';
import { CSS2DObject } from 'three/addons/renderers/CSS2DRenderer.js';
import { AU_KM, LIGHT_S_PER_AU } from '../astro/constants.js';
import { positionOf } from '../sim/custom.js';
import { fmtAu, fmtMkm, fmtLightTime, fmtKm } from '../ui/format.js';

/** @param {THREE.Scene} scene */
export function createMeasure(scene) {
  const geom = new THREE.BufferGeometry();
  geom.setAttribute('position', new THREE.BufferAttribute(new Float32Array(6), 3));
  const line = new THREE.Line(geom, new THREE.LineBasicMaterial({ color: '#ffd166', transparent: true, opacity: 0.95, depthTest: false }));
  line.frustumCulled = false;
  line.renderOrder = 10;
  line.visible = false;
  const el = document.createElement('div');
  el.className = 'label label-measure';
  const label = new CSS2DObject(el);
  label.center.set(0.5, 1.3);
  label.visible = false;
  scene.add(line, label);
  let lastText = '';

  /** Text for a distance in AU. */
  function text(d) {
    const km = d * AU_KM;
    const dist = d < 0.01 ? fmtKm(km) : `${fmtAu(d)} · ${fmtMkm(km)}`;
    return `${dist} · ${fmtLightTime(d * LIGHT_S_PER_AU)} light`;
  }

  function update(fc) {
    const m = fc.measure;
    const show = !!(m && m.a && m.b);
    line.visible = label.visible = show;
    if (!show) return;
    const A = fc.screen.get(m.a)?.rel ?? relOf(m.a, fc);
    const B = fc.screen.get(m.b)?.rel ?? relOf(m.b, fc);
    const pa = positionOf(m.a, fc.jd, fc.ctx), pb = positionOf(m.b, fc.jd, fc.ctx);
    if (!A || !B || !pa || !pb) { line.visible = label.visible = false; return; }
    const arr = geom.getAttribute('position').array;
    arr.set([A[0], A[1], A[2], B[0], B[1], B[2]]);
    geom.getAttribute('position').needsUpdate = true;
    // True distance uses true positions (screen offsets for co-located markers are ignored).
    const d = Math.hypot(pa[0] - pb[0], pa[1] - pb[1], pa[2] - pb[2]);
    label.position.set((A[0] + B[0]) / 2, (A[1] + B[1]) / 2, (A[2] + B[2]) / 2);
    const t = text(d);
    if (t !== lastText) { el.textContent = t; lastText = t; }
  }

  function relOf(id, fc) {
    const p = positionOf(id, fc.jd, fc.ctx);
    return p ? [p[0] - fc.F[0], p[1] - fc.F[1], p[2] - fc.F[2]] : null;
  }

  return { update, text };
}
