import { $, h, fmtBytes, fmtLeft, extOf, groupOf, icon } from './common.js';

const token = location.pathname.split('/').filter(Boolean).pop();
const sheet = $('#sheet');

async function load() {
  let res;
  try {
    res = await fetch(`/api/d/${encodeURIComponent(token)}`);
  } catch {
    return show(h('h1', {}, 'Can’t reach the server.'), h('p', { class: 'facts' }, 'Check your connection and reload this page.'));
  }
  if (!res.ok) {
    return show(
      h('h1', {}, 'This link has expired.'),
      h('p', { class: 'facts' }, 'Files are only kept for a short time. Ask the person who sent it to share the file again.')
    );
  }
  const f = await res.json();
  const ttlMs = Math.max(1, f.expiresAt - f.createdAt);
  const left = h('p', { class: 'facts' });
  const bar = h('b');
  const tick = () => {
    const ms = f.expiresAt - Date.now();
    if (ms <= 0) return load();
    left.textContent = `${fmtBytes(f.size)}, available for another ${fmtLeft(ms)}`;
    bar.style.setProperty('--p', Math.min(1, ms / ttlMs));
  };
  show(
    h('span', { class: 'ext', 'data-g': groupOf(f.name, f.mime) }, extOf(f.name)),
    h('h1', {}, f.name),
    left,
    h('a', { class: 'btn btn--blue', href: `/api/d/${encodeURIComponent(token)}/file`, download: '' }, icon('download'), 'Download'),
    h('div', { class: 'meter', 'aria-hidden': 'true' }, bar)
  );
  tick();
  setInterval(tick, 30000);
}

function show(...nodes) {
  sheet.replaceChildren(...nodes);
}
load();
