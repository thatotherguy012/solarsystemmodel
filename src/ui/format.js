// Number formatting for display. All inputs are in internal units unless the name says otherwise.
import { AU_KM, LIGHT_S_PER_AU, auDayToKmS, auDay2ToMS2, G0_M_S2, RAD } from '../astro/constants.js';
import { formatDuration } from '../astro/time.js';

const nf0 = new Intl.NumberFormat('en-US', { maximumFractionDigits: 0 });
const nfCache = new Map();
function nf(digits) {
  let f = nfCache.get(digits);
  if (!f) {
    f = new Intl.NumberFormat('en-US', { minimumFractionDigits: digits, maximumFractionDigits: digits });
    nfCache.set(digits, f);
  }
  return f;
}

/** Grouped number with fixed decimals: fmtNum(384400.2, 0) -> "384,400". */
export function fmtNum(x, digits = 0) {
  if (!Number.isFinite(x)) return '—';
  return digits === 0 ? nf0.format(x) : nf(digits).format(x);
}

/** Distance in AU: "5.2034 AU", "0.002571 AU". */
export function fmtAu(au) {
  if (!Number.isFinite(au)) return '—';
  const a = Math.abs(au);
  let s;
  if (a >= 100) s = au.toFixed(2);
  else if (a >= 1) s = au.toFixed(4);
  else if (a >= 0.01) s = au.toFixed(5);
  else if (a >= 1e-6) s = au.toPrecision(4);
  else s = au.toExponential(3);
  return `${s} AU`;
}

/** Distance in km from a km value: "384,400 km", "11.1 km". */
export function fmtKm(km) {
  if (!Number.isFinite(km)) return '—';
  const a = Math.abs(km);
  if (a < 10) return `${km.toFixed(2)} km`;
  if (a < 1000) return `${km.toFixed(1)} km`;
  return `${fmtNum(km, 0)} km`;
}

/** Distance in million km from a km value: "78.4 M km". */
export function fmtMkm(km) {
  if (!Number.isFinite(km)) return '—';
  const m = km / 1e6;
  const a = Math.abs(m);
  const d = a < 1 ? 3 : a < 100 ? 2 : 1;
  return `${fmtNum(m, d)} M km`;
}

/** Best single distance string from AU: km below 0.01 AU, otherwise AU (M km). */
export function fmtDist(au) {
  if (!Number.isFinite(au)) return '—';
  const km = au * AU_KM;
  if (Math.abs(au) < 0.01) return fmtKm(km);
  return `${fmtAu(au)} (${fmtMkm(km)})`;
}

/** Speed from AU/day: "29.78 km/s". */
export function fmtKmS(auPerDay) {
  return fmtSpeedKmS(auDayToKmS(auPerDay));
}

/** Speed from km/s. */
export function fmtSpeedKmS(kms) {
  if (!Number.isFinite(kms)) return '—';
  const a = Math.abs(kms);
  if (a < 1) return `${(kms * 1000).toFixed(1)} m/s`;
  if (a < 100) return `${kms.toFixed(2)} km/s`;
  return `${fmtNum(kms, a < 10000 ? 1 : 0)} km/s`;
}

/**
 * Light time from seconds: "1.28 s", "4 min 21 s", "1 h 12 min", "5.2 h", "2.3 light-days".
 */
export function fmtLightTime(seconds) {
  if (!Number.isFinite(seconds)) return '—';
  const s = Math.abs(seconds);
  if (s < 1e-3) return `${(s * 1e6).toFixed(1)} µs`;
  if (s < 1) return `${(s * 1000).toFixed(1)} ms`;
  if (s < 60) return `${s.toFixed(s < 10 ? 2 : 1)} s`;
  if (s < 3600) {
    const m = Math.floor(s / 60), r = Math.round(s - m * 60);
    return r === 60 ? `${m + 1} min 0 s` : `${m} min ${r} s`;
  }
  if (s < 3 * 3600) {
    const h = Math.floor(s / 3600), m = Math.round((s - h * 3600) / 60);
    return m === 60 ? `${h + 1} h 0 min` : `${h} h ${m} min`;
  }
  if (s < 48 * 3600) return `${(s / 3600).toFixed(1)} h`;
  return `${(s / 86400).toFixed(1)} light-days`;
}

/** One-way light time for a distance in AU. */
export function fmtLightAu(au) {
  return fmtLightTime(au * LIGHT_S_PER_AU);
}

/** Acceleration from AU/day^2 as g: "0.300 g". */
export function fmtGFromAuDay2(a) {
  return fmtG(auDay2ToMS2(a) / G0_M_S2);
}

/** Acceleration in g: "0.300 g", "0.00042 g". */
export function fmtG(g) {
  if (!Number.isFinite(g)) return '—';
  const a = Math.abs(g);
  if (a >= 100) return `${fmtNum(g, 0)} g`;
  if (a >= 0.01) return `${g.toFixed(3)} g`;
  return `${g.toPrecision(3)} g`;
}

/** m/s^2 from AU/day^2. */
export function fmtMS2(a) {
  const v = auDay2ToMS2(a);
  if (!Number.isFinite(v)) return '—';
  return `${Math.abs(v) >= 0.1 ? v.toFixed(3) : v.toPrecision(3)} m/s²`;
}

/** Angle from radians: "10.588°". */
export function fmtDeg(rad, digits = 3) {
  if (!Number.isFinite(rad)) return '—';
  return `${(rad * RAD).toFixed(digits)}°`;
}

/** Duration from days (wraps formatDuration). */
export function fmtDuration(days) {
  if (!Number.isFinite(days)) return '—';
  return formatDuration(days);
}

/** Escape text for HTML insertion. */
export function esc(s) {
  return String(s ?? '').replace(/[&<>"']/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c]));
}
