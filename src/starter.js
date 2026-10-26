// Ventana de inicio: crear una bóveda nueva o abrir una carpeta existente.
(async () => {
  const brain = window.brain;
  const $ = (id) => document.getElementById(id);
  const dark = window.matchMedia('(prefers-color-scheme: dark)');
  const applyTheme = () => {
    document.body.classList.toggle('theme-dark', dark.matches);
    document.body.classList.toggle('theme-light', !dark.matches);
  };
  applyTheme();
  dark.addEventListener('change', applyTheme);

  const info = await brain.invoke('starter:info');
  let parent = info.defaultParent;
  $('version').textContent = 'Versión ' + info.version;
  $('parent').textContent = parent;

  const showError = (err) => {
    const message = err && err.message ? err.message : String(err || '');
    $('error').textContent = message.replace(/^Error invoking remote method '[^']+': (Error: )?/, '');
  };

  const recent = $('recent');
  if (!info.recent.length) {
    recent.innerHTML = '<div class="starter-recent-empty">Todavía no has abierto ninguna bóveda.</div>';
  }
  for (const dir of info.recent) {
    const item = document.createElement('div');
    item.className = 'starter-recent-item';
    item.title = dir;
    const name = document.createElement('div');
    name.className = 'starter-recent-name';
    name.textContent = dir.split('/').pop();
    const path = document.createElement('div');
    path.className = 'starter-recent-path';
    path.textContent = dir;
    item.append(name, path);
    item.addEventListener('click', () => brain.invoke('starter:open', dir).catch(showError));
    recent.appendChild(item);
  }

  $('go-create').addEventListener('click', () => {
    $('choose').classList.add('is-hidden');
    $('create').classList.remove('is-hidden');
    $('error').textContent = '';
    $('name').focus();
    $('name').select();
  });

  $('back').addEventListener('click', () => {
    $('create').classList.add('is-hidden');
    $('choose').classList.remove('is-hidden');
    $('error').textContent = '';
  });

  $('browse').addEventListener('click', async () => {
    const dir = await brain.invoke('starter:pick-folder', parent);
    if (dir) {
      parent = dir;
      $('parent').textContent = dir;
    }
  });

  const create = () => {
    $('error').textContent = '';
    brain.invoke('starter:create', parent, $('name').value).catch(showError);
  };
  $('create-go').addEventListener('click', create);
  $('name').addEventListener('keydown', (e) => {
    if (e.key === 'Enter') create();
  });

  $('open').addEventListener('click', async () => {
    $('error').textContent = '';
    const dir = await brain.invoke('starter:pick-folder', info.defaultParent);
    if (dir) brain.invoke('starter:open', dir).catch(showError);
  });
})();
