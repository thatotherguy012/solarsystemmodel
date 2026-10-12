// Story events editor: list sorted by date with add/edit/delete and "Jump". §8.
import { formatJd, parseDateToJd } from '../../astro/time.js';
import { store, upsertEvent, deleteEvent, newId } from '../../sim/store.js';
import { openModal, h } from '../modal.js';
import { esc } from '../format.js';

const COLORS = ['#ffcc66', '#ff8a3d', '#ff6b6b', '#e8d44d', '#4fd18b', '#5aa9ff', '#b48cff', '#cfd6e0'];

/**
 * @param {Object} app
 * @param {{editId?:string}} [opts] open with this event's row in edit mode
 */
export function openEvents(app, opts = {}) {
  let editing = opts.editId ?? null;
  const body = h('<div class="events-editor"><div data-f="list"></div></div>');
  const foot = h(`<div class="btn-row">
    <button class="btn" data-a="add">＋ Add event at current time</button><span class="spacer"></span>
    <button class="btn primary" data-a="close">Done</button></div>`);
  const modal = openModal({ title: 'Story events', body, footer: foot, wide: true, onClose: () => unsub() });
  const list = body.querySelector('[data-f=list]');

  function render() {
    const evs = store.get().events;
    if (!evs.length) { list.innerHTML = '<p class="muted">No events yet. Events appear as coloured ticks on the timeline in the bottom bar.</p>'; return; }
    let html = '<table class="events-table"><thead><tr><th></th><th>Date (UTC)</th><th>Title</th><th>Notes</th><th></th></tr></thead><tbody>';
    for (const e of evs) {
      if (e.id === editing) {
        html += `<tr class="editing" data-id="${esc(e.id)}">
          <td><select data-e="color" aria-label="Colour">${COLORS.map((c) => `<option value="${c}" ${c === e.color ? 'selected' : ''} style="background:${c}">${c}</option>`).join('')}</select></td>
          <td><input data-e="date" class="mono" value="${esc(formatJd(e.jd).replace(' UTC', ''))}" aria-label="Date"></td>
          <td><input data-e="title" value="${esc(e.title)}" aria-label="Title"></td>
          <td><textarea data-e="notes" rows="2" aria-label="Notes">${esc(e.notes)}</textarea></td>
          <td class="row-btns"><button class="btn small primary" data-a="save">Save</button><button class="btn small" data-a="cancel">Cancel</button></td></tr>`;
      } else {
        html += `<tr data-id="${esc(e.id)}">
          <td><span class="dot" style="background:${esc(e.color)}"></span></td>
          <td class="mono nowrap">${formatJd(e.jd)}</td><td>${esc(e.title)}</td><td class="muted">${esc(e.notes)}</td>
          <td class="row-btns nowrap"><button class="btn small" data-a="jump">Jump</button><button class="icon-btn small" data-a="edit" title="Edit">✎</button><button class="icon-btn small" data-a="del" title="Delete">🗑</button></td></tr>`;
      }
    }
    list.innerHTML = html + '</tbody></table>';
    list.querySelector('tr.editing [data-e=title]')?.focus();
  }

  list.addEventListener('click', (ev) => {
    const a = ev.target.closest('[data-a]')?.dataset.a;
    const tr = ev.target.closest('tr[data-id]');
    if (!a || !tr) return;
    const e = store.get().events.find((x) => x.id === tr.dataset.id);
    if (!e) return;
    if (a === 'jump') { store.set({ jd: e.jd }); app.toast(`Jumped to “${e.title}”`); }
    else if (a === 'edit') { editing = e.id; render(); }
    else if (a === 'cancel') { editing = null; render(); }
    else if (a === 'del') { deleteEvent(e.id); app.toast('Event deleted'); }
    else if (a === 'save') {
      const jd = parseDateToJd(tr.querySelector('[data-e=date]').value);
      if (!Number.isFinite(jd)) { tr.querySelector('[data-e=date]').classList.add('invalid'); app.toast('Invalid date', 'error'); return; }
      editing = null;
      upsertEvent({ ...e, jd, title: tr.querySelector('[data-e=title]').value.trim() || 'Event', notes: tr.querySelector('[data-e=notes]').value, color: tr.querySelector('[data-e=color]').value });
      app.toast('Event saved', 'success');
    }
  });
  list.addEventListener('keydown', (ev) => {
    if (ev.key === 'Enter' && ev.target.matches('input[data-e]')) list.querySelector('tr.editing [data-a=save]')?.click();
  });

  foot.querySelector('[data-a=add]').addEventListener('click', () => {
    const s = store.get();
    const e = { id: newId(), jd: s.jd, title: `Event ${s.events.length + 1}`, notes: '', color: COLORS[s.events.length % COLORS.length] };
    editing = e.id;
    upsertEvent(e);
  });
  foot.querySelector('[data-a=close]').addEventListener('click', () => modal.close());
  const unsub = store.subscribe((_s, changed) => { if (changed.includes('events')) render(); });
  render();
}
