// Simulation clock: play/pause, rate presets, stepping. Time lives in the store (`jd`). DESIGN.md §7.
import { store } from './store.js';
import { nowJd } from '../astro/time.js';

/** Rate presets in sim seconds per real second. */
export const RATE_PRESETS = [
  { label: 'Real time', rate: 1 },
  { label: '1 min/s', rate: 60 },
  { label: '1 h/s', rate: 3600 },
  { label: '1 day/s', rate: 86400 },
  { label: '1 week/s', rate: 7 * 86400 },
  { label: '1 month/s', rate: 30 * 86400 },
  { label: '1 yr/s', rate: 365.25 * 86400 },
  { label: '10 yr/s', rate: 3652.5 * 86400 },
];

/** Step sizes for the step buttons, in days. */
export const STEP_PRESETS = [
  { label: '1 h', days: 1 / 24 },
  { label: '1 d', days: 1 },
  { label: '7 d', days: 7 },
  { label: '30 d', days: 30 },
  { label: '1 yr', days: 365.25 },
];

/** Largest real-time step honoured per frame (s); avoids huge jumps after the tab was hidden. */
const MAX_DT = 0.25;

/**
 * Advance the clock by a real-time interval.
 * @param {number} dtSeconds real seconds since the last frame
 */
export function tick(dtSeconds) {
  const s = store.get();
  if (!s.playing) return;
  const dt = Math.min(Math.max(dtSeconds, 0), MAX_DT);
  if (dt > 0) store.set({ jd: s.jd + (s.rate * dt) / 86400 });
}

export function togglePlay() {
  store.set({ playing: !store.get().playing });
}

export function setPlaying(playing) {
  store.set({ playing });
}

/** Step by ±stepDays. */
export function step(direction) {
  const s = store.get();
  store.set({ jd: s.jd + direction * s.stepDays });
}

export function setJd(jd) {
  if (Number.isFinite(jd)) store.set({ jd });
}

export function setNow() {
  store.set({ jd: nowJd() });
}

export function setRate(rate) {
  store.set({ rate });
}

/** Flip the direction of time. */
export function toggleReverse() {
  store.set({ rate: -store.get().rate });
}

/** Move to the next faster (dir=+1) or slower (dir=-1) preset, keeping the sign. */
export function changeSpeed(dir) {
  const s = store.get();
  const sign = s.rate < 0 ? -1 : 1;
  const mag = Math.abs(s.rate);
  let idx = RATE_PRESETS.findIndex((p) => Math.abs(p.rate - mag) < 1e-9);
  if (idx < 0) idx = RATE_PRESETS.findIndex((p) => p.rate > mag) - 1;
  idx = Math.min(RATE_PRESETS.length - 1, Math.max(0, idx + dir));
  store.set({ rate: sign * RATE_PRESETS[idx].rate });
}

/** Label for the current rate. */
export function rateLabel(rate) {
  const p = RATE_PRESETS.find((q) => Math.abs(q.rate - Math.abs(rate)) < 1e-9);
  const base = p ? p.label : `${Math.abs(rate).toFixed(0)}×`;
  return rate < 0 ? `−${base}` : base;
}
