// Acceso al proceso principal (sistema de archivos, ventanas, tema).
const bridge = window.brain;

export const api = {
  init: () => bridge.invoke('app:init'),
  flushed: (token) => bridge.invoke('app:flushed', token),

  list: (dir) => bridge.invoke('vault:list', dir || ''),
  chooseVault: () => bridge.invoke('vault:choose'),
  switchVault: (dir) => bridge.invoke('vault:switch', dir),

  read: (path) => bridge.invoke('fs:read', path),
  write: (path, data) => bridge.invoke('fs:write', path, data),
  writeBinary: (path, data) => bridge.invoke('fs:write-binary', path, data),
  importFile: (source, path) => bridge.invoke('fs:import', source, path),
  pathForFile: (file) => bridge.pathForFile(file),
  create: (path, data) => bridge.invoke('fs:create', path, data),
  copy: (from, to) => bridge.invoke('fs:copy', from, to),
  mkdir: (path) => bridge.invoke('fs:mkdir', path),
  rename: (from, to) => bridge.invoke('fs:rename', from, to),
  trash: (path) => bridge.invoke('fs:trash', path),
  exists: (path) => bridge.invoke('fs:exists', path),

  reveal: (path) => bridge.invoke('shell:reveal', path),
  openPath: (path) => bridge.invoke('shell:open-path', path),
  openExternal: (url) => bridge.invoke('shell:open-external', url),

  popout: (layout) => bridge.invoke('window:popout', { layout }),
  newWindow: () => bridge.invoke('window:new'),
  closeWindow: () => bridge.invoke('window:close'),
  reload: () => bridge.invoke('window:reload'),
  toggleDevtools: () => bridge.invoke('window:toggle-devtools'),

  readMetadataCache: () => bridge.invoke('cache:read'),
  writeMetadataCache: (data) => bridge.invoke('cache:write', data),

  loadWorkspace: () => bridge.invoke('workspace:load'),
  saveWorkspace: (layout) => bridge.invoke('workspace:save', layout),

  broadcast: (channel, payload) => bridge.invoke('broadcast', channel, payload),
  setTheme: (source) => bridge.invoke('theme:set', source),
  isDark: () => bridge.invoke('theme:is-dark'),
  editAction: (action, arg) => bridge.invoke('edit:action', action, arg),

  on: (channel, callback) => bridge.on(channel, callback),
};
