// Explorador de archivos (barra lateral izquierda).
import { el, empty, iconButton, debounce, dirname, joinPath, isModEvent } from '../util.js';
import { icon } from '../icons.js';
import { View } from './base.js';
import { Menu, Notice } from '../ui.js';
import { api } from '../api.js';

const SORT_OPTIONS = [
  ['alphabetical', 'Nombre del archivo (A a Z)'],
  ['alphabeticalReverse', 'Nombre del archivo (Z a A)'],
  null,
  ['byModifiedTime', 'Fecha de modificación (más reciente primero)'],
  ['byModifiedTimeReverse', 'Fecha de modificación (más antigua primero)'],
  null,
  ['byCreatedTime', 'Fecha de creación (más reciente primero)'],
  ['byCreatedTimeReverse', 'Fecha de creación (más antigua primero)'],
];

export class FileExplorerView extends View {
  constructor(leaf) {
    super(leaf);
    this.expanded = new Set();
    this.itemEls = new Map();
    this.activePath = null;

    const header = el('div.nav-header', { parent: this.containerEl });
    const buttons = el('div.nav-buttons-container', { parent: header });
    buttons.append(
      iconButton('square-pen', 'Nota nueva', () => this.app.fileManager.newNote(), 'nav-action-button'),
      iconButton('folder-plus', 'Carpeta nueva', () => this.createFolder(''), 'nav-action-button'),
    );
    this.sortButton = iconButton('arrow-up-narrow-wide', 'Cambiar el orden', () => this.showSortMenu(), 'nav-action-button');
    this.collapseButton = iconButton('chevrons-down-up', 'Contraer todo', () => this.toggleCollapseAll(), 'nav-action-button');
    buttons.append(this.sortButton, this.collapseButton);

    this.filesEl = el('div.nav-files-container', { attr: { tabindex: '-1' }, parent: this.containerEl });
    this.rootEl = el('div.tree-item.nav-folder.mod-root', { parent: this.filesEl });
    this.rootChildrenEl = el('div.tree-item-children.nav-folder-children', { parent: this.rootEl });

    this.requestRender = debounce(() => this.render(), 50);
    this.bindEvents();

    const vault = this.app.vault;
    this.registerEvent(vault.on('create', () => this.requestRender()));
    this.registerEvent(vault.on('delete', () => this.requestRender()));
    this.registerEvent(vault.on('rename', (file, oldPath) => {
      if (file.isFolder && this.expanded.has(oldPath)) {
        this.expanded.delete(oldPath);
        this.expanded.add(file.path);
      }
      this.requestRender();
    }));
    this.registerEvent(vault.on('modify', () => {
      if (this.app.settings.get('fileSortOrder').startsWith('byModified')) this.requestRender();
    }));
    this.registerEvent(this.app.settings.on('change', (key) => {
      if (key === 'fileSortOrder' || key === 'showUnsupportedFiles') this.requestRender();
    }));
    this.registerEvent(this.app.workspace.on('file-open', (file) => this.setActive(file ? file.path : null)));
  }

  getViewType() {
    return 'file-explorer';
  }

  getDisplayText() {
    return 'Explorador de archivos';
  }

  getIcon() {
    return 'folder';
  }

  getState() {
    return { expanded: [...this.expanded] };
  }

  async setState(state) {
    if (state && Array.isArray(state.expanded)) this.expanded = new Set(state.expanded);
    this.render();
  }

  async onOpen() {
    this.render();
  }

  /* --------------------------------------------------------- Render */

  render() {
    const scroll = this.filesEl.scrollTop;
    this.itemEls = new Map();
    empty(this.rootChildrenEl);
    this.renderChildren(this.app.vault.root, this.rootChildrenEl);
    this.filesEl.scrollTop = scroll;
    this.setActive(this.activePath, true);
    this.collapseButton.replaceChildren(icon(this.expanded.size ? 'chevrons-down-up' : 'chevrons-up-down'));
    this.collapseButton.setAttribute('aria-label', this.expanded.size ? 'Contraer todo' : 'Expandir todo');
  }

  renderChildren(folder, parentEl) {
    const showAll = this.app.settings.get('showUnsupportedFiles');
    for (const item of this.app.vault.sortChildren(folder, this.app.settings.get('fileSortOrder'))) {
      if (!item.isFolder && !showAll && !['md', 'png', 'jpg', 'jpeg', 'gif', 'svg', 'webp', 'pdf'].includes(item.extension)) continue;
      parentEl.appendChild(item.isFolder ? this.renderFolder(item) : this.renderFile(item));
    }
  }

  renderFolder(folder) {
    const collapsed = !this.expanded.has(folder.path);
    const itemEl = el('div.tree-item.nav-folder', { cls: collapsed ? 'is-collapsed' : '' });
    const self = el('div.tree-item-self.nav-folder-title.is-clickable.mod-collapsible', {
      attr: { 'data-path': folder.path, draggable: 'true' },
      parent: itemEl,
    });
    el('div.tree-item-icon.collapse-icon', { cls: collapsed ? 'is-collapsed' : '', parent: self }, [icon('right-triangle')]);
    el('div.tree-item-inner.nav-folder-title-content', { text: folder.name, parent: self });
    const children = el('div.tree-item-children.nav-folder-children', { parent: itemEl });
    if (!collapsed) this.renderChildren(folder, children);
    this.itemEls.set(folder.path, self);
    return itemEl;
  }

  renderFile(file) {
    const itemEl = el('div.tree-item.nav-file');
    const self = el('div.tree-item-self.nav-file-title.is-clickable', {
      attr: { 'data-path': file.path, draggable: 'true' },
      parent: itemEl,
    });
    el('div.tree-item-inner.nav-file-title-content', { text: file.extension === 'md' ? file.basename : file.name.slice(0, file.name.length - file.extension.length - 1), parent: self });
    if (file.extension !== 'md') el('div.nav-file-tag', { text: file.extension, parent: self });
    this.itemEls.set(file.path, self);
    return itemEl;
  }

  setActive(path, silent) {
    if (!silent && this.activePath && this.itemEls.get(this.activePath)) this.itemEls.get(this.activePath).classList.remove('is-active');
    this.activePath = path;
    for (const node of this.rootChildrenEl.querySelectorAll('.tree-item-self.is-active')) node.classList.remove('is-active');
    const target = path && this.itemEls.get(path);
    if (target) target.classList.add('is-active');
  }

  reveal(path) {
    const parts = path.split('/');
    for (let i = 1; i < parts.length; i++) this.expanded.add(parts.slice(0, i).join('/'));
    if (this.app.vault.getFolder(path)) this.expanded.add(path);
    this.render();
    const target = this.itemEls.get(path);
    if (target) {
      target.scrollIntoView({ block: 'center' });
      target.classList.add('is-flashing');
      setTimeout(() => target.classList.remove('is-flashing'), 1200);
    }
    this.app.workspace.requestSaveLayout();
  }

  /* --------------------------------------------------------- Eventos */

  itemFromEvent(e) {
    const self = e.target.closest('.tree-item-self[data-path]');
    if (!self || !this.filesEl.contains(self)) return null;
    return { self, item: this.app.vault.getAbstractFileByPath(self.getAttribute('data-path')) };
  }

  bindEvents() {
    const files = this.filesEl;
    files.addEventListener('click', (e) => {
      const hit = this.itemFromEvent(e);
      if (!hit || !hit.item || hit.self.classList.contains('is-being-renamed')) return;
      if (hit.item.isFolder) {
        this.toggleFolder(hit.item);
        return;
      }
      const newLeaf = isModEvent(e) ? (e.altKey ? 'split' : 'tab') : false;
      this.app.workspace.openFile(hit.item, newLeaf);
    });
    files.addEventListener('auxclick', (e) => {
      if (e.button !== 1) return;
      const hit = this.itemFromEvent(e);
      if (hit && hit.item && !hit.item.isFolder) this.app.workspace.openFile(hit.item, 'tab');
    });
    files.addEventListener('contextmenu', (e) => {
      const hit = this.itemFromEvent(e);
      const menu = new Menu();
      if (!hit || !hit.item) {
        menu.addItem((i) => i.setTitle('Nota nueva').setIcon('square-pen').onClick(() => this.app.fileManager.newNote({ folder: '' })));
        menu.addItem((i) => i.setTitle('Carpeta nueva').setIcon('folder-plus').onClick(() => this.createFolder('')));
        menu.showAtMouseEvent(e);
        return;
      }
      hit.self.classList.add('has-active-menu');
      menu.onHide(() => hit.self.classList.remove('has-active-menu'));
      if (hit.item.isFolder) this.buildFolderMenu(menu, hit.item);
      else this.app.addFileMenuItems(menu, hit.item, 'file-explorer');
      menu.showAtMouseEvent(e);
    });

    // Arrastrar y soltar
    files.addEventListener('dragstart', (e) => {
      const hit = this.itemFromEvent(e);
      if (!hit || !hit.item) return;
      this.app.workspace.dnd.startFileDrag([hit.item], e);
      hit.self.classList.add('is-being-dragged');
      this.draggedEl = hit.self;
    });
    files.addEventListener('dragend', () => {
      if (this.draggedEl) this.draggedEl.classList.remove('is-being-dragged');
      this.clearDropHighlight();
      this.app.workspace.dnd.cleanup();
    });
    files.addEventListener('dragover', (e) => {
      const d = this.app.workspace.dnd.dragging;
      const external = !d && [...e.dataTransfer.types].includes('Files');
      if (!external && (!d || d.type !== 'file')) return;
      const folderPath = this.dropFolderFromEvent(e);
      if (folderPath == null) return;
      e.preventDefault();
      e.dataTransfer.dropEffect = external ? 'copy' : 'move';
      this.highlightDrop(folderPath);
    });
    files.addEventListener('dragleave', (e) => {
      if (!files.contains(e.relatedTarget)) this.clearDropHighlight();
    });
    files.addEventListener('drop', async (e) => {
      const d = this.app.workspace.dnd.dragging;
      const folderPath = this.dropFolderFromEvent(e);
      this.clearDropHighlight();
      if (folderPath == null) return;
      e.preventDefault();
      if (d && d.type === 'file') {
        for (const item of d.files) await this.app.fileManager.moveTo(item, folderPath);
      } else if (e.dataTransfer.files.length) {
        for (const f of e.dataTransfer.files) {
          const osPath = api.pathForFile(f);
          if (!osPath) continue;
          try {
            await this.importInto(osPath, folderPath);
          } catch (err) {
            new Notice('No se pudo importar: ' + err.message);
          }
        }
      }
      this.app.workspace.dnd.cleanup();
    });
  }

  async importInto(osPath, folderPath) {
    const name = osPath.split('/').pop();
    const dot = name.lastIndexOf('.');
    const base = dot > 0 ? name.slice(0, dot) : name;
    const ext = dot > 0 ? name.slice(dot + 1).toLowerCase() : '';
    const path = this.app.vault.getAvailablePath(folderPath, base, ext);
    const entry = await api.importFile(osPath, path);
    const file = this.app.vault._insert(entry);
    if (file.extension === 'md') this.app.vault.contents.set(file.path, await api.read(file.path));
    this.app.vault.trigger('create', file);
  }

  dropFolderFromEvent(e) {
    const self = e.target.closest('.tree-item-self[data-path]');
    const d = this.app.workspace.dnd.dragging;
    let folderPath = '';
    if (self) {
      const item = this.app.vault.getAbstractFileByPath(self.getAttribute('data-path'));
      if (!item) return null;
      folderPath = item.isFolder ? item.path : dirname(item.path);
      if (item.isFolder && this.expanded.has(item.path) === false) this.scheduleExpand(item);
    }
    if (d && d.type === 'file') {
      for (const item of d.files) {
        if (item.isFolder && (folderPath === item.path || folderPath.startsWith(item.path + '/'))) return null;
      }
    }
    return folderPath;
  }

  scheduleExpand(folder) {
    if (this.expandTarget === folder.path) return;
    clearTimeout(this.expandTimer);
    this.expandTarget = folder.path;
    this.expandTimer = setTimeout(() => {
      if (this.expandTarget !== folder.path) return;
      this.expanded.add(folder.path);
      this.render();
      this.highlightDrop(folder.path);
    }, 700);
  }

  highlightDrop(folderPath) {
    if (this.dropHighlight === folderPath) return;
    this.clearDropHighlight();
    this.dropHighlight = folderPath;
    if (folderPath === '') this.filesEl.classList.add('is-being-dragged-over');
    else {
      const target = this.itemEls.get(folderPath);
      if (target) target.classList.add('is-being-dragged-over');
    }
  }

  clearDropHighlight() {
    this.dropHighlight = undefined;
    clearTimeout(this.expandTimer);
    this.expandTarget = null;
    this.filesEl.classList.remove('is-being-dragged-over');
    for (const node of this.filesEl.querySelectorAll('.is-being-dragged-over')) node.classList.remove('is-being-dragged-over');
  }

  /* ---------------------------------------------------------- Acciones */

  toggleFolder(folder) {
    if (this.expanded.has(folder.path)) this.expanded.delete(folder.path);
    else this.expanded.add(folder.path);
    this.render();
    this.app.workspace.requestSaveLayout();
  }

  toggleCollapseAll() {
    if (this.expanded.size) this.expanded.clear();
    else for (const folder of this.app.vault.getAllFolders()) if (folder.path) this.expanded.add(folder.path);
    this.render();
    this.app.workspace.requestSaveLayout();
  }

  showSortMenu() {
    const menu = new Menu();
    const current = this.app.settings.get('fileSortOrder');
    for (const option of SORT_OPTIONS) {
      if (!option) {
        menu.addSeparator();
        continue;
      }
      const [value, label] = option;
      menu.addItem((i) => i.setTitle(label).setChecked(value === current).onClick(() => this.app.settings.set('fileSortOrder', value)));
    }
    menu.showBelow(this.sortButton);
  }

  async createFolder(parentPath) {
    if (parentPath) this.expanded.add(parentPath);
    const folder = await this.app.fileManager.createNewFolder(parentPath);
    this.render();
    this.startRename(folder);
  }

  buildFolderMenu(menu, folder) {
    menu.addItem((i) => i.setTitle('Nota nueva').setIcon('square-pen').onClick(async () => {
      this.expanded.add(folder.path);
      await this.app.fileManager.newNote({ folder: folder.path });
    }));
    menu.addItem((i) => i.setTitle('Carpeta nueva').setIcon('folder-plus').onClick(() => this.createFolder(folder.path)));
    menu.addSeparator();
    menu.addItem((i) => i.setTitle('Mover la carpeta a…').setIcon('folder-input').onClick(() => this.app.openMoveModal(folder)));
    menu.addItem((i) => i.setTitle('Buscar en la carpeta').setIcon('search').onClick(() => this.app.openSearch(`path:"${folder.path}" `)));
    menu.addSeparator();
    menu.addItem((i) => i.setTitle('Copiar ruta').setIcon('copy').onClick(() => navigator.clipboard.writeText(folder.path)));
    menu.addItem((i) => i.setTitle('Mostrar en Finder').setIcon('folder-open').onClick(() => api.reveal(folder.path)));
    menu.addSeparator();
    menu.addItem((i) => i.setTitle('Renombrar…').setIcon('pencil').onClick(() => this.startRename(folder)));
    menu.addItem((i) => i.setTitle('Eliminar').setIcon('trash').setWarning(true).onClick(() => this.app.fileManager.trash(folder)));
  }

  // Renombrado en el propio árbol.
  startRename(item) {
    if (dirname(item.path)) this.reveal(dirname(item.path));
    const self = this.itemEls.get(item.path);
    if (!self) return;
    const inner = self.querySelector('.tree-item-inner');
    const original = item.isFolder ? item.name : item.extension === 'md' ? item.basename : item.name.slice(0, -item.extension.length - 1);
    self.classList.add('is-being-renamed');
    self.setAttribute('draggable', 'false');
    inner.setAttribute('contenteditable', 'true');
    inner.textContent = original;
    inner.focus();
    const range = document.createRange();
    range.selectNodeContents(inner);
    const sel = window.getSelection();
    sel.removeAllRanges();
    sel.addRange(range);
    let done = false;
    const finish = async (commit) => {
      if (done) return;
      done = true;
      inner.removeAttribute('contenteditable');
      self.classList.remove('is-being-renamed');
      self.setAttribute('draggable', 'true');
      const name = inner.textContent.replace(/\n/g, ' ').trim();
      if (!commit || !name || name === original) {
        inner.textContent = original;
        return;
      }
      const error = this.app.fileManager.validateName(name);
      if (error) {
        new Notice(error);
        inner.textContent = original;
        return;
      }
      const ext = item.isFolder ? '' : item.extension;
      const ok = await this.app.fileManager.renameFile(item, joinPath(dirname(item.path), ext ? `${name}.${ext}` : name));
      if (!ok) inner.textContent = original;
    };
    inner.addEventListener('keydown', (e) => {
      if (e.key === 'Enter' && !e.isComposing) {
        e.preventDefault();
        finish(true);
      } else if (e.key === 'Escape') {
        e.preventDefault();
        finish(false);
      }
      e.stopPropagation();
    });
    inner.addEventListener('blur', () => finish(true), { once: true });
  }
}
