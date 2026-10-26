// Ajustes de la bóveda (guardados en .brain/app.json) y ventana de ajustes.
import { api } from './api.js';
import { el, empty, Events, formatHotkey } from './util.js';
import { icon } from './icons.js';
import { Modal } from './ui.js';

const SETTINGS_PATH = '.brain/app.json';

export const DEFAULT_SETTINGS = {
  theme: 'system',
  accentColor: '',
  fontSize: 16,
  interfaceZoom: 1,
  showRibbon: true,
  showInlineTitle: true,
  showViewHeader: true,
  readableLineLength: true,
  defaultViewMode: 'source',
  livePreview: true,
  spellcheck: true,
  newFileLocation: 'root',
  newFileFolder: '',
  attachmentFolder: '',
  dailyNotesFolder: '',
  alwaysUpdateLinks: true,
  promptDelete: true,
  showUnsupportedFiles: true,
  fileSortOrder: 'alphabetical',
};

export class Settings extends Events {
  constructor(app) {
    super();
    this.app = app;
    this.data = { ...DEFAULT_SETTINGS };
  }

  async load() {
    try {
      if (!(await api.exists(SETTINGS_PATH))) throw new Error('sin ajustes');
      const raw = await api.read(SETTINGS_PATH);
      this.data = { ...DEFAULT_SETTINGS, ...JSON.parse(raw) };
    } catch {
      this.data = { ...DEFAULT_SETTINGS };
    }
  }

  get(key) {
    return this.data[key];
  }

  async set(key, value, { broadcast = true } = {}) {
    if (this.data[key] === value) return;
    this.data[key] = value;
    this.trigger('change', key, value);
    if (broadcast) {
      api.broadcast('settings-change', { key, value });
      await api.write(SETTINGS_PATH, JSON.stringify(this.data, null, 2));
    }
  }

  applyRemote({ key, value }) {
    this.data[key] = value;
    this.trigger('change', key, value);
  }
}

/* ======================================================== Ventana */

function toggle(value, onChange) {
  const box = el('div.checkbox-container', { cls: value ? 'is-enabled' : '' });
  box.addEventListener('click', () => {
    const next = !box.classList.contains('is-enabled');
    box.classList.toggle('is-enabled', next);
    onChange(next);
  });
  return box;
}

function dropdown(options, value, onChange) {
  const select = el('select.dropdown');
  for (const [v, label] of options) {
    const option = el('option', { text: label, attr: { value: v } });
    if (v === value) option.selected = true;
    select.appendChild(option);
  }
  select.addEventListener('change', () => onChange(select.value));
  return select;
}

function textInput(value, placeholder, onChange) {
  const input = el('input', { attr: { type: 'text', placeholder, spellcheck: 'false' } });
  input.value = value || '';
  input.addEventListener('change', () => onChange(input.value.trim().replace(/^\/+|\/+$/g, '')));
  return input;
}

export class SettingsModal extends Modal {
  constructor(app, initialTab = 'editor') {
    super(app);
    this.modalEl.classList.add('mod-settings');
    this.titleEl.remove();
    this.tab = initialTab;
  }

  onOpen() {
    const container = el('div.vertical-tabs-container', { parent: this.contentEl });
    this.contentEl.style.height = '100%';
    this.contentEl.style.overflow = 'hidden';
    const header = el('div.vertical-tab-header', { parent: container });
    const group = el('div.vertical-tab-header-group', { parent: header });
    el('div.vertical-tab-header-group-title', { text: 'Opciones', parent: group });
    const items = el('div.vertical-tab-header-group-items', { parent: group });
    this.contentContainer = el('div.vertical-tab-content-container', { parent: container });
    this.content = el('div.vertical-tab-content', { parent: this.contentContainer });
    const tabs = [
      ['editor', 'Editor', 'pencil'],
      ['files', 'Archivos y enlaces', 'folder'],
      ['appearance', 'Apariencia', 'sun'],
      ['hotkeys', 'Atajos de teclado', 'keyboard'],
      ['about', 'Acerca de', 'info'],
    ];
    this.navEls = {};
    for (const [id, label, iconName] of tabs) {
      const nav = el('div.vertical-tab-nav-item', { parent: items }, [icon(iconName), el('span', { text: label })]);
      nav.addEventListener('click', () => this.show(id));
      this.navEls[id] = nav;
    }
    this.show(this.tab);
  }

  show(id) {
    this.tab = id;
    for (const [key, nav] of Object.entries(this.navEls)) nav.classList.toggle('is-active', key === id);
    empty(this.content);
    this.contentContainer.scrollTop = 0;
    this['render_' + id]();
  }

  heading(text) {
    el('div.setting-heading', { text, parent: this.content });
    return el('div.setting-items', { parent: this.content });
  }

  item(parent, name, description, control) {
    el('div.setting-item', { parent }, [
      el('div.setting-item-info', [el('div.setting-item-name', { text: name }), description ? el('div.setting-item-description', { text: description }) : null]),
      el('div.setting-item-control', [control]),
    ]);
  }

  bind(key) {
    return (value) => this.app.settings.set(key, value);
  }

  render_editor() {
    const s = this.app.settings;
    const general = this.heading('General');
    this.item(general, 'Vista predeterminada para pestañas nuevas', 'Al abrir una nota se mostrará en modo edición o en modo lectura.',
      dropdown([['source', 'Vista de edición'], ['preview', 'Vista de lectura']], s.get('defaultViewMode'), this.bind('defaultViewMode')));
    this.item(general, 'Modo de edición predeterminado', 'La vista previa en vivo oculta la sintaxis de markdown fuera de la línea en la que escribes.',
      dropdown([['live', 'Vista previa en vivo'], ['source', 'Modo fuente']], s.get('livePreview') ? 'live' : 'source', (v) => s.set('livePreview', v === 'live')));
    const display = this.heading('Visualización');
    this.item(display, 'Longitud de línea legible', 'Limita el ancho del texto para que sea más cómodo de leer.',
      toggle(s.get('readableLineLength'), this.bind('readableLineLength')));
    this.item(display, 'Mostrar el título en línea', 'Muestra el nombre del archivo como título editable al principio de la nota.',
      toggle(s.get('showInlineTitle'), this.bind('showInlineTitle')));
    this.item(display, 'Mostrar la barra de título de las pestañas', 'Muestra la cabecera con navegación y acciones encima de cada nota.',
      toggle(s.get('showViewHeader'), this.bind('showViewHeader')));
    const behaviour = this.heading('Comportamiento');
    this.item(behaviour, 'Revisión ortográfica', 'Subraya las palabras mal escritas mientras editas.',
      toggle(s.get('spellcheck'), this.bind('spellcheck')));
  }

  render_files() {
    const s = this.app.settings;
    const files = this.heading('Archivos');
    this.item(files, 'Confirmar la eliminación de archivos', 'Pide confirmación antes de mover un archivo a la papelera.',
      toggle(s.get('promptDelete'), this.bind('promptDelete')));
    this.item(files, 'Mostrar todos los tipos de archivo', 'Muestra en el explorador también los archivos que no son notas.',
      toggle(s.get('showUnsupportedFiles'), this.bind('showUnsupportedFiles')));
    const location = this.heading('Ubicaciones');
    this.item(location, 'Ubicación predeterminada para notas nuevas', 'Dónde se crean las notas nuevas.',
      dropdown([['root', 'Raíz de la bóveda'], ['current', 'Misma carpeta que el archivo actual'], ['folder', 'En la carpeta indicada abajo']], s.get('newFileLocation'), this.bind('newFileLocation')));
    this.item(location, 'Carpeta para notas nuevas', 'Se usa si eliges «En la carpeta indicada».',
      textInput(s.get('newFileFolder'), 'Ejemplo: carpeta/subcarpeta', this.bind('newFileFolder')));
    this.item(location, 'Carpeta para archivos adjuntos', 'Dónde se guardan las imágenes pegadas o arrastradas. Vacío = raíz; «./» = junto a la nota.',
      textInput(s.get('attachmentFolder'), 'Ejemplo: adjuntos', this.bind('attachmentFolder')));
    this.item(location, 'Carpeta de notas diarias', 'Dónde se crea la nota del día (AAAA-MM-DD).',
      textInput(s.get('dailyNotesFolder'), 'Ejemplo: diario', this.bind('dailyNotesFolder')));
    const links = this.heading('Enlaces');
    this.item(links, 'Actualizar automáticamente los enlaces internos', 'Al renombrar o mover un archivo se actualizan los enlaces que apuntan a él.',
      toggle(s.get('alwaysUpdateLinks'), this.bind('alwaysUpdateLinks')));
  }

  render_appearance() {
    const s = this.app.settings;
    const theme = this.heading('Tema');
    this.item(theme, 'Esquema de color base', 'Elige entre claro, oscuro o seguir al sistema.',
      dropdown([['system', 'Adaptar al sistema'], ['light', 'Claro'], ['dark', 'Oscuro']], s.get('theme'), this.bind('theme')));
    const color = el('input', { attr: { type: 'color' } });
    color.value = s.get('accentColor') || '#8a5cf5';
    color.addEventListener('input', () => s.set('accentColor', color.value));
    const reset = el('button', { text: 'Restablecer' });
    reset.addEventListener('click', () => {
      s.set('accentColor', '');
      color.value = '#8a5cf5';
    });
    this.item(theme, 'Color de acento', 'Color de enlaces, selección y elementos activos.', el('div', { style: { display: 'flex', gap: '8px', alignItems: 'center' } }, [reset, color]));
    const font = this.heading('Fuente');
    const size = el('input', { attr: { type: 'range', min: '10', max: '30', step: '1' } });
    size.value = s.get('fontSize');
    const sizeLabel = el('span', { text: String(s.get('fontSize')), style: { minWidth: '22px', textAlign: 'right', color: 'var(--text-muted)' } });
    size.addEventListener('input', () => {
      sizeLabel.textContent = size.value;
      s.set('fontSize', Number(size.value));
    });
    this.item(font, 'Tamaño de fuente', 'Tamaño del texto de las notas.', el('div', { style: { display: 'flex', gap: '8px', alignItems: 'center' } }, [sizeLabel, size]));
    const iface = this.heading('Interfaz');
    this.item(iface, 'Mostrar la cinta', 'La barra vertical de accesos rápidos a la izquierda.', toggle(s.get('showRibbon'), this.bind('showRibbon')));
  }

  render_hotkeys() {
    const list = this.heading('Atajos de teclado');
    list.classList.add('hotkey-list');
    const commands = this.app.commands.list().filter((c) => c.hotkey).sort((a, b) => a.name.localeCompare(b.name, 'es'));
    for (const c of commands) this.item(list, c.name, null, el('span.setting-hotkey', { text: formatHotkey(c.hotkey) }));
    const editor = this.heading('Editor');
    editor.classList.add('hotkey-list');
    const editorKeys = [
      ['Negrita', { modifiers: ['Mod'], key: 'b' }],
      ['Cursiva', { modifiers: ['Mod'], key: 'i' }],
      ['Tachado', { modifiers: ['Mod', 'Shift'], key: 'x' }],
      ['Resaltar', { modifiers: ['Mod', 'Shift'], key: 'h' }],
      ['Código en línea', { modifiers: ['Mod', 'Shift'], key: 'c' }],
      ['Insertar enlace markdown', { modifiers: ['Mod'], key: 'k' }],
      ['Alternar casilla de tarea', { modifiers: ['Mod'], key: 'l' }],
      ['Seguir el enlace bajo el cursor', { modifiers: ['Alt'], key: 'Enter' }],
      ['Abrir el enlace bajo el cursor en una pestaña nueva', { modifiers: ['Mod'], key: 'Enter' }],
      ['Buscar en la nota', { modifiers: ['Mod'], key: 'f' }],
    ];
    for (const [name, hk] of editorKeys) this.item(editor, name, null, el('span.setting-hotkey', { text: formatHotkey(hk) }));
  }

  render_about() {
    const about = this.heading('Brain');
    this.item(about, 'Versión', null, el('span', { text: this.app.info.version, style: { color: 'var(--text-muted)' } }));
    const open = el('button', { text: 'Mostrar en Finder' });
    open.addEventListener('click', () => api.reveal('.brain'));
    this.item(about, 'Bóveda actual', this.app.vault.basePath, open);
    const change = el('button', { text: 'Abrir otra' });
    change.addEventListener('click', () => api.chooseVault());
    this.item(about, 'Abrir otra carpeta como bóveda', 'Cualquier carpeta con archivos markdown puede ser una bóveda.', change);
  }
}
