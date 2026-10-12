// Command-mode preview: the planned path of each commanded ship while the user hovers a target, and a small marker
// for a point target on the ecliptic plane. Points are heliocentric; they are stored relative to the path's first
// point (float32 precision) and placed relative to the focus every frame like everything else.
import * as THREE from 'three';
import { ringTexture } from './util.js';

const CAPACITY = 260;
const MARKER_PX = 16;

/** @param {THREE.Scene} scene */
export function createPreview(scene) {
  const group = new THREE.Group();
  group.name = 'command-preview';
  scene.add(group);
  /** @type {{line:THREE.Line, origin:number[]}[]} */
  const lines = [];
  const marker = new THREE.Sprite(new THREE.SpriteMaterial({ map: ringTexture('#ffd166', 9), depthTest: false, depthWrite: false, transparent: true, sizeAttenuation: false }));
  marker.renderOrder = 22;
  marker.frustumCulled = false;
  marker.visible = false;
  group.add(marker);
  let markerPos = null;

  function lineAt(k) {
    while (lines.length <= k) {
      const geom = new THREE.BufferGeometry();
      geom.setAttribute('position', new THREE.BufferAttribute(new Float32Array(CAPACITY * 3), 3));
      const mat = new THREE.LineDashedMaterial({ color: '#ffd166', transparent: true, opacity: 0.95, dashSize: 1, gapSize: 0.6, depthTest: false, depthWrite: false });
      const line = new THREE.Line(geom, mat);
      line.frustumCulled = false;
      line.renderOrder = 21;
      line.visible = false;
      group.add(line);
      lines.push({ line, origin: [0, 0, 0] });
    }
    return lines[k];
  }

  /**
   * @param {{paths?:{points:number[][], color?:string}[], marker?:number[]|null}|null} p
   */
  function set(p) {
    const paths = p?.paths ?? [];
    paths.forEach((path, k) => {
      const L = lineAt(k);
      const pts = path.points;
      const n = Math.min(pts.length, CAPACITY);
      const arr = L.line.geometry.getAttribute('position').array;
      const o = pts[0];
      L.origin = o.slice();
      let total = 0;
      for (let i = 0; i < n; i++) {
        arr[3 * i] = pts[i][0] - o[0]; arr[3 * i + 1] = pts[i][1] - o[1]; arr[3 * i + 2] = pts[i][2] - o[2];
        if (i > 0) total += Math.hypot(pts[i][0] - pts[i - 1][0], pts[i][1] - pts[i - 1][1], pts[i][2] - pts[i - 1][2]);
      }
      L.line.geometry.getAttribute('position').needsUpdate = true;
      L.line.geometry.setDrawRange(0, n);
      L.line.computeLineDistances();
      // ~40 dashes along the path whatever its length
      L.line.material.dashSize = total / 60;
      L.line.material.gapSize = total / 110;
      L.line.material.color.set(path.color ?? '#ffd166');
      L.line.visible = n > 1;
    });
    for (let k = paths.length; k < lines.length; k++) lines[k].line.visible = false;
    markerPos = p?.marker ?? null;
    marker.visible = !!markerPos;
  }

  function update(fc) {
    const F = fc.F;
    for (const L of lines) if (L.line.visible) L.line.position.set(L.origin[0] - F[0], L.origin[1] - F[1], L.origin[2] - F[2]);
    if (markerPos) {
      marker.position.set(markerPos[0] - F[0], markerPos[1] - F[1], markerPos[2] - F[2]);
      marker.scale.setScalar(MARKER_PX / fc.pxPerRad);
    }
  }

  return { set, update };
}
