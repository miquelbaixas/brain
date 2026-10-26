# Brain

Editor de notas markdown con la estética y el funcionamiento básico de Obsidian.

## Uso

- Abre **Brain.app** (doble clic). Puedes arrastrarla al Dock.
- Tus notas están en `~/brain/vault` como archivos `.md` normales.
- Ajustes y estado de la bóveda: `~/brain/vault/.brain/`. Datos de la app: `~/brain/.userdata/`.

## Funciones

- Explorador de archivos y carpetas: crear, renombrar, mover (arrastrando), duplicar, eliminar (a la papelera).
- Markdown con vista previa en vivo, modo fuente y vista de lectura (⌘ E).
- Enlaces internos `[[nota]]`, alias, encabezados, incrustaciones `![[nota]]` e imágenes. Autocompletado al escribir `[[`.
- Al renombrar o mover una nota se actualizan los enlaces que apuntan a ella.
- Panel derecho: enlaces entrantes (con menciones no enlazadas), enlaces salientes, etiquetas y esquema.
- Barra de estado: enlaces entrantes, palabras, caracteres y número de notas.
- Pestañas, paneles divididos (arrastrando pestañas o con clic derecho) y ventanas independientes que se recuerdan al cerrar.
- Selector rápido (⌘ O), paleta de comandos (⌘ P), búsqueda (⌘ ⇧ F), vista gráfica (⌘ G), marcadores, nota diaria, plegado de encabezados, tema claro y oscuro.

## Desarrollo

```
npm install
npm start          # ejecutar desde el código
npm run package    # regenerar Brain.app
```

Código: `electron/` (proceso principal), `src/js/` (interfaz), `src/app.css` (tema). `starter/` son las notas de bienvenida que se copian si la bóveda no existe.
