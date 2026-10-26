// Punto de entrada del renderer.
import { App } from './app.js';

const app = new App();
window.brainApp = app;
app.init().catch((err) => {
  console.error(err);
  document.body.textContent = 'No se pudo iniciar Brain: ' + (err && err.message ? err.message : err);
  document.body.style.cssText = 'padding:40px;font-family:system-ui;color:#dadada;background:#1c1c1c';
});
