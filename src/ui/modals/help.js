// Help: controls, shortcuts, accuracy notes (§11), scenario format, credits.
import { DATA_INFO } from '../../data/catalog.js';
import { openModal } from '../modal.js';

export function openHelp() {
  const fetched = (iso) => (iso ? iso.slice(0, 10) : 'unknown');
  openModal({
    title: 'Help',
    wide: true,
    body: `<div class="help">
      <section>
        <h3>Navigating</h3>
        <ul>
          <li><b>Drag</b> to rotate around the focused object, <b>mouse wheel</b> to zoom (zoom is multiplicative: it works from the whole Kuiper belt down to a station in low orbit).</li>
          <li><b>Click</b> any body, object or label (or a row in the object list) to select it and centre the camera on it. The camera then follows it through time.</li>
          <li><b>View</b> menu: top-down, oblique, inner/outer system, Kuiper belt, frame selection. <b>Marker size</b> sets the minimum on-screen radius of bodies (0 = true scale).</li>
          <li>Chips above the view toggle orbits, labels, the ecliptic grid, moons, asteroids (incl. NEOs, Trojans, Centaurs), comets and custom objects. Moons and orbiting objects are hidden automatically when their orbit is smaller than ~10 px.</li>
        </ul>
      </section>
      <section>
        <h3>Time</h3>
        <ul>
          <li>Play/pause, step back/forward by the chosen step, choose a rate (real time to 10 yr/s) and reverse time.</li>
          <li>Type a UTC date in the date field (<code>2187-03-14</code>, <code>2187-03-14 06:42</code>, negative years allowed) and press Enter, or use the picker.</li>
          <li>The events strip shows story events as coloured ticks; click a tick to jump to it, or empty space to scrub.</li>
        </ul>
      </section>
      <section>
        <h3>Keyboard shortcuts</h3>
        <table class="keys"><tbody>
          <tr><td><kbd>Space</kbd></td><td>Play / pause</td></tr>
          <tr><td><kbd>,</kbd> <kbd>.</kbd></td><td>Step back / forward</td></tr>
          <tr><td><kbd>[</kbd> <kbd>]</kbd></td><td>Slower / faster</td></tr>
          <tr><td><kbd>N</kbd></td><td>Jump to now</td></tr>
          <tr><td><kbd>Esc</kbd></td><td>Close dialogs, cancel measuring</td></tr>
          <tr><td><kbd>Enter</kbd> in search</td><td>Focus the first match</td></tr>
        </tbody></table>
      </section>
      <section>
        <h3>Your objects</h3>
        <ul>
          <li><b>＋ Object</b> creates ships, fleets, stations, habitats, bases, probes. Motion models: <b>Orbit</b> (Kepler elements about any body, with presets such as LEO, geostationary, areostationary), <b>Co-located</b> (surface base or “somewhere in orbit”), <b>Lagrange point</b> (L1–L5 of any pair), <b>Fixed point</b>, and <b>Route</b>.</li>
          <li>A route is a list of stops (bodies, other objects or fixed points) with arrival/departure times. Legs fly as <b>brachistochrone</b> (constant thrust with a midpoint flip — leave an arrival blank and give an acceleration to solve it), <b>ballistic</b> (Lambert coast about the Sun), or <b>linear</b>. Relative times like <code>+20</code> (days), <code>+12h</code>, <code>+1y</code> are accepted.</li>
          <li><b>Planner</b> answers “how long at 0.3 g?”, “what acceleration to get there in 10 days?” and “what does a ballistic transfer cost?” (with a duration scan), and can create a ship from the plan.</li>
          <li>The <b>Distances</b> tab lists distance and one-way / round-trip light time from the selection to everything that matters; <b>Measure to…</b> draws a persistent line to the next object you click.</li>
        </ul>
      </section>
      <section>
        <h3>Accuracy</h3>
        <ul>
          <li><b>Planets</b>: JPL/Standish Keplerian approximation, valid 3000 BC–3000 AD; typical error a few arcminutes in heliocentric longitude (Jupiter up to ~5′ far from J2000), i.e. ~10⁵–10⁶ km. Good for story geometry, not for navigation.</li>
          <li><b>Moon</b>: truncated Meeus series, ~0.02° (≈150 km).</li>
          <li><b>Small bodies</b>: SBDB osculating elements at their epoch, propagated as unperturbed Kepler orbits. Accurate for a few decades around the epoch for main-belt asteroids; comets and NEOs drift quickly (planetary perturbations and outgassing ignored).</li>
          <li><b>Moons</b>: Horizons osculating elements at J2000 propagated as fixed Kepler orbits; orbit planes are right, phases drift over decades.</li>
          <li><b>Transfers</b>: brachistochrone = straight line, constant thrust, midpoint flip, solar gravity ignored; ballistic = two-body Lambert about the Sun, planetary gravity ignored (no SOI, no capture burns).</li>
          <li><b>Light time</b>: straight-line distance / c, no relativistic corrections.</li>
          <li>Frame: heliocentric ecliptic J2000. Times are UTC (the ~1 min TT–UTC difference is below the model accuracy).</li>
        </ul>
      </section>
      <section>
        <h3>Saving</h3>
        <p>Everything autosaves in this browser. <b>Export</b> downloads <code>&lt;name&gt;.solarsystem.json</code> (scenario format version 1: <code>{ version, name, savedAt, objects, events, view }</code> — see the README); <b>Import</b> loads one (merge or replace) and can start a new or example scenario.</p>
      </section>
      <section>
        <h3>Data &amp; credits</h3>
        <p>Ephemeris data: NASA/JPL Solar System Dynamics — <a href="https://ssd.jpl.nasa.gov/planets/approx_pos.html" target="_blank" rel="noopener">Standish approximate planetary positions</a>,
        <a href="https://ssd.jpl.nasa.gov/tools/sbdb_lookup.html" target="_blank" rel="noopener">Small-Body Database</a> (${DATA_INFO.smallBodyCount} bodies, fetched ${fetched(DATA_INFO.smallBodiesFetchedAt)}) and
        <a href="https://ssd.jpl.nasa.gov/horizons/" target="_blank" rel="noopener">Horizons</a> (${DATA_INFO.moonCount} moons, fetched ${fetched(DATA_INFO.moonsFetchedAt)}). Lunar series after J. Meeus, <i>Astronomical Algorithms</i>. Rendering: three.js. All data is bundled; the app works offline.</p>
      </section>
    </div>`,
  });
}
