// Vistas sencillas: pestaña vacía, imágenes, PDF, audio/vídeo y archivos no soportados.
import { el, formatHotkey, AUDIO_EXTENSIONS, VIDEO_EXTENSIONS } from '../util.js';
import { icon } from '../icons.js';
import { ItemView, FileView } from './base.js';

export class EmptyView extends ItemView {
  constructor(leaf) {
    super(leaf);
    const state = el('div.empty-state', { parent: this.contentEl });
    const box = el('div.empty-state-container', { parent: state });
    el('div.empty-state-title', { text: 'No hay ningún archivo abierto', parent: box });
    const list = el('div.empty-state-action-list', { parent: box });
    const action = (text, hotkey, fn) => {
      const a = el('div.empty-state-action', { parent: list }, [text + (hotkey ? ' ' : ''), hotkey ? el('kbd', { text: `(${formatHotkey(hotkey)})` }) : null]);
      a.addEventListener('click', fn);
    };
    action('Crear nota nueva', { modifiers: ['Mod'], key: 'n' }, () => this.app.fileManager.newNote({ newLeaf: false }));
    action('Ir al archivo', { modifiers: ['Mod'], key: 'o' }, () => this.app.commands.execute('switcher:open'));
    action('Ver archivos recientes', null, () => this.app.commands.execute('switcher:recent'));
    action('Cerrar', null, () => this.leaf.detach());
  }

  getViewType() {
    return 'empty';
  }

  getDisplayText() {
    return 'Pestaña nueva';
  }

  getIcon() {
    return 'file';
  }
}

export class ImageView extends FileView {
  getViewType() {
    return 'image';
  }

  getIcon() {
    return 'image';
  }

  async onLoadFile(file) {
    this.contentEl.replaceChildren(
      el('div.image-container', [el('img', { attr: { src: this.app.vault.getResourceUrl(file.path) + '?t=' + file.stat.mtime, alt: file.name } })]),
    );
  }
}

export class PdfView extends FileView {
  getViewType() {
    return 'pdf';
  }

  getIcon() {
    return 'file-text';
  }

  async onLoadFile(file) {
    this.contentEl.replaceChildren(el('div.pdf-container', [el('iframe', { attr: { src: this.app.vault.getResourceUrl(file.path) } })]));
  }
}

export class MediaView extends FileView {
  getViewType() {
    return 'media';
  }

  getIcon() {
    return this.file && VIDEO_EXTENSIONS.has(this.file.extension) ? 'file-video' : 'file-audio';
  }

  async onLoadFile(file) {
    const tag = VIDEO_EXTENSIONS.has(file.extension) ? 'video' : 'audio';
    const media = el(tag, { attr: { controls: true, src: this.app.vault.getResourceUrl(file.path) }, style: { maxWidth: '100%' } });
    this.contentEl.replaceChildren(el('div.image-container', [media]));
  }
}

export class UnsupportedView extends FileView {
  getViewType() {
    return 'unknown';
  }

  getIcon() {
    return 'file-question';
  }

  async onLoadFile(file) {
    const open = el('button.mod-cta', { text: 'Abrir con la aplicación predeterminada' });
    open.addEventListener('click', () => this.app.api.openPath(file.path));
    this.contentEl.replaceChildren(el('div.unsupported-file', [
      icon('file-question'),
      el('div', { text: `Brain no puede mostrar archivos «.${file.extension}».` }),
      open,
    ]));
  }
}

export function viewTypeForFile(file) {
  const ext = file.extension;
  if (ext === 'md') return 'markdown';
  if (['png', 'jpg', 'jpeg', 'gif', 'bmp', 'svg', 'webp', 'avif', 'ico'].includes(ext)) return 'image';
  if (ext === 'pdf') return 'pdf';
  if (AUDIO_EXTENSIONS.has(ext) || VIDEO_EXTENSIONS.has(ext)) return 'media';
  return 'unknown';
}
