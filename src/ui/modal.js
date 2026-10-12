// Minimal modal dialog helper built on <dialog>. Esc closes (native), clicking the backdrop closes.

let openCount = 0;

/**
 * Open a modal dialog.
 * @param {{ title:string, body:HTMLElement|string, footer?:HTMLElement, wide?:boolean, className?:string, onClose?:()=>void }} o
 * @returns {{ dialog:HTMLDialogElement, close:()=>void, body:HTMLElement, footer:HTMLElement }}
 */
export function openModal(o) {
  const dialog = document.createElement('dialog');
  dialog.className = `modal${o.wide ? ' wide' : ''}${o.className ? ' ' + o.className : ''}`;
  dialog.innerHTML = `
    <div class="modal-head"><h2></h2><button class="icon-btn modal-x" title="Close (Esc)" aria-label="Close">✕</button></div>
    <div class="modal-body"></div>
    <div class="modal-foot"></div>`;
  dialog.querySelector('h2').textContent = o.title;
  const body = dialog.querySelector('.modal-body');
  const footer = dialog.querySelector('.modal-foot');
  if (typeof o.body === 'string') body.innerHTML = o.body; else if (o.body) body.appendChild(o.body);
  if (o.footer) footer.appendChild(o.footer); else footer.remove();
  document.body.appendChild(dialog);
  let closed = false;
  const close = () => {
    if (closed) return;
    closed = true;
    openCount--;
    if (dialog.open) dialog.close();
    dialog.remove();
    o.onClose?.();
  };
  dialog.addEventListener('close', close);
  dialog.addEventListener('cancel', (ev) => { ev.preventDefault(); close(); });
  dialog.querySelector('.modal-x').addEventListener('click', close);
  dialog.addEventListener('mousedown', (ev) => {
    if (ev.target === dialog) {
      const r = dialog.getBoundingClientRect();
      const inside = ev.clientX >= r.left && ev.clientX <= r.right && ev.clientY >= r.top && ev.clientY <= r.bottom;
      if (!inside) close();
    }
  });
  openCount++;
  dialog.showModal();
  return { dialog, close, body, footer };
}

/** True while any modal is open. */
export const modalOpen = () => openCount > 0;

/**
 * Promise-based confirm dialog.
 * @param {string} title
 * @param {string} message
 * @param {string} [okLabel]
 * @returns {Promise<boolean>}
 */
export function confirmModal(title, message, okLabel = 'OK') {
  return new Promise((resolve) => {
    const foot = document.createElement('div');
    foot.className = 'btn-row';
    foot.innerHTML = `<button class="btn" data-a="cancel">Cancel</button><button class="btn danger" data-a="ok"></button>`;
    foot.querySelector('[data-a=ok]').textContent = okLabel;
    const p = document.createElement('p');
    p.textContent = message;
    let result = false;
    const m = openModal({ title, body: p, footer: foot, onClose: () => resolve(result) });
    foot.querySelector('[data-a=cancel]').addEventListener('click', () => m.close());
    foot.querySelector('[data-a=ok]').addEventListener('click', () => { result = true; m.close(); });
    foot.querySelector('[data-a=ok]').focus();
  });
}

/** Create an element from an HTML string (single root). */
export function h(html) {
  const t = document.createElement('template');
  t.innerHTML = html.trim();
  return t.content.firstElementChild;
}
