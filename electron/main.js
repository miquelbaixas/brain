// Proceso principal de Brain: ventanas, acceso a la bóveda en disco y vigilancia de cambios.
const { app, BrowserWindow, ipcMain, shell, dialog, Menu, nativeTheme, screen } = require('electron');
const path = require('path');
const fs = require('fs');
const fsp = fs.promises;
const os = require('os');

const BRAIN_HOME = path.join(os.homedir(), 'brain');
const USER_DATA = path.join(BRAIN_HOME, '.userdata');
const CONFIG_FILE = path.join(USER_DATA, 'config.json');
const DEFAULT_VAULT = path.join(BRAIN_HOME, 'vault');
const STARTER_DIR = path.join(__dirname, '..', 'starter');
const CONFIG_DIR = '.brain';

app.setName('Brain');
app.setPath('userData', USER_DATA);

let config = { vault: DEFAULT_VAULT, recent: [] };
let vaultPath = DEFAULT_VAULT;
let watcher = null;
let isQuitting = false;
let nextPopoutId = 1;

// Registro de ventanas abiertas: id de BrowserWindow -> { win, type, layout, flushed }
const windows = new Map();

/* ---------------------------------------------------------------- Config */

function loadConfig() {
  try {
    config = { ...config, ...JSON.parse(fs.readFileSync(CONFIG_FILE, 'utf8')) };
  } catch {}
  if (!config.vault) config.vault = DEFAULT_VAULT;
}

function saveConfig() {
  fs.mkdirSync(USER_DATA, { recursive: true });
  fs.writeFileSync(CONFIG_FILE, JSON.stringify(config, null, 2));
}

function copyDirSync(from, to) {
  fs.mkdirSync(to, { recursive: true });
  for (const entry of fs.readdirSync(from, { withFileTypes: true })) {
    const src = path.join(from, entry.name);
    const dst = path.join(to, entry.name);
    if (entry.isDirectory()) copyDirSync(src, dst);
    else fs.copyFileSync(src, dst);
  }
}

function ensureVault(dir) {
  if (!fs.existsSync(dir)) {
    if (dir === DEFAULT_VAULT && fs.existsSync(STARTER_DIR)) copyDirSync(STARTER_DIR, dir);
    else fs.mkdirSync(dir, { recursive: true });
  }
  fs.mkdirSync(path.join(dir, CONFIG_DIR), { recursive: true });
}

/* ------------------------------------------------------------- Rutas seguras */

function toPosix(p) {
  return p.split(path.sep).join('/');
}

function abs(rel) {
  const target = path.resolve(vaultPath, rel || '.');
  if (target !== vaultPath && !target.startsWith(vaultPath + path.sep)) {
    throw new Error('Ruta fuera de la bóveda: ' + rel);
  }
  return target;
}

function isHiddenRel(rel) {
  return rel.split('/').some((seg) => seg.startsWith('.') || seg === 'node_modules');
}

async function listDir(relDir) {
  const out = [];
  async function walk(rel) {
    let entries;
    try {
      entries = await fsp.readdir(abs(rel), { withFileTypes: true });
    } catch {
      return;
    }
    await Promise.all(entries.map(async (entry) => {
      if (entry.name.startsWith('.') || entry.name === 'node_modules') return;
      const childRel = rel ? rel + '/' + entry.name : entry.name;
      let stat;
      try {
        stat = await fsp.stat(abs(childRel));
      } catch {
        return;
      }
      if (stat.isDirectory()) {
        out.push({ path: childRel, type: 'folder', mtime: stat.mtimeMs, ctime: stat.birthtimeMs });
        await walk(childRel);
      } else if (stat.isFile()) {
        out.push({ path: childRel, type: 'file', mtime: stat.mtimeMs, ctime: stat.birthtimeMs, size: stat.size });
      }
    }));
  }
  await walk(relDir || '');
  return out;
}

/* ------------------------------------------------------------- Vigilancia */

let pendingChanges = new Map();
let flushTimer = null;

function startWatcher() {
  stopWatcher();
  try {
    watcher = fs.watch(vaultPath, { recursive: true }, (_event, filename) => {
      if (!filename) return;
      const rel = toPosix(filename.toString());
      if (isHiddenRel(rel)) return;
      pendingChanges.set(rel, true);
      clearTimeout(flushTimer);
      flushTimer = setTimeout(flushChanges, 120);
    });
  } catch (err) {
    console.error('No se pudo vigilar la bóveda', err);
  }
}

function stopWatcher() {
  if (watcher) watcher.close();
  watcher = null;
}

async function flushChanges() {
  const paths = [...pendingChanges.keys()];
  pendingChanges = new Map();
  const changes = await Promise.all(paths.map(async (rel) => {
    try {
      const stat = await fsp.stat(abs(rel));
      return {
        path: rel,
        exists: true,
        type: stat.isDirectory() ? 'folder' : 'file',
        mtime: stat.mtimeMs,
        ctime: stat.birthtimeMs,
        size: stat.size,
      };
    } catch {
      return { path: rel, exists: false };
    }
  }));
  broadcast('vault:changed', changes);
}

/* --------------------------------------------------------- Espacio de trabajo */

function workspaceFile() {
  return path.join(vaultPath, CONFIG_DIR, 'workspace.json');
}

function readWorkspace() {
  try {
    return JSON.parse(fs.readFileSync(workspaceFile(), 'utf8'));
  } catch {
    return {};
  }
}

let saveTimer = null;
function scheduleWorkspaceSave() {
  clearTimeout(saveTimer);
  saveTimer = setTimeout(writeWorkspaceNow, 400);
}

function writeWorkspaceNow() {
  clearTimeout(saveTimer);
  const data = { main: null, popouts: [] };
  for (const rec of windows.values()) {
    const entry = { bounds: rec.bounds || null, layout: rec.layout || null };
    if (rec.type === 'main') data.main = entry;
    else data.popouts.push(entry);
  }
  if (!data.main) {
    const previous = readWorkspace();
    data.main = previous.main || null;
  }
  try {
    fs.mkdirSync(path.dirname(workspaceFile()), { recursive: true });
    fs.writeFileSync(workspaceFile(), JSON.stringify(data, null, 2));
  } catch (err) {
    console.error('No se pudo guardar workspace.json', err);
  }
}

function validBounds(bounds) {
  if (!bounds || !bounds.width || !bounds.height) return null;
  const visible = screen.getAllDisplays().some((d) => {
    const a = d.workArea;
    return bounds.x < a.x + a.width - 50 && bounds.x + bounds.width > a.x + 50 &&
      bounds.y < a.y + a.height - 50 && bounds.y + bounds.height > a.y;
  });
  return visible ? bounds : null;
}

/* --------------------------------------------------------------- Ventanas */

function backgroundColor() {
  return nativeTheme.shouldUseDarkColors ? '#1c1c1c' : '#ffffff';
}

function createWindow({ type, layout, bounds }) {
  const valid = validBounds(bounds);
  const win = new BrowserWindow({
    width: valid ? valid.width : type === 'main' ? 1280 : 800,
    height: valid ? valid.height : type === 'main' ? 820 : 640,
    x: valid ? valid.x : undefined,
    y: valid ? valid.y : undefined,
    minWidth: 420,
    minHeight: 300,
    show: false,
    title: 'Brain',
    titleBarStyle: 'hidden',
    trafficLightPosition: { x: 14, y: 14 },
    backgroundColor: backgroundColor(),
    webPreferences: {
      preload: path.join(__dirname, 'preload.js'),
      contextIsolation: true,
      nodeIntegration: false,
      sandbox: true,
      spellcheck: true,
    },
  });

  const rec = { win, type, layout: layout || null, bounds: valid || null, flushed: false };
  windows.set(win.webContents.id, rec);
  const wcId = win.webContents.id;

  win.loadFile(path.join(__dirname, '..', 'src', 'index.html'), { query: { type } });
  win.once('ready-to-show', () => win.show());

  const updateBounds = () => {
    if (win.isDestroyed() || win.isFullScreen() || win.isMinimized()) return;
    rec.bounds = win.getNormalBounds();
    scheduleWorkspaceSave();
  };
  win.on('resize', updateBounds);
  win.on('move', updateBounds);
  win.on('enter-full-screen', () => win.webContents.send('window:fullscreen', true));
  win.on('leave-full-screen', () => win.webContents.send('window:fullscreen', false));
  win.on('focus', () => win.webContents.send('window:focus', true));
  win.on('blur', () => win.webContents.send('window:focus', false));

  win.on('close', (event) => {
    if (type === 'main') isQuitting = true;
    if (rec.flushed) return;
    event.preventDefault();
    requestFlush(win).finally(() => {
      rec.flushed = true;
      if (!win.isDestroyed()) win.close();
    });
  });

  win.on('closed', () => {
    if (!isQuitting) {
      windows.delete(wcId);
      scheduleWorkspaceSave();
    } else {
      // Al salir se conservan todas las ventanas para restaurarlas en el próximo arranque.
      rec.closed = true;
      writeWorkspaceNow();
    }
    if (type === 'main') app.quit();
  });

  // Menú contextual nativo: se reenvía al renderer, que lo muestra con el estilo de la app.
  win.webContents.on('context-menu', (_event, params) => {
    win.webContents.send('context-menu', {
      x: params.x,
      y: params.y,
      isEditable: params.isEditable,
      selectionText: params.selectionText,
      misspelledWord: params.misspelledWord,
      suggestions: params.dictionarySuggestions || [],
      editFlags: params.editFlags,
    });
  });

  // Los enlaces externos se abren en el navegador del sistema, nunca dentro de la app.
  win.webContents.setWindowOpenHandler(({ url }) => {
    if (/^(https?|mailto):/i.test(url)) shell.openExternal(url);
    return { action: 'deny' };
  });
  win.webContents.on('will-navigate', (event, url) => {
    if (url !== win.webContents.getURL()) {
      event.preventDefault();
      if (/^(https?|mailto):/i.test(url)) shell.openExternal(url);
    }
  });

  return win;
}

const flushWaiters = new Map();
let flushToken = 0;

function requestFlush(win) {
  if (win.isDestroyed() || win.webContents.isDestroyed()) return Promise.resolve();
  const token = ++flushToken;
  return new Promise((resolve) => {
    const timer = setTimeout(() => {
      flushWaiters.delete(token);
      resolve();
    }, 2500);
    flushWaiters.set(token, () => {
      clearTimeout(timer);
      resolve();
    });
    win.webContents.send('app:flush', token);
  });
}

function broadcast(channel, payload, exceptWebContentsId) {
  for (const [id, rec] of windows) {
    if (id === exceptWebContentsId || rec.win.isDestroyed()) continue;
    rec.win.webContents.send(channel, payload);
  }
}

function openVaultWindows() {
  const saved = readWorkspace();
  const main = saved.main || {};
  createWindow({ type: 'main', layout: main.layout, bounds: main.bounds });
  for (const popout of saved.popouts || []) {
    if (popout && popout.layout) createWindow({ type: 'popout', layout: popout.layout, bounds: popout.bounds });
  }
}

async function switchVault(dir) {
  if (!dir || dir === vaultPath) return;
  // Guardar todo lo pendiente antes de cambiar de bóveda.
  const live = [...windows.values()].filter((rec) => !rec.win.isDestroyed());
  await Promise.all(live.map((rec) => requestFlush(rec.win)));
  writeWorkspaceNow();
  for (const rec of windows.values()) rec.flushed = true;
  const all = [...windows.values()];
  windows.clear();
  isQuitting = true;
  // Evitar que el cierre de la ventana principal termine la aplicación.
  for (const rec of all) {
    if (rec.win.isDestroyed()) continue;
    rec.win.removeAllListeners('closed');
    rec.win.destroy();
  }
  isQuitting = false;
  openVault(dir);
  openVaultWindows();
}

function openVault(dir) {
  vaultPath = path.resolve(dir);
  ensureVault(vaultPath);
  config.vault = vaultPath;
  config.recent = [vaultPath, ...(config.recent || []).filter((p) => p !== vaultPath)].slice(0, 10);
  saveConfig();
  startWatcher();
}

async function chooseVault(parent) {
  const result = await dialog.showOpenDialog(parent || undefined, {
    title: 'Abrir carpeta como bóveda',
    buttonLabel: 'Abrir',
    properties: ['openDirectory', 'createDirectory'],
  });
  if (result.canceled || !result.filePaths.length) return;
  await switchVault(result.filePaths[0]);
}

/* -------------------------------------------------------------------- IPC */

function recFor(event) {
  return windows.get(event.sender.id);
}

function handle(channel, fn) {
  ipcMain.handle(channel, async (event, ...args) => fn(event, ...args));
}

handle('app:init', (event) => {
  const rec = recFor(event);
  return {
    vaultPath,
    vaultName: path.basename(vaultPath),
    windowType: rec ? rec.type : 'main',
    platform: process.platform,
    isFullscreen: rec ? rec.win.isFullScreen() : false,
    isFocused: rec ? rec.win.isFocused() : true,
    recentVaults: (config.recent || []).filter((p) => fs.existsSync(p)),
    version: app.getVersion(),
  };
});

handle('app:flushed', (_event, token) => {
  const done = flushWaiters.get(token);
  if (done) {
    flushWaiters.delete(token);
    done();
  }
});

handle('vault:list', (_event, relDir) => listDir(relDir || ''));
handle('vault:choose', (event) => chooseVault(BrowserWindow.fromWebContents(event.sender)));
handle('vault:switch', (_event, dir) => switchVault(dir));

handle('fs:read', (_event, rel) => fsp.readFile(abs(rel), 'utf8'));

handle('fs:write', async (_event, rel, data) => {
  const target = abs(rel);
  await fsp.mkdir(path.dirname(target), { recursive: true });
  await fsp.writeFile(target, data, 'utf8');
  const stat = await fsp.stat(target);
  return { mtime: stat.mtimeMs, size: stat.size };
});

handle('fs:create', async (_event, rel, data) => {
  const target = abs(rel);
  await fsp.mkdir(path.dirname(target), { recursive: true });
  await fsp.writeFile(target, data || '', { encoding: 'utf8', flag: 'wx' });
  const stat = await fsp.stat(target);
  return { path: rel, type: 'file', mtime: stat.mtimeMs, ctime: stat.birthtimeMs, size: stat.size };
});

handle('fs:copy', async (_event, from, to) => {
  const target = abs(to);
  await fsp.mkdir(path.dirname(target), { recursive: true });
  await fsp.copyFile(abs(from), target, fs.constants.COPYFILE_EXCL);
  const stat = await fsp.stat(target);
  return { path: to, type: 'file', mtime: stat.mtimeMs, ctime: stat.birthtimeMs, size: stat.size };
});

handle('fs:write-binary', async (_event, rel, data) => {
  const target = abs(rel);
  await fsp.mkdir(path.dirname(target), { recursive: true });
  await fsp.writeFile(target, Buffer.from(data), { flag: 'wx' });
  const stat = await fsp.stat(target);
  return { path: rel, type: 'file', mtime: stat.mtimeMs, ctime: stat.birthtimeMs, size: stat.size };
});

// Copia a la bóveda un archivo arrastrado desde Finder.
handle('fs:import', async (_event, source, rel) => {
  const target = abs(rel);
  const stat = await fsp.stat(source);
  if (!stat.isFile()) throw new Error('Solo se pueden importar archivos.');
  await fsp.mkdir(path.dirname(target), { recursive: true });
  await fsp.copyFile(source, target, fs.constants.COPYFILE_EXCL);
  const result = await fsp.stat(target);
  return { path: rel, type: 'file', mtime: result.mtimeMs, ctime: result.birthtimeMs, size: result.size };
});

handle('fs:mkdir', async (_event, rel) => {
  await fsp.mkdir(abs(rel), { recursive: true });
  const stat = await fsp.stat(abs(rel));
  return { path: rel, type: 'folder', mtime: stat.mtimeMs, ctime: stat.birthtimeMs };
});

handle('fs:rename', async (_event, from, to) => {
  const src = abs(from);
  const dst = abs(to);
  if (src === dst) return;
  const sameIgnoringCase = src.toLowerCase() === dst.toLowerCase();
  if (!sameIgnoringCase && fs.existsSync(dst)) throw new Error('Ya existe un elemento con ese nombre.');
  await fsp.mkdir(path.dirname(dst), { recursive: true });
  await fsp.rename(src, dst);
});

handle('fs:trash', async (_event, rel) => {
  await shell.trashItem(abs(rel));
});

handle('fs:exists', (_event, rel) => fs.existsSync(abs(rel)));

handle('shell:reveal', (_event, rel) => shell.showItemInFolder(abs(rel)));
handle('shell:open-path', (_event, rel) => shell.openPath(abs(rel)));
handle('shell:open-external', (_event, url) => {
  if (/^(https?|mailto|tel):/i.test(url)) return shell.openExternal(url);
});

handle('window:popout', (_event, { layout }) => {
  const cursor = screen.getCursorScreenPoint();
  createWindow({
    type: 'popout',
    layout,
    bounds: { x: cursor.x - 120, y: cursor.y - 20, width: 800, height: 640 },
  });
});

handle('workspace:load', (event) => {
  const rec = recFor(event);
  return rec ? rec.layout : null;
});

handle('workspace:save', (event, layout) => {
  const rec = recFor(event);
  if (!rec) return;
  rec.layout = layout;
  scheduleWorkspaceSave();
});

handle('broadcast', (event, channel, payload) => {
  broadcast('broadcast', { channel, payload }, event.sender.id);
});

handle('edit:action', (event, action, arg) => {
  const wc = event.sender;
  switch (action) {
    case 'cut': return wc.cut();
    case 'copy': return wc.copy();
    case 'paste': return wc.paste();
    case 'pasteAndMatchStyle': return wc.pasteAndMatchStyle();
    case 'selectAll': return wc.selectAll();
    case 'replaceMisspelling': return wc.replaceMisspelling(String(arg || ''));
    case 'addWord': return wc.session.addWordToSpellCheckerDictionary(String(arg || ''));
    default: return null;
  }
});

handle('window:close', (event) => {
  const win = BrowserWindow.fromWebContents(event.sender);
  if (win) win.close();
});

handle('window:new', () => {
  createWindow({ type: 'popout', layout: null });
});

handle('window:reload', (event) => {
  event.sender.reload();
});

handle('window:toggle-devtools', (event) => {
  event.sender.toggleDevTools();
});

handle('theme:set', (_event, source) => {
  nativeTheme.themeSource = ['light', 'dark', 'system'].includes(source) ? source : 'system';
});

handle('theme:is-dark', () => nativeTheme.shouldUseDarkColors);

nativeTheme.on('updated', () => broadcast('theme:updated', nativeTheme.shouldUseDarkColors));

/* ------------------------------------------------------------------- Menú */

function sendCommand(id) {
  return () => {
    const win = BrowserWindow.getFocusedWindow();
    if (win) win.webContents.send('command', id);
  };
}

// Los atajos los gestiona el renderer; el menú solo los muestra (registerAccelerator: false)
// para que no se ejecuten dos veces.
function item(label, accelerator, command) {
  return { label, accelerator, registerAccelerator: false, click: sendCommand(command) };
}

function buildMenu() {
  const sep = { type: 'separator' };
  const template = [
    {
      label: 'Brain',
      submenu: [
        { role: 'about', label: 'Acerca de Brain' },
        sep,
        item('Ajustes…', 'CmdOrCtrl+,', 'app:open-settings'),
        sep,
        { role: 'services', label: 'Servicios' },
        sep,
        { role: 'hide', label: 'Ocultar Brain' },
        { role: 'hideOthers', label: 'Ocultar otros' },
        { role: 'unhide', label: 'Mostrar todo' },
        sep,
        { role: 'quit', label: 'Salir de Brain' },
      ],
    },
    {
      label: 'Archivo',
      submenu: [
        item('Nueva nota', 'CmdOrCtrl+N', 'file:new-note'),
        item('Nueva pestaña', 'CmdOrCtrl+T', 'workspace:new-tab'),
        { label: 'Nueva ventana', accelerator: 'CmdOrCtrl+Shift+N', click: () => createWindow({ type: 'popout' }) },
        sep,
        item('Abrir selector rápido…', 'CmdOrCtrl+O', 'switcher:open'),
        { label: 'Abrir carpeta como bóveda…', click: () => chooseVault(BrowserWindow.getFocusedWindow()) },
        sep,
        item('Cerrar pestaña', 'CmdOrCtrl+W', 'workspace:close'),
        {
          label: 'Cerrar ventana',
          accelerator: 'CmdOrCtrl+Shift+W',
          click: () => {
            const win = BrowserWindow.getFocusedWindow();
            if (win) win.close();
          },
        },
      ],
    },
    {
      label: 'Edición',
      submenu: [
        { label: 'Deshacer', accelerator: 'CmdOrCtrl+Z', registerAccelerator: false, click: sendCommand('editor:undo') },
        { label: 'Rehacer', accelerator: 'CmdOrCtrl+Shift+Z', registerAccelerator: false, click: sendCommand('editor:redo') },
        sep,
        { role: 'cut', label: 'Cortar' },
        { role: 'copy', label: 'Copiar' },
        { role: 'paste', label: 'Pegar' },
        { role: 'pasteAndMatchStyle', label: 'Pegar como texto sin formato' },
        { role: 'selectAll', label: 'Seleccionar todo' },
        sep,
        item('Buscar en la nota', 'CmdOrCtrl+F', 'editor:open-search'),
        item('Buscar en todos los archivos', 'CmdOrCtrl+Shift+F', 'search:open'),
      ],
    },
    {
      label: 'Ver',
      submenu: [
        item('Paleta de comandos…', 'CmdOrCtrl+P', 'command-palette:open'),
        item('Alternar vista de lectura', 'CmdOrCtrl+E', 'markdown:toggle-preview'),
        item('Vista gráfica', 'CmdOrCtrl+G', 'graph:open'),
        sep,
        item('Alternar barra lateral izquierda', 'CmdOrCtrl+Alt+[', 'app:toggle-left-sidebar'),
        item('Alternar barra lateral derecha', 'CmdOrCtrl+Alt+]', 'app:toggle-right-sidebar'),
        sep,
        { role: 'resetZoom', label: 'Tamaño real' },
        { role: 'zoomIn', label: 'Acercar' },
        { role: 'zoomOut', label: 'Alejar' },
        sep,
        { role: 'togglefullscreen', label: 'Pantalla completa' },
        sep,
        item('Recargar', null, 'app:reload'),
        { role: 'toggleDevTools', label: 'Herramientas de desarrollo' },
      ],
    },
    {
      label: 'Navegar',
      submenu: [
        item('Atrás', 'CmdOrCtrl+Alt+Left', 'app:go-back'),
        item('Adelante', 'CmdOrCtrl+Alt+Right', 'app:go-forward'),
        sep,
        item('Pestaña siguiente', 'Ctrl+Tab', 'workspace:next-tab'),
        item('Pestaña anterior', 'Ctrl+Shift+Tab', 'workspace:previous-tab'),
        sep,
        item('Dividir a la derecha', null, 'workspace:split-vertical'),
        item('Dividir hacia abajo', null, 'workspace:split-horizontal'),
        item('Abrir en una ventana nueva', null, 'workspace:open-in-new-window'),
      ],
    },
    {
      label: 'Ventana',
      role: 'window',
      submenu: [
        { role: 'minimize', label: 'Minimizar' },
        { role: 'zoom', label: 'Zoom' },
        sep,
        { role: 'front', label: 'Traer todo al frente' },
      ],
    },
    {
      label: 'Ayuda',
      role: 'help',
      submenu: [
        item('Atajos de teclado', null, 'app:open-hotkeys'),
        { label: 'Mostrar la bóveda en Finder', click: () => shell.openPath(vaultPath) },
      ],
    },
  ];
  Menu.setApplicationMenu(Menu.buildFromTemplate(template));
}

/* ---------------------------------------------------------------- Arranque */

if (!app.requestSingleInstanceLock()) {
  app.quit();
} else {
  app.on('second-instance', () => {
    const main = [...windows.values()].find((r) => r.type === 'main' && !r.win.isDestroyed());
    if (main) {
      if (main.win.isMinimized()) main.win.restore();
      main.win.focus();
    }
  });

  app.whenReady().then(() => {
    loadConfig();
    let target = config.vault;
    if (!target || (!fs.existsSync(target) && target !== DEFAULT_VAULT)) target = DEFAULT_VAULT;
    openVault(target);
    buildMenu();
    app.setAboutPanelOptions({
      applicationName: 'Brain',
      applicationVersion: app.getVersion(),
      copyright: 'Notas en markdown, enlazadas como tu cerebro.',
    });
    openVaultWindows();
  });

  app.on('before-quit', () => {
    isQuitting = true;
  });

  app.on('will-quit', () => {
    stopWatcher();
  });

  app.on('window-all-closed', () => {
    app.quit();
  });
}
