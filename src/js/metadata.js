// Caché de metadatos: enlaces, incrustaciones, etiquetas, encabezados y propiedades de cada nota.
import * as yaml from 'js-yaml';
import { api } from './api.js';
import {
  Events, debounce, basename, dirname, extname, stem, normalizePath, joinPath, escapeRegExp,
} from './util.js';

const CACHE_VERSION = 1;
const FRONTMATTER_RE = /^---[ \t]*\r?\n(?:([\s\S]*?)\r?\n)?(?:---|\.\.\.)[ \t]*(?:\r?\n|$)/;
const WIKILINK_RE = /(!?)\[\[([^\[\]\n]+?)\]\]/g;
const MDLINK_RE = /(!?)\[((?:[^\[\]\n]|\[[^\[\]\n]*\])*)\]\(\s*(<[^>\n]+>|[^)\s]+)(?:\s+(?:"[^"\n]*"|'[^'\n]*'))?\s*\)/g;
const TAG_RE = /(^|[\s,;(])#([\p{L}\p{N}_\-/]*[\p{L}_\-/][\p{L}\p{N}_\-/]*)/gu;
const HEADING_RE = /^(#{1,6})[ \t]+(.+?)[ \t]*(?:[ \t]#+)?[ \t]*$/gm;

function blank(text) {
  return text.replace(/[^\n]/g, ' ');
}

// Sustituye por espacios lo que no debe analizarse (código, comentarios, frontmatter)
// manteniendo las posiciones del texto original.
export function maskText(text, { frontmatter = true, links = false } = {}) {
  let out = text;
  if (frontmatter) {
    const fm = FRONTMATTER_RE.exec(out);
    if (fm) out = blank(fm[0]) + out.slice(fm[0].length);
  }
  // Bloques de código delimitados
  const lines = out.split('\n');
  let fence = null;
  for (let i = 0; i < lines.length; i++) {
    const line = lines[i];
    const m = /^\s{0,3}(`{3,}|~{3,})/.exec(line);
    if (fence) {
      lines[i] = blank(line);
      if (m && m[1][0] === fence[0] && m[1].length >= fence.length && line.trim().replace(/[`~]/g, '') === '') fence = null;
    } else if (m) {
      fence = m[1];
      lines[i] = blank(line);
    }
  }
  out = lines.join('\n');
  // Código en línea, comentarios HTML y comentarios %% %%
  out = out.replace(/(`+)([^`\n]|[^`\n][\s\S]*?[^`])\1(?!`)/g, (m) => blank(m));
  out = out.replace(/<!--[\s\S]*?-->/g, (m) => blank(m));
  out = out.replace(/%%[\s\S]*?%%/g, (m) => blank(m));
  if (links) {
    out = out.replace(WIKILINK_RE, (m) => blank(m));
    out = out.replace(MDLINK_RE, (m) => blank(m));
    out = out.replace(/https?:\/\/[^\s)>\]]+/g, (m) => blank(m));
  }
  return out;
}

export function parseFrontmatter(text) {
  const fm = FRONTMATTER_RE.exec(text);
  if (!fm) return { data: null, end: 0, raw: null };
  let data = null;
  try {
    data = yaml.load(fm[1] || '', { schema: yaml.JSON_SCHEMA });
  } catch {
    data = null;
  }
  if (data && typeof data !== 'object') data = null;
  return { data, end: fm[0].length, raw: fm[1] || '' };
}

export function parseLinkInner(inner) {
  let linkPart = inner;
  let alias = null;
  const pipe = inner.search(/(?<!\\)\|/);
  if (pipe >= 0) {
    linkPart = inner.slice(0, pipe);
    alias = inner.slice(pipe + 1);
  }
  linkPart = linkPart.replace(/\\$/, '').trim();
  const hash = linkPart.indexOf('#');
  const linkpath = hash >= 0 ? linkPart.slice(0, hash).trim() : linkPart;
  const subpath = hash >= 0 ? linkPart.slice(hash + 1).trim() : '';
  return { link: linkPart, linkpath, subpath, alias };
}

export function parseMarkdown(text) {
  const result = { links: [], embeds: [], tags: [], headings: [], frontmatter: null, frontmatterEnd: 0 };
  const fm = parseFrontmatter(text);
  result.frontmatter = fm.data;
  result.frontmatterEnd = fm.end;
  const masked = maskText(text);

  let m;
  HEADING_RE.lastIndex = 0;
  let line = 0;
  let counted = 0;
  while ((m = HEADING_RE.exec(masked))) {
    const start = m.index;
    for (; counted < start; counted++) if (text.charCodeAt(counted) === 10) line++;
    const original = text.slice(start, start + m[0].length);
    const hm = /^(#{1,6})[ \t]+(.+?)[ \t]*(?:[ \t]#+)?[ \t]*$/.exec(original);
    result.headings.push({ level: m[1].length, heading: hm ? hm[2] : m[2], line, position: { start, end: start + m[0].length } });
  }

  WIKILINK_RE.lastIndex = 0;
  while ((m = WIKILINK_RE.exec(masked))) {
    const start = m.index;
    const original = text.slice(start, start + m[0].length);
    const inner = original.slice(m[1] ? 3 : 2, -2);
    const parsed = parseLinkInner(inner);
    const entry = {
      ...parsed,
      displayText: parsed.alias || parsed.link,
      original,
      type: 'wiki',
      position: { start, end: start + m[0].length },
    };
    (m[1] ? result.embeds : result.links).push(entry);
  }

  MDLINK_RE.lastIndex = 0;
  while ((m = MDLINK_RE.exec(masked))) {
    let url = m[3];
    if (url.startsWith('<')) url = url.slice(1, -1);
    if (/^[a-z][a-z0-9+.-]*:/i.test(url)) continue;
    let decoded = url;
    try {
      decoded = decodeURI(url);
    } catch {}
    const hash = decoded.indexOf('#');
    const linkpath = hash >= 0 ? decoded.slice(0, hash) : decoded;
    const subpath = hash >= 0 ? decoded.slice(hash + 1) : '';
    if (!linkpath) continue;
    const start = m.index;
    const entry = {
      link: decoded,
      linkpath,
      subpath,
      alias: m[2],
      displayText: m[2],
      original: text.slice(start, start + m[0].length),
      type: 'md',
      position: { start, end: start + m[0].length },
    };
    (m[1] ? result.embeds : result.links).push(entry);
  }
  result.links.sort((a, b) => a.position.start - b.position.start);
  result.embeds.sort((a, b) => a.position.start - b.position.start);

  TAG_RE.lastIndex = 0;
  while ((m = TAG_RE.exec(masked))) {
    const start = m.index + m[1].length;
    result.tags.push({ tag: '#' + m[2], position: { start, end: start + m[2].length + 1 } });
  }
  if (result.frontmatter) {
    for (const tag of frontmatterList(result.frontmatter, ['tags', 'tag'])) {
      result.tags.push({ tag: '#' + tag.replace(/^#/, ''), position: null, frontmatter: true });
    }
  }
  return result;
}

export function frontmatterList(fm, keys) {
  const out = [];
  for (const key of keys) {
    const value = fm && fm[key];
    if (value == null) continue;
    const items = Array.isArray(value) ? value : String(value).split(/[,\s]+/);
    for (const item of items) {
      if (item == null) continue;
      const s = String(item).trim();
      if (s) out.push(s);
    }
  }
  return out;
}

export class MetadataCache extends Events {
  constructor(app) {
    super();
    this.app = app;
    this.vault = app.vault;
    this.cache = new Map();
    this.nameIndex = new Map();
    this.pathIndex = new Map();
    this.resolvedLinks = {};
    this.unresolvedLinks = {};
    this._resolveSoon = debounce(() => this.resolveAll(), 150);
    this.saveSoon = debounce(() => this.saveNow(), 4000);
  }

  // Arranca con la caché guardada: solo se leen después, en segundo plano, las notas nuevas o cambiadas.
  async init() {
    this.rebuildNameIndex();
    let saved = null;
    try {
      saved = JSON.parse((await api.readMetadataCache()) || 'null');
    } catch {
      saved = null;
    }
    const entries = saved && saved.version === CACHE_VERSION ? saved.files || {} : {};
    this.stale = [];
    for (const file of this.vault.getMarkdownFiles()) {
      const entry = entries[file.path];
      if (entry && entry.mtime === file.stat.mtime && entry.size === file.stat.size) this.cache.set(file.path, entry.data);
      else this.stale.push(file);
    }
    this.indexed = this.stale.length === 0;
    this.resolveAll();

    this.vault.on('create', (file) => {
      this.rebuildNameIndex();
      if (!file.isFolder && file.extension === 'md') this.cache.set(file.path, parseMarkdown(this.vault.getContent(file.path) || ''));
      this._resolveSoon();
      this.saveSoon();
    });
    this.vault.on('delete', (file) => {
      this.cache.delete(file.path);
      this.rebuildNameIndex();
      this._resolveSoon();
      this.saveSoon();
    });
    this.vault.on('rename', (file, oldPath) => {
      // El contenido no cambia al renombrar: se mueven los metadatos a la ruta nueva.
      const moves = [];
      for (const key of this.cache.keys()) {
        if (key === oldPath) moves.push([key, file.path]);
        else if (file.isFolder && key.startsWith(oldPath + '/')) moves.push([key, file.path + key.slice(oldPath.length)]);
      }
      for (const [from, to] of moves) {
        const data = this.cache.get(from);
        this.cache.delete(from);
        this.cache.set(to, data);
      }
      if (!file.isFolder && file.extension === 'md' && !moves.length) this.cache.set(file.path, parseMarkdown(this.vault.getContent(file.path) || ''));
      this.rebuildNameIndex();
      this._resolveSoon();
      this.saveSoon();
    });
    this.vault.on('modify', (file, info) => {
      if (!file || file.extension !== 'md') return;
      this.updateText(file.path, this.vault.getContent(file.path) || '', info && info.local);
      this.saveSoon();
    });
  }

  // Lee y analiza en segundo plano las notas que no estaban en la caché.
  async indexStale() {
    const files = this.stale || [];
    this.stale = [];
    for (let i = 0; i < files.length; i += 64) {
      const chunk = files.slice(i, i + 64).filter((f) => this.vault.getFile(f.path) === f);
      await this.vault.loadContents(chunk.map((f) => f.path), { silent: true });
      for (const f of chunk) this.cache.set(f.path, parseMarkdown(this.vault.getContent(f.path) || ''));
      await new Promise((resolve) => setTimeout(resolve, 0));
    }
    this.indexed = true;
    if (files.length) {
      this.resolveAll();
      this.saveSoon.flush();
    }
    performance.mark('brain:index-done');
    this.trigger('indexed');
  }

  async saveNow() {
    if (!this.app.isMain) return;
    const files = {};
    for (const [path, data] of this.cache) {
      const file = this.vault.getFile(path);
      if (file) files[path] = { mtime: file.stat.mtime, size: file.stat.size, data };
    }
    const json = JSON.stringify({ version: CACHE_VERSION, files }, (key, value) => (key === 'resolved' ? undefined : value));
    try {
      await api.writeMetadataCache(json);
    } catch (err) {
      console.error('No se pudo guardar la caché de metadatos', err);
    }
  }

  rebuildNameIndex() {
    this.nameIndex = new Map();
    this.pathIndex = new Map();
    for (const file of this.vault.getFiles()) {
      this.pathIndex.set(file.path.toLowerCase(), file);
      const keys = [file.name.toLowerCase()];
      if (file.extension === 'md') keys.push(file.basename.toLowerCase());
      for (const key of keys) {
        if (!this.nameIndex.has(key)) this.nameIndex.set(key, []);
        this.nameIndex.get(key).push(file);
      }
    }
  }

  // Recalcula los metadatos de una nota a partir de su texto (por ejemplo mientras se escribe).
  updateText(path, text) {
    const previous = this.cache.get(path);
    const parsed = parseMarkdown(text);
    this.cache.set(path, parsed);
    this._resolveFile(path, parsed);
    this.trigger('changed', path, parsed, previous);
    this._resolveSoon();
  }

  getFileCache(path) {
    return this.cache.get(path) || null;
  }

  /* ------------------------------------------------------ Resolución */

  getFirstLinkpathDest(linkpath, sourcePath) {
    if (linkpath == null) return null;
    let lp = linkpath.trim().replace(/\\/g, '/');
    if (!lp) return this.vault.getFile(sourcePath);
    lp = lp.replace(/^\.\//, '');
    const hasExt = !!extname(lp) && this.nameIndex.has(basename(lp).toLowerCase());
    const candidates = hasExt ? [lp] : [lp + '.md', lp];
    const lookup = (p) => this.vault.getFile(p) || this.pathIndex.get(p.toLowerCase()) || null;

    if (lp.includes('/') || lp.startsWith('..')) {
      const sourceDir = dirname(sourcePath || '');
      for (const c of candidates) {
        const rel = lookup(normalizePath(joinPath(sourceDir, c)));
        if (rel) return rel;
      }
      for (const c of candidates) {
        const absPath = lookup(normalizePath(c));
        if (absPath) return absPath;
      }
      for (const c of candidates) {
        const lower = '/' + normalizePath(c).toLowerCase();
        const suffix = this.vault.getFiles().filter((f) => ('/' + f.path.toLowerCase()).endsWith(lower));
        if (suffix.length) return this._pickBest(suffix, sourcePath);
      }
      return null;
    }

    for (const c of candidates) {
      const matches = this.nameIndex.get(c.toLowerCase());
      if (matches && matches.length) {
        const filtered = c.endsWith('.md') ? matches.filter((f) => f.extension === 'md') : matches;
        if (filtered.length) return this._pickBest(filtered, sourcePath);
      }
    }
    return null;
  }

  _pickBest(files, sourcePath) {
    if (files.length === 1) return files[0];
    const dir = dirname(sourcePath || '');
    const sameDir = files.find((f) => dirname(f.path) === dir);
    if (sameDir) return sameDir;
    return [...files].sort((a, b) => a.path.length - b.path.length || a.path.localeCompare(b.path))[0];
  }

  // Texto de enlace más corto que identifica el archivo sin ambigüedad.
  fileToLinktext(file, sourcePath, omitMdExtension = true) {
    const name = file.extension === 'md' && omitMdExtension ? file.basename : file.name;
    const matches = this.nameIndex.get(file.name.toLowerCase()) || [];
    if (matches.length <= 1) {
      const resolved = this.getFirstLinkpathDest(name, sourcePath);
      if (!resolved || resolved === file) return name;
    }
    return file.extension === 'md' && omitMdExtension ? file.path.slice(0, -3) : file.path;
  }

  _resolveFile(path, parsed) {
    const resolved = {};
    const unresolved = {};
    for (const link of [...parsed.links, ...parsed.embeds]) {
      const dest = link.linkpath ? this.getFirstLinkpathDest(link.linkpath, path) : null;
      link.resolved = link.linkpath ? (dest ? dest.path : null) : path;
      if (!link.linkpath) continue;
      if (dest) resolved[dest.path] = (resolved[dest.path] || 0) + 1;
      else unresolved[link.linkpath] = (unresolved[link.linkpath] || 0) + 1;
    }
    this.resolvedLinks[path] = resolved;
    this.unresolvedLinks[path] = unresolved;
  }

  resolveAll() {
    this.resolvedLinks = {};
    this.unresolvedLinks = {};
    for (const [path, parsed] of this.cache) this._resolveFile(path, parsed);
    this.trigger('resolved');
  }

  /* -------------------------------------------------------- Consultas */

  getBacklinksForFile(path) {
    const result = new Map();
    for (const [source, parsed] of this.cache) {
      const links = [...parsed.links, ...parsed.embeds].filter((l) => l.resolved === path && l.linkpath);
      if (links.length) result.set(source, links.sort((a, b) => a.position.start - b.position.start));
    }
    return result;
  }

  getBacklinkCount(path) {
    let n = 0;
    for (const source in this.resolvedLinks) if (this.resolvedLinks[source][path]) n += 1;
    return n;
  }

  getTags() {
    const counts = new Map();
    for (const parsed of this.cache.values()) {
      for (const { tag } of parsed.tags) {
        const lower = tag.toLowerCase();
        const entry = counts.get(lower) || { tag, count: 0 };
        entry.count += 1;
        counts.set(lower, entry);
      }
    }
    return [...counts.values()];
  }

  getAliases(path) {
    const parsed = this.cache.get(path);
    return parsed && parsed.frontmatter ? frontmatterList(parsed.frontmatter, ['aliases', 'alias']) : [];
  }

  // Menciones del nombre de una nota que no están enlazadas.
  async getUnlinkedMentions(file) {
    const names = [file.basename, ...this.getAliases(file.path)].filter((n) => n && n.length > 1);
    if (!names.length) return new Map();
    await this.vault.ensureAllContents();
    const pattern = new RegExp(
      '(?<![\\p{L}\\p{N}_])(' + names.map(escapeRegExp).sort((a, b) => b.length - a.length).join('|') + ')(?![\\p{L}\\p{N}_])',
      'giu',
    );
    const result = new Map();
    for (const other of this.vault.getMarkdownFiles()) {
      if (other.path === file.path) continue;
      const text = this.vault.getContent(other.path) || '';
      const masked = maskText(text, { links: true });
      const matches = [];
      let m;
      pattern.lastIndex = 0;
      while ((m = pattern.exec(masked))) matches.push({ position: { start: m.index, end: m.index + m[0].length }, text: text.slice(m.index, m.index + m[0].length) });
      if (matches.length) result.set(other.path, matches);
    }
    return result;
  }

  getHeadings(path) {
    const parsed = this.cache.get(path);
    return parsed ? parsed.headings : [];
  }
}

// Extrae la línea que rodea una posición para mostrarla como contexto.
export function getContext(text, start, end, maxLength = 240) {
  const lineStart = text.lastIndexOf('\n', start - 1) + 1;
  let lineEnd = text.indexOf('\n', end);
  if (lineEnd < 0) lineEnd = text.length;
  let from = lineStart;
  let to = lineEnd;
  if (to - from > maxLength) {
    from = Math.max(lineStart, start - Math.floor(maxLength / 2));
    to = Math.min(lineEnd, from + maxLength);
  }
  return {
    text: text.slice(from, to),
    matchStart: start - from,
    matchEnd: Math.min(end, to) - from,
    prefix: from > lineStart ? '…' : '',
    suffix: to < lineEnd ? '…' : '',
    line: text.slice(0, start).split('\n').length - 1,
  };
}

export { stem };
