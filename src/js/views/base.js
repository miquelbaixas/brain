// Clases base de las vistas que viven dentro de una pestaña.
import { el, iconButton, dirname, Disposer } from '../util.js';
import { Menu } from '../ui.js';

export class View {
  constructor(leaf) {
    this.leaf = leaf;
    this.app = leaf.app;
    this.disposer = new Disposer();
    this.containerEl = el('div.workspace-leaf-content', { attr: { 'data-type': this.getViewType() } });
    this.contentEl = el('div.view-content');
  }

  getViewType() {
    return 'view';
  }

  getDisplayText() {
    return '';
  }

  getIcon() {
    return 'file';
  }

  getState() {
    return {};
  }

  async setState() {}

  setEphemeralState() {}

  async onOpen() {}

  async onClose() {
    this.disposer.dispose();
  }

  onShow() {}

  focus() {}

  // Registra un listener de eventos de la app que se quita al cerrar la vista.
  registerEvent(unsubscribe) {
    this.disposer.add(unsubscribe);
  }
}

// Vista con cabecera: navegación, título y acciones.
export class ItemView extends View {
  constructor(leaf) {
    super(leaf);
    this.headerEl = el('div.view-header', { parent: this.containerEl });
    const left = el('div.view-header-left', { parent: this.headerEl });
    const nav = el('div.view-header-nav-buttons', { parent: left });
    this.backButton = iconButton('arrow-left', 'Atrás', () => this.leaf.goBack());
    this.forwardButton = iconButton('arrow-right', 'Adelante', () => this.leaf.goForward());
    this.backButton.addEventListener('contextmenu', (e) => this.leaf.showHistoryMenu(e, 'back'));
    this.forwardButton.addEventListener('contextmenu', (e) => this.leaf.showHistoryMenu(e, 'forward'));
    nav.append(this.backButton, this.forwardButton);
    this.titleContainerEl = el('div.view-header-title-container', { parent: this.headerEl });
    this.titleParentEl = el('div.view-header-title-parent', { parent: this.titleContainerEl });
    this.titleEl = el('div.view-header-title', { parent: this.titleContainerEl });
    this.actionsEl = el('div.view-actions', { parent: this.headerEl });
    this.moreButton = iconButton('ellipsis', 'Más opciones', (e) => {
      const menu = new Menu();
      this.onPaneMenu(menu, 'more-options');
      menu.showBelow(this.moreButton);
      e.stopPropagation();
    }, 'view-action');
    this.actionsEl.appendChild(this.moreButton);
    this.containerEl.appendChild(this.contentEl);
  }

  addAction(iconName, title, callback) {
    const button = iconButton(iconName, title, callback, 'view-action');
    this.actionsEl.insertBefore(button, this.actionsEl.firstChild);
    return button;
  }

  updateHeader() {
    this.titleEl.textContent = this.getDisplayText();
    this.backButton.classList.toggle('is-disabled', !this.leaf.history.back.length);
    this.forwardButton.classList.toggle('is-disabled', !this.leaf.history.forward.length);
    this.renderBreadcrumbs();
  }

  renderBreadcrumbs() {
    this.titleParentEl.replaceChildren();
  }

  // Menú «Más opciones» y menú contextual de la pestaña.
  onPaneMenu(menu, source) {
    const ws = this.app.workspace;
    if (source !== 'tab-header') {
      menu.addItem((i) => i.setTitle('Dividir a la derecha').setIcon('separator-vertical').onClick(() => ws.duplicateLeaf(this.leaf, 'vertical')));
      menu.addItem((i) => i.setTitle('Dividir hacia abajo').setIcon('separator-horizontal').onClick(() => ws.duplicateLeaf(this.leaf, 'horizontal')));
      menu.addItem((i) => i.setTitle('Abrir en una ventana nueva').setIcon('app-window').onClick(() => ws.openLeafInNewWindow(this.leaf, false)));
      menu.addItem((i) => i.setTitle('Mover a una ventana nueva').setIcon('app-window').onClick(() => ws.openLeafInNewWindow(this.leaf, true)));
      menu.addSeparator();
    }
  }
}

// Vista asociada a un archivo de la bóveda.
export class FileView extends ItemView {
  constructor(leaf) {
    super(leaf);
    this.file = null;
    this.titleEl.setAttribute('contenteditable', 'true');
    this.titleEl.setAttribute('spellcheck', 'false');
    this.titleEl.addEventListener('keydown', (e) => {
      if (e.key === 'Enter') {
        e.preventDefault();
        this.titleEl.blur();
      } else if (e.key === 'Escape') {
        e.preventDefault();
        this.titleEl.textContent = this.getDisplayText();
        this.titleEl.blur();
      }
    });
    this.titleEl.addEventListener('blur', () => this.commitTitle(this.titleEl));
    this.titleEl.addEventListener('focus', () => {
      const range = document.createRange();
      range.selectNodeContents(this.titleEl);
      const sel = window.getSelection();
      sel.removeAllRanges();
      sel.addRange(range);
    });
  }

  getDisplayText() {
    if (!this.file) return 'Sin archivo';
    return this.file.extension === 'md' ? this.file.basename : this.file.name;
  }

  getState() {
    return this.file ? { file: this.file.path } : {};
  }

  async setState(state) {
    const file = state.file ? this.app.vault.getFile(state.file) : null;
    if (file !== this.file || !this.loaded) {
      if (this.file) await this.onUnloadFile(this.file);
      this.file = file;
      this.loaded = true;
      if (file) await this.onLoadFile(file, state);
    }
  }

  async onLoadFile() {}

  async onUnloadFile() {}

  async onClose() {
    if (this.file) await this.onUnloadFile(this.file);
    await super.onClose();
  }

  onFileRenamed() {
    this.leaf.updateHeader();
  }

  async commitTitle(source) {
    if (!this.file) return;
    const name = source.textContent.replace(/\n/g, ' ').trim();
    const current = this.file.extension === 'md' ? this.file.basename : this.file.name;
    if (!name || name === current) {
      source.textContent = current;
      return;
    }
    const ok = this.file.extension === 'md'
      ? await this.app.fileManager.renameWithBasename(this.file, name)
      : await this.app.fileManager.renameFile(this.file, (dirname(this.file.path) ? dirname(this.file.path) + '/' : '') + name);
    if (!ok) source.textContent = this.getDisplayText();
  }

  renderBreadcrumbs() {
    this.titleParentEl.replaceChildren();
    if (!this.file) return;
    const parts = dirname(this.file.path).split('/').filter(Boolean);
    parts.forEach((part, i) => {
      const folderPath = parts.slice(0, i + 1).join('/');
      const crumb = el('span.view-header-breadcrumb', { text: part, parent: this.titleParentEl });
      crumb.addEventListener('click', () => this.app.revealInExplorer(folderPath));
      el('span.view-header-breadcrumb-separator', { text: '/', parent: this.titleParentEl });
    });
  }

  onPaneMenu(menu, source) {
    super.onPaneMenu(menu, source);
    if (!this.file) return;
    this.app.addFileMenuItems(menu, this.file, source);
  }
}
