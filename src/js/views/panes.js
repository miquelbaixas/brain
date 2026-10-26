// Paneles laterales: búsqueda, marcadores, enlaces entrantes y salientes, etiquetas y esquema.
import { el, empty, iconButton, debounce, compareNames, escapeRegExp, isModEvent, plural } from '../util.js';
import { icon } from '../icons.js';
import { View } from './base.js';
import { Menu } from '../ui.js';
import { getContext, maskText } from '../metadata.js';

/* ------------------------------------------------------------ Ayudas */

function collapsibleHeader(parent, title, count, collapsed, onToggle) {
  const self = el('div.tree-item-self.is-clickable', { parent });
  const collapse = el('div.tree-item-icon.collapse-icon', { cls: collapsed ? 'is-collapsed' : '', parent: self }, [icon('right-triangle')]);
  el('div.tree-item-inner', { text: title, parent: self });
  if (count != null) el('div.tree-item-flair-outer', { parent: self }, [el('span.tree-item-flair', { text: String(count) })]);
  self.addEventListener('click', () => {
    const next = !collapse.classList.contains('is-collapsed');
    collapse.classList.toggle('is-collapsed', next);
    onToggle(next);
  });
  return self;
}

function renderSnippet(parent, ctx, onClick) {
  const match = el('div.search-result-file-match', { parent });
  match.appendChild(document.createTextNode(ctx.prefix + ctx.text.slice(0, ctx.matchStart)));
  el('span.search-result-file-matched-text', { text: ctx.text.slice(ctx.matchStart, ctx.matchEnd), parent: match });
  match.appendChild(document.createTextNode(ctx.text.slice(ctx.matchEnd) + ctx.suffix));
  match.addEventListener('click', (e) => onClick(e));
  return match;
}

// Bloque de resultados de un archivo (búsqueda y menciones).
function renderFileResult(view, parent, file, entries, { collapsed = false, button } = {}) {
  const item = el('div.tree-item.search-result', { cls: collapsed ? 'is-collapsed' : '', parent });
  const self = el('div.tree-item-self.search-result-file-title.is-clickable', { parent: item });
  const collapse = el('div.tree-item-icon.collapse-icon', { cls: collapsed ? 'is-collapsed' : '', parent: self }, [icon('right-triangle')]);
  el('div.tree-item-inner', { text: file.extension === 'md' ? file.basename : file.name, parent: self });
  el('div.tree-item-flair-outer', { parent: self }, [el('span.tree-item-flair', { text: String(entries.length) })]);
  collapse.addEventListener('click', (e) => {
    e.stopPropagation();
    const next = !item.classList.contains('is-collapsed');
    item.classList.toggle('is-collapsed', next);
    collapse.classList.toggle('is-collapsed', next);
  });
  self.addEventListener('click', (e) => view.app.workspace.openFile(file, isModEvent(e) ? 'tab' : false));
  self.addEventListener('contextmenu', (e) => {
    const menu = new Menu();
    view.app.addFileMenuItems(menu, file, 'search');
    menu.showAtMouseEvent(e);
  });
  self.addEventListener('mouseover', (e) => {
    if (isModEvent(e)) view.app.hoverPopover.show(self, file.path, '');
  });
  const matches = el('div.search-result-file-matches.tree-item-children', { parent: item, style: { border: 'none', padding: 0 } });
  for (const entry of entries) {
    const snippet = renderSnippet(matches, entry.ctx, (e) => {
      view.app.workspace.openFile(file, isModEvent(e) ? 'tab' : false, { eState: { match: { from: entry.start, to: entry.end }, line: entry.ctx.line } });
    });
    if (button) {
      const b = el('button.search-result-hover-button', { text: button.text, parent: snippet });
      b.addEventListener('click', (e) => {
        e.stopPropagation();
        button.onClick(entry);
      });
    }
  }
  return item;
}

/* ============================================================ Búsqueda */

function parseQuery(query) {
  const terms = [];
  const re = /(-)?(?:([a-z]+):)?(?:"([^"]*)"|(\S+))/gi;
  let m;
  while ((m = re.exec(query))) {
    let op = m[2] ? m[2].toLowerCase() : null;
    let value = m[3] != null ? m[3] : m[4];
    if (op && !['tag', 'path', 'file', 'line'].includes(op)) {
      value = m[2] + ':' + value;
      op = null;
    }
    if (!value) continue;
    if (op === 'tag') value = '#' + value.replace(/^#/, '');
    terms.push({ negate: !!m[1], op, value: value.toLowerCase() });
  }
  return terms;
}

export class SearchView extends View {
  constructor(leaf) {
    super(leaf);
    this.query = '';
    const header = el('div.nav-header', { parent: this.containerEl });
    const inputContainer = el('div.search-input-container', { parent: header });
    this.inputEl = el('input', { attr: { type: 'search', placeholder: 'Buscar…', spellcheck: 'false' }, parent: inputContainer });
    this.clearEl = el('div.search-input-clear-button', { title: 'Borrar la búsqueda', parent: inputContainer }, [icon('x')]);
    this.clearEl.addEventListener('click', () => this.setQuery(''));
    this.inputEl.addEventListener('input', () => {
      this.query = this.inputEl.value;
      this.searchSoon();
    });
    this.inputEl.addEventListener('keydown', (e) => {
      if (e.key === 'Enter') this.search();
    });
    this.infoEl = el('div.search-result-info', { parent: this.containerEl });
    this.resultsEl = el('div.search-result-container', { parent: this.containerEl });
    this.searchSoon = debounce(() => this.search(), 250);
    this.registerEvent(this.app.metadataCache.on('resolved', () => {
      if (this.query && this.leaf.containerEl.classList.contains('is-visible')) this.searchSoon();
    }));
    this.containerEl.style.display = 'flex';
    this.containerEl.style.flexDirection = 'column';
    this.updateClear();
  }

  getViewType() {
    return 'search';
  }

  getDisplayText() {
    return 'Buscar';
  }

  getIcon() {
    return 'search';
  }

  getState() {
    return { query: this.query };
  }

  async setState(state) {
    if (state && typeof state.query === 'string') this.setQuery(state.query, false);
  }

  focus() {
    this.inputEl.focus();
    this.inputEl.select();
  }

  onShow() {
    if (this.query) this.search();
  }

  setQuery(query, focus = true) {
    this.query = query;
    this.inputEl.value = query;
    this.search();
    if (focus) this.inputEl.focus();
  }

  updateClear() {
    this.clearEl.style.display = this.query ? '' : 'none';
  }

  search() {
    this.updateClear();
    empty(this.resultsEl);
    empty(this.infoEl);
    this.app.workspace.requestSaveLayout();
    const terms = parseQuery(this.query.trim());
    if (!terms.length) return;
    const mc = this.app.metadataCache;
    const results = [];
    for (const file of this.app.vault.getMarkdownFiles()) {
      const text = this.app.vault.getContent(file.path) || '';
      const lower = text.toLowerCase();
      const tags = (mc.getFileCache(file.path) || { tags: [] }).tags;
      const entries = [];
      let ok = true;
      for (const term of terms) {
        let hit = false;
        if (term.op === 'path') hit = file.path.toLowerCase().includes(term.value);
        else if (term.op === 'file') hit = file.name.toLowerCase().includes(term.value);
        else if (term.op === 'tag') {
          const matching = tags.filter((t) => t.tag.toLowerCase() === term.value || t.tag.toLowerCase().startsWith(term.value + '/'));
          hit = matching.length > 0;
          if (hit && !term.negate) {
            for (const t of matching) if (t.position) entries.push({ start: t.position.start, end: t.position.end });
          }
        } else {
          let idx = lower.indexOf(term.value);
          hit = idx >= 0 || file.basename.toLowerCase().includes(term.value);
          if (!term.negate) {
            let n = 0;
            while (idx >= 0 && n < 100) {
              entries.push({ start: idx, end: idx + term.value.length });
              idx = lower.indexOf(term.value, idx + term.value.length);
              n += 1;
            }
          }
        }
        if (term.negate ? hit : !hit) {
          ok = false;
          break;
        }
      }
      if (!ok) continue;
      entries.sort((a, b) => a.start - b.start);
      const seenLines = new Set();
      const shown = [];
      for (const entry of entries) {
        const ctx = getContext(text, entry.start, entry.end);
        if (seenLines.has(ctx.line)) continue;
        seenLines.add(ctx.line);
        shown.push({ ...entry, ctx });
      }
      results.push({ file, entries: shown });
    }
    results.sort((a, b) => compareNames(a.file.basename, b.file.basename));
    el('div', { text: results.length ? plural(results.length, 'resultado', 'resultados') : 'No se encontraron resultados.', parent: this.infoEl });
    const collapseAll = iconButton('chevrons-down-up', 'Contraer resultados', () => {
      for (const item of this.resultsEl.querySelectorAll('.search-result')) {
        item.classList.add('is-collapsed');
        item.querySelector('.collapse-icon').classList.add('is-collapsed');
      }
    });
    if (results.length) this.infoEl.appendChild(collapseAll);
    for (const r of results.slice(0, 300)) renderFileResult(this, this.resultsEl, r.file, r.entries);
  }
}

/* ============================================================ Marcadores */

export class BookmarksView extends View {
  constructor(leaf) {
    super(leaf);
    this.listEl = el('div.nav-files-container', { parent: this.containerEl, style: { paddingTop: '8px' } });
    this.registerEvent(this.app.bookmarks.on('changed', () => this.render()));
    this.registerEvent(this.app.workspace.on('file-open', () => this.render()));
  }

  getViewType() {
    return 'bookmarks';
  }

  getDisplayText() {
    return 'Marcadores';
  }

  getIcon() {
    return 'bookmark';
  }

  async onOpen() {
    this.render();
  }

  render() {
    empty(this.listEl);
    const items = this.app.bookmarks.items;
    if (!items.length) {
      el('div.pane-empty', { text: 'Todavía no tienes marcadores. Añade una nota desde su menú «Más opciones» o con el botón derecho en el explorador.', parent: this.listEl });
      return;
    }
    const active = this.app.workspace.getLastActiveFile();
    for (const bookmark of items) {
      const item = this.app.vault.getAbstractFileByPath(bookmark.path);
      const self = el('div.tree-item-self.is-clickable.bookmark', { cls: active && item === active ? 'is-active' : '', parent: el('div.tree-item', { parent: this.listEl }) });
      el('div.tree-item-icon', { parent: self }, [icon(!item ? 'file-question' : item.isFolder ? 'folder' : 'file-text')]);
      el('div.tree-item-inner', { text: item ? (item.isFolder ? item.name : item.extension === 'md' ? item.basename : item.name) : bookmark.path, parent: self });
      self.addEventListener('click', (e) => {
        if (!item) return;
        if (item.isFolder) this.app.revealInExplorer(item.path);
        else this.app.workspace.openFile(item, isModEvent(e) ? 'tab' : false);
      });
      self.addEventListener('contextmenu', (e) => {
        const menu = new Menu();
        if (item && !item.isFolder) {
          menu.addItem((i) => i.setTitle('Abrir en una pestaña nueva').setIcon('file-plus').onClick(() => this.app.workspace.openFile(item, 'tab')));
          menu.addItem((i) => i.setTitle('Abrir a la derecha').setIcon('separator-vertical').onClick(() => this.app.workspace.openFile(item, 'split')));
          menu.addSeparator();
        }
        menu.addItem((i) => i.setTitle('Quitar de marcadores').setIcon('bookmark-minus').onClick(() => this.app.bookmarks.remove(bookmark.path)));
        menu.showAtMouseEvent(e);
      });
    }
  }
}

/* ===================================================== Enlaces entrantes */

export class BacklinkView extends View {
  constructor(leaf) {
    super(leaf);
    this.collapsedLinked = false;
    this.collapsedUnlinked = true;
    this.collapseResults = false;
    const header = el('div.nav-header', { parent: this.containerEl });
    const buttons = el('div.nav-buttons-container', { parent: header });
    this.collapseButton = iconButton('chevrons-down-up', 'Contraer resultados', () => {
      this.collapseResults = !this.collapseResults;
      this.collapseButton.classList.toggle('is-active', this.collapseResults);
      this.render();
    }, 'nav-action-button');
    buttons.appendChild(this.collapseButton);
    this.paneEl = el('div.backlink-pane.side-pane-scroll', { parent: this.containerEl, style: { height: 'calc(100% - 48px)' } });
    this.renderSoon = debounce(() => this.render(), 250);
    this.registerEvent(this.app.workspace.on('file-open', () => this.renderSoon()));
    this.registerEvent(this.app.metadataCache.on('resolved', () => this.renderSoon()));
  }

  getViewType() {
    return 'backlink';
  }

  getDisplayText() {
    return 'Enlaces entrantes';
  }

  getIcon() {
    return 'links-coming-in';
  }

  getState() {
    return { collapseUnlinked: this.collapsedUnlinked, collapseLinked: this.collapsedLinked };
  }

  async setState(state) {
    if (state.collapseUnlinked != null) this.collapsedUnlinked = state.collapseUnlinked;
    if (state.collapseLinked != null) this.collapsedLinked = state.collapseLinked;
    this.render();
  }

  onShow() {
    this.render();
  }

  render() {
    if (!this.leaf.containerEl.classList.contains('is-visible') && this.rendered) return;
    this.rendered = true;
    empty(this.paneEl);
    const file = this.app.workspace.getLastActiveFile();
    if (!file || file.extension !== 'md') {
      el('div.pane-empty', { text: 'No hay ninguna nota activa.', parent: this.paneEl });
      return;
    }
    const mc = this.app.metadataCache;
    const backlinks = mc.getBacklinksForFile(file.path);
    const sources = [...backlinks.keys()].filter((p) => p !== file.path).sort((a, b) => compareNames(a, b));
    const linkedContainer = el('div.search-result-container');
    collapsibleHeader(this.paneEl, 'Menciones enlazadas', sources.length, this.collapsedLinked, (collapsed) => {
      this.collapsedLinked = collapsed;
      linkedContainer.style.display = collapsed ? 'none' : '';
      this.app.workspace.requestSaveLayout();
    });
    this.paneEl.appendChild(linkedContainer);
    linkedContainer.style.display = this.collapsedLinked ? 'none' : '';
    if (!sources.length) el('div.search-empty-state', { text: 'No se encontraron enlaces entrantes.', parent: linkedContainer });
    for (const source of sources) {
      const sourceFile = this.app.vault.getFile(source);
      if (!sourceFile) continue;
      const text = this.app.vault.getContent(source) || '';
      const entries = backlinks.get(source).map((link) => ({
        start: link.position.start,
        end: link.position.end,
        ctx: getContext(text, link.position.start, link.position.end),
      }));
      renderFileResult(this, linkedContainer, sourceFile, entries, { collapsed: this.collapseResults });
    }

    const unlinkedContainer = el('div.search-result-container');
    const renderUnlinked = () => {
      empty(unlinkedContainer);
      const mentions = mc.getUnlinkedMentions(file);
      const paths = [...mentions.keys()].sort((a, b) => compareNames(a, b));
      unlinkedHeader.querySelector('.tree-item-flair').textContent = String(paths.length);
      if (!paths.length) el('div.search-empty-state', { text: 'No se encontraron menciones sin enlazar.', parent: unlinkedContainer });
      for (const path of paths) {
        const sourceFile = this.app.vault.getFile(path);
        const text = this.app.vault.getContent(path) || '';
        const entries = mentions.get(path).map((m) => ({ start: m.position.start, end: m.position.end, text: m.text, ctx: getContext(text, m.position.start, m.position.end) }));
        renderFileResult(this, unlinkedContainer, sourceFile, entries, {
          collapsed: this.collapseResults,
          button: { text: 'Enlazar', onClick: (entry) => this.linkMention(sourceFile, entry, file) },
        });
      }
    };
    const unlinkedHeader = collapsibleHeader(this.paneEl, 'Menciones no enlazadas', '', this.collapsedUnlinked, (collapsed) => {
      this.collapsedUnlinked = collapsed;
      unlinkedContainer.style.display = collapsed ? 'none' : '';
      if (!collapsed) renderUnlinked();
      this.app.workspace.requestSaveLayout();
    });
    this.paneEl.appendChild(unlinkedContainer);
    unlinkedContainer.style.display = this.collapsedUnlinked ? 'none' : '';
    if (!this.collapsedUnlinked) renderUnlinked();
  }

  async linkMention(sourceFile, entry, target) {
    const text = await this.app.docs.getText(sourceFile.path);
    if (text.slice(entry.start, entry.end) !== entry.text) return;
    const linktext = this.app.metadataCache.fileToLinktext(target, sourceFile.path);
    const insert = entry.text === linktext ? `[[${linktext}]]` : `[[${linktext}|${entry.text}]]`;
    await this.app.docs.writeText(sourceFile.path, text.slice(0, entry.start) + insert + text.slice(entry.end));
  }
}

/* ===================================================== Enlaces salientes */

export class OutgoingLinkView extends View {
  constructor(leaf) {
    super(leaf);
    this.paneEl = el('div.backlink-pane.side-pane-scroll', { parent: this.containerEl, style: { height: '100%', paddingTop: '4px' } });
    this.renderSoon = debounce(() => this.render(), 250);
    this.registerEvent(this.app.workspace.on('file-open', () => this.renderSoon()));
    this.registerEvent(this.app.metadataCache.on('resolved', () => this.renderSoon()));
    this.collapsedLinks = false;
    this.collapsedUnlinked = true;
  }

  getViewType() {
    return 'outgoing-link';
  }

  getDisplayText() {
    return 'Enlaces salientes';
  }

  getIcon() {
    return 'links-going-out';
  }

  onShow() {
    this.render();
  }

  render() {
    if (!this.leaf.containerEl.classList.contains('is-visible') && this.rendered) return;
    this.rendered = true;
    empty(this.paneEl);
    const file = this.app.workspace.getLastActiveFile();
    if (!file || file.extension !== 'md') {
      el('div.pane-empty', { text: 'No hay ninguna nota activa.', parent: this.paneEl });
      return;
    }
    const parsed = this.app.metadataCache.getFileCache(file.path);
    const seen = new Map();
    for (const link of parsed ? [...parsed.links, ...parsed.embeds] : []) {
      if (!link.linkpath) continue;
      const key = link.resolved || 'unresolved:' + link.linkpath.toLowerCase();
      if (!seen.has(key)) seen.set(key, link);
    }
    const links = [...seen.values()].sort((a, b) => (a.resolved ? 0 : 1) - (b.resolved ? 0 : 1) || compareNames(a.linkpath, b.linkpath));
    const list = el('div');
    collapsibleHeader(this.paneEl, 'Enlaces', links.length, this.collapsedLinks, (collapsed) => {
      this.collapsedLinks = collapsed;
      list.style.display = collapsed ? 'none' : '';
    });
    this.paneEl.appendChild(list);
    list.style.display = this.collapsedLinks ? 'none' : '';
    if (!links.length) el('div.search-empty-state', { text: 'Esta nota no tiene enlaces salientes.', parent: list });
    for (const link of links) {
      const target = link.resolved ? this.app.vault.getFile(link.resolved) : null;
      const self = el('div.tree-item-self.is-clickable.outgoing-link-item', { cls: target ? '' : 'is-unresolved', parent: el('div.tree-item', { parent: list }) });
      el('div.tree-item-icon', { parent: self }, [icon(target ? (target.extension === 'md' ? 'file-text' : 'file') : 'file-plus')]);
      el('div.tree-item-inner', { text: target ? (target.extension === 'md' ? target.basename : target.name) : link.linkpath, parent: self });
      if (!target) self.setAttribute('aria-label', 'Nota no creada todavía. Clic para crearla.');
      self.addEventListener('click', (e) => this.app.workspace.openLinkText(link.link, file.path, isModEvent(e) ? 'tab' : false));
      self.addEventListener('mouseover', (e) => {
        if (target && isModEvent(e)) this.app.hoverPopover.show(self, target.path, '');
      });
    }

    const unlinked = el('div.search-result-container');
    const renderUnlinked = () => {
      empty(unlinked);
      const text = this.app.vault.getContent(file.path) || '';
      const masked = maskText(text, { links: true });
      const linked = new Set(links.map((l) => l.resolved).filter(Boolean));
      let count = 0;
      for (const other of this.app.vault.getMarkdownFiles()) {
        if (other === file || linked.has(other.path) || other.basename.length < 3) continue;
        const re = new RegExp('(?<![\\p{L}\\p{N}_])' + escapeRegExp(other.basename) + '(?![\\p{L}\\p{N}_])', 'giu');
        const entries = [];
        let m;
        while ((m = re.exec(masked)) && entries.length < 20) {
          entries.push({ start: m.index, end: m.index + m[0].length, text: text.slice(m.index, m.index + m[0].length), ctx: getContext(text, m.index, m.index + m[0].length) });
        }
        if (!entries.length) continue;
        count += 1;
        const result = renderFileResult(this, unlinked, other, entries, {
          button: { text: 'Enlazar', onClick: (entry) => this.linkMention(file, entry, other) },
        });
        result.querySelector('.search-result-file-title').onclick = (e) => this.app.workspace.openFile(other, isModEvent(e) ? 'tab' : false);
        for (const match of result.querySelectorAll('.search-result-file-match')) {
          const entry = entries[[...result.querySelectorAll('.search-result-file-match')].indexOf(match)];
          match.onclick = () => this.app.workspace.openFile(file, false, { eState: { match: { from: entry.start, to: entry.end }, line: entry.ctx.line } });
        }
      }
      unlinkedHeader.querySelector('.tree-item-flair').textContent = String(count);
      if (!count) el('div.search-empty-state', { text: 'No se encontraron menciones sin enlazar.', parent: unlinked });
    };
    const unlinkedHeader = collapsibleHeader(this.paneEl, 'Menciones no enlazadas', '', this.collapsedUnlinked, (collapsed) => {
      this.collapsedUnlinked = collapsed;
      unlinked.style.display = collapsed ? 'none' : '';
      if (!collapsed) renderUnlinked();
    });
    this.paneEl.appendChild(unlinked);
    unlinked.style.display = this.collapsedUnlinked ? 'none' : '';
    if (!this.collapsedUnlinked) renderUnlinked();
  }

  async linkMention(file, entry, target) {
    const text = await this.app.docs.getText(file.path);
    if (text.slice(entry.start, entry.end) !== entry.text) return;
    const linktext = this.app.metadataCache.fileToLinktext(target, file.path);
    const insert = entry.text === linktext ? `[[${linktext}]]` : `[[${linktext}|${entry.text}]]`;
    await this.app.docs.writeText(file.path, text.slice(0, entry.start) + insert + text.slice(entry.end));
  }
}

/* ============================================================ Etiquetas */

export class TagView extends View {
  constructor(leaf) {
    super(leaf);
    this.sort = 'frequency';
    this.collapsed = new Set();
    const header = el('div.nav-header', { parent: this.containerEl });
    const buttons = el('div.nav-buttons-container', { parent: header });
    this.sortButton = iconButton('arrow-up-narrow-wide', 'Cambiar el orden', () => {
      const menu = new Menu();
      menu.addItem((i) => i.setTitle('Nombre (A a Z)').setChecked(this.sort === 'name').onClick(() => this.setSort('name')));
      menu.addItem((i) => i.setTitle('Nombre (Z a A)').setChecked(this.sort === 'nameReverse').onClick(() => this.setSort('nameReverse')));
      menu.addItem((i) => i.setTitle('Frecuencia (mayor primero)').setChecked(this.sort === 'frequency').onClick(() => this.setSort('frequency')));
      menu.addItem((i) => i.setTitle('Frecuencia (menor primero)').setChecked(this.sort === 'frequencyReverse').onClick(() => this.setSort('frequencyReverse')));
      menu.showBelow(this.sortButton);
    }, 'nav-action-button');
    buttons.appendChild(this.sortButton);
    this.listEl = el('div.nav-files-container.tag-container', { parent: this.containerEl });
    this.renderSoon = debounce(() => this.render(), 300);
    this.registerEvent(this.app.metadataCache.on('resolved', () => this.renderSoon()));
  }

  getViewType() {
    return 'tag';
  }

  getDisplayText() {
    return 'Etiquetas';
  }

  getIcon() {
    return 'tags';
  }

  getState() {
    return { sort: this.sort };
  }

  async setState(state) {
    if (state.sort) this.sort = state.sort;
    this.render();
  }

  setSort(sort) {
    this.sort = sort;
    this.render();
    this.app.workspace.requestSaveLayout();
  }

  render() {
    empty(this.listEl);
    const tags = this.app.metadataCache.getTags();
    if (!tags.length) {
      el('div.pane-empty', { text: 'No hay etiquetas en la bóveda. Escribe #etiqueta en cualquier nota.', parent: this.listEl });
      return;
    }
    // Árbol de etiquetas anidadas (#padre/hija)
    const root = { children: new Map() };
    for (const { tag, count } of tags) {
      const parts = tag.slice(1).split('/');
      let node = root;
      let path = '';
      for (const part of parts) {
        path = path ? path + '/' + part : part;
        if (!node.children.has(part.toLowerCase())) node.children.set(part.toLowerCase(), { name: part, path, count: 0, own: 0, children: new Map() });
        node = node.children.get(part.toLowerCase());
        node.count += count;
      }
      node.own += count;
    }
    const sorter = {
      name: (a, b) => compareNames(a.name, b.name),
      nameReverse: (a, b) => compareNames(b.name, a.name),
      frequency: (a, b) => b.count - a.count || compareNames(a.name, b.name),
      frequencyReverse: (a, b) => a.count - b.count || compareNames(a.name, b.name),
    }[this.sort];
    const renderNode = (node, parent) => {
      const item = el('div.tree-item.tag-pane-tag', { parent });
      const self = el('div.tree-item-self.is-clickable', { parent: item });
      const hasChildren = node.children.size > 0;
      const collapsed = this.collapsed.has(node.path);
      if (hasChildren) {
        const collapse = el('div.tree-item-icon.collapse-icon', { cls: collapsed ? 'is-collapsed' : '', parent: self }, [icon('right-triangle')]);
        collapse.addEventListener('click', (e) => {
          e.stopPropagation();
          if (this.collapsed.has(node.path)) this.collapsed.delete(node.path);
          else this.collapsed.add(node.path);
          this.render();
        });
      }
      el('div.tree-item-inner', { parent: self }, [el('span.tag-pane-tag-text', { text: (hasChildren && node.path.includes('/')) || !node.path.includes('/') ? '#' + node.name : node.name })]);
      el('div.tree-item-flair-outer', { parent: self }, [el('span.tree-item-flair.tag-pane-tag-count', { text: String(node.count) })]);
      self.addEventListener('click', () => this.app.openSearch('tag:#' + node.path));
      if (hasChildren && !collapsed) {
        const children = el('div.tree-item-children', { parent: item });
        [...node.children.values()].sort(sorter).forEach((child) => renderNode(child, children));
      }
    };
    [...root.children.values()].sort(sorter).forEach((node) => renderNode(node, this.listEl));
  }
}

/* ============================================================== Esquema */

export class OutlineView extends View {
  constructor(leaf) {
    super(leaf);
    this.listEl = el('div.nav-files-container.outline', { parent: this.containerEl, style: { paddingTop: '8px', height: '100%' } });
    this.collapsed = new Set();
    this.renderSoon = debounce(() => this.render(), 250);
    this.registerEvent(this.app.workspace.on('file-open', () => this.render()));
    this.registerEvent(this.app.metadataCache.on('changed', (path) => {
      const file = this.app.workspace.getLastActiveFile();
      if (file && file.path === path) this.renderSoon();
    }));
  }

  getViewType() {
    return 'outline';
  }

  getDisplayText() {
    return 'Esquema';
  }

  getIcon() {
    return 'list';
  }

  onShow() {
    this.render();
  }

  render() {
    empty(this.listEl);
    const file = this.app.workspace.getLastActiveFile();
    if (!file || file.extension !== 'md') {
      el('div.pane-empty', { text: 'No hay ninguna nota activa.', parent: this.listEl });
      return;
    }
    const headings = this.app.metadataCache.getHeadings(file.path);
    if (!headings.length) {
      el('div.pane-empty', { text: 'No se encontraron encabezados.', parent: this.listEl });
      return;
    }
    const text = this.app.vault.getContent(file.path) || '';
    const stack = [{ level: 0, el: this.listEl }];
    headings.forEach((h, i) => {
      while (stack.length > 1 && stack[stack.length - 1].level >= h.level) stack.pop();
      const parent = stack[stack.length - 1].el;
      const item = el('div.tree-item', { parent });
      const self = el('div.tree-item-self.is-clickable', { parent: item });
      const next = headings[i + 1];
      const hasChildren = next && next.level > h.level;
      const key = i + ':' + h.heading;
      if (hasChildren) {
        const collapsed = this.collapsed.has(key);
        const collapse = el('div.tree-item-icon.collapse-icon', { cls: collapsed ? 'is-collapsed' : '', parent: self }, [icon('right-triangle')]);
        collapse.addEventListener('click', (e) => {
          e.stopPropagation();
          if (this.collapsed.has(key)) this.collapsed.delete(key);
          else this.collapsed.add(key);
          this.render();
        });
        if (collapsed) item.classList.add('is-collapsed');
      }
      el('div.tree-item-inner', { text: h.heading.replace(/\[\[([^\]|]*\|)?([^\]]*)\]\]/g, '$2').replace(/[*_`=~]/g, ''), parent: self });
      self.addEventListener('click', () => {
        const line = text.slice(0, h.position.start).split('\n').length - 1;
        const leaf = this.app.workspace.getActiveRootLeaf();
        if (leaf && leaf.view && leaf.view.file === file) leaf.view.setEphemeralState({ line });
      });
      const children = el('div.tree-item-children', { parent: item });
      stack.push({ level: h.level, el: children });
    });
  }
}

