const crypto = require('node:crypto');

const fs = require('node:fs');

const path = require('node:path');

const express = require('express');

const busboy = require('busboy');

const { ZipArchive } = require('archiver');



const config = require('./config');

const { q, listFiles, countByKind, FILES_DIR } = require('./db');

const auth = require('./auth');



const TTL_MS = config.ttlHours * 3600 * 1000;

const PUBLIC_DIR = path.join(__dirname, 'public');

const COOKIE = 'slot_sid';



const app = express();

app.disable('x-powered-by');

if (config.trustProxy) app.set('trust proxy', config.trustProxy);



// ---------------------------------------------------------------------------------------------

// Security headers

// ---------------------------------------------------------------------------------------------

app.use((req, res, next) => {

res.setHeader('X-Content-Type-Options', 'nosniff');

res.setHeader('Referrer-Policy', 'no-referrer');

res.setHeader('X-Frame-Options', 'DENY');

res.setHeader(

    'Content-Security-Policy',

    "default-src 'self'; img-src 'self' blob: data:; media-src 'self' blob:; object-src 'none'; base-uri 'none'; frame-ancestors 'none'; form-action 'self'"

  );

  next();

});



// ---------------------------------------------------------------------------------------------

// Helpers

// ---------------------------------------------------------------------------------------------

const filePath = (id) => path.join(FILES_DIR, id);

const sha = (v) => crypto.createHash('sha256').update(v).digest('hex');

const usedBytes = () => q.usedBytes.get(Date.now()).n;



function cleanName(raw) {

let n = String(raw || 'file').replace(/\\/g, '/').split('/').pop();

  n = n.replace(/[\u0000-\u001f\u007f<>:"|?*]/g, '_').trim();

  if (!n || n === '.' || n === '..') n = 'file';

  if (n.length > 200) {

const ext = path.extname(n).slice(0, 20);

    n = n.slice(0, 200 - ext.length) + ext;

  }

  return n;

}



function cleanMime(raw) {

const m = String(raw || '').toLowerCase().trim();

  return /^[a-z0-9.+-]+\/[a-z0-9.+-]+$/.test(m) && m.length <= 100 ? m : 'application/octet-stream';

}



const publicRow = (r) => ({

  id: r.id,

  name: r.name,

  size: r.size,

  mime: r.mime,

  kind: r.kind,

  sender: r.sender,

  ip: r.ip,

  uploadedBy: r.uploaded_by,

  token: r.token,

  createdAt: r.created_at,

  expiresAt: r.expires_at,

});



// Per-IP rate limit for anonymous uploads (in memory is fine for a single instance).

const hits = new Map();

function uploadLimiter(req, res, next) {

const now = Date.now();

const arr = (hits.get(req.ip) || []).filter((t) => now - t < 3600e3);

  if (arr.length >= config.uploadsPerHour) {

    return res.status(429).json({ error: 'Too many uploads from this network. Try again in a while.' });

  }

  arr.push(now);

  hits.set(req.ip, arr);

  next();

}



// Mutating admin calls must carry this header; combined with SameSite=Strict it blocks CSRF.

function csrf(req, res, next) {

  if (req.get('x-requested-with') !== 'slot') return res.status(403).json({ error: 'Request blocked.' });

  next();

}



function readCookie(req, name) {

const raw = req.headers.cookie || '';

  for (const part of raw.split(';')) {

const i = part.indexOf('=');

    if (i > 0 && part.slice(0, i).trim() === name) return decodeURIComponent(part.slice(i + 1).trim());

  }

  return null;

}



function currentAdminSession(req) {
  const sid = readCookie(req, COOKIE);
  return sid && q.getSession.get(sha(sid), Date.now());
}

function requireAdmin(req, res, next) {
  const s = currentAdminSession(req);
  if (!s) return res.status(401).json({ error: 'Sign in required.' });
  req.user = { username: s.username };
  next();
}

function requireAdminPage(req, res, next) {
  const s = currentAdminSession(req);
  if (!s) return res.redirect(302, '/auth/login');
  req.user = { username: s.username };
  next();
}

// ---------------------------------------------------------------------------------------------

// Upload (shared by anonymous clients and admin outbound)

// ---------------------------------------------------------------------------------------------

function handleUpload(req, res, { kind, uploadedBy = '' }) {

  if (!/^multipart\/form-data/i.test(req.headers['content-type'] || '')) {

    return res.status(415).json({ error: 'Upload as multipart/form-data.' });

  }

const declared = Number(req.headers['content-length'] || 0);

  if (declared > config.maxFileBytes + 1024 * 1024) {

    return res.status(413).json({ error: `File is larger than the ${fmtBytes(config.maxFileBytes)} limit.` });

  }

  if (usedBytes() + declared > config.maxTotalBytes) {

    return res.status(507).json({ error: 'Storage is full right now. Files free up as they expire.' });

  }



let sender = '';

let info = null;

let finished = false;

let bb;



const cleanup = () => {

    if (info) {

      info.out.destroy();

      fs.rm(info.tmp, { force: true }, () => {});

    }

  };

const fail = (status, error) => {

    if (finished) return;

    finished = true;

    cleanup();

    if (!res.headersSent) res.status(status).json({ error });

    req.unpipe(bb);

    req.resume();

  };



  try {

    bb = busboy({

      headers: req.headers,

      defParamCharset: 'utf8',

      limits: { fileSize: config.maxFileBytes, files: 1, fields: 6, fieldSize: 2000, parts: 8 },

    });

  } catch {

    return res.status(400).json({ error: 'Malformed upload.' });

  }



  bb.on('field', (name, val) => {

    if (name === 'sender') sender = String(val).replace(/[\u0000-\u001f]/g, ' ').trim().slice(0, 200);

  });



  bb.on('file', (_field, stream, meta) => {

const id = crypto.randomUUID();

const tmp = filePath(id + '.part');

const out = fs.createWriteStream(tmp, { flags: 'wx', mode: 0o600 });

    info = {

      id,

      tmp,

      out,

      name: cleanName(meta.filename),

      mime: cleanMime(meta.mimeType),

      size: 0,

      truncated: false,

      written: new Promise((resolve, reject) => {

        out.on('finish', resolve);

        out.on('error', reject);

      }),

    };

    info.written.catch(() => fail(500, 'Could not save the file. Try again.'));

    stream.on('data', (c) => (info.size += c.length));

    stream.on('limit', () => {

      info.truncated = true;

      fail(413, `File is larger than the ${fmtBytes(config.maxFileBytes)} limit.`);

    });

    stream.pipe(out);

  });



  bb.on('error', () => fail(400, 'Upload was interrupted.'));



  bb.on('close', async () => {

    if (finished) return;

    if (!info) return fail(400, 'No file received.');

    try {

      await info.written;

      if (info.size === 0) return fail(400, 'That file is empty.');

      fs.renameSync(info.tmp, filePath(info.id));

const now = Date.now();

const token = kind === 'out' ? crypto.randomBytes(18).toString('base64url') : null;

      q.insertFile.run(info.id, info.name, info.size, info.mime, kind, sender, kind === 'in' ? req.ip || '' : '', uploadedBy, token, now, now + TTL_MS);

      finished = true;

      res.status(201).json({ id: info.id, name: info.name, size: info.size, expiresAt: now + TTL_MS, token });

    } catch {

      fail(500, 'Could not save the file. Try again.');

    }

  });



  // If the client goes away mid-upload, throw the partial file away.

  res.on('close', () => {

    if (!finished) {

      finished = true;

      cleanup();

    }

  });



  req.pipe(bb);

}



function fmtBytes(n) {

const u = ['B', 'KB', 'MB', 'GB', 'TB'];

let i = 0;

  while (n >= 1024 && i < u.length - 1) {

    n /= 1024;

    i++;

  }

  return `${n >= 10 || i === 0 ? Math.round(n) : n.toFixed(1)} ${u[i]}`;

}



// ---------------------------------------------------------------------------------------------

// Public API

// ---------------------------------------------------------------------------------------------

app.get('/api/config', (req, res) => {

  res.json({ ttlHours: config.ttlHours, maxFileBytes: config.maxFileBytes });

});



app.post('/api/upload', uploadLimiter, (req, res) => handleUpload(req, res, { kind: 'in' }));



// Public download page for admin -> client transfers (unguessable token).

app.get('/api/d/:token', (req, res) => {

const r = q.getByToken.get(req.params.token, Date.now());

  if (!r) return res.status(404).json({ error: 'This link has expired or does not exist.' });

  res.json({ name: r.name, size: r.size, mime: r.mime, createdAt: r.created_at, expiresAt: r.expires_at });

});



app.get('/api/d/:token/file', (req, res) => {

const r = q.getByToken.get(req.params.token, Date.now());

  if (!r || !fs.existsSync(filePath(r.id))) return res.status(404).send('This link has expired or does not exist.');

  res.type('application/octet-stream');

  res.download(filePath(r.id), r.name);

});



// ---------------------------------------------------------------------------------------------

// NaCl Auth (OIDC)

app.get('/auth/login', async (req, res) => {
  // Avoid another provider round-trip when this browser already has a Slot session.
  if (currentAdminSession(req)) return res.redirect(302, '/admin');
  try {
    await auth.beginLogin(req, res);
  } catch (err) {
    console.error('[auth] OIDC login start failed:', err.message);
    auth.clearBrowserCookie(res);
    res.status(503).type('text').send('NaCl Auth is unavailable. Please try again later.');
  }
});

app.get('/auth/callback', async (req, res) => {
  try {
    const user = await auth.completeLogin(req);
    const sid = crypto.randomBytes(32).toString('base64url');
    const expires = Date.now() + config.sessionHours * 3600e3;

    q.insertSession.run(sha(sid), user.username, expires);
    res.cookie(COOKIE, sid, {
      httpOnly: true,
      sameSite: 'strict',
      secure: config.cookieSecure,
      maxAge: config.sessionHours * 3600e3,
      path: '/',
    });

    auth.clearBrowserCookie(res);
    return res.redirect(302, '/admin');
  } catch (err) {
    console.error('[auth] OIDC callback failed:', err.message);
    auth.clearBrowserCookie(res);
    return res.status(401).type('html').send(
      '<!doctype html><html lang="en"><meta charset="utf-8"><title>NaCl Auth sign-in failed</title>' +
      '<body><h1>Sign-in failed</h1><p>We could not verify your NaCl Auth session.</p>' +
      '<p><a href="/auth/login">Try signing in again</a></p></body></html>'
    );
  }
});

// Admin API

// ---------------------------------------------------------------------------------------------

app.post('/api/admin/logout', csrf, (req, res) => {

const sid = readCookie(req, COOKIE);

  if (sid) q.deleteSession.run(sha(sid));

  res.clearCookie(COOKIE, { path: '/' });

  res.json({ ok: true });

});



app.get('/api/admin/me', requireAdmin, (req, res) => res.json({ username: req.user.username }));



app.get('/api/admin/files', requireAdmin, (req, res) => {

const now = Date.now();

const kind = req.query.kind === 'out' ? 'out' : req.query.kind === 'in' ? 'in' : '';

const search = String(req.query.q || '').slice(0, 100);

  res.json({

    files: listFiles({ kind, search, now }).map(publicRow),

    counts: countByKind(now),

    storage: { used: usedBytes(), cap: config.maxTotalBytes },

    ttlHours: config.ttlHours,

    maxFileBytes: config.maxFileBytes,

    now,

  });

});



const INLINE_OK = /^(image\/(png|jpe?g|gif|webp|avif|bmp)|video\/(mp4|webm|ogg|quicktime)|audio\/(mpeg|mp3|ogg|wav|webm|aac|mp4|x-m4a)|application\/pdf)$/;



app.get('/api/admin/files/:id/preview', requireAdmin, (req, res) => {

const r = q.getFile.get(req.params.id, Date.now());

  if (!r || !fs.existsSync(filePath(r.id))) return res.status(404).send('Gone.');

  if (!INLINE_OK.test(r.mime)) return res.status(415).send('No preview for this type.');

  // The sandbox directive breaks the browser's built-in PDF viewer, so PDFs get a locked-down CSP without it.

  res.setHeader('Content-Security-Policy', r.mime === 'application/pdf' ? "default-src 'none'" : "default-src 'none'; sandbox");

  res.setHeader('Content-Disposition', 'inline');

  res.type(r.mime);

  res.sendFile(filePath(r.id), { headers: { 'Content-Type': r.mime, 'Cache-Control': 'private, max-age=60' } });

});



app.get('/api/admin/files/:id/download', requireAdmin, (req, res) => {

const r = q.getFile.get(req.params.id, Date.now());

  if (!r || !fs.existsSync(filePath(r.id))) return res.status(404).send('This file has expired.');

  res.type('application/octet-stream');

  res.download(filePath(r.id), r.name);

});



app.get('/api/admin/zip', requireAdmin, (req, res) => {

const ids = String(req.query.ids || '').split(',').filter(Boolean).slice(0, 500);

const rows = ids.map((id) => q.getFile.get(id, Date.now())).filter((r) => r && fs.existsSync(filePath(r.id)));

  if (!rows.length) return res.status(404).send('Nothing to download.');

const stamp = new Date().toISOString().slice(0, 16).replace(/[:T]/g, '-');

  res.attachment(`slot-${stamp}.zip`);

const zip = new ZipArchive({ store: true });

  zip.on('error', () => res.destroy());

  res.on('close', () => zip.abort());

  zip.pipe(res);

const used = new Set();

  for (const r of rows) {

let name = r.name;

    for (let i = 2; used.has(name.toLowerCase()); i++) {

const ext = path.extname(r.name);

      name = `${path.basename(r.name, ext)} (${i})${ext}`;

    }

    used.add(name.toLowerCase());

    zip.file(filePath(r.id), { name });

  }

  zip.finalize();

});



function removeFile(id) {

  q.deleteFile.run(id);

  fs.rm(filePath(id), { force: true }, () => {});

}



app.post('/api/admin/delete', requireAdmin, csrf, express.json({ limit: '64kb' }), (req, res) => {

const ids = Array.isArray(req.body?.ids) ? req.body.ids.filter((x) => typeof x === 'string').slice(0, 500) : [];

  ids.forEach(removeFile);

  res.json({ deleted: ids.length });

});



app.post('/api/admin/outbound', requireAdmin, csrf, (req, res) =>

  handleUpload(req, res, { kind: 'out', uploadedBy: req.user.username })

);



// ---------------------------------------------------------------------------------------------

// Pages

// ---------------------------------------------------------------------------------------------

app.get(['/admin', '/admin.html'], requireAdminPage, (req, res) =>
  res.sendFile(path.join(PUBLIC_DIR, 'admin.html'))
);

app.get('/d/:token', (req, res) => res.sendFile(path.join(PUBLIC_DIR, 'download.html')));

app.use(express.static(PUBLIC_DIR, { maxAge: '1h', index: 'index.html' }));



app.use((req, res) => {

  if (req.path.startsWith('/api/')) return res.status(404).json({ error: 'Not found.' });

  res.status(404).sendFile(path.join(PUBLIC_DIR, 'index.html'));

});



// ---------------------------------------------------------------------------------------------

// 24-hour cleanup

// ---------------------------------------------------------------------------------------------

function sweep() {

const now = Date.now();

let removed = 0;

  for (const { id } of q.expired.all(now)) {

    removeFile(id);

    removed++;

  }

  q.purgeSessions.run(now);

  // abandoned partial uploads older than 6 hours

  for (const f of fs.readdirSync(FILES_DIR)) {

    if (!f.endsWith('.part')) continue;

    try {

      if (now - fs.statSync(path.join(FILES_DIR, f)).mtimeMs > 6 * 3600e3) fs.rmSync(path.join(FILES_DIR, f), { force: true });

    } catch {}

  }

  if (removed) console.log(`[sweep] removed ${removed} expired file(s)`);

}



// On boot: drop disk files that have no database row, and rows whose file is missing.

function reconcile() {

const known = new Set(q.allIds.all().map((r) => r.id));

  for (const f of fs.readdirSync(FILES_DIR)) {

    if (f.endsWith('.part')) continue;

    if (!known.has(f)) fs.rmSync(path.join(FILES_DIR, f), { force: true });

  }

  for (const id of known) if (!fs.existsSync(filePath(id))) q.deleteFile.run(id);

}



reconcile();

sweep();

setInterval(sweep, 60 * 1000).unref();



if (require.main === module) {

  app.listen(config.port, () => {

    console.log(`Slot is running on http://localhost:${config.port}  (files expire after ${config.ttlHours}h, admin auth: OIDC)`);

  });

}



module.exports = { app, sweep };