// Puente seguro entre el renderer y el proceso principal.
const { contextBridge, ipcRenderer, webUtils } = require('electron');

const INVOKE = new Set([
  'app:init', 'app:flushed',
  'vault:list', 'vault:choose', 'vault:switch',
  'fs:read', 'fs:write', 'fs:write-binary', 'fs:import', 'fs:create', 'fs:copy', 'fs:mkdir', 'fs:rename', 'fs:trash', 'fs:exists',
  'shell:reveal', 'shell:open-path', 'shell:open-external',
  'window:popout', 'window:close', 'window:new', 'window:reload', 'window:toggle-devtools',
  'workspace:load', 'workspace:save',
  'broadcast', 'theme:set', 'theme:is-dark', 'edit:action',
  'starter:info', 'starter:pick-folder', 'starter:create', 'starter:open',
  'cache:read', 'cache:write',
]);

const EVENTS = new Set([
  'vault:changed', 'command', 'broadcast', 'app:flush',
  'window:fullscreen', 'window:focus', 'theme:updated', 'context-menu',
]);

contextBridge.exposeInMainWorld('brain', {
  invoke(channel, ...args) {
    if (!INVOKE.has(channel)) throw new Error('Canal no permitido: ' + channel);
    return ipcRenderer.invoke(channel, ...args);
  },
  pathForFile(file) {
    try {
      return webUtils.getPathForFile(file);
    } catch {
      return '';
    }
  },
  on(channel, callback) {
    if (!EVENTS.has(channel)) throw new Error('Evento no permitido: ' + channel);
    const listener = (_event, ...args) => callback(...args);
    ipcRenderer.on(channel, listener);
    return () => ipcRenderer.removeListener(channel, listener);
  },
});
