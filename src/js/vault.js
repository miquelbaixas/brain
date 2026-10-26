// Modelo en memoria de la bóveda: archivos, carpetas y contenido de las notas.
import { api } from './api.js';
import { Events, basename, dirname, extname, stem, joinPath, compareNames } from './util.js';

export class TAbstractFile {
  constructor(path) {
    this.path = path;
    this.parent = null;
  }

  get name() {
    return this.path ? basename(this.path) : '';
  }
}

export class TFile extends TAbstractFile {
  constructor(path, stat = {}) {
    super(path);
    this.isFolder = false;
    this.stat = { mtime: stat.mtime || Date.now(), ctime: stat.ctime || stat.mtime || Date.now(), size: stat.size || 0 };
  }

  get basename() {
    return stem(this.path);
  }

  get extension() {
    return extname(this.path);
  }
}

export class TFolder extends TAbstractFile {
  constructor(path, stat = {}) {
    super(path);
    this.isFolder = true;
    this.children = [];
    this.stat = { mtime: stat.mtime || 0, ctime: stat.ctime || 0 };
  }

  get isRoot() {
    return this.path === '';
  }
}

export class Vault extends Events {
  constructor(info) {
    super();
    this.basePath = info.vaultPath;
    this.name = info.vaultName;
    this.root = new TFolder('');
    this.items = new Map([['', this.root]]);
    this.contents = new Map();
  }

  async load() {
    const entries = await api.list('');
    entries.sort((a, b) => a.path.split('/').length - b.path.split('/').length);
    for (const entry of entries) this._insert(entry);
    await this._readAll(this.getMarkdownFiles());
  }

  async _readAll(files) {
    const queue = [...files];
    const workers = Array.from({ length: 16 }, async () => {
      while (queue.length) {
        const file = queue.shift();
        try {
          this.contents.set(file.path, await api.read(file.path));
        } catch {
          this.contents.set(file.path, '');
        }
      }
    });
    await Promise.all(workers);
  }

  _insert(entry) {
    if (this.items.has(entry.path)) return this.items.get(entry.path);
    const parentPath = dirname(entry.path);
    let parent = this.items.get(parentPath);
    if (!parent) parent = this._insert({ path: parentPath, type: 'folder' });
    const item = entry.type === 'folder' ? new TFolder(entry.path, entry) : new TFile(entry.path, entry);
    item.parent = parent;
    parent.children.push(item);
    this.items.set(entry.path, item);
    return item;
  }

  _remove(item) {
    if (item.isFolder) for (const child of [...item.children]) this._remove(child);
    this.items.delete(item.path);
    this.contents.delete(item.path);
    if (item.parent) item.parent.children = item.parent.children.filter((c) => c !== item);
  }

  /* -------------------------------------------------------- Consultas */

  getAbstractFileByPath(path) {
    return this.items.get(path) || null;
  }

  getFile(path) {
    const item = this.items.get(path);
    return item && !item.isFolder ? item : null;
  }

  getFolder(path) {
    const item = this.items.get(path);
    return item && item.isFolder ? item : null;
  }

  getFiles() {
    return [...this.items.values()].filter((i) => !i.isFolder);
  }

  getMarkdownFiles() {
    return this.getFiles().filter((f) => f.extension === 'md');
  }

  getAllFolders() {
    return [...this.items.values()].filter((i) => i.isFolder);
  }

  getContent(path) {
    return this.contents.get(path);
  }

  async read(path) {
    if (this.contents.has(path)) return this.contents.get(path);
    const text = await api.read(path);
    if (extname(path) === 'md') this.contents.set(path, text);
    return text;
  }

  getResourceUrl(path) {
    const full = this.basePath + '/' + path;
    return 'file://' + full.split('/').map(encodeURIComponent).join('/').replace(/^%2F/, '/');
  }

  exists(path) {
    return this.items.has(path);
  }

  // Devuelve una ruta libre: "Sin título.md", "Sin título 1.md", ...
  getAvailablePath(folderPath, base, ext) {
    const make = (n) => joinPath(folderPath, (n ? `${base} ${n}` : base) + (ext ? '.' + ext : ''));
    let n = 0;
    while (this.existsInsensitive(make(n))) n += 1;
    return make(n);
  }

  existsInsensitive(path) {
    const lower = path.toLowerCase();
    for (const key of this.items.keys()) if (key.toLowerCase() === lower) return true;
    return false;
  }

  sortChildren(folder, order = 'alphabetical') {
    const children = [...folder.children];
    const byName = (a, b) => compareNames(a.isFolder ? a.name : stemOrName(a), b.isFolder ? b.name : stemOrName(b));
    const cmp = {
      alphabetical: byName,
      alphabeticalReverse: (a, b) => -byName(a, b),
      byModifiedTime: (a, b) => (b.stat.mtime || 0) - (a.stat.mtime || 0) || byName(a, b),
      byModifiedTimeReverse: (a, b) => (a.stat.mtime || 0) - (b.stat.mtime || 0) || byName(a, b),
      byCreatedTime: (a, b) => (b.stat.ctime || 0) - (a.stat.ctime || 0) || byName(a, b),
      byCreatedTimeReverse: (a, b) => (a.stat.ctime || 0) - (b.stat.ctime || 0) || byName(a, b),
    }[order] || byName;
    const folders = children.filter((c) => c.isFolder).sort(order.startsWith('alphabetical') ? cmp : byName);
    const files = children.filter((c) => !c.isFolder).sort(cmp);
    return [...folders, ...files];
  }

  /* ------------------------------------------------------- Escritura */

  async modify(path, text) {
    const file = this.getFile(path);
    this.contents.set(path, text);
    const stat = await api.write(path, text);
    if (file) {
      file.stat.mtime = stat.mtime;
      file.stat.size = stat.size;
    }
    this.trigger('modify', file, { local: true });
  }

  async create(path, text = '') {
    const entry = await api.create(path, text);
    const file = this._insert(entry);
    if (file.extension === 'md') this.contents.set(path, text);
    this.trigger('create', file);
    return file;
  }

  async createBinaryCopy(from, to) {
    const entry = await api.copy(from, to);
    const file = this._insert(entry);
    if (file.extension === 'md') this.contents.set(to, await api.read(to));
    this.trigger('create', file);
    return file;
  }

  async createFolder(path) {
    const entry = await api.mkdir(path);
    const folder = this._insert(entry);
    this.trigger('create', folder);
    return folder;
  }

  async rename(item, newPath) {
    if (item.path === newPath) return;
    const oldPath = item.path;
    await api.rename(oldPath, newPath);
    this._move(item, newPath);
    this.trigger('rename', item, oldPath);
  }

  _move(item, newPath) {
    const oldPath = item.path;
    const descendants = item.isFolder ? this._descendants(item) : [];
    // Sacar del padre antiguo
    if (item.parent) item.parent.children = item.parent.children.filter((c) => c !== item);
    this.items.delete(oldPath);
    item.path = newPath;
    let parent = this.items.get(dirname(newPath));
    if (!parent) parent = this._insert({ path: dirname(newPath), type: 'folder' });
    item.parent = parent;
    parent.children.push(item);
    this.items.set(newPath, item);
    if (this.contents.has(oldPath)) {
      this.contents.set(newPath, this.contents.get(oldPath));
      this.contents.delete(oldPath);
    }
    for (const child of descendants) {
      const childOld = child.path;
      const childNew = newPath + childOld.slice(oldPath.length);
      this.items.delete(childOld);
      child.path = childNew;
      this.items.set(childNew, child);
      if (this.contents.has(childOld)) {
        this.contents.set(childNew, this.contents.get(childOld));
        this.contents.delete(childOld);
      }
    }
  }

  _descendants(folder) {
    const out = [];
    const walk = (f) => {
      for (const c of f.children) {
        out.push(c);
        if (c.isFolder) walk(c);
      }
    };
    walk(folder);
    return out;
  }

  async trash(item) {
    await api.trash(item.path);
    const removed = item.isFolder ? [item, ...this._descendants(item)] : [item];
    this._remove(item);
    for (const r of removed) this.trigger('delete', r);
  }

  /* ---------------------------------------------- Cambios desde disco */

  async handleExternalChanges(changes) {
    for (const change of changes) {
      const existing = this.items.get(change.path);
      if (!change.exists) {
        if (existing) {
          const removed = existing.isFolder ? [existing, ...this._descendants(existing)] : [existing];
          this._remove(existing);
          for (const r of removed) this.trigger('delete', r);
        }
        continue;
      }
      if (!existing) {
        const item = this._insert(change);
        if (item.isFolder) {
          const entries = await api.list(item.path);
          entries.sort((a, b) => a.path.split('/').length - b.path.split('/').length);
          const created = entries.map((e) => this._insert(e));
          await this._readAll(created.filter((f) => !f.isFolder && f.extension === 'md'));
          this.trigger('create', item);
          for (const c of created) this.trigger('create', c);
        } else {
          if (item.extension === 'md') await this._readAll([item]);
          this.trigger('create', item);
        }
        continue;
      }
      if (existing.isFolder || change.type === 'folder') continue;
      existing.stat.mtime = change.mtime;
      existing.stat.size = change.size;
      if (existing.extension !== 'md') {
        this.trigger('modify', existing, { local: false });
        continue;
      }
      let text;
      try {
        text = await api.read(existing.path);
      } catch {
        continue;
      }
      if (text === this.contents.get(existing.path)) continue;
      if (this.shouldIgnoreExternal && this.shouldIgnoreExternal(existing.path, text)) continue;
      this.contents.set(existing.path, text);
      this.trigger('modify', existing, { local: false, text });
    }
  }

  // Actualización del contenido recibida de otra ventana (sin tocar el disco).
  setCachedContent(path, text) {
    if (!this.items.has(path)) return;
    this.contents.set(path, text);
  }
}

function stemOrName(file) {
  return file.extension === 'md' ? file.basename : file.name;
}
