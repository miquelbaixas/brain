// Operaciones sobre archivos: crear, renombrar (actualizando enlaces), mover, duplicar, eliminar y adjuntos.
import { api } from './api.js';
import { dirname, basename, joinPath, extname, stem, INVALID_NAME_CHARS, todayString, plural } from './util.js';
import { parseMarkdown } from './metadata.js';
import { confirmDialog, Notice } from './ui.js';

export class FileManager {
  constructor(app) {
    this.app = app;
  }

  get vault() {
    return this.app.vault;
  }

  getNewFileParent(sourcePath) {
    const setting = this.app.settings.get('newFileLocation');
    if (setting === 'current' && sourcePath) {
      const folder = dirname(sourcePath);
      if (folder === '' || this.vault.getFolder(folder)) return folder;
    }
    if (setting === 'folder') {
      const folder = this.app.settings.get('newFileFolder') || '';
      return folder;
    }
    return '';
  }

  validateName(name) {
    if (!name.trim()) return 'El nombre no puede estar vacío.';
    if (INVALID_NAME_CHARS.test(name)) return 'Los nombres no pueden contener ninguno de estos caracteres: \\ / : * ? " < > | # ^ [ ]';
    if (name.startsWith('.')) return 'Los nombres no pueden empezar por un punto.';
    return null;
  }

  async ensureFolder(folderPath) {
    if (!folderPath || this.vault.getFolder(folderPath)) return;
    await this.vault.createFolder(folderPath);
  }

  async createNewMarkdownFile(folderPath = '', baseName = 'Sin título', content = '') {
    await this.ensureFolder(folderPath);
    const path = this.vault.getAvailablePath(folderPath, baseName, 'md');
    return this.vault.create(path, content);
  }

  async createNewFolder(parentPath = '') {
    const path = this.vault.getAvailablePath(parentPath, 'Sin título', '');
    return this.vault.createFolder(path);
  }

  // Crea una nota nueva y la abre lista para escribir el título.
  async newNote({ folder, newLeaf } = {}) {
    const active = this.app.workspace.getActiveFile();
    const parent = folder != null ? folder : this.getNewFileParent(active ? active.path : '');
    const file = await this.createNewMarkdownFile(parent);
    const activeLeaf = this.app.workspace.getActiveRootLeaf();
    const reuse = activeLeaf && activeLeaf.view && activeLeaf.view.getViewType() === 'empty';
    await this.app.workspace.openFile(file, newLeaf != null ? newLeaf : reuse ? false : 'tab', { state: { mode: 'source' }, eState: { rename: true } });
    return file;
  }

  async openDailyNote() {
    const folder = this.app.settings.get('dailyNotesFolder') || '';
    const name = todayString();
    const path = joinPath(folder, name + '.md');
    let file = this.vault.getFile(path);
    if (!file) {
      await this.ensureFolder(folder);
      file = await this.vault.create(path, '');
    }
    await this.app.workspace.openFile(file, false);
  }

  /* -------------------------------------------------------- Renombrar */

  async renameFile(item, newPath) {
    if (!item || newPath === item.path) return;
    if (this.vault.exists(newPath) && newPath.toLowerCase() !== item.path.toLowerCase()) {
      new Notice('Ya existe un archivo o carpeta con ese nombre.');
      return false;
    }
    const mc = this.app.metadataCache;
    const oldPath = item.path;
    const affected = new Set(item.isFolder ? this.vault._descendants(item).filter((f) => !f.isFolder).map((f) => f.path) : [item.path]);

    // Foto de los enlaces que apuntan a los archivos afectados antes de mover.
    const snapshot = new Map();
    for (const [source, parsed] of mc.cache) {
      for (const link of [...parsed.links, ...parsed.embeds]) {
        if (link.linkpath && affected.has(link.resolved)) {
          if (!snapshot.has(source)) snapshot.set(source, new Map());
          snapshot.get(source).set(link.original + '\u0000' + link.linkpath, link.resolved);
        }
      }
    }
    // Enlaces relativos dentro de las notas que se mueven pueden dejar de resolverse.
    for (const path of affected) {
      const parsed = mc.cache.get(path);
      if (!parsed) continue;
      for (const link of [...parsed.links, ...parsed.embeds]) {
        if (link.linkpath && link.resolved && (link.linkpath.includes('/') || link.type === 'md')) {
          if (!snapshot.has(path)) snapshot.set(path, new Map());
          snapshot.get(path).set(link.original + '\u0000' + link.linkpath, link.resolved);
        }
      }
    }

    try {
      await this.app.docs.flushAll();
      await this.vault.rename(item, newPath);
    } catch (err) {
      new Notice('No se pudo renombrar: ' + err.message);
      return false;
    }

    if (!this.app.settings.get('alwaysUpdateLinks')) return true;
    mc.rebuildNameIndex();
    const mapPath = (p) => (p === oldPath ? newPath : p.startsWith(oldPath + '/') ? newPath + p.slice(oldPath.length) : p);
    let linkCount = 0;
    let fileCount = 0;
    for (const [oldSource, targets] of snapshot) {
      const source = mapPath(oldSource);
      if (!this.vault.getFile(source)) continue;
      const text = await this.app.docs.getText(source);
      const fresh = parseMarkdown(text);
      const edits = [];
      for (const link of [...fresh.links, ...fresh.embeds]) {
        const key = link.original + '\u0000' + link.linkpath;
        if (!targets.has(key)) continue;
        const target = this.vault.getFile(mapPath(targets.get(key)));
        if (!target) continue;
        const current = mc.getFirstLinkpathDest(link.linkpath, source);
        if (current && current.path === target.path) continue;
        edits.push({ from: link.position.start, to: link.position.end, insert: this.buildLink(link, target, source) });
      }
      if (!edits.length) continue;
      edits.sort((a, b) => b.from - a.from);
      let next = text;
      for (const e of edits) next = next.slice(0, e.from) + e.insert + next.slice(e.to);
      await this.app.docs.writeText(source, next);
      linkCount += edits.length;
      fileCount += 1;
    }
    if (linkCount) new Notice(`Se ${linkCount === 1 ? 'actualizó' : 'actualizaron'} ${plural(linkCount, 'enlace', 'enlaces')} en ${plural(fileCount, 'archivo', 'archivos')}.`);
    return true;
  }

  buildLink(link, file, sourcePath) {
    const embed = link.original.startsWith('!');
    if (link.type === 'wiki') {
      let inner = this.app.metadataCache.fileToLinktext(file, sourcePath);
      if (link.subpath) inner += '#' + link.subpath;
      if (link.alias != null) inner += '|' + link.alias;
      return (embed ? '!' : '') + '[[' + inner + ']]';
    }
    const url = file.path.split('/').map(encodeURIComponent).join('/') + (link.subpath ? '#' + encodeURIComponent(link.subpath) : '');
    return (embed ? '!' : '') + '[' + (link.alias || '') + '](' + url + ')';
  }

  generateMarkdownLink(file, sourcePath, { subpath, alias, embed } = {}) {
    let inner = this.app.metadataCache.fileToLinktext(file, sourcePath, file.extension === 'md');
    if (subpath) inner += '#' + subpath;
    if (alias) inner += '|' + alias;
    return (embed ? '!' : '') + '[[' + inner + ']]';
  }

  async renameWithBasename(item, newName) {
    const error = this.validateName(newName);
    if (error) {
      new Notice(error);
      return false;
    }
    const parent = dirname(item.path);
    const ext = item.isFolder ? '' : extname(item.path);
    const newPath = joinPath(parent, ext ? `${newName}.${ext}` : newName);
    return this.renameFile(item, newPath);
  }

  async moveTo(item, folderPath) {
    if (item.isFolder && (folderPath === item.path || folderPath.startsWith(item.path + '/'))) return false;
    if (dirname(item.path) === folderPath) return false;
    const newPath = joinPath(folderPath, basename(item.path));
    if (this.vault.exists(newPath)) {
      new Notice(`Ya existe «${basename(item.path)}» en esa carpeta.`);
      return false;
    }
    return this.renameFile(item, newPath);
  }

  /* --------------------------------------------------------- Otros */

  async duplicate(file) {
    const folder = dirname(file.path);
    const ext = file.extension;
    let n = 1;
    while (this.vault.existsInsensitive(joinPath(folder, `${stem(file.path)} ${n}.${ext}`))) n += 1;
    const path = joinPath(folder, `${stem(file.path)} ${n}.${ext}`);
    await this.app.docs.flushAll();
    const created = await this.vault.createBinaryCopy(file.path, path);
    await this.app.workspace.openFile(created, 'tab');
    return created;
  }

  async trash(item) {
    if (this.app.settings.get('promptDelete')) {
      const ok = await confirmDialog(this.app, {
        title: item.isFolder ? 'Eliminar carpeta' : 'Eliminar archivo',
        message: item.isFolder
          ? `¿Seguro que quieres eliminar la carpeta «${item.name}» y todo su contenido? Se moverá a la papelera del sistema.`
          : `¿Seguro que quieres eliminar «${item.name}»? Se moverá a la papelera del sistema.`,
        confirmText: 'Eliminar',
        warning: true,
      });
      if (!ok) return false;
    }
    try {
      await this.vault.trash(item);
      return true;
    } catch (err) {
      new Notice('No se pudo eliminar: ' + err.message);
      return false;
    }
  }

  attachmentFolder(sourcePath) {
    const setting = this.app.settings.get('attachmentFolder') || '';
    if (setting === './') return dirname(sourcePath || '');
    return setting;
  }

  async saveAttachment(blob, sourcePath) {
    const ext = (blob.type.split('/')[1] || 'png').replace('jpeg', 'jpg').replace('svg+xml', 'svg');
    const now = new Date();
    const pad = (n) => String(n).padStart(2, '0');
    const stamp = `${now.getFullYear()}${pad(now.getMonth() + 1)}${pad(now.getDate())}${pad(now.getHours())}${pad(now.getMinutes())}${pad(now.getSeconds())}`;
    const folder = this.attachmentFolder(sourcePath);
    await this.ensureFolder(folder);
    const path = this.vault.getAvailablePath(folder, `Imagen pegada ${stamp}`, ext);
    const data = new Uint8Array(await blob.arrayBuffer());
    const entry = await api.writeBinary(path, data);
    const file = this.vault._insert(entry);
    this.vault.trigger('create', file);
    return file;
  }

  async importExternalFile(osPath, sourcePath) {
    const name = basename(osPath.replace(/\\/g, '/'));
    const folder = extname(name) === 'md' ? this.getNewFileParent(sourcePath) : this.attachmentFolder(sourcePath);
    await this.ensureFolder(folder);
    const path = this.vault.getAvailablePath(folder, stem(name), extname(name));
    const entry = await api.importFile(osPath, path);
    const file = this.vault._insert(entry);
    if (file.extension === 'md') this.vault.contents.set(file.path, await api.read(file.path));
    this.vault.trigger('create', file);
    return file;
  }
}
