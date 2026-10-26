// Utilidades compartidas: DOM, rutas, búsqueda difusa, atajos y eventos.
import { icon } from './icons.js';

export const isMac = navigator.platform.toUpperCase().includes('MAC');

/* ------------------------------------------------------------------ DOM */

// el('div.clase.otra', { text, attr, on, title, parent }, [hijos])
export function el(spec, opts = {}, children) {
  const [tag, ...classes] = spec.split('.');
  const node = document.createElement(tag || 'div');
  if (classes.length) node.className = classes.join(' ');
  if (Array.isArray(opts) || opts instanceof Node || typeof opts === 'string') {
    children = opts;
    opts = {};
  }
  if (opts.cls) node.classList.add(...[].concat(opts.cls).filter(Boolean).join(' ').split(' ').filter(Boolean));
  if (opts.text != null) node.textContent = opts.text;
  if (opts.html != null) node.innerHTML = opts.html;
  if (opts.title) node.setAttribute('aria-label', opts.title);
  if (opts.attr) for (const [k, v] of Object.entries(opts.attr)) if (v != null && v !== false) node.setAttribute(k, v === true ? '' : v);
  if (opts.style) Object.assign(node.style, opts.style);
  if (opts.on) for (const [k, v] of Object.entries(opts.on)) node.addEventListener(k, v);
  if (opts.icon) node.appendChild(icon(opts.icon));
  if (children != null) appendChildren(node, children);
  if (opts.parent) opts.parent.appendChild(node);
  return node;
}

function appendChildren(node, children) {
  for (const child of [].concat(children)) {
    if (child == null || child === false) continue;
    node.appendChild(child instanceof Node ? child : document.createTextNode(String(child)));
  }
}

export function iconButton(name, title, onClick, cls = '') {
  return el('div.clickable-icon' + (cls ? '.' + cls.split(' ').join('.') : ''), {
    title,
    icon: name,
    on: onClick ? { click: onClick } : undefined,
  });
}

export function empty(node) {
  while (node.firstChild) node.removeChild(node.firstChild);
  return node;
}

export function setIcon(node, name) {
  empty(node);
  node.appendChild(icon(name));
}

// Resalta los rangos [inicio, fin) de un texto dentro de un elemento.
export function renderHighlighted(node, text, ranges, cls = 'suggestion-highlight') {
  empty(node);
  let last = 0;
  for (const [from, to] of ranges || []) {
    if (from > last) node.appendChild(document.createTextNode(text.slice(last, from)));
    node.appendChild(el('span.' + cls, { text: text.slice(from, to) }));
    last = to;
  }
  if (last < text.length) node.appendChild(document.createTextNode(text.slice(last)));
}

/* --------------------------------------------------------------- Tiempo */

export function debounce(fn, ms) {
  let timer = null;
  const wrapped = (...args) => {
    clearTimeout(timer);
    timer = setTimeout(() => {
      timer = null;
      fn(...args);
    }, ms);
  };
  wrapped.cancel = () => clearTimeout(timer);
  wrapped.flush = (...args) => {
    clearTimeout(timer);
    fn(...args);
  };
  return wrapped;
}

export function throttle(fn, ms) {
  let last = 0;
  let timer = null;
  let pendingArgs = null;
  return (...args) => {
    const now = Date.now();
    pendingArgs = args;
    if (now - last >= ms) {
      last = now;
      fn(...args);
    } else if (!timer) {
      timer = setTimeout(() => {
        timer = null;
        last = Date.now();
        fn(...pendingArgs);
      }, ms - (now - last));
    }
  };
}

let uidCounter = 0;
export function uid(prefix = 'id') {
  uidCounter += 1;
  return prefix + '-' + Date.now().toString(36) + '-' + uidCounter.toString(36);
}

/* --------------------------------------------------------------- Rutas */

export function basename(path) {
  const i = path.lastIndexOf('/');
  return i < 0 ? path : path.slice(i + 1);
}

export function dirname(path) {
  const i = path.lastIndexOf('/');
  return i < 0 ? '' : path.slice(0, i);
}

export function extname(path) {
  const name = basename(path);
  const i = name.lastIndexOf('.');
  return i <= 0 ? '' : name.slice(i + 1).toLowerCase();
}

export function stem(path) {
  const name = basename(path);
  const i = name.lastIndexOf('.');
  return i <= 0 ? name : name.slice(0, i);
}

export function joinPath(...parts) {
  return parts.filter((p) => p != null && p !== '').join('/').replace(/\/+/g, '/').replace(/^\/|\/$/g, '');
}

export function normalizePath(path) {
  const out = [];
  for (const seg of path.replace(/\\/g, '/').split('/')) {
    if (!seg || seg === '.') continue;
    if (seg === '..') out.pop();
    else out.push(seg);
  }
  return out.join('/');
}

export const IMAGE_EXTENSIONS = new Set(['png', 'jpg', 'jpeg', 'gif', 'bmp', 'svg', 'webp', 'avif', 'ico']);
export const AUDIO_EXTENSIONS = new Set(['mp3', 'wav', 'm4a', 'ogg', 'flac', 'webm']);
export const VIDEO_EXTENSIONS = new Set(['mp4', 'mov', 'mkv', 'ogv']);

export function isMarkdownPath(path) {
  return extname(path) === 'md';
}

export function isImagePath(path) {
  return IMAGE_EXTENSIONS.has(extname(path));
}

export const INVALID_NAME_CHARS = /[\\/:*?"<>|#^[\]]/;

/* ------------------------------------------------------------ Búsqueda */

const collator = new Intl.Collator('es', { numeric: true, sensitivity: 'base' });
export function compareNames(a, b) {
  return collator.compare(a, b);
}

export function normalizeForSearch(text) {
  return text.toLowerCase().normalize('NFD').replace(/[̀-ͯ]/g, '');
}

// Coincidencia difusa: devuelve { score, matches: [[from, to]] } o null.
export function fuzzyMatch(query, text) {
  const q = normalizeForSearch(query).replace(/\s+/g, ' ').trim();
  if (!q) return { score: 0, matches: [] };
  const t = normalizeForSearch(text);
  const idx = t.indexOf(q);
  if (idx >= 0) {
    const atWord = idx === 0 || /[\s\-_/.]/.test(t[idx - 1]);
    return { score: 1000 - idx + (atWord ? 200 : 0) - t.length * 0.1, matches: [[idx, idx + q.length]] };
  }
  // Todas las palabras deben aparecer (en cualquier orden) o como subsecuencia.
  const words = q.split(' ');
  if (words.length > 1) {
    const matches = [];
    let score = 500;
    for (const w of words) {
      const i = t.indexOf(w);
      if (i < 0) return subsequence(q.replace(/ /g, ''), t);
      matches.push([i, i + w.length]);
      score -= i * 0.5;
    }
    matches.sort((a, b) => a[0] - b[0]);
    return { score: score - t.length * 0.1, matches: mergeRanges(matches) };
  }
  return subsequence(q, t);
}

function subsequence(q, t) {
  const matches = [];
  let ti = 0;
  let score = 0;
  let prev = -2;
  for (const ch of q) {
    const found = t.indexOf(ch, ti);
    if (found < 0) return null;
    if (found === prev + 1 && matches.length) {
      matches[matches.length - 1][1] += 1;
      score += 4;
    } else {
      matches.push([found, found + 1]);
      score -= Math.min(found - ti, 20) * 0.5;
      if (found === 0 || /[\s\-_/.]/.test(t[found - 1])) score += 3;
    }
    prev = found;
    ti = found + 1;
  }
  return { score: score - t.length * 0.1, matches };
}

function mergeRanges(ranges) {
  const out = [];
  for (const r of ranges) {
    const last = out[out.length - 1];
    if (last && r[0] <= last[1]) last[1] = Math.max(last[1], r[1]);
    else out.push([...r]);
  }
  return out;
}

/* ------------------------------------------------------------- Atajos */

const CODE_KEYS = {
  BracketLeft: '[', BracketRight: ']', Comma: ',', Period: '.', Slash: '/', Backslash: '\\',
  Semicolon: ';', Quote: "'", Backquote: '`', Minus: '-', Equal: '=', Space: ' ',
};

export function eventKey(e) {
  if (e.code && e.code.startsWith('Key')) return e.code.slice(3).toLowerCase();
  if (e.code && e.code.startsWith('Digit')) return e.code.slice(5);
  if (e.code && CODE_KEYS[e.code]) return CODE_KEYS[e.code];
  return e.key.length === 1 ? e.key.toLowerCase() : e.key;
}

export function matchHotkey(e, hotkey) {
  const mods = hotkey.modifiers || [];
  const wantMod = mods.includes('Mod');
  const wantCtrl = mods.includes('Ctrl');
  const wantShift = mods.includes('Shift');
  const wantAlt = mods.includes('Alt');
  const modPressed = isMac ? e.metaKey : e.ctrlKey;
  const ctrlPressed = isMac ? e.ctrlKey : false;
  if (modPressed !== wantMod) return false;
  if (isMac && ctrlPressed !== wantCtrl) return false;
  if (!isMac && wantCtrl && !e.ctrlKey) return false;
  if (e.shiftKey !== wantShift) return false;
  if (e.altKey !== wantAlt) return false;
  return eventKey(e).toLowerCase() === hotkey.key.toLowerCase();
}

const KEY_LABELS = {
  ArrowLeft: '←', ArrowRight: '→', ArrowUp: '↑', ArrowDown: '↓', Enter: '↵', Tab: '⇥',
  Backspace: '⌫', Delete: '⌦', Escape: 'Esc', ' ': 'Espacio',
};

export function formatHotkey(hotkey) {
  if (!hotkey) return '';
  const mods = hotkey.modifiers || [];
  const parts = [];
  if (isMac) {
    if (mods.includes('Ctrl')) parts.push('⌃');
    if (mods.includes('Alt')) parts.push('⌥');
    if (mods.includes('Shift')) parts.push('⇧');
    if (mods.includes('Mod')) parts.push('⌘');
  } else {
    if (mods.includes('Mod') || mods.includes('Ctrl')) parts.push('Ctrl');
    if (mods.includes('Alt')) parts.push('Alt');
    if (mods.includes('Shift')) parts.push('Shift');
  }
  const key = KEY_LABELS[hotkey.key] || (hotkey.key.length === 1 ? hotkey.key.toUpperCase() : hotkey.key);
  parts.push(key);
  return isMac ? parts.join(' ') : parts.join(' + ');
}

export function isModEvent(e) {
  return isMac ? e.metaKey : e.ctrlKey;
}

/* ------------------------------------------------------------- Texto */

export function countWords(text) {
  const matches = text.match(/[\p{L}\p{N}]+(?:['’\-][\p{L}\p{N}]+)*/gu);
  return matches ? matches.length : 0;
}

export function formatNumber(n) {
  return n.toLocaleString('es-ES');
}

export function plural(n, one, many) {
  return formatNumber(n) + ' ' + (n === 1 ? one : many);
}

export function escapeRegExp(text) {
  return text.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
}

export function escapeHtml(text) {
  return String(text)
    .replace(/&/g, '&amp;')
    .replace(/</g, '&lt;')
    .replace(/>/g, '&gt;')
    .replace(/"/g, '&quot;');
}

export function todayString(date = new Date()) {
  const pad = (n) => String(n).padStart(2, '0');
  return `${date.getFullYear()}-${pad(date.getMonth() + 1)}-${pad(date.getDate())}`;
}

export function formatDate(ms) {
  if (!ms) return '';
  return new Date(ms).toLocaleString('es-ES', { dateStyle: 'medium', timeStyle: 'short' });
}

/* ------------------------------------------------------------- Eventos */

export class Events {
  constructor() {
    this._handlers = new Map();
  }

  on(name, fn) {
    if (!this._handlers.has(name)) this._handlers.set(name, new Set());
    this._handlers.get(name).add(fn);
    return () => this.off(name, fn);
  }

  off(name, fn) {
    const set = this._handlers.get(name);
    if (set) set.delete(fn);
  }

  trigger(name, ...args) {
    const set = this._handlers.get(name);
    if (!set) return;
    for (const fn of [...set]) {
      try {
        fn(...args);
      } catch (err) {
        console.error('Error en el evento', name, err);
      }
    }
  }
}

// Agrupa funciones de limpieza (para quitar listeners al cerrar vistas).
export class Disposer {
  constructor() {
    this.fns = [];
  }

  add(fn) {
    if (typeof fn === 'function') this.fns.push(fn);
    return fn;
  }

  listen(target, type, fn, opts) {
    target.addEventListener(type, fn, opts);
    this.fns.push(() => target.removeEventListener(type, fn, opts));
  }

  dispose() {
    for (const fn of this.fns.splice(0)) {
      try {
        fn();
      } catch {}
    }
  }
}
