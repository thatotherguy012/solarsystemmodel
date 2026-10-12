// Julian Date <-> civil calendar (proleptic Gregorian), independent of JS Date limits.
// JD here is treated as UTC-ish for display; the ~1 minute TT-UTC difference is irrelevant at this accuracy.
import { J2000_JD, JULIAN_CENTURY } from './constants.js';

export const UNIX_EPOCH_JD = 2440587.5;

export function dateToJd(date) { return date.getTime() / 86400000 + UNIX_EPOCH_JD; }
export function jdToDate(jd) { return new Date((jd - UNIX_EPOCH_JD) * 86400000); }
export function nowJd() { return dateToJd(new Date()); }
export function jdToT(jd) { return (jd - J2000_JD) / JULIAN_CENTURY; } // Julian centuries since J2000
export function jdToDaysJ2000(jd) { return jd - J2000_JD; }

/** Gregorian calendar (year, month 1-12, day, hour, minute, second) -> JD. Works for any year, incl. negative. */
export function civilToJd(y, m, d, hh = 0, mm = 0, ss = 0) {
  const a = Math.floor((14 - m) / 12);
  const yy = y + 4800 - a;
  const mmth = m + 12 * a - 3;
  const jdn = d + Math.floor((153 * mmth + 2) / 5) + 365 * yy + Math.floor(yy / 4) - Math.floor(yy / 100) + Math.floor(yy / 400) - 32045;
  return jdn + (hh - 12) / 24 + mm / 1440 + ss / 86400;
}

/** JD -> {year, month, day, hour, minute, second} in the proleptic Gregorian calendar. */
export function jdToCivil(jd) {
  const z = Math.floor(jd + 0.5);
  let f = jd + 0.5 - z;
  const a = z + 32044;
  const b = Math.floor((4 * a + 3) / 146097);
  const c = a - Math.floor(146097 * b / 4);
  const d = Math.floor((4 * c + 3) / 1461);
  const e = c - Math.floor(1461 * d / 4);
  const m = Math.floor((5 * e + 2) / 153);
  const day = e - Math.floor((153 * m + 2) / 5) + 1;
  const month = m + 3 - 12 * Math.floor(m / 10);
  const year = 100 * b + d - 4800 + Math.floor(m / 10);
  let secs = Math.round(f * 86400);
  if (secs >= 86400) secs = 86399;
  const hour = Math.floor(secs / 3600);
  const minute = Math.floor((secs % 3600) / 60);
  const second = secs % 60;
  return { year, month, day, hour, minute, second };
}

const pad = (n, w = 2) => String(Math.abs(n)).padStart(w, '0');

/** "2187-03-14 06:42 UTC" style formatting. */
export function formatJd(jd, { seconds = false, time = true } = {}) {
  const c = jdToCivil(jd);
  const ys = (c.year < 0 ? '-' : '') + pad(c.year, 4);
  let s = `${ys}-${pad(c.month)}-${pad(c.day)}`;
  if (time) {
    s += ` ${pad(c.hour)}:${pad(c.minute)}`;
    if (seconds) s += `:${pad(c.second)}`;
    s += ' UTC';
  }
  return s;
}

/** Value usable in <input type="datetime-local"> (no timezone); clamps to 4-digit years for the control. */
export function jdToInputValue(jd) {
  const c = jdToCivil(jd);
  const y = Math.min(Math.max(c.year, 1), 9999);
  return `${pad(y, 4)}-${pad(c.month)}-${pad(c.day)}T${pad(c.hour)}:${pad(c.minute)}`;
}

/**
 * Parse "YYYY-MM-DD", "YYYY-MM-DD HH:MM", "YYYY-MM-DDTHH:MM[:SS]", with optional leading '-' for BCE years.
 * Returns JD or NaN.
 */
export function parseDateToJd(str) {
  if (typeof str !== 'string') return NaN;
  const m = str.trim().match(/^(-?\d{1,6})-(\d{1,2})-(\d{1,2})(?:[ T](\d{1,2}):(\d{2})(?::(\d{2}(?:\.\d+)?))?)?\s*(?:Z|UTC)?$/i);
  if (!m) return NaN;
  const y = parseInt(m[1], 10), mo = parseInt(m[2], 10), d = parseInt(m[3], 10);
  const hh = m[4] ? parseInt(m[4], 10) : 0, mm = m[5] ? parseInt(m[5], 10) : 0, ss = m[6] ? parseFloat(m[6]) : 0;
  if (mo < 1 || mo > 12 || d < 1 || d > 31 || hh > 23 || mm > 59 || ss >= 61) return NaN;
  return civilToJd(y, mo, d, hh, mm, ss);
}

/** Human friendly duration from days. */
export function formatDuration(days) {
  const neg = days < 0; days = Math.abs(days);
  let s;
  if (days < 1 / 24) s = `${(days * 1440).toFixed(1)} min`;
  else if (days < 1) s = `${(days * 24).toFixed(2)} h`;
  else if (days < 60) s = `${days.toFixed(2)} d`;
  else if (days < 365.25 * 2) s = `${(days / 30.4375).toFixed(1)} months (${days.toFixed(0)} d)`;
  else s = `${(days / 365.25).toFixed(2)} yr (${days.toFixed(0)} d)`;
  return neg ? '-' + s : s;
}
