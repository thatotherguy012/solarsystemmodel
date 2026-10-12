// Procedural starfield: 5000 random directions at 5e4 AU, fixed pixel size, subtle colour variation. §6.
import * as THREE from 'three';

/** @param {THREE.Scene} scene */
export function createStarfield(scene, count = 5000) {
  const pos = new Float32Array(count * 3);
  const col = new Float32Array(count * 3);
  // Deterministic PRNG so the sky is the same every session.
  let seed = 1234567;
  const rnd = () => ((seed = (seed * 1664525 + 1013904223) >>> 0) / 4294967296);
  const R = 5e4;
  const c = new THREE.Color();
  for (let k = 0; k < count; k++) {
    const z = 2 * rnd() - 1, t = 2 * Math.PI * rnd(), s = Math.sqrt(1 - z * z);
    pos[3 * k] = R * s * Math.cos(t);
    pos[3 * k + 1] = R * s * Math.sin(t);
    pos[3 * k + 2] = R * z;
    const temp = rnd();
    const bright = 0.35 + 0.65 * Math.pow(rnd(), 2.2);
    if (temp < 0.15) c.setRGB(0.75, 0.82, 1.0);
    else if (temp < 0.3) c.setRGB(1.0, 0.86, 0.7);
    else c.setRGB(0.95, 0.95, 0.93);
    c.multiplyScalar(bright);
    col[3 * k] = c.r; col[3 * k + 1] = c.g; col[3 * k + 2] = c.b;
  }
  const geom = new THREE.BufferGeometry();
  geom.setAttribute('position', new THREE.BufferAttribute(pos, 3));
  geom.setAttribute('color', new THREE.BufferAttribute(col, 3));
  const mat = new THREE.PointsMaterial({ size: 1.5, sizeAttenuation: false, vertexColors: true, depthWrite: false, transparent: true, opacity: 0.9 });
  const points = new THREE.Points(geom, mat);
  points.frustumCulled = false;
  points.renderOrder = -1;
  scene.add(points);
  return {
    /** Keep the sphere centred on the camera so stars show no parallax. */
    update(fc) { points.position.copy(fc.camPos); },
  };
}
