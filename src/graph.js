// Thin client for the official Instagram API with Instagram Login (graph.instagram.com).
import { load, save, getAccount, upsertAccount } from './config.js';
import { assertAllowed } from './guard.js';

export const API_VERSION = process.env.INSTA_PILOT_API_VERSION || 'v23.0';
export const BASE = 'https://graph.instagram.com';

const RATE_LIMIT_CODES = new Set([4, 17, 32, 613, 80002]);
const DAY = 86_400_000;
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

export class GraphError extends Error {
  constructor(status, body) {
    const e = body?.error || {};
    super(`Instagram API ${status}: ${e.message || JSON.stringify(body)}${e.code ? ` (code ${e.code})` : ''}`);
    this.status = status;
    this.code = e.code;
    this.subcode = e.error_subcode;
  }
}

export async function request(method, url, { token, params, json, retries = 3 } = {}) {
  const u = new URL(url.startsWith('http') ? url : `${BASE}/${API_VERSION}/${url.replace(/^\//, '')}`);
  for (const [k, v] of Object.entries(params || {})) {
    if (v !== undefined && v !== null) u.searchParams.set(k, typeof v === 'object' ? JSON.stringify(v) : String(v));
  }
  if (token && !u.searchParams.has('access_token')) u.searchParams.set('access_token', token);

  for (let attempt = 0; ; attempt++) {
    const res = await fetch(u, {
      method,
      headers: json ? { 'Content-Type': 'application/json' } : undefined,
      body: json ? JSON.stringify(json) : undefined,
    });
    const text = await res.text();
    let body;
    try {
      body = text ? JSON.parse(text) : {};
    } catch {
      body = { raw: text };
    }
    if (res.ok && !body.error) return body;

    const err = new GraphError(res.status, body);
    const retryable = res.status === 429 || res.status >= 500 || RATE_LIMIT_CODES.has(err.code);
    if (!retryable || attempt >= retries) throw err;
    await sleep(Math.min(30_000, 1000 * 2 ** attempt));
  }
}

export async function refreshToken(token) {
  return request('GET', `${BASE}/refresh_access_token`, { params: { grant_type: 'ig_refresh_token', access_token: token } });
}

// Returns a client bound to one account. Long-lived tokens last 60 days; refresh when <10 days remain.
export async function client(username) {
  const cfg = load();
  const acc = getAccount(cfg, username);
  assertAllowed(acc.username, cfg);

  if (acc.expiresAt && acc.expiresAt - Date.now() < 10 * DAY) {
    try {
      const r = await refreshToken(acc.token);
      acc.token = r.access_token;
      acc.expiresAt = Date.now() + r.expires_in * 1000;
      save(upsertAccount(cfg, acc));
    } catch {
      // Keep the old token; doctor/whoami will surface the problem.
    }
  }

  const call = (method) => (path, opts = {}) => request(method, path, { ...opts, token: acc.token });
  const get = call('GET');

  return {
    account: acc,
    get,
    post: call('POST'),
    del: call('DELETE'),
    // Follows paging.next until `max` items or the end.
    async paginate(path, params = {}, max = Infinity) {
      const out = [];
      let page = await get(path, { params });
      while (true) {
        out.push(...(page.data || []));
        const next = page.paging?.next;
        if (!next || out.length >= max) break;
        page = await get(next);
      }
      return out.slice(0, max);
    },
  };
}
