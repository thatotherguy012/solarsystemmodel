// Canvas widgets for the planner's "Launch windows" tab: a porkchop heatmap (departure date x flight time, banded
// perceptual colour scale, legend, date/day axes, minimum / window / selection markers, hover and click) and a
// small two-axis line chart (torch-ship trip time and peak speed against departure date).
// Rendering only; the numbers come from src/sim/porkchop.js. Both widgets follow their container's width.
import '../styles-porkchop.css';
import { jdToCivil, civilToJd } from '../astro/time.js';

const MONTHS = ['Jan', 'Feb', 'Mar', 'Apr', 'May', 'Jun', 'Jul', 'Aug', 'Sep', 'Oct', 'Nov', 'Dec'];
const FONT = '11px system-ui, -apple-system, "Segoe UI", Roboto, sans-serif';
const FONT_B = '600 11px system-ui, -apple-system, "Segoe UI", Roboto, sans-serif';
const C = {
  axis: '#2e3848', grid: 'rgba(215, 220, 229, 0.10)', text: '#a7b0bf', textHi: '#d7dce5', bg: '#0b0e14',
  blank: [86, 92, 104], pending: [16, 20, 28], accent: '#5aa9ff', best: '#ffffff', warm: '#f0b44c',
};

/** Matplotlib "viridis" sampled at 9 stops (perceptually uniform, dark = low). */
const VIRIDIS = [
  [68, 1, 84], [72, 40, 120], [62, 74, 137], [49, 104, 142], [38, 130, 142],
  [31, 158, 137], [53, 183, 121], [110, 206, 88], [253, 231, 37],
];

/** Viridis colour at t in [0, 1] as [r, g, b]. */
export function viridis(t) {
  const x = Math.min(1, Math.max(0, t)) * (VIRIDIS.length - 1);
  const i = Math.min(VIRIDIS.length - 2, Math.floor(x)), f = x - i;
  const a = VIRIDIS[i], b = VIRIDIS[i + 1];
  return [a[0] + (b[0] - a[0]) * f, a[1] + (b[1] - a[1]) * f, a[2] + (b[2] - a[2]) * f];
}
const rgb = (c) => `rgb(${c[0] | 0},${c[1] | 0},${c[2] | 0})`;

/**
 * Banded colour scale for finite values: bands of a "nice" step from just below the minimum up to `cap`
 * (cap = min + 1.5 x min, at least min + 2, at most min + 12, never above the maximum). Values above the cap share
 * the top colour.
 * @param {ArrayLike<number>} values
 * @returns {null|{base:number, step:number, nb:number, cap:number, min:number, max:number, band:(v:number)=>number, color:(b:number)=>number[]}}
 */
export function bandScale(values) {
  let min = Infinity, max = -Infinity;
  for (let k = 0; k < values.length; k++) { const v = values[k]; if (Number.isFinite(v)) { if (v < min) min = v; if (v > max) max = v; } }
  if (!Number.isFinite(min)) return null;
  let cap = Math.min(max, min + Math.min(12, Math.max(2, 1.5 * min)));
  if (!(cap > min)) cap = min + 1;
  const range = cap - min;
  const steps = [0.01, 0.02, 0.025, 0.05, 0.1, 0.2, 0.25, 0.5, 1, 2, 2.5, 5, 10, 20, 25, 50, 100];
  let step = steps[steps.length - 1];
  for (const s of steps) if (range / s <= 16) { step = s; break; }
  const base = Math.floor(min / step) * step;
  const nb = Math.max(1, Math.ceil((cap - base) / step - 1e-9));
  cap = base + nb * step;
  const colors = [];
  for (let b = 0; b <= nb; b++) colors.push(viridis(nb <= 1 ? b : b / nb));
  return {
    base, step, nb, cap, min, max,
    band: (v) => (v >= cap ? nb : Math.max(0, Math.floor((v - base) / step))),
    color: (b) => colors[Math.min(nb, Math.max(0, b))],
  };
}

/** Calendar month ticks between two JDs (1/2/3/6/12/24/60-month steps, at most `maxTicks`). */
export function monthTicks(jd0, jd1, maxTicks = 10) {
  const c0 = jdToCivil(jd0);
  for (const step of [1, 2, 3, 6, 12, 24, 60]) {
    const ticks = [];
    let y = c0.year, m = c0.month;
    // align to a multiple of the step (months counted from January)
    let idx = y * 12 + (m - 1);
    idx = Math.ceil(idx / step) * step;
    for (let k = 0; k < 400; k++) {
      y = Math.floor(idx / 12); m = (idx % 12) + 1;
      const jd = civilToJd(y, m, 1);
      if (jd > jd1) break;
      if (jd >= jd0) ticks.push({ jd, year: y, month: m, major: m === 1, label: m === 1 || step >= 12 ? String(y) : MONTHS[m - 1] });
      idx += step;
    }
    if (ticks.length <= maxTicks) return ticks;
  }
  return [];
}

/** "Nice" numeric ticks covering [lo, hi]. */
export function niceTicks(lo, hi, maxTicks = 6) {
  const span = hi - lo;
  if (!(span > 0)) return [lo];
  const raw = span / Math.max(1, maxTicks);
  const p = Math.pow(10, Math.floor(Math.log10(raw)));
  const step = [1, 2, 2.5, 5, 10].map((m) => m * p).find((s) => span / s <= maxTicks) ?? 10 * p;
  const out = [];
  for (let v = Math.ceil(lo / step - 1e-9) * step; v <= hi + 1e-9; v += step) out.push(+v.toPrecision(12));
  return out;
}

const fmtTick = (v) => (Math.abs(v) >= 100 || Number.isInteger(v) ? String(Math.round(v)) : String(+v.toPrecision(3)));

/** Canvas sized to its container (CSS px) at the device pixel ratio; calls draw() on resize. */
function hiDpiCanvas(host, cssHeight, draw) {
  const canvas = document.createElement('canvas');
  canvas.className = 'pc-canvas';
  canvas.style.height = `${cssHeight}px`;
  host.appendChild(canvas);
  const g = canvas.getContext('2d');
  const size = { w: 0, h: cssHeight, dpr: 1 };
  function fit() {
    const w = Math.max(240, Math.floor(host.clientWidth || 600));
    const dpr = Math.min(2, window.devicePixelRatio || 1);
    if (w === size.w && dpr === size.dpr && canvas.width) return false;
    size.w = w; size.dpr = dpr;
    canvas.width = Math.round(w * dpr); canvas.height = Math.round(cssHeight * dpr);
    canvas.style.width = `${w}px`;
    return true;
  }
  const ro = typeof ResizeObserver === 'function' ? new ResizeObserver(() => { if (fit()) draw(true); }) : null;
  ro?.observe(host);
  fit();
  return { canvas, g, size, fit, destroy: () => ro?.disconnect() };
}

function label(g, text, x, y, { align = 'left', base = 'middle', color = C.text, font = FONT, box = null } = {}) {
  g.font = font;
  g.textAlign = align;
  g.textBaseline = base;
  if (box) {
    const w = g.measureText(text).width, padX = 5, hgt = 16;
    let bx = align === 'left' ? x - padX : align === 'right' ? x - w - padX : x - w / 2 - padX;
    const by = base === 'middle' ? y - hgt / 2 : base === 'top' ? y - 2 : y - hgt + 2;
    g.fillStyle = box;
    g.beginPath();
    g.roundRect ? g.roundRect(bx, by, w + 2 * padX, hgt, 4) : g.rect(bx, by, w + 2 * padX, hgt);
    g.fill();
  }
  g.fillStyle = color;
  g.fillText(text, x, y);
}

// ------------------------------------------------------------------ porkchop heatmap

/**
 * Porkchop heatmap. x = departure date (JD), y = flight time (days, increasing upwards).
 * @param {{height?:number, onHover?:(cell:{i:number,j:number}|null)=>void, onClick?:(cell:{i:number,j:number})=>void}} opts
 */
export function createPorkchopChart(opts = {}) {
  const el = document.createElement('div');
  el.className = 'pc-chart';
  const H = opts.height ?? 380;
  const M = { l: 52, r: 86, t: 12, b: 36 };
  /** @type {null|{dep:Float64Array, tof:Float64Array, nx:number, ny:number, values:Float64Array, colsDone:number, unit:string}} */
  let data = null;
  let scale = null;
  let heat = null; // offscreen canvas with the plot-area image
  let hover = null, selected = null, best = null, windows = [];
  const cv = hiDpiCanvas(el, H, (resized) => { if (resized) heat = null; draw(); });
  el.tabIndex = -1;

  const plot = () => ({ x: M.l, y: M.t, w: cv.size.w - M.l - M.r, h: H - M.t - M.b });
  const xOf = (jd) => { const p = plot(); return p.x + ((jd - data.dep[0]) / (data.dep[data.nx - 1] - data.dep[0])) * p.w; };
  const yOf = (T) => { const p = plot(); return p.y + p.h - ((T - data.tof[0]) / (data.tof[data.ny - 1] - data.tof[0])) * p.h; };

  function buildHeat() {
    const p = plot();
    const dpr = cv.size.dpr;
    const w = Math.max(1, Math.round(p.w * dpr)), h = Math.max(1, Math.round(p.h * dpr));
    heat = document.createElement('canvas');
    heat.width = w; heat.height = h;
    const hg = heat.getContext('2d');
    const img = hg.createImageData(w, h);
    const { values: v, nx, ny, colsDone } = data;
    const bands = new Int16Array(w * h);
    // pass 1: interpolated band index per pixel (-1 blank, -2 not computed yet)
    for (let py = 0; py < h; py++) {
      const fy = (1 - py / Math.max(1, h - 1)) * (ny - 1);
      const j0 = Math.min(ny - 2, Math.floor(fy)), ty = fy - j0;
      for (let px = 0; px < w; px++) {
        const fx = (px / Math.max(1, w - 1)) * (nx - 1);
        const i0 = Math.min(nx - 2, Math.floor(fx)), tx = fx - i0;
        const iN = tx < 0.5 ? i0 : i0 + 1, jN = ty < 0.5 ? j0 : j0 + 1;
        const o = py * w + px;
        if (iN >= colsDone) { bands[o] = -2; continue; }
        const a = v[i0 * ny + j0], c = v[i0 * ny + j0 + 1];
        let val;
        if (i0 + 1 < colsDone) {
          const b = v[(i0 + 1) * ny + j0], d = v[(i0 + 1) * ny + j0 + 1];
          if (Number.isFinite(a) && Number.isFinite(b) && Number.isFinite(c) && Number.isFinite(d)) {
            val = (a * (1 - tx) + b * tx) * (1 - ty) + (c * (1 - tx) + d * tx) * ty;
          } else val = v[iN * ny + jN];
        } else val = Number.isFinite(a) && Number.isFinite(c) ? a * (1 - ty) + c * ty : v[i0 * ny + jN];
        bands[o] = Number.isFinite(val) && scale ? scale.band(val) : -1;
      }
    }
    // pass 2: colours, darkened along band boundaries (contour-like lines)
    const px4 = img.data;
    for (let py = 0; py < h; py++) {
      for (let px = 0; px < w; px++) {
        const o = py * w + px, b = bands[o];
        let col;
        if (b === -2) col = C.pending;
        else if (b === -1) col = C.blank;
        else {
          col = scale.color(b);
          const r = px + 1 < w ? bands[o + 1] : b, dn = py + 1 < h ? bands[o + w] : b;
          if ((r >= 0 && r !== b) || (dn >= 0 && dn !== b)) col = [col[0] * 0.5, col[1] * 0.5, col[2] * 0.5];
        }
        const q = o * 4;
        px4[q] = col[0]; px4[q + 1] = col[1]; px4[q + 2] = col[2]; px4[q + 3] = 255;
      }
    }
    hg.putImageData(img, 0, 0);
  }

  function marker(g, x, y, kind) {
    g.save();
    if (kind === 'best') {
      g.lineWidth = 2.5; g.strokeStyle = '#000';
      g.beginPath(); g.arc(x, y, 7, 0, 2 * Math.PI); g.stroke();
      g.lineWidth = 1.6; g.strokeStyle = C.best;
      g.beginPath(); g.arc(x, y, 7, 0, 2 * Math.PI); g.stroke();
      g.fillStyle = C.best; g.beginPath(); g.arc(x, y, 2, 0, 2 * Math.PI); g.fill();
    } else if (kind === 'sel') {
      g.lineWidth = 3; g.strokeStyle = '#000'; g.strokeRect(x - 6, y - 6, 12, 12);
      g.lineWidth = 1.8; g.strokeStyle = C.accent; g.strokeRect(x - 6, y - 6, 12, 12);
    }
    g.restore();
  }

  function draw() {
    const g = cv.g, dpr = cv.size.dpr;
    g.setTransform(1, 0, 0, 1, 0, 0);
    g.clearRect(0, 0, cv.canvas.width, cv.canvas.height);
    g.setTransform(dpr, 0, 0, dpr, 0, 0);
    const p = plot();
    g.fillStyle = C.bg;
    g.fillRect(p.x, p.y, p.w, p.h);
    if (!data) {
      label(g, 'No plot yet', p.x + p.w / 2, p.y + p.h / 2, { align: 'center', color: C.text });
      return;
    }
    if (!heat) buildHeat();
    g.imageSmoothingEnabled = false;
    g.drawImage(heat, p.x, p.y, p.w, p.h);
    // axes and ticks
    g.strokeStyle = C.axis; g.lineWidth = 1;
    g.strokeRect(p.x + 0.5, p.y + 0.5, p.w - 1, p.h - 1);
    const jd0 = data.dep[0], jd1 = data.dep[data.nx - 1];
    for (const t of monthTicks(jd0, jd1, Math.max(4, Math.floor(p.w / 52)))) {
      const x = Math.round(xOf(t.jd)) + 0.5;
      g.strokeStyle = t.major ? 'rgba(255,255,255,0.28)' : C.grid;
      g.beginPath(); g.moveTo(x, p.y); g.lineTo(x, p.y + p.h); g.stroke();
      g.strokeStyle = C.axis; g.beginPath(); g.moveTo(x, p.y + p.h); g.lineTo(x, p.y + p.h + 4); g.stroke();
      label(g, t.label, x, p.y + p.h + 7, { align: 'center', base: 'top', color: t.major ? C.textHi : C.text, font: t.major ? FONT_B : FONT });
    }
    label(g, 'Departure date (UTC)', p.x + p.w / 2, H - 2, { align: 'center', base: 'bottom', color: C.text });
    for (const T of niceTicks(data.tof[0], data.tof[data.ny - 1], Math.max(3, Math.floor(p.h / 44)))) {
      const y = Math.round(yOf(T)) + 0.5;
      g.strokeStyle = C.grid; g.beginPath(); g.moveTo(p.x, y); g.lineTo(p.x + p.w, y); g.stroke();
      g.strokeStyle = C.axis; g.beginPath(); g.moveTo(p.x - 4, y); g.lineTo(p.x, y); g.stroke();
      label(g, `${fmtTick(T)} d`, p.x - 7, y, { align: 'right' });
    }
    g.save();
    g.translate(12, p.y + p.h / 2); g.rotate(-Math.PI / 2);
    label(g, 'Flight time', 0, 0, { align: 'center', color: C.text });
    g.restore();
    drawLegend(g, p);
    // window markers (numbered; nudged aside when they would sit under the "best" marker)
    windows.forEach((w, n) => {
      let x = xOf(w.t), y = yOf(w.T);
      if (best && Math.hypot(x - xOf(best.t), y - yOf(best.T)) < 14) { x -= 13; y += 13; }
      g.save();
      g.fillStyle = 'rgba(0,0,0,0.65)'; g.beginPath(); g.arc(x, y, 7.5, 0, 2 * Math.PI); g.fill();
      g.strokeStyle = C.warm; g.lineWidth = 1.4; g.stroke();
      g.restore();
      label(g, String(n + 1), x, y + 0.5, { align: 'center', color: '#ffe2ad', font: FONT_B });
    });
    // hover crosshair
    if (hover) {
      const x = xOf(data.dep[hover.i]), y = yOf(data.tof[hover.j]);
      g.save();
      g.strokeStyle = 'rgba(255,255,255,0.55)'; g.setLineDash([3, 3]); g.lineWidth = 1;
      g.beginPath(); g.moveTo(x, p.y); g.lineTo(x, p.y + p.h); g.moveTo(p.x, y); g.lineTo(p.x + p.w, y); g.stroke();
      g.restore();
    }
    if (selected) marker(g, xOf(selected.t), yOf(selected.T), 'sel');
    if (best) {
      const x = xOf(best.t), y = yOf(best.T);
      marker(g, x, y, 'best');
      g.font = FONT_B;
      const tw = g.measureText(best.text).width;
      let lx = x + 12, align = 'left';
      if (lx + tw + 8 > p.x + p.w) { lx = x - 12; align = 'right'; }
      const ly = Math.min(p.y + p.h - 12, Math.max(p.y + 12, y - 14));
      label(g, best.text, lx, ly, { align, color: '#fff', font: FONT_B, box: 'rgba(8,10,14,0.82)' });
    }
  }

  function drawLegend(g, p) {
    const x = p.x + p.w + 14, w = 14, y0 = p.y + 4, h = p.h - 40;
    label(g, data.unit, x, p.y - 1 + 4, { base: 'bottom', color: C.text });
    if (scale) {
      const nb = scale.nb;
      const bh = h / (nb + 1); // top segment = "above the cap"
      for (let b = 0; b <= nb; b++) {
        const yb = y0 + h - (b + 1) * bh;
        g.fillStyle = rgb(scale.color(b));
        g.fillRect(x, yb, w, bh + 0.5);
      }
      g.strokeStyle = C.axis; g.strokeRect(x + 0.5, y0 + 0.5, w - 1, h - 1);
      const every = nb > 10 ? Math.ceil(nb / 8) : 1;
      for (let b = 0; b < nb; b += every) { // the cap itself is labelled "≥ cap" on the top segment
        const yb = y0 + h - b * bh;
        g.strokeStyle = C.text; g.beginPath(); g.moveTo(x + w, yb); g.lineTo(x + w + 3, yb); g.stroke();
        label(g, fmtTick(scale.base + b * scale.step), x + w + 5, yb, { color: C.text });
      }
      label(g, `≥ ${fmtTick(scale.cap)}`, x + w + 5, y0 + bh / 2 + 1, { color: C.text });
    }
    const yb = y0 + h + 10;
    g.fillStyle = rgb(C.blank); g.fillRect(x, yb, w, 10);
    label(g, 'none', x + w + 5, yb + 5, { color: C.text });
  }

  function cellAt(ev) {
    if (!data) return null;
    const r = cv.canvas.getBoundingClientRect(), p = plot();
    const x = ev.clientX - r.left, y = ev.clientY - r.top;
    if (x < p.x || x > p.x + p.w || y < p.y || y > p.y + p.h) return null;
    const i = Math.round(((x - p.x) / p.w) * (data.nx - 1));
    const j = Math.round((1 - (y - p.y) / p.h) * (data.ny - 1));
    if (i >= data.colsDone) return null;
    return { i: Math.min(data.nx - 1, Math.max(0, i)), j: Math.min(data.ny - 1, Math.max(0, j)) };
  }
  cv.canvas.addEventListener('mousemove', (ev) => {
    const c = cellAt(ev);
    if ((c?.i ?? -1) === (hover?.i ?? -1) && (c?.j ?? -1) === (hover?.j ?? -1)) return;
    hover = c;
    cv.canvas.style.cursor = c ? 'crosshair' : 'default';
    draw();
    opts.onHover?.(c);
  });
  cv.canvas.addEventListener('mouseleave', () => { if (hover) { hover = null; draw(); opts.onHover?.(null); } });
  cv.canvas.addEventListener('click', (ev) => { const c = cellAt(ev); if (c) opts.onClick?.(c); });

  return {
    el,
    /**
     * @param {null|{dep:Float64Array, tof:Float64Array, nx:number, ny:number, values:Float64Array, colsDone:number, unit:string}} d
     * @param {{keepScale?:boolean}} [o] keep the colour scale (progressive updates while computing)
     */
    setData(d, o = {}) {
      data = d;
      if (!d) scale = null;
      else if (!o.keepScale || !scale) scale = bandScale(d.values);
      heat = null;
      if (hover && (!d || hover.i >= d.colsDone || hover.i >= d.nx || hover.j >= d.ny)) hover = null;
      draw();
      opts.onHover?.(hover); // the numbers under a resting pointer changed
    },
    /** Re-derive the colour scale from the current values. */
    rescale() { if (data) { scale = bandScale(data.values); heat = null; draw(); } },
    /** @param {null|{t:number, T:number, text:string}} b */
    setBest(b) { best = b; draw(); },
    /** @param {{t:number, T:number}[]} list */
    setWindows(list) { windows = list || []; draw(); },
    /** @param {null|{t:number, T:number}} s */
    setSelected(s) { selected = s; draw(); },
    get scale() { return scale; },
    destroy() { cv.destroy(); },
  };
}

// ------------------------------------------------------------------ line chart (torch ships)

/**
 * Line chart over departure date with a left and an optional right axis.
 * series: [{ values:number[] (NaN = gap), color, axis:'left'|'right', dash?:number[], label, unit }]
 * @param {{height?:number, onHover?:(k:number|null)=>void, onClick?:(k:number)=>void}} opts
 */
export function createLineChart(opts = {}) {
  const el = document.createElement('div');
  el.className = 'pc-chart pc-line';
  const H = opts.height ?? 220;
  const M = { l: 52, r: 62, t: 14, b: 36 };
  let data = null; // { xs:number[], series:[], done:number }
  let hover = null, selected = null;
  const cv = hiDpiCanvas(el, H, () => draw());
  const plot = () => ({ x: M.l, y: M.t, w: cv.size.w - M.l - M.r, h: H - M.t - M.b });
  const ranges = { left: [0, 1], right: [0, 1] };

  function axisRange(axis) {
    let hi = -Infinity;
    for (const s of data.series) if ((s.axis ?? 'left') === axis) for (const v of s.values) if (Number.isFinite(v) && v > hi) hi = v;
    if (!Number.isFinite(hi) || hi <= 0) return [0, 1];
    const t = niceTicks(0, hi * 1.12, 5);
    return [0, Math.max(t[t.length - 1], hi * 1.05)];
  }
  const xOf = (jd) => { const p = plot(); const x0 = data.xs[0], x1 = data.xs[data.xs.length - 1]; return p.x + (x1 > x0 ? (jd - x0) / (x1 - x0) : 0.5) * p.w; };
  const yOf = (v, axis) => { const p = plot(); const [lo, hi] = ranges[axis]; return p.y + p.h - ((v - lo) / (hi - lo)) * p.h; };

  function draw() {
    const g = cv.g, dpr = cv.size.dpr;
    g.setTransform(1, 0, 0, 1, 0, 0);
    g.clearRect(0, 0, cv.canvas.width, cv.canvas.height);
    g.setTransform(dpr, 0, 0, dpr, 0, 0);
    const p = plot();
    g.fillStyle = C.bg; g.fillRect(p.x, p.y, p.w, p.h);
    g.strokeStyle = C.axis; g.strokeRect(p.x + 0.5, p.y + 0.5, p.w - 1, p.h - 1);
    if (!data || data.xs.length < 2) { label(g, 'No curve yet', p.x + p.w / 2, p.y + p.h / 2, { align: 'center' }); return; }
    ranges.left = axisRange('left');
    ranges.right = axisRange('right');
    for (const t of monthTicks(data.xs[0], data.xs[data.xs.length - 1], Math.max(4, Math.floor(p.w / 52)))) {
      const x = Math.round(xOf(t.jd)) + 0.5;
      g.strokeStyle = t.major ? 'rgba(255,255,255,0.22)' : C.grid;
      g.beginPath(); g.moveTo(x, p.y); g.lineTo(x, p.y + p.h); g.stroke();
      label(g, t.label, x, p.y + p.h + 7, { align: 'center', base: 'top', color: t.major ? C.textHi : C.text, font: t.major ? FONT_B : FONT });
    }
    label(g, 'Departure date (UTC)', p.x + p.w / 2, H - 2, { align: 'center', base: 'bottom' });
    const left = data.series.find((s) => (s.axis ?? 'left') === 'left');
    const right = data.series.find((s) => s.axis === 'right');
    for (const v of niceTicks(ranges.left[0], ranges.left[1], 5)) {
      const y = Math.round(yOf(v, 'left')) + 0.5;
      g.strokeStyle = C.grid; g.beginPath(); g.moveTo(p.x, y); g.lineTo(p.x + p.w, y); g.stroke();
      label(g, `${fmtTick(v)}${left?.unit ? ' ' + left.unit : ''}`, p.x - 6, y, { align: 'right', color: left?.color ?? C.text });
    }
    if (right) {
      for (const v of niceTicks(ranges.right[0], ranges.right[1], 5)) {
        const y = Math.round(yOf(v, 'right')) + 0.5;
        label(g, fmtTick(v), p.x + p.w + 6, y, { color: right.color });
      }
      label(g, right.unit ?? '', p.x + p.w + 6, p.y - 6, { color: right.color });
    }
    for (const s of data.series) {
      const axis = s.axis ?? 'left';
      g.save();
      g.strokeStyle = s.color; g.lineWidth = s.width ?? 1.8; g.setLineDash(s.dash ?? []);
      g.beginPath();
      let pen = false;
      for (let k = 0; k < data.done; k++) {
        const v = s.values[k];
        if (!Number.isFinite(v)) { pen = false; continue; }
        const x = xOf(data.xs[k]), y = yOf(v, axis);
        if (pen) g.lineTo(x, y); else g.moveTo(x, y);
        pen = true;
      }
      g.stroke();
      g.restore();
    }
    const mark = (k, color, r) => {
      const x = xOf(data.xs[k]);
      g.save();
      g.strokeStyle = color; g.globalAlpha = 0.6; g.setLineDash([3, 3]);
      g.beginPath(); g.moveTo(x, p.y); g.lineTo(x, p.y + p.h); g.stroke();
      g.restore();
      for (const s of data.series) {
        const v = s.values[k];
        if (!Number.isFinite(v)) continue;
        g.fillStyle = s.color; g.strokeStyle = '#000'; g.lineWidth = 1.5;
        g.beginPath(); g.arc(x, yOf(v, s.axis ?? 'left'), r, 0, 2 * Math.PI); g.fill(); g.stroke();
      }
    };
    if (selected != null && selected < data.done) mark(selected, C.accent, 5);
    if (hover != null) mark(hover, 'rgba(255,255,255,0.8)', 3.5);
    // legend (bottom-left: the curves start at zero-based axes, so the bottom of the plot is usually empty)
    let lx = p.x + 8;
    const ly = p.y + p.h - 12;
    for (const s of data.series) {
      g.font = FONT;
      const tw = g.measureText(s.label).width;
      g.fillStyle = 'rgba(8,10,14,0.75)'; g.fillRect(lx - 4, ly - 8, tw + 30, 16);
      g.save(); g.strokeStyle = s.color; g.lineWidth = 2; g.setLineDash(s.dash ?? []);
      g.beginPath(); g.moveTo(lx, ly); g.lineTo(lx + 18, ly); g.stroke(); g.restore();
      label(g, s.label, lx + 22, ly, { color: C.textHi });
      lx += tw + 40;
    }
  }

  function indexAt(ev) {
    if (!data || data.done < 1) return null;
    const r = cv.canvas.getBoundingClientRect(), p = plot();
    const x = ev.clientX - r.left, y = ev.clientY - r.top;
    if (x < p.x - 4 || x > p.x + p.w + 4 || y < p.y || y > p.y + p.h) return null;
    const x0 = data.xs[0], x1 = data.xs[data.xs.length - 1];
    const jd = x0 + ((x - p.x) / p.w) * (x1 - x0);
    let best = 0;
    for (let k = 1; k < data.done; k++) if (Math.abs(data.xs[k] - jd) < Math.abs(data.xs[best] - jd)) best = k;
    return best;
  }
  cv.canvas.addEventListener('mousemove', (ev) => {
    const k = indexAt(ev);
    if (k === hover) return;
    hover = k;
    cv.canvas.style.cursor = k != null ? 'crosshair' : 'default';
    draw();
    opts.onHover?.(k);
  });
  cv.canvas.addEventListener('mouseleave', () => { if (hover != null) { hover = null; draw(); opts.onHover?.(null); } });
  cv.canvas.addEventListener('click', (ev) => { const k = indexAt(ev); if (k != null) opts.onClick?.(k); });

  return {
    el,
    /** @param {null|{xs:number[], series:Object[], done:number}} d */
    setData(d) { data = d; if (hover != null && (!d || hover >= d.done)) hover = null; draw(); opts.onHover?.(hover); },
    setSelected(k) { selected = k; draw(); },
    destroy() { cv.destroy(); },
  };
}
