// Situation report: a plain-text-friendly Markdown summary of the scenario at one date — the status and position of
// each custom object, distances and one-way signal delays between everything included, and the derived milestones
// and story events coming up. Pure function of the store state and the options (no DOM).
import { AU_KM, LIGHT_S_PER_AU, C_KM_S, auDayToKmS, auDay2ToMS2, G0_M_S2 } from '../astro/constants.js';
import { vlen, vsub } from '../astro/vec3.js';
import { formatJd } from '../astro/time.js';
import { getBody, allBodies, hasBody } from './ephemeris.js';
import {
  positionOf, velocityOf, existsAt, nameOf, routePhase, legData, stopFrameBody, orbitMotionElements,
} from './custom.js';
import { computeMilestones, stopName, legFlipJd } from './milestones.js';
import { formatAge } from './lightlag.js';

/**
 * @typedef {Object} ReportOptions
 * @property {number} jd                 report date
 * @property {string[]} objectIds        custom objects to include (in this order)
 * @property {string[]} bodyIds          natural bodies to include
 * @property {'mkm'|'km'|'au'} [distUnit] second distance unit shown next to AU (default million km)
 * @property {'kms'|'ms'|'c'} [speedUnit] speed unit (default km/s)
 * @property {number} [windowDays]       look-ahead for milestones and story events (default 30)
 * @property {boolean} [includeEvents]   list story events in the window (default true)
 * @property {'all'|'custom'} [pairs]    pair table: all pairs, or only pairs involving a custom object
 */

// ------------------------------------------------------------------ formatting helpers

const group3 = (x, d = 0) => x.toLocaleString('en-US', { minimumFractionDigits: d, maximumFractionDigits: d });
const signed = (x, d) => `${x < 0 ? '-' : '+'}${Math.abs(x).toFixed(d)}`;

/** Short relative duration from days: "45 min", "6.5 h", "4.2 d", "31 d", "2.4 yr". */
export function shortDuration(days) {
  const d = Math.abs(days);
  if (d < 1 / 24) return `${Math.round(d * 1440)} min`;
  if (d < 1) return `${(d * 24).toFixed(1)} h`;
  if (d < 10) return `${d.toFixed(1)} d`;
  if (d < 730) return `${Math.round(d)} d`;
  return `${(d / 365.25).toFixed(1)} yr`;
}

/** "in 4.2 d" / "4.2 d ago" / "now". */
function relative(days) {
  if (Math.abs(days) < 1 / 1440) return 'now';
  return days > 0 ? `in ${shortDuration(days)}` : `${shortDuration(days)} ago`;
}

const dateTime = (jd) => formatJd(jd);
const dateTimeShort = (jd) => formatJd(jd).replace(' UTC', '');

/** Distance in the chosen secondary unit (no AU). */
function secondUnit(au, unit) {
  const km = au * AU_KM;
  if (unit === 'km') return `${group3(km)} km`;
  const m = km / 1e6;
  return `${group3(m, m < 1 ? 3 : 2)} M km`;
}

/** "1.0012 AU (149.78 M km)"; very small distances in km. */
function distanceText(au, unit) {
  if (au === 0) return '0';
  const auTxt = au < 0.001 ? `${au.toPrecision(3)} AU` : `${au.toFixed(au < 10 ? 4 : 2)} AU`;
  if (unit === 'au') return auTxt;
  if (au * AU_KM < 1e6 && unit !== 'km') return `${auTxt} (${group3(au * AU_KM)} km)`;
  return `${auTxt} (${secondUnit(au, unit)})`;
}

/** Number for the pair table in the chosen unit. */
function distanceCell(au, unit) {
  if (unit === 'au') return au === 0 ? '0' : au < 0.001 ? au.toPrecision(3) : au.toFixed(au < 10 ? 4 : 2);
  const km = au * AU_KM;
  if (unit === 'km') return group3(km);
  const m = km / 1e6;
  return m === 0 ? '0' : m < 0.01 ? m.toPrecision(2) : group3(m, m < 100 ? 2 : 1);
}

const DIST_HEAD = { mkm: 'Distance (M km)', km: 'Distance (km)', au: 'Distance (AU)' };

/** Speed from AU/day in the chosen unit. */
function speedText(auDay, unit) {
  const kms = auDayToKmS(auDay);
  if (unit === 'ms') return `${group3(kms * 1000)} m/s`;
  if (unit === 'c') return `${((kms / C_KM_S) * 100).toPrecision(3)}% c`;
  return `${kms >= 100 ? group3(kms) : kms.toFixed(kms >= 10 ? 1 : 2)} km/s`;
}

/** One-way light time (signal delay) from a distance in AU. */
function delayText(au) {
  if (au === 0) return '0 s';
  return formatAge(au * LIGHT_S_PER_AU);
}

/** Markdown-safe single-line cell text. */
function cell(s) {
  return String(s ?? '').replace(/\s*\n\s*/g, ' ').replace(/\|/g, '\\|').trim();
}

/**
 * Markdown table padded so its columns line up in a plain-text editor.
 * @param {string[]} head
 * @param {string[][]} rows
 * @param {('l'|'r')[]} align
 */
export function mdTable(head, rows, align = []) {
  const all = [head, ...rows].map((r) => r.map(cell));
  const w = head.map((_, c) => Math.max(3, ...all.map((r) => (r[c] ?? '').length)));
  const line = (r) => `| ${r.map((x, c) => (align[c] === 'r' ? (x ?? '').padStart(w[c]) : (x ?? '').padEnd(w[c]))).join(' | ')} |`;
  const sep = `| ${w.map((n, c) => (align[c] === 'r' ? `${'-'.repeat(n - 1)}:` : '-'.repeat(n))).join(' | ')} |`;
  return [line(all[0]), sep, ...all.slice(1).map(line)].join('\n');
}

// ------------------------------------------------------------------ plain-language status

/** "Earth", "Gateway Station" or a waypoint description. */
function placeName(stop, ctx) {
  return stopName(stop, ctx);
}

/**
 * Plain-language status of a custom object at jd, e.g. "En route Earth → Mars, arrives 2187-05-14 06:00 UTC
 * (in 31 d), 612 km/s; decelerating at 0.30 g".
 */
export function objectStatus(obj, jd, ctx, speedUnit = 'kms') {
  if (!existsAt(obj, jd)) {
    if (obj.existsFromJd != null && jd < obj.existsFromJd) return `Not yet in existence (appears ${dateTime(obj.existsFromJd)}, ${relative(obj.existsFromJd - jd)})`;
    return `No longer exists (since ${dateTime(obj.existsUntilJd)})`;
  }
  const m = obj.motion || {};
  switch (m.kind) {
    case 'orbit': {
      let extra = '';
      const b = getBody(m.parent);
      const { el, mu } = orbitMotionElements(m);
      const parts = [];
      if (b) parts.push(`altitude ${group3(m.aKm * (1 - (m.e || 0)) - b.radiusKm)}${m.e > 0.001 ? `–${group3(m.aKm * (1 + m.e) - b.radiusKm)}` : ''} km`);
      if (mu > 0 && el.n > 0 && (m.e ?? 0) < 1) {
        const P = (2 * Math.PI) / el.n;
        parts.push(`period ${P < 1 ? `${(P * 24).toFixed(2)} h` : `${P.toFixed(2)} d`}`);
      }
      if (parts.length) extra = ` (${parts.join(', ')})`;
      return `In orbit around ${nameOf(m.parent, ctx)}${extra}`;
    }
    case 'colocated': {
      const p = nameOf(m.parent, ctx);
      const label = (m.label || '').trim();
      if (/^surface$/i.test(label)) return `On the surface of ${p}`;
      if (label) return `${label}, at ${p}`;
      return `Co-located with ${p}`;
    }
    case 'lagrange':
      return `Holding station at the ${nameOf(m.primary, ctx)}–${nameOf(m.secondary, ctx)} ${m.point || 'L1'} point`;
    case 'fixed':
      return 'Holding a fixed heliocentric position (station-keeping)';
    case 'route':
      return routeStatus(obj, jd, ctx, speedUnit);
    default:
      return 'Unknown motion';
  }
}

function routeStatus(obj, jd, ctx, speedUnit) {
  const m = obj.motion;
  const stops = m.stops || [];
  const ph = routePhase(m, jd);
  if (ph.kind === 'invalid') return 'Route has no stops';
  if (ph.kind === 'before' || ph.kind === 'parked') {
    const i = ph.stop;
    const here = placeName(stops[i], ctx);
    const next = stops[i + 1];
    if (next && stops[i].departJd != null && next.arriveJd != null) {
      const verb = ph.kind === 'before' ? 'Awaiting departure at' : 'Parked at';
      return `${verb} ${here}; departs for ${placeName(next, ctx)} ${dateTime(stops[i].departJd)} (${relative(stops[i].departJd - jd)})`;
    }
    return `Parked at ${here}`;
  }
  if (ph.kind === 'arrived') {
    const last = stops[stops.length - 1];
    return `Parked at ${placeName(last, ctx)} (arrived ${dateTime(last.arriveJd)}, ${relative(last.arriveJd - jd)})`;
  }
  // in transit
  const leg = legData(obj, ph.leg, ctx, 0);
  const from = placeName(stops[ph.leg], ctx), to = placeName(stops[ph.leg + 1], ctx);
  const v = vlen(velocityOf(obj.id, jd, ctx));
  const flyby = leg.arrFlyby ? ' (flyby)' : '';
  let s = `En route ${from} → ${to}${flyby}, arrives ${dateTime(leg.t1)} (${relative(leg.t1 - jd)}), ${speedText(v, speedUnit)}`;
  const flip = legFlipJd(leg);
  if (flip != null) {
    const g = auDay2ToMS2(leg.accel) / G0_M_S2;
    const gTxt = g >= 0.01 ? g.toFixed(2) : g.toPrecision(2);
    s += jd < flip ? `; accelerating at ${gTxt} g, flip ${relative(flip - jd)}` : `; decelerating at ${gTxt} g`;
  } else if (leg.profile === 'ballistic' && !leg.fallback) {
    s += '; engines off, drifting (ballistic coast)';
  } else if (leg.profile === 'linear' || leg.fallback) {
    s += '; cruising at constant velocity';
  }
  return s;
}

/** Natural bodies that an object is "at" or travelling between at jd (for the default body selection). */
export function parentsOf(obj, jd, ctx) {
  const m = obj.motion || {};
  const out = [];
  const add = (id) => {
    const b = stopFrameBody(id, ctx);
    if (b && !out.includes(b)) out.push(b);
  };
  if (m.kind === 'orbit' || m.kind === 'colocated') add(m.parent);
  else if (m.kind === 'lagrange') { add(m.primary); add(m.secondary); }
  else if (m.kind === 'route') {
    const ph = routePhase(m, jd);
    if (ph.kind === 'transit') { add(m.stops[ph.leg]?.ref); add(m.stops[ph.leg + 1]?.ref); }
    else if (ph.stop != null) { add(m.stops[ph.stop]?.ref); if (ph.kind !== 'arrived') add(m.stops[ph.stop + 1]?.ref); }
  }
  return out;
}

/**
 * Default selection: every custom object; the Sun, Earth, and the bodies the objects are at or travelling between.
 * @returns {{objectIds:string[], bodyIds:string[]}}
 */
export function defaultSelection(state, jd = state.jd) {
  const objectIds = state.objects.map((o) => o.id);
  const bodyIds = ['sun', 'earth'];
  for (const o of state.objects) for (const b of parentsOf(o, jd, state.ctx)) if (!bodyIds.includes(b)) bodyIds.push(b);
  return { objectIds, bodyIds: sortBodies(bodyIds) };
}

/** Catalog order (Sun, planets, …) for a list of body ids. */
export function sortBodies(ids) {
  const order = new Map(allBodies().map((b, i) => [b.id, i]));
  return [...new Set(ids)].filter(hasBody).sort((a, b) => (order.get(a) ?? 1e9) - (order.get(b) ?? 1e9));
}

// ------------------------------------------------------------------ report

/**
 * Build the situation report.
 * @param {import('./store.js').AppState} state
 * @param {ReportOptions} opts
 * @returns {{markdown:string, fileName:string}}
 */
export function buildReport(state, opts) {
  const ctx = state.ctx;
  const jd = opts.jd;
  const distUnit = opts.distUnit || 'mkm';
  const speedUnit = opts.speedUnit || 'kms';
  const windowDays = Number.isFinite(opts.windowDays) && opts.windowDays > 0 ? opts.windowDays : 30;
  const objects = opts.objectIds.map((id) => ctx.byId.get(id)).filter(Boolean);
  const bodies = sortBodies(opts.bodyIds);
  const L = [];
  const earth = positionOf('earth', jd, ctx);
  const sunDist = (r) => vlen(r);

  L.push(`# Situation report: ${state.scenarioName || 'Untitled scenario'}`);
  L.push('');
  L.push(`Date:   ${dateTime(jd)} (JD ${jd.toFixed(5)})`);
  L.push('Frame:  heliocentric ecliptic J2000; distances are straight lines; signal delay = one-way light time.');
  L.push(`Speeds: heliocentric.`);
  L.push('');

  // ---- custom objects
  L.push('## Custom objects');
  L.push('');
  if (!objects.length) { L.push('None selected.'); L.push(''); }
  for (const o of objects) {
    L.push(`### ${o.name} (${o.type})`);
    L.push('');
    L.push(`- Status:     ${objectStatus(o, jd, ctx, speedUnit)}`);
    const r = positionOf(o.id, jd, ctx);
    if (r && existsAt(o, jd)) {
      L.push(`- Position:   x ${signed(r[0], 6)}, y ${signed(r[1], 6)}, z ${signed(r[2], 6)} AU`);
      L.push(`- From Sun:   ${distanceText(sunDist(r), distUnit)}`);
      const dE = vlen(vsub(r, earth));
      L.push(`- From Earth: ${dE === 0 ? '0 (at Earth)' : distanceText(dE, distUnit)}`);
      L.push(`- Signal delay to Earth: ${dE === 0 ? 'none (at Earth)' : `${delayText(dE)} one-way, ${formatAge(2 * dE * LIGHT_S_PER_AU)} round trip`}`);
      L.push(`- Speed:      ${speedText(vlen(velocityOf(o.id, jd, ctx)), speedUnit)}`);
    }
    if (o.tags?.length) L.push(`- Tags:       ${o.tags.join(', ')}`);
    L.push('');
  }

  // ---- reference bodies
  if (bodies.length) {
    L.push('## Reference bodies');
    L.push('');
    const rows = bodies.map((id) => {
      const r = positionOf(id, jd, ctx);
      const dE = vlen(vsub(r, earth));
      return [nameOf(id, ctx), signed(r[0], 6), signed(r[1], 6), signed(r[2], 6), distanceCell(sunDist(r), distUnit), id === 'earth' ? '—' : distanceCell(dE, distUnit), id === 'earth' ? '—' : delayText(dE)];
    });
    const u = { mkm: 'M km', km: 'km', au: 'AU' }[distUnit];
    L.push(mdTable(['Body', 'x (AU)', 'y (AU)', 'z (AU)', `From Sun (${u})`, `From Earth (${u})`, 'Signal delay to Earth'], rows, ['l', 'r', 'r', 'r', 'r', 'r', 'r']));
    L.push('');
  }

  // ---- pairwise distances and delays
  const items = [
    ...objects.filter((o) => existsAt(o, jd)).map((o) => ({ id: o.id, name: o.name, custom: true })),
    ...bodies.map((id) => ({ id, name: nameOf(id, ctx), custom: false })),
  ];
  const pos = new Map(items.map((it) => [it.id, positionOf(it.id, jd, ctx)]));
  const rows = [];
  for (let a = 0; a < items.length; a++) {
    for (let b = a + 1; b < items.length; b++) {
      const A = items[a], B = items[b];
      if (opts.pairs === 'custom' && !A.custom && !B.custom) continue;
      const d = vlen(vsub(pos.get(A.id), pos.get(B.id)));
      const row = [A.name, B.name];
      if (distUnit !== 'au') row.push(distanceCell(d, 'au'));
      row.push(distanceCell(d, distUnit), delayText(d));
      rows.push(row);
    }
  }
  L.push('## Distances and signal delays');
  L.push('');
  if (rows.length) {
    const head = ['From', 'To', ...(distUnit !== 'au' ? ['AU'] : []), DIST_HEAD[distUnit], 'Signal delay (one-way)'];
    L.push(mdTable(head, rows, ['l', 'l', 'r', 'r', 'r']));
  } else L.push('Select at least two objects or bodies.');
  L.push('');

  // ---- upcoming milestones
  const end = jd + windowDays;
  const objSet = new Set(objects.map((o) => o.id));
  const ms = computeMilestones(state.objects, ctx).filter((x) => x.jd >= jd && x.jd <= end && objSet.has(x.objId));
  L.push(`## Upcoming milestones (next ${windowDays} days, to ${dateTimeShort(end)})`);
  L.push('');
  if (ms.length) {
    L.push(mdTable(['Date (UTC)', 'In', 'Milestone', 'Details'],
      ms.map((x) => [dateTimeShort(x.jd), shortDuration(x.jd - jd), x.title, x.detail]), ['l', 'r', 'l', 'l']));
  } else L.push('None in this window.');
  L.push('');

  // ---- story events
  if (opts.includeEvents !== false) {
    const evs = state.events.filter((e) => e.jd >= jd && e.jd <= end).sort((a, b) => a.jd - b.jd);
    L.push(`## Story events (next ${windowDays} days)`);
    L.push('');
    if (evs.length) {
      L.push(mdTable(['Date (UTC)', 'In', 'Event', 'Notes'], evs.map((e) => [dateTimeShort(e.jd), shortDuration(e.jd - jd), e.title, e.notes || '']), ['l', 'r', 'l', 'l']));
    } else L.push('None in this window.');
    L.push('');
  }

  L.push('---');
  L.push('Generated by Solar System Model. Planet positions: JPL/Standish mean elements; light time: straight-line distance / c.');
  return { markdown: L.join('\n') + '\n', fileName: reportFileName(state.scenarioName, jd) };
}

/** "<scenario> situation report 2187-03-14.md" (file-system safe). */
export function reportFileName(name, jd) {
  const base = (name || 'scenario').trim().replace(/[\\/:*?"<>|]+/g, '-').replace(/\s+/g, ' ') || 'scenario';
  const c = formatJd(jd, { time: false });
  return `${base} situation report ${c}.md`;
}
