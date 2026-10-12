# Solar System Model — Build Specification

An interactive 3D solar system for writing hard science fiction. The writer needs to know, for any
date, where the planets, moons, dwarf planets, major asteroids and comets are; to place their own
ships, fleets, stations and bases; to move ships between bodies with physically plausible transfers;
to read off distances and light-lag between any two things; and to attach story events to dates.

This document is the complete specification for the implementation. The astrodynamics core in
`src/astro/` is already written and validated against JPL Horizons (`npm run validate`). Do not
rewrite it; build on it. Everything else described here must be created.

---

## 1. Stack and constraints

- **Vite + three.js + vanilla JavaScript (ES modules).** No TypeScript, no UI framework, no CSS
  framework. The only runtime dependency is `three` (latest; use `three/addons/...` imports for
  `OrbitControls` and `CSS2DRenderer`). Dev dependency: `vite`.
- `package.json` already exists with `"type": "module"` and scripts `dev`, `build`, `preview`,
  `validate`, `fetch-data`. Add dependencies with `npm install three` and `npm install -D vite`.
- `vite.config.js` must set `base: './'` so the built site works from any path (GitHub Pages
  serves it under `/solarsystemmodel/`).
- **No downloaded textures, images or binaries.** All visuals are procedural (colors, simple
  materials, canvas-generated sprites). The repo must stay small.
- **No runtime network access.** All ephemeris data is baked into JSON under `src/data/` by the
  fetch script and committed. The app must work offline after `npm run build`.
- Target: desktop Chrome/Edge/Firefox, window ≥ 1100 px wide. Dark theme.
- Windows host. Paths contain spaces and brackets: always quote them. Prefer the Write/Edit tools
  over shell heredocs for file content.
- Internal units everywhere: **AU, days, radians, Julian Date (JD)**. Display units: AU, km,
  million km, km/s, light-seconds/minutes/hours, g (9.80665 m/s²), calendar dates in UTC.
- Reference frame everywhere: **heliocentric ecliptic J2000**. In three.js the scene axes equal the
  ecliptic axes directly (x, y in the ecliptic plane, +z = ecliptic north). Set `camera.up = (0,0,1)`.

## 2. Existing modules (`src/astro/`) — API summary

- `constants.js`: `AU_KM`, `C_KM_S`, `LIGHT_S_PER_AU`, `DAY_S`, `J2000_JD`, `GM_SUN` (AU³/day²),
  `GM_SUN_KM3_S2`, `DEG`, `RAD`, `G0_M_S2`, `gmToAuDay(gmKm3S2)`, `kmToAu`, `auToKm`,
  `auDayToKmS`, `kmSToAuDay`, `mS2ToAuDay2`, `auDay2ToMS2`, `wrapDeg`, `wrapRad`, `wrapPiRad`.
- `vec3.js`: plain-array vector helpers `vadd vsub vscale vdot vcross vlen vdist vnorm vlerp rotX rotZ`.
- `time.js`: `dateToJd`, `jdToDate`, `nowJd`, `jdToT` (Julian centuries since J2000),
  `civilToJd(y,m,d,hh,mm,ss)`, `jdToCivil(jd)` → `{year,month,day,hour,minute,second}`,
  `formatJd(jd,{seconds,time})` → `"2187-03-14 06:42 UTC"`, `jdToInputValue`, `parseDateToJd(str)`
  (accepts `YYYY-MM-DD`, `YYYY-MM-DD HH:MM[:SS]`, negative years), `formatDuration(days)`.
- `kepler.js`: elements object `{a, e, i, om, w, M, epoch, n?}` (a in AU, angles rad, M at `epoch`,
  `n` mean motion rad/day optional — computed from a and mu when absent). Functions:
  `elementsToState(el, mu, jd)` → `{r, v}`; `elementsToPosition`; `orbitPath(el, mu, segments, rMax)`
  → array of `[x,y,z]` in the parent frame (closed ellipse, or hyperbolic arc to `rMax`);
  `stateToElements(r, v, mu, jd)` → full element set incl. `period`, `rp`, `ra`, `nu`;
  `periodDays(a, mu)`, `meanMotion`, `solveKeplerElliptic`, `solveKeplerHyperbolic`,
  `perifocalToReference`.
- `lambert.js`: `lambert(r1, r2, dt, mu, prograde=true)` → `{ok, v1, v2, a, iterations}`;
  `propagateUniversal(r0, v0, dt, mu)` → `{r, v}` (all conics);
  `brachistochroneFraction(tau)`, `brachistochroneAccel(D, T)`, `brachistochroneTime(D, a)`,
  `brachistochronePeakV(D, T)` (AU, days, AU/day²).
- `lagrange.js`: `lagrangePoint(rP, gmP, rS, gmS, 'L1'..'L5', normal=[0,0,1])` → position.
  `normal` should be the unit orbit normal of the secondary about the primary: `vnorm(vcross(rS-rP, vS-vP))`.
- `planets.js`: `planetState(key, jd)` / `planetPosition(key, jd)` for keys
  `mercury venus emb mars jupiter saturn uranus neptune` (heliocentric `{r, v}`);
  `earthState(jd)` (Earth itself, barycenter-corrected — use this for Earth, never `emb` directly);
  `planetElementsAt(key, jd)` (elements for drawing the orbit; `M` already evaluated at `jd`, `n: 0`);
  `moonGeocentric(jd)` → `{r (AU, geocentric ecliptic J2000), lonDeg, latDeg, distKm}`;
  `moonMeanElements(jd)` (for drawing the Moon's orbit ellipse about Earth);
  `equatorialToEcliptic(v)`, `eclipticToEquatorial(v)`.
- `scripts/validate-astro.mjs`: numeric validation; must keep passing (`npm run validate`).

If you find a genuine bug in `src/astro/`, fix it minimally, keep `npm run validate` green, and
mention the change in your final report.

## 3. Data acquisition — `scripts/fetch-data.mjs`

A Node script (uses global `fetch`, Node 22) that writes two JSON files which are committed to the repo.
Rate-limit politely (sequential requests, ~250 ms apart). On any individual failure, log it, use the
fallback values in §3.4 if available, and continue. The app must never depend on this script at runtime.

### 3.1 Small bodies → `src/data/smallbodies.json`

Source: JPL SBDB API, `https://ssd-api.jpl.nasa.gov/sbdb.api?sstr=<KEY>&phys-par=1&full-prec=1`.
Response: `orbit.epoch` (JD string), `orbit.elements[]` of `{name, value}` with names
`e a q i om w ma tp per n ad` (a, q, ad in AU; i, om, w, ma in degrees; per in days);
`phys_par[]` of `{name, value, units}` with possible names `H`, `diameter` (km), `GM` (km³/s²),
`rot_per` (h), `albedo`, `extent`. `object.fullname`, `object.shortname`, `object.orbit_class.name`.

Fetch these (key → id, display name, category):

| category | keys (sstr) |
|---|---|
| dwarf | `Pluto`, `1` (Ceres), `136199` (Eris), `136108` (Haumea), `136472` (Makemake), `225088` (Gonggong), `50000` (Quaoar), `90377` (Sedna), `90482` (Orcus) |
| asteroid (main belt) | `2` Pallas, `3` Juno, `4` Vesta, `5` Astraea, `6` Hebe, `7` Iris, `8` Flora, `9` Metis, `10` Hygiea, `15` Eunomia, `16` Psyche, `19` Fortuna, `21` Lutetia, `24` Themis, `29` Amphitrite, `31` Euphrosyne, `52` Europa, `65` Cybele, `87` Sylvia, `88` Thisbe, `107` Camilla, `121` Hermione, `216` Kleopatra, `243` Ida, `253` Mathilde, `324` Bamberga, `511` Davida, `532` Herculina, `704` Interamnia, `951` Gaspra |
| trojan | `588` Achilles, `624` Hektor, `617` Patroclus, `884` Priamus |
| neo | `433` Eros, `1036` Ganymed, `1566` Icarus, `1862` Apollo, `1221` Amor, `3200` Phaethon, `3753` Cruithne, `4179` Toutatis, `25143` Itokawa, `65803` Didymos, `99942` Apophis, `101955` Bennu, `162173` Ryugu, `2062` Aten |
| centaur | `2060` Chiron, `10199` Chariklo, `944` Hidalgo, `5145` Pholus |
| comet | `1P` Halley, `2P` Encke, `9P` Tempel 1, `67P` Churyumov-Gerasimenko, `81P` Wild 2, `103P` Hartley 2, `109P` Swift-Tuttle, `C/1995 O1` Hale-Bopp, `46P` Wirtanen, `55P` Tempel-Tuttle, `21P` Giacobini-Zinner, `19P` Borrelly |

Output record schema (one per body):
```json
{ "id": "ceres", "name": "Ceres", "designation": "1 Ceres (A801 AA)", "category": "dwarf",
  "orbitClass": "Main-belt Asteroid", "epochJd": 2461200.5,
  "elements": { "a": 2.7655, "e": 0.0797, "iDeg": 10.588, "omDeg": 80.249, "wDeg": 73.294, "maDeg": 274.42, "periodDays": 1679.85 },
  "radiusKm": 469.7, "gmKm3S2": 62.6284, "rotationHours": 9.07, "albedo": 0.09, "H": 3.34 }
```
`id` = lowercase name, non-alphanumerics → `-` (e.g. `hale-bopp`, `tempel-1`). `radiusKm` =
diameter/2 when SBDB has a diameter; otherwise from absolute magnitude H:
`D_km = 1329 / sqrt(albedo) * 10^(-H/5)` with albedo default 0.10 (0.04 for comets). `gmKm3S2`
null when unknown (the app then estimates mass from radius assuming 2000 kg/m³, only needed for
orbit-around-asteroid custom objects: `GM = G * (4/3)π r³ ρ`).

### 3.2 Moons → `src/data/moons.json`

Source: JPL Horizons API, osculating elements at J2000 relative to the parent, ecliptic frame:
```
https://ssd.jpl.nasa.gov/api/horizons.api?format=text&COMMAND='<ID>'&OBJ_DATA='YES'&MAKE_EPHEM='YES'
  &EPHEM_TYPE='ELEMENTS'&CENTER='500@<PARENT>'&START_TIME='2000-01-01 12:00'&STOP_TIME='2000-01-02'
  &STEP_SIZE='2d'&REF_PLANE='ECLIPTIC'&OUT_UNITS='KM-S'
```
(URL-encode the quoted values.) The block between `$$SOE` and `$$EOE` contains
`EC= QR= IN= OM= W = Tp= N = MA= TA= A = AD= PR=` (km, degrees, N in deg/s, PR in s). Parse with a
regex like `/(EC|QR|IN|OM|W|Tp|N|MA|TA|A|AD|PR)\s*=\s*([-+0-9.E]+)/g`. The object-data header may
contain `Mean radius (km) = 1821.49` or `Radius (km) = ...` and `GM (km^3/s^2) = 5959.9`; parse
when present, otherwise use the fallback table in §3.4.

Moons to fetch (Horizons ID, parent center code, parent app id):

- Mars (`499`, parent `mars`): 401 Phobos, 402 Deimos
- Jupiter (`599`, `jupiter`): 501 Io, 502 Europa, 503 Ganymede, 504 Callisto, 505 Amalthea, 506 Himalia
- Saturn (`699`, `saturn`): 601 Mimas, 602 Enceladus, 603 Tethys, 604 Dione, 605 Rhea, 606 Titan, 607 Hyperion, 608 Iapetus, 609 Phoebe
- Uranus (`799`, `uranus`): 705 Miranda, 701 Ariel, 702 Umbriel, 703 Titania, 704 Oberon
- Neptune (`899`, `neptune`): 801 Triton, 802 Nereid, 808 Proteus
- Pluto (`999`, `pluto`): 901 Charon, 902 Nix, 903 Hydra

Earth's Moon is **not** fetched; it uses `moonGeocentric()`.

Output record schema:
```json
{ "id": "io", "name": "Io", "parent": "jupiter", "horizonsId": 501, "epochJd": 2451545.0,
  "elements": { "aKm": 422036.4, "e": 0.004716, "iDeg": 2.2126, "omDeg": 336.85, "wDeg": 66.165, "maDeg": 335.15, "nDegPerDay": 203.23 },
  "radiusKm": 1821.5, "gmKm3S2": 5959.9 }
```
`nDegPerDay = N(deg/s) * 86400`. Use `nDegPerDay` as the mean motion (convert to rad/day for the
`n` field of the elements object) rather than recomputing from GM, so periods match Horizons.

### 3.3 Planets and Sun (hard-coded in `src/data/catalog.js`)

| id | name | radius km | GM km³/s² | color | notes |
|---|---|---|---|---|---|
| sun | Sun | 695700 | 1.32712440018e11 | #fff1c9 | emissive + glow |
| mercury | Mercury | 2439.7 | 22031.78 | #9c9088 | |
| venus | Venus | 6051.8 | 324858.6 | #e6c89c | |
| earth | Earth | 6371.0 | 398600.4418 | #4f8fd9 | |
| moon | Moon | 1737.4 | 4902.8 | #b8b8b8 | parent earth, special ephemeris |
| mars | Mars | 3389.5 | 42828.37 | #d1693f | |
| jupiter | Jupiter | 69911 | 126686534 | #d8b48a | |
| saturn | Saturn | 58232 | 37931187 | #e3d1a0 | rings: inner 74500 km, outer 136780 km; pole RA 40.589°, Dec 83.537° |
| uranus | Uranus | 25362 | 5793939 | #9fd7e3 | |
| neptune | Neptune | 24622 | 6836529 | #4b70dd | |

Saturn's ring orientation: pole unit vector in equatorial coordinates
`(cos δ cos α, cos δ sin α, sin δ)` → `equatorialToEcliptic()` → use as the ring mesh's normal.

### 3.4 Fallback physical data for moons (km; GM km³/s² where known)

Phobos 11.1 (0.0007) · Deimos 6.2 (0.0001) · Io 1821.6 (5959.9) · Europa 1560.8 (3202.7) ·
Ganymede 2634.1 (9887.8) · Callisto 2410.3 (7179.3) · Amalthea 83.5 · Himalia 85 ·
Mimas 198.2 (2.5) · Enceladus 252.1 (7.2) · Tethys 531.1 (41.2) · Dione 561.4 (73.1) ·
Rhea 763.8 (153.9) · Titan 2574.7 (8978.1) · Hyperion 135 · Iapetus 734.5 (120.5) · Phoebe 106.5 ·
Miranda 235.8 (4.4) · Ariel 578.9 (86.4) · Umbriel 584.7 (81.5) · Titania 788.4 (228.2) ·
Oberon 761.4 (192.4) · Triton 1353.4 (1427.6) · Nereid 170 · Proteus 210 ·
Charon 606 (105.9) · Nix 25 · Hydra 27.
Pluto itself: radius 1188.3, GM 869.6 (SBDB may lack these; apply as fallback).

Moon display colors: pick muted greys/tans per moon; Io yellowish (#d9c27a), Europa pale (#d8d2c4),
Titan orange (#d9a066), Triton pinkish grey (#c8b8b0), Enceladus white (#eeeeee).

## 4. Unified body catalog and ephemeris engine (`src/sim/`)

`catalog.js` builds one array of **body descriptors** from §3 data:
```js
{ id, name, type: 'star'|'planet'|'moon'|'dwarf'|'asteroid'|'trojan'|'neo'|'centaur'|'comet',
  parent: id|null, radiusKm, gmKm3S2 (number|null), color, designation?, orbitClass?,
  ephem: { kind: 'sun' } | { kind: 'planet', key } | { kind: 'earth' } | { kind: 'moon-earth' }
       | { kind: 'kepler', elements /* AU, rad, n rad/day, epoch */, muKey: 'sun'|parentId } }
```
Elements for small bodies: `a` in AU, angles converted to radians, `n = 2π/periodDays`.
Elements for moons: `a = aKm / AU_KM`, `n = nDegPerDay * DEG`, mu = parent GM converted with
`gmToAuDay`.

`ephemeris.js` exposes:
- `getState(id, jd)` → `{ r, v }` heliocentric ecliptic J2000 (AU, AU/day). Moons: parent state +
  relative state. Earth: `earthState`. Moon: `earthState(jd).r + moonGeocentric(jd).r` (velocity:
  finite difference ±0.01 d, or Earth's velocity + finite-difference of moonGeocentric).
  **Memoize per `(id, jd)`** with a per-frame cache (clear when jd changes) because the render loop,
  the info panel, and custom-object evaluation all call it for the same jd.
- `getPosition(id, jd)` → `r`.
- `getOrbitPath(id, jd)` → `{ center: parentId|'sun', points: [[x,y,z], ...] }` in the parent's frame
  (planets: `planetElementsAt`, orbit recomputed when |jd − cachedJd| > 3650 days; moon: `moonMeanElements`,
  recompute every 30 days of sim time; kepler bodies: fixed, computed once; use `rMax = 1.5 × a(1+e)` cap
  of 2000 AU for hyperbolic/near-parabolic).
- `getMu(id)` → GM in AU³/day² (for custom orbits; estimate from radius when null, see §3.1).
- `getOrbitNormal(secondaryId, jd)` → unit normal of the secondary's orbit about its parent.

## 5. Custom objects (ships, fleets, stations, bases, probes) — `src/sim/custom.js`

Data model (stored in the scenario, see §9):
```js
{ id: 'uuid', name: 'ISV Kestrel', type: 'ship'|'fleet'|'station'|'habitat'|'base'|'probe'|'other',
  color: '#ff8800', notes: 'free text (markdown-free)', tags: ['Navy', 'Act 2'],
  existsFromJd: null|number, existsUntilJd: null|number,   // hidden outside this window
  showPath: true,
  motion: <one of the kinds below> }
```
Motion kinds and the exact position rule `pos(jd)`:

1. **`orbit`** `{ kind:'orbit', parent:id, aKm, e, iDeg, omDeg, wDeg, m0Deg, epochJd }`
   Relative Keplerian orbit about `parent` (any natural body or another custom object), ecliptic
   frame. `pos = getPosition(parent, jd) + elementsToState({a: aKm/AU_KM, e, i, om, w, M: m0, epoch}, getMu(parent), jd).r`.
   The UI offers presets: altitude input (a = radius + altitude) and named presets (LEO 400 km,
   GEO/geostationary, lunar 100 km, areostationary 17032 km alt, etc.).
2. **`colocated`** `{ kind:'colocated', parent:id, label?:string }` — surface base, colony, or
   "in orbit (unspecified)". `pos = getPosition(parent, jd)`. Rendered slightly offset above the
   body surface in screen space so the label does not collide with the body's label.
3. **`lagrange`** `{ kind:'lagrange', primary:id, secondary:id, point:'L1'|'L2'|'L3'|'L4'|'L5' }`
   `pos = lagrangePoint(rP, gmP, rS, gmS, point, getOrbitNormal(secondary, jd))` using heliocentric
   positions of both bodies at `jd`. Typical pairs: sun–earth, earth–moon, sun–mars, sun–jupiter.
4. **`fixed`** `{ kind:'fixed', x, y, z }` heliocentric ecliptic AU (UI also accepts km).
5. **`route`** `{ kind:'route', profile:'brachistochrone'|'ballistic'|'linear', accelG?: number,
   stops: [ { ref: id|null, x?, y?, z?, arriveJd: number|null, departJd: number|null }, ... ] }`
   A stop is a body/custom object (`ref`) or a fixed heliocentric point (`ref: null` with x,y,z in AU).
   Let `S_i(t)` be the stop's position at time t. Rules:
   - Before `stops[0].departJd` (or if only one stop): `pos = S_0(jd)`.
   - If `stops[i].arriveJd ≤ jd ≤ stops[i].departJd`: parked, `pos = S_i(jd)`.
   - After the last stop's `arriveJd`: `pos = S_last(jd)`.
   - Leg from stop i (t0 = `departJd`) to stop i+1 (t1 = `arriveJd`), with `P0 = S_i(t0)`,
     `P1 = S_{i+1}(t1)`, `T = t1 − t0`, `τ = (jd − t0)/T`:
     - `linear`: `pos = P0 + (P1 − P0)·τ`.
     - `brachistochrone`: `pos = P0 + (P1 − P0)·brachistochroneFraction(τ)` (constant thrust, flip at
       midpoint, straight line in inertial space — solar gravity neglected, valid for ≳0.01 g).
       Derived: `D = |P1−P0|`, `accel = 4D/T²`, `vPeak = 2D/T`, `Δv = 4D/T`.
     - `ballistic`: `sol = lambert(P0, P1, T, GM_SUN, true)`; `pos = propagateUniversal(P0, sol.v1, jd − t0, GM_SUN).r`.
       Derived: departure excess speed `|sol.v1 − vel(S_i, t0)|`, arrival `|sol.v2 − vel(S_{i+1}, t1)|`,
       transfer `a`, `e` via `stateToElements`. If `!sol.ok`, fall back to `linear` for that leg and
       flag it in the UI ("no ballistic solution").
     Cache per-leg derived data (Lambert solution, sampled path) keyed by the leg's JSON; recompute
     only when the object is edited.
   - Validation: times strictly increasing along the route; `arriveJd` of stop i+1 > `departJd` of stop i.
     The editor must show inline errors and refuse to save an inconsistent route.
   - **Solve arrival from acceleration** (brachistochrone only): when the user enters `accelG` and leaves
     a leg's arrival blank, compute `a = mS2ToAuDay2(accelG·G0)`, then iterate
     `T ← brachistochroneTime(|S_{i+1}(t0+T) − S_i(t0)|, a)` starting from `T = brachistochroneTime(|S_{i+1}(t0) − S_i(t0)|, a)`
     for 12 iterations, and fill `arriveJd = t0 + T`. Do this at save time (the stored route always
     has explicit times).
   - Velocity of a custom object (for the info panel): central finite difference ±0.005 day.
   - References to other custom objects are allowed (a fleet escorting a flagship, a shuttle based on a
     station). Guard against cycles with a recursion depth limit of 4; on cycle, treat as fixed at origin
     and show an error badge.

`src/sim/custom.js` exports `customState(obj, jd, ctx)` → `{ r, v, legInfo }` and
`customPath(obj, ctx)` → array of polylines (one per transfer leg, 128–256 samples each; parked
segments are not drawn) for rendering.

## 6. Rendering (`src/scene/`)

- `WebGLRenderer({ antialias: true, logarithmicDepthBuffer: true })`, `PerspectiveCamera(50, aspect, 1e-7, 1e7)`,
  `camera.up.set(0,0,1)`. Scene unit = 1 AU. `OrbitControls` with `enablePan = false`,
  `enableDamping = true`, `zoomSpeed` tuned, `minDistance = 2e-7`, `maxDistance = 5000`. Mouse wheel zoom
  must feel logarithmic (OrbitControls dolly is multiplicative, which is fine).
- **Focus-relative origin.** The controls' target is always `(0,0,0)`. Every frame compute
  `F = getPosition(focusId, jd)`; set each object's `mesh.position = worldPos − F` (computed in doubles,
  then assigned). Orbit-line groups are placed at `centerPos − F`. This keeps float precision where the
  camera looks and makes the camera follow the focused object through time automatically.
  When focus changes, keep the camera's current orientation and set its distance to
  `max(6 × radius, 2.5 × (largest moon orbit radius), minimum 1e-5 AU)`; animate the transition over
  ~0.6 s (ease-out) by tweening the subtraction offset, or simply snap if animation proves fiddly.
- **Bodies**: one shared `SphereGeometry(1, 48, 24)`, per-body `MeshStandardMaterial({ color })`
  (Sun: `MeshBasicMaterial`). `mesh.scale = radiusAu × k`, where each frame `k` enforces a **minimum
  on-screen radius**: `pxRadius = radiusAu / dist × (viewportHeight/2) / tan(fov/2)`; if
  `pxRadius < minPx` then `k = minPx / pxRadius`, else `k = 1`. `minPx` comes from the "Marker size"
  slider (0 = true scale, default 4, max 12). Custom objects are rendered as small octahedron/diamond
  meshes (ships, probes), rings (stations/habitats) or flat discs (bases) with a fixed on-screen size
  (~6 px) in their color, plus a 1-px outline sprite when selected.
- **Moon visibility**: hide a moon's mesh, label and orbit when the apparent radius of its orbit
  `aMoon / distToParent × (viewportHeight/2)/tan(fov/2) < 10 px`. Same rule for custom objects in
  `orbit` kind about a body.
- **Orbit lines**: `Line` + `LineBasicMaterial` (transparent, opacity ~0.5), colors by category
  (planets: category colour tinted; moons grey; asteroids olive; comets cyan; custom: object colour).
  Planet orbit lines are rebuilt when the ephemeris cache says so (§4). The selected body's orbit is
  drawn brighter.
- **Custom routes**: full path polyline in the object's colour (past part dimmer than future, if easy),
  dashed `LineDashedMaterial` for ballistic legs optional. Toggle per object (`showPath`).
- **Labels**: `CSS2DRenderer` with one `<div class="label label-planet">` per visible body/object;
  click on a label selects/focuses. Category toggles hide labels and meshes together. Label text:
  name; custom objects additionally show a small type glyph.
- **Picking**: on click, project all visible objects to screen space and pick the nearest within 14 px;
  ignore drags (> 5 px mouse movement). Double-click focuses; single click selects (info panel) and
  focuses as well — one behaviour: click = select + focus. Hovering highlights the label.
- **Sun**: true-scale emissive sphere + additive-blended radial-gradient `Sprite` sized to a fixed
  ~36 px, plus `PointLight` at the Sun (decay 0, intensity ~3) and `AmbientLight(0xffffff, 0.35)`.
- **Saturn rings**: `RingGeometry(innerAu, outerAu, 96)`, `MeshBasicMaterial({ side: DoubleSide,
  transparent: true, opacity: 0.6, color: '#c8b995' })`, oriented to the pole (§3.3); scales with the
  body's `k` factor.
- **Ecliptic grid**: concentric circles at 0.39, 0.72, 1, 1.52, 2, 3, 5, 10, 20, 30, 50, 100 AU
  (faint, planet distances slightly brighter) plus 12 radial spokes; `CSS2D` labels "1 AU", "5 AU"…
  Toggle. Centered on the Sun.
- **Starfield**: `Points` with 5000 random unit directions × 5e4 AU, `sizeAttenuation: false`,
  size 1.5, subtle colour variation.
- **Measurement line**: when "Measure" has two endpoints, draw a line between them each frame and a
  mid-point CSS2D label: `0.524 AU · 78.4 M km · 4 min 21 s light`.
- Resize handling; `requestAnimationFrame` loop that only re-renders when something changed or time
  is playing (cheap enough to always render at 60 fps; keep it simple).

## 7. Time control (`src/sim/clock.js` + bottom bar UI)

State: `jd` (number), `playing` (bool), `rate` (sim seconds per real second; negative allowed).
Presets: Real time (1), 1 min/s (60), 1 h/s (3600), 1 day/s, 1 week/s, 1 month/s (30 d), 1 yr/s
(365.25 d), 10 yr/s. Buttons: ⏮ step back / ⏯ play-pause / ⏭ step forward with a step-size
dropdown (1 h, 1 d, 7 d, 30 d, 1 yr); "Now" (sets to `nowJd()`); a date text field accepting
`parseDateToJd` input (Enter applies; invalid shows red); a `datetime-local` picker as an
alternative where year ≤ 9999. Display: `formatJd(jd)` and the JD number. Keyboard: Space = play/pause,
`,`/`.` = step back/forward, `[`/`]` = slower/faster, `N` = now, `Esc` closes modals.
Reverse-play toggle (negates `rate`). While playing, advance `jd += rate × dtRealSeconds / 86400`.

## 8. UI (`index.html`, `src/styles.css`, `src/ui/*.js`)

Layout (CSS grid): top bar; left sidebar (object browser, collapsible); center canvas; right sidebar
(inspector); bottom bar (time + events timeline). Dark theme (#0b0e14 background, #d7dce5 text,
accent #5aa9ff), system font, tabular numerals for data. Everything keyboard-accessible where cheap.

**Top bar**: title "Solar System Model"; search box (filters the object list, Enter focuses the first
match); toggle chips: Orbits · Labels · Grid · Moons · Asteroids · Comets · Custom; "Marker size"
slider; View menu: Top-down (ecliptic north, looking down at the focus), Oblique (default, ~35° elevation),
Inner system (focus Sun, distance ~3.5 AU), Outer system (~45 AU), Kuiper belt (~110 AU), Frame selection;
buttons: ＋ Object · Planner · Events · Import · Export · Help.

**Left sidebar — object browser**: groups (collapsible): Custom objects (with edit ✎ and delete 🗑 per
row and "＋ new"), Sun & planets (moons nested under their planet), Dwarf planets, Asteroids
(main belt + Trojans), Near-Earth objects, Centaurs, Comets. Row: colour dot, name, and for custom
objects a type glyph. Click → select + focus. The selected row is highlighted.

**Right sidebar — inspector** for the selection (tabs: Overview · Distances · Orbit):
- Overview: name, type/category, parent, radius (km), GM, rotation (if known), designation/orbit class;
  heliocentric position x/y/z (AU, 6 decimals), distance from Sun (AU and M km), speed (km/s),
  for moons: distance from parent (km); for custom objects: motion summary (kind; for routes: current
  leg "Earth → Mars, departed 2187-03-02, arrives 2187-05-14 (in 31.2 d)", accel in g, peak velocity
  km/s, Δv km/s, distance; for ballistic: departure/arrival excess speed, transfer a/e), status badges
  (parked / in transit / not yet exists), editable notes textarea (autosaves), tags.
- Distances: table of distance from the selection to the Sun, all planets, the Moon, and every custom
  object (and the selection's parent and sibling moons when relevant): AU · M km · one-way light time
  · round-trip. Sortable by distance (default). A "Measure to…" button arms measure mode: the next
  click on any object sets the second endpoint; the measurement persists (line + label) until cleared.
- Orbit: osculating elements of the selection about its parent (a, e, i, Ω, ω, M, period, periapsis,
  apoapsis) from `stateToElements` of its current relative state.

**Bottom bar**: time controls (§7) on the left; on the right an **events timeline strip**: a horizontal
axis spanning `[min(eventJd, jd) − margin, max(eventJd, jd) + margin]` with tick marks for story events
(coloured), the current time as a vertical cursor; clicking a tick jumps to it; hovering shows title.
Buttons: "＋ event at current time", "Events…" (opens the list editor).

**Modals**:
- **Object editor** (add/edit): name, type, colour (palette + input), tags, notes, existence window
  (optional from/until dates), show path checkbox; motion kind tabs: Orbit / Co-located / Lagrange /
  Fixed / Route. Route tab: profile select, optional acceleration (g) for brachistochrone, stops table
  (ref select with search across natural bodies + custom objects, or fixed xyz; arrive/depart date
  fields; add/remove/reorder). Live validation summary (computed legs: distance, duration, accel, peak v,
  Δv; for ballistic: departure/arrival speeds; warnings). Save/Cancel/Delete. Body selects list bodies
  grouped by category.
- **Travel planner**: from, to (any body/custom object), departure date (default current jd),
  mode: (a) Brachistochrone, given acceleration (g) → duration, arrival date, peak velocity, Δv, distance
  at departure and arrival (uses the iterative solve from §5); (b) Brachistochrone, given duration →
  required acceleration (g and m/s²), peak v, Δv; (c) Ballistic (Lambert), given duration → departure
  and arrival excess speeds (km/s), transfer orbit a/e, perihelion distance; (d) a "scan" table for
  ballistic mode: durations from 60 d to 3 yr in ~12 steps with total excess Δv, to spot cheap windows.
  Always shows the straight-line distance and one-way light time at departure. Button
  "Create ship from this plan" → opens the object editor prefilled with a 2-stop route.
- **Events editor**: list (date, title, notes, colour) with add/edit/delete; "Jump" per row; sort by date.
- **Import**: file input (JSON, §9) with a preview of counts and a merge/replace choice.
- **Help**: controls, keyboard shortcuts, accuracy notes (§11), scenario format pointer, credits (JPL SSD).

Toasts for save/import/export/errors (bottom-center, auto-dismiss).

## 9. Scenario persistence (`src/sim/scenario.js`)

```json
{ "version": 1, "name": "My Story", "savedAt": "ISO string",
  "objects": [ ...custom objects (§5) ], "events": [ { "id", "jd", "title", "notes", "color" } ],
  "view": { "jd": 2461324.5, "focus": "earth", "toggles": { "orbits": true, ... }, "markerPx": 4 } }
```
- Autosave to `localStorage['ssm.scenario.v1']` debounced 500 ms on any change (objects, events, view).
- Export: download `<name>.solarsystem.json` (pretty-printed). Import: validate `version`, ids
  deduplicated on merge. "New scenario" clears (with confirm). Scenario name editable in the top bar
  (click to edit).
- On first run (no saved data) load the **example scenario** generated relative to the current date
  `t = nowJd()` (times rounded to whole days). Compute route arrival times with the §5 solver so the
  example is self-consistent:
  1. "Gateway Station" — station, `orbit` earth, a = 42164 km (geostationary), e 0, i 0.
  2. "Tsiolkovsky Yards" — habitat, `lagrange` earth–moon L2.
  3. "Ardent" — ship, `route` brachistochrone 0.3 g: Earth (depart t+10 d) → Mars (arrive solved; depart +20 d) → Ceres (arrive solved).
  4. "Hermes" — ship, `route` ballistic: Earth (depart t+30 d) → Mars (arrive t+30+240 d). Notes: "Slow freighter, Hohmann-ish."
  5. "Olympus Base" — base, `colocated` mars.
  6. "Perimeter Watch" — fleet, `orbit` jupiter, a = 1.9e6 km (just outside Callisto), i 2°.
  7. "Far Horizon" — probe, `route` brachistochrone 0.01 g: Earth (depart t+60 d) → Neptune (arrive solved).
  8. "Vesta Mining Camp" — base, `colocated` vesta.
  Events: "Ardent departs Earth" (t+10 d), "Ardent arrives Mars" (solved), "Hermes departs" (t+30 d),
  "Opposition watch" (t+400 d).
  Name: "Example scenario". Scenario view: jd = t, focus = sun, oblique view, distance ~3.5 AU.

## 10. Project layout

```
index.html                 app shell (static markup for bars/panels/modals)
vite.config.js             base: './'
package.json               (exists)
README.md                  user documentation (see §12)
.gitignore                 node_modules/ dist/ .vite/ .claude/ *.log
.github/workflows/deploy.yml   manual GitHub Pages deploy (workflow_dispatch only)
.claude/launch.json        { "configurations": [{ "name": "dev", "runtimeExecutable": "npm", "runtimeArgs": ["run","dev","--","--port","5173","--strictPort"], "port": 5173 }] }  (gitignored)
scripts/fetch-data.mjs     §3
scripts/validate-astro.mjs (exists)
src/main.js                bootstrap: load data, build catalog, scene, UI, start loop
src/styles.css
src/astro/*                (exists)
src/data/catalog.js        planets/sun table + colours + loader that merges smallbodies.json & moons.json
src/data/smallbodies.json  generated
src/data/moons.json        generated
src/sim/ephemeris.js       §4
src/sim/custom.js          §5
src/sim/clock.js           §7
src/sim/scenario.js        §9 (+ example scenario)
src/sim/store.js           tiny observable app state (selection, focus, toggles, measure, jd) with subscribe()
src/scene/renderer.js      three setup, resize, loop, focus-relative update
src/scene/bodies.js        meshes, orbit lines, labels for natural bodies
src/scene/customObjects.js meshes, paths, labels for custom objects
src/scene/grid.js, starfield.js, measure.js
src/ui/topbar.js, sidebar.js, inspector.js, timebar.js, timeline.js, modals/objectEditor.js,
       modals/planner.js, modals/events.js, modals/importExport.js, modals/help.js, toast.js, format.js
```
`format.js`: `fmtAu(x)`, `fmtKm(x)`, `fmtMkm`, `fmtKmS`, `fmtLightTime(seconds)` ("4 min 21 s",
"1 h 12 min", "5.2 h", "2.3 light-days"), `fmtG`, `fmtDeg`, `fmtDuration` (wraps `formatDuration`).

Keep modules small and documented with JSDoc. No global mutable state except the store.

## 11. Accuracy notes (must appear in Help and README)

- Planets: JPL/Standish Keplerian approximation, valid 3000 BC–3000 AD; typical error a few
  arcminutes in heliocentric longitude (Jupiter up to ~5′ far from J2000), i.e. ~10⁵–10⁶ km. Good for
  story geometry, not for navigation.
- Moon: truncated Meeus series, ~0.02° (≈150 km).
- Small bodies: SBDB osculating elements at their epoch, propagated as unperturbed Kepler orbits.
  Accurate for a few decades around the epoch for main-belt asteroids; comets and NEOs drift quickly
  (planetary perturbations and outgassing ignored). Re-run `npm run fetch-data` to refresh.
- Moons: Horizons osculating elements at J2000 propagated as fixed Kepler orbits; orbit planes are
  right, phases drift over decades.
- Transfers: brachistochrone = straight line, constant thrust, midpoint flip, solar gravity ignored;
  ballistic = two-body Lambert about the Sun, planetary gravity ignored (no SOI, no capture burns).
- Light time: straight-line distance / c, no relativistic corrections.

## 12. README.md

Sections: What it is · Features (bulleted, with the motion models and planner) · Quick start
(`npm install`, `npm run dev`, `npm run build`; `npm run validate`; `npm run fetch-data`) · Using the
app (controls, time, adding objects, routes, planner, measuring, events, saving/exporting; keyboard
shortcuts) · Scenario JSON format (§9 with a short example) · Accuracy & data sources (§11, link JPL SSD,
Horizons, SBDB, Standish tables) · Publishing to GitHub Pages (run the "Deploy to GitHub Pages" workflow
from the Actions tab; Pages must then be set to "GitHub Actions" source if the workflow's `enablement`
step cannot do it) · Project structure · License (MIT, author Sam / thatotherguy012).

## 13. GitHub

- Repository: `https://github.com/thatotherguy012/solarsystemmodel.git` (exists, empty, default branch `main`).
- `git init -b main` in the project root; set repo-local identity
  `git config user.name "thatotherguy012"` and `git config user.email "sksl1912@gmail.com"`.
- Commit in a few logical commits (astro core + data; scene; UI; docs/workflow). Commit messages end
  with the line `Co-Authored-By: Claude Opus 5.5 <noreply@anthropic.com>`.
- `git remote add origin https://github.com/thatotherguy012/solarsystemmodel.git` and
  `git push -u origin main`. Git Credential Manager is the configured helper and no GitHub credential is
  stored, so the push may open an interactive sign-in window; run the push with a 5-minute timeout. If
  `GH_TOKEN` or `GITHUB_TOKEN` exists in the environment, use it non-interactively instead
  (`git -c credential.helper= push https://x-access-token:$TOKEN@github.com/thatotherguy012/solarsystemmodel.git main`
  — never commit or print the token). If the push fails or times out, leave everything committed locally
  and report exactly that; do not retry more than twice.
- `.github/workflows/deploy.yml`: `on: workflow_dispatch`; Node 22; `npm ci`; `npm run build`;
  `actions/configure-pages@v5` with `enablement: true`; `actions/upload-pages-artifact@v3` (path `dist`);
  `actions/deploy-pages@v4`; permissions `pages: write`, `id-token: write`, `contents: read`.
  Do **not** enable Pages or trigger the workflow yourself.

## 14. Verification (do all of this before reporting)

1. `npm run validate` passes.
2. `npm run fetch-data` produced both JSON files with the expected counts (≈73 small bodies, 28 moons);
   spot-check that Ceres a ≈ 2.77 AU, Halley e ≈ 0.967, Io a ≈ 421 800 km, Titan a ≈ 1 221 900 km.
3. `npm run build` succeeds without warnings about missing imports; bundle < 2 MB.
4. Use the built-in browser (`preview_start` with the `dev` launch config) to open the app and:
   - no console errors on load; screenshot the default view;
   - select Earth from the sidebar: inspector shows distance from Sun ≈ 0.98–1.02 AU and speed ≈ 29–30 km/s;
     Moon visible and orbiting when zoomed in;
   - set the date to `2026-10-11 00:00` and confirm Earth's heliocentric position is approximately
     x 0.9532, y 0.2974 AU (Horizons reference) and Mars ≈ (−0.0072, 1.5700, 0.0331);
   - press play at 1 day/s and confirm motion; step ±1 yr; set year 2187 via the text field;
   - open the object editor, create a station in a 400 km orbit about Mars, save, and see it listed,
     rendered, and persisted after reload;
   - open the planner Earth→Mars at 0.3 g from the current date: duration should be roughly 3–7 days
     depending on geometry; "Create ship" prefills the editor;
   - the example ship "Ardent" shows a transit badge and a path line; the Distances tab lists light times;
   - Measure Earth→Jupiter shows a line and label; Export downloads JSON (check the toast and the
     download is offered); category toggles hide/show groups.
   Fix anything broken and re-test. Capture 2–3 screenshots for the report.
5. `git status` clean, pushed (or push failure explained).

## 15. Final report (to the coordinating agent)

Concise: what was built (by file group), data counts, validation/build/browser-test results with any
numbers checked, screenshots paths, git commits and push status, deviations from this spec and why,
known limitations. No questions — make reasonable decisions and record them.
