// Physical constants and unit helpers. Internal units everywhere: AU, days, radians.
export const AU_KM = 149597870.7;
export const C_KM_S = 299792.458;
export const LIGHT_S_PER_AU = AU_KM / C_KM_S; // 499.00478 s
export const DAY_S = 86400;
export const J2000_JD = 2451545.0;
export const JULIAN_CENTURY = 36525;
export const GM_SUN_KM3_S2 = 1.32712440018e11;
export const DEG = Math.PI / 180;
export const RAD = 180 / Math.PI;
export const G0_M_S2 = 9.80665;
export const OBLIQUITY_J2000_DEG = 23.4392911;

/** Convert a GM in km^3/s^2 to AU^3/day^2. */
export function gmToAuDay(gmKm3S2) {
  return gmKm3S2 * DAY_S * DAY_S / (AU_KM * AU_KM * AU_KM);
}
export const GM_SUN = gmToAuDay(GM_SUN_KM3_S2); // ~2.9591220828e-4 AU^3/day^2

export const kmToAu = (km) => km / AU_KM;
export const auToKm = (au) => au * AU_KM;
/** AU/day -> km/s */
export const auDayToKmS = (v) => v * AU_KM / DAY_S;
/** km/s -> AU/day */
export const kmSToAuDay = (v) => v * DAY_S / AU_KM;
/** m/s^2 -> AU/day^2 */
export const mS2ToAuDay2 = (a) => a * DAY_S * DAY_S / (AU_KM * 1000);
/** AU/day^2 -> m/s^2 */
export const auDay2ToMS2 = (a) => a * AU_KM * 1000 / (DAY_S * DAY_S);

export function wrapDeg(x) { x = x % 360; return x < 0 ? x + 360 : x; }
export function wrapRad(x) { const t = 2 * Math.PI; x = x % t; return x < 0 ? x + t : x; }
export function wrapPiRad(x) { x = wrapRad(x); return x > Math.PI ? x - 2 * Math.PI : x; }
