// Espacio de trabajo: divisiones, grupos de pestañas, hojas (pestañas), barras laterales y arrastrar y soltar.
import { api } from './api.js';
import { el, empty, Events, debounce, uid, iconButton, dirname, basename } from './util.js';
import { icon } from './icons.js';
import { Menu, Notice } from './ui.js';
import { parseLinkInner } from './metadata.js';
import { viewTypeForFile } from './views/simple.js';

/* ================================================================= Hoja */

export class WorkspaceLeaf {
  constructor(workspace, { sidedock = false } = {}) {
    this.workspace = workspace;
    this.app = workspace.app;
    this.id = uid('leaf');
    this.parent = null;
    this.sidedock = sidedock;
    this.view = null;
    this.history = { back: [], forward: [] };
    this.containerEl = el('div.workspace-leaf');
    this.containerEl.addEventListener('mousedown', () => workspace.setActiveLeaf(this), true);
    this.containerEl.addEventListener('focusin', () => workspace.setActiveLeaf(this));
    this.buildTabHeader();
  }

  buildTabHeader() {
    const header = el('div.workspace-tab-header', { attr: { draggable: this.sidedock ? 'false' : 'true', 'data-type': 'empty' } });
    const inner = el('div.workspace-tab-header-inner', { parent: header });
    this.tabIconEl = el('div.workspace-tab-header-inner-icon', { parent: inner });
    this.tabTitleEl = el('div.workspace-tab-header-inner-title', { parent: inner });
    el('div.workspace-tab-header-status-container', { parent: inner });
    this.tabCloseEl = el('div.workspace-tab-header-inner-close-button', { title: 'Cerrar', parent: inner }, [icon('x')]);
    header.addEventListener('mousedown', (e) => {
      if (e.button !== 0 || e.target.closest('.workspace-tab-header-inner-close-button')) return;
      if (this.parent) this.parent.selectTab(this);
      this.workspace.setActiveLeaf(this, { focus: !this.sidedock });
    });
    header.addEventListener('auxclick', (e) => {
      if (e.button === 1 && !this.sidedock) this.detach();
    });
    this.tabCloseEl.addEventListener('mousedown', (e) => e.stopPropagation());
    this.tabCloseEl.addEventListener('click', (e) => {
      e.stopPropagation();
      this.detach();
    });
    header.addEventListener('contextmenu', (e) => {
      if (this.sidedock) return;
      const menu = new Menu();
      this.workspace.buildTabMenu(menu, this);
      menu.showAtMouseEvent(e);
    });
    header.addEventListener('dragstart', (e) => this.workspace.dnd.startLeafDrag(this, e));
    header.addEventListener('dragend', (e) => this.workspace.dnd.endDrag(e));
    header.addEventListener('mouseenter', () => {
      const prev = header.previousElementSibling;
      if (prev) prev.classList.add('is-before-hover');
    });
    header.addEventListener('mouseleave', () => {
      const prev = header.previousElementSibling;
      if (prev) prev.classList.remove('is-before-hover');
    });
    this.tabHeaderEl = header;
  }

  async setViewState(viewState, { history = true, focus = false } = {}) {
    const type = viewState.type || 'empty';
    const state = viewState.state || {};
    if (history && this.view && this.view.getViewType() !== 'empty') {
      const current = this.getViewState();
      if (JSON.stringify({ ...current.state, scroll: 0 }) !== JSON.stringify({ ...state, scroll: 0 }) || current.type !== type) {
        this.history.back.push(current);
        if (this.history.back.length > 50) this.history.back.shift();
        this.history.forward = [];
      }
    }
    if (!this.view || this.view.getViewType() !== type) {
      if (this.view) {
        await this.view.onClose();
        this.view.containerEl.remove();
      }
      const ViewClass = this.workspace.viewRegistry[type] || this.workspace.viewRegistry.empty;
      this.view = new ViewClass(this);
      this.containerEl.appendChild(this.view.containerEl);
      await this.view.onOpen();
    }
    await this.view.setState(state);
    this.updateHeader();
    this.workspace.onLeafStateChange(this);
    if (focus) this.view.focus();
  }

  getViewState() {
    return { type: this.view ? this.view.getViewType() : 'empty', state: this.view ? this.view.getState() : {} };
  }

  async openFile(file, { state = {}, eState } = {}) {
    const type = viewTypeForFile(file);
    const current = this.view && this.view.file === file && this.view.getViewType() === type;
    if (!current) await this.setViewState({ type, state: { file: file.path, ...state } });
    else if (state.mode && this.view.setMode) this.view.setMode(state.mode);
    if (eState) this.view.setEphemeralState(eState);
  }

  async goBack() {
    const prev = this.history.back.pop();
    if (!prev) return;
    this.history.forward.push(this.getViewState());
    await this.setViewState(prev, { history: false });
    this.workspace.setActiveLeaf(this, { focus: true });
  }

  async goForward() {
    const next = this.history.forward.pop();
    if (!next) return;
    this.history.back.push(this.getViewState());
    await this.setViewState(next, { history: false });
    this.workspace.setActiveLeaf(this, { focus: true });
  }

  showHistoryMenu(e, direction) {
    const list = direction === 'back' ? [...this.history.back].reverse() : [...this.history.forward].reverse();
    if (!list.length) return;
    const menu = new Menu();
    list.slice(0, 15).forEach((entry, i) => {
      const file = entry.state.file ? this.app.vault.getFile(entry.state.file) : null;
      const title = file ? (file.extension === 'md' ? file.basename : file.name) : entry.type === 'graph' ? 'Vista gráfica' : 'Pestaña nueva';
      menu.addItem((item) => item.setTitle(title).onClick(async () => {
        for (let k = 0; k <= i; k++) {
          if (direction === 'back') await this.goBack();
          else await this.goForward();
        }
      }));
    });
    menu.showAtMouseEvent(e);
  }

  getDisplayText() {
    return this.view ? this.view.getDisplayText() : 'Pestaña nueva';
  }

  updateHeader() {
    const title = this.getDisplayText();
    this.tabTitleEl.textContent = title;
    this.tabHeaderEl.setAttribute('data-type', this.view ? this.view.getViewType() : 'empty');
    if (this.sidedock) this.tabHeaderEl.setAttribute('aria-label', title);
    empty(this.tabIconEl).appendChild(icon(this.view ? this.view.getIcon() : 'file'));
    if (this.view && this.view.updateHeader) this.view.updateHeader();
    if (this.workspace.activeLeaf === this) this.workspace.app.updateTitle();
  }

  detach() {
    this.workspace.detachLeaf(this);
  }
}

/* ======================================================= Grupo de pestañas */

export class WorkspaceTabs {
  constructor(workspace, { sidedock = false } = {}) {
    this.type = 'tabs';
    this.workspace = workspace;
    this.sidedock = sidedock;
    this.children = [];
    this.currentTab = 0;
    this.parent = null;
    this.size = 1;
    this.containerEl = el('div.workspace-tabs');
    this.headerContainerEl = el('div.workspace-tab-header-container', { parent: this.containerEl });
    this.headerInnerEl = el('div.workspace-tab-header-container-inner', { parent: this.headerContainerEl });
    if (!sidedock) {
      const newTab = el('div.workspace-tab-header-new-tab', { parent: this.headerContainerEl });
      newTab.appendChild(iconButton('plus', 'Pestaña nueva', () => this.workspace.newTabIn(this)));
      const spacer = el('div.workspace-tab-header-spacer', { parent: this.headerContainerEl });
      spacer.addEventListener('dblclick', () => this.workspace.newTabIn(this));
      const list = el('div.workspace-tab-header-tab-list', { parent: this.headerContainerEl });
      const listButton = iconButton('chevron-down', 'Pestañas abiertas', () => this.showTabList(listButton));
      list.appendChild(listButton);
    } else {
      el('div.workspace-tab-header-spacer', { parent: this.headerContainerEl });
    }
    this.tabContainerEl = el('div.workspace-tab-container', { parent: this.containerEl });
    this.resizeHandleEl = el('hr.workspace-leaf-resize-handle');
    if (!sidedock) workspace.dnd.attachTabs(this);
  }

  get activeLeaf() {
    return this.children[this.currentTab] || null;
  }

  insertChild(index, leaf) {
    index = Math.max(0, Math.min(index, this.children.length));
    leaf.parent = this;
    this.children.splice(index, 0, leaf);
    this.headerInnerEl.insertBefore(leaf.tabHeaderEl, this.headerInnerEl.children[index] || null);
    this.tabContainerEl.appendChild(leaf.containerEl);
    if (this.children.length === 1) this.currentTab = 0;
    else if (index <= this.currentTab) this.currentTab += 1;
    this.updateTabDisplay();
  }

  removeChild(leaf) {
    const index = this.children.indexOf(leaf);
    if (index < 0) return;
    this.children.splice(index, 1);
    leaf.tabHeaderEl.remove();
    leaf.containerEl.remove();
    leaf.parent = null;
    if (index < this.currentTab) this.currentTab -= 1;
    else if (index === this.currentTab) this.currentTab = Math.min(index, this.children.length - 1);
    if (this.currentTab < 0) this.currentTab = 0;
    this.updateTabDisplay();
  }

  selectTab(leaf) {
    const index = this.children.indexOf(leaf);
    if (index < 0 || index === this.currentTab) {
      this.updateTabDisplay();
      return;
    }
    this.currentTab = index;
    this.updateTabDisplay();
    this.workspace.requestSaveLayout();
  }

  updateTabDisplay() {
    this.children.forEach((leaf, i) => {
      const active = i === this.currentTab;
      leaf.tabHeaderEl.classList.toggle('is-active', active);
      leaf.tabHeaderEl.classList.toggle('is-before-active', i === this.currentTab - 1);
      const wasVisible = leaf.containerEl.classList.contains('is-visible');
      leaf.containerEl.classList.toggle('is-visible', active);
      if (active && !wasVisible && leaf.view) leaf.view.onShow();
    });
  }

  showTabList(button) {
    const menu = new Menu();
    for (const leaf of this.children) {
      menu.addItem((i) => i.setTitle(leaf.getDisplayText()).setIcon(leaf.view ? leaf.view.getIcon() : 'file').setChecked(leaf === this.activeLeaf).onClick(() => {
        this.selectTab(leaf);
        this.workspace.setActiveLeaf(leaf, { focus: true });
      }));
    }
    menu.addSeparator();
    menu.addItem((i) => i.setTitle('Cerrar todas las pestañas').setIcon('x').onClick(() => {
      for (const leaf of [...this.children]) leaf.detach();
    }));
    menu.showBelow(button);
  }
}

/* ================================================================ División */

export class WorkspaceSplit {
  constructor(workspace, direction = 'vertical') {
    this.type = 'split';
    this.workspace = workspace;
    this.direction = direction;
    this.children = [];
    this.parent = null;
    this.size = 1;
    this.containerEl = el('div.workspace-split');
    this.resizeHandleEl = el('hr.workspace-leaf-resize-handle');
  }

  insertChild(index, child) {
    child.parent = this;
    this.children.splice(Math.max(0, Math.min(index, this.children.length)), 0, child);
  }

  removeChild(child) {
    const i = this.children.indexOf(child);
    if (i >= 0) this.children.splice(i, 1);
    child.parent = null;
  }

  replaceChild(oldChild, newChild) {
    const i = this.children.indexOf(oldChild);
    if (i < 0) return;
    this.children[i] = newChild;
    newChild.parent = this;
    oldChild.parent = null;
  }
}

/* ===================================================== Barra lateral (dock) */

export class SideDock {
  constructor(workspace, side) {
    this.workspace = workspace;
    this.side = side;
    this.collapsed = false;
    this.width = 300;
    this.containerEl = el(`div.workspace-split.mod-horizontal.mod-sidedock.mod-${side}-split`);
    this.tabs = new WorkspaceTabs(workspace, { sidedock: true });
    this.tabs.parent = this;
    this.resizeHandleEl = el('hr.workspace-leaf-resize-handle');
    this.containerEl.appendChild(this.tabs.containerEl);
    if (side === 'left') {
      this.vaultProfileEl = el('div.workspace-sidedock-vault-profile', { parent: this.containerEl });
    }
    this.containerEl.appendChild(this.resizeHandleEl);
    this.setupResize();
    this.applyWidth();
  }

  async addView(type) {
    const leaf = new WorkspaceLeaf(this.workspace, { sidedock: true });
    this.tabs.insertChild(this.tabs.children.length, leaf);
    await leaf.setViewState({ type, state: {} }, { history: false });
    return leaf;
  }

  getLeafOfType(type) {
    return this.tabs.children.find((l) => l.view && l.view.getViewType() === type) || null;
  }

  applyWidth() {
    this.containerEl.style.width = this.width + 'px';
    this.containerEl.classList.toggle('is-sidedock-collapsed', this.collapsed);
  }

  setupResize() {
    this.resizeHandleEl.addEventListener('mousedown', (e) => {
      e.preventDefault();
      const startX = e.clientX;
      const startWidth = this.width;
      this.resizeHandleEl.classList.add('is-active');
      document.body.classList.add('is-grabbing');
      const move = (ev) => {
        const delta = this.side === 'left' ? ev.clientX - startX : startX - ev.clientX;
        this.width = Math.max(180, Math.min(window.innerWidth * 0.6, startWidth + delta));
        this.applyWidth();
      };
      const up = () => {
        document.removeEventListener('mousemove', move);
        document.removeEventListener('mouseup', up);
        this.resizeHandleEl.classList.remove('is-active');
        document.body.classList.remove('is-grabbing');
        this.workspace.requestSaveLayout();
      };
      document.addEventListener('mousemove', move);
      document.addEventListener('mouseup', up);
    });
  }

  toggle(force) {
    this.collapsed = force != null ? !force : !this.collapsed;
    this.applyWidth();
    this.workspace.updateTopClasses();
    this.workspace.requestSaveLayout();
    this.workspace.trigger('layout-change');
  }

  reveal(type) {
    if (this.collapsed) this.toggle(true);
    const leaf = this.getLeafOfType(type);
    if (leaf) {
      this.tabs.selectTab(leaf);
      leaf.updateHeader();
    }
    return leaf;
  }

  serialize() {
    return {
      collapsed: this.collapsed,
      width: Math.round(this.width),
      active: this.tabs.activeLeaf && this.tabs.activeLeaf.view ? this.tabs.activeLeaf.view.getViewType() : null,
      views: Object.fromEntries(this.tabs.children.filter((l) => l.view).map((l) => [l.view.getViewType(), l.view.getState()])),
    };
  }
}

/* ======================================================= Arrastrar y soltar */

class DragManager {
  constructor(workspace) {
    this.workspace = workspace;
    this.dragging = null;
    this.target = null;
    this.overlayEl = el('div.workspace-drop-overlay');
    this.indicatorEl = el('div.workspace-tab-drop-indicator');
    window.addEventListener('dragend', () => this.cleanup());
    window.addEventListener('drop', () => this.cleanup());
  }

  startLeafDrag(leaf, e) {
    this.dragging = { type: 'leaf', leaf };
    e.dataTransfer.effectAllowed = 'move';
    e.dataTransfer.setData('application/x-brain-leaf', leaf.id);
    this.setGhost(e, leaf.getDisplayText(), leaf.view ? leaf.view.getIcon() : 'file');
  }

  startFileDrag(files, e) {
    const app = this.workspace.app;
    this.dragging = { type: 'file', files };
    e.dataTransfer.effectAllowed = 'copyMove';
    const source = app.workspace.getActiveFile();
    const links = files.filter((f) => !f.isFolder).map((f) => app.fileManager.generateMarkdownLink(f, source ? source.path : '', { embed: f.extension !== 'md' && /^(png|jpe?g|gif|svg|webp|bmp|avif|pdf|mp3|wav|mp4|mov)$/.test(f.extension) }));
    e.dataTransfer.setData('text/plain', links.join('\n'));
    const first = files[0];
    this.setGhost(e, files.length > 1 ? `${files.length} archivos` : first.isFolder ? first.name : first.extension === 'md' ? first.basename : first.name, first.isFolder ? 'folder' : 'file-text');
  }

  setGhost(e, text, iconName) {
    const ghost = el('div.drag-ghost', { parent: document.body, style: { top: '-1000px', left: '-1000px' } }, [icon(iconName), el('span', { text })]);
    e.dataTransfer.setDragImage(ghost, -12, -8);
    setTimeout(() => ghost.remove(), 0);
  }

  endDrag(e) {
    const dragging = this.dragging;
    this.cleanup();
    if (!dragging || dragging.type !== 'leaf' || !e) return;
    const outside = e.screenX < window.screenX || e.screenX > window.screenX + window.outerWidth ||
      e.screenY < window.screenY || e.screenY > window.screenY + window.outerHeight;
    if (e.dataTransfer && e.dataTransfer.dropEffect === 'none' && outside) {
      this.workspace.openLeafInNewWindow(dragging.leaf, true);
    }
  }

  cleanup() {
    this.overlayEl.remove();
    this.indicatorEl.remove();
    this.target = null;
    setTimeout(() => {
      this.dragging = null;
    }, 0);
  }

  attachTabs(tabs) {
    tabs.containerEl.addEventListener('dragover', (e) => this.onDragOver(tabs, e));
    tabs.containerEl.addEventListener('dragleave', (e) => {
      if (!tabs.containerEl.contains(e.relatedTarget)) {
        this.overlayEl.remove();
        this.indicatorEl.remove();
      }
    });
    tabs.containerEl.addEventListener('drop', (e) => this.onDrop(tabs, e), true);
  }

  onDragOver(tabs, e) {
    const d = this.dragging;
    if (!d && e.dataTransfer && [...e.dataTransfer.types].includes('Files')) {
      return this.onExternalDragOver(tabs, e);
    }
    if (!d) return;
    if (tabs.headerContainerEl.contains(e.target)) {
      e.preventDefault();
      e.dataTransfer.dropEffect = 'move';
      const headers = tabs.children.map((l) => l.tabHeaderEl);
      let index = headers.length;
      for (let i = 0; i < headers.length; i++) {
        const r = headers[i].getBoundingClientRect();
        if (e.clientX < r.left + r.width / 2) {
          index = i;
          break;
        }
      }
      const ref = headers[index] ? headers[index].getBoundingClientRect() : headers.length ? headers[headers.length - 1].getBoundingClientRect() : tabs.headerInnerEl.getBoundingClientRect();
      const x = headers[index] ? ref.left - 1 : ref.right + 1;
      Object.assign(this.indicatorEl.style, { left: x + 'px', top: ref.top + 4 + 'px', height: ref.height - 8 + 'px' });
      document.body.appendChild(this.indicatorEl);
      this.overlayEl.remove();
      this.target = { tabs, index };
      return;
    }
    this.indicatorEl.remove();
    const rect = tabs.tabContainerEl.getBoundingClientRect();
    const x = (e.clientX - rect.left) / rect.width;
    const y = (e.clientY - rect.top) / rect.height;
    let zone = 'center';
    const edge = 0.22;
    const distances = [['left', x], ['right', 1 - x], ['top', y], ['bottom', 1 - y]].filter(([, v]) => v < edge).sort((a, b) => a[1] - b[1]);
    if (distances.length) zone = distances[0][0];
    const active = tabs.activeLeaf;
    if (d.type === 'file' && zone === 'center' && active && active.view && active.view.getViewType() === 'markdown' && active.view.mode === 'source') {
      // Dejar que el editor inserte el enlace en la posición del cursor.
      this.overlayEl.remove();
      this.target = null;
      return;
    }
    if (d.type === 'file' && d.files.every((f) => f.isFolder)) return;
    e.preventDefault();
    e.dataTransfer.dropEffect = d.type === 'file' ? 'copy' : 'move';
    const box = { left: rect.left, top: rect.top, width: rect.width, height: rect.height };
    if (zone === 'left') box.width /= 2;
    if (zone === 'right') {
      box.left += box.width / 2;
      box.width /= 2;
    }
    if (zone === 'top') box.height /= 2;
    if (zone === 'bottom') {
      box.top += box.height / 2;
      box.height /= 2;
    }
    Object.assign(this.overlayEl.style, { left: box.left + 'px', top: box.top + 'px', width: box.width + 'px', height: box.height + 'px' });
    document.body.appendChild(this.overlayEl);
    this.target = { tabs, zone };
  }

  onExternalDragOver(tabs, e) {
    const active = tabs.activeLeaf;
    if (active && active.view && active.view.getViewType() === 'markdown' && active.view.mode === 'source') {
      e.preventDefault();
      e.dataTransfer.dropEffect = 'copy';
      this.target = { tabs, external: true };
    }
  }

  async onDrop(tabs, e) {
    const target = this.target;
    const d = this.dragging;
    if (target && target.external && e.dataTransfer.files.length) {
      e.preventDefault();
      e.stopPropagation();
      this.cleanup();
      const view = tabs.activeLeaf.view;
      const pos = view.editor.view.posAtCoords({ x: e.clientX, y: e.clientY });
      const links = [];
      for (const f of e.dataTransfer.files) {
        const osPath = api.pathForFile(f);
        if (!osPath) continue;
        try {
          const file = await this.workspace.app.fileManager.importExternalFile(osPath, view.file.path);
          links.push(this.workspace.app.fileManager.generateMarkdownLink(file, view.file.path, { embed: file.extension !== 'md' }));
        } catch (err) {
          new Notice('No se pudo importar: ' + err.message);
        }
      }
      if (links.length) {
        const at = pos == null ? view.editor.view.state.selection.main.head : pos;
        view.editor.view.dispatch({ changes: { from: at, insert: links.join('\n') }, selection: { anchor: at + links.join('\n').length } });
        view.editor.focus();
      }
      return;
    }
    if (!d || !target || target.tabs !== tabs) return;
    e.preventDefault();
    e.stopPropagation();
    this.cleanup();
    const ws = this.workspace;
    if (d.type === 'leaf') {
      if (target.index != null) ws.moveLeafToTabs(d.leaf, tabs, target.index);
      else if (target.zone === 'center') ws.moveLeafToTabs(d.leaf, tabs, tabs.children.length);
      else ws.moveLeafToSplit(d.leaf, tabs, target.zone);
      return;
    }
    const files = d.files.filter((f) => !f.isFolder);
    if (!files.length) return;
    let leaf;
    if (target.index != null) {
      leaf = new WorkspaceLeaf(ws);
      tabs.insertChild(target.index, leaf);
      tabs.selectTab(leaf);
    } else if (target.zone === 'center') {
      leaf = tabs.activeLeaf || new WorkspaceLeaf(ws);
      if (!leaf.parent) tabs.insertChild(tabs.children.length, leaf);
    } else {
      leaf = ws.splitTabs(tabs, target.zone);
    }
    ws.render();
    await leaf.openFile(files[0]);
    ws.setActiveLeaf(leaf, { focus: true });
  }
}

/* =========================================================== Workspace */

export class Workspace extends Events {
  constructor(app) {
    super();
    this.app = app;
    this.viewRegistry = {};
    this.activeLeaf = null;
    this.mostRecentRootLeaf = null;
    this.layoutReady = false;
    this.dnd = new DragManager(this);
    this.rootSplit = new WorkspaceSplit(this, 'vertical');
    this.rootSplit.isRoot = true;
    this.leftDock = null;
    this.rightDock = null;
    this.containerEl = el('div.workspace');
    this.requestSaveLayout = debounce(() => this.saveLayout(), 500);
  }

  registerView(type, ViewClass) {
    this.viewRegistry[type] = ViewClass;
  }

  /* ----------------------------------------------------------- DOM */

  buildDom({ ribbonEl } = {}) {
    if (this.app.isMain) {
      this.leftDock = new SideDock(this, 'left');
      this.rightDock = new SideDock(this, 'right');
      this.containerEl.append(ribbonEl, this.leftDock.containerEl, this.rootSplit.containerEl, this.rightDock.containerEl);
      this.leftToggleEl = el('div.sidebar-toggle-button.mod-left', { parent: this.containerEl }, [
        iconButton('panel-left', 'Alternar barra lateral izquierda', () => this.leftDock.toggle()),
      ]);
      this.rightToggleEl = el('div.sidebar-toggle-button.mod-right', { parent: this.containerEl }, [
        iconButton('panel-right', 'Alternar barra lateral derecha', () => this.rightDock.toggle()),
      ]);
      this.ribbonEl = ribbonEl;
    } else {
      this.containerEl.append(this.rootSplit.containerEl);
    }
  }

  render() {
    this.renderNode(this.rootSplit);
    this.updateTopClasses();
  }

  renderNode(node) {
    if (node.type !== 'split') return;
    const c = node.containerEl;
    c.className = `workspace-split mod-${node.direction}` + (node.isRoot ? ' mod-root' : '');
    const wanted = [];
    node.children.forEach((child, i) => {
      this.renderNode(child);
      wanted.push(child.containerEl);
      child.containerEl.style.flexGrow = String(child.size || 1);
      if (i < node.children.length - 1) {
        if (child.resizeHandleEl.parentNode !== child.containerEl) child.containerEl.appendChild(child.resizeHandleEl);
        this.bindResize(node, i);
      } else {
        child.resizeHandleEl.remove();
      }
    });
    // Reordenar sin destruir los elementos existentes (los editores conservan su estado).
    for (const child of [...c.children]) if (!wanted.includes(child)) child.remove();
    wanted.forEach((childEl, i) => {
      if (c.children[i] !== childEl) c.insertBefore(childEl, c.children[i] || null);
    });
  }

  bindResize(split, index) {
    const child = split.children[index];
    const handle = child.resizeHandleEl;
    handle.onmousedown = (e) => {
      e.preventDefault();
      const vertical = split.direction === 'vertical';
      const a = split.children[index];
      const b = split.children[index + 1];
      if (!a || !b) return;
      const sizes = split.children.map((ch) => {
        const r = ch.containerEl.getBoundingClientRect();
        return vertical ? r.width : r.height;
      });
      split.children.forEach((ch, i) => {
        ch.size = sizes[i];
        ch.containerEl.style.flexGrow = String(sizes[i]);
      });
      const start = vertical ? e.clientX : e.clientY;
      const sa = sizes[index];
      const sb = sizes[index + 1];
      const min = 120;
      handle.classList.add('is-active');
      document.body.classList.add('is-grabbing');
      const move = (ev) => {
        let delta = (vertical ? ev.clientX : ev.clientY) - start;
        delta = Math.max(min - sa, Math.min(sb - min, delta));
        a.size = sa + delta;
        b.size = sb - delta;
        a.containerEl.style.flexGrow = String(a.size);
        b.containerEl.style.flexGrow = String(b.size);
      };
      const up = () => {
        document.removeEventListener('mousemove', move);
        document.removeEventListener('mouseup', up);
        handle.classList.remove('is-active');
        document.body.classList.remove('is-grabbing');
        this.requestSaveLayout();
      };
      document.addEventListener('mousemove', move);
      document.addEventListener('mouseup', up);
    };
    handle.ondblclick = () => {
      split.children.forEach((ch) => {
        ch.size = 1;
      });
      this.render();
      this.requestSaveLayout();
    };
  }

  updateTopClasses() {
    const allTabs = [];
    this.iterateTabs(this.rootSplit, (t) => allTabs.push(t));
    for (const t of allTabs) t.containerEl.classList.remove('mod-top', 'mod-top-left-space', 'mod-top-right-space');
    const leftSpace = !this.app.isMain || this.leftDock.collapsed;
    const rightSpace = this.app.isMain && this.rightDock.collapsed;
    const mark = (node, left, right) => {
      if (node.type === 'tabs') {
        node.containerEl.classList.add('mod-top');
        if (left) node.containerEl.classList.add('mod-top-left-space');
        if (right) node.containerEl.classList.add('mod-top-right-space');
        return;
      }
      if (node.direction === 'vertical') {
        node.children.forEach((child, i) => mark(child, left && i === 0, right && i === node.children.length - 1));
      } else if (node.children[0]) {
        mark(node.children[0], left, right);
      }
    };
    mark(this.rootSplit, leftSpace, rightSpace);
    if (this.app.isMain) {
      this.ribbonEl.classList.toggle('is-collapsed', this.leftDock.collapsed);
      this.leftDock.tabs.containerEl.classList.add('mod-top');
      this.rightDock.tabs.containerEl.classList.add('mod-top');
    }
  }

  iterateTabs(node, cb) {
    if (node.type === 'tabs') cb(node);
    else for (const child of node.children) this.iterateTabs(child, cb);
  }

  iterateRootLeaves(cb) {
    this.iterateTabs(this.rootSplit, (tabs) => tabs.children.forEach(cb));
  }

  iterateAllLeaves(cb) {
    this.iterateRootLeaves(cb);
    if (this.leftDock) this.leftDock.tabs.children.forEach(cb);
    if (this.rightDock) this.rightDock.tabs.children.forEach(cb);
  }

  getRootLeaves() {
    const out = [];
    this.iterateRootLeaves((l) => out.push(l));
    return out;
  }

  getLeavesOfType(type) {
    const out = [];
    this.iterateAllLeaves((l) => {
      if (l.view && l.view.getViewType() === type) out.push(l);
    });
    return out;
  }

  isInRoot(leaf) {
    let node = leaf.parent;
    while (node && node.parent) node = node.parent;
    return node === this.rootSplit;
  }

  firstTabs() {
    let node = this.rootSplit;
    while (node && node.type === 'split') node = node.children[0];
    return node;
  }

  /* --------------------------------------------------------- Hojas */

  getActiveRootLeaf() {
    if (this.activeLeaf && this.activeLeaf.parent && this.isInRoot(this.activeLeaf)) return this.activeLeaf;
    if (this.mostRecentRootLeaf && this.mostRecentRootLeaf.parent && this.isInRoot(this.mostRecentRootLeaf)) return this.mostRecentRootLeaf;
    const tabs = this.firstTabs();
    return tabs ? tabs.activeLeaf : null;
  }

  getActiveFile() {
    const leaf = this.getActiveRootLeaf();
    return leaf && leaf.view && leaf.view.file ? leaf.view.file : null;
  }

  // Última nota mostrada en el área principal (para los paneles laterales).
  getLastActiveFile() {
    const file = this.getActiveFile();
    if (file) {
      this.lastActiveFile = file;
      return file;
    }
    const last = this.lastActiveFile;
    if (!last || !this.app.vault.getFile(last.path)) return null;
    const open = this.getRootLeaves().some((l) => l.view && l.view.file === last);
    return open ? last : null;
  }

  getActiveMarkdownView() {
    const leaf = this.getActiveRootLeaf();
    return leaf && leaf.view && leaf.view.getViewType() === 'markdown' ? leaf.view : null;
  }

  ensureRootTabs() {
    let tabs = this.firstTabs();
    if (!tabs) {
      tabs = new WorkspaceTabs(this);
      this.rootSplit.insertChild(0, tabs);
    }
    return tabs;
  }

  getLeaf(newLeaf = false) {
    const active = this.getActiveRootLeaf();
    if (newLeaf === 'split') return this.createLeafBySplit(active, 'vertical');
    if (newLeaf === 'split-horizontal') return this.createLeafBySplit(active, 'horizontal');
    if (newLeaf === 'tab' || newLeaf === true) {
      const tabs = active && active.parent ? active.parent : this.ensureRootTabs();
      const leaf = new WorkspaceLeaf(this);
      tabs.insertChild(active && active.parent === tabs ? tabs.children.indexOf(active) + 1 : tabs.children.length, leaf);
      tabs.selectTab(leaf);
      this.render();
      return leaf;
    }
    if (active) return active;
    return this.getLeaf('tab');
  }

  createLeafBySplit(leaf, direction = 'vertical', before = false) {
    const tabs = leaf && leaf.parent ? leaf.parent : this.ensureRootTabs();
    return this.splitTabs(tabs, direction === 'vertical' ? (before ? 'left' : 'right') : before ? 'top' : 'bottom');
  }

  // Crea un grupo nuevo junto a `tabs` en la zona indicada y devuelve una hoja vacía dentro.
  splitTabs(tabs, zone, leaf) {
    const direction = zone === 'left' || zone === 'right' ? 'vertical' : 'horizontal';
    const before = zone === 'left' || zone === 'top';
    const newTabs = new WorkspaceTabs(this);
    const newLeaf = leaf || new WorkspaceLeaf(this);
    newTabs.insertChild(0, newLeaf);
    const parent = tabs.parent;
    if (parent.direction === direction) {
      const i = parent.children.indexOf(tabs);
      const half = (tabs.size || 1) / 2;
      tabs.size = half;
      newTabs.size = half;
      parent.insertChild(before ? i : i + 1, newTabs);
    } else {
      const split = new WorkspaceSplit(this, direction);
      split.size = tabs.size || 1;
      parent.replaceChild(tabs, split);
      tabs.size = 1;
      newTabs.size = 1;
      split.insertChild(0, before ? newTabs : tabs);
      split.insertChild(1, before ? tabs : newTabs);
    }
    this.render();
    this.requestSaveLayout();
    return newLeaf;
  }

  async newTabIn(tabs) {
    const leaf = new WorkspaceLeaf(this);
    const active = tabs.activeLeaf;
    tabs.insertChild(active ? tabs.children.indexOf(active) + 1 : tabs.children.length, leaf);
    tabs.selectTab(leaf);
    await leaf.setViewState({ type: 'empty' }, { history: false });
    this.render();
    this.setActiveLeaf(leaf, { focus: true });
  }

  async duplicateLeaf(leaf, where = 'vertical', stateOverrides = {}) {
    const viewState = leaf.getViewState();
    viewState.state = { ...viewState.state, ...stateOverrides };
    let newLeaf;
    if (where === 'tab') {
      newLeaf = new WorkspaceLeaf(this);
      leaf.parent.insertChild(leaf.parent.children.indexOf(leaf) + 1, newLeaf);
      leaf.parent.selectTab(newLeaf);
      this.render();
    } else {
      newLeaf = this.createLeafBySplit(leaf, where);
    }
    await newLeaf.setViewState(viewState, { history: false });
    this.setActiveLeaf(newLeaf, { focus: true });
    return newLeaf;
  }

  async openLeafInNewWindow(leaf, move) {
    const viewState = leaf.getViewState();
    await api.popout({ main: { type: 'split', direction: 'vertical', children: [{ type: 'tabs', currentTab: 0, children: [{ type: 'leaf', state: viewState }] }] } });
    if (move) this.detachLeaf(leaf);
  }

  detachLeaf(leaf) {
    const tabs = leaf.parent;
    if (!tabs || leaf.sidedock) return;
    const wasActive = this.activeLeaf === leaf;
    if (leaf.view) leaf.view.onClose();
    tabs.removeChild(leaf);
    this.cleanupTabs(tabs);
    if (!this.getRootLeaves().length) {
      if (!this.app.isMain) {
        this.saveLayout();
        api.closeWindow();
        return;
      }
      const newLeaf = new WorkspaceLeaf(this);
      this.ensureRootTabs().insertChild(0, newLeaf);
      newLeaf.setViewState({ type: 'empty' }, { history: false });
      this.render();
      this.setActiveLeaf(newLeaf);
    } else {
      this.render();
      if (wasActive) {
        const next = tabs.parent && tabs.activeLeaf ? tabs.activeLeaf : this.mostRecentRootLeaf && this.mostRecentRootLeaf !== leaf && this.mostRecentRootLeaf.parent ? this.mostRecentRootLeaf : this.getRootLeaves()[0];
        this.activeLeaf = null;
        if (next) this.setActiveLeaf(next, { focus: true });
      }
    }
    this.requestSaveLayout();
    this.trigger('layout-change');
  }

  // Quita grupos vacíos y divisiones con un solo hijo.
  cleanupTabs(tabs) {
    if (tabs.children.length || !tabs.parent) return;
    const parent = tabs.parent;
    if (parent === this.rootSplit && parent.children.length === 1) return;
    parent.removeChild(tabs);
    tabs.containerEl.remove();
    this.collapseSplit(parent);
  }

  collapseSplit(split) {
    if (split.isRoot) {
      if (split.children.length === 1 && split.children[0].type === 'split') {
        const only = split.children[0];
        split.children = [];
        split.direction = only.direction;
        for (const child of only.children) split.insertChild(split.children.length, child);
        only.containerEl.remove();
      }
      return;
    }
    if (split.children.length === 0) {
      const parent = split.parent;
      parent.removeChild(split);
      split.containerEl.remove();
      this.collapseSplit(parent);
    } else if (split.children.length === 1) {
      const only = split.children[0];
      const parent = split.parent;
      only.size = split.size;
      parent.replaceChild(split, only);
      split.containerEl.remove();
      if (only.type === 'split' && only.direction === parent.direction) {
        const i = parent.children.indexOf(only);
        parent.children.splice(i, 1, ...only.children);
        for (const c of only.children) c.parent = parent;
        only.containerEl.remove();
      }
    }
  }

  moveLeafToTabs(leaf, tabs, index) {
    const from = leaf.parent;
    if (from === tabs) {
      const current = tabs.children.indexOf(leaf);
      if (index > current) index -= 1;
      if (index === current) return;
    }
    from.removeChild(leaf);
    tabs.insertChild(index, leaf);
    tabs.selectTab(leaf);
    if (from !== tabs) this.cleanupTabs(from);
    this.render();
    this.setActiveLeaf(leaf, { focus: true });
    this.requestSaveLayout();
  }

  moveLeafToSplit(leaf, tabs, zone) {
    const from = leaf.parent;
    if (from === tabs && tabs.children.length === 1) return;
    from.removeChild(leaf);
    this.splitTabs(tabs, zone, leaf);
    if (from !== tabs) this.cleanupTabs(from);
    this.render();
    this.setActiveLeaf(leaf, { focus: true });
    this.requestSaveLayout();
  }

  setActiveLeaf(leaf, { focus = false } = {}) {
    if (!leaf || !leaf.parent) return;
    if (this.activeLeaf === leaf) {
      if (focus && leaf.view) leaf.view.focus();
      return;
    }
    if (leaf.sidedock) {
      if (focus && leaf.view) leaf.view.focus();
      return;
    }
    const previous = this.activeLeaf;
    if (previous) previous.containerEl.classList.remove('mod-active');
    this.iterateTabs(this.rootSplit, (t) => t.containerEl.classList.remove('mod-active'));
    this.activeLeaf = leaf;
    leaf.containerEl.classList.add('mod-active');
    if (leaf.parent) {
      leaf.parent.containerEl.classList.add('mod-active');
      leaf.parent.selectTab(leaf);
    }
    this.mostRecentRootLeaf = leaf;
    if (focus && leaf.view) leaf.view.focus();
    this.app.updateTitle();
    this.trigger('active-leaf-change', leaf);
    this.trigger('file-open', this.getActiveFile());
    this.requestSaveLayout();
  }

  onLeafStateChange(leaf) {
    if (!this.layoutReady) return;
    if (leaf === this.getActiveRootLeaf()) this.trigger('file-open', this.getActiveFile());
    this.trigger('layout-change');
    this.requestSaveLayout();
  }

  /* ------------------------------------------------------- Abrir */

  async openFile(file, newLeaf = false, { state, eState } = {}) {
    if (!file) return null;
    if (newLeaf === 'window') {
      const type = viewTypeForFile(file);
      await api.popout({ main: { type: 'split', direction: 'vertical', children: [{ type: 'tabs', currentTab: 0, children: [{ type: 'leaf', state: { type, state: { file: file.path, ...(state || {}) } } }] }] } });
      return null;
    }
    const leaf = this.getLeaf(newLeaf);
    state = { ...(state || {}) };
    if (!state.mode) {
      // Una pestaña conserva su modo (lectura o edición) al navegar entre notas.
      const current = leaf.view && leaf.view.getViewType() === 'markdown' ? leaf.view.mode : null;
      state.mode = current || this.app.settings.get('defaultViewMode');
    }
    await leaf.openFile(file, { state, eState });
    this.setActiveLeaf(leaf, { focus: !eState || !eState.rename });
    if (eState && eState.rename) leaf.view.setEphemeralState(eState);
    this.app.recordRecentFile(file);
    return leaf;
  }

  async openLinkText(linktext, sourcePath, newLeaf = false, { state, eState } = {}) {
    const { linkpath, subpath } = parseLinkInner(linktext || '');
    let file = linkpath ? this.app.metadataCache.getFirstLinkpathDest(linkpath, sourcePath) : this.app.vault.getFile(sourcePath);
    if (!file) {
      if (!linkpath) return;
      const clean = linkpath.replace(/\.md$/i, '');
      const folder = clean.includes('/') ? dirname(clean) : this.app.fileManager.getNewFileParent(sourcePath);
      const error = this.app.fileManager.validateName(basename(clean));
      if (error) {
        new Notice(error);
        return;
      }
      file = await this.app.fileManager.createNewMarkdownFile(folder, basename(clean));
    }
    const active = this.getActiveRootLeaf();
    if (!newLeaf && subpath && active && active.view && active.view.file === file) {
      active.view.setEphemeralState({ subpath });
      return;
    }
    await this.openFile(file, newLeaf, { state, eState: subpath ? { subpath, ...(eState || {}) } : eState });
  }

  /* ------------------------------------------------------- Menús */

  buildTabMenu(menu, leaf) {
    const tabs = leaf.parent;
    menu.addItem((i) => i.setTitle('Cerrar').setIcon('x').onClick(() => leaf.detach()));
    menu.addItem((i) => i.setTitle('Cerrar las demás pestañas').setDisabled(tabs.children.length < 2).onClick(() => {
      for (const other of [...tabs.children]) if (other !== leaf) other.detach();
    }));
    menu.addItem((i) => i.setTitle('Cerrar las pestañas de la derecha').setDisabled(tabs.children.indexOf(leaf) === tabs.children.length - 1).onClick(() => {
      for (const other of tabs.children.slice(tabs.children.indexOf(leaf) + 1)) other.detach();
    }));
    menu.addItem((i) => i.setTitle('Cerrar todas').onClick(() => {
      for (const other of [...tabs.children]) other.detach();
    }));
    menu.addSeparator();
    menu.addItem((i) => i.setTitle('Dividir a la derecha').setIcon('separator-vertical').onClick(() => this.duplicateLeaf(leaf, 'vertical')));
    menu.addItem((i) => i.setTitle('Dividir hacia abajo').setIcon('separator-horizontal').onClick(() => this.duplicateLeaf(leaf, 'horizontal')));
    menu.addItem((i) => i.setTitle('Abrir en una ventana nueva').setIcon('app-window').onClick(() => this.openLeafInNewWindow(leaf, false)));
    menu.addItem((i) => i.setTitle('Mover a una ventana nueva').setIcon('app-window').onClick(() => this.openLeafInNewWindow(leaf, true)));
    menu.addSeparator();
    if (leaf.view && leaf.view.file) this.app.addFileMenuItems(menu, leaf.view.file, 'tab-header');
  }

  /* ------------------------------------------------ Serialización */

  serializeNode(node) {
    if (node.type === 'split') {
      return { type: 'split', direction: node.direction, size: node.size, children: node.children.map((c) => this.serializeNode(c)) };
    }
    return {
      type: 'tabs',
      size: node.size,
      currentTab: node.currentTab,
      children: node.children.map((leaf) => ({ type: 'leaf', id: leaf.id, state: leaf.getViewState() })),
    };
  }

  async deserializeNode(json) {
    if (json.type === 'split') {
      const split = new WorkspaceSplit(this, json.direction || 'vertical');
      split.size = json.size || 1;
      for (const childJson of json.children || []) {
        const child = await this.deserializeNode(childJson);
        if (child) split.insertChild(split.children.length, child);
      }
      return split.children.length ? split : null;
    }
    if (json.type === 'tabs') {
      const tabs = new WorkspaceTabs(this);
      tabs.size = json.size || 1;
      for (const leafJson of json.children || []) {
        const leaf = new WorkspaceLeaf(this);
        if (leafJson.id) leaf.id = leafJson.id;
        tabs.insertChild(tabs.children.length, leaf);
        await this.restoreLeafState(leaf, leafJson.state);
      }
      if (!tabs.children.length) return null;
      tabs.currentTab = Math.min(json.currentTab || 0, tabs.children.length - 1);
      tabs.updateTabDisplay();
      return tabs;
    }
    return null;
  }

  async restoreLeafState(leaf, viewState) {
    let state = viewState || { type: 'empty' };
    if (state.state && state.state.file && !this.app.vault.getFile(state.state.file)) state = { type: 'empty' };
    try {
      await leaf.setViewState(state, { history: false });
    } catch (err) {
      console.error('No se pudo restaurar la pestaña', err);
      await leaf.setViewState({ type: 'empty' }, { history: false });
    }
  }

  serialize() {
    const data = {
      main: this.serializeNode(this.rootSplit),
      active: this.activeLeaf ? this.activeLeaf.id : null,
    };
    if (this.app.isMain) {
      data.left = this.leftDock.serialize();
      data.right = this.rightDock.serialize();
      data.lastOpenFiles = this.app.recentFiles.slice(0, 20);
    }
    return data;
  }

  async loadLayout(layout) {
    let root = null;
    if (layout && layout.main) {
      try {
        root = await this.deserializeNode(layout.main);
      } catch (err) {
        console.error('Diseño dañado, se usa el predeterminado', err);
      }
    }
    if (root && root.type === 'split') {
      this.rootSplit.direction = root.direction;
      for (const child of [...root.children]) this.rootSplit.insertChild(this.rootSplit.children.length, child);
    } else if (root) {
      this.rootSplit.insertChild(0, root);
    } else {
      const tabs = new WorkspaceTabs(this);
      this.rootSplit.insertChild(0, tabs);
      const leaf = new WorkspaceLeaf(this);
      tabs.insertChild(0, leaf);
      const welcome = this.app.isMain ? this.app.vault.getFile('Bienvenida.md') : null;
      if (welcome) await leaf.setViewState({ type: 'markdown', state: { file: welcome.path, mode: 'source' } }, { history: false });
      else await leaf.setViewState({ type: 'empty' }, { history: false });
    }

    if (this.app.isMain) {
      const left = (layout && layout.left) || {};
      const right = (layout && layout.right) || {};
      for (const type of ['file-explorer', 'search', 'bookmarks']) {
        const leaf = await this.leftDock.addView(type);
        if (left.views && left.views[type]) await leaf.view.setState(left.views[type]);
      }
      for (const type of ['backlink', 'outgoing-link', 'tag', 'outline']) {
        const leaf = await this.rightDock.addView(type);
        if (right.views && right.views[type]) await leaf.view.setState(right.views[type]);
      }
      this.leftDock.width = left.width || 280;
      this.leftDock.collapsed = !!left.collapsed;
      this.rightDock.width = right.width || 300;
      this.rightDock.collapsed = right.collapsed != null ? right.collapsed : false;
      this.leftDock.applyWidth();
      this.rightDock.applyWidth();
      const leftActive = this.leftDock.getLeafOfType(left.active || 'file-explorer');
      if (leftActive) this.leftDock.tabs.selectTab(leftActive);
      const rightActive = this.rightDock.getLeafOfType(right.active || 'backlink');
      if (rightActive) this.rightDock.tabs.selectTab(rightActive);
      if (layout && layout.lastOpenFiles) this.app.recentFiles = layout.lastOpenFiles.filter((p) => this.app.vault.getFile(p));
    }

    this.render();
    let active = null;
    if (layout && layout.active) this.iterateRootLeaves((l) => {
      if (l.id === layout.active) active = l;
    });
    this.layoutReady = true;
    this.setActiveLeaf(active || this.getActiveRootLeaf(), { focus: false });
    this.trigger('layout-ready');
    this.trigger('file-open', this.getActiveFile());
  }

  async saveLayout() {
    if (!this.layoutReady) return;
    await api.saveWorkspace(this.serialize());
  }

  /* ---------------------------------------------- Cambios en archivos */

  onFileRenamed(file) {
    this.iterateAllLeaves((leaf) => {
      if (leaf.view && leaf.view.file && (leaf.view.file === file || (file.isFolder && leaf.view.file.path.startsWith(file.path + '/')))) {
        leaf.view.onFileRenamed(file);
      }
    });
    this.app.updateTitle();
    this.requestSaveLayout();
  }

  onFileDeleted(file) {
    const leaves = [];
    this.iterateRootLeaves((leaf) => {
      if (leaf.view && leaf.view.file === file) leaves.push(leaf);
    });
    for (const leaf of leaves) {
      leaf.history.back = leaf.history.back.filter((h) => h.state.file !== file.path);
      leaf.history.forward = leaf.history.forward.filter((h) => h.state.file !== file.path);
      leaf.setViewState({ type: 'empty' }, { history: false });
    }
  }
}
