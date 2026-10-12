// Natural bodies: meshes (minimum on-screen size), orbit lines, labels, Sun glow, Saturn's rings. §6.
import * as THREE from 'three';
import { CSS2DObject } from 'three/addons/renderers/CSS2DRenderer.js';
import { AU_KM, DEG } from '../astro/constants.js';
import { equatorialToEcliptic } from '../astro/planets.js';
import { allBodies, getPosition, getOrbitPath, moonsOf, getBody } from '../sim/ephemeris.js';
import { ORBIT_COLORS } from '../data/catalog.js';
import { glowTexture, makeDynamicLine, setLinePoints, mixColor } from './util.js';
import { esc } from '../ui/format.js';

const ORBIT_SEGMENTS = 720;
const SMALL_TYPES = new Set(['asteroid', 'trojan', 'neo', 'centaur', 'comet']);
const BASE_PRIORITY = { star: 600, planet: 500, dwarf: 300, moon: 200, asteroid: 120, trojan: 110, neo: 115, centaur: 110, comet: 125 };
const ORBIT_OPACITY = { planet: 0.6, dwarf: 0.32, moon: 0.45, asteroid: 0.13, trojan: 0.13, neo: 0.18, centaur: 0.2, comet: 0.24 };

/** Is a body category enabled by the toggles? */
export function categoryVisible(type, toggles) {
  if (type === 'moon') return toggles.moons;
  if (type === 'comet') return toggles.comets;
  if (type === 'asteroid' || type === 'trojan' || type === 'neo' || type === 'centaur') return toggles.asteroids;
  return true;
}

/** Semi-major axis (AU) of a body's orbit about its parent, if it has Kepler elements. */
function orbitSemiMajor(b) {
  if (b.ephem.kind === 'kepler') return b.ephem.elements.a;
  if (b.ephem.kind === 'moon-earth') return 384400 / AU_KM;
  return null;
}

/** Largest orbit radius among a body's major moons (radius >= 200 km; all moons when none qualify). */
export function largestMoonOrbitAu(id) {
  const ids = moonsOf(id);
  if (!ids.length) return 0;
  const moons = ids.map(getBody);
  const major = moons.filter((m) => m.radiusKm >= 200);
  const set = major.length ? major : moons;
  return Math.max(...set.map((m) => orbitSemiMajor(m) * (1 + (m.ephem.elements?.e ?? 0.055))));
}

/**
 * Create meshes, labels and orbit lines for every natural body.
 * @param {THREE.Scene} scene
 * @param {{ onLabelCreated?: (el:HTMLElement, id:string) => void }} opts
 */
export function createBodies(scene, opts = {}) {
  const group = new THREE.Group();
  group.name = 'bodies';
  const orbitGroup = new THREE.Group();
  orbitGroup.name = 'orbits';
  const labelGroup = new THREE.Group();
  labelGroup.name = 'body-labels';
  scene.add(orbitGroup, group, labelGroup);

  const sphere = new THREE.SphereGeometry(1, 48, 24);
  const entries = [];
  const byId = new Map();

  for (const b of allBodies()) {
    const isSun = b.type === 'star';
    const material = isSun
      ? new THREE.MeshBasicMaterial({ color: b.color })
      : new THREE.MeshStandardMaterial({ color: b.color, roughness: 0.95, metalness: 0 });
    const mesh = new THREE.Mesh(sphere, material);
    mesh.name = b.id;
    mesh.frustumCulled = false;
    group.add(mesh);

    const el = document.createElement('div');
    el.className = `label label-${b.type}`;
    el.dataset.id = b.id;
    el.innerHTML = `<span class="label-text">${esc(b.name)}</span>`;
    const label = new CSS2DObject(el);
    label.center.set(0, 0.5);
    labelGroup.add(label);
    opts.onLabelCreated?.(el, b.id);

    const e = {
      id: b.id, body: b, mesh, label, labelEl: el, radiusAu: b.radiusKm / AU_KM, marginPx: -1,
      priority: (BASE_PRIORITY[b.type] ?? 100) + Math.min(60, Math.log10(Math.max(1, b.radiusKm)) * 12),
      labelW: 10 + b.name.length * 6.6, small: SMALL_TYPES.has(b.type), orbitA: orbitSemiMajor(b),
      orbitLine: null, orbit: null, glow: null,
    };

    if (isSun) {
      const glow = new THREE.Sprite(new THREE.SpriteMaterial({
        map: glowTexture(), blending: THREE.AdditiveBlending, depthWrite: false, transparent: true, sizeAttenuation: false,
      }));
      glow.renderOrder = 2;
      glow.frustumCulled = false;
      group.add(glow);
      e.glow = glow;
    } else {
      const baseColor = b.type === 'planet' ? mixColor(b.color, '#8090a0', 0.35) : new THREE.Color(ORBIT_COLORS[b.type] ?? '#666666');
      const mat = new THREE.LineBasicMaterial({ color: baseColor, transparent: true, opacity: ORBIT_OPACITY[b.type] ?? 0.4, depthWrite: false });
      e.orbitLine = makeDynamicLine(ORBIT_SEGMENTS + 1, mat);
      e.orbitLine.name = `orbit-${b.id}`;
      e.orbitOpacity = mat.opacity;
      e.orbitColor = baseColor.clone();
      orbitGroup.add(e.orbitLine);
    }

    if (b.rings) {
      // Ring geometry in units of the planet radius so it scales with the body's marker factor.
      const pole = equatorialToEcliptic([
        Math.cos(b.pole.dec * DEG) * Math.cos(b.pole.ra * DEG),
        Math.cos(b.pole.dec * DEG) * Math.sin(b.pole.ra * DEG),
        Math.sin(b.pole.dec * DEG),
      ]);
      const q = new THREE.Quaternion().setFromUnitVectors(new THREE.Vector3(0, 0, 1), new THREE.Vector3(...pole));
      for (const r of b.rings) {
        const ring = new THREE.Mesh(
          new THREE.RingGeometry(r.inner / b.radiusKm, r.outer / b.radiusKm, 96, 1),
          new THREE.MeshBasicMaterial({ color: '#c8b995', side: THREE.DoubleSide, transparent: true, opacity: r.opacity, depthWrite: false }),
        );
        ring.quaternion.copy(q);
        mesh.add(ring);
      }
    }
    entries.push(e);
    byId.set(b.id, e);
  }


  /**
   * Per-frame update.
   * @param {Object} fc frame context (see renderer.js)
   */
  function update(fc) {
    const { jd, F, camPos, pxPerRad, toggles, markerPx, selection, focus } = fc;
    let rebuilds = 0;
    // Heliocentric orbit lines other than the focus/selection fade when zoomed in close to a body, where
    // they would otherwise criss-cross the view in projection.
    const helioFade = Math.min(1, Math.max(0.15, (Math.log10(Math.max(camPos.length(), 1e-9)) + 3) / 2));
    // pass 1: positions (needed by moons for the parent-distance rule)
    for (const e of entries) {
      const W = getPosition(e.id, jd);
      e.rel = [W[0] - F[0], W[1] - F[1], W[2] - F[2]];
      e.camDist = Math.hypot(e.rel[0] - camPos.x, e.rel[1] - camPos.y, e.rel[2] - camPos.z);
    }
    for (const e of entries) {
      const b = e.body;
      const pinned = e.id === focus || e.id === selection;
      let visible = categoryVisible(b.type, toggles) || pinned;
      if (visible && b.type === 'moon' && !pinned && e.orbitA) {
        const p = byId.get(b.parent);
        const aPx = (e.orbitA / Math.max(p.camDist, 1e-12)) * pxPerRad;
        if (aPx < 10) visible = false;
      }
      e.visible = visible;
      e.mesh.visible = visible;
      const [rx, ry, rz] = e.rel;
      const pxTrue = (e.radiusAu / Math.max(e.camDist, 1e-12)) * pxPerRad;
      let k = 1;
      const minPx = e.small ? markerPx * 0.75 : markerPx;
      if (minPx > 0 && pxTrue < minPx) k = minPx / pxTrue;
      e.pxRadius = pxTrue * k;
      if (visible) {
        e.mesh.position.set(rx, ry, rz);
        e.mesh.scale.setScalar(e.radiusAu * k);
      }
      if (e.glow) {
        e.glow.visible = true;
        e.glow.position.set(rx, ry, rz);
        const px = Math.max(36, e.pxRadius * 5);
        e.glow.scale.setScalar(px / pxPerRad);
      }

      // orbit line
      if (e.orbitLine) {
        const show = visible && toggles.orbits;
        e.orbitLine.visible = show;
        if (show) {
          const o = e.orbit;
          let need = !o;
          if (o) {
            const dt = Math.abs(jd - o.jd);
            const moved = (o.a * o.n * dt) / Math.max(0.05, 1 - o.e);
            need = moved > 0.0015 * e.camDist || (b.type === 'planet' && dt > 3650) || (b.ephem.kind === 'moon-earth' && dt > 30);
          }
          if (need && (rebuilds < 60 || pinned)) {
            const path = getOrbitPath(e.id, jd, ORBIT_SEGMENTS);
            if (path) {
              setLinePoints(e.orbitLine, path.points);
              const n = path.el.n || Math.sqrt(path.mu / Math.abs(path.el.a ** 3));
              e.orbit = { jd, center: path.center, a: Math.abs(path.el.a), e: path.el.e, n };
              rebuilds++;
            }
          }
          if (e.orbit) {
            const c = e.orbit.center === 'sun' ? [-F[0], -F[1], -F[2]] : byId.get(e.orbit.center).rel;
            e.orbitLine.position.set(c[0], c[1], c[2]);
          }
          const sel = e.id === selection;
          const mat = e.orbitLine.material;
          const fade = e.orbit && e.orbit.center === 'sun' && !pinned ? helioFade : 1;
          mat.opacity = sel ? 0.95 : e.orbitOpacity * fade;
          if (sel) mat.color.set('#9fd0ff'); else mat.color.copy(e.orbitColor);
        }
      }

      // label + screen item
      e.label.position.set(rx, ry, rz);
      const scr = fc.project(rx, ry, rz);
      const item = {
        id: e.id, kind: 'body', x: scr.x, y: scr.y, behind: scr.behind, r: e.pxRadius, visible,
        priority: e.priority + (e.id === selection ? 1000 : 0) + (e.id === focus ? 800 : 0),
        label: e.label, labelEl: e.labelEl, labelW: e.labelW, wantLabel: visible && toggles.labels && !scr.behind,
        rel: e.rel, camDist: e.camDist,
      };
      const margin = Math.round(Math.min(e.pxRadius, 400) + 5);
      if (margin !== e.marginPx) { e.labelEl.style.marginLeft = `${margin}px`; e.marginPx = margin; }
      fc.items.push(item);
      fc.screen.set(e.id, item);
    }
  }

  return { update, entries, byId };
}
