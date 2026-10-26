// Genera build/icon.png (1024 px) a partir de scripts/icon.svg. Uso: electron scripts/make-icon.cjs
const { app, BrowserWindow } = require('electron');
const fs = require('fs');
const path = require('path');

app.whenReady().then(async () => {
  const svg = fs.readFileSync(path.join(__dirname, 'icon.svg'), 'utf8');
  const win = new BrowserWindow({ show: false, width: 300, height: 300 });
  await win.loadURL('data:text/html,<html><body></body></html>');
  const dataUrl = await win.webContents.executeJavaScript(`new Promise((resolve) => {
    const img = new Image();
    img.onload = () => {
      const c = document.createElement('canvas');
      c.width = 1024; c.height = 1024;
      c.getContext('2d').drawImage(img, 0, 0, 1024, 1024);
      resolve(c.toDataURL('image/png'));
    };
    img.src = 'data:image/svg+xml;base64,' + ${JSON.stringify(Buffer.from(svg).toString('base64'))};
  })`);
  const out = path.join(__dirname, '..', 'build', 'icon.png');
  fs.writeFileSync(out, Buffer.from(dataUrl.split(',')[1], 'base64'));
  console.log('Icono generado en', out);
  app.quit();
});
