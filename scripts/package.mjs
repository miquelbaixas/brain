// Crea ~/brain/Brain.app (aplicación de macOS de doble clic).
import { packager } from '@electron/packager';
import fs from 'node:fs';
import path from 'node:path';
import os from 'node:os';

const root = path.resolve(path.dirname(new URL(import.meta.url).pathname), '..');
const out = fs.mkdtempSync(path.join(os.tmpdir(), 'brain-package-'));

const [appDir] = await packager({
  dir: root,
  out,
  name: 'Brain',
  executableName: 'Brain',
  platform: 'darwin',
  arch: process.arch,
  icon: path.join(root, 'build', 'icon.icns'),
  appBundleId: 'local.brain.notes',
  appCategoryType: 'public.app-category.productivity',
  asar: false,
  prune: false,
  overwrite: true,
  ignore: [
    /^\/node_modules($|\/)/,
    /^\/vault($|\/)/,
    /^\/\.userdata($|\/)/,
    /^\/Brain\.app($|\/)/,
    /^\/scripts($|\/)/,
    /^\/build($|\/)/,
    /^\/build\.mjs$/,
    /^\/package-lock\.json$/,
    /^\/README\.md$/,
    /\.map$/,
  ],
});

const target = path.join(root, 'Brain.app');
fs.rmSync(target, { recursive: true, force: true });
fs.renameSync(path.join(appDir, 'Brain.app'), target);
fs.rmSync(out, { recursive: true, force: true });
console.log('Aplicación creada en', target);
