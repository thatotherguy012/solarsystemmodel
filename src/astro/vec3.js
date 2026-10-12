// Minimal double-precision 3-vector helpers on plain arrays [x,y,z].
export const vadd = (a, b) => [a[0] + b[0], a[1] + b[1], a[2] + b[2]];
export const vsub = (a, b) => [a[0] - b[0], a[1] - b[1], a[2] - b[2]];
export const vscale = (a, s) => [a[0] * s, a[1] * s, a[2] * s];
export const vdot = (a, b) => a[0] * b[0] + a[1] * b[1] + a[2] * b[2];
export const vcross = (a, b) => [a[1] * b[2] - a[2] * b[1], a[2] * b[0] - a[0] * b[2], a[0] * b[1] - a[1] * b[0]];
export const vlen = (a) => Math.hypot(a[0], a[1], a[2]);
export const vdist = (a, b) => Math.hypot(a[0] - b[0], a[1] - b[1], a[2] - b[2]);
export const vnorm = (a) => { const l = vlen(a); return l > 0 ? [a[0] / l, a[1] / l, a[2] / l] : [0, 0, 0]; };
export const vlerp = (a, b, t) => [a[0] + (b[0] - a[0]) * t, a[1] + (b[1] - a[1]) * t, a[2] + (b[2] - a[2]) * t];
export const vzero = () => [0, 0, 0];

/** Rotate vector about X axis by angle (rad). */
export function rotX(v, ang) {
  const c = Math.cos(ang), s = Math.sin(ang);
  return [v[0], c * v[1] - s * v[2], s * v[1] + c * v[2]];
}
/** Rotate vector about Z axis by angle (rad). */
export function rotZ(v, ang) {
  const c = Math.cos(ang), s = Math.sin(ang);
  return [c * v[0] - s * v[1], s * v[0] + c * v[1], v[2]];
}
