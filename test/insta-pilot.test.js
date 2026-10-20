import { test, beforeEach } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';

process.env.INSTA_PILOT_HOME = fs.mkdtempSync(path.join(os.tmpdir(), 'insta-pilot-'));
delete process.env.INSTA_PILOT_BLOB_TOKEN;
delete process.env.BLOB_READ_WRITE_TOKEN;

const config = await import('../src/config.js');
const { client, request } = await import('../src/graph.js');
const ops = await import('../src/ops.js');
const { summarize } = await import('../src/analytics.js');
const { TOOLS, buildServer } = await import('../src/server.js');

// Routes "METHOD path" → handler(url, init) returning a JSON body (or [status, body]).
let calls;
function mockFetch(routes) {
  calls = [];
  globalThis.fetch = async (input, init = {}) => {
    const url = new URL(input);
    const key = `${init.method || 'GET'} ${url.pathname.replace(/^\/v[\d.]+\//, '')}`;
    calls.push({ key, url, init });
    const h = routes[key];
    if (!h) return new Response(JSON.stringify({ error: { message: `no route ${key}` } }), { status: 404 });
    let out = typeof h === 'function' ? h(url, init) : h;
    const [status, body] = Array.isArray(out) ? out : [200, out];
    return new Response(JSON.stringify(body), { status });
  };
}

beforeEach(() => {
  delete process.env.INSTA_PILOT_READ_ONLY;
  const cfg = { active: null, accounts: {}, blocklist: [] };
  config.upsertAccount(cfg, { username: 'adify.dev', token: 'T1', expiresAt: Date.now() + 50 * 86_400_000 });
  config.upsertAccount(cfg, { username: 'fabregueees_', token: 'T2' });
  config.save(cfg);
});

test('la cuenta fabregueees_ está bloqueada siempre', async () => {
  assert.ok(config.isBlocked('@Fabregueees_'));
  mockFetch({});
  await assert.rejects(() => client('fabregueees_'), /bloqueo/);
  assert.equal(calls.length, 0, 'no debe tocar la API');
});

test('blocklist extra por variable de entorno', () => {
  process.env.INSTA_PILOT_BLOCKLIST = 'otra.cuenta';
  assert.ok(config.isBlocked('otra.cuenta'));
  delete process.env.INSTA_PILOT_BLOCKLIST;
});

test('paginate sigue paging.next', async () => {
  mockFetch({
    'GET me/media': (url) =>
      url.searchParams.get('after')
        ? { data: [{ id: '3' }] }
        : { data: [{ id: '1' }, { id: '2' }], paging: { next: 'https://graph.instagram.com/v23.0/me/media?after=x&access_token=T1' } },
  });
  const c = await client();
  assert.deepEqual((await ops.listMedia(c, { limit: 10 })).map((m) => m.id), ['1', '2', '3']);
  assert.equal(calls[0].url.searchParams.get('access_token'), 'T1');
});

test('reintenta en 429', async () => {
  let n = 0;
  mockFetch({ 'GET me': () => (++n === 1 ? [429, { error: { message: 'slow down', code: 4 } }] : { username: 'adify.dev' }) });
  const t = setTimeout;
  globalThis.setTimeout = (fn) => t(fn, 0);
  try {
    assert.equal((await request('GET', 'me', { token: 'T1' })).username, 'adify.dev');
  } finally {
    globalThis.setTimeout = t;
  }
  assert.equal(n, 2);
});

test('comentarios sin responder ignora los respondidos y los propios', async () => {
  mockFetch({
    'GET me/media': { data: [{ id: 'm1', comments_count: 3, caption: 'hola', permalink: 'p1' }] },
    'GET m1/comments': {
      data: [
        { id: 'c1', username: 'fan', text: '🔥', timestamp: new Date().toISOString() },
        { id: 'c2', username: 'fan2', text: 'repo?', timestamp: new Date().toISOString(), replies: { data: [{ username: 'adify.dev' }] } },
        { id: 'c3', username: 'adify.dev', text: 'gracias', timestamp: new Date().toISOString() },
      ],
    },
  });
  const out = await ops.unansweredComments(await client());
  assert.deepEqual(out.map((c) => c.comment_id), ['c1']);
});

test('publicar reel: crea contenedor, espera FINISHED y publica', async () => {
  let polls = 0;
  mockFetch({
    'POST me/media': (url) => {
      assert.equal(url.searchParams.get('media_type'), 'REELS');
      assert.equal(url.searchParams.get('video_url'), 'https://cdn.example.com/v.mp4');
      return { id: 'cont1' };
    },
    'GET cont1': () => ({ status_code: ++polls < 2 ? 'IN_PROGRESS' : 'FINISHED' }),
    'POST me/media_publish': (url) => (assert.equal(url.searchParams.get('creation_id'), 'cont1'), { id: 'media9' }),
    'GET media9': { id: 'media9', permalink: 'https://instagram.com/reel/x' },
  });
  const r = await ops.publishReel(await client(), { video: 'https://cdn.example.com/v.mp4', caption: 'hey', timing: { intervalMs: 1 } });
  assert.equal(r.permalink, 'https://instagram.com/reel/x');
  assert.equal(polls, 2);
  const log = fs.readFileSync(path.join(process.env.INSTA_PILOT_HOME, 'audit.jsonl'), 'utf8');
  assert.match(log, /publish\.reel/);
});

test('contenedor en ERROR lanza error', async () => {
  mockFetch({ 'POST me/media': { id: 'c' }, 'GET c': { status_code: 'ERROR', status: 'formato inválido' } });
  await assert.rejects(async () => ops.publishReel(await client(), { video: 'https://x/v.mp4', timing: { intervalMs: 1 } }), /formato inválido/);
});

test('archivo local sin token de Blob da un error claro', async () => {
  mockFetch({});
  const f = path.join(process.env.INSTA_PILOT_HOME, 'v.mp4');
  fs.writeFileSync(f, 'x');
  await assert.rejects(async () => ops.publishReel(await client(), { video: f }), /INSTA_PILOT_BLOB_TOKEN/);
});

test('dry_run no llama a la API', async () => {
  mockFetch({});
  const r = await ops.replyComment(await client(), 'c1', 'gracias!', true);
  assert.equal(r.dry_run, true);
  assert.equal(calls.length, 0);
});

test('modo solo lectura bloquea escrituras y oculta tools', async () => {
  process.env.INSTA_PILOT_READ_ONLY = '1';
  mockFetch({});
  await assert.rejects(async () => ops.sendMessage(await client(), 'u1', 'hola'), /solo lectura/);
  assert.ok(buildServer());
});

test('conversaciones marcan las que esperan respuesta', async () => {
  mockFetch({
    'GET me/conversations': {
      data: [
        { id: 'cv1', participants: { data: [{ id: 'u1', username: 'fan' }, { id: 'me', username: 'adify.dev' }] }, messages: { data: [{ message: 'hola', from: { username: 'fan' } }] } },
        { id: 'cv2', participants: { data: [{ id: 'u2', username: 'b' }] }, messages: { data: [{ message: 'ok', from: { username: 'adify.dev' } }] } },
      ],
    },
  });
  const rows = await ops.listConversations(await client());
  assert.deepEqual(rows.map((r) => r.awaiting_reply), [true, false]);
  assert.equal(rows[0].with.id, 'u1');
});

test('enviar DM usa JSON con recipient', async () => {
  mockFetch({ 'POST me/messages': (_u, init) => (assert.deepEqual(JSON.parse(init.body), { recipient: { id: 'u1' }, message: { text: 'hola' } }), { message_id: 'mid' }) });
  assert.equal((await ops.sendMessage(await client(), 'u1', 'hola')).message_id, 'mid');
});

test('analytics: top y mejores horas', () => {
  const s = summarize([
    { id: 'a', timestamp: '2026-10-01T18:00:00Z', like_count: 100, comments_count: 10, insights: { views: 5000, shares: 5 } },
    { id: 'b', timestamp: '2026-10-02T08:00:00Z', like_count: 5, comments_count: 0, insights: { views: 300 } },
  ]);
  assert.equal(s.top[0].id, 'a');
  assert.equal(s.avg_views, 2650);
  assert.match(s.best_hours[0].slot, /^20:00/);
});

test('CSV escapa comas y comillas', () => {
  const csv = ops.toCsv([{ id: '1', caption: 'hola, "mundo"' }]);
  assert.match(csv, /"hola, ""mundo"""/);
});

test('todas las tools tienen nombre ig_ y descripción', () => {
  assert.ok(TOOLS.length >= 20);
  for (const t of TOOLS) {
    assert.match(t.name, /^ig_/);
    assert.ok(t.description.length > 10);
  }
});
