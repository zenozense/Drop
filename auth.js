'use strict';

const crypto = require('node:crypto');
const config = require('./config');

const FLOW_COOKIE = 'slot_oidc_browser';
const FLOW_TTL_MS = 10 * 60 * 1000;
const pendingFlows = new Map();

let oidcPromise;

function requiredEnv(name) {
  const value = process.env[name];
  if (!value || !value.trim()) {
    const error = new Error(`${name} is not configured`);
    error.code = 'OIDC_NOT_CONFIGURED';
    throw error;
  }
  return value.trim();
}

function getOidcSettings() {
  const issuer = requiredEnv('OIDC_ISSUER');
  const clientId = requiredEnv('OIDC_CLIENT_ID');
  const clientSecret = requiredEnv('OIDC_CLIENT_SECRET');
  const redirectUri = requiredEnv('OIDC_REDIRECT_URI');
  const scopes = (process.env.OIDC_SCOPES || 'openid profile email')
    .split(/\s+/)
    .filter(Boolean);

  if (!scopes.includes('openid')) scopes.unshift('openid');

  const issuerUrl = new URL(issuer);
  const redirectUrl = new URL(redirectUri);

  if (issuerUrl.protocol !== 'https:') {
    throw new Error('OIDC_ISSUER must use HTTPS.');
  }
  if (redirectUrl.protocol !== 'https:' && !['localhost', '127.0.0.1'].includes(redirectUrl.hostname)) {
    throw new Error('OIDC_REDIRECT_URI must use HTTPS outside localhost.');
  }
  if (redirectUrl.search || redirectUrl.hash) {
    throw new Error('OIDC_REDIRECT_URI must not contain a query string or fragment.');
  }

  return { issuerUrl, clientId, clientSecret, redirectUri, scopes: scopes.join(' ') };
}

async function getOidc() {
  if (!oidcPromise) {
    oidcPromise = (async () => {
      const settings = getOidcSettings();
      // openid-client v6 is ESM; dynamic import keeps this project CommonJS.
      const oidc = await import('openid-client');
      const clientConfig = await oidc.discovery(
        settings.issuerUrl,
        settings.clientId,
        settings.clientSecret,
      );
      return { oidc, clientConfig, settings };
    })().catch((error) => {
      // Allow discovery/configuration to be retried after a temporary outage.
      oidcPromise = null;
      throw error;
    });
  }
  return oidcPromise;
}

function readCookie(req, name) {
  const raw = req.headers.cookie || '';
  for (const part of raw.split(';')) {
    const i = part.indexOf('=');
    if (i > 0 && part.slice(0, i).trim() === name) {
      try {
        return decodeURIComponent(part.slice(i + 1).trim());
      } catch {
        return null;
      }
    }
  }
  return null;
}

function cookieOptions(maxAge) {
  return {
    httpOnly: true,
    secure: Boolean(config.cookieSecure),
    sameSite: 'lax',
    maxAge,
    path: '/auth/callback',
  };
}

function clearBrowserCookie(res) {
  res.clearCookie(FLOW_COOKIE, {
    httpOnly: true,
    secure: Boolean(config.cookieSecure),
    sameSite: 'lax',
    path: '/auth/callback',
  });
}

function pruneFlows() {
  const now = Date.now();
  for (const [state, flow] of pendingFlows) {
    if (flow.expiresAt <= now) pendingFlows.delete(state);
  }
}

function sameSecret(a, b) {
  if (typeof a !== 'string' || typeof b !== 'string') return false;
  const aa = Buffer.from(a);
  const bb = Buffer.from(b);
  return aa.length === bb.length && crypto.timingSafeEqual(aa, bb);
}

function cleanText(value, max = 128) {
  return String(value || '').replace(/[\u0000-\u001f\u007f]/g, ' ').trim().slice(0, max);
}

async function beginLogin(req, res) {
  const { oidc, clientConfig, settings } = await getOidc();
  pruneFlows();

  let browserBinding = readCookie(req, FLOW_COOKIE);
  if (!browserBinding) {
    browserBinding = crypto.randomBytes(32).toString('base64url');
  }
  res.cookie(FLOW_COOKIE, browserBinding, cookieOptions(FLOW_TTL_MS));

  const state = oidc.randomState();
  const nonce = oidc.randomNonce();
  const codeVerifier = oidc.randomPKCECodeVerifier();
  const codeChallenge = await oidc.calculatePKCECodeChallenge(codeVerifier);

  pendingFlows.set(state, {
    nonce,
    codeVerifier,
    browserBinding,
    expiresAt: Date.now() + FLOW_TTL_MS,
  });

  // The in-memory flow store is intended for this app's single Node.js instance.
  const url = oidc.buildAuthorizationUrl(clientConfig, {
    redirect_uri: settings.redirectUri,
    response_type: 'code',
    scope: settings.scopes,
    state,
    nonce,
    code_challenge: codeChallenge,
    code_challenge_method: 'S256',
  });

  return res.redirect(302, url.href);
}

async function completeLogin(req) {
  const state = typeof req.query.state === 'string' ? req.query.state : '';
  if (!state) throw new Error('Missing OIDC state.');

  const flow = pendingFlows.get(state);
  pendingFlows.delete(state); // State is single-use, including failed callbacks.

  const browserBinding = readCookie(req, FLOW_COOKIE);
  if (!flow || flow.expiresAt <= Date.now() || !sameSecret(flow.browserBinding, browserBinding)) {
    throw new Error('OIDC state validation failed. Start sign-in again.');
  }

  if (typeof req.query.error === 'string') {
    throw new Error(`Authentik returned ${cleanText(req.query.error, 80)}.`);
  }
  if (typeof req.query.code !== 'string' || !req.query.code) {
    throw new Error('Missing authorization code.');
  }

  const { oidc, clientConfig, settings } = await getOidc();
  const callbackUrl = new URL(req.originalUrl, settings.redirectUri);
  const tokens = await oidc.authorizationCodeGrant(clientConfig, callbackUrl, {
    pkceCodeVerifier: flow.codeVerifier,
    expectedState: state,
    expectedNonce: flow.nonce,
    idTokenExpected: true,
  });

  const claims = tokens.claims();
  if (!claims || typeof claims.sub !== 'string' || !claims.sub) {
    throw new Error('Authentik did not return a valid subject claim.');
  }

  // UserInfo is verified against the subject from the validated ID Token.
  // If the provider does not expose optional profile claims, the subject remains
  // a safe fallback username rather than failing authentication.
  let profile = {};
  if (tokens.access_token) {
    try {
      profile = await oidc.fetchUserInfo(clientConfig, tokens.access_token, claims.sub);
    } catch (error) {
      console.warn('[auth] OIDC UserInfo unavailable; using ID Token claims:', error.message);
    }
  }

  const username = cleanText(
    profile.preferred_username || profile.username || claims.preferred_username || profile.email || claims.email || claims.sub,
    128,
  );
  const displayName = cleanText(
    profile.name || claims.name || [profile.given_name, profile.family_name].filter(Boolean).join(' ') || username,
    200,
  );

  return { username, displayName, subject: claims.sub };
}

module.exports = {
  beginLogin,
  completeLogin,
  clearBrowserCookie,
  mode: 'oidc',
};