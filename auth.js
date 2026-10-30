/**
 * Admin authentication providers.
 *
 * Each provider is `async (username, password) => { username, displayName } | null`.
 * Return null for bad credentials. Throw for infrastructure problems (LDAP down, bad config).
 *
 *   ADMIN_AUTH=dev   -> one local account from ADMIN_DEV_USER / ADMIN_DEV_PASSWORD (for building the UI only)
 *   ADMIN_AUTH=ldap  -> Authentik LDAP outpost (search + bind). Fill in the LDAP_* variables.
 */
const crypto = require('node:crypto');
const config = require('./config');

function safeEqual(a, b) {
  const ha = crypto.createHash('sha256').update(String(a)).digest();
  const hb = crypto.createHash('sha256').update(String(b)).digest();
  return crypto.timingSafeEqual(ha, hb);
}

// ---- dev provider -------------------------------------------------------------------------
const devUser = process.env.ADMIN_DEV_USER || 'admin';
const devPass = process.env.ADMIN_DEV_PASSWORD || crypto.randomBytes(9).toString('base64url');

async function devAuth(username, password) {
  const okUser = safeEqual(username, devUser);
  const okPass = safeEqual(password, devPass);
  return okUser && okPass ? { username: devUser, displayName: 'Dev admin' } : null;
}

// ---- LDAP provider (Authentik outpost) -----------------------------------------------------
// RFC 4515 escaping so a username can never change the meaning of the search filter.
function escapeFilterValue(v) {
  return String(v).replace(/[\\*()\0]/g, (c) => '\\' + c.charCodeAt(0).toString(16).padStart(2, '0'));
}

async function ldapAuth(username, password) {
  const L = config.ldap;
  if (!L.url || !L.baseDn || !L.bindDn) {
    const e = new Error('LDAP is not configured');
    e.code = 'AUTH_NOT_CONFIGURED';
    throw e;
  }
  const { Client } = require('ldapts');
  const make = () =>
    new Client({
      url: L.url,
      timeout: 8000,
      connectTimeout: 8000,
      tlsOptions: { rejectUnauthorized: L.rejectUnauthorized },
    });

  // 1) service account looks the user up
  const search = make();
  let entry;
  try {
    await search.bind(L.bindDn, L.bindPassword);
    const filter = L.userFilter.replace('{username}', escapeFilterValue(username));
    const { searchEntries } = await search.search(L.baseDn, {
      scope: 'sub',
      filter,
      attributes: ['dn', 'cn', 'uid', 'displayName', 'name', 'memberOf'],
      sizeLimit: 2,
    });
    if (searchEntries.length !== 1) return null;
    entry = searchEntries[0];
  } finally {
    await search.unbind().catch(() => {});
  }

  // 2) optional group gate
  if (L.requiredGroupDn) {
    const groups = [].concat(entry.memberOf || []).map((g) => String(g).toLowerCase());
    if (!groups.includes(L.requiredGroupDn.toLowerCase())) return null;
  }

  // 3) the user proves their password by binding as themselves
  const userClient = make();
  try {
    await userClient.bind(entry.dn, password);
  } catch (err) {
    if (err && (err.code === 49 || /InvalidCredentials/i.test(err.name || ''))) return null;
    throw err;
  } finally {
    await userClient.unbind().catch(() => {});
  }

  const first = (v) => (Array.isArray(v) ? v[0] : v);
  return {
    username: String(first(entry.uid) || first(entry.cn) || username),
    displayName: String(first(entry.displayName) || first(entry.name) || first(entry.cn) || username),
  };
}

const provider = config.authMode === 'dev' ? devAuth : ldapAuth;

if (config.authMode === 'dev') {
  console.warn('\n  [auth] ADMIN_AUTH=dev is on. Do not use this in production.');
  console.warn(`  [auth] Sign in at /admin with  ${devUser} / ${devPass}\n`);
}

module.exports = { authenticate: provider, mode: config.authMode };
