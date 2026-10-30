import { $, h, fmtBytes, fmtLeft, fmtHours, extOf, groupOf, icon, store } from './common.js';

const slips = $('#slips');
const fileInput = $('#file');
const senderInput = $('#sender');
const announce = $('#announce');

let cfg = { ttlHours: 24, maxFileBytes: 1024 ** 3 };
const RECEIPTS_KEY = 'slot.receipts.v1';
const SENDER_KEY = 'slot.sender';
const MAX_PARALLEL = 3;

const items = []; // { file, name, size, state, expiresAt, ttlMs, xhr, el }
let active = 0;

// ---- config ----------------------------------------------------------------------------------
fetch('/api/config')
  .then((r) => r.json())
  .then((c) => {
    cfg = c;
    document.querySelectorAll('[data-ttl]').forEach((n) => (n.textContent = fmtHours(c.ttlHours)));
  })
  .catch(() => {});

senderInput.value = store(SENDER_KEY) || '';
senderInput.addEventListener('input', () => store(SENDER_KEY, senderInput.value));

// ---- receipts -----------------------------------------------------------------------------------
function buildSlip(item) {
  const name = h('p', { class: 'slip-name' }, item.name);
  const status = h('p', { class: 'slip-status' });
  const act = h('div', { class: 'slip-act' });
  const meter = h('div', { class: 'meter', 'aria-hidden': 'true' }, h('b'));
  const ext = h('span', { class: 'ext', 'data-g': groupOf(item.name) }, extOf(item.name));
  const el = h('li', { class: 'slip', 'data-state': item.state }, ext, h('div', { class: 'slip-text' }, name, status), act, meter);
  item.el = el;
  item.ui = { status, act, meter: meter.firstChild };
  return el;
}

function paint(item) {
  const { el, ui } = item;
  el.dataset.state = item.state;
  ui.act.replaceChildren();

  if (item.state === 'queued') {
    ui.status.textContent = 'Waiting to upload';
    ui.meter.style.setProperty('--p', 0);
    ui.act.append(removeBtn(item, 'Cancel'));
  } else if (item.state === 'uploading') {
    const pct = Math.round(item.progress * 100);
    ui.status.textContent = pct >= 100 ? 'Finishing…' : `Uploading ${pct}% of ${fmtBytes(item.size)}`;
    ui.meter.style.setProperty('--p', item.progress);
    ui.act.append(removeBtn(item, 'Cancel'));
  } else if (item.state === 'done') {
    const left = item.expiresAt - Date.now();
    ui.status.textContent = `Sent. Deleted in ${fmtLeft(left)}`;
    ui.meter.style.setProperty('--p', Math.max(0, Math.min(1, left / item.ttlMs)));
    ui.act.append(removeBtn(item, 'Hide'));
  } else if (item.state === 'error') {
    ui.status.textContent = item.error;
    if (item.file && item.retryable) {
      ui.act.append(
        h('button', { class: 'btn btn--line', type: 'button', onclick: () => { item.state = 'queued'; paint(item); pump(); } }, icon('retry'), 'Try again')
      );
    }
    ui.act.append(removeBtn(item, 'Remove'));
  }
}

function removeBtn(item, label) {
  const b = h('button', { class: 'icon-btn', type: 'button', 'aria-label': `${label} ${item.name}`, title: label, onclick: () => remove(item) }, icon('close'));
  return b;
}

function remove(item) {
  if (item.xhr) item.xhr.abort();
  const i = items.indexOf(item);
  if (i >= 0) items.splice(i, 1);
  item.el.remove();
  persist();
  pump();
}

function persist() {
  store(
    RECEIPTS_KEY,
    items.filter((i) => i.state === 'done').map((i) => ({ name: i.name, size: i.size, expiresAt: i.expiresAt, ttlMs: i.ttlMs }))
  );
}

function say(msg) {
  announce.textContent = '';
  setTimeout(() => (announce.textContent = msg), 50);
}

// ---- uploading ---------------------------------------------------------------------------------
function addFiles(list) {
  const files = Array.from(list || []);
  if (!files.length) return;
  for (const file of files) {
    const item = { file, name: file.name || 'pasted-file', size: file.size, state: 'queued', progress: 0, retryable: false };
    if (file.size === 0) {
      item.state = 'error';
      item.error = 'Empty file. If this is a folder, zip it first.';
    } else if (file.size > cfg.maxFileBytes) {
      item.state = 'error';
      item.error = `Too large. The limit is ${fmtBytes(cfg.maxFileBytes)} per file.`;
    }
    items.unshift(item);
    slips.prepend(buildSlip(item));
    paint(item);
  }
  pump();
}

function pump() {
  for (const item of items.slice().reverse()) {
    if (active >= MAX_PARALLEL) break;
    if (item.state === 'queued') start(item);
  }
}

function start(item) {
  active++;
  item.state = 'uploading';
  item.progress = 0;
  paint(item);

  const fd = new FormData();
  fd.append('sender', senderInput.value.trim());
  fd.append('file', item.file, item.name);

  const xhr = new XMLHttpRequest();
  item.xhr = xhr;
  xhr.open('POST', '/api/upload');
  xhr.responseType = 'json';
  xhr.upload.onprogress = (e) => {
    if (e.lengthComputable) {
      item.progress = e.loaded / e.total;
      paint(item);
    }
  };
  const finish = () => {
    active--;
    item.xhr = null;
    pump();
  };
  xhr.onload = () => {
    const body = xhr.response || {};
    if (xhr.status === 201) {
      item.state = 'done';
      item.expiresAt = body.expiresAt;
      item.ttlMs = cfg.ttlHours * 3600e3;
      item.file = null;
      persist();
      say(`${item.name} sent.`);
    } else {
      item.state = 'error';
      item.error = body.error || 'The upload failed. Try again.';
      item.retryable = xhr.status >= 500 || xhr.status === 429;
      say(`${item.name} failed. ${item.error}`);
    }
    paint(item);
    finish();
  };
  xhr.onerror = () => {
    item.state = 'error';
    item.error = 'Lost the connection. Check your network and try again.';
    item.retryable = true;
    paint(item);
    finish();
  };
  xhr.onabort = finish;
  xhr.send(fd);
}

// ---- inputs: click, drop, paste ------------------------------------------------------------------
$('#slot').addEventListener('click', () => fileInput.click());
fileInput.addEventListener('change', () => {
  addFiles(fileInput.files);
  fileInput.value = '';
});

let depth = 0;
const hasFiles = (e) => e.dataTransfer && Array.from(e.dataTransfer.types || []).includes('Files');

window.addEventListener('dragenter', (e) => {
  if (!hasFiles(e)) return;
  depth++;
  document.body.classList.add('is-dragging');
});
window.addEventListener('dragleave', (e) => {
  if (!hasFiles(e)) return;
  depth = Math.max(0, depth - 1);
  if (!depth) document.body.classList.remove('is-dragging');
});
window.addEventListener('dragover', (e) => {
  if (hasFiles(e)) e.preventDefault();
});
window.addEventListener('drop', (e) => {
  if (!hasFiles(e)) return;
  e.preventDefault();
  depth = 0;
  document.body.classList.remove('is-dragging');
  addFiles(e.dataTransfer.files);
});

window.addEventListener('paste', (e) => {
  const files = e.clipboardData && e.clipboardData.files;
  if (files && files.length) {
    e.preventDefault();
    const stamp = new Date().toISOString().slice(0, 19).replace(/[:T]/g, '-');
    addFiles(
      Array.from(files).map((f) => (f.name && f.name !== 'image.png' ? f : new File([f], `pasted-${stamp}.${(f.type.split('/')[1] || 'bin').replace('jpeg', 'jpg')}`, { type: f.type })))
    );
  }
});

// ---- restore earlier receipts, keep countdowns honest -------------------------------------------
for (const r of store(RECEIPTS_KEY) || []) {
  if (!r || r.expiresAt <= Date.now()) continue;
  const item = { name: r.name, size: r.size, state: 'done', expiresAt: r.expiresAt, ttlMs: r.ttlMs || 86400e3, progress: 1 };
  items.push(item);
  slips.append(buildSlip(item));
  paint(item);
}

setInterval(() => {
  for (const item of items.slice()) {
    if (item.state !== 'done') continue;
    if (item.expiresAt <= Date.now()) remove(item);
    else paint(item);
  }
}, 30 * 1000);
