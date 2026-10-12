// Small three.js helpers shared by the scene modules.
import * as THREE from 'three';

/**
 * Canvas-generated texture (procedural; no image files).
 * @param {number} size canvas size in px
 * @param {(ctx:CanvasRenderingContext2D, size:number) => void} draw
 */
export function canvasTexture(size, draw) {
  const c = document.createElement('canvas');
  c.width = c.height = size;
  draw(c.getContext('2d'), size);
  const tex = new THREE.CanvasTexture(c);
  tex.colorSpace = THREE.SRGBColorSpace;
  return tex;
}

/** Radial glow (white centre fading out), used for the Sun. */
export function glowTexture() {
  return canvasTexture(128, (g, s) => {
    const grd = g.createRadialGradient(s / 2, s / 2, 0, s / 2, s / 2, s / 2);
    grd.addColorStop(0, 'rgba(255,248,225,1)');
    grd.addColorStop(0.18, 'rgba(255,236,190,0.85)');
    grd.addColorStop(0.42, 'rgba(255,205,120,0.28)');
    grd.addColorStop(1, 'rgba(255,180,80,0)');
    g.fillStyle = grd;
    g.fillRect(0, 0, s, s);
  });
}

/** Thin ring outline (selection indicator). */
export function ringTexture(color = '#5aa9ff') {
  return canvasTexture(128, (g, s) => {
    g.strokeStyle = color;
    g.lineWidth = 5;
    g.beginPath();
    g.arc(s / 2, s / 2, s / 2 - 5, 0, Math.PI * 2);
    g.stroke();
  });
}

/**
 * Create a Line whose geometry can be rewritten in place (fixed capacity).
 * @param {number} capacity number of vertices
 * @param {THREE.Material} material
 */
export function makeDynamicLine(capacity, material) {
  const geom = new THREE.BufferGeometry();
  const attr = new THREE.BufferAttribute(new Float32Array(capacity * 3), 3);
  attr.setUsage(THREE.DynamicDrawUsage);
  geom.setAttribute('position', attr);
  geom.setDrawRange(0, 0);
  const line = new THREE.Line(geom, material);
  line.frustumCulled = false;
  return line;
}

/**
 * Write points (array of [x,y,z]) into a dynamic line's geometry.
 * @param {THREE.Line} line
 * @param {number[][]} points
 */
export function setLinePoints(line, points) {
  const attr = line.geometry.getAttribute('position');
  const arr = attr.array;
  const n = Math.min(points.length, arr.length / 3);
  for (let k = 0; k < n; k++) {
    const p = points[k];
    arr[3 * k] = p[0];
    arr[3 * k + 1] = p[1];
    arr[3 * k + 2] = p[2];
  }
  attr.needsUpdate = true;
  line.geometry.setDrawRange(0, n);
}

/** Linear blend of two hex colours. */
export function mixColor(a, b, t) {
  return new THREE.Color(a).lerp(new THREE.Color(b), t);
}

/** Ease-out cubic. */
export const easeOut = (t) => 1 - Math.pow(1 - Math.min(1, Math.max(0, t)), 3);
