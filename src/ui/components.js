// Reusable form widgets: searchable object picker.
import { store } from '../sim/store.js';
import { allBodies, getBody } from '../sim/ephemeris.js';
import { TYPE_GLYPHS } from '../sim/custom.js';
import { esc } from './format.js';

const GROUPS = [
  ['star', 'Sun'], ['planet', 'Planets'], ['moon', 'Moons'], ['dwarf', 'Dwarf planets'], ['asteroid', 'Asteroids'],
  ['trojan', 'Jupiter trojans'], ['neo', 'Near-Earth objects'], ['centaur', 'Centaurs'], ['comet', 'Comets'],
];

export const FIXED_REF = '__fixed__';

/**
 * Searchable select of natural bodies and (optionally) custom objects.
 * @param {{ value?:string|null, includeCustom?:boolean, excludeId?:string|null, allowFixed?:boolean,
 *           types?:string[], onChange?:(id:string)=>void, ariaLabel?:string }} o
 */
export function refPicker(o = {}) {
  const el = document.createElement('div');
  el.className = 'ref-picker';
  el.innerHTML = `<input class="ref-filter" type="search" placeholder="Filter…" aria-label="Filter list" spellcheck="false"><select ${o.ariaLabel ? `aria-label="${esc(o.ariaLabel)}"` : ''}></select>`;
  const filter = el.querySelector('input');
  const select = el.querySelector('select');
  let value = o.value ?? null;

  function options(q) {
    q = q.trim().toLowerCase();
    const match = (name) => !q || name.toLowerCase().includes(q);
    let html = '';
    if (o.allowFixed && (!q || 'fixed point'.includes(q))) html += `<option value="${FIXED_REF}">Fixed point (x, y, z)…</option>`;
    if (o.includeCustom !== false) {
      const objs = store.get().objects.filter((x) => x.id !== o.excludeId && match(x.name));
      if (objs.length) html += `<optgroup label="Custom objects">${objs.map((x) => `<option value="${esc(x.id)}">${TYPE_GLYPHS[x.type] ?? ''} ${esc(x.name)}</option>`).join('')}</optgroup>`;
    }
    const bodies = allBodies();
    for (const [type, label] of GROUPS) {
      if (o.types && !o.types.includes(type)) continue;
      const list = bodies.filter((b) => b.type === type && match(b.name));
      if (!list.length) continue;
      html += `<optgroup label="${label}">${list.map((b) => `<option value="${b.id}">${esc(b.name)}${b.type === 'moon' ? ` (${esc(getBody(b.parent)?.name ?? '')})` : ''}</option>`).join('')}</optgroup>`;
    }
    return html;
  }

  function render(q = '') {
    select.innerHTML = options(q) || '<option value="" disabled>No matches</option>';
    if (value != null && [...select.options].some((op) => op.value === value)) select.value = value;
    else if (q && select.options.length && select.options[0].value) {
      select.selectedIndex = 0;
      if (select.value !== value) { value = select.value; o.onChange?.(value); }
    } else if (value == null && select.options.length) {
      select.selectedIndex = -1;
    }
  }
  render();
  filter.addEventListener('input', () => render(filter.value));
  select.addEventListener('change', () => { value = select.value; o.onChange?.(value); });
  return {
    el,
    get value() { return value; },
    set value(v) { value = v; render(filter.value); },
  };
}
