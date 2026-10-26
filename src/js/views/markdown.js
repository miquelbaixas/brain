// Vista de nota markdown: edición (vista previa en vivo o fuente) y lectura.
import { el, debounce, throttle, setIcon, countWords, isModEvent } from '../util.js';
import { FileView } from './base.js';
import { MarkdownEditor } from '../editor/editor.js';
import { renderMarkdownToElement, attachRenderedHandlers } from '../render.js';
import { parseLinkInner } from '../metadata.js';

export class MarkdownView extends FileView {
  constructor(leaf) {
    super(leaf);
    const app = this.app;
    this.mode = app.settings.get('defaultViewMode') === 'preview' ? 'preview' : 'source';
    this.buffer = null;

    // Edición
    this.sourceEl = el('div.markdown-source-view.mod-cm6', { parent: this.contentEl });
    this.scrollEl = el('div.cm-scroll-outer', { parent: this.sourceEl });
    this.sizerEl = el('div.cm-sizer', { parent: this.scrollEl });
    this.inlineTitleEl = el('div.inline-title', { attr: { contenteditable: 'true', spellcheck: 'false', tabindex: '-1' }, parent: this.sizerEl });
    this.editorHost = el('div.cm-editor-host', { parent: this.sizerEl });
    this.editor = new MarkdownEditor({
      app,
      parent: this.editorHost,
      getPath: () => (this.file ? this.file.path : ''),
      onChange: (text) => {
        if (this.buffer) this.buffer.setText(text, this);
        this.app.workspace.trigger('editor-change', this);
      },
      onFocus: () => app.workspace.setActiveLeaf(this.leaf),
      livePreview: app.settings.get('livePreview'),
      spellcheck: app.settings.get('spellcheck'),
    });
    this.editor.view.dom.addEventListener('keyup', () => this.app.workspace.trigger('editor-selection', this));
    this.editor.view.dom.addEventListener('mouseup', () => this.app.workspace.trigger('editor-selection', this));

    // Lectura
    this.previewEl = el('div.markdown-reading-view', { parent: this.contentEl });
    this.previewViewEl = el('div.markdown-preview-view.markdown-rendered', { attr: { tabindex: '-1' }, parent: this.previewEl });
    this.previewSizerEl = el('div.markdown-preview-sizer.markdown-preview-section', { parent: this.previewViewEl });
    this.previewTitleEl = el('div.inline-title', { parent: this.previewSizerEl });
    this.previewContentEl = el('div.markdown-preview-content', { parent: this.previewSizerEl });
    attachRenderedHandlers(app, this.previewContentEl, () => (this.file ? this.file.path : ''), {
      onCheckbox: (line) => this.toggleTaskLine(line),
    });

    this.modeButton = this.addAction('book-open', '', (e) => {
      if (isModEvent(e)) {
        this.app.workspace.duplicateLeaf(this.leaf, 'tab', { mode: this.mode === 'source' ? 'preview' : 'source' });
        return;
      }
      this.toggleMode();
    });

    this.setupInlineTitle();
    this.sizerEl.addEventListener('mousedown', (e) => {
      if (e.target !== this.sizerEl && e.target !== this.editorHost) return;
      const rect = this.editor.view.dom.getBoundingClientRect();
      if (e.clientY < rect.bottom) return;
      e.preventDefault();
      const end = this.editor.view.state.doc.length;
      this.editor.view.focus();
      this.editor.view.dispatch({ selection: { anchor: end } });
    });
    this.scrollEl.addEventListener('scroll', () => this.app.workspace.requestSaveLayout());
    this.previewViewEl.addEventListener('scroll', () => this.app.workspace.requestSaveLayout());

    this.renderPreviewSoon = debounce(() => this.renderPreview(), 200);
    const refreshLinks = throttle(() => {
      this.editor.refresh();
      if (this.mode === 'preview') this.renderPreviewSoon();
    }, 500);
    this.registerEvent(app.metadataCache.on('resolved', refreshLinks));
    this.registerEvent(app.vault.on('content-loaded', refreshLinks));
    this.registerEvent(app.settings.on('change', (key, value) => this.onSettingChange(key, value)));
    this.applyDisplaySettings();
  }

  getViewType() {
    return 'markdown';
  }

  getIcon() {
    return 'file-text';
  }

  setupInlineTitle() {
    const t = this.inlineTitleEl;
    t.addEventListener('keydown', (e) => {
      if (e.key === 'Enter' && !e.isComposing) {
        e.preventDefault();
        this.commitTitle(t).then(() => {
          this.editor.view.focus();
          this.editor.view.dispatch({ selection: { anchor: 0 } });
        });
      } else if (e.key === 'Escape') {
        e.preventDefault();
        t.textContent = this.file ? this.file.basename : '';
        this.editor.focus();
      } else if (e.key === 'ArrowDown') {
        e.preventDefault();
        this.editor.view.focus();
        this.editor.view.dispatch({ selection: { anchor: 0 } });
      }
    });
    t.addEventListener('blur', () => this.commitTitle(t));
    t.addEventListener('focus', () => this.app.workspace.setActiveLeaf(this.leaf));
    t.addEventListener('paste', (e) => {
      e.preventDefault();
      document.execCommand('insertText', false, e.clipboardData.getData('text/plain').replace(/\n/g, ' '));
    });
  }

  applyDisplaySettings() {
    const readable = this.app.settings.get('readableLineLength');
    this.sourceEl.classList.toggle('is-readable-line-width', readable);
    this.previewViewEl.classList.toggle('is-readable-line-width', readable);
    this.sourceEl.classList.toggle('is-live-preview', this.editor.livePreview);
  }

  onSettingChange(key, value) {
    if (key === 'readableLineLength') this.applyDisplaySettings();
    if (key === 'livePreview') this.setLivePreview(value);
    if (key === 'spellcheck') this.editor.setSpellcheck(value);
  }

  /* ---------------------------------------------------------- Archivo */

  async onLoadFile(file, state = {}) {
    this.buffer = await this.app.docs.acquire(file.path, this);
    if (this.file !== file) return;
    this.editor.setText(this.buffer.text);
    this.updateTitles();
    if (state.mode === 'preview' || state.mode === 'source') this.mode = state.mode;
    if (state.source != null) this.setLivePreview(!state.source);
    this.applyMode();
    if (state.scroll != null) this.restoreScroll(state.scroll);
  }

  async onUnloadFile(file) {
    this.app.docs.release(file.path, this);
    this.buffer = null;
  }

  getState() {
    const state = super.getState();
    state.mode = this.mode;
    state.source = !this.editor.livePreview;
    state.scroll = Math.round(this.mode === 'preview' ? this.previewViewEl.scrollTop : this.scrollEl.scrollTop);
    return state;
  }

  async setState(state) {
    const sameFile = this.file && state.file === this.file.path && this.loaded;
    await super.setState(state);
    if (sameFile) {
      if (state.mode && state.mode !== this.mode) this.setMode(state.mode);
      if (state.scroll != null) this.restoreScroll(state.scroll);
    }
  }

  restoreScroll(scroll) {
    requestAnimationFrame(() => {
      if (this.mode === 'preview') this.previewViewEl.scrollTop = scroll;
      else this.scrollEl.scrollTop = scroll;
    });
  }

  setEphemeralState(eState = {}) {
    if (eState.rename) {
      if (this.mode !== 'source') this.setMode('source');
      requestAnimationFrame(() => {
        this.inlineTitleEl.focus();
        const range = document.createRange();
        range.selectNodeContents(this.inlineTitleEl);
        const sel = window.getSelection();
        sel.removeAllRanges();
        sel.addRange(range);
      });
      return;
    }
    if (eState.subpath) {
      this.scrollToSubpath(eState.subpath);
      return;
    }
    if (eState.match) {
      if (this.mode === 'source') {
        requestAnimationFrame(() => {
          this.editor.selectRange(eState.match.from, eState.match.to);
          this.editor.focus();
        });
      } else {
        this.scrollPreviewToLine(eState.line || 0);
      }
      return;
    }
    if (eState.line != null) {
      if (this.mode === 'source') requestAnimationFrame(() => this.editor.scrollToLine(eState.line));
      else this.scrollPreviewToLine(eState.line);
      return;
    }
    if (eState.focus) this.focus();
  }

  scrollToSubpath(subpath) {
    const text = this.buffer ? this.buffer.text : '';
    let line = -1;
    if (subpath.startsWith('^')) {
      const id = subpath.slice(1);
      line = text.split('\n').findIndex((l) => new RegExp('\\s\\^' + id.replace(/[.*+?^${}()|[\]\\]/g, '\\$&') + '\\s*$').test(l));
    } else {
      const target = subpath.split('#').pop().trim().toLowerCase();
      line = text.split('\n').findIndex((l) => {
        const m = /^#{1,6}\s+(.*?)\s*#*\s*$/.exec(l);
        return m && m[1].trim().toLowerCase() === target;
      });
    }
    if (line < 0) return;
    if (this.mode === 'source') requestAnimationFrame(() => this.editor.scrollToLine(line));
    else this.scrollPreviewToLine(line);
  }

  scrollPreviewToLine(line) {
    requestAnimationFrame(() => {
      let best = null;
      for (const node of this.previewContentEl.querySelectorAll('[data-line]')) {
        const n = Number(node.getAttribute('data-line'));
        if (n <= line && (!best || n >= Number(best.getAttribute('data-line')))) best = node;
      }
      if (best) {
        best.scrollIntoView({ block: 'start' });
        this.previewViewEl.scrollTop -= 20;
        best.classList.add('is-flashing');
        setTimeout(() => best.classList.remove('is-flashing'), 1400);
      }
    });
  }

  onBufferChanged(text) {
    this.editor.applyExternalText(text);
    if (this.mode === 'preview') this.renderPreviewSoon();
  }

  onFileRenamed() {
    this.updateTitles();
    super.onFileRenamed();
  }

  updateTitles() {
    const name = this.file ? this.file.basename : '';
    if (document.activeElement !== this.inlineTitleEl) this.inlineTitleEl.textContent = name;
    this.previewTitleEl.textContent = name;
  }

  /* ------------------------------------------------------------ Modos */

  setMode(mode) {
    if (mode === this.mode) return;
    const wasFocused = this.containerEl.contains(document.activeElement);
    this.mode = mode;
    this.applyMode();
    if (wasFocused) this.focus();
    this.app.workspace.requestSaveLayout();
    this.app.workspace.trigger('layout-change');
  }

  applyMode() {
    const preview = this.mode === 'preview';
    this.containerEl.classList.toggle('is-read-mode', preview);
    this.sourceEl.style.display = preview ? 'none' : '';
    this.previewEl.style.display = preview ? '' : 'none';
    if (preview) this.renderPreview();
    setIcon(this.modeButton, preview ? 'pencil' : 'book-open');
    this.modeButton.setAttribute('aria-label', preview
      ? 'Vista actual: lectura\nClic para editar\n⌘ + clic para abrir en una pestaña nueva'
      : 'Vista actual: edición\nClic para leer\n⌘ + clic para abrir en una pestaña nueva');
  }

  toggleMode() {
    this.setMode(this.mode === 'source' ? 'preview' : 'source');
    this.focus();
  }

  setLivePreview(enabled) {
    if (this.editor.livePreview === enabled) return;
    this.editor.setLivePreview(enabled);
    this.applyDisplaySettings();
    this.app.workspace.requestSaveLayout();
    this.app.workspace.trigger('layout-change');
  }

  renderPreview() {
    if (!this.file || !this.buffer) return;
    const scroll = this.previewViewEl.scrollTop;
    renderMarkdownToElement(this.app, this.buffer.text, this.file.path, this.previewContentEl);
    this.previewViewEl.scrollTop = scroll;
  }

  toggleTaskLine(line) {
    if (!this.buffer) return;
    const lines = this.buffer.text.split('\n');
    if (line < 0 || line >= lines.length) return;
    lines[line] = lines[line].replace(/^(\s*(?:[-*+]|\d+[.)])\s+\[)(.)(\])/, (_m, a, c, b) => a + (c === ' ' ? 'x' : ' ') + b);
    this.buffer.setText(lines.join('\n'), null);
  }

  focus() {
    if (this.mode === 'source') this.editor.focus();
    else this.previewViewEl.focus({ preventScroll: true });
  }

  /* ------------------------------------------------------- Consultas */

  getText() {
    return this.buffer ? this.buffer.text : '';
  }

  getSelectionText() {
    if (this.mode !== 'source') return '';
    const { state } = this.editor.view;
    return state.selection.ranges.map((r) => state.sliceDoc(r.from, r.to)).join('\n');
  }

  getWordStats() {
    const selection = this.getSelectionText();
    const text = selection || this.getText();
    return { words: countWords(text), characters: text.length, selection: !!selection };
  }

  onPaneMenu(menu, source) {
    super.onPaneMenu(menu, source);
    if (source === 'more-options') {
      menu.addSeparator();
      menu.addItem((i) => i.setTitle(this.mode === 'source' ? 'Vista de lectura' : 'Vista de edición').setIcon(this.mode === 'source' ? 'book-open' : 'pencil').onClick(() => this.toggleMode()));
      menu.addItem((i) => i.setTitle('Modo fuente').setIcon('file-code').setChecked(!this.editor.livePreview).onClick(() => this.setLivePreview(!this.editor.livePreview)));
      menu.addItem((i) => i.setTitle('Buscar en la nota…').setIcon('search').onClick(() => {
        if (this.mode !== 'source') this.setMode('source');
        this.editor.openSearch();
      }));
    }
  }

  async onClose() {
    this.editor.destroy();
    await super.onClose();
  }

  // Inserta texto en la posición del cursor (por ejemplo, un enlace).
  insertText(text) {
    const view = this.editor.view;
    view.dispatch(view.state.replaceSelection(text));
    view.focus();
  }

  linkUnderCursor() {
    const view = this.editor.view;
    const pos = view.state.selection.main.head;
    const line = view.state.doc.lineAt(pos);
    const re = /\[\[([^\]]+)\]\]/g;
    let m;
    while ((m = re.exec(line.text))) {
      if (line.from + m.index <= pos && pos <= line.from + m.index + m[0].length) return parseLinkInner(m[1]);
    }
    return null;
  }
}
