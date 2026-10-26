// Vista gráfica: notas como nodos y enlaces como aristas, con simulación de fuerzas.
import { forceSimulation, forceLink, forceManyBody, forceX, forceY, forceCollide } from 'd3-force';
import { el, iconButton, debounce, isModEvent } from '../util.js';
import { ItemView } from './base.js';

export class GraphView extends ItemView {
  constructor(leaf) {
    super(leaf);
    this.options = { search: '', showTags: false, showUnresolved: true, showOrphans: true, repel: 10, distance: 250, nodeSize: 1 };
    this.transform = { x: 0, y: 0, k: 1 };
    this.nodes = [];
    this.links = [];
    this.hover = null;
    this.containerEl.classList.add('mod-graph');
    this.graphEl = el('div.graph-view-container', { parent: this.contentEl });
    this.canvas = el('canvas', { parent: this.graphEl });
    this.ctx = this.canvas.getContext('2d');
    this.buildControls();
    this.rebuildSoon = debounce(() => this.rebuild(), 300);
    this.registerEvent(this.app.metadataCache.on('resolved', () => this.rebuildSoon()));
    this.registerEvent(this.app.workspace.on('file-open', () => this.draw()));
    this.registerEvent(this.app.settings.on('change', (key) => {
      if (key === 'theme' || key === 'accentColor') setTimeout(() => this.readColors(), 50);
    }));
    this.bindInteraction();
  }

  getViewType() {
    return 'graph';
  }

  getDisplayText() {
    return 'Vista gráfica';
  }

  getIcon() {
    return 'git-fork';
  }

  getState() {
    return { options: this.options };
  }

  async setState(state) {
    if (state && state.options) Object.assign(this.options, state.options);
    this.syncControls();
    this.rebuild();
  }

  async onOpen() {
    this.resizeObserver = new ResizeObserver(() => this.resize());
    this.resizeObserver.observe(this.graphEl);
    this.readColors();
    this.rebuild();
  }

  async onClose() {
    if (this.simulation) this.simulation.stop();
    if (this.resizeObserver) this.resizeObserver.disconnect();
    await super.onClose();
  }

  onShow() {
    this.resize();
  }

  readColors() {
    const style = getComputedStyle(this.graphEl);
    const v = (name) => style.getPropertyValue(name).trim();
    this.colors = {
      node: v('--graph-node') || '#999',
      line: v('--graph-line') || '#444',
      focused: v('--graph-node-focused') || '#a88bfa',
      unresolved: v('--graph-node-unresolved') || '#666',
      tag: v('--graph-node-tag') || '#44cf6e',
      attachment: v('--graph-node-attachment') || '#e0de71',
      text: v('--graph-text') || '#ddd',
      background: v('--background-primary') || '#1c1c1c',
    };
    this.draw();
  }

  /* ---------------------------------------------------------- Controles */

  buildControls() {
    const panel = el('div.graph-controls.is-close', { parent: this.graphEl });
    const header = el('div.graph-controls-header', { parent: panel });
    header.appendChild(iconButton('settings', 'Abrir ajustes del grafo', () => panel.classList.toggle('is-close')));
    const filters = el('div.graph-control-section', { parent: panel });
    this.searchInput = el('input', { attr: { type: 'search', placeholder: 'Buscar archivos…' }, parent: filters });
    this.searchInput.addEventListener('input', () => {
      this.options.search = this.searchInput.value;
      this.rebuildSoon();
      this.app.workspace.requestSaveLayout();
    });
    const toggleRow = (label, key) => {
      const box = el('div.checkbox-container');
      const row = el('div.graph-control-row', { parent: filters }, [el('span', { text: label }), box]);
      box.addEventListener('click', () => {
        this.options[key] = !this.options[key];
        box.classList.toggle('is-enabled', this.options[key]);
        this.rebuild();
        this.app.workspace.requestSaveLayout();
      });
      this['toggle_' + key] = box;
      return row;
    };
    toggleRow('Etiquetas', 'showTags');
    toggleRow('Notas sin crear', 'showUnresolved');
    toggleRow('Huérfanas', 'showOrphans');
    const forces = el('div.graph-control-section', { parent: panel });
    const slider = (label, key, min, max, step) => {
      const input = el('input', { attr: { type: 'range', min, max, step } });
      el('div.graph-control-row', { parent: forces }, [el('span', { text: label }), input]);
      input.addEventListener('input', () => {
        this.options[key] = Number(input.value);
        this.applyForces();
        this.app.workspace.requestSaveLayout();
      });
      this['slider_' + key] = input;
    };
    slider('Tamaño de los nodos', 'nodeSize', 0.4, 3, 0.1);
    slider('Fuerza de repulsión', 'repel', 0, 20, 1);
    slider('Distancia de enlaces', 'distance', 30, 500, 10);
    this.syncControls();
  }

  syncControls() {
    if (!this.searchInput) return;
    this.searchInput.value = this.options.search || '';
    for (const key of ['showTags', 'showUnresolved', 'showOrphans']) this['toggle_' + key].classList.toggle('is-enabled', !!this.options[key]);
    for (const key of ['nodeSize', 'repel', 'distance']) this['slider_' + key].value = this.options[key];
  }

  /* -------------------------------------------------------------- Datos */

  rebuild() {
    const mc = this.app.metadataCache;
    const old = new Map(this.nodes.map((n) => [n.id, n]));
    const nodes = new Map();
    const links = [];
    const query = (this.options.search || '').toLowerCase().trim();
    const addNode = (id, data) => {
      if (nodes.has(id)) return nodes.get(id);
      const prev = old.get(id);
      const node = { id, ...data, degree: 0, x: prev ? prev.x : (Math.random() - 0.5) * 400, y: prev ? prev.y : (Math.random() - 0.5) * 400, vx: prev ? prev.vx : 0, vy: prev ? prev.vy : 0 };
      nodes.set(id, node);
      return node;
    };
    const files = this.app.vault.getMarkdownFiles().filter((f) => !query || f.path.toLowerCase().includes(query));
    const allowed = new Set(files.map((f) => f.path));
    for (const file of files) addNode(file.path, { label: file.basename, type: 'file', path: file.path });
    for (const file of files) {
      for (const target of Object.keys(mc.resolvedLinks[file.path] || {})) {
        if (target === file.path) continue;
        const targetFile = this.app.vault.getFile(target);
        if (!targetFile) continue;
        if (targetFile.extension !== 'md') continue;
        if (!allowed.has(target)) continue;
        links.push({ source: file.path, target });
      }
      if (this.options.showUnresolved) {
        for (const linkpath of Object.keys(mc.unresolvedLinks[file.path] || {})) {
          const id = 'unresolved:' + linkpath.toLowerCase();
          addNode(id, { label: linkpath.split('/').pop(), type: 'unresolved', linkpath, sourcePath: file.path });
          links.push({ source: file.path, target: id });
        }
      }
      if (this.options.showTags) {
        const parsed = mc.getFileCache(file.path);
        for (const { tag } of parsed ? parsed.tags : []) {
          const id = 'tag:' + tag.toLowerCase();
          addNode(id, { label: tag, type: 'tag', tag });
          links.push({ source: file.path, target: id });
        }
      }
    }
    // Quitar enlaces duplicados
    const seen = new Set();
    this.links = links.filter((l) => {
      const key = l.source < l.target ? l.source + '\u0000' + l.target : l.target + '\u0000' + l.source;
      if (seen.has(key)) return false;
      seen.add(key);
      return true;
    });
    for (const l of this.links) {
      nodes.get(l.source).degree += 1;
      nodes.get(l.target).degree += 1;
    }
    let list = [...nodes.values()];
    if (!this.options.showOrphans) list = list.filter((n) => n.degree > 0);
    const ids = new Set(list.map((n) => n.id));
    this.links = this.links.filter((l) => ids.has(l.source) && ids.has(l.target));
    this.nodes = list;
    this.neighbors = new Map(list.map((n) => [n.id, new Set()]));
    for (const l of this.links) {
      this.neighbors.get(l.source).add(l.target);
      this.neighbors.get(l.target).add(l.source);
    }
    this.startSimulation(old.size === 0);
  }

  radius(node) {
    return (3 + Math.sqrt(node.degree) * 1.6) * this.options.nodeSize + 1;
  }

  startSimulation(fresh) {
    if (this.simulation) this.simulation.stop();
    this.simulation = forceSimulation(this.nodes)
      .force('link', forceLink(this.links).id((d) => d.id))
      .force('charge', forceManyBody())
      .force('x', forceX(0).strength(0.04))
      .force('y', forceY(0).strength(0.04))
      .force('collide', forceCollide((d) => this.radius(d) + 2))
      .alphaDecay(0.025)
      .on('tick', () => this.draw());
    this.applyForces();
    this.simulation.alpha(fresh ? 1 : 0.3).restart();
  }

  applyForces() {
    if (!this.simulation) return;
    this.simulation.force('charge').strength(-30 - this.options.repel * 18).distanceMax(900);
    this.simulation.force('link').distance(this.options.distance * 0.35).strength(0.6);
    this.simulation.force('collide').radius((d) => this.radius(d) + 2);
    this.simulation.alpha(Math.max(this.simulation.alpha(), 0.3)).restart();
  }

  /* -------------------------------------------------------------- Dibujo */

  resize() {
    const rect = this.graphEl.getBoundingClientRect();
    if (!rect.width || !rect.height) return;
    const dpr = window.devicePixelRatio || 1;
    this.width = rect.width;
    this.height = rect.height;
    this.canvas.width = Math.round(rect.width * dpr);
    this.canvas.height = Math.round(rect.height * dpr);
    this.dpr = dpr;
    if (!this.centered) {
      this.transform.x = rect.width / 2;
      this.transform.y = rect.height / 2;
      this.centered = true;
    }
    this.draw();
  }

  draw() {
    if (!this.width || !this.colors || this.drawPending) return;
    this.drawPending = true;
    requestAnimationFrame(() => {
      this.drawPending = false;
      this.paint();
    });
  }

  paint() {
    const { ctx, transform: t, colors } = this;
    ctx.setTransform(this.dpr, 0, 0, this.dpr, 0, 0);
    ctx.clearRect(0, 0, this.width, this.height);
    ctx.translate(t.x, t.y);
    ctx.scale(t.k, t.k);
    const hover = this.hover;
    const related = hover ? this.neighbors.get(hover.id) : null;
    const active = this.app.workspace.getActiveFile();
    const activeId = active ? active.path : null;

    ctx.lineWidth = 1 / Math.max(t.k, 0.5);
    for (const l of this.links) {
      const s = l.source;
      const d = l.target;
      const highlighted = hover && (s === hover || d === hover);
      ctx.globalAlpha = hover ? (highlighted ? 1 : 0.15) : 0.7;
      ctx.strokeStyle = highlighted ? colors.focused : colors.line;
      ctx.beginPath();
      ctx.moveTo(s.x, s.y);
      ctx.lineTo(d.x, d.y);
      ctx.stroke();
    }

    for (const n of this.nodes) {
      const r = this.radius(n);
      const isHover = hover === n;
      const isNeighbor = related && related.has(n.id);
      ctx.globalAlpha = hover && !isHover && !isNeighbor ? 0.25 : 1;
      let fill = n.type === 'unresolved' ? colors.unresolved : n.type === 'tag' ? colors.tag : colors.node;
      if (isHover || n.id === activeId) fill = colors.focused;
      ctx.fillStyle = fill;
      ctx.beginPath();
      ctx.arc(n.x, n.y, r, 0, Math.PI * 2);
      ctx.fill();
    }

    // Etiquetas de texto: aparecen al acercar el zoom
    const textAlpha = Math.max(0, Math.min(1, (t.k - 0.55) / 0.5));
    ctx.font = `${12 / Math.max(t.k, 0.75) * Math.min(t.k, 1.4)}px ${getComputedStyle(document.body).getPropertyValue('--font-interface') || 'sans-serif'}`;
    ctx.textAlign = 'center';
    ctx.textBaseline = 'top';
    ctx.fillStyle = colors.text;
    for (const n of this.nodes) {
      const isHover = hover === n;
      const isNeighbor = related && related.has(n.id);
      let alpha = textAlpha;
      if (hover) alpha = isHover ? 1 : isNeighbor ? Math.max(textAlpha, 0.8) : textAlpha * 0.2;
      if (alpha <= 0.02) continue;
      ctx.globalAlpha = alpha;
      ctx.fillText(n.label, n.x, n.y + this.radius(n) + 3);
    }
    ctx.globalAlpha = 1;
  }

  /* -------------------------------------------------------- Interacción */

  toGraph(clientX, clientY) {
    const rect = this.canvas.getBoundingClientRect();
    return { x: (clientX - rect.left - this.transform.x) / this.transform.k, y: (clientY - rect.top - this.transform.y) / this.transform.k };
  }

  nodeAt(clientX, clientY) {
    const p = this.toGraph(clientX, clientY);
    let best = null;
    let bestDist = Infinity;
    for (const n of this.nodes) {
      const d = Math.hypot(n.x - p.x, n.y - p.y);
      const r = this.radius(n) + 4 / this.transform.k;
      if (d <= r && d < bestDist) {
        best = n;
        bestDist = d;
      }
    }
    return best;
  }

  bindInteraction() {
    const canvas = this.canvas;
    canvas.addEventListener('wheel', (e) => {
      e.preventDefault();
      const rect = canvas.getBoundingClientRect();
      const mx = e.clientX - rect.left;
      const my = e.clientY - rect.top;
      const factor = Math.exp(-e.deltaY * (e.ctrlKey ? 0.01 : 0.0025));
      const k = Math.max(0.1, Math.min(6, this.transform.k * factor));
      this.transform.x = mx - ((mx - this.transform.x) * k) / this.transform.k;
      this.transform.y = my - ((my - this.transform.y) * k) / this.transform.k;
      this.transform.k = k;
      this.draw();
    }, { passive: false });

    let drag = null;
    canvas.addEventListener('mousedown', (e) => {
      if (e.button !== 0) return;
      const node = this.nodeAt(e.clientX, e.clientY);
      drag = { node, startX: e.clientX, startY: e.clientY, tx: this.transform.x, ty: this.transform.y, moved: false };
      if (node) {
        node.fx = node.x;
        node.fy = node.y;
        this.simulation.alphaTarget(0.3).restart();
      }
      const move = (ev) => {
        const dx = ev.clientX - drag.startX;
        const dy = ev.clientY - drag.startY;
        if (Math.abs(dx) + Math.abs(dy) > 3) drag.moved = true;
        if (drag.node) {
          const p = this.toGraph(ev.clientX, ev.clientY);
          drag.node.fx = p.x;
          drag.node.fy = p.y;
        } else {
          this.transform.x = drag.tx + dx;
          this.transform.y = drag.ty + dy;
          this.draw();
        }
      };
      const up = (ev) => {
        document.removeEventListener('mousemove', move);
        document.removeEventListener('mouseup', up);
        if (drag.node) {
          drag.node.fx = null;
          drag.node.fy = null;
          this.simulation.alphaTarget(0);
          if (!drag.moved) this.openNode(drag.node, ev);
        }
        drag = null;
      };
      document.addEventListener('mousemove', move);
      document.addEventListener('mouseup', up);
    });

    canvas.addEventListener('mousemove', (e) => {
      if (drag) return;
      const node = this.nodeAt(e.clientX, e.clientY);
      if (node !== this.hover) {
        this.hover = node;
        canvas.style.cursor = node ? 'pointer' : 'default';
        this.draw();
      }
    });
    canvas.addEventListener('mouseleave', () => {
      this.hover = null;
      this.draw();
    });
  }

  openNode(node, e) {
    const newLeaf = isModEvent(e) ? 'tab' : false;
    if (node.type === 'file') {
      const file = this.app.vault.getFile(node.path);
      if (file) this.app.workspace.openFile(file, newLeaf);
    } else if (node.type === 'unresolved') {
      this.app.workspace.openLinkText(node.linkpath, node.sourcePath, newLeaf);
    } else if (node.type === 'tag') {
      this.app.openSearch('tag:' + node.tag);
    }
  }
}
