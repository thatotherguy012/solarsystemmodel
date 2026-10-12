// Collapsible side panels: the object browser (left) and the inspector (right) each collapse to a ~28 px strip
// with an expand chevron; the 3D canvas resizes to fill (its ResizeObserver follows the grid). The state lives in
// the store (persisted in the scenario view). Keyboard: O = object list, I = inspector.
import { store } from '../sim/store.js';
import { modalOpen } from './modal.js';

/** @param {Object} app */
export function initPanels(app) {
  const $ = (id) => document.getElementById(id);
  const appEl = $('app');
  const panels = [
    { key: 'sidebarCollapsed', cls: 'left-collapsed', collapse: $('collapse-left'), expand: $('expand-left'), body: $('object-list') },
    { key: 'inspectorCollapsed', cls: 'right-collapsed', collapse: $('collapse-right'), expand: $('expand-right'), body: $('inspector-body') },
  ];

  function apply() {
    const s = store.get();
    for (const p of panels) {
      const c = !!s[p.key];
      appEl.classList.toggle(p.cls, c);
      p.expand.hidden = !c;
      p.collapse.setAttribute('aria-expanded', String(!c));
      p.body.toggleAttribute('inert', c);
    }
  }

  const toggle = (key, value) => {
    const v = value ?? !store.get()[key];
    store.set({ [key]: v });
    // keep keyboard focus on the visible control of that panel
    const p = panels.find((x) => x.key === key);
    if (document.activeElement === p.collapse || document.activeElement === p.expand) (v ? p.expand : p.collapse).focus();
  };

  for (const p of panels) {
    p.collapse.addEventListener('click', () => toggle(p.key, true));
    p.expand.addEventListener('click', () => toggle(p.key, false));
  }

  document.addEventListener('keydown', (ev) => {
    if (ev.ctrlKey || ev.metaKey || ev.altKey) return;
    const t = ev.target;
    const typing = t instanceof HTMLElement && (t.isContentEditable || /^(INPUT|TEXTAREA|SELECT)$/.test(t.tagName));
    if (typing || modalOpen()) return;
    if (ev.key === 'i' || ev.key === 'I') { ev.preventDefault(); toggle('inspectorCollapsed'); }
    else if (ev.key === 'o' || ev.key === 'O') { ev.preventDefault(); toggle('sidebarCollapsed'); }
  });

  store.subscribe((_s, changed) => {
    if (changed.includes('sidebarCollapsed') || changed.includes('inspectorCollapsed')) apply();
  });
  apply();
  // animate collapse/expand only after the initial layout (no slide-in on page load)
  requestAnimationFrame(() => requestAnimationFrame(() => appEl.classList.add('anim-ready')));

  return { toggle };
}
