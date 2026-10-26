// Renderizado de markdown al estilo Obsidian (vista de lectura, incrustaciones y vistas previas).
import MarkdownIt from 'markdown-it';
import { LanguageDescription } from '@codemirror/language';
import { languages } from '@codemirror/language-data';
import { highlightCode, classHighlighter } from '@lezer/highlight';
import { el, empty, escapeHtml, isImagePath, extname, AUDIO_EXTENSIONS, VIDEO_EXTENSIONS, isModEvent, basename } from './util.js';
import { icon } from './icons.js';
import { parseFrontmatter, parseLinkInner } from './metadata.js';
import { Menu } from './ui.js';

/* ============================================================ markdown-it */

const md = new MarkdownIt({ html: true, linkify: true, breaks: true, typographer: false });

// [[enlace]] y ![[incrustación]]
md.inline.ruler.before('link', 'wikilink', (state, silent) => {
  const src = state.src;
  let pos = state.pos;
  let embed = false;
  if (src.charCodeAt(pos) === 0x21 && src.charCodeAt(pos + 1) === 0x5b && src.charCodeAt(pos + 2) === 0x5b) {
    embed = true;
    pos += 1;
  } else if (!(src.charCodeAt(pos) === 0x5b && src.charCodeAt(pos + 1) === 0x5b)) {
    return false;
  }
  const end = src.indexOf(']]', pos + 2);
  if (end < 0 || end > state.posMax) return false;
  const inner = src.slice(pos + 2, end);
  if (!inner.trim() || inner.includes('\n') || inner.includes('[[')) return false;
  if (!silent) {
    const token = state.push(embed ? 'wikiembed' : 'wikilink', '', 0);
    token.meta = parseLinkInner(inner);
  }
  state.pos = end + 2;
  return true;
});

// #etiquetas
md.inline.ruler.after('wikilink', 'tag', (state, silent) => {
  const src = state.src;
  const pos = state.pos;
  if (src.charCodeAt(pos) !== 0x23) return false;
  if (pos > 0 && !/[\s,;(]/.test(src[pos - 1])) return false;
  const m = /^#([\p{L}\p{N}_\-/]*[\p{L}_\-/][\p{L}\p{N}_\-/]*)/u.exec(src.slice(pos, state.posMax));
  if (!m) return false;
  if (!silent) {
    const token = state.push('tag', '', 0);
    token.content = m[1];
  }
  state.pos += m[0].length;
  return true;
});

// ==resaltado==
md.inline.ruler.before('emphasis', 'highlight', (state, silent) => {
  const src = state.src;
  const start = state.pos;
  if (src.charCodeAt(start) !== 0x3d || src.charCodeAt(start + 1) !== 0x3d) return false;
  if (src.charCodeAt(start + 2) === 0x3d || /\s/.test(src[start + 2] || ' ')) return false;
  const end = src.indexOf('==', start + 2);
  if (end < 0 || end > state.posMax - 2 || /\s/.test(src[end - 1])) return false;
  if (!silent) {
    state.push('mark_open', 'mark', 1);
    const oldMax = state.posMax;
    state.pos = start + 2;
    state.posMax = end;
    state.md.inline.tokenize(state);
    state.posMax = oldMax;
    state.push('mark_close', 'mark', -1);
  }
  state.pos = end + 2;
  return true;
});

// Número de línea de origen en cada bloque y casillas de tareas.
md.core.ruler.push('brain_lines_tasks', (state) => {
  const tokens = state.tokens;
  for (let i = 0; i < tokens.length; i++) {
    const token = tokens[i];
    if (token.map && token.nesting === 1) token.attrSet('data-line', String(token.map[0]));
    if (token.type !== 'inline' || i < 2) continue;
    const listItem = tokens[i - 2];
    if (tokens[i - 1].type !== 'paragraph_open' || listItem.type !== 'list_item_open') continue;
    const m = /^\[([ xX\-/!?*<>])\][ \t]/.exec(token.content) || /^\[([ xX\-/!?*<>])\]$/.exec(token.content);
    if (!m) continue;
    const checked = m[1] !== ' ';
    listItem.attrJoin('class', 'task-list-item' + (checked ? ' is-checked' : ''));
    listItem.attrSet('data-task', m[1]);
    const first = token.children[0];
    if (first && first.type === 'text') first.content = first.content.replace(/^\[.\][ \t]?/, '');
    const checkbox = new state.Token('html_inline', '', 0);
    checkbox.content = `<input type="checkbox" class="task-list-item-checkbox" data-line="${listItem.map ? listItem.map[0] : ''}"${checked ? ' checked' : ''}>`;
    token.children.unshift(checkbox);
  }
});

md.renderer.rules.wikilink = (tokens, idx, _opts, env) => {
  const { link, linkpath, subpath, alias } = tokens[idx].meta;
  const app = env.app;
  const dest = linkpath ? app.metadataCache.getFirstLinkpathDest(linkpath, env.sourcePath) : app.vault.getFile(env.sourcePath);
  const display = alias || (subpath ? (linkpath ? `${linkpath} > ${subpath}` : subpath) : linkpath);
  const cls = 'internal-link' + (dest ? '' : ' is-unresolved');
  return `<a data-href="${escapeHtml(link)}" href="${escapeHtml(link)}" class="${cls}" target="_blank" rel="noopener">${escapeHtml(display)}</a>`;
};

md.renderer.rules.wikiembed = (tokens, idx, _opts, env) => {
  const { link, linkpath, subpath, alias } = tokens[idx].meta;
  const app = env.app;
  const dest = app.metadataCache.getFirstLinkpathDest(linkpath, env.sourcePath);
  if (dest && isImagePath(dest.path)) {
    const size = alias && /^\d+(x\d+)?$/.test(alias) ? alias.split('x') : null;
    const attrs = size ? ` width="${size[0]}"${size[1] ? ` height="${size[1]}"` : ''}` : '';
    const alt = alias && !size ? alias : basename(dest.path);
    return `<span class="internal-embed image-embed is-loaded" src="${escapeHtml(link)}"><img src="${escapeHtml(app.vault.getResourceUrl(dest.path))}" alt="${escapeHtml(alt)}"${attrs}></span>`;
  }
  return `<span class="internal-embed" data-src="${escapeHtml(link)}" data-subpath="${escapeHtml(subpath || '')}"></span>`;
};

md.renderer.rules.tag = (tokens, idx) => {
  const tag = tokens[idx].content;
  return `<a href="#${escapeHtml(tag)}" class="tag" target="_blank" rel="noopener">#${escapeHtml(tag)}</a>`;
};

const defaultLinkOpen = md.renderer.rules.link_open || ((tokens, idx, options, _env, self) => self.renderToken(tokens, idx, options));
md.renderer.rules.link_open = (tokens, idx, options, env, self) => {
  const token = tokens[idx];
  const href = token.attrGet('href') || '';
  if (/^[a-z][a-z0-9+.-]*:/i.test(href)) {
    token.attrJoin('class', 'external-link');
    token.attrSet('target', '_blank');
    token.attrSet('rel', 'noopener');
  } else {
    let decoded = href;
    try {
      decoded = decodeURI(href);
    } catch {}
    const linkpath = decoded.split('#')[0];
    const dest = linkpath ? env.app.metadataCache.getFirstLinkpathDest(linkpath, env.sourcePath) : true;
    token.attrJoin('class', 'internal-link' + (dest ? '' : ' is-unresolved'));
    token.attrSet('data-href', decoded);
  }
  return defaultLinkOpen(tokens, idx, options, env, self);
};

const defaultImage = md.renderer.rules.image;
md.renderer.rules.image = (tokens, idx, options, env, self) => {
  const token = tokens[idx];
  const src = token.attrGet('src') || '';
  if (!/^[a-z][a-z0-9+.-]*:/i.test(src) && !src.startsWith('data:')) {
    let decoded = src;
    try {
      decoded = decodeURI(src);
    } catch {}
    const dest = env.app.metadataCache.getFirstLinkpathDest(decoded, env.sourcePath);
    if (dest) token.attrSet('src', env.app.vault.getResourceUrl(dest.path));
  }
  return defaultImage(tokens, idx, options, env, self);
};

md.renderer.rules.fence = (tokens, idx) => {
  const token = tokens[idx];
  const lang = (token.info || '').trim().split(/\s+/)[0];
  const line = token.map ? ` data-line="${token.map[0]}"` : '';
  return `<pre class="language-${escapeHtml(lang)}"${line}><code data-lang="${escapeHtml(lang)}">${escapeHtml(token.content)}</code></pre>\n`;
};

/* ============================================================ Render */

// Sustituye el frontmatter por líneas en blanco para conservar la numeración.
function stripFrontmatter(text) {
  const fm = parseFrontmatter(text);
  if (!fm.end) return { body: text, data: null };
  return { body: text.slice(0, fm.end).replace(/[^\n]/g, '') + text.slice(fm.end), data: fm.data };
}

export function renderMarkdownToElement(app, text, sourcePath, container, { depth = 0, showProperties = true } = {}) {
  const { body, data } = stripFrontmatter(text);
  empty(container);
  if (showProperties && data && Object.keys(data).length) container.appendChild(renderProperties(app, data, sourcePath));
  const holder = document.createElement('div');
  holder.innerHTML = md.render(body, { app, sourcePath });
  while (holder.firstChild) container.appendChild(holder.firstChild);
  postProcess(app, container, sourcePath, depth);
  return container;
}

function postProcess(app, container, sourcePath, depth) {
  // Llamadas (callouts)
  for (const quote of container.querySelectorAll('blockquote')) transformCallout(quote);
  // Bloques de código: resaltado y botón de copiar
  for (const pre of container.querySelectorAll('pre')) {
    const code = pre.querySelector('code');
    if (!code) continue;
    const button = el('button.copy-code-button', { title: 'Copiar' }, [icon('copy')]);
    button.addEventListener('click', (e) => {
      e.stopPropagation();
      navigator.clipboard.writeText(code.textContent);
      button.replaceChildren(icon('check'));
      setTimeout(() => button.replaceChildren(icon('copy')), 1500);
    });
    pre.appendChild(button);
    const lang = code.getAttribute('data-lang');
    if (lang) highlightCodeElement(code, lang);
  }
  // Incrustaciones de notas y archivos
  for (const span of container.querySelectorAll('span.internal-embed[data-src]')) {
    renderEmbed(app, span, sourcePath, depth);
  }
}

async function highlightCodeElement(codeEl, lang) {
  const desc = LanguageDescription.matchLanguageName(languages, lang, true);
  if (!desc) return;
  try {
    const support = desc.support || (await desc.load());
    const text = codeEl.textContent;
    const tree = support.language.parser.parse(text);
    const frag = document.createDocumentFragment();
    highlightCode(
      text,
      tree,
      classHighlighter,
      (chunk, classes) => frag.appendChild(classes ? el('span', { cls: classes, text: chunk }) : document.createTextNode(chunk)),
      () => frag.appendChild(document.createTextNode('\n')),
    );
    codeEl.replaceChildren(frag);
  } catch {}
}

const CALLOUT_ICONS = {
  note: 'pencil', abstract: 'clipboard-list', summary: 'clipboard-list', tldr: 'clipboard-list',
  info: 'info', todo: 'circle-check', tip: 'flame', hint: 'flame', important: 'flame',
  success: 'check', check: 'check', done: 'check', question: 'circle-help', help: 'circle-help',
  faq: 'circle-help', warning: 'circle-alert', caution: 'circle-alert', attention: 'circle-alert',
  failure: 'x', fail: 'x', missing: 'x', danger: 'zap', error: 'zap', bug: 'bug', example: 'list',
  quote: 'quote', cite: 'quote',
};

const CALLOUT_TITLES = {
  note: 'Nota', abstract: 'Resumen', summary: 'Resumen', tldr: 'Resumen', info: 'Info', todo: 'Pendiente',
  tip: 'Consejo', hint: 'Pista', important: 'Importante', success: 'Éxito', check: 'Hecho', done: 'Hecho',
  question: 'Pregunta', help: 'Ayuda', faq: 'Preguntas frecuentes', warning: 'Advertencia', caution: 'Precaución',
  attention: 'Atención', failure: 'Fallo', fail: 'Fallo', missing: 'Falta', danger: 'Peligro', error: 'Error',
  bug: 'Error', example: 'Ejemplo', quote: 'Cita', cite: 'Cita',
};

function transformCallout(quote) {
  const first = quote.firstElementChild;
  if (!first || first.tagName !== 'P') return;
  const firstText = first.firstChild;
  if (!firstText || firstText.nodeType !== Node.TEXT_NODE) return;
  const m = /^\[!([\w-]+)\]([+-]?)[ \t]*/.exec(firstText.textContent);
  if (!m) return;
  const type = m[1].toLowerCase();
  const fold = m[2];
  firstText.textContent = firstText.textContent.slice(m[0].length);
  // Título: nodos hasta el primer <br>
  const titleNodes = [];
  while (first.firstChild && first.firstChild.nodeName !== 'BR') titleNodes.push(first.removeChild(first.firstChild));
  if (first.firstChild && first.firstChild.nodeName === 'BR') first.removeChild(first.firstChild);
  if (first.firstChild && first.firstChild.nodeType === Node.TEXT_NODE) first.firstChild.textContent = first.firstChild.textContent.replace(/^\n/, '');

  const callout = el('div.callout', { attr: { 'data-callout': type, 'data-line': quote.getAttribute('data-line') } });
  if (fold) callout.classList.add('is-collapsible');
  const titleInner = el('div.callout-title-inner');
  const hasTitle = titleNodes.some((n) => n.textContent.trim());
  if (hasTitle) titleNodes.forEach((n) => titleInner.appendChild(n));
  else titleInner.textContent = CALLOUT_TITLES[type] || type.charAt(0).toUpperCase() + type.slice(1);
  const title = el('div.callout-title', [el('div.callout-icon', [icon(CALLOUT_ICONS[type] || 'pencil')]), titleInner]);
  const content = el('div.callout-content');
  if (first.childNodes.length && first.textContent.trim()) content.appendChild(first);
  else first.remove();
  while (quote.firstChild) content.appendChild(quote.firstChild);
  callout.appendChild(title);
  if (content.childNodes.length) callout.appendChild(content);
  if (fold) {
    const foldEl = el('div.callout-fold', { style: { display: 'flex', marginLeft: 'auto', alignItems: 'center' } }, [icon('chevron-down')]);
    title.appendChild(foldEl);
    title.style.cursor = 'default';
    if (fold === '-') content.style.display = 'none';
    title.addEventListener('click', () => {
      content.style.display = content.style.display === 'none' ? '' : 'none';
    });
  }
  quote.replaceWith(callout);
}

export function extractSection(text, subpath) {
  if (!subpath) return text;
  if (subpath.startsWith('^')) {
    const re = new RegExp('^.*\\s\\^' + subpath.slice(1).replace(/[.*+?^${}()|[\]\\]/g, '\\$&') + '\\s*$', 'm');
    const m = re.exec(text);
    return m ? m[0].replace(/\s\^[\w-]+\s*$/, '') : '';
  }
  const target = subpath.split('#').pop().trim().toLowerCase();
  const lines = text.split('\n');
  let start = -1;
  let level = 0;
  for (let i = 0; i < lines.length; i++) {
    const m = /^(#{1,6})\s+(.*?)\s*#*\s*$/.exec(lines[i]);
    if (!m) continue;
    if (start < 0 && m[2].trim().toLowerCase() === target) {
      start = i;
      level = m[1].length;
    } else if (start >= 0 && m[1].length <= level) {
      return lines.slice(start, i).join('\n');
    }
  }
  return start >= 0 ? lines.slice(start).join('\n') : '';
}

function renderEmbed(app, span, sourcePath, depth) {
  const link = span.getAttribute('data-src');
  const { linkpath, subpath } = parseLinkInner(link);
  const dest = linkpath ? app.metadataCache.getFirstLinkpathDest(linkpath, sourcePath) : app.vault.getFile(sourcePath);
  if (!dest) {
    span.classList.add('is-unresolved-embed');
    span.textContent = `«${linkpath}» no se ha creado todavía.`;
    return;
  }
  const ext = dest.extension;
  if (ext === 'pdf') {
    span.classList.add('pdf-embed');
    span.appendChild(el('iframe', { attr: { src: app.vault.getResourceUrl(dest.path) }, style: { width: '100%', height: '600px', border: 'none', display: 'block' } }));
    return;
  }
  if (AUDIO_EXTENSIONS.has(ext)) {
    span.appendChild(el('audio', { attr: { controls: true, src: app.vault.getResourceUrl(dest.path) } }));
    return;
  }
  if (VIDEO_EXTENSIONS.has(ext)) {
    span.appendChild(el('video', { attr: { controls: true, src: app.vault.getResourceUrl(dest.path) }, style: { maxWidth: '100%' } }));
    return;
  }
  if (ext !== 'md') {
    span.appendChild(el('a.internal-link', { text: dest.name, attr: { 'data-href': dest.path } }));
    return;
  }
  span.classList.add('markdown-embed');
  span.style.display = 'block';
  span.setAttribute('data-href', dest.path);
  if (depth >= 3) {
    span.appendChild(el('a.internal-link', { text: dest.basename, attr: { 'data-href': dest.path } }));
    return;
  }
  const text = extractSection(app.vault.getContent(dest.path) || '', subpath);
  const titleText = subpath ? `${dest.basename} > ${subpath}` : dest.basename;
  span.appendChild(el('div.markdown-embed-title', { text: titleText }));
  const openLink = el('div.markdown-embed-link.clickable-icon', { title: 'Abrir enlace', attr: { 'data-href': dest.path } }, [icon('link')]);
  span.appendChild(openLink);
  const content = el('div.markdown-embed-content.markdown-rendered', { parent: span });
  renderMarkdownToElement(app, text, dest.path, content, { depth: depth + 1, showProperties: false });
}

/* ============================================================ Propiedades */

function propertyIcon(key, value) {
  const k = key.toLowerCase();
  if (k === 'tags' || k === 'tag') return 'tags';
  if (k === 'aliases' || k === 'alias') return 'link';
  if (Array.isArray(value)) return 'list';
  if (typeof value === 'number') return 'hash';
  if (typeof value === 'boolean') return 'circle-check';
  if (typeof value === 'string' && /^\d{4}-\d{2}-\d{2}/.test(value)) return 'calendar-days';
  return 'text-cursor-input';
}

export function renderProperties(app, data, sourcePath) {
  const container = el('div.metadata-container');
  el('div.metadata-properties-heading', { text: 'Propiedades', parent: container });
  for (const [key, value] of Object.entries(data)) {
    const row = el('div.metadata-property', { parent: container });
    el('div.metadata-property-key', { parent: row }, [icon(propertyIcon(key, value)), el('span', { text: key })]);
    const valueEl = el('div.metadata-property-value.markdown-rendered', { parent: row });
    const k = key.toLowerCase();
    const items = Array.isArray(value) ? value : value == null ? [] : [value];
    if (k === 'tags' || k === 'tag') {
      const tags = items.flatMap((t) => String(t).split(/[,\s]+/)).filter(Boolean);
      for (const t of tags) {
        const tag = t.replace(/^#/, '');
        valueEl.appendChild(el('a.tag', { text: '#' + tag, attr: { href: '#' + tag } }));
      }
    } else if (Array.isArray(value)) {
      for (const item of items) {
        const pill = el('div.multi-select-pill', { parent: valueEl });
        renderInlineValue(app, pill, String(item), sourcePath);
      }
    } else if (typeof value === 'boolean') {
      const cb = el('input.task-list-item-checkbox', { attr: { type: 'checkbox', disabled: true } });
      cb.checked = value;
      valueEl.appendChild(cb);
    } else if (value != null) {
      renderInlineValue(app, valueEl, typeof value === 'object' ? JSON.stringify(value) : String(value), sourcePath);
    }
  }
  return container;
}

function renderInlineValue(app, parent, text, sourcePath) {
  parent.innerHTML = md.renderInline(text, { app, sourcePath });
}

/* ===================================================== Interacción */

export function linkTargetFromEvent(e) {
  if (e.button === 1 || isModEvent(e)) return e.altKey ? 'split' : 'tab';
  return false;
}

// Gestiona clics en enlaces, etiquetas, casillas e incrustaciones del contenido renderizado.
export function attachRenderedHandlers(app, container, getSourcePath, { onCheckbox, hoverNeedsMod = false } = {}) {
  const openLink = (target, e) => {
    const href = target.getAttribute('data-href');
    app.workspace.openLinkText(href, getSourcePath(), linkTargetFromEvent(e));
  };
  container.addEventListener('click', (e) => {
    const target = e.target;
    const checkbox = target.closest('input.task-list-item-checkbox');
    if (checkbox) {
      if (onCheckbox && checkbox.dataset.line) onCheckbox(Number(checkbox.dataset.line), checkbox.checked);
      else e.preventDefault();
      return;
    }
    const internal = target.closest('a.internal-link[data-href], .markdown-embed-link[data-href]');
    if (internal) {
      e.preventDefault();
      openLink(internal, e);
      return;
    }
    const tag = target.closest('a.tag');
    if (tag) {
      e.preventDefault();
      app.openSearch('tag:' + tag.textContent);
      return;
    }
    const external = target.closest('a.external-link, a[href^="http"], a[href^="mailto:"]');
    if (external) {
      e.preventDefault();
      app.api.openExternal(external.getAttribute('href'));
      return;
    }
    const anchor = target.closest('a');
    if (anchor) e.preventDefault();
  });
  container.addEventListener('auxclick', (e) => {
    if (e.button !== 1) return;
    const internal = e.target.closest('a.internal-link[data-href]');
    if (internal) {
      e.preventDefault();
      openLink(internal, e);
    }
  });
  container.addEventListener('contextmenu', (e) => {
    const internal = e.target.closest('a.internal-link[data-href]');
    if (!internal) return;
    const href = internal.getAttribute('data-href');
    showLinkMenu(app, e, href, getSourcePath());
  });
  container.addEventListener('mouseover', (e) => {
    const internal = e.target.closest('a.internal-link[data-href]');
    if (!internal || (hoverNeedsMod && !isModEvent(e))) return;
    app.hoverPopover.show(internal, internal.getAttribute('data-href'), getSourcePath());
  });
}

export function showLinkMenu(app, e, linktext, sourcePath) {
  const menu = new Menu();
  menu.addItem((i) => i.setTitle('Abrir en una pestaña nueva').setIcon('file-plus').onClick(() => app.workspace.openLinkText(linktext, sourcePath, 'tab')));
  menu.addItem((i) => i.setTitle('Abrir a la derecha').setIcon('separator-vertical').onClick(() => app.workspace.openLinkText(linktext, sourcePath, 'split')));
  menu.addItem((i) => i.setTitle('Abrir en una ventana nueva').setIcon('app-window').onClick(() => app.workspace.openLinkText(linktext, sourcePath, 'window')));
  menu.showAtMouseEvent(e);
}

/* ===================================================== Vista previa flotante */

export class HoverPopover {
  constructor(app) {
    this.app = app;
    this.el = null;
    this.target = null;
    this.showTimer = null;
    this.hideTimer = null;
  }

  show(target, linktext, sourcePath) {
    if (this.target === target && this.el) {
      clearTimeout(this.hideTimer);
      return;
    }
    clearTimeout(this.showTimer);
    this.pendingTarget = target;
    const onLeave = () => {
      clearTimeout(this.showTimer);
      target.removeEventListener('mouseleave', onLeave);
      this.scheduleHide();
    };
    target.addEventListener('mouseleave', onLeave);
    this.showTimer = setTimeout(() => {
      if (this.pendingTarget !== target || !target.isConnected) return;
      this.open(target, linktext, sourcePath);
    }, 350);
  }

  open(target, linktext, sourcePath) {
    this.close();
    const { linkpath, subpath } = parseLinkInner(linktext);
    const file = linkpath ? this.app.metadataCache.getFirstLinkpathDest(linkpath, sourcePath) : this.app.vault.getFile(sourcePath);
    if (!file) return;
    this.target = target;
    this.el = el('div.popover.hover-popover', { parent: document.body });
    const view = el('div.markdown-preview-view.markdown-rendered', { parent: this.el });
    const sizer = el('div.markdown-preview-sizer', { parent: view });
    if (file.extension === 'md') {
      if (!subpath) el('div.popover-title', { text: file.basename, parent: sizer });
      const content = el('div', { parent: sizer });
      renderMarkdownToElement(this.app, extractSection(this.app.vault.getContent(file.path) || '', subpath), file.path, content);
      attachRenderedHandlers(this.app, sizer, () => file.path);
    } else if (isImagePath(file.path)) {
      sizer.appendChild(el('img', { attr: { src: this.app.vault.getResourceUrl(file.path) }, style: { maxWidth: '100%' } }));
    } else {
      sizer.appendChild(el('div', { text: file.name }));
    }
    const rect = target.getBoundingClientRect();
    const popRect = this.el.getBoundingClientRect();
    let top = rect.bottom + 6;
    if (top + popRect.height > window.innerHeight - 8) top = Math.max(8, rect.top - popRect.height - 6);
    const left = Math.max(8, Math.min(rect.left, window.innerWidth - popRect.width - 8));
    this.el.style.top = top + 'px';
    this.el.style.left = left + 'px';
    this.el.addEventListener('mouseenter', () => clearTimeout(this.hideTimer));
    this.el.addEventListener('mouseleave', () => this.scheduleHide());
  }

  scheduleHide() {
    clearTimeout(this.hideTimer);
    this.hideTimer = setTimeout(() => this.close(), 300);
  }

  close() {
    clearTimeout(this.hideTimer);
    if (this.el) this.el.remove();
    this.el = null;
    this.target = null;
  }
}

export { md as markdownIt, extname };
