// Documentos abiertos: un búfer por nota compartido por todas las vistas que la muestran.
import { api } from './api.js';
import { debounce, throttle } from './util.js';

const SAVE_DELAY = 800;

export class FileBuffer {
  constructor(registry, path, text) {
    this.registry = registry;
    this.app = registry.app;
    this.path = path;
    this.text = text;
    this.savedText = text;
    this.views = new Set();
    this.saveTimer = null;
    this.saving = null;
    this.updateMetadata = debounce(() => {
      this.app.vault.setCachedContent(this.path, this.text);
      this.app.metadataCache.updateText(this.path, this.text);
    }, 250);
    this.broadcastChange = throttle(() => {
      api.broadcast('doc-change', { path: this.path, text: this.text });
    }, 250);
  }

  get dirty() {
    return this.text !== this.savedText;
  }

  setText(text, origin) {
    if (text === this.text) return;
    this.text = text;
    for (const view of this.views) if (view !== origin) view.onBufferChanged(text, { origin });
    this.updateMetadata();
    this.broadcastChange();
    this.scheduleSave();
    this.registry.app.workspace.trigger('editor-change', this);
  }

  // Cambio que viene del disco (otra aplicación) o de otra ventana: no se vuelve a guardar.
  applyExternal(text) {
    if (text === this.text) {
      this.savedText = text;
      return;
    }
    this.text = text;
    this.savedText = text;
    clearTimeout(this.saveTimer);
    for (const view of this.views) view.onBufferChanged(text, { external: true });
    this.registry.app.workspace.trigger('editor-change', this);
  }

  scheduleSave() {
    clearTimeout(this.saveTimer);
    this.saveTimer = setTimeout(() => this.save(), SAVE_DELAY);
  }

  async save() {
    clearTimeout(this.saveTimer);
    if (!this.dirty) return;
    const text = this.text;
    if (!this.app.vault.getFile(this.path)) return;
    this.savedText = text;
    this.updateMetadata.flush();
    try {
      this.saving = this.app.vault.modify(this.path, text);
      await this.saving;
    } catch (err) {
      this.savedText = null;
      console.error('No se pudo guardar', this.path, err);
    } finally {
      this.saving = null;
    }
  }
}

export class DocRegistry {
  constructor(app) {
    this.app = app;
    this.buffers = new Map();
    app.vault.on('modify', (file, info) => {
      if (!file || info.local) return;
      const buffer = this.buffers.get(file.path);
      if (buffer && typeof info.text === 'string' && !buffer.dirty) buffer.applyExternal(info.text);
    });
    app.vault.on('rename', (file, oldPath) => this.onRename(file, oldPath));
    app.vault.on('delete', (file) => {
      const buffer = this.buffers.get(file.path);
      if (buffer) clearTimeout(buffer.saveTimer);
    });
    // Ignorar en la vigilancia los ecos de nuestras propias escrituras.
    app.vault.shouldIgnoreExternal = (path, text) => {
      const buffer = this.buffers.get(path);
      return !!buffer && (buffer.dirty || buffer.text === text || buffer.savedText === text);
    };
  }

  get(path) {
    return this.buffers.get(path) || null;
  }

  async acquire(path, view) {
    let buffer = this.buffers.get(path);
    if (!buffer) {
      const text = await this.app.vault.read(path);
      buffer = this.buffers.get(path);
      if (!buffer) {
        buffer = new FileBuffer(this, path, text);
        this.buffers.set(path, buffer);
      }
    }
    buffer.views.add(view);
    return buffer;
  }

  release(path, view) {
    const buffer = this.buffers.get(path);
    if (!buffer) return;
    buffer.views.delete(view);
    if (!buffer.views.size) {
      buffer.save().finally(() => {
        if (!buffer.views.size && this.buffers.get(path) === buffer) this.buffers.delete(path);
      });
    }
  }

  async getText(path) {
    const buffer = this.buffers.get(path);
    if (buffer) return buffer.text;
    return this.app.vault.read(path);
  }

  // Escribe un texto en una nota, pasando por el búfer si está abierta.
  async writeText(path, text) {
    const buffer = this.buffers.get(path);
    if (buffer) {
      buffer.setText(text, null);
      await buffer.save();
    } else {
      await this.app.vault.modify(path, text);
    }
  }

  onRename(file, oldPath) {
    const moves = [];
    for (const [path, buffer] of this.buffers) {
      if (path === oldPath) moves.push([buffer, file.path]);
      else if (file.isFolder && path.startsWith(oldPath + '/')) moves.push([buffer, file.path + path.slice(oldPath.length)]);
    }
    for (const [buffer, newPath] of moves) {
      this.buffers.delete(buffer.path);
      buffer.path = newPath;
      this.buffers.set(newPath, buffer);
    }
  }

  onRemoteChange({ path, text }) {
    this.app.vault.setCachedContent(path, text);
    const buffer = this.buffers.get(path);
    if (buffer) buffer.applyExternal(text);
    this.app.metadataCache.updateText(path, text);
  }

  async flushAll() {
    await Promise.all([...this.buffers.values()].map((b) => b.save()));
  }
}
