// Selector rápido, paleta de comandos y selector de carpeta.
import { el, fuzzyMatch, dirname, formatHotkey, isModEvent, isMac } from './util.js';
import { icon } from './icons.js';
import { SuggestModal, renderSuggestionText } from './ui.js';

const MOD = isMac ? '⌘' : 'Ctrl';
const ALT = isMac ? '⌥' : 'Alt';
const SHIFT = isMac ? '⇧' : 'Shift';

export class QuickSwitcher extends SuggestModal {
  constructor(app, { recentOnly = false } = {}) {
    super(app);
    this.recentOnly = recentOnly;
    this.setPlaceholder('Busca o crea un archivo…');
    this.emptyStateText = 'No se encontró ningún archivo.';
    this.setInstructions([
      { command: '↑↓', purpose: 'para navegar' },
      { command: '↵', purpose: 'para abrir' },
      { command: `${MOD} ↵`, purpose: 'para abrir en una pestaña nueva' },
      { command: `${MOD} ${ALT} ↵`, purpose: 'para abrir a la derecha' },
      { command: `${SHIFT} ↵`, purpose: 'para crear' },
      { command: 'esc', purpose: 'para cerrar' },
    ]);
  }

  getSuggestions(query) {
    const vault = this.app.vault;
    const files = vault.getFiles();
    if (!query.trim()) {
      const recent = this.app.recentFiles.map((p) => vault.getFile(p)).filter(Boolean);
      const recentSet = new Set(recent);
      const rest = this.recentOnly ? [] : files.filter((f) => !recentSet.has(f) && f.extension === 'md').sort((a, b) => b.stat.mtime - a.stat.mtime);
      return [...recent, ...rest].map((file) => ({ file, matches: [], title: this.titleOf(file) }));
    }
    const results = [];
    for (const file of files) {
      const title = this.titleOf(file);
      let best = fuzzyMatch(query, title);
      let usedPath = false;
      if (query.includes('/')) {
        const pathMatch = fuzzyMatch(query, file.path);
        if (pathMatch && (!best || pathMatch.score > best.score)) {
          best = pathMatch;
          usedPath = true;
        }
      }
      if (best) results.push({ file, title: usedPath ? file.path : title, matches: best.matches, score: best.score + (file.extension === 'md' ? 2 : 0) });
      if (file.extension === 'md') {
        for (const alias of this.app.metadataCache.getAliases(file.path)) {
          const m = fuzzyMatch(query, alias);
          if (m) results.push({ file, title: alias, alias: true, matches: m.matches, score: m.score - 1 });
        }
      }
    }
    return results.sort((a, b) => b.score - a.score || a.title.localeCompare(b.title, 'es'));
  }

  titleOf(file) {
    return file.extension === 'md' ? file.basename : file.name;
  }

  renderSuggestion(item, itemEl) {
    const folder = dirname(item.file.path);
    renderSuggestionText(itemEl, item.title, item.matches, item.alias ? item.file.basename : folder || null);
    if (item.file.extension !== 'md') el('div.suggestion-aux', { parent: itemEl }, [el('span.nav-file-tag', { text: item.file.extension })]);
  }

  renderEmpty(emptyEl, query) {
    if (query.trim()) emptyEl.textContent = `No se encontró nada. Pulsa ↵ para crear «${query.trim()}».`;
  }

  onKeyDown(e) {
    if (e.key === 'Enter' && e.shiftKey && !e.isComposing) {
      e.preventDefault();
      this.close();
      this.createNote(this.inputEl.value, e);
      return;
    }
    super.onKeyDown(e);
  }

  async createNote(query, e) {
    const name = query.trim();
    if (!name) return;
    await this.app.workspace.openLinkText(name, this.app.workspace.getActiveFile()?.path || '', isModEvent(e) ? 'tab' : false);
  }

  onEmptyEnter(query, e) {
    this.close();
    this.createNote(query, e);
  }

  onChooseSuggestion(item, e) {
    const newLeaf = isModEvent(e) ? (e.altKey ? 'split' : 'tab') : false;
    this.app.workspace.openFile(item.file, newLeaf);
  }
}

export class CommandPalette extends SuggestModal {
  constructor(app) {
    super(app);
    this.setPlaceholder('Escribe un comando…');
    this.emptyStateText = 'No se encontraron comandos.';
    this.setInstructions([
      { command: '↑↓', purpose: 'para navegar' },
      { command: '↵', purpose: 'para usar' },
      { command: 'esc', purpose: 'para cerrar' },
    ]);
  }

  getSuggestions(query) {
    const commands = this.app.commands.list().filter((c) => this.app.commands.isAvailable(c));
    const recent = this.app.commands.recent;
    if (!query.trim()) {
      return commands
        .map((c) => ({ command: c, matches: [], rank: recent.includes(c.id) ? recent.indexOf(c.id) : 1000 }))
        .sort((a, b) => a.rank - b.rank || a.command.name.localeCompare(b.command.name, 'es'));
    }
    return commands
      .map((c) => ({ command: c, match: fuzzyMatch(query, c.name) }))
      .filter((x) => x.match)
      .map((x) => ({ command: x.command, matches: x.match.matches, score: x.match.score }))
      .sort((a, b) => b.score - a.score);
  }

  renderSuggestion(item, itemEl) {
    renderSuggestionText(itemEl, item.command.name, item.matches);
    const aux = el('div.suggestion-aux', { parent: itemEl });
    if (this.app.commands.recent.includes(item.command.id) && !this.inputEl.value.trim()) aux.appendChild(icon('pin'));
    if (item.command.hotkey) el('kbd.suggestion-hotkey', { text: formatHotkey(item.command.hotkey), parent: aux });
  }

  onChooseSuggestion(item) {
    this.app.commands.execute(item.command.id);
  }
}

export class FolderPicker extends SuggestModal {
  constructor(app, item, onChoose) {
    super(app);
    this.item = item;
    this.onChoose = onChoose;
    this.setPlaceholder('Escribe el nombre de una carpeta…');
    this.setInstructions([
      { command: '↑↓', purpose: 'para navegar' },
      { command: '↵', purpose: 'para mover' },
      { command: 'esc', purpose: 'para cerrar' },
    ]);
  }

  getSuggestions(query) {
    const folders = this.app.vault.getAllFolders().filter((f) => {
      if (!this.item.isFolder) return true;
      return f.path !== this.item.path && !f.path.startsWith(this.item.path + '/');
    });
    return folders
      .map((f) => {
        const label = f.path || '/';
        const match = fuzzyMatch(query, label);
        return match ? { folder: f, label, matches: match.matches, score: match.score } : null;
      })
      .filter(Boolean)
      .sort((a, b) => (query ? b.score - a.score : a.label.localeCompare(b.label, 'es')));
  }

  renderSuggestion(item, itemEl) {
    el('div.suggestion-aux', { parent: itemEl, style: { order: -1 } }, [icon('folder')]);
    renderSuggestionText(itemEl, item.label, item.matches);
  }

  onChooseSuggestion(item) {
    this.onChoose(item.folder);
  }
}
