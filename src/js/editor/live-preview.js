// Vista previa en vivo: estiliza el markdown y oculta su sintaxis fuera de la zona donde está el cursor.
import { ViewPlugin, Decoration, WidgetType, EditorView } from '@codemirror/view';
import { StateField, StateEffect, Facet } from '@codemirror/state';
import { syntaxTree } from '@codemirror/language';
import { el, isImagePath } from '../util.js';
import { icon } from '../icons.js';
import { parseLinkInner, parseFrontmatter } from '../metadata.js';
import { renderMarkdownToElement, renderProperties, attachRenderedHandlers, extractSection } from '../render.js';

/* ------------------------------------------------------------ Estado */

export const setFocusEffect = StateEffect.define();
export const refreshEffect = StateEffect.define();

export const focusField = StateField.define({
  create: () => false,
  update(value, tr) {
    for (const e of tr.effects) if (e.is(setFocusEffect)) value = e.value;
    return value;
  },
});

export const focusTracker = EditorView.focusChangeEffect.of((_state, focusing) => setFocusEffect.of(focusing));

// Contexto de la app para el editor: { app, getPath }
export const editorContext = Facet.define({ combine: (values) => values[values.length - 1] || {} });
// true = vista previa en vivo, false = modo fuente
export const livePreviewFacet = Facet.define({ combine: (values) => (values.length ? values[values.length - 1] : true) });

function rangesTouch(state, from, to) {
  if (!state.field(focusField, false)) return false;
  for (const r of state.selection.ranges) if (r.from <= to && r.to >= from) return true;
  return false;
}

function linesTouch(state, from, to) {
  return rangesTouch(state, state.doc.lineAt(from).from, state.doc.lineAt(to).to);
}

function isCalloutStart(state, from) {
  return /^\s*>\s*\[![\w-]+\]/.test(state.doc.lineAt(from).text);
}

function coversWholeLines(state, from, to) {
  return state.doc.lineAt(from).from === from && state.doc.lineAt(to).to === to;
}

// Bloques que se sustituyen por su versión renderizada cuando el cursor no está dentro.
function isRenderedBlock(state, name, from, to) {
  if (!state.facet(livePreviewFacet)) return false;
  if (name !== 'Frontmatter' && name !== 'Table' && !(name === 'Blockquote' && isCalloutStart(state, from))) return false;
  if (!coversWholeLines(state, from, to)) return false;
  return !rangesTouch(state, from, to);
}

/* ------------------------------------------------------------ Widgets */

class BulletWidget extends WidgetType {
  eq() {
    return true;
  }

  toDOM() {
    return el('span.list-bullet', { text: '•' });
  }

  ignoreEvent() {
    return false;
  }
}

class CheckboxWidget extends WidgetType {
  constructor(checked) {
    super();
    this.checked = checked;
  }

  eq(other) {
    return other.checked === this.checked;
  }

  toDOM(view) {
    const input = el('input.task-list-item-checkbox', { attr: { type: 'checkbox' } });
    input.checked = this.checked;
    input.addEventListener('mousedown', (e) => e.preventDefault());
    input.addEventListener('click', (e) => {
      e.preventDefault();
      const pos = view.posAtDOM(input);
      const text = view.state.sliceDoc(pos, pos + 3);
      if (!/^\[.\]$/.test(text)) return;
      view.dispatch({ changes: { from: pos + 1, to: pos + 2, insert: text[1] === ' ' ? 'x' : ' ' } });
    });
    return input;
  }

  ignoreEvent() {
    return true;
  }
}

class HrWidget extends WidgetType {
  eq() {
    return true;
  }

  toDOM() {
    return el('span.hr-widget');
  }
}

class ImageWidget extends WidgetType {
  constructor(src, alt, width) {
    super();
    this.src = src;
    this.alt = alt;
    this.width = width;
  }

  eq(other) {
    return other.src === this.src && other.width === this.width;
  }

  toDOM() {
    const img = el('img.image-widget', { attr: { src: this.src, alt: this.alt || '' } });
    if (this.width) img.style.width = this.width + 'px';
    return el('span.image-embed', [img]);
  }

  ignoreEvent() {
    return false;
  }
}

class CodeFlairWidget extends WidgetType {
  constructor(lang) {
    super();
    this.lang = lang;
  }

  eq(other) {
    return other.lang === this.lang;
  }

  toDOM() {
    return el('span.code-block-flair', { text: this.lang });
  }
}

// Base para widgets renderizados con markdown: al pulsar sobre ellos se edita el código fuente.
class RenderedWidget extends WidgetType {
  constructor(ctx, text) {
    super();
    this.ctx = ctx;
    this.text = text;
  }

  eq(other) {
    return other.text === this.text && other.constructor === this.constructor;
  }

  wrap(view, inner, block = true) {
    const wrapper = el(block ? 'div.cm-widget-block' : 'span.cm-widget-inline', { style: { position: 'relative' } });
    wrapper.appendChild(inner);
    const edit = el('div.clickable-icon.cm-widget-edit-button', { title: 'Editar' }, [icon('pencil')]);
    wrapper.appendChild(edit);
    wrapper.addEventListener('mousedown', (e) => {
      if (e.target.closest('a, input, .internal-embed .markdown-embed-link')) return;
      e.preventDefault();
      const pos = view.posAtDOM(wrapper);
      view.focus();
      view.dispatch({ selection: { anchor: pos }, scrollIntoView: false });
    });
    attachRenderedHandlers(this.ctx.app, wrapper, () => this.ctx.getPath());
    return wrapper;
  }

  ignoreEvent() {
    return true;
  }

  get estimatedHeight() {
    return 60;
  }
}

class MarkdownBlockWidget extends RenderedWidget {
  toDOM(view) {
    const inner = el('div.markdown-rendered');
    renderMarkdownToElement(this.ctx.app, this.text, this.ctx.getPath(), inner, { showProperties: false });
    return this.wrap(view, inner);
  }
}

class PropertiesWidget extends RenderedWidget {
  toDOM(view) {
    const fm = parseFrontmatter(this.text + '\n');
    const data = fm.data || {};
    const inner = Object.keys(data).length
      ? renderProperties(this.ctx.app, data, this.ctx.getPath())
      : el('div.metadata-container', [el('div.metadata-properties-heading', { text: 'Propiedades' })]);
    return this.wrap(view, inner);
  }
}

class NoteEmbedWidget extends RenderedWidget {
  constructor(ctx, text, path, subpath) {
    super(ctx, text);
    this.path = path;
    this.subpath = subpath;
  }

  eq(other) {
    return other instanceof NoteEmbedWidget && other.path === this.path && other.subpath === this.subpath && other.text === this.text;
  }

  toDOM(view) {
    const file = this.ctx.app.vault.getFile(this.path);
    const box = el('div.internal-embed.markdown-embed');
    el('div.markdown-embed-title', { text: this.subpath ? `${file.basename} > ${this.subpath}` : file.basename, parent: box });
    el('div.markdown-embed-link.clickable-icon', { title: 'Abrir enlace', attr: { 'data-href': this.path }, parent: box }, [icon('link')]);
    const content = el('div.markdown-embed-content.markdown-rendered', { parent: box });
    renderMarkdownToElement(this.ctx.app, extractSection(this.text, this.subpath), this.path, content, { depth: 1, showProperties: false });
    const wrapper = this.wrap(view, box, false);
    wrapper.style.display = 'block';
    return wrapper;
  }
}

/* ---------------------------------------------------- Decoraciones en línea */

const HIDE = Decoration.replace({});
const FORMATTING = Decoration.mark({ class: 'cm-formatting' });
const FORMATTING_LINK = Decoration.mark({ class: 'cm-formatting cm-formatting-link' });
const FORMATTING_LIST = Decoration.mark({ class: 'cm-formatting cm-formatting-list' });
const FORMATTING_QUOTE = Decoration.mark({ class: 'cm-formatting cm-formatting-quote' });
const FORMATTING_HEADER = Decoration.mark({ class: 'cm-formatting cm-formatting-header' });
const URL_MARK = Decoration.mark({ class: 'cm-url' });
const BULLET = new BulletWidget();
const HR = new HrWidget();

const INLINE_STYLES = {
  Emphasis: ['cm-em', 'EmphasisMark'],
  StrongEmphasis: ['cm-strong', 'EmphasisMark'],
  Strikethrough: ['cm-strikethrough', 'StrikethroughMark'],
  Highlight: ['cm-highlight', 'HighlightMark'],
  InlineCode: ['cm-inline-code', 'CodeMark'],
};

function isExternalUrl(url) {
  return /^[a-z][a-z0-9+.-]*:/i.test(url);
}

function safeDecode(url) {
  try {
    return decodeURI(url);
  } catch {
    return url;
  }
}

function buildInline(view) {
  const state = view.state;
  const doc = state.doc;
  const ctx = state.facet(editorContext);
  const live = state.facet(livePreviewFacet);
  const app = ctx.app;
  const sourcePath = ctx.getPath ? ctx.getPath() : '';
  const decos = [];
  const lineClasses = new Map();
  const add = (from, to, deco) => {
    if (from < to || (from === to && deco.spec.widget)) decos.push(deco.range(from, to));
  };
  const addLine = (pos, cls) => {
    const line = doc.lineAt(pos);
    if (!lineClasses.has(line.from)) lineClasses.set(line.from, new Set());
    for (const c of cls.split(' ')) lineClasses.get(line.from).add(c);
  };
  const addLines = (from, to, cls) => {
    const first = doc.lineAt(from).number;
    const last = doc.lineAt(to).number;
    for (let n = first; n <= last; n++) addLine(doc.line(n).from, cls);
  };
  const resolve = (linkpath) => (linkpath ? app.metadataCache.getFirstLinkpathDest(linkpath, sourcePath) : app.vault.getFile(sourcePath));

  const { from: vpFrom, to: vpTo } = view.viewport;
  syntaxTree(state).iterate({
    from: vpFrom,
    to: vpTo,
    enter: (ref) => {
      const { name, from, to } = ref;
      const node = ref.node;

      if (INLINE_STYLES[name]) {
        const [cls, markName] = INLINE_STYLES[name];
        add(from, to, Decoration.mark({ class: cls }));
        const hide = live && !rangesTouch(state, from, to);
        for (const m of node.getChildren(markName)) add(m.from, m.to, hide ? HIDE : FORMATTING);
        return name !== 'InlineCode';
      }

      switch (name) {
        case 'Frontmatter':
          if (isRenderedBlock(state, name, from, to)) return false;
          addLines(from, to, 'HyperMD-frontmatter');
          for (const m of node.getChildren('FrontmatterMark')) add(m.from, m.to, FORMATTING);
          return false;

        case 'Table':
          if (isRenderedBlock(state, name, from, to)) return false;
          addLines(from, to, 'HyperMD-table-row');
          return true;

        case 'Blockquote':
          if (isRenderedBlock(state, name, from, to)) return false;
          addLines(from, to, 'HyperMD-quote');
          return true;

        case 'QuoteMark': {
          if (live && !linesTouch(state, from, to)) {
            const end = doc.sliceString(to, to + 1) === ' ' ? to + 1 : to;
            add(from, end, HIDE);
          } else {
            add(from, to, FORMATTING_QUOTE);
          }
          return false;
        }

        case 'ATXHeading1':
        case 'ATXHeading2':
        case 'ATXHeading3':
        case 'ATXHeading4':
        case 'ATXHeading5':
        case 'ATXHeading6': {
          const level = name.slice(-1);
          addLine(from, `HyperMD-header HyperMD-header-${level}`);
          const hide = live && !linesTouch(state, from, to);
          for (const m of node.getChildren('HeaderMark')) {
            if (hide) {
              let start = m.from;
              let end = m.to;
              if (m.from === from) {
                if (doc.sliceString(end, end + 1) === ' ') end += 1;
              } else {
                while (start > from && doc.sliceString(start - 1, start) === ' ') start -= 1;
              }
              add(start, end, HIDE);
            } else {
              add(m.from, m.to, FORMATTING_HEADER);
            }
          }
          return true;
        }

        case 'SetextHeading1':
        case 'SetextHeading2': {
          const level = name.slice(-1);
          const mark = node.getChild('HeaderMark');
          addLines(from, mark ? mark.from - 1 : to, `HyperMD-header HyperMD-header-${level}`);
          if (mark) add(mark.from, mark.to, FORMATTING_HEADER);
          return true;
        }

        case 'Link': {
          const marks = node.getChildren('LinkMark');
          if (marks.length < 2) return true;
          const url = node.getChild('URL');
          const textFrom = marks[0].to;
          const textTo = marks[1].from;
          const urlText = url ? doc.sliceString(url.from, url.to).replace(/^<|>$/g, '') : '';
          const hide = live && !rangesTouch(state, from, to);
          const external = isExternalUrl(urlText);
          const attrs = external ? { 'data-url': urlText } : { 'data-href': safeDecode(urlText) };
          if (hide) attrs['data-live'] = '1';
          let cls = 'cm-link-text';
          if (!external) {
            const target = resolve(safeDecode(urlText).split('#')[0]);
            cls = 'cm-hmd-internal-link' + (target || !urlText ? '' : ' is-unresolved');
          } else {
            cls += ' external-link';
          }
          if (textTo > textFrom) add(textFrom, textTo, Decoration.mark({ class: cls, attributes: attrs }));
          if (hide && url) {
            add(from, textFrom, HIDE);
            add(textTo, to, HIDE);
          } else {
            for (const m of marks) add(m.from, m.to, FORMATTING_LINK);
            if (url) add(url.from, url.to, URL_MARK);
          }
          return true;
        }

        case 'Image': {
          const url = node.getChild('URL');
          const marks = node.getChildren('LinkMark');
          if (!url || marks.length < 2) return false;
          const hide = live && !rangesTouch(state, from, to);
          if (hide) {
            const raw = doc.sliceString(url.from, url.to).replace(/^<|>$/g, '');
            let src = raw;
            if (!isExternalUrl(raw)) {
              const target = resolve(safeDecode(raw));
              src = target ? app.vault.getResourceUrl(target.path) : raw;
            }
            const alt = doc.sliceString(marks[0].to, marks[1].from);
            const width = /^\d+$/.test(alt.split('|').pop()) ? Number(alt.split('|').pop()) : null;
            add(from, to, Decoration.replace({ widget: new ImageWidget(src, alt, width) }));
          } else {
            for (const m of marks) add(m.from, m.to, FORMATTING_LINK);
            add(url.from, url.to, URL_MARK);
          }
          return false;
        }

        case 'Autolink': {
          const url = node.getChild('URL');
          if (!url) return false;
          const hide = live && !rangesTouch(state, from, to);
          const urlText = doc.sliceString(url.from, url.to);
          add(url.from, url.to, Decoration.mark({ class: 'cm-bare-url', attributes: { 'data-url': urlText, 'data-live': hide ? '1' : '0' } }));
          for (const m of node.getChildren('LinkMark')) add(m.from, m.to, hide ? HIDE : FORMATTING_LINK);
          return false;
        }

        case 'URL': {
          const parent = node.parent && node.parent.name;
          if (parent === 'Link' || parent === 'Image' || parent === 'Autolink' || parent === 'LinkReference') return false;
          const urlText = doc.sliceString(from, to);
          const href = /^www\./i.test(urlText) ? 'https://' + urlText : urlText;
          add(from, to, Decoration.mark({ class: 'cm-bare-url', attributes: { 'data-url': href, 'data-live': '1' } }));
          return false;
        }

        case 'WikiLink':
        case 'Embed': {
          const target = node.getChild('WikiLinkTarget');
          const alias = node.getChild('WikiLinkAlias');
          const pipe = node.getChild('WikiLinkPipe');
          const marks = node.getChildren('WikiLinkMark');
          if (!target || marks.length < 2) return false;
          const targetText = doc.sliceString(target.from, target.to).replace(/\\$/, '');
          const { linkpath, subpath } = parseLinkInner(targetText);
          const dest = resolve(linkpath);
          const hide = live && !rangesTouch(state, from, to);
          if (name === 'Embed' && hide && dest) {
            if (isImagePath(dest.path)) {
              const aliasText = alias ? doc.sliceString(alias.from, alias.to) : '';
              const width = /^\d+/.test(aliasText) ? Number(aliasText.split('x')[0]) : null;
              add(from, to, Decoration.replace({ widget: new ImageWidget(app.vault.getResourceUrl(dest.path), dest.name, width) }));
              return false;
            }
            if (dest.extension === 'md' && dest.path !== sourcePath) {
              const text = app.vault.getContent(dest.path) || '';
              add(from, to, Decoration.replace({ widget: new NoteEmbedWidget(ctx, text, dest.path, subpath) }));
              return false;
            }
          }
          const attrs = { 'data-href': targetText };
          if (hide) attrs['data-live'] = '1';
          const linkMark = Decoration.mark({ class: 'cm-hmd-internal-link' + (dest ? '' : ' is-unresolved'), attributes: attrs });
          if (hide) {
            add(marks[0].from, marks[0].to, HIDE);
            if (alias) {
              add(target.from, alias.from, HIDE);
              add(alias.from, alias.to, linkMark);
            } else {
              add(target.from, target.to, linkMark);
            }
            add(marks[1].from, marks[1].to, HIDE);
          } else {
            for (const m of marks) add(m.from, m.to, FORMATTING_LINK);
            add(target.from, target.to, linkMark);
            if (pipe) add(pipe.from, pipe.to, FORMATTING_LINK);
            if (alias) add(alias.from, alias.to, linkMark);
          }
          return false;
        }

        case 'Hashtag':
          add(from, to, Decoration.mark({ class: 'cm-hashtag', attributes: { 'data-tag': doc.sliceString(from, to), 'data-live': '1' } }));
          return false;

        case 'ListItem': {
          let depth = 0;
          for (let p = node.parent; p; p = p.parent) if (p.name === 'BulletList' || p.name === 'OrderedList') depth += 1;
          addLine(from, `HyperMD-list-line HyperMD-list-line-${depth}`);
          const task = node.getChild('Task');
          if (task) {
            const marker = task.getChild('TaskMarker');
            addLine(from, 'HyperMD-task-line');
            if (marker && /\[[^ ]\]/.test(doc.sliceString(marker.from, marker.to))) addLine(from, 'is-task-done');
          }
          return true;
        }

        case 'ListMark': {
          const item = node.parent;
          const list = item && item.parent;
          if (!item || !list) return false;
          const task = item.getChild('Task');
          const markEnd = doc.sliceString(to, to + 1) === ' ' ? to + 1 : to;
          const touching = rangesTouch(state, from, markEnd);
          if (live && !touching && task) add(from, markEnd, HIDE);
          else if (live && !touching && list.name === 'BulletList') add(from, to, Decoration.replace({ widget: BULLET }));
          else add(from, to, FORMATTING_LIST);
          return false;
        }

        case 'TaskMarker': {
          const checked = /\[[^ ]\]/.test(doc.sliceString(from, to));
          if (live && !rangesTouch(state, from, to)) add(from, to, Decoration.replace({ widget: new CheckboxWidget(checked) }));
          else add(from, to, FORMATTING);
          return false;
        }

        case 'HorizontalRule': {
          if (live && !linesTouch(state, from, to)) {
            addLine(from, 'hr');
            add(from, to, Decoration.replace({ widget: HR }));
          } else {
            add(from, to, FORMATTING);
          }
          return false;
        }

        case 'FencedCode':
        case 'CodeBlock': {
          const startLine = doc.lineAt(from);
          const endLine = doc.lineAt(to);
          const fenced = name === 'FencedCode';
          const closed = fenced && endLine.number > startLine.number && /^\s*(`{3,}|~{3,})\s*$/.test(endLine.text);
          const active = rangesTouch(state, from, to);
          for (let n = startLine.number; n <= endLine.number; n++) {
            let cls = 'HyperMD-codeblock';
            if (n === startLine.number) cls += ' HyperMD-codeblock-begin';
            if (n === endLine.number) cls += ' HyperMD-codeblock-end';
            if (fenced && live && !active && (n === startLine.number || (n === endLine.number && closed))) cls += ' is-inactive';
            addLine(doc.line(n).from, cls);
          }
          if (fenced && live && !active) {
            const info = node.getChild('CodeInfo');
            if (info) add(startLine.to, startLine.to, Decoration.widget({ widget: new CodeFlairWidget(doc.sliceString(info.from, info.to)), side: 1 }));
          }
          return true;
        }

        case 'Escape':
          if (live && !rangesTouch(state, from, to)) add(from, from + 1, HIDE);
          else add(from, from + 1, FORMATTING);
          return false;

        default:
          return true;
      }
    },
  });

  for (const [pos, classes] of lineClasses) decos.push(Decoration.line({ class: [...classes].join(' ') }).range(pos));
  return Decoration.set(decos, true);
}

class InlinePreviewPlugin {
  constructor(view) {
    this.decorations = buildInline(view);
  }

  update(update) {
    const reconfigured = update.transactions.some((tr) => tr.reconfigured || tr.effects.some((e) => e.is(refreshEffect) || e.is(setFocusEffect)));
    if (update.docChanged || update.viewportChanged || update.selectionSet || update.focusChanged || reconfigured ||
      syntaxTree(update.startState) !== syntaxTree(update.state)) {
      this.decorations = buildInline(update.view);
    }
  }
}

export const inlinePreview = ViewPlugin.fromClass(InlinePreviewPlugin, { decorations: (v) => v.decorations });

/* ------------------------------------------------------ Bloques renderizados */

function buildBlocks(state) {
  if (!state.facet(livePreviewFacet)) return Decoration.none;
  const ctx = state.facet(editorContext);
  const tree = syntaxTree(state);
  const cursor = tree.cursor();
  const decos = [];
  if (!cursor.firstChild()) return Decoration.none;
  do {
    const { name, from, to } = cursor;
    if (!isRenderedBlock(state, name, from, to)) continue;
    const text = state.doc.sliceString(from, to);
    const widget = name === 'Frontmatter' ? new PropertiesWidget(ctx, text) : new MarkdownBlockWidget(ctx, text);
    decos.push(Decoration.replace({ widget, block: true }).range(from, to));
  } while (cursor.nextSibling());
  return Decoration.set(decos, true);
}

export const blockPreview = StateField.define({
  create: (state) => buildBlocks(state),
  update(value, tr) {
    const refresh = tr.effects.some((e) => e.is(refreshEffect) || e.is(setFocusEffect));
    if (tr.docChanged || tr.selection || refresh || tr.reconfigured || syntaxTree(tr.state) !== syntaxTree(tr.startState)) {
      return buildBlocks(tr.state);
    }
    return value;
  },
  provide: (field) => EditorView.decorations.from(field),
});

export const livePreviewExtensions = [focusField, focusTracker, inlinePreview, blockPreview];
