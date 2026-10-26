// Editor de markdown basado en CodeMirror 6 con el comportamiento de Obsidian.
import { EditorState, Compartment, Annotation, EditorSelection } from '@codemirror/state';
import { EditorView, keymap, drawSelection, dropCursor, rectangularSelection, crosshairCursor, tooltips } from '@codemirror/view';
import { defaultKeymap, history, historyKeymap, indentWithTab, undo, redo } from '@codemirror/commands';
import { syntaxHighlighting, HighlightStyle, indentUnit, syntaxTree } from '@codemirror/language';
import { markdown, commonmarkLanguage, markdownKeymap } from '@codemirror/lang-markdown';
import { GFM } from '@lezer/markdown';
import { languages } from '@codemirror/language-data';
import { autocompletion, closeBrackets, closeBracketsKeymap, completionKeymap } from '@codemirror/autocomplete';
import { search, searchKeymap, openSearchPanel } from '@codemirror/search';
import { tags as t, classHighlighter } from '@lezer/highlight';
import { brainMarkdownExtensions } from './syntax.js';
import { livePreviewExtensions, editorContext, livePreviewFacet, refreshEffect } from './live-preview.js';
import { foldingExtensions } from './folding.js';
import { fuzzyMatch, isModEvent, dirname } from '../util.js';
import { parseLinkInner } from '../metadata.js';
import { linkTargetFromEvent, showLinkMenu } from '../render.js';

export const remoteChange = Annotation.define();

const markdownHighlight = HighlightStyle.define([
  { tag: t.strong, class: 'cm-strong' },
  { tag: t.emphasis, class: 'cm-em' },
  { tag: t.strikethrough, class: 'cm-strikethrough' },
  { tag: t.processingInstruction, class: 'cm-formatting' },
  { tag: t.contentSeparator, class: 'cm-formatting' },
]);

/* --------------------------------------------------------- Comandos */

function toggleWrap(mark) {
  return (view) => {
    const { state } = view;
    const changes = state.changeByRange((range) => {
      const text = state.sliceDoc(range.from, range.to);
      const before = state.sliceDoc(range.from - mark.length, range.from);
      const after = state.sliceDoc(range.to, range.to + mark.length);
      if (before === mark && after === mark) {
        return {
          changes: [{ from: range.from - mark.length, to: range.from }, { from: range.to, to: range.to + mark.length }],
          range: EditorSelection.range(range.from - mark.length, range.to - mark.length),
        };
      }
      if (text.startsWith(mark) && text.endsWith(mark) && text.length >= mark.length * 2) {
        return {
          changes: { from: range.from, to: range.to, insert: text.slice(mark.length, text.length - mark.length) },
          range: EditorSelection.range(range.from, range.to - mark.length * 2),
        };
      }
      return {
        changes: [{ from: range.from, insert: mark }, { from: range.to, insert: mark }],
        range: EditorSelection.range(range.from + mark.length, range.to + mark.length),
      };
    });
    view.dispatch(state.update(changes, { scrollIntoView: true, userEvent: 'input' }));
    return true;
  };
}

function insertMarkdownLink(view) {
  const { state } = view;
  const range = state.selection.main;
  const text = state.sliceDoc(range.from, range.to);
  if (/^https?:\/\/\S+$/.test(text)) {
    view.dispatch({ changes: { from: range.from, to: range.to, insert: `[](${text})` }, selection: { anchor: range.from + 1 } });
  } else {
    view.dispatch({
      changes: { from: range.from, to: range.to, insert: `[${text}]()` },
      selection: { anchor: range.from + text.length + 3 },
    });
  }
  return true;
}

function toggleChecklist(view) {
  const { state } = view;
  const lines = new Set();
  for (const r of state.selection.ranges) {
    for (let pos = r.from; pos <= r.to; ) {
      const line = state.doc.lineAt(pos);
      lines.add(line.number);
      pos = line.to + 1;
    }
  }
  const changes = [];
  for (const n of lines) {
    const line = state.doc.line(n);
    const m = /^(\s*)([-*+]|\d+[.)])(\s+)(\[(.)\]\s)?/.exec(line.text);
    if (m && m[4]) {
      const pos = line.from + m[1].length + m[2].length + m[3].length + 1;
      changes.push({ from: pos, to: pos + 1, insert: m[5] === ' ' ? 'x' : ' ' });
    } else if (m) {
      const pos = line.from + m[0].length;
      changes.push({ from: pos, insert: '[ ] ' });
    } else {
      const indent = /^\s*/.exec(line.text)[0].length;
      changes.push({ from: line.from + indent, insert: '- [ ] ' });
    }
  }
  view.dispatch({ changes, userEvent: 'input' });
  return true;
}

function linkAtCursor(view) {
  const pos = view.state.selection.main.head;
  let node = syntaxTree(view.state).resolveInner(pos, -1);
  for (; node; node = node.parent) {
    if (node.name === 'WikiLink' || node.name === 'Embed') {
      const target = node.getChild('WikiLinkTarget');
      return target ? { href: view.state.sliceDoc(target.from, target.to) } : null;
    }
    if (node.name === 'Link') {
      const url = node.getChild('URL');
      if (!url) return null;
      const text = view.state.sliceDoc(url.from, url.to);
      return /^[a-z][a-z0-9+.-]*:/i.test(text) ? { url: text } : { href: decodeURIComponent(text) };
    }
    if (node.name === 'URL') return { url: view.state.sliceDoc(node.from, node.to) };
  }
  return null;
}

/* -------------------------------------------------------- Autocompletado */

function linkCompletions(ctxRef) {
  return (context) => {
    const { app, getPath } = ctxRef();
    const line = context.state.doc.lineAt(context.pos);
    const before = line.text.slice(0, context.pos - line.from);
    const after = line.text.slice(context.pos - line.from);
    const closeAfter = after.startsWith(']]');

    const finish = (insert) => (view, _completion, from, to) => {
      const end = closeAfter ? to + 2 : to;
      const text = insert + ']]';
      view.dispatch({
        changes: { from, to: end, insert: text },
        selection: { anchor: from + text.length },
        userEvent: 'input.complete',
      });
    };

    // Encabezados: [[Nota#
    let m = /\[\[([^\[\]|#^\n]*)#([^\[\]|#\n]*)$/.exec(before);
    if (m) {
      const file = m[1] ? app.metadataCache.getFirstLinkpathDest(m[1], getPath()) : app.vault.getFile(getPath());
      if (!file) return null;
      const query = m[2];
      const options = app.metadataCache.getHeadings(file.path)
        .map((h) => ({ h, match: fuzzyMatch(query, h.heading) }))
        .filter((x) => x.match)
        .sort((a, b) => b.match.score - a.match.score)
        .slice(0, 50)
        .map(({ h }) => ({ label: h.heading, detail: 'H' + h.level, apply: finish(`${m[1]}#${h.heading}`) }));
      return { from: context.pos - query.length - m[1].length - 1, options: options.map((o) => ({ ...o, label: o.label })), filter: false };
    }

    // Notas y archivos: [[
    m = /!?\[\[([^\[\]|#^\n]*)$/.exec(before);
    if (m) {
      const query = m[1];
      const from = context.pos - query.length;
      const sourcePath = getPath();
      const scored = [];
      for (const file of app.vault.getFiles()) {
        const name = file.extension === 'md' ? file.basename : file.name;
        const nameMatch = fuzzyMatch(query, name);
        const pathMatch = query.includes('/') ? fuzzyMatch(query, file.path) : null;
        const best = nameMatch && (!pathMatch || nameMatch.score >= pathMatch.score) ? nameMatch : pathMatch;
        if (best) scored.push({ file, name, score: best.score + (file.extension === 'md' ? 5 : 0) });
        for (const alias of file.extension === 'md' ? app.metadataCache.getAliases(file.path) : []) {
          const am = fuzzyMatch(query, alias);
          if (am) scored.push({ file, name: alias, alias: true, score: am.score - 1 });
        }
      }
      scored.sort((a, b) => b.score - a.score || a.name.localeCompare(b.name));
      const options = scored.slice(0, 60).map(({ file, name, alias }) => {
        const linktext = app.metadataCache.fileToLinktext(file, sourcePath);
        const folder = dirname(file.path);
        return {
          label: name,
          detail: alias ? file.basename : folder || undefined,
          apply: finish(alias ? `${linktext}|${name}` : linktext),
        };
      });
      if (query.trim() && !scored.some((s) => s.name.toLowerCase() === query.trim().toLowerCase())) {
        options.push({ label: query.trim(), detail: 'Enlace a una nota que todavía no existe', apply: finish(query.trim()) });
      }
      return { from, options, filter: false };
    }

    // Etiquetas: #eti
    m = /(?:^|[\s,;(])#([\p{L}\p{N}_\-/]*)$/u.exec(before);
    if (m && context.explicit !== undefined) {
      const query = m[1];
      if (!query && !context.explicit) return null;
      const options = app.metadataCache.getTags()
        .map((tag) => ({ tag, match: fuzzyMatch(query, tag.tag.slice(1)) }))
        .filter((x) => x.match)
        .sort((a, b) => b.match.score - a.match.score || b.tag.count - a.tag.count)
        .slice(0, 50)
        .map(({ tag }) => ({ label: tag.tag.slice(1), detail: String(tag.count), apply: tag.tag.slice(1) + ' ' }));
      if (!options.length) return null;
      return { from: context.pos - query.length, options, filter: false };
    }
    return null;
  };
}

/* ---------------------------------------------------------- Editor */

export class MarkdownEditor {
  constructor({ app, parent, getPath, onChange, onFocus, livePreview = true, spellcheck = true, onFollowLink }) {
    this.app = app;
    this.getPath = getPath;
    this.onChange = onChange;
    this.onFollowLink = onFollowLink;
    this.liveCompartment = new Compartment();
    this.spellCompartment = new Compartment();
    this.livePreview = livePreview;
    this.spellcheck = spellcheck;
    this.view = new EditorView({ parent, state: this.createState('') });
    this.view.contentDOM.addEventListener('focus', () => onFocus && onFocus());
  }

  extensions() {
    const ctxRef = () => ({ app: this.app, getPath: this.getPath });
    return [
      editorContext.of({ app: this.app, getPath: this.getPath }),
      this.liveCompartment.of(livePreviewFacet.of(this.livePreview)),
      this.spellCompartment.of(EditorView.contentAttributes.of({ spellcheck: this.spellcheck ? 'true' : 'false', autocorrect: 'off', autocapitalize: 'off' })),
      history(),
      drawSelection(),
      dropCursor(),
      rectangularSelection(),
      crosshairCursor(),
      EditorView.lineWrapping,
      EditorState.allowMultipleSelections.of(true),
      EditorState.tabSize.of(4),
      indentUnit.of('\t'),
      markdown({ base: commonmarkLanguage, extensions: [GFM, ...brainMarkdownExtensions], codeLanguages: languages, addKeymap: false }),
      syntaxHighlighting(markdownHighlight),
      syntaxHighlighting(classHighlighter),
      ...livePreviewExtensions,
      ...foldingExtensions,
      closeBrackets(),
      tooltips({ parent: document.body }),
      autocompletion({ override: [linkCompletions(ctxRef)], icons: false, activateOnTyping: true, closeOnBlur: true, maxRenderedOptions: 60 }),
      search({ top: true }),
      keymap.of([
        { key: 'Mod-b', run: toggleWrap('**') },
        { key: 'Mod-i', run: toggleWrap('*') },
        { key: 'Mod-Shift-x', run: toggleWrap('~~') },
        { key: 'Mod-Shift-h', run: toggleWrap('==') },
        { key: 'Mod-Shift-c', run: toggleWrap('`') },
        { key: 'Mod-k', run: insertMarkdownLink },
        { key: 'Mod-l', run: toggleChecklist },
        { key: 'Alt-Enter', run: (view) => this.followLinkAtCursor(view, false) },
        { key: 'Mod-Enter', run: (view) => this.followLinkAtCursor(view, 'tab') },
        ...closeBracketsKeymap,
        ...completionKeymap,
        ...markdownKeymap,
        ...searchKeymap,
        ...historyKeymap,
        indentWithTab,
        ...defaultKeymap,
      ]),
      EditorView.updateListener.of((update) => {
        if (!update.docChanged) return;
        const remote = update.transactions.every((tr) => tr.annotation(remoteChange));
        if (!remote && this.onChange) this.onChange(update.state.doc.toString(), update);
      }),
      EditorView.domEventHandlers({
        mousedown: (e, view) => this.handleMouseDown(e, view),
        mouseover: (e) => this.handleMouseOver(e),
        contextmenu: (e) => this.handleContextMenu(e),
        paste: (e, view) => this.handlePaste(e, view),
      }),
    ];
  }

  createState(doc) {
    return EditorState.create({ doc, extensions: this.extensions() });
  }

  setText(text) {
    this.view.setState(this.createState(text));
  }

  getText() {
    return this.view.state.doc.toString();
  }

  // Aplica un texto que viene de fuera (otra vista o el disco) conservando el cursor.
  applyExternalText(text) {
    const current = this.view.state.doc.toString();
    if (current === text) return;
    let start = 0;
    const minLen = Math.min(current.length, text.length);
    while (start < minLen && current.charCodeAt(start) === text.charCodeAt(start)) start++;
    let endA = current.length;
    let endB = text.length;
    while (endA > start && endB > start && current.charCodeAt(endA - 1) === text.charCodeAt(endB - 1)) {
      endA--;
      endB--;
    }
    this.view.dispatch({
      changes: { from: start, to: endA, insert: text.slice(start, endB) },
      annotations: [remoteChange.of(true)],
    });
  }

  setLivePreview(enabled) {
    this.livePreview = enabled;
    this.view.dispatch({ effects: this.liveCompartment.reconfigure(livePreviewFacet.of(enabled)) });
  }

  setSpellcheck(enabled) {
    this.spellcheck = enabled;
    this.view.dispatch({
      effects: this.spellCompartment.reconfigure(EditorView.contentAttributes.of({ spellcheck: enabled ? 'true' : 'false', autocorrect: 'off', autocapitalize: 'off' })),
    });
  }

  refresh() {
    this.view.dispatch({ effects: refreshEffect.of(null) });
  }

  focus() {
    this.view.focus();
  }

  undo() {
    return undo(this.view);
  }

  redo() {
    return redo(this.view);
  }

  openSearch() {
    openSearchPanel(this.view);
  }

  followLinkAtCursor(view, newLeaf) {
    const link = linkAtCursor(view);
    if (!link) return false;
    if (link.url) this.app.api.openExternal(link.url);
    else this.app.workspace.openLinkText(link.href, this.getPath(), newLeaf);
    return true;
  }

  handleMouseDown(e, view) {
    if (e.button !== 0 && e.button !== 1) return false;
    const target = e.target.closest && e.target.closest('[data-href], [data-url], [data-tag]');
    if (!target || !view.contentDOM.contains(target)) return false;
    const live = target.getAttribute('data-live') === '1';
    if (!live && !isModEvent(e) && e.button !== 1) return false;
    e.preventDefault();
    if (target.hasAttribute('data-href')) {
      this.app.workspace.openLinkText(target.getAttribute('data-href'), this.getPath(), linkTargetFromEvent(e));
    } else if (target.hasAttribute('data-url')) {
      this.app.api.openExternal(target.getAttribute('data-url'));
    } else if (target.hasAttribute('data-tag')) {
      this.app.openSearch('tag:' + target.getAttribute('data-tag'));
    }
    return true;
  }

  handleMouseOver(e) {
    if (!isModEvent(e)) return false;
    const target = e.target.closest && e.target.closest('[data-href]');
    if (target) this.app.hoverPopover.show(target, target.getAttribute('data-href'), this.getPath());
    return false;
  }

  handleContextMenu(e) {
    const target = e.target.closest && e.target.closest('[data-href]');
    if (!target) return false;
    showLinkMenu(this.app, e, target.getAttribute('data-href'), this.getPath());
    return true;
  }

  handlePaste(e, view) {
    const data = e.clipboardData;
    if (!data) return false;
    // Pegar una imagen: se guarda en la bóveda y se incrusta.
    const imageFile = [...data.files].find((f) => f.type.startsWith('image/'));
    if (imageFile) {
      e.preventDefault();
      this.app.fileManager.saveAttachment(imageFile, this.getPath()).then((file) => {
        if (!file) return;
        const link = this.app.metadataCache.fileToLinktext(file, this.getPath(), false);
        view.dispatch(view.state.replaceSelection(`![[${link}]]`));
      });
      return true;
    }
    // Pegar una URL sobre texto seleccionado crea un enlace.
    const text = data.getData('text/plain');
    const sel = view.state.selection.main;
    if (!sel.empty && /^https?:\/\/\S+$/.test(text.trim())) {
      const selected = view.state.sliceDoc(sel.from, sel.to);
      if (!/^https?:\/\//.test(selected)) {
        e.preventDefault();
        view.dispatch({ changes: { from: sel.from, to: sel.to, insert: `[${selected}](${text.trim()})` } });
        return true;
      }
    }
    return false;
  }

  scrollToLine(line, { select = false, flash = true } = {}) {
    const doc = this.view.state.doc;
    const n = Math.max(1, Math.min(doc.lines, line + 1));
    const target = doc.line(n);
    this.view.dispatch({
      selection: select ? { anchor: target.from, head: target.to } : { anchor: target.from },
      effects: EditorView.scrollIntoView(target.from, { y: 'start', yMargin: 80 }),
    });
    if (flash) this.flashLine(target.from);
  }

  selectRange(from, to) {
    this.view.dispatch({
      selection: { anchor: from, head: to },
      effects: EditorView.scrollIntoView(from, { y: 'center' }),
    });
  }

  flashLine(pos) {
    requestAnimationFrame(() => {
      const { node } = this.view.domAtPos(pos);
      const lineEl = node && (node.nodeType === 1 ? node : node.parentElement);
      const line = lineEl && lineEl.closest('.cm-line');
      if (!line) return;
      line.classList.remove('cm-flash-line');
      void line.offsetWidth;
      line.classList.add('cm-flash-line');
    });
  }

  destroy() {
    this.view.destroy();
  }
}

export { parseLinkInner };
