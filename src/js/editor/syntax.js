// Extensiones del parser de markdown: [[enlaces]], ![[incrustaciones]], #etiquetas, ==resaltado== y frontmatter.
import { tags as t } from '@lezer/highlight';

const SPACE_BEFORE_TAG = new Set([32, 9, 10, 44, 59, 40]);

export const WikiLinkExtension = {
  defineNodes: [
    { name: 'WikiLink' },
    { name: 'Embed' },
    { name: 'WikiLinkMark', style: t.processingInstruction },
    { name: 'WikiLinkTarget' },
    { name: 'WikiLinkPipe', style: t.processingInstruction },
    { name: 'WikiLinkAlias' },
  ],
  parseInline: [
    {
      name: 'WikiLink',
      parse(cx, next, pos) {
        let open = pos;
        let embed = false;
        if (next === 33 && cx.char(pos + 1) === 91 && cx.char(pos + 2) === 91) {
          embed = true;
          open = pos + 1;
        } else if (!(next === 91 && cx.char(pos + 1) === 91)) {
          return -1;
        }
        const innerFrom = open + 2;
        const rest = cx.slice(innerFrom, cx.end);
        const close = rest.indexOf(']]');
        if (close <= 0) return -1;
        const inner = rest.slice(0, close);
        if (!inner.trim() || inner.includes('\n') || inner.includes('[[')) return -1;
        const innerTo = innerFrom + close;
        const children = [cx.elt('WikiLinkMark', pos, innerFrom)];
        const pipe = inner.search(/(?<!\\)\|/);
        if (pipe >= 0) {
          children.push(cx.elt('WikiLinkTarget', innerFrom, innerFrom + pipe));
          children.push(cx.elt('WikiLinkPipe', innerFrom + pipe, innerFrom + pipe + 1));
          if (innerFrom + pipe + 1 < innerTo) children.push(cx.elt('WikiLinkAlias', innerFrom + pipe + 1, innerTo));
        } else {
          children.push(cx.elt('WikiLinkTarget', innerFrom, innerTo));
        }
        children.push(cx.elt('WikiLinkMark', innerTo, innerTo + 2));
        return cx.addElement(cx.elt(embed ? 'Embed' : 'WikiLink', pos, innerTo + 2, children));
      },
      before: 'Link',
    },
  ],
};

export const HashtagExtension = {
  defineNodes: [{ name: 'Hashtag' }],
  parseInline: [
    {
      name: 'Hashtag',
      parse(cx, next, pos) {
        if (next !== 35) return -1;
        if (pos > cx.offset && !SPACE_BEFORE_TAG.has(cx.char(pos - 1))) return -1;
        const m = /^#([\p{L}\p{N}_\-/]*[\p{L}_\-/][\p{L}\p{N}_\-/]*)/u.exec(cx.slice(pos, Math.min(cx.end, pos + 200)));
        if (!m) return -1;
        return cx.addElement(cx.elt('Hashtag', pos, pos + m[0].length));
      },
      before: 'Emphasis',
    },
  ],
};

const HighlightDelim = { resolve: 'Highlight', mark: 'HighlightMark' };

export const HighlightExtension = {
  defineNodes: [{ name: 'Highlight' }, { name: 'HighlightMark', style: t.processingInstruction }],
  parseInline: [
    {
      name: 'Highlight',
      parse(cx, next, pos) {
        if (next !== 61 || cx.char(pos + 1) !== 61 || cx.char(pos + 2) === 61) return -1;
        const before = cx.slice(pos - 1, pos);
        const after = cx.slice(pos + 2, pos + 3);
        const spaceBefore = /\s|^$/.test(before);
        const spaceAfter = /\s|^$/.test(after);
        return cx.addDelimiter(HighlightDelim, pos, pos + 2, !spaceAfter, !spaceBefore);
      },
      after: 'Emphasis',
    },
  ],
};

const FRONTMATTER_BLOCK = /^---[ \t]*\r?\n(?:[\s\S]*?\r?\n)?(?:---|\.\.\.)[ \t]*(?=\r?\n|$)/;

export const FrontmatterExtension = {
  defineNodes: [{ name: 'Frontmatter', block: true }, { name: 'FrontmatterMark', style: t.processingInstruction }],
  parseBlock: [
    {
      name: 'Frontmatter',
      before: 'HorizontalRule',
      parse(cx, line) {
        if (cx.lineStart !== 0 || !/^---[ \t]*$/.test(line.text)) return false;
        const head = cx.input.read(0, Math.min(cx.input.length, 200000));
        const m = FRONTMATTER_BLOCK.exec(head);
        if (!m) return false;
        const end = m[0].length;
        const children = [cx.elt('FrontmatterMark', 0, line.text.length)];
        while (cx.nextLine()) {
          if (cx.lineStart + line.text.length >= end) {
            children.push(cx.elt('FrontmatterMark', cx.lineStart, cx.lineStart + line.text.length));
            cx.nextLine();
            break;
          }
        }
        cx.addElement(cx.elt('Frontmatter', 0, end, children));
        return true;
      },
    },
  ],
};

export const brainMarkdownExtensions = [WikiLinkExtension, HashtagExtension, HighlightExtension, FrontmatterExtension];
