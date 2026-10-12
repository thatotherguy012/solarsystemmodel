// Transient notifications (bottom-centre, auto-dismiss), optionally with one action button (e.g. Undo).

/**
 * Show a toast.
 * @param {string} message
 * @param {'info'|'success'|'error'} [kind]
 * @param {number} [ms] display time
 * @param {{label:string, onClick:()=>void}} [action] a button in the toast (the toast closes when it is clicked)
 * @returns {{close:()=>void}}
 */
export function toast(message, kind = 'info', ms = 3200, action = null) {
  const host = document.getElementById('toasts');
  if (!host) return { close() {} };
  const el = document.createElement('div');
  el.className = `toast toast-${kind}`;
  el.setAttribute('role', kind === 'error' ? 'alert' : 'status');
  const text = document.createElement('span');
  text.textContent = message;
  el.appendChild(text);
  let timer = null;
  const close = () => {
    clearTimeout(timer);
    el.classList.remove('show');
    setTimeout(() => el.remove(), 300);
  };
  if (action) {
    const b = document.createElement('button');
    b.className = 'toast-action';
    b.textContent = action.label;
    b.title = action.title ?? action.label;
    b.addEventListener('click', () => { action.onClick(); close(); });
    el.appendChild(b);
    el.classList.add('has-action');
  }
  host.appendChild(el);
  requestAnimationFrame(() => el.classList.add('show'));
  timer = setTimeout(close, ms);
  // keep a toast with an action open while the pointer is on it
  el.addEventListener('pointerenter', () => clearTimeout(timer));
  el.addEventListener('pointerleave', () => { clearTimeout(timer); timer = setTimeout(close, 2000); });
  return { close };
}
