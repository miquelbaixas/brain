// Aplicación: une la bóveda, los metadatos, el espacio de trabajo y la interfaz.
import { api } from './api.js';
import { el, empty, Events, iconButton, isMac, plural, formatNumber, debounce, basename } from './util.js';
import { icon } from './icons.js';
import { Vault } from './vault.js';
import { MetadataCache } from './metadata.js';
import { DocRegistry } from './docs.js';
import { FileManager } from './file-manager.js';
import { Settings, SettingsModal } from './settings.js';
import { Commands } from './commands.js';
import { Workspace } from './workspace.js';
import { HoverPopover } from './render.js';
import { Menu, Notice, installTooltips, promptDialog } from './ui.js';
import { QuickSwitcher, CommandPalette, FolderPicker } from './modals.js';
import { MarkdownView } from './views/markdown.js';
import { EmptyView, ImageView, PdfView, MediaView, UnsupportedView } from './views/simple.js';
import { FileExplorerView } from './views/file-explorer.js';
import { SearchView, BookmarksView, BacklinkView, OutgoingLinkView, TagView, OutlineView } from './views/panes.js';
import { GraphView } from './views/graph.js';

/* ============================================================= Marcadores */

class Bookmarks extends Events {
  constructor(app) {
    super();
    this.app = app;
    this.items = [];
  }

  async load() {
    try {
      if (!(await api.exists('.brain/bookmarks.json'))) throw new Error('sin marcadores');
      const data = JSON.parse(await api.read('.brain/bookmarks.json'));
      this.items = Array.isArray(data.items) ? data.items : [];
    } catch {
      this.items = [];
    }
    this.trigger('changed');
  }

  async save() {
    await api.write('.brain/bookmarks.json', JSON.stringify({ items: this.items }, null, 2));
    api.broadcast('bookmarks-change', null);
    this.trigger('changed');
  }

  has(path) {
    return this.items.some((b) => b.path === path);
  }

  toggle(path) {
    if (this.has(path)) this.remove(path);
    else this.add(path);
  }

  add(path) {
    if (this.has(path)) return;
    this.items.push({ type: 'file', path });
    this.save();
  }

  remove(path) {
    this.items = this.items.filter((b) => b.path !== path);
    this.save();
  }

  onRename(file, oldPath) {
    let changed = false;
    for (const b of this.items) {
      if (b.path === oldPath) {
        b.path = file.path;
        changed = true;
      } else if (file.isFolder && b.path.startsWith(oldPath + '/')) {
        b.path = file.path + b.path.slice(oldPath.length);
        changed = true;
      }
    }
    if (changed) this.save();
  }
}

/* ===================================================================== App */

export class App {
  async init() {
    this.api = api;
    this.info = await api.init();
    this.isMain = this.info.windowType === 'main';
    this.recentFiles = [];
    document.body.classList.toggle('is-popout-window', !this.isMain);
    document.body.classList.toggle('mod-macos', isMac);
    document.body.classList.toggle('is-fullscreen', this.info.isFullscreen);
    document.body.classList.toggle('is-focused', document.hasFocus());
    this.applyFrameVars();

    this.settings = new Settings(this);
    await this.settings.load();
    this.applyAppearance();
    this.settings.on('change', () => this.applyAppearance());

    this.vault = new Vault(this.info);
    await this.vault.load();
    this.metadataCache = new MetadataCache(this);
    this.metadataCache.init();
    this.docs = new DocRegistry(this);
    this.fileManager = new FileManager(this);
    this.hoverPopover = new HoverPopover(this);
    this.bookmarks = new Bookmarks(this);
    await this.bookmarks.load();
    this.commands = new Commands(this);

    this.buildDom();
    this.registerViews();
    this.registerCommands();
    this.bindEvents();
    installTooltips();

    await this.workspace.loadLayout(await api.loadWorkspace());
    this.updateTitle();
    if (this.statusBar) this.updateStatusBar();
  }

  /* --------------------------------------------------------- Interfaz */

  applyFrameVars() {
    const style = document.body.style;
    if (!isMac) {
      style.setProperty('--frame-left-space', this.isMain ? '36px' : '0px');
      return;
    }
    style.setProperty('--frame-left-space', this.isMain ? '68px' : '72px');
    style.setProperty('--frame-left-space-fullscreen', this.isMain ? '32px' : '0px');
    style.setProperty('--frame-right-space', this.isMain ? '36px' : '0px');
  }

  async applyAppearance() {
    const s = this.settings;
    const body = document.body;
    const theme = s.get('theme');
    api.setTheme(theme);
    const dark = theme === 'dark' || (theme === 'system' && window.matchMedia('(prefers-color-scheme: dark)').matches);
    body.classList.toggle('theme-dark', dark);
    body.classList.toggle('theme-light', !dark);
    body.classList.toggle('show-ribbon', s.get('showRibbon'));
    body.classList.toggle('show-inline-title', s.get('showInlineTitle'));
    body.classList.toggle('show-view-header', s.get('showViewHeader'));
    body.style.setProperty('--font-text-size', s.get('fontSize') + 'px');
    const accent = s.get('accentColor');
    if (accent) {
      const [h, sat, l] = hexToHsl(accent);
      body.style.setProperty('--accent-h', String(h));
      body.style.setProperty('--accent-s', sat + '%');
      body.style.setProperty('--accent-l', l + '%');
    } else {
      body.style.removeProperty('--accent-h');
      body.style.removeProperty('--accent-s');
      body.style.removeProperty('--accent-l');
    }
  }

  buildDom() {
    const container = el('div.app-container', { parent: document.body });
    const main = el('div.horizontal-main-container', { parent: container });
    this.workspace = new Workspace(this);
    let ribbonEl = null;
    if (this.isMain) ribbonEl = this.buildRibbon();
    this.workspace.buildDom({ ribbonEl });
    main.appendChild(this.workspace.containerEl);
    if (this.isMain) {
      this.statusBar = el('div.status-bar', { parent: container });
      this.buildVaultProfile();
    }
  }

  buildRibbon() {
    const ribbon = el('div.workspace-ribbon.side-dock-ribbon.mod-left');
    const actions = el('div.side-dock-actions', { parent: ribbon });
    const action = (iconName, title, command, parent = actions) => {
      const button = iconButton(iconName, title, () => this.commands.execute(command), 'side-dock-ribbon-action');
      button.setAttribute('data-tooltip-position', 'right');
      parent.appendChild(button);
    };
    action('zap', 'Abrir el selector rápido', 'switcher:open');
    action('git-fork', 'Abrir la vista gráfica', 'graph:open');
    action('calendar-days', 'Abrir la nota diaria de hoy', 'daily-notes');
    action('square-terminal', 'Abrir la paleta de comandos', 'command-palette:open');
    const settings = el('div.side-dock-settings', { parent: ribbon });
    action('circle-help', 'Ayuda', 'app:open-help', settings);
    action('settings', 'Ajustes', 'app:open-settings', settings);
    return ribbon;
  }

  buildVaultProfile() {
    const profile = this.workspace.leftDock.vaultProfileEl;
    const switcher = el('div.workspace-drawer-vault-switcher', { parent: profile, title: 'Cambiar de bóveda' }, [
      el('div.workspace-drawer-vault-switcher-icon', [icon('chevrons-up-down')]),
      el('div.workspace-drawer-vault-name', { text: this.vault.name }),
    ]);
    switcher.addEventListener('click', () => {
      const menu = new Menu();
      for (const path of this.info.recentVaults) {
        menu.addItem((i) => i.setTitle(basename(path)).setIcon('vault').setChecked(path === this.vault.basePath).onClick(() => {
          if (path !== this.vault.basePath) api.switchVault(path);
        }));
      }
      menu.addSeparator();
      menu.addItem((i) => i.setTitle('Abrir carpeta como bóveda…').setIcon('folder-open').onClick(() => api.chooseVault()));
      menu.addItem((i) => i.setTitle('Mostrar la bóveda en Finder').setIcon('external-link').onClick(() => api.openPath('')));
      menu.showBelow(switcher);
      const rect = switcher.getBoundingClientRect();
      const menuRect = menu.dom.getBoundingClientRect();
      menu.dom.style.top = Math.max(8, rect.top - menuRect.height - 4) + 'px';
    });
    const actions = el('div.workspace-drawer-vault-actions', { parent: profile });
    actions.append(
      iconButton('circle-help', 'Ayuda', () => this.commands.execute('app:open-help')),
      iconButton('settings', 'Ajustes', () => this.commands.execute('app:open-settings')),
    );
  }

  registerViews() {
    const ws = this.workspace;
    ws.registerView('empty', EmptyView);
    ws.registerView('markdown', MarkdownView);
    ws.registerView('image', ImageView);
    ws.registerView('pdf', PdfView);
    ws.registerView('media', MediaView);
    ws.registerView('unknown', UnsupportedView);
    ws.registerView('graph', GraphView);
    ws.registerView('file-explorer', FileExplorerView);
    ws.registerView('search', SearchView);
    ws.registerView('bookmarks', BookmarksView);
    ws.registerView('backlink', BacklinkView);
    ws.registerView('outgoing-link', OutgoingLinkView);
    ws.registerView('tag', TagView);
    ws.registerView('outline', OutlineView);
  }

  /* ---------------------------------------------------------- Eventos */

  bindEvents() {
    const vault = this.vault;
    api.on('vault:changed', (changes) => vault.handleExternalChanges(changes));
    api.on('command', (id) => this.commands.execute(id));
    api.on('app:flush', async (token) => {
      try {
        await this.workspace.saveLayout();
        await this.docs.flushAll();
      } finally {
        api.flushed(token);
      }
    });
    api.on('broadcast', ({ channel, payload }) => {
      if (channel === 'doc-change') this.docs.onRemoteChange(payload);
      else if (channel === 'settings-change') this.settings.applyRemote(payload);
      else if (channel === 'bookmarks-change') this.bookmarks.load();
    });
    api.on('context-menu', (params) => this.showEditContextMenu(params));
    api.on('window:fullscreen', (full) => document.body.classList.toggle('is-fullscreen', full));
    window.addEventListener('focus', () => document.body.classList.add('is-focused'));
    window.addEventListener('blur', () => document.body.classList.remove('is-focused'));
    api.on('theme:updated', () => this.applyAppearance());
    window.matchMedia('(prefers-color-scheme: dark)').addEventListener('change', () => this.applyAppearance());

    vault.on('rename', (file, oldPath) => {
      this.workspace.onFileRenamed(file, oldPath);
      this.bookmarks.onRename(file, oldPath);
      this.recentFiles = this.recentFiles.map((p) => (p === oldPath ? file.path : file.isFolder && p.startsWith(oldPath + '/') ? file.path + p.slice(oldPath.length) : p));
    });
    vault.on('delete', (file) => {
      this.workspace.onFileDeleted(file);
      this.recentFiles = this.recentFiles.filter((p) => p !== file.path);
    });

    document.addEventListener('keydown', (e) => this.commands.handleKeydown(e));
    window.addEventListener('beforeunload', () => {
      this.workspace.saveLayout();
      this.docs.flushAll();
    });

    if (this.statusBar) {
      const update = debounce(() => this.updateStatusBar(), 120);
      for (const name of ['file-open', 'editor-change', 'editor-selection', 'layout-change', 'active-leaf-change']) this.workspace.on(name, update);
      this.metadataCache.on('resolved', update);
      for (const name of ['create', 'delete', 'rename']) vault.on(name, update);
    }
  }

  // Menú contextual para texto (editor, campos de texto y selección en lectura).
  showEditContextMenu(params) {
    if (!params.isEditable && !params.selectionText) return;
    const menu = new Menu();
    if (params.misspelledWord) {
      for (const word of params.suggestions.slice(0, 5)) {
        menu.addItem((i) => i.setTitle(word).onClick(() => api.editAction('replaceMisspelling', word)));
      }
      if (!params.suggestions.length) menu.addLabel('Sin sugerencias');
      menu.addItem((i) => i.setTitle('Añadir al diccionario').setIcon('plus').onClick(() => api.editAction('addWord', params.misspelledWord)));
      menu.addSeparator();
    }
    const view = this.workspace.getActiveMarkdownView();
    const inEditor = view && view.mode === 'source' && view.editor.view.contentDOM.contains(document.activeElement);
    if (inEditor && params.selectionText) {
      const cm = view.editor.view;
      const wrap = (mark) => () => {
        const r = cm.state.selection.main;
        cm.dispatch({ changes: [{ from: r.from, insert: mark }, { from: r.to, insert: mark }], selection: { anchor: r.from + mark.length, head: r.to + mark.length } });
        cm.focus();
      };
      menu.addItem((i) => i.setTitle('Negrita').setIcon('pencil').onClick(wrap('**')));
      menu.addItem((i) => i.setTitle('Cursiva').onClick(wrap('*')));
      menu.addItem((i) => i.setTitle('Resaltar').onClick(wrap('==')));
      menu.addItem((i) => i.setTitle('Convertir en enlace interno').setIcon('link').onClick(() => {
        const r = cm.state.selection.main;
        cm.dispatch({ changes: [{ from: r.from, insert: '[[' }, { from: r.to, insert: ']]' }] });
        cm.focus();
      }));
      menu.addSeparator();
    }
    if (params.isEditable) menu.addItem((i) => i.setTitle('Cortar').setDisabled(!params.selectionText).onClick(() => api.editAction('cut')));
    menu.addItem((i) => i.setTitle('Copiar').setIcon('copy').setDisabled(!params.selectionText).onClick(() => api.editAction('copy')));
    if (params.isEditable) {
      menu.addItem((i) => i.setTitle('Pegar').onClick(() => api.editAction('paste')));
      menu.addItem((i) => i.setTitle('Pegar como texto sin formato').onClick(() => api.editAction('pasteAndMatchStyle')));
      menu.addItem((i) => i.setTitle('Seleccionar todo').onClick(() => api.editAction('selectAll')));
    }
    if (params.selectionText && params.selectionText.length < 200 && this.isMain) {
      menu.addSeparator();
      menu.addItem((i) => i.setTitle(`Buscar «${params.selectionText.slice(0, 30)}»`).setIcon('search').onClick(() => this.openSearch(params.selectionText)));
    }
    menu.showAtPosition({ x: params.x, y: params.y });
  }

  /* ------------------------------------------------------ Barra de estado */

  updateStatusBar() {
    const bar = this.statusBar;
    if (!bar) return;
    empty(bar);
    const file = this.workspace.getActiveFile();
    const view = this.workspace.getActiveMarkdownView();
    if (file && file.extension === 'md') {
      const count = this.metadataCache.getBacklinkCount(file.path);
      const backlinks = el('div.status-bar-item.mod-clickable', { text: plural(count, 'enlace entrante', 'enlaces entrantes'), title: 'Mostrar los enlaces entrantes', attr: { 'data-tooltip-position': 'top' }, parent: bar });
      backlinks.addEventListener('click', () => this.commands.execute('backlink:open'));
    }
    if (view) {
      const modeItem = el('div.status-bar-item.mod-clickable', {
        title: view.mode === 'preview' ? 'Vista de lectura' : view.editor.livePreview ? 'Vista previa en vivo' : 'Modo fuente',
        attr: { 'data-tooltip-position': 'top' },
        parent: bar,
      }, [icon(view.mode === 'preview' ? 'book-open' : view.editor.livePreview ? 'pencil' : 'file-code')]);
      modeItem.addEventListener('click', (e) => {
        const menu = new Menu();
        menu.addItem((i) => i.setTitle('Vista previa en vivo').setChecked(view.mode === 'source' && view.editor.livePreview).onClick(() => {
          view.setMode('source');
          view.setLivePreview(true);
        }));
        menu.addItem((i) => i.setTitle('Modo fuente').setChecked(view.mode === 'source' && !view.editor.livePreview).onClick(() => {
          view.setMode('source');
          view.setLivePreview(false);
        }));
        menu.addItem((i) => i.setTitle('Vista de lectura').setChecked(view.mode === 'preview').onClick(() => view.setMode('preview')));
        menu.showAtMouseEvent(e);
      });
      const stats = view.getWordStats();
      el('div.status-bar-item', { parent: bar }, [
        el('span.status-bar-item-segment', { text: plural(stats.words, 'palabra', 'palabras') }),
        el('span.status-bar-item-segment', { text: plural(stats.characters, 'carácter', 'caracteres') }),
      ]);
    }
    const notes = this.vault.getMarkdownFiles().length;
    const notesItem = el('div.status-bar-item.mod-clickable', { title: `${formatNumber(this.vault.getFiles().length)} archivos y ${formatNumber(this.vault.getAllFolders().length - 1)} carpetas en la bóveda`, attr: { 'data-tooltip-position': 'top' }, parent: bar }, [
      icon('files'),
      el('span', { text: plural(notes, 'nota', 'notas') }),
    ]);
    notesItem.addEventListener('click', () => this.commands.execute('file-explorer:open'));
  }

  updateTitle() {
    const file = this.workspace && this.workspace.getActiveFile();
    const name = file ? (file.extension === 'md' ? file.basename : file.name) : null;
    document.title = (name ? name + ' - ' : '') + this.vault.name + ' - Brain';
  }

  /* --------------------------------------------------------- Acciones */

  recordRecentFile(file) {
    if (!file) return;
    this.recentFiles = [file.path, ...this.recentFiles.filter((p) => p !== file.path)].slice(0, 30);
  }

  openSearch(query) {
    if (!this.isMain) {
      new Notice('La búsqueda está en la ventana principal.');
      return;
    }
    const leaf = this.workspace.leftDock.reveal('search');
    if (leaf) {
      leaf.view.setQuery(query);
      leaf.view.focus();
    }
  }

  revealInExplorer(path) {
    if (!this.isMain) return;
    const leaf = this.workspace.leftDock.reveal('file-explorer');
    if (leaf) leaf.view.reveal(path);
  }

  openMoveModal(item) {
    new FolderPicker(this, item, (folder) => this.fileManager.moveTo(item, folder.path)).open();
  }

  async renameFromMenu(file, source) {
    if (source === 'file-explorer' && this.isMain) {
      const explorer = this.workspace.leftDock.getLeafOfType('file-explorer');
      if (explorer) {
        explorer.view.startRename(file);
        return;
      }
    }
    const view = this.workspace.getActiveMarkdownView();
    if (view && view.file === file && this.settings.get('showInlineTitle')) {
      view.setEphemeralState({ rename: true });
      return;
    }
    const current = file.extension === 'md' ? file.basename : file.name;
    const name = await promptDialog(this, { title: 'Renombrar archivo', value: current, confirmText: 'Renombrar' });
    if (!name || name === current) return;
    if (file.extension === 'md') await this.fileManager.renameWithBasename(file, name);
    else await this.fileManager.renameFile(file, (file.parent && file.parent.path ? file.parent.path + '/' : '') + name);
  }

  addFileMenuItems(menu, file, source) {
    const ws = this.workspace;
    if (source !== 'tab-header' && source !== 'more-options') {
      menu.addItem((i) => i.setTitle('Abrir en una pestaña nueva').setIcon('file-plus').onClick(() => ws.openFile(file, 'tab')));
      menu.addItem((i) => i.setTitle('Abrir a la derecha').setIcon('separator-vertical').onClick(() => ws.openFile(file, 'split')));
      menu.addItem((i) => i.setTitle('Abrir en una ventana nueva').setIcon('app-window').onClick(() => ws.openFile(file, 'window')));
      menu.addSeparator();
    }
    const bookmarked = this.bookmarks.has(file.path);
    menu.addItem((i) => i.setTitle(bookmarked ? 'Quitar de marcadores' : 'Añadir a marcadores').setIcon(bookmarked ? 'bookmark-minus' : 'bookmark').onClick(() => this.bookmarks.toggle(file.path)));
    menu.addItem((i) => i.setTitle('Duplicar').setIcon('copy').onClick(() => this.fileManager.duplicate(file)));
    menu.addItem((i) => i.setTitle('Mover el archivo a…').setIcon('folder-input').onClick(() => this.openMoveModal(file)));
    menu.addSeparator();
    menu.addItem((i) => i.setTitle('Copiar ruta').setIcon('copy').onClick(() => navigator.clipboard.writeText(file.path)));
    if (source !== 'file-explorer' && this.isMain) {
      menu.addItem((i) => i.setTitle('Mostrar en el explorador de archivos').setIcon('folder').onClick(() => this.revealInExplorer(file.path)));
    }
    menu.addItem((i) => i.setTitle('Mostrar en Finder').setIcon('folder-open').onClick(() => api.reveal(file.path)));
    if (file.extension !== 'md') menu.addItem((i) => i.setTitle('Abrir con la aplicación predeterminada').setIcon('external-link').onClick(() => api.openPath(file.path)));
    menu.addSeparator();
    menu.addItem((i) => i.setTitle('Renombrar…').setIcon('pencil').onClick(() => this.renameFromMenu(file, source)));
    menu.addItem((i) => i.setTitle('Eliminar').setIcon('trash').setWarning(true).onClick(() => this.fileManager.trash(file)));
  }

  /* ---------------------------------------------------------- Comandos */

  registerCommands() {
    const c = this.commands;
    const ws = this.workspace;
    const mod = (key, ...extra) => ({ modifiers: ['Mod', ...extra], key });
    const activeLeaf = () => ws.getActiveRootLeaf();
    const activeMd = () => ws.getActiveMarkdownView();
    const activeFile = () => ws.getActiveFile();
    const mainOnly = () => this.isMain;

    c.add({ id: 'file:new-note', name: 'Crear nota nueva', hotkey: mod('n'), callback: () => this.fileManager.newNote() });
    c.add({ id: 'file:new-note-split', name: 'Crear nota nueva a la derecha', callback: () => this.fileManager.newNote({ newLeaf: 'split' }) });
    c.add({ id: 'file:new-note-window', name: 'Crear nota nueva en una ventana nueva', callback: async () => {
      const file = await this.fileManager.createNewMarkdownFile(this.fileManager.getNewFileParent(activeFile()?.path));
      ws.openFile(file, 'window');
    } });
    c.add({ id: 'switcher:open', name: 'Selector rápido: Abrir el selector rápido', hotkey: mod('o'), callback: () => new QuickSwitcher(this).open() });
    c.add({ id: 'switcher:recent', name: 'Selector rápido: Ver archivos recientes', hidden: true, callback: () => new QuickSwitcher(this, { recentOnly: true }).open() });
    c.add({ id: 'command-palette:open', name: 'Paleta de comandos: Abrir la paleta de comandos', hotkey: mod('p'), callback: () => new CommandPalette(this).open() });
    c.add({ id: 'search:open', name: 'Buscar: Buscar en todos los archivos', hotkey: mod('f', 'Shift'), check: mainOnly, callback: () => {
      const view = activeMd();
      const selection = view ? view.getSelectionText() : '';
      this.openSearch(selection && !selection.includes('\n') ? selection : this.workspace.leftDock.getLeafOfType('search').view.query);
    } });
    c.add({ id: 'editor:open-search', name: 'Buscar en la nota actual', hotkey: mod('f'), check: () => !!activeMd(), callback: () => {
      const view = activeMd();
      if (view.mode !== 'source') view.setMode('source');
      view.editor.openSearch();
    } });
    c.add({ id: 'markdown:toggle-preview', name: 'Alternar vista de lectura y de edición', hotkey: mod('e'), check: () => !!activeMd(), callback: () => activeMd().toggleMode() });
    c.add({ id: 'editor:toggle-source', name: 'Alternar vista previa en vivo y modo fuente', check: () => !!activeMd(), callback: () => {
      const view = activeMd();
      if (view.mode !== 'source') view.setMode('source');
      view.setLivePreview(!view.editor.livePreview);
    } });
    c.add({ id: 'editor:undo', name: 'Deshacer', hidden: true, check: () => !!activeMd(), callback: () => activeMd().editor.undo() });
    c.add({ id: 'editor:redo', name: 'Rehacer', hidden: true, check: () => !!activeMd(), callback: () => activeMd().editor.redo() });

    c.add({ id: 'workspace:close', name: 'Cerrar la pestaña actual', hotkey: mod('w'), callback: () => {
      const leaf = activeLeaf();
      if (leaf) leaf.detach();
    } });
    c.add({ id: 'workspace:close-others', name: 'Cerrar las demás pestañas del grupo', check: () => !!activeLeaf(), callback: () => {
      const leaf = activeLeaf();
      for (const other of [...leaf.parent.children]) if (other !== leaf) other.detach();
    } });
    c.add({ id: 'workspace:new-tab', name: 'Nueva pestaña', hotkey: mod('t'), callback: () => {
      const leaf = activeLeaf();
      ws.newTabIn(leaf && leaf.parent ? leaf.parent : ws.ensureRootTabs());
    } });
    c.add({ id: 'workspace:new-window', name: 'Abrir una ventana nueva', hotkey: mod('n', 'Shift'), callback: () => api.newWindow() });
    c.add({ id: 'workspace:split-vertical', name: 'Dividir a la derecha', check: () => !!activeLeaf(), callback: () => ws.duplicateLeaf(activeLeaf(), 'vertical') });
    c.add({ id: 'workspace:split-horizontal', name: 'Dividir hacia abajo', check: () => !!activeLeaf(), callback: () => ws.duplicateLeaf(activeLeaf(), 'horizontal') });
    c.add({ id: 'workspace:open-in-new-window', name: 'Abrir la pestaña actual en una ventana nueva', check: () => !!activeLeaf(), callback: () => ws.openLeafInNewWindow(activeLeaf(), false) });
    c.add({ id: 'workspace:move-to-new-window', name: 'Mover la pestaña actual a una ventana nueva', check: () => !!activeLeaf(), callback: () => ws.openLeafInNewWindow(activeLeaf(), true) });
    c.add({ id: 'app:go-back', name: 'Navegar hacia atrás', hotkey: mod('ArrowLeft', 'Alt'), check: () => !!activeLeaf(), callback: () => activeLeaf().goBack() });
    c.add({ id: 'app:go-forward', name: 'Navegar hacia delante', hotkey: mod('ArrowRight', 'Alt'), check: () => !!activeLeaf(), callback: () => activeLeaf().goForward() });
    const cycleTab = (delta) => {
      const leaf = activeLeaf();
      if (!leaf || !leaf.parent) return;
      const tabs = leaf.parent;
      const next = tabs.children[(tabs.children.indexOf(leaf) + delta + tabs.children.length) % tabs.children.length];
      ws.setActiveLeaf(next, { focus: true });
    };
    c.add({ id: 'workspace:next-tab', name: 'Ir a la pestaña siguiente', hotkeys: [{ modifiers: ['Ctrl'], key: 'Tab' }, mod(']', 'Shift')], hotkey: { modifiers: ['Ctrl'], key: 'Tab' }, callback: () => cycleTab(1) });
    c.add({ id: 'workspace:previous-tab', name: 'Ir a la pestaña anterior', hotkeys: [{ modifiers: ['Ctrl', 'Shift'], key: 'Tab' }, mod('[', 'Shift')], hotkey: { modifiers: ['Ctrl', 'Shift'], key: 'Tab' }, callback: () => cycleTab(-1) });
    for (let n = 1; n <= 9; n++) {
      c.add({ id: `workspace:goto-tab-${n}`, name: `Ir a la pestaña ${n}`, hidden: true, hotkey: mod(String(n)), callback: () => {
        const leaf = activeLeaf();
        if (!leaf || !leaf.parent) return;
        const tabs = leaf.parent.children;
        const target = n === 9 ? tabs[tabs.length - 1] : tabs[n - 1];
        if (target) ws.setActiveLeaf(target, { focus: true });
      } });
    }

    c.add({ id: 'app:toggle-left-sidebar', name: 'Alternar la barra lateral izquierda', hotkey: mod('[', 'Alt'), check: mainOnly, callback: () => ws.leftDock.toggle() });
    c.add({ id: 'app:toggle-right-sidebar', name: 'Alternar la barra lateral derecha', hotkey: mod(']', 'Alt'), check: mainOnly, callback: () => ws.rightDock.toggle() });
    c.add({ id: 'file-explorer:open', name: 'Explorador de archivos: Mostrar el explorador de archivos', hotkey: mod('e', 'Shift'), check: mainOnly, callback: () => ws.leftDock.reveal('file-explorer') });
    c.add({ id: 'file-explorer:reveal-active-file', name: 'Explorador de archivos: Mostrar el archivo activo', check: () => mainOnly() && !!activeFile(), callback: () => this.revealInExplorer(activeFile().path) });
    c.add({ id: 'bookmarks:open', name: 'Marcadores: Mostrar los marcadores', check: mainOnly, callback: () => ws.leftDock.reveal('bookmarks') });
    c.add({ id: 'bookmarks:toggle', name: 'Marcadores: Añadir o quitar la nota actual', check: () => !!activeFile(), callback: () => this.bookmarks.toggle(activeFile().path) });
    c.add({ id: 'backlink:open', name: 'Enlaces entrantes: Mostrar los enlaces entrantes', check: mainOnly, callback: () => ws.rightDock.reveal('backlink') });
    c.add({ id: 'outgoing-links:open', name: 'Enlaces salientes: Mostrar los enlaces salientes', check: mainOnly, callback: () => ws.rightDock.reveal('outgoing-link') });
    c.add({ id: 'tag-pane:open', name: 'Etiquetas: Mostrar las etiquetas', check: mainOnly, callback: () => ws.rightDock.reveal('tag') });
    c.add({ id: 'outline:open', name: 'Esquema: Mostrar el esquema', check: mainOnly, callback: () => ws.rightDock.reveal('outline') });
    c.add({ id: 'graph:open', name: 'Vista gráfica: Abrir la vista gráfica', hotkey: mod('g'), callback: async () => {
      const existing = ws.getLeavesOfType('graph')[0];
      if (existing) {
        ws.setActiveLeaf(existing, { focus: true });
        return;
      }
      const current = activeLeaf();
      const leaf = ws.getLeaf(current && current.view && current.view.getViewType() === 'empty' ? false : 'tab');
      await leaf.setViewState({ type: 'graph', state: {} });
      ws.setActiveLeaf(leaf, { focus: true });
    } });
    c.add({ id: 'daily-notes', name: 'Notas diarias: Abrir la nota de hoy', callback: () => this.fileManager.openDailyNote() });

    c.add({ id: 'file:rename', name: 'Renombrar el archivo', hotkey: { modifiers: [], key: 'F2' }, check: () => !!activeFile(), callback: () => this.renameFromMenu(activeFile(), 'command') });
    c.add({ id: 'file:move', name: 'Mover el archivo actual a otra carpeta', check: () => !!activeFile(), callback: () => this.openMoveModal(activeFile()) });
    c.add({ id: 'file:duplicate', name: 'Duplicar el archivo actual', check: () => !!activeFile(), callback: () => this.fileManager.duplicate(activeFile()) });
    c.add({ id: 'file:delete', name: 'Eliminar el archivo actual', check: () => !!activeFile(), callback: () => this.fileManager.trash(activeFile()) });
    c.add({ id: 'file:copy-path', name: 'Copiar la ruta del archivo', check: () => !!activeFile(), callback: () => navigator.clipboard.writeText(activeFile().path) });
    c.add({ id: 'file:reveal-in-finder', name: 'Mostrar el archivo actual en Finder', check: () => !!activeFile(), callback: () => api.reveal(activeFile().path) });
    c.add({ id: 'editor:insert-link', name: 'Insertar enlace interno', check: () => !!activeMd() && activeMd().mode === 'source', callback: () => {
      const view = activeMd();
      const cm = view.editor.view;
      const sel = cm.state.selection.main;
      cm.dispatch({ changes: { from: sel.from, to: sel.to, insert: '[[' + cm.state.sliceDoc(sel.from, sel.to) + ']]' }, selection: { anchor: sel.from + 2 + (sel.to - sel.from) } });
      cm.focus();
    } });

    c.add({ id: 'app:open-settings', name: 'Abrir los ajustes', hotkey: mod(','), callback: () => new SettingsModal(this).open() });
    c.add({ id: 'app:open-hotkeys', name: 'Ver los atajos de teclado', callback: () => new SettingsModal(this, 'hotkeys').open() });
    c.add({ id: 'app:open-help', name: 'Abrir la ayuda', callback: () => {
      const help = this.vault.getFile('Bienvenida.md');
      if (help) ws.openFile(help, 'tab');
      else new SettingsModal(this, 'hotkeys').open();
    } });
    c.add({ id: 'app:open-vault', name: 'Abrir otra bóveda', callback: () => api.chooseVault() });
    c.add({ id: 'theme:toggle', name: 'Cambiar entre tema claro y oscuro', callback: () => {
      const dark = document.body.classList.contains('theme-dark');
      this.settings.set('theme', dark ? 'light' : 'dark');
    } });
    c.add({ id: 'app:reload', name: 'Recargar la aplicación', callback: async () => {
      await this.docs.flushAll();
      await this.workspace.saveLayout();
      api.reload();
    } });
    c.add({ id: 'app:toggle-devtools', name: 'Abrir las herramientas de desarrollo', hotkey: mod('i', 'Alt'), callback: () => api.toggleDevtools() });
  }
}

function hexToHsl(hex) {
  const m = /^#?([0-9a-f]{2})([0-9a-f]{2})([0-9a-f]{2})$/i.exec(hex);
  if (!m) return [258, 88, 66];
  const r = parseInt(m[1], 16) / 255;
  const g = parseInt(m[2], 16) / 255;
  const b = parseInt(m[3], 16) / 255;
  const max = Math.max(r, g, b);
  const min = Math.min(r, g, b);
  const l = (max + min) / 2;
  let h = 0;
  let s = 0;
  if (max !== min) {
    const d = max - min;
    s = l > 0.5 ? d / (2 - max - min) : d / (max + min);
    if (max === r) h = (g - b) / d + (g < b ? 6 : 0);
    else if (max === g) h = (b - r) / d + 2;
    else h = (r - g) / d + 4;
    h /= 6;
  }
  return [Math.round(h * 360), Math.round(s * 100), Math.round(l * 100)];
}
