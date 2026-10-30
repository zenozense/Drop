const path = require('node:path');

const num = (v, d) => (v !== undefined && v !== '' && !Number.isNaN(Number(v)) ? Number(v) : d);
const GB = 1024 ** 3;

module.exports = {
  port: num(process.env.PORT, 3000),
  dataDir: path.resolve(process.env.DATA_DIR || path.join(__dirname, 'data')),

  // How long a file lives after upload. Spec: 24 hours.
  ttlHours: num(process.env.TTL_HOURS, 24),

  // Per-file cap and total storage cap (bytes).
  maxFileBytes: Math.floor(num(process.env.MAX_FILE_GB, 1) * GB),
  maxTotalBytes: Math.floor(num(process.env.MAX_TOTAL_GB, 50) * GB),

  // Anonymous upload limits, per client IP.
  uploadsPerHour: num(process.env.UPLOADS_PER_HOUR, 120),

  // Set to the number of reverse proxies in front of the app (e.g. 1 for Traefik/nginx).
  trustProxy: process.env.TRUST_PROXY ? num(process.env.TRUST_PROXY, 1) : false,

  // Admin sign-in
  authMode: (process.env.ADMIN_AUTH || 'ldap').toLowerCase(), // 'ldap' | 'dev'
  sessionHours: num(process.env.SESSION_HOURS, 12),
  cookieSecure: process.env.COOKIE_SECURE === 'true',

  ldap: {
    url: process.env.LDAP_URL || '',
    bindDn: process.env.LDAP_BIND_DN || '',
    bindPassword: process.env.LDAP_BIND_PASSWORD || '',
    baseDn: process.env.LDAP_BASE_DN || '',
    userFilter: process.env.LDAP_USER_FILTER || '(&(objectClass=user)(cn={username}))',
    requiredGroupDn: process.env.LDAP_REQUIRED_GROUP_DN || '',
    rejectUnauthorized: process.env.LDAP_TLS_REJECT_UNAUTHORIZED !== 'false',
  },
};
