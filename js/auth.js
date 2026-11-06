// Google Identity Services — OAuth2 token model (pure client side)
import { ls } from './utils.js';

const DRIVE_FILE = 'https://www.googleapis.com/auth/drive.file';
const SCOPES = `${DRIVE_FILE} openid email profile`;
const LS_TOKEN = 'pt.token';
const LS_USER = 'pt.user';

let client = null;
let token = null;
let expiresAt = 0;
let pending = null;

const authError = (message, type) => Object.assign(new Error(message), { code: 'auth', type });

function waitForGis(timeout = 12000) {
  return new Promise((resolve, reject) => {
    const start = Date.now();
    (function check() {
      if (window.google?.accounts?.oauth2) return resolve();
      if (Date.now() - start > timeout) return reject(new Error('Google Identity Services non disponibile'));
      setTimeout(check, 100);
    })();
  });
}

export async function init(clientId) {
  await waitForGis();
  client = google.accounts.oauth2.initTokenClient({
    client_id: clientId,
    scope: SCOPES,
    callback: (resp) => {
      const p = pending;
      pending = null;
      if (!p) return;
      if (resp.error) return p.reject(authError(resp.error_description || resp.error, resp.error));
      if (!google.accounts.oauth2.hasGrantedAllScopes(resp, DRIVE_FILE)) {
        return p.reject(authError('drive_scope_denied', 'scope'));
      }
      token = resp.access_token;
      expiresAt = Date.now() + (Number(resp.expires_in || 3600) - 120) * 1000;
      ls.set(LS_TOKEN, { token, expiresAt });
      p.resolve(token);
    },
    error_callback: (err) => {
      const p = pending;
      pending = null;
      p?.reject(authError(err?.message || err?.type || 'auth_error', err?.type));
    },
  });
  const saved = ls.get(LS_TOKEN);
  if (saved && saved.expiresAt > Date.now()) {
    token = saved.token;
    expiresAt = saved.expiresAt;
  }
}

export const hasValidToken = () => !!token && Date.now() < expiresAt;

/** Opens the Google popup. Call it from a user gesture (click) when possible. */
export function requestToken() {
  if (!client) return Promise.reject(authError('not_initialized'));
  return new Promise((resolve, reject) => {
    pending?.reject(authError('superseded'));
    pending = { resolve, reject };
    const hint = ls.get(LS_USER)?.email;
    client.requestAccessToken({ prompt: '', ...(hint ? { login_hint: hint } : {}) });
  });
}

export async function getToken() {
  if (hasValidToken()) return token;
  return requestToken();
}

export function invalidate() {
  token = null;
  expiresAt = 0;
  ls.del(LS_TOKEN);
}

export async function fetchUser() {
  const tk = await getToken();
  const r = await fetch('https://www.googleapis.com/oauth2/v3/userinfo', {
    headers: { Authorization: `Bearer ${tk}` },
  });
  if (r.status === 401) {
    invalidate();
    throw authError('expired');
  }
  if (!r.ok) throw new Error('userinfo ' + r.status);
  const u = await r.json();
  const user = { email: u.email, name: u.name || u.email, picture: u.picture || '' };
  ls.set(LS_USER, user);
  return user;
}

export const cachedUser = () => ls.get(LS_USER);

export function signOut() {
  try {
    if (token && window.google?.accounts?.oauth2) google.accounts.oauth2.revoke(token, () => {});
  } catch {}
  invalidate();
  ls.del(LS_USER);
}
