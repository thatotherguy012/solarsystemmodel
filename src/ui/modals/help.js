// Help: controls, shortcuts, accuracy notes (§11), scenario format, credits.
import { DATA_INFO } from '../../data/catalog.js';
import { openModal } from '../modal.js';
import { storyToolsHelpHtml } from '../storyTools.js';

export function openHelp() {
  const fetched = (iso) => (iso ? iso.slice(0, 10) : 'unknown');
  openModal({
    title: 'Help',
    wide: true,
    body: `<div class="help">
      <section>
        <h3>Navigating</h3>
        <ul>
          <li><b>Drag</b> to rotate, <b>right-drag</b> (or <b>shift + drag</b>) to pan, <b>mouse wheel</b> to zoom (zoom is multiplicative: it works from the whole Kuiper belt down to a station in low orbit).</li>
          <li><b>Click</b> any body, object or label (or a row in the object list) to select it; the camera then <b>follows</b> it through time (“Following: …” above the view; <b>Follow Sun</b> goes back to the Sun). <b>Esc</b> or a click on empty space clears the selection; the camera keeps following.</li>
          <li>Panning moves the view off the followed object but it keeps following it as time runs. <b>Double-click</b> the object or press <kbd>C</kbd> to re-centre; following something else resets the pan.</li>
          <li><b>View</b> menu: top-down, oblique, inner system, asteroid belt (top-down), outer system, Kuiper belt, frame selection, re-centre, plus the <b>ecliptic grid</b> and <b>Kirkwood gaps</b> layers. <b>Marker size</b> sets the minimum on-screen radius of bodies (0 = true scale).</li>
          <li>Chips above the view toggle orbits, labels, moons, asteroids (incl. NEOs, Trojans, Centaurs), comets, your objects and the asteroid-belt cloud. Moons and orbiting objects are hidden automatically when their orbit is smaller than ~10 px.</li>
          <li><b>Simple / Full</b> (top right): Simple shows plain-language summaries — status, distances, signal delay, speed, trip — with the technical tables behind “Details”; Full shows every table.</li>
          <li>The <b>eye</b> on each row of the object list hides that body (its marker, label and orbit) or custom object (with its path); hiding a planet also hides its moons. Group headers have show-all / hide-all eyes. A body is shown only if its category chip is on <i>and</i> it is not hidden individually. Hidden rows are dimmed and still searchable; the hidden set is saved with the scenario.</li>
          <li>Markers keep the bodies' size order at every zoom: the minimum on-screen radius is the marker size × (R / R<sub>Earth</sub>)<sup>0.3</sup> (between 0.45× and 3×), so the Sun is largest, Jupiter about twice Earth, and asteroids stay small dots.</li>
          <li>The chevrons at the edges of the object list and the inspector collapse them to a thin strip (keys <kbd>O</kbd> and <kbd>I</kbd>); the view widens to fill.</li>
        </ul>
      </section>
      <section>
        <h3>Commanding ships</h3>
        <ul>
          <li>Select a ship, fleet or probe: a command bar appears at the bottom of the view (and in the inspector). <b>Go to</b> (<kbd>G</kbd>) flies there and matches its speed (rendezvous); <b>Intercept</b> (<kbd>T</kbd>) reaches it as fast as possible and flies through at the closing speed.</li>
          <li>Then point at a destination — a planet, moon, asteroid, another ship or a station, or empty space (a point on the ecliptic plane): the planned path is drawn and a tooltip gives the arrival date, trip time, peak speed and delta-v (Δv). <b>Click</b> to set the course (an <b>Undo</b> button appears in the confirmation), <b>Esc</b> to cancel.</li>
          <li>The new course starts <i>now</i> (the current simulation time) from where the ship really is and how fast it is moving: the route is cut at this moment and a “course change” point is recorded, so scrubbing back shows the ship on its old path before the order. Torch ships (constant thrust) fly a burn–flip–brake profile solved under the gravity of the Sun and planets; coast ships make one burn now and coast on a ballistic arc (the cheapest of eight transfer times; the burn is shown).</li>
          <li><b>Cut engines</b> stops thrusting: the ship coasts on (a dashed line shows the next three years). <b>Drive</b> sets the acceleration (torch) or coast mode; <b>Set course…</b> gives full control (arrive by a date, transfer duration, intercept or rendezvous).</li>
          <li><b>Shift-click</b> more ships to command them together.</li>
        </ul>
      </section>
      <section>
        <h3>The asteroid belt</h3>
        <ul>
          <li>The <b>Belt</b> cloud shows every known asteroid larger than about 10 km (absolute magnitude H &lt; 13, about 7,700 objects inside 6 AU) moving on its real orbit. Colours: inner belt, middle, outer, the Hilda group (~4 AU) and the two Jupiter Trojan clouds (60° ahead of and behind Jupiter). Hover a dot for its name.</li>
          <li>The gaps are real: the <b>Kirkwood gaps</b> (View menu) at 2.06, 2.50, 2.82, 2.95 and 3.27 AU are orbits that Jupiter's resonances have emptied.</li>
          <li>For navigation or combat the belt is empty space: all of it together has about 4% of the Moon's mass, and kilometre-size rocks are typically millions of km apart. Its density matters for where settlements and mining would plausibly be, not for dodging rocks.</li>
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
          <tr><td><kbd>G</kbd> / <kbd>T</kbd></td><td>Selected ship: Go to / Intercept (then click a destination)</td></tr>
          <tr><td><kbd>C</kbd></td><td>Re-centre the view on the followed object</td></tr>
          <tr><td><kbd>Esc</kbd></td><td>Close dialogs and menus, cancel targeting or measuring, then clear the selection</td></tr>
          <tr><td><kbd>Enter</kbd> in search</td><td>Focus the first match</td></tr>
        </tbody></table>
      </section>
      <section>
        <h3>Your objects</h3>
        <ul>
          <li><b>＋ Add</b> creates ships, fleets, stations, habitats, bases, probes. Motion models: <b>Orbit</b> (Kepler elements about any body, with presets such as LEO, geostationary, areostationary), <b>Co-located</b> (surface base or “somewhere in orbit”), <b>Lagrange point</b> (L1–L5 of any pair), <b>Fixed point</b>, and <b>Route</b>.</li>
          <li>Every ship, fleet and probe has a <b>drive</b>: torch (constant thrust, e.g. 0.3 g) or coast (impulsive burns, ballistic arcs).</li>
          <li>A route is a list of stops (bodies, other objects or fixed points) with arrival/departure times. Each leg can fly as <b>torch</b> (rendezvous or intercept from the ship's actual state, arrival solved), <b>brachistochrone</b> (constant thrust with a midpoint flip — leave an arrival blank and give an acceleration to solve it), <b>ballistic</b> (a coast through the Sun + planets gravity field), or <b>linear</b>. Relative times like <code>+20</code> (days), <code>+12h</code>, <code>+1y</code> are accepted.</li>
          <li>Ballistic legs report the departure and arrival excess speeds (v∞), the burns from and into circular parking orbits (per-stop altitude; defaults 300 km for rocky planets and large moons, 10% of the radius for gas giants, half the radius (≥ 5 km) for small bodies; a station's own orbit when departing from one), the leg's total Δv, the three closest planetary approaches (flagged inside 2 sphere-of-influence radii) and any impact. Tick <b>flyby (no stop)</b> on an intermediate planet (or moon: its planet's gravity is used) for a gravity-assist analysis: v∞ in/out, turn angle, required periapsis altitude and a verdict. Flybys are marked by a small ring on the path.</li>
          <li>Brachistochrone legs get a <b>gravity audit</b>: the engine acceleration actually needed to hold the straight line against the Sun's and planets' gravity, the Δv including gravity, the gravity loss, and OK / marginal / cannot-hold status.</li>
          <li><b>Tools ▾ → Travel planner</b> answers “how long at 0.3 g?”, “what acceleration to get there in 10 days?” and “what does a ballistic transfer cost?” (v∞, parking-orbit burns with editable altitudes, closest approaches, and a duration scan), and can create a ship from the plan.</li>
          <li><b>Tools ▾ → Launch windows…</b> (also a tab of the planner): a porkchop plot of coasting transfers between two bodies — total Δv by departure date and flight time, the cheapest trip of each window listed (click a cell or <b>Use</b> to plan it with the N-body model) — and, for comparison, the trip time of a torch ship for every departure date.</li>
          <li>The <b>Distances</b> tab lists distance and one-way / round-trip light time from the selection to everything that matters; <b>Measure to…</b> draws a persistent line to the next object you click.</li>
        </ul>
      </section>
      ${storyToolsHelpHtml()}
      <section>
        <h3>Accuracy</h3>
        <ul>
          <li><b>Planets</b>: JPL/Standish Keplerian approximation, valid 3000 BC–3000 AD; typical error a few arcminutes in heliocentric longitude (Jupiter up to ~5′ far from J2000), i.e. ~10⁵–10⁶ km. Good for story geometry, not for navigation.</li>
          <li><b>Moon</b>: truncated Meeus series, ~0.02° (≈150 km).</li>
          <li><b>Small bodies</b>: SBDB osculating elements at their epoch, propagated as unperturbed Kepler orbits. Accurate for a few decades around the epoch for main-belt asteroids; comets and NEOs drift quickly (planetary perturbations and outgassing ignored).</li>
          <li><b>Moons</b>: Horizons osculating elements at J2000 propagated as fixed Kepler orbits; orbit planes are right, phases drift over decades.</li>
          <li><b>Ballistic legs</b>: integrated in the gravity of the Sun and the 8 planets (Earth + Moon as one body at their barycentre), targeted to reach the destination at the arrival time, with patched-conic endpoints: the departure and arrival planets' gravity is switched off inside their sphere of influence (ramping back to full strength at 2 SOI radii), and the departure / capture burns are computed from the hyperbolic excess speed for a circular parking orbit. The two-body Lambert arc is shown while the N-body solution computes (typically well under a second) and if targeting fails (a yellow note says so). Moons and small bodies do not perturb trajectories.</li>
          <li><b>Flybys</b> are patched conics: the heliocentric path is continuous in position but kinks in velocity at the flyby; the hyperbola inside the planet's sphere of influence is not modelled in detail.</li>
          <li><b>Torch legs</b> (command mode, “Torch” leg profile): constant thrust in two phases (burn, flip, burn) from the ship's real position and velocity to the moving target, solved without gravity and then refined by shooting through the gravity of the Sun and the 8 planets (the departure and arrival planets' pull is switched off near them, as for ballistic legs). Below ~0.003 g the refinement may not converge; the gravity-free solution is then shown and flagged.</li>
          <li><b>Drift</b> (engines off): integrated in the Sun + 8 planets field for four years, then two-body.</li>
          <li><b>Belt cloud</b>: SBDB osculating elements propagated as fixed Kepler orbits, like the named asteroids.</li>
          <li><b>Brachistochrone legs</b> are straight lines at constant thrust with a midpoint flip; gravity is accounted for after the fact by the gravity audit (it does not bend the path). Constant-thrust legs below ~0.01 g are outside the model's validity: there the Sun's pull (0.0006 g at 1 AU) is comparable to the thrust and a straight line is not a meaningful trajectory.</li>
          <li><b>Light time</b>: straight-line distance / c, no relativistic corrections.</li>
          <li>Frame: heliocentric ecliptic J2000. Times are UTC (the ~1 min TT–UTC difference is below the model accuracy).</li>
        </ul>
      </section>
      <section>
        <h3>Saving</h3>
        <p>Everything autosaves in this browser. <b>Scenario ▾ → Export</b> downloads <code>&lt;name&gt;.solarsystem.json</code> (scenario format version 1: <code>{ version, name, savedAt, objects, events, view }</code> — see the README); <b>Scenario ▾ → Import</b> loads one (merge or replace); the same menu starts a new or the example scenario.</p>
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
