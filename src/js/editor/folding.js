// Plegado de encabezados y elementos de lista con flechas en el margen, como en Obsidian.
import { gutter, gutters, GutterMarker } from '@codemirror/view';
import { codeFolding, foldEffect, unfoldEffect, foldedRanges, syntaxTree } from '@codemirror/language';
import { el } from '../util.js';
import { icon } from '../icons.js';

function headingLevel(text) {
  const m = /^(#{1,6})\s/.exec(text);
  return m ? m[1].length : 0;
}

function inCode(state, pos) {
  for (let node = syntaxTree(state).resolveInner(pos, 1); node; node = node.parent) {
    if (node.name === 'FencedCode' || node.name === 'CodeBlock' || node.name === 'Frontmatter') return true;
  }
  return false;
}

// Rango plegable que empieza en la línea dada, o null.
export function foldRangeAt(state, line) {
  const level = headingLevel(line.text);
  if (level && !inCode(state, line.from)) {
    let end = line.to;
    for (let n = line.number + 1; n <= state.doc.lines; n++) {
      const next = state.doc.line(n);
      const l = headingLevel(next.text);
      if (l && l <= level && !inCode(state, next.from)) break;
      end = next.to;
    }
    // No incluir líneas vacías al final
    while (end > line.to && /^\s*$/.test(state.doc.lineAt(end).text)) end = state.doc.lineAt(end).from - 1;
    return end > line.to ? { from: line.to, to: end } : null;
  }
  const node = syntaxTree(state).resolveInner(line.from + /^\s*/.exec(line.text)[0].length, 1);
  for (let n = node; n; n = n.parent) {
    if (n.name === 'ListItem') {
      if (state.doc.lineAt(n.from).number !== line.number) return null;
      let to = n.to;
      while (to > line.to && /^\s*$/.test(state.doc.lineAt(to).text)) to = state.doc.lineAt(to).from - 1;
      return to > line.to ? { from: line.to, to } : null;
    }
    if (n.name === 'Document') break;
  }
  return null;
}

function isFolded(state, from) {
  let folded = null;
  foldedRanges(state).between(from, from + 1, (a, b) => {
    if (a === from) folded = { from: a, to: b };
  });
  return folded;
}

class FoldMarker extends GutterMarker {
  constructor(folded) {
    super();
    this.folded = folded;
  }

  eq(other) {
    return other.folded === this.folded;
  }

  toDOM() {
    return el('div.cm-fold-indicator', { cls: this.folded ? 'is-collapsed' : '' }, [el('div.collapse-indicator.collapse-icon', { cls: this.folded ? 'is-collapsed' : '' }, [icon('right-triangle')])]);
  }
}

const openMarker = new FoldMarker(false);
const closedMarker = new FoldMarker(true);

export const foldingExtensions = [
  gutters({ fixed: false }),
  codeFolding({
    placeholderDOM(view, onclick) {
      const span = el('span.cm-foldPlaceholder', { text: '…', title: 'Desplegar' });
      span.addEventListener('click', onclick);
      return span;
    },
  }),
  gutter({
    class: 'cm-fold-gutter',
    lineMarker(view, line) {
      const docLine = view.state.doc.lineAt(line.from);
      const range = foldRangeAt(view.state, docLine);
      if (!range) return null;
      return isFolded(view.state, docLine.to) ? closedMarker : openMarker;
    },
    lineMarkerChange: (update) => update.docChanged || update.viewportChanged ||
      update.transactions.some((tr) => tr.effects.some((e) => e.is(foldEffect) || e.is(unfoldEffect))) ||
      syntaxTree(update.startState) !== syntaxTree(update.state),
    initialSpacer: () => openMarker,
    domEventHandlers: {
      mousedown(view, line, event) {
        const docLine = view.state.doc.lineAt(line.from);
        const range = foldRangeAt(view.state, docLine);
        if (!range) return false;
        event.preventDefault();
        const folded = isFolded(view.state, docLine.to);
        view.dispatch({ effects: folded ? unfoldEffect.of(folded) : foldEffect.of(range) });
        return true;
      },
    },
  }),
];
