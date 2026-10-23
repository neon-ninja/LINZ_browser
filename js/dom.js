export const $ = (id) => document.getElementById(id);

/** Small DOM builder: el('a', { href, class: 'x', onclick }, 'text', child). */
export function el(tag, attrs = {}, ...children) {
  const node = document.createElement(tag);
  for (const [key, value] of Object.entries(attrs)) {
    if (value === undefined || value === null || value === false) continue;
    if (key === 'class') node.className = value;
    else if (key.startsWith('on')) node.addEventListener(key.slice(2), value);
    else if (key === 'value') node.value = value;
    else node.setAttribute(key, value === true ? '' : value);
  }
  for (const child of children.flat()) {
    if (child !== null && child !== undefined && child !== false) node.append(child);
  }
  return node;
}

const SVG_NS = 'http://www.w3.org/2000/svg';

/** A 16×16 icon (e.g. an Octicon path) drawn in the current text colour; decorative. */
export function svgIcon(pathData, { size = 16, className = 'icon' } = {}) {
  const svg = document.createElementNS(SVG_NS, 'svg');
  for (const [k, v] of Object.entries({
    viewBox: '0 0 16 16', width: size, height: size, fill: 'currentColor', class: className, 'aria-hidden': 'true',
  })) svg.setAttribute(k, String(v));
  const path = document.createElementNS(SVG_NS, 'path');
  path.setAttribute('d', pathData);
  svg.append(path);
  return svg;
}

// A modal dialog makes the rest of the page inert and sits above it, so
// temporary elements go inside the open dialog when there is one.
function overlayHost() {
  return document.querySelector('dialog[open]') || document.body;
}

/** Copies text to the clipboard, falling back to execCommand where the async API is refused. */
export async function copyText(text) {
  try {
    await navigator.clipboard.writeText(text);
    return true;
  } catch {
    const area = el('textarea', { readonly: true, style: 'position: fixed; top: 0; left: 0; opacity: 0;' });
    area.value = text;
    overlayHost().append(area);
    area.select();
    let ok = false;
    try {
      ok = document.execCommand('copy');
    } catch {
      ok = false;
    }
    area.remove();
    return ok;
  }
}

let toastTimer = null;

/** A short message at the bottom of the screen, also announced to screen readers. */
export function toast(message) {
  const box = document.getElementById('toast')
    || el('div', { id: 'toast', class: 'toast', role: 'status', 'aria-live': 'polite' });
  if (box.parentElement !== overlayHost()) overlayHost().append(box);
  box.textContent = message;
  box.classList.add('show');
  clearTimeout(toastTimer);
  toastTimer = setTimeout(() => box.classList.remove('show'), 2200);
}

/** Copies text and confirms with a toast (or offers it to copy by hand). */
export async function copyWithToast(text, what = 'Copied') {
  if (await copyText(text)) toast(what);
  else window.prompt('Copy this:', text);
}
