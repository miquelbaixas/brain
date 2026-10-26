// Registro de comandos y atajos de teclado.
import { matchHotkey } from './util.js';
import { hasOpenModal } from './ui.js';

const RECENT_KEY = 'brain:recent-commands';

export class Commands {
  constructor(app) {
    this.app = app;
    this.commands = new Map();
    try {
      this.recent = JSON.parse(localStorage.getItem(RECENT_KEY) || '[]');
    } catch {
      this.recent = [];
    }
  }

  add(command) {
    this.commands.set(command.id, command);
  }

  list() {
    return [...this.commands.values()].filter((c) => !c.hidden);
  }

  isAvailable(command) {
    return !command.check || command.check();
  }

  execute(id) {
    const command = this.commands.get(id);
    if (!command || !this.isAvailable(command)) return false;
    if (!command.hidden) {
      this.recent = [id, ...this.recent.filter((r) => r !== id)].slice(0, 6);
      try {
        localStorage.setItem(RECENT_KEY, JSON.stringify(this.recent));
      } catch {}
    }
    Promise.resolve(command.callback()).catch((err) => console.error('Error en el comando', id, err));
    return true;
  }

  handleKeydown(e) {
    if (e.defaultPrevented || e.isComposing || hasOpenModal()) return;
    for (const command of this.commands.values()) {
      const hotkeys = command.hotkeys || (command.hotkey ? [command.hotkey] : []);
      if (hotkeys.some((hk) => matchHotkey(e, hk))) {
        if (!this.isAvailable(command)) continue;
        e.preventDefault();
        e.stopPropagation();
        this.execute(command.id);
        return;
      }
    }
  }
}
