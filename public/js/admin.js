import { $, h, fmtBytes, fmtLeft, fmtAgo, fmtHours, extOf, groupOf, canPreview, icon } from './common.js';



const ZIP_MAX = 100;

const POLL_MS = 8000;

const GROUPS = [

  ['all', 'Everything'],

  ['doc', 'Documents'],

  ['image', 'Images'],

  ['video', 'Video'],

  ['audio', 'Audio'],

  ['archive', 'Archives'],

  ['other', 'Other'],

];



const state = {

  kind: 'in',

  group: 'all',

  sort: 'new',

  q: '',

  files: [],

  counts: { in: 0, out: 0 },

  selected: new Set(),

  sig: '',

  skew: 0, // server time minus browser time

  ttlHours: 24,

  maxFileBytes: 1024 ** 3,

};

const rowRefs = new Map(); // id -> { el, left, drain, file }

let pollTimer = null;



const nowMs = () => Date.now() + state.skew;



// ---- api ------------------------------------------------------------------------------------------

async function api(path, { method = 'GET', body } = {}) {

const res = await fetch(path, {

    method,

    credentials: 'same-origin',

    headers: { 'X-Requested-With': 'slot', ...(body ? { 'Content-Type': 'application/json' } : {}) },

    body: body ? JSON.stringify(body) : undefined,

  });

  if (res.status === 401) {
    window.location.replace('/auth/login');
    throw new Error('signed-out');
  }

const data = await res.json().catch(() => ({}));

  if (!res.ok) throw new Error(data.error || 'Something went wrong. Try again.');

  return data;

}



// ---- views -------------------------------------------------------------------------------------------

function setView(v) {
  document.body.dataset.view = v;
  const loading = $('#auth-loading');
  if (loading) loading.hidden = v === 'app';
  $('#app').hidden = v !== 'app';
  clearInterval(pollTimer);
  if (v === 'app') pollTimer = setInterval(() => document.visibilityState === 'visible' && refresh().catch(() => {}), POLL_MS);
}



async function boot() {
  const loading = $('#auth-loading');
  try {
    const res = await fetch('/api/admin/me', { credentials: 'same-origin' });
    if (res.status === 401) {
      window.location.replace('/auth/login');
      return;
    }
    if (!res.ok) throw new Error('Could not verify the admin session.');
    const me = await res.json();
    enterApp(me.username);
  } catch {
    if (loading) loading.textContent = 'Can’t reach the server. Check your connection and reload.';
  }
}



function enterApp(username) {

  $('#who').textContent = username;

  setView('app');

  refresh({ force: true }).catch(() => {});

}



$('#logout').addEventListener('click', async () => {
  try {
    const res = await fetch('/api/admin/logout', {
      method: 'POST',
      credentials: 'same-origin',
      headers: { 'X-Requested-With': 'slot' },
    });
    if (res.status === 401) {
      window.location.replace('/auth/login');
      return;
    }
  } catch {}
  window.location.replace('/');
});



// ---- data ----------------------------------------------------------------------------------------------

async function refresh({ force = false } = {}) {

const data = await api(`/api/admin/files?kind=${state.kind}`);

  state.skew = data.now - Date.now();

  state.counts = data.counts;

  state.ttlHours = data.ttlHours;

  state.maxFileBytes = data.maxFileBytes;

  renderChrome(data);



const sig = data.files.map((f) => f.id).join(',');

  if (force || sig !== state.sig) {

    state.sig = sig;

    state.files = data.files;

const ids = new Set(data.files.map((f) => f.id));

    for (const id of state.selected) if (!ids.has(id)) state.selected.delete(id);

    renderList();

  }

}



function renderChrome(data) {

  $('#count-in').textContent = data.counts.in;

  $('#count-out').textContent = data.counts.out;

  $('#tab-in').setAttribute('aria-selected', state.kind === 'in');

  $('#tab-out').setAttribute('aria-selected', state.kind === 'out');

const { used, cap } = data.storage;

  $('#storage-text').textContent = `${fmtBytes(used)} of ${fmtBytes(cap)} in use. Everything clears itself after ${fmtHours(data.ttlHours)}.`;

  $('#storage-bar').style.setProperty('--p', Math.min(1, used / cap));

  if (used / cap > 0.8) $('#storage').setAttribute('data-warn', '');

  else $('#storage').removeAttribute('data-warn');

  document.querySelectorAll('[data-ttl]').forEach((n) => (n.textContent = fmtHours(data.ttlHours)));

}



// ---- list ---------------------------------------------------------------------------------------------------

function visibleFiles() {

let list = state.files;

  if (state.group !== 'all') list = list.filter((f) => groupOf(f.name, f.mime) === state.group);

const q = state.q.trim().toLowerCase();

  if (q) list = list.filter((f) => f.name.toLowerCase().includes(q) || f.sender.toLowerCase().includes(q));

const by = {

    new: (a, b) => b.createdAt - a.createdAt,

    soon: (a, b) => a.expiresAt - b.expiresAt,

    big: (a, b) => b.size - a.size,

    name: (a, b) => a.name.localeCompare(b.name, undefined, { numeric: true, sensitivity: 'base' }),

  }[state.sort];

  return list.slice().sort(by);

}



function renderList() {

const rows = $('#rows');

const list = visibleFiles();

  rowRefs.clear();

  rows.replaceChildren(...list.map(rowFor));

  $('#select-all').hidden = list.length < 2;

  renderChips();

  renderEmpty(list.length);

  renderBulk();

}



function renderChips() {

const present = new Set(state.files.map((f) => groupOf(f.name, f.mime)));

const chips = $('#chips');

  chips.replaceChildren(

    ...GROUPS.filter(([g]) => g === 'all' || present.has(g) || g === state.group).map(([g, label]) =>

      h('button', {

        class: 'chip',

        type: 'button',

        'aria-pressed': state.group === g,

        onclick: () => {

          state.group = g;

          renderList();

        },

      }, label)

    )

  );

}



function cleanIp(ip) {

  return String(ip || '').replace(/^::ffff:/, '');

}



function rowFor(f) {

const g = groupOf(f.name, f.mime);

const selected = state.selected.has(f.id);

const age = nowMs() - f.createdAt;



const box = h('input', { type: 'checkbox', 'aria-label': `Select ${f.name}`, onchange: (e) => select(f.id, e.target.checked) });

  box.checked = selected;



const dl = `/api/admin/files/${encodeURIComponent(f.id)}/download`;

const nameEl = canPreview(f.mime)

    ? h('button', { class: 'name', type: 'button', onclick: () => openViewer(f) }, f.name)

    : h('a', { class: 'name', href: dl, download: '' }, f.name);



const facts = h(

    'div',

    { class: 'facts' },

    age < 5 * 60e3 ? h('span', { class: 'fresh' }, 'New') : null,

    h('span', { class: 'from' }, f.kind === 'in' ? f.sender || 'No name given' : `Sent by ${f.uploadedBy || 'an admin'}`),

    h('span', {}, fmtBytes(f.size)),

    h('span', {}, fmtAgo(age)),

    f.kind === 'in' && f.ip ? h('span', { title: 'Uploader network address' }, cleanIp(f.ip)) : null

  );



const left = h('span', { class: 'left' });

const drain = h('b');

const acts = h('div', { class: 'acts' });

const el = h(

    'li',

    { class: 'row', 'data-id': f.id },

    h('label', { class: 'pick' }, box, h('span', { class: 'ext', 'data-g': g }, h('span', {}, extOf(f.name)), icon('check'))),

    h('div', { class: 'what' }, nameEl, facts),

    left,

    acts,

    h('i', { class: 'drain', 'aria-hidden': 'true' }, drain)

  );

  if (selected) el.setAttribute('data-selected', '');



const ref = { el, left, drain, file: f, acts };

  rowRefs.set(f.id, ref);

  paintActs(ref);

  paintClock(ref);

  return el;

}



function paintActs(ref) {

const f = ref.file;

const dl = `/api/admin/files/${encodeURIComponent(f.id)}/download`;

  ref.acts.replaceChildren(

    ...[

    h('a', { class: 'icon-btn', href: dl, download: '', 'aria-label': `Download ${f.name}`, title: 'Download' }, icon('download')),

    f.kind === 'out' && f.token

      ? h('button', { class: 'icon-btn', type: 'button', 'aria-label': `Copy link for ${f.name}`, title: 'Copy link', onclick: () => copyText(`${location.origin}/d/${f.token}`, 'Link copied.') }, icon('link'))

      : null,

    h('button', { class: 'icon-btn', type: 'button', 'aria-label': `Delete ${f.name}`, title: 'Delete', onclick: () => askDelete(ref) }, icon('trash'))

    ].filter(Boolean)

  );

}



function askDelete(ref) {

const f = ref.file;

const back = setTimeout(() => paintActs(ref), 5000);

const yes = h('button', { class: 'btn btn--ink', type: 'button', onclick: () => { clearTimeout(back); removeFiles([f.id]); } }, 'Delete');

  ref.acts.replaceChildren(

    h('span', { class: 'confirm-text' }, 'Delete now?'),

    yes,

    h('button', { class: 'btn btn--line', type: 'button', onclick: () => { clearTimeout(back); paintActs(ref); } }, 'Keep')

  );

  yes.focus();

}



function paintClock(ref) {

const f = ref.file;

const left = f.expiresAt - nowMs();

const total = state.ttlHours * 3600e3;

  ref.left.textContent = left > 0 ? `${fmtLeft(left)} left` : 'Expired';

  ref.drain.style.setProperty('--p', Math.max(0, Math.min(1, left / total)));

  if (left < 2 * 3600e3) ref.el.setAttribute('data-urgent', '');

  else ref.el.removeAttribute('data-urgent');

}



setInterval(() => {

  if (document.body.dataset.view !== 'app') return;

let expired = false;

  for (const ref of rowRefs.values()) {

    paintClock(ref);

    if (ref.file.expiresAt <= nowMs()) expired = true;

  }

  if (expired) refresh({ force: true }).catch(() => {});

}, 20 * 1000);



function renderEmpty(shown) {

const box = $('#empty');

  box.hidden = shown > 0;

  if (shown > 0) return;

const filtered = state.q.trim() || state.group !== 'all';

  if (filtered && state.files.length) {

    box.replaceChildren(

      h('h2', {}, 'No matches.'),

      h('p', {}, 'Try a different search or file type.'),

      h('button', { class: 'btn btn--line', type: 'button', onclick: () => { state.q = ''; state.group = 'all'; $('#search').value = ''; renderList(); } }, 'Clear filters')

    );

  } else if (state.kind === 'in') {

    box.replaceChildren(

      h('h2', {}, 'Nothing received yet.'),

      h('p', {}, 'Files your clients drop on the client page show up here within a few seconds.'),

      h('button', { class: 'btn btn--blue', type: 'button', onclick: copyDropLink }, icon('copy'), 'Copy the client page link')

    );

  } else {

    box.replaceChildren(

      h('h2', {}, 'Nothing sent out.'),

      h('p', {}, `Upload a file and give the client its link. It is deleted after ${fmtHours(state.ttlHours)}.`),

      h('button', { class: 'btn btn--blue', type: 'button', onclick: openSender }, icon('plus'), 'Send a file to a client')

    );

  }

}



// ---- selection + bulk ----------------------------------------------------------------------------------------

function select(id, on) {

  if (on) state.selected.add(id);

  else state.selected.delete(id);

const ref = rowRefs.get(id);

  if (ref) {

    if (on) ref.el.setAttribute('data-selected', '');

    else ref.el.removeAttribute('data-selected');

  }

  renderBulk();

}



$('#select-all').addEventListener('click', () => {

const shown = visibleFiles();

const all = shown.every((f) => state.selected.has(f.id));

  shown.forEach((f) => (all ? state.selected.delete(f.id) : state.selected.add(f.id)));

  renderList();

});



let bulkConfirm = null;

function renderBulk() {

const n = state.selected.size;

const bar = $('#bulk');

  bar.hidden = n === 0;

  clearTimeout(bulkConfirm);

  $('#bulk-del').textContent = 'Delete';

  $('#bulk-del').classList.remove('btn--lemon');

  if (!n) return;

  $('#bulk-n').textContent = n === 1 ? '1 file selected' : `${n} files selected`;

const zip = $('#bulk-zip');

  if (n > ZIP_MAX) {

    zip.removeAttribute('href');

    zip.setAttribute('aria-disabled', 'true');

    zip.classList.add('is-off');

    zip.textContent = `Zip: up to ${ZIP_MAX}`;

  } else {

    zip.href = `/api/admin/zip?ids=${Array.from(state.selected).map(encodeURIComponent).join(',')}`;

    zip.removeAttribute('aria-disabled');

    zip.classList.remove('is-off');

    zip.textContent = 'Download zip';

  }

}



$('#bulk-zip').addEventListener('click', (e) => {

  if (e.currentTarget.getAttribute('aria-disabled') === 'true') e.preventDefault();

});

$('#bulk-clear').addEventListener('click', () => {

  state.selected.clear();

  renderList();

});

$('#bulk-del').addEventListener('click', (e) => {

const btn = e.currentTarget;

const n = state.selected.size;

  if (btn.dataset.armed) {

    delete btn.dataset.armed;

    removeFiles(Array.from(state.selected));

    return;

  }

  btn.dataset.armed = '1';

  btn.textContent = `Yes, delete ${n}`;

  btn.classList.add('btn--lemon');

  bulkConfirm = setTimeout(() => {

    delete btn.dataset.armed;

    btn.textContent = 'Delete';

    btn.classList.remove('btn--lemon');

  }, 4000);

});



async function removeFiles(ids) {

  try {

    await api('/api/admin/delete', { method: 'POST', body: { ids } });

    ids.forEach((id) => state.selected.delete(id));

    toast(ids.length === 1 ? 'File deleted.' : `${ids.length} files deleted.`);

    await refresh({ force: true });

  } catch (err) {

    if (err.message !== 'signed-out') toast(err.message);

  }

}



// ---- controls -------------------------------------------------------------------------------------------------------

for (const tab of document.querySelectorAll('.tab')) {

  tab.addEventListener('click', () => {

    if (state.kind === tab.dataset.kind) return;

    state.kind = tab.dataset.kind;

    state.selected.clear();

    state.group = 'all';

    state.sig = '';

    refresh({ force: true }).catch(() => {});

  });

}



let searchTimer;

$('#search').addEventListener('input', (e) => {

  clearTimeout(searchTimer);

  searchTimer = setTimeout(() => {

    state.q = e.target.value;

    renderList();

  }, 120);

});

$('#sort').addEventListener('change', (e) => {

  state.sort = e.target.value;

  renderList();

});



document.addEventListener('visibilitychange', () => {

  if (document.visibilityState === 'visible' && document.body.dataset.view === 'app') refresh().catch(() => {});

});



// ---- clipboard + toast ------------------------------------------------------------------------------------------------

async function copyText(text, done) {

  try {

    await navigator.clipboard.writeText(text);

  } catch {

const t = h('textarea', { readonly: true });

    t.style.position = 'fixed';

    t.style.opacity = '0';

    t.value = text;

    document.body.append(t);

    t.select();

    try {

      document.execCommand('copy');

    } catch {}

    t.remove();

  }

  toast(done);

}



function copyDropLink() {

  copyText(`${location.origin}/`, 'Client page link copied.');

}

$('#copy-drop').addEventListener('click', copyDropLink);



let toastTimer;

function toast(msg) {

const t = $('#toast');

  t.textContent = msg;

  t.hidden = false;

  clearTimeout(toastTimer);

  toastTimer = setTimeout(() => (t.hidden = true), 2800);

}



// ---- preview ---------------------------------------------------------------------------------------------------------------

const viewer = $('#viewer');

$('#viewer-close').append(icon('close'));

$('#viewer-close').addEventListener('click', () => viewer.close());

viewer.addEventListener('close', () => $('#viewer-body').replaceChildren());

viewer.addEventListener('click', (e) => {

  if (e.target === viewer) viewer.close();

});



function openViewer(f) {

const src = `/api/admin/files/${encodeURIComponent(f.id)}/preview`;

  if (f.mime === 'application/pdf') {

    window\.open(src, '_blank', 'noopener');

    return;

  }

  $('#viewer-title').textContent = f.name;

  $('#viewer-dl').href = `/api/admin/files/${encodeURIComponent(f.id)}/download`;

const body = $('#viewer-body');

  if (f.mime.startsWith('image/')) body.replaceChildren(h('img', { src, alt: f.name }));

  else if (f.mime.startsWith('video/')) body.replaceChildren(h('video', { src, controls: true, preload: 'metadata', playsinline: true }));

  else body.replaceChildren(h('audio', { src, controls: true, preload: 'metadata' }));

  viewer.showModal();

}



// ---- send a file to a client -------------------------------------------------------------------------------------------------

const sender = $('#sender');

const sPick = $('#sender-pick');

const sProg = $('#sender-progress');

const sDone = $('#sender-done');

const sErr = $('#sender-error');

const sFile = $('#sender-file');



$('#open-send').append(icon('plus'), 'Send a file to a client');

$('#open-send').addEventListener('click', openSender);



function openSender() {

  sPick.hidden = false;

  sProg.hidden = true;

  sDone.hidden = true;

  sErr.hidden = true;

  sFile.value = '';

  if (!sender.open) sender.showModal();

}



$('#sender-choose').addEventListener('click', () => sFile.click());

sFile.addEventListener('change', () => sFile.files[0] && sendOut(sFile.files[0]));



const choose = $('#sender-choose');

choose.addEventListener('dragover', (e) => {

  e.preventDefault();

  choose.setAttribute('data-over', '');

});

choose.addEventListener('dragleave', () => choose.removeAttribute('data-over'));

choose.addEventListener('drop', (e) => {

  e.preventDefault();

  choose.removeAttribute('data-over');

  if (e.dataTransfer.files[0]) sendOut(e.dataTransfer.files[0]);

});



function sendOut(file) {

  sErr.hidden = true;

  if (file.size === 0) return fail('That file is empty. If it is a folder, zip it first.');

  if (file.size > state.maxFileBytes) return fail(`Too large. The limit is ${fmtBytes(state.maxFileBytes)} per file.`);



  sPick.hidden = true;

  sProg.hidden = false;

  $('#sender-name').textContent = file.name;

  $('#sender-bar').style.setProperty('--p', 0);

  $('#sender-status').textContent = 'Uploading 0%';



const fd = new FormData();

  fd.append('file', file, file.name);

const xhr = new XMLHttpRequest();

  xhr.open('POST', '/api/admin/outbound');

  xhr.setRequestHeader('X-Requested-With', 'slot');

  xhr.responseType = 'json';

  xhr.upload.onprogress = (e) => {

    if (!e.lengthComputable) return;

    $('#sender-bar').style.setProperty('--p', e.loaded / e.total);

    $('#sender-status').textContent = `Uploading ${Math.round((e.loaded / e.total) * 100)}%`;

  };

  xhr.onload = () => {

const body = xhr.response || {};

    if (xhr.status === 401) {

      sender.close();

      return window.location.replace('/auth/login');

    }

    if (xhr.status !== 201) return fail(body.error || 'The upload failed. Try again.');

    sProg.hidden = true;

    sDone.hidden = false;

const input = $('#sender-link');

    input.value = `${location.origin}/d/${body.token}`;

    input.focus();

    input.select();

    refresh({ force: true }).catch(() => {});

  };

  xhr.onerror = () => fail('Lost the connection. Check your network and try again.');

  xhr.send(fd);

}



function fail(msg) {

  sPick.hidden = false;

  sProg.hidden = true;

  sErr.hidden = false;

  sErr.textContent = msg;

}



$('#sender-copy').addEventListener('click', () => copyText($('#sender-link').value, 'Link copied.'));



boot();