// Componentes de interfaz: menús contextuales, modales, sugerencias, avisos y tooltips.
import { el, empty, iconButton, renderHighlighted } from './util.js';
import { icon } from './icons.js';

/* ================================================================= Menú */

let currentMenu = null;

export class Menu {
  constructor() {
    this.items = [];
    this.hideCallbacks = [];
    this.dom = null;
    this.selected = -1;
  }

  addItem(cb) {
    const item = new MenuItem();
    cb(item);
    this.items.push(item);
    return this;
  }

  addSeparator() {
    if (this.items.length && !this.items[this.items.length - 1].separator) this.items.push({ separator: true });
    return this;
  }

  addLabel(text) {
    this.items.push({ label: text });
    return this;
  }

  onHide(cb) {
    this.hideCallbacks.push(cb);
    return this;
  }

  showAtMouseEvent(e) {
    e.preventDefault();
    e.stopPropagation();
    return this.showAtPosition({ x: e.clientX, y: e.clientY });
  }

  showBelow(target) {
    const rect = target.getBoundingClientRect();
    target.classList.add('has-active-menu');
    this.onHide(() => target.classList.remove('has-active-menu'));
    return this.showAtPosition({ x: rect.left, y: rect.bottom + 4 });
  }

  showAtPosition({ x, y }) {
    if (currentMenu) currentMenu.hide();
    currentMenu = this;
    while (this.items.length && this.items[this.items.length - 1].separator) this.items.pop();
    this.dom = el('div.menu');
    this.itemEls = [];
    for (const item of this.items) {
      if (item.separator) {
        this.dom.appendChild(el('div.menu-separator'));
        continue;
      }
      if (item.label) {
        this.dom.appendChild(el('div.menu-label', { text: item.label }));
        continue;
      }
      const itemEl = el('div.menu-item', {
        cls: [item.disabled && 'is-disabled', item.warning && 'is-warning', item.checked && 'is-checked'],
      }, [
        el('div.menu-item-icon', item.iconName ? [icon(item.iconName)] : []),
        el('div.menu-item-title', { text: item.title }),
        item.checked != null ? el('div.menu-item-check', [icon('check')]) : null,
      ]);
      itemEl.addEventListener('mousedown', (e) => e.preventDefault());
      itemEl.addEventListener('click', (e) => {
        e.stopPropagation();
        this.hide();
        if (item.callback) item.callback(e);
      });
      itemEl.addEventListener('mouseenter', () => this.select(this.itemEls.indexOf(itemEl)));
      this.itemEls.push(itemEl);
      this.dom.appendChild(itemEl);
    }
    document.body.appendChild(this.dom);
    const rect = this.dom.getBoundingClientRect();
    const left = Math.min(x, window.innerWidth - rect.width - 8);
    const top = y + rect.height > window.innerHeight - 8 ? Math.max(8, y - rect.height) : y;
    this.dom.style.left = Math.max(8, left) + 'px';
    this.dom.style.top = top + 'px';

    this._onDown = (e) => {
      if (this.dom && !this.dom.contains(e.target)) this.hide();
    };
    this._onKey = (e) => {
      if (e.key === 'Escape') {
        e.preventDefault();
        this.hide();
      } else if (e.key === 'ArrowDown') {
        e.preventDefault();
        this.select((this.selected + 1) % this.itemEls.length);
      } else if (e.key === 'ArrowUp') {
        e.preventDefault();
        this.select((this.selected - 1 + this.itemEls.length) % this.itemEls.length);
      } else if (e.key === 'Enter' && this.selected >= 0) {
        e.preventDefault();
        this.itemEls[this.selected].click();
      }
    };
    this._onBlur = () => this.hide();
    setTimeout(() => {
      document.addEventListener('mousedown', this._onDown, true);
      document.addEventListener('contextmenu', this._onDown, true);
    });
    document.addEventListener('keydown', this._onKey, true);
    window.addEventListener('blur', this._onBlur);
    return this;
  }

  select(index) {
    if (this.itemEls[this.selected]) this.itemEls[this.selected].classList.remove('is-selected');
    this.selected = index;
    if (this.itemEls[index]) this.itemEls[index].classList.add('is-selected');
  }

  hide() {
    if (!this.dom) return;
    this.dom.remove();
    this.dom = null;
    document.removeEventListener('mousedown', this._onDown, true);
    document.removeEventListener('contextmenu', this._onDown, true);
    document.removeEventListener('keydown', this._onKey, true);
    window.removeEventListener('blur', this._onBlur);
    if (currentMenu === this) currentMenu = null;
    for (const cb of this.hideCallbacks) cb();
  }
}

class MenuItem {
  constructor() {
    this.title = '';
    this.iconName = null;
    this.callback = null;
    this.disabled = false;
    this.checked = null;
    this.warning = false;
  }

  setTitle(title) {
    this.title = title;
    return this;
  }

  setIcon(name) {
    this.iconName = name;
    return this;
  }

  onClick(cb) {
    this.callback = cb;
    return this;
  }

  setDisabled(disabled) {
    this.disabled = disabled;
    return this;
  }

  setChecked(checked) {
    this.checked = !!checked;
    return this;
  }

  setWarning(warning) {
    this.warning = warning;
    return this;
  }
}

/* =============================================================== Modal */

const openModals = [];

export function hasOpenModal() {
  return openModals.length > 0;
}

export class Modal {
  constructor(app) {
    this.app = app;
    this.containerEl = el('div.modal-container.mod-dim');
    this.bgEl = el('div.modal-bg', { parent: this.containerEl });
    this.modalEl = el('div.modal', { parent: this.containerEl });
    this.closeButtonEl = iconButton('x', null, () => this.close(), 'modal-close-button');
    this.modalEl.appendChild(this.closeButtonEl);
    this.titleEl = el('div.modal-title', { parent: this.modalEl });
    this.contentEl = el('div.modal-content', { parent: this.modalEl });
    this.bgEl.addEventListener('click', () => this.close());
    this._onKey = (e) => {
      if (openModals[openModals.length - 1] !== this) return;
      if (e.key === 'Escape') {
        e.preventDefault();
        e.stopPropagation();
        this.close();
      }
    };
  }

  setTitle(text) {
    this.titleEl.textContent = text;
    return this;
  }

  open() {
    this.previousFocus = document.activeElement;
    document.body.appendChild(this.containerEl);
    openModals.push(this);
    document.addEventListener('keydown', this._onKey, true);
    this.onOpen();
    const focusable = this.modalEl.querySelector('input, textarea, button.mod-cta');
    if (focusable) focusable.focus();
    return this;
  }

  close() {
    if (!this.containerEl.isConnected) return;
    this.onClose();
    this.containerEl.remove();
    const i = openModals.indexOf(this);
    if (i >= 0) openModals.splice(i, 1);
    document.removeEventListener('keydown', this._onKey, true);
    if (this.previousFocus && this.previousFocus.isConnected && this.restoreFocus !== false) this.previousFocus.focus();
  }

  onOpen() {}

  onClose() {}
}

export function confirmDialog(app, { title, message, confirmText = 'Aceptar', cancelText = 'Cancelar', warning = false }) {
  return new Promise((resolve) => {
    let result = false;
    const modal = new Modal(app);
    modal.setTitle(title);
    modal.contentEl.appendChild(el('p', { text: message }));
    const buttons = el('div.modal-button-container', { parent: modal.modalEl });
    const ok = el('button', { cls: warning ? 'mod-warning' : 'mod-cta', text: confirmText, parent: buttons });
    const cancel = el('button', { text: cancelText, parent: buttons });
    buttons.insertBefore(cancel, ok);
    ok.addEventListener('click', () => {
      result = true;
      modal.close();
    });
    cancel.addEventListener('click', () => modal.close());
    modal.onClose = () => resolve(result);
    modal.open();
    ok.focus();
  });
}

export function promptDialog(app, { title, placeholder = '', value = '', confirmText = 'Aceptar', description }) {
  return new Promise((resolve) => {
    let result = null;
    const modal = new Modal(app);
    modal.setTitle(title);
    if (description) modal.contentEl.appendChild(el('p', { text: description }));
    const input = el('input', { attr: { type: 'text', placeholder, spellcheck: 'false' }, parent: modal.contentEl });
    input.value = value;
    const buttons = el('div.modal-button-container', { parent: modal.modalEl });
    const cancel = el('button', { text: 'Cancelar', parent: buttons });
    const ok = el('button.mod-cta', { text: confirmText, parent: buttons });
    const submit = () => {
      result = input.value.trim();
      modal.close();
    };
    ok.addEventListener('click', submit);
    cancel.addEventListener('click', () => modal.close());
    input.addEventListener('keydown', (e) => {
      if (e.key === 'Enter' && !e.isComposing) {
        e.preventDefault();
        submit();
      }
    });
    modal.onClose = () => resolve(result || null);
    modal.open();
    input.focus();
    input.select();
  });
}

/* ====================================================== Lista de sugerencias */

export class SuggestModal {
  constructor(app) {
    this.app = app;
    this.limit = 100;
    this.selected = 0;
    this.items = [];
    this.emptyStateText = 'No se encontraron resultados.';
    this.containerEl = el('div.modal-container.mod-prompt');
    this.bgEl = el('div.modal-bg', { parent: this.containerEl });
    this.promptEl = el('div.prompt', { parent: this.containerEl });
    const inputContainer = el('div.prompt-input-container', { parent: this.promptEl });
    this.inputEl = el('input.prompt-input', { attr: { type: 'text', spellcheck: 'false', enterkeyhint: 'done' }, parent: inputContainer });
    this.resultsEl = el('div.prompt-results', { parent: this.promptEl });
    this.instructionsEl = el('div.prompt-instructions', { parent: this.promptEl });
    this.bgEl.addEventListener('click', () => this.close());
    this.inputEl.addEventListener('input', () => this.update());
    this.inputEl.addEventListener('keydown', (e) => this.onKeyDown(e));
  }

  setPlaceholder(text) {
    this.inputEl.placeholder = text;
  }

  setInstructions(list) {
    empty(this.instructionsEl);
    for (const { command, purpose } of list) {
      el('div.prompt-instruction', { parent: this.instructionsEl }, [
        el('span.prompt-instruction-command', { text: command }),
        el('span', { text: purpose }),
      ]);
    }
  }

  open() {
    this.previousFocus = document.activeElement;
    document.body.appendChild(this.containerEl);
    openModals.push(this);
    this.update();
    this.inputEl.focus();
    this.onOpen();
  }

  onOpen() {}

  close() {
    if (!this.containerEl.isConnected) return;
    this.containerEl.remove();
    const i = openModals.indexOf(this);
    if (i >= 0) openModals.splice(i, 1);
    if (this.previousFocus && this.previousFocus.isConnected && this.restoreFocus !== false) this.previousFocus.focus();
    this.onClose();
  }

  onClose() {}

  update() {
    const query = this.inputEl.value;
    this.items = this.getSuggestions(query).slice(0, this.limit);
    this.selected = 0;
    empty(this.resultsEl);
    this.itemEls = [];
    if (!this.items.length) {
      const emptyEl = el('div.suggestion-empty', { text: this.emptyStateText, parent: this.resultsEl });
      this.renderEmpty(emptyEl, query);
      return;
    }
    this.items.forEach((item, i) => {
      const itemEl = el('div.suggestion-item', { parent: this.resultsEl });
      this.renderSuggestion(item, itemEl);
      itemEl.addEventListener('mousemove', () => this.select(i));
      itemEl.addEventListener('mousedown', (e) => e.preventDefault());
      itemEl.addEventListener('click', (e) => this.choose(item, e));
      this.itemEls.push(itemEl);
    });
    this.select(0);
  }

  renderEmpty() {}

  select(index) {
    if (!this.itemEls || !this.itemEls.length) return;
    if (this.itemEls[this.selected]) this.itemEls[this.selected].classList.remove('is-selected');
    this.selected = index;
    const itemEl = this.itemEls[index];
    if (itemEl) {
      itemEl.classList.add('is-selected');
      itemEl.scrollIntoView({ block: 'nearest' });
    }
  }

  choose(item, evt) {
    this.close();
    this.onChooseSuggestion(item, evt);
  }

  onKeyDown(e) {
    if (e.isComposing) return;
    if (e.key === 'ArrowDown' || (e.ctrlKey && e.key === 'n')) {
      e.preventDefault();
      if (this.items.length) this.select((this.selected + 1) % this.items.length);
    } else if (e.key === 'ArrowUp' || (e.ctrlKey && e.key === 'p')) {
      e.preventDefault();
      if (this.items.length) this.select((this.selected - 1 + this.items.length) % this.items.length);
    } else if (e.key === 'Enter') {
      e.preventDefault();
      if (this.items.length) this.choose(this.items[this.selected], e);
      else this.onEmptyEnter(this.inputEl.value, e);
    } else if (e.key === 'Escape') {
      e.preventDefault();
      e.stopPropagation();
      this.close();
    }
  }

  onEmptyEnter() {}

  getSuggestions() {
    return [];
  }

  renderSuggestion(item, itemEl) {
    itemEl.textContent = String(item);
  }

  onChooseSuggestion() {}
}

export function renderSuggestionText(parent, title, matches, note) {
  const content = el('div.suggestion-content', { parent });
  const titleEl = el('div.suggestion-title', { parent: content });
  renderHighlighted(titleEl, title, matches);
  if (note) el('div.suggestion-note', { text: note, parent: content });
  return content;
}

/* ================================================================ Avisos */

let noticeContainer = null;

export class Notice {
  constructor(message, timeout = 4000) {
    if (!noticeContainer || !noticeContainer.isConnected) noticeContainer = el('div.notice-container', { parent: document.body });
    this.noticeEl = el('div.notice', { text: message, parent: noticeContainer });
    this.noticeEl.addEventListener('click', () => this.hide());
    if (timeout) setTimeout(() => this.hide(), timeout);
  }

  setMessage(message) {
    this.noticeEl.textContent = message;
  }

  hide() {
    this.noticeEl.remove();
  }
}

/* ============================================================== Tooltips */

export function installTooltips() {
  let timer = null;
  let tip = null;
  let current = null;
  const hide = () => {
    clearTimeout(timer);
    if (tip) tip.remove();
    tip = null;
    current = null;
  };
  document.addEventListener('mouseover', (e) => {
    const target = e.target.closest && e.target.closest('[aria-label]');
    if (target === current) return;
    hide();
    if (!target || target.closest('.menu') || document.body.classList.contains('is-grabbing')) return;
    current = target;
    timer = setTimeout(() => {
      if (!current || !current.isConnected) return;
      const label = current.getAttribute('aria-label');
      if (!label) return;
      tip = el('div.tooltip', { text: label, parent: document.body });
      const rect = current.getBoundingClientRect();
      const tipRect = tip.getBoundingClientRect();
      const position = current.getAttribute('data-tooltip-position') || 'bottom';
      let top;
      let left;
      if (position === 'right') {
        top = rect.top + rect.height / 2 - tipRect.height / 2;
        left = rect.right + 8;
      } else if (position === 'top') {
        top = rect.top - tipRect.height - 8;
        left = rect.left + rect.width / 2 - tipRect.width / 2;
      } else {
        top = rect.bottom + 8;
        left = rect.left + rect.width / 2 - tipRect.width / 2;
        if (top + tipRect.height > window.innerHeight - 4) top = rect.top - tipRect.height - 8;
      }
      tip.style.top = Math.max(4, top) + 'px';
      tip.style.left = Math.max(4, Math.min(left, window.innerWidth - tipRect.width - 4)) + 'px';
    }, 450);
  });
  document.addEventListener('mousedown', hide, true);
  document.addEventListener('keydown', hide, true);
  window.addEventListener('blur', hide);
}
