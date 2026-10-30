
'use strict';

const path = require('node:path');

const num = (value, fallback) => (
  value !== undefined && value !== '' && !Number.isNaN(Number(value))
    ? Number(value)
    : fallback
);

const GB = 1024 ** 3;

module.exports = {
  // Server
  port: num(process.env.PORT, 8080),
  dataDir: path.resolve(
    process.env.DATA_DIR || path.join(__dirname, 'data')
  ),

  // File expiration
  ttlHours: num(process.env.TTL_HOURS, 24),

  // Storage limits
  maxFileBytes: Math.floor(
    num(process.env.MAX_FILE_GB, 1) * GB
  ),
  maxTotalBytes: Math.floor(
    num(process.env.MAX_TOTAL_GB, 50) * GB
  ),

  // Anonymous upload limits
  uploadsPerHour: num(
    process.env.UPLOADS_PER_HOUR,
    120
  ),

  // Reverse Proxy
  trustProxy: process.env.TRUST_PROXY
    ? num(process.env.TRUST_PROXY, 1)
    : false,

  // NaCl Auth (OIDC) Session
  sessionHours: num(
    process.env.SESSION_HOURS,
    12
  ),

  // Cookie Security
  cookieSecure: process.env.COOKIE_SECURE === 'true',
};
