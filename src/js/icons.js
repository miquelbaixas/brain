// Iconos (Lucide, los mismos que usa Obsidian) y algunos propios.
import {
  AppWindow, ArrowLeft, ArrowRight, ArrowUpDown, ArrowUpNarrowWide, BookOpen, Bookmark, BookmarkMinus,
  Bug, CalendarDays, Check, ChevronDown, ChevronRight, ChevronsDownUp, ChevronsUpDown, CircleAlert,
  CircleCheck, CircleHelp, CircleX, ClipboardList, Clock, Copy, Ellipsis, ExternalLink, File, FileCode,
  FileImage, FilePlus, FileQuestionMark, FileText, Files, Flame, Folder, FolderInput, FolderOpen,
  FolderPlus, GitFork, Hash, Image, Info, Keyboard, Layers, Lightbulb, Link, List, ListTree, Moon,
  PanelLeft, PanelRight, Paperclip, Pencil, Pin, Plus, Quote, RefreshCw, ScrollText, Search,
  SeparatorHorizontal, SeparatorVertical, Settings, SquarePen, SquareTerminal, Sun, Tags,
  TextCursorInput, Trash2, Vault, X, Zap, FileAudio, FileVideo,
} from 'lucide';

const LUCIDE = {
  'app-window': AppWindow,
  'arrow-left': ArrowLeft,
  'arrow-right': ArrowRight,
  'arrow-up-down': ArrowUpDown,
  'arrow-up-narrow-wide': ArrowUpNarrowWide,
  'book-open': BookOpen,
  bookmark: Bookmark,
  'bookmark-minus': BookmarkMinus,
  bug: Bug,
  'calendar-days': CalendarDays,
  check: Check,
  'chevron-down': ChevronDown,
  'chevron-right': ChevronRight,
  'chevrons-down-up': ChevronsDownUp,
  'chevrons-up-down': ChevronsUpDown,
  'circle-alert': CircleAlert,
  'circle-check': CircleCheck,
  'circle-help': CircleHelp,
  'circle-x': CircleX,
  'clipboard-list': ClipboardList,
  clock: Clock,
  copy: Copy,
  ellipsis: Ellipsis,
  'external-link': ExternalLink,
  file: File,
  'file-audio': FileAudio,
  'file-code': FileCode,
  'file-image': FileImage,
  'file-plus': FilePlus,
  'file-question': FileQuestionMark,
  'file-text': FileText,
  'file-video': FileVideo,
  files: Files,
  flame: Flame,
  folder: Folder,
  'folder-input': FolderInput,
  'folder-open': FolderOpen,
  'folder-plus': FolderPlus,
  'git-fork': GitFork,
  hash: Hash,
  image: Image,
  info: Info,
  keyboard: Keyboard,
  layers: Layers,
  lightbulb: Lightbulb,
  link: Link,
  list: List,
  'list-tree': ListTree,
  moon: Moon,
  'panel-left': PanelLeft,
  'panel-right': PanelRight,
  paperclip: Paperclip,
  pencil: Pencil,
  pin: Pin,
  plus: Plus,
  quote: Quote,
  'refresh-cw': RefreshCw,
  'scroll-text': ScrollText,
  search: Search,
  'separator-horizontal': SeparatorHorizontal,
  'separator-vertical': SeparatorVertical,
  settings: Settings,
  'square-pen': SquarePen,
  'square-terminal': SquareTerminal,
  sun: Sun,
  tags: Tags,
  'text-cursor-input': TextCursorInput,
  trash: Trash2,
  vault: Vault,
  x: X,
  zap: Zap,
};

// Iconos propios de Obsidian que no existen en Lucide.
const CUSTOM = {
  'right-triangle': [['path', { d: 'M3 8L12 17L21 8' }]],
  'links-coming-in': [
    ['path', { d: 'M9 17H7A5 5 0 0 1 7 7h2' }],
    ['path', { d: 'M15 7h2a5 5 0 0 1 4.6 7' }],
    ['path', { d: 'M8 12h13' }],
    ['path', { d: 'm12 8-4 4 4 4' }],
  ],
  'links-going-out': [
    ['path', { d: 'M9 17H7A5 5 0 0 1 7 7h2' }],
    ['path', { d: 'M15 7h2a5 5 0 0 1 4.6 7' }],
    ['path', { d: 'M8 12h13' }],
    ['path', { d: 'm17 8 4 4-4 4' }],
  ],
};

const SVG_NS = 'http://www.w3.org/2000/svg';

function build([tag, attrs, children]) {
  const node = document.createElementNS(SVG_NS, tag);
  for (const [k, v] of Object.entries(attrs || {})) node.setAttribute(k, String(v));
  for (const child of children || []) node.appendChild(build(child));
  return node;
}

export function icon(name) {
  const nodes = CUSTOM[name] || LUCIDE[name] || LUCIDE.file;
  const svg = build(['svg', {
    xmlns: SVG_NS,
    width: 24,
    height: 24,
    viewBox: '0 0 24 24',
    fill: 'none',
    stroke: 'currentColor',
    'stroke-width': 2,
    'stroke-linecap': 'round',
    'stroke-linejoin': 'round',
    class: 'svg-icon lucide-' + name + (name === 'right-triangle' ? ' right-triangle' : ''),
  }, nodes]);
  return svg;
}

export function hasIcon(name) {
  return !!(CUSTOM[name] || LUCIDE[name]);
}
