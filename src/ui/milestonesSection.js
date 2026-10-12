// "Derived milestones" section for the Events dialog: a read-only list of the milestones derived from the routes
// (src/sim/milestones.js) with a Jump button per row. They are not story events and are never saved.
import { store } from '../sim/store.js';
import { formatJd } from '../astro/time.js';
import { getMilestones, onMilestonesChange, MILESTONE_KINDS } from '../sim/milestones.js';
import { esc } from './format.js';
import { h } from './modal.js';

/**
 * Append the section to a dialog body. It keeps itself up to date while attached and unsubscribes once removed.
 * @param {HTMLElement} parent
 * @param {Object} app application facade (toast)
 * @returns {HTMLElement}
 */
export function appendMilestonesSection(parent, app) {
  const el = h(`<details class="ms-section" open>
    <summary><span class="section-title">Derived milestones</span> <span class="muted small" data-f="count"></span></summary>
    <p class="muted small">Computed from the objects' routes (departures, flips, flybys, close approaches inside 2 SOI radii, impacts,
      arrivals). They update when a route changes, are shown as hollow ticks under the story events on the timeline, and are
      not saved with the scenario.</p>
    <div data-f="list"></div></details>`);
  const listEl = el.querySelector('[data-f=list]');
  const countEl = el.querySelector('[data-f=count]');
  let rows = [];

  function render() {
    rows = getMilestones();
    countEl.textContent = `(${rows.length})`;
    if (!rows.length) { listEl.innerHTML = '<p class="muted">No routes, so no milestones. Give an object a route to see its departures, flips and arrivals here.</p>'; return; }
    const now = store.get().jd;
    let html = '<table class="events-table ms-table"><thead><tr><th></th><th>Date (UTC)</th><th>Milestone</th><th>Details</th><th></th></tr></thead><tbody>';
    rows.forEach((m, i) => {
      html += `<tr class="${m.jd < now ? 'past' : ''}${m.kind === 'impact' ? ' impact' : ''}">
        <td><span class="tl-ms-swatch" data-kind="${m.kind}" style="--c:${esc(m.color)}" title="${esc(MILESTONE_KINDS[m.kind] ?? m.kind)}"></span></td>
        <td class="mono nowrap">${formatJd(m.jd)}</td><td>${esc(m.title)}</td><td class="muted">${esc(m.detail)}</td>
        <td class="row-btns"><button class="btn small" data-jump="${i}">Jump</button></td></tr>`;
    });
    listEl.innerHTML = html + '</tbody></table>';
  }

  listEl.addEventListener('click', (ev) => {
    const b = ev.target.closest('[data-jump]');
    const m = b && rows[Number(b.dataset.jump)];
    if (!m) return;
    store.set({ jd: m.jd });
    app.toast(`Jumped to “${m.title}”`);
  });

  const unsub = onMilestonesChange(() => {
    if (!el.isConnected) { unsub(); return; }
    render();
  });
  render();
  parent.appendChild(el);
  return el;
}
