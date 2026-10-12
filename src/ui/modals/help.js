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
          <li>The <b>eye</b> on each row of the object list hides that body (its marker, label and orbit) or custom object (with its path); hiding a planet also hides its moons. Group headers have show-all / hide-all eyes. A body is shown only if its category chip is on <i>and</i> it is not hidden individually. Hidden rows are dimmed and still searchable; the hidden set is saved with the scenario.</li>
          <li>Markers keep the bodies' size order at every zoom: the minimum on-screen radius is the marker size × (R / R<sub>Earth</sub>)<sup>0.3</sup> (between 0.45× and 3×), so the Sun is largest, Jupiter about twice Earth, and asteroids stay small dots.</li>
          <li>The chevrons at the edges of the object list and the inspector collapse them to a thin strip (keys <kbd>O</kbd> and <kbd>I</kbd>); the view widens to fill.</li>
        </ul>
      </section>
      <section>
        <h3>Time and the timeline</h3>
        <ul>
          <li>Play/pause, step back/forward by the chosen step, choose a rate (real time to 10 yr/s) and reverse time.</li>
          <li>Type a UTC date in the date field (<code>2187-03-14</code>, <code>2187-03-14 06:42</code>, negative years allowed) and press Enter, or use the picker.</li>
          <li>Timeline strip (bottom right): <b>drag the blue cursor</b> to scrub time (everything follows live; playback pauses), <b>click</b> the axis to jump there, <b>drag the background</b> to pan, and use the <b>mouse wheel</b> to zoom about the pointer (1 day to 500 years). Span presets (1 d … 100 yr) and <b>Fit events</b> sit above the strip; tick labels switch between hours, days, months and years. Story events are coloured ticks: hover for the title, click to jump. While playing, the window follows the cursor unless you are panning or zooming.</li>
        </ul>
      </section>
      <section>
        <h3>Keyboard shortcuts</h3>
        <table class="keys"><tbody>
          <tr><td><kbd>Space</kbd></td><td>Play / pause</td></tr>
          <tr><td><kbd>,</kbd> <kbd>.</kbd></td><td>Step back / forward</td></tr>
          <tr><td><kbd>[</kbd> <kbd>]</kbd></td><td>Slower / faster</td></tr>
          <tr><td><kbd>N</kbd></td><td>Jump to now</td></tr>
          <tr><td><kbd>O</kbd> / <kbd>I</kbd></td><td>Collapse / expand the object list / the inspector</td></tr>
          <tr><td><kbd>Esc</kbd></td><td>Close dialogs, cancel measuring</td></tr>
          <tr><td><kbd>Enter</kbd> in search</td><td>Focus the first match</td></tr>
        </tbody></table>
      </section>
      <section>
        <h3>Your objects</h3>
        <ul>
          <li><b>＋ Object</b> creates ships, fleets, stations, habitats, bases, probes. Motion models: <b>Orbit</b> (Kepler elements about any body, with presets such as LEO, geostationary, areostationary), <b>Co-located</b> (surface base or “somewhere in orbit”), <b>Lagrange point</b> (L1–L5 of any pair), <b>Fixed point</b>, and <b>Route</b>.</li>
          <li>A route is a list of stops (bodies, other objects or fixed points) with arrival/departure times. Legs fly as <b>brachistochrone</b> (constant thrust with a midpoint flip — leave an arrival blank and give an acceleration to solve it), <b>ballistic</b> (a coast through the Sun + planets gravity field), or <b>linear</b>. Relative times like <code>+20</code> (days), <code>+12h</code>, <code>+1y</code> are accepted.</li>
          <li>Ballistic legs report the departure and arrival excess speeds (v∞), the burns from and into circular parking orbits (per-stop altitude; defaults 300 km for rocky planets and large moons, 10% of the radius for gas giants, half the radius (≥ 5 km) for small bodies; a station's own orbit when departing from one), the leg's total Δv, the three closest planetary approaches (flagged inside 2 sphere-of-influence radii) and any impact. Tick <b>flyby (no stop)</b> on an intermediate planet (or moon: its planet's gravity is used) for a gravity-assist analysis: v∞ in/out, turn angle, required periapsis altitude and a verdict. Flybys are marked by a small ring on the path.</li>
          <li>Brachistochrone legs get a <b>gravity audit</b>: the engine acceleration actually needed to hold the straight line against the Sun's and planets' gravity, the Δv including gravity, the gravity loss, and OK / marginal / cannot-hold status.</li>
          <li><b>Planner</b> answers “how long at 0.3 g?”, “what acceleration to get there in 10 days?” and “what does a ballistic transfer cost?” (v∞, parking-orbit burns with editable altitudes, closest approaches, and a duration scan), and can create a ship from the plan.</li>
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
          <li><b>Ballistic legs</b>: integrated in the gravity of the Sun and the 8 planets (Earth + Moon as one body at their barycentre), targeted to reach the destination at the arrival time, with patched-conic endpoints: the departure and arrival planets' gravity is switched off inside their sphere of influence (ramping back to full strength at 2 SOI radii), and the departure / capture burns are computed from the hyperbolic excess speed for a circular parking orbit. The two-body Lambert arc is shown while the N-body solution computes (typically well under a second) and if targeting fails (a yellow note says so). Moons and small bodies do not perturb trajectories.</li>
          <li><b>Flybys</b> are patched conics: the heliocentric path is continuous in position but kinks in velocity at the flyby; the hyperbola inside the planet's sphere of influence is not modelled in detail.</li>
          <li><b>Brachistochrone legs</b> are straight lines at constant thrust with a midpoint flip; gravity is accounted for after the fact by the gravity audit (it does not bend the path). Constant-thrust legs below ~0.01 g are outside the model's validity: there the Sun's pull (0.0006 g at 1 AU) is comparable to the thrust and a straight line is not a meaningful trajectory.</li>
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
