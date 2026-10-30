// Small helpers shared by the client page, the download page and the admin console.

export const $ = (sel, root = document) => root.querySelector(sel);

/** Build DOM safely: text goes in as text nodes, never as HTML. */
export function h(tag, attrs, ...kids) {
  const el = document.createElement(tag);
  for (const [k, v] of Object.entries(attrs || {})) {
    if (v == null || v === false) continue;
    if (k === 'class') el.className = v;
    else if (k.startsWith('on')) el.addEventListener(k.slice(2), v);
    else el.setAttribute(k, v === true ? '' : v);
  }
  for (const kid of kids.flat()) {
    if (kid == null || kid === false) continue;
    el.append(kid.nodeType ? kid : document.createTextNode(String(kid)));
  }
  return el;
}

export function fmtBytes(n) {
  const u = ['B', 'KB', 'MB', 'GB', 'TB'];
  let i = 0;
  while (n >= 1024 && i < u.length - 1) {
    n /= 1024;
    i++;
  }
  return `${n >= 10 || i === 0 ? Math.round(n) : n.toFixed(1)} ${u[i]}`;
}

export function fmtLeft(ms) {
  if (ms <= 0) return 'expired';
  const m = Math.floor(ms / 60000);
  if (m >= 60) return `${Math.floor(m / 60)}h ${String(m % 60).padStart(2, '0')}m`;
  if (m >= 1) return `${m}m`;
  return 'under 1m';
}

export function fmtAgo(ms) {
  const m = Math.floor(ms / 60000);
  if (m < 1) return 'just now';
  if (m < 60) return `${m}m ago`;
  const hr = Math.floor(m / 60);
  return `${hr}h ${m % 60}m ago`;
}

export function fmtHours(n) {
  return n === 1 ? '1 hour' : `${n} hours`;
}

export function extOf(name) {
  const i = name.lastIndexOf('.');
  return i > 0 && i < name.length - 1 ? name.slice(i + 1).toLowerCase().slice(0, 4) : 'file';
}

const DOCS = new Set(['pdf', 'doc', 'docx', 'xls', 'xlsx', 'csv', 'ppt', 'pptx', 'txt', 'rtf', 'odt', 'ods', 'odp', 'md', 'json', 'xml', 'key', 'pages', 'numbers']);
const ARCH = new Set(['zip', 'rar', '7z', 'tar', 'gz', 'tgz', 'bz2', 'xz', 'iso', 'dmg']);

/** doc | image | video | audio | archive | other */
export function groupOf(name, mime = '') {
  const e = extOf(name);
  if (mime.startsWith('image/')) return 'image';
  if (mime.startsWith('video/')) return 'video';
  if (mime.startsWith('audio/')) return 'audio';
  if (mime === 'application/pdf' || DOCS.has(e) || mime.startsWith('text/')) return 'doc';
  if (ARCH.has(e)) return 'archive';
  return 'other';
}

const INLINE = /^(image\/(png|jpe?g|gif|webp|avif|bmp)|video\/(mp4|webm|ogg|quicktime)|audio\/(mpeg|mp3|ogg|wav|webm|aac|mp4|x-m4a)|application\/pdf)$/;
export const canPreview = (mime) => INLINE.test(mime);

const ICONS = {
  download: 'M12 3v12m0 0l-5-5m5 5l5-5M5 21h14',
  trash: 'M4 7h16M10 11v6m4-6v6M6 7l1 13h10l1-13M9 7V4h6v3',
  link: 'M10 14a4 4 0 005.7 0l3-3a4 4 0 00-5.7-5.7l-1 1M14 10a4 4 0 00-5.7 0l-3 3a4 4 0 005.7 5.7l1-1',
  close: 'M6 6l12 12M18 6L6 18',
  plus: 'M12 5v14M5 12h14',
  copy: 'M9 9h10v11H9zM5 15V4h10',
  check: 'M5 12.5l4.5 4.5L19 7.5',
  retry: 'M4 12a8 8 0 108-8H7m0 0l3-3M7 4l3 3',
};

export function icon(name) {
  const svg = document.createElementNS('http://www.w3.org/2000/svg', 'svg');
  svg.setAttribute('viewBox', '0 0 24 24');
  svg.setAttribute('fill', 'none');
  svg.setAttribute('stroke', 'currentColor');
  svg.setAttribute('stroke-width', '2');
  svg.setAttribute('stroke-linecap', 'round');
  svg.setAttribute('stroke-linejoin', 'round');
  svg.setAttribute('aria-hidden', 'true');
  const p = document.createElementNS('http://www.w3.org/2000/svg', 'path');
  p.setAttribute('d', ICONS[name]);
  svg.append(p);
  return svg;
}

export function store(key, value) {
  try {
    if (value === undefined) return JSON.parse(localStorage.getItem(key));
    localStorage.setItem(key, JSON.stringify(value));
  } catch {
    return null;
  }
}
