#!/usr/bin/env node
// insta-pilot CLI. Without arguments it starts the MCP server on stdio.
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { execSync } from 'node:child_process';
import { fileURLToPath } from 'node:url';
import { load, save, norm, upsertAccount, isBlocked, blocklist, HOME } from '../src/config.js';
import { request, refreshToken, client, BASE } from '../src/graph.js';
import { PROFILE_FIELDS, exportAll, inbox } from '../src/ops.js';
import { readOnly } from '../src/guard.js';

const ROOT = path.dirname(path.dirname(fileURLToPath(import.meta.url)));
const [cmd, ...args] = process.argv.slice(2);
const flag = (name) => {
  const i = args.indexOf(`--${name}`);
  return i >= 0 ? args[i + 1] : undefined;
};
const print = (x) => console.log(typeof x === 'string' ? x : JSON.stringify(x, null, 2));

const HELP = `insta-pilot — Instagram para Claude (MCP)

  insta-pilot                      arranca el servidor MCP (stdio)
  insta-pilot add <TOKEN> [--secret APP_SECRET]
                                   añade una cuenta (token de "Generate token" en Meta)
  insta-pilot list                 cuentas configuradas
  insta-pilot use <usuario>        cambia la cuenta activa
  insta-pilot remove <usuario>     borra una cuenta
  insta-pilot block <usuario>      bloquea una cuenta para siempre
  insta-pilot refresh [usuario]    renueva el token (60 días)
  insta-pilot doctor               comprueba tokens, permisos y configuración
  insta-pilot inbox [usuario]      comentarios y DMs sin responder
  insta-pilot export [usuario] [--dms]   vuelca toda la cuenta a ${path.join(HOME, 'exports')}
  insta-pilot install              registra el MCP en Claude Code e instala la skill
`;

async function add() {
  let token = args[0];
  if (!token) throw new Error('Uso: insta-pilot add <ACCESS_TOKEN> [--secret APP_SECRET]');
  let expiresIn;
  const secret = flag('secret');
  if (secret) {
    const r = await request('GET', `${BASE}/access_token`, { params: { grant_type: 'ig_exchange_token', client_secret: secret, access_token: token } });
    token = r.access_token;
    expiresIn = r.expires_in;
  }
  const me = await request('GET', 'me', { token, params: { fields: PROFILE_FIELDS } });
  const cfg = load();
  if (isBlocked(me.username, cfg)) throw new Error(`@${me.username} está en la lista de bloqueo. No se guarda.`);
  if (!expiresIn) {
    // Dashboard tokens are long-lived; a refresh tells us the real expiry.
    try {
      const r = await refreshToken(token);
      token = r.access_token;
      expiresIn = r.expires_in;
    } catch {}
  }
  upsertAccount(cfg, {
    username: me.username,
    token,
    appScopedId: me.id,
    userId: me.user_id,
    accountType: me.account_type,
    expiresAt: expiresIn ? Date.now() + expiresIn * 1000 : null,
  });
  save(cfg);
  print(`✓ @${me.username} (${me.account_type}, ${me.followers_count} seguidores) añadida. Activa: @${cfg.active}`);
}

async function doctor() {
  const cfg = load();
  print(`Config: ${HOME}`);
  print(`Solo lectura: ${readOnly() ? 'sí' : 'no'}   Bloqueadas: ${blocklist(cfg).join(', ')}`);
  print(`Archivos locales: ${process.env.INSTA_PILOT_BLOB_TOKEN || process.env.BLOB_READ_WRITE_TOKEN ? 'Vercel Blob configurado' : 'solo URLs públicas (falta INSTA_PILOT_BLOB_TOKEN)'}`);
  const accounts = Object.values(cfg.accounts);
  if (!accounts.length) print('⚠ No hay cuentas. Ejecuta: insta-pilot add <TOKEN>');
  for (const a of accounts) {
    const days = a.expiresAt ? Math.round((a.expiresAt - Date.now()) / 86_400_000) : '?';
    try {
      const c = await client(a.username);
      const me = await c.get('me', { params: { fields: 'username,account_type,media_count' } });
      const checks = await Promise.allSettled([c.get('me/media', { params: { limit: 1 } }), c.get('me/conversations', { params: { platform: 'instagram', limit: 1 } })]);
      print(
        `✓ @${me.username} ${me.account_type} · token ${days} días · media ${checks[0].status === 'fulfilled' ? 'ok' : '✗'} · DMs ${
          checks[1].status === 'fulfilled' ? 'ok' : `✗ (${checks[1].reason.message})`
        }`
      );
    } catch (e) {
      print(`✗ @${a.username}: ${e.message}`);
    }
  }
}

function install() {
  const server = path.join(ROOT, 'bin', 'insta-pilot.js');
  try {
    // claude is a .cmd shim on Windows, so it needs a shell: quote paths ourselves.
    const q = (s) => `"${s}"`;
    execSync(`claude mcp add --scope user insta-pilot -- ${q(process.execPath)} ${q(server)}`, { stdio: 'inherit' });
  } catch {
    print(`No se pudo ejecutar "claude mcp add". Añádelo a mano:\n  claude mcp add --scope user insta-pilot -- node "${server}"`);
  }
  const dest = path.join(os.homedir(), '.claude', 'skills', 'instagram-pilot');
  fs.mkdirSync(dest, { recursive: true });
  fs.copyFileSync(path.join(ROOT, 'skills', 'instagram-pilot', 'SKILL.md'), path.join(dest, 'SKILL.md'));
  print(`✓ Skill instalada en ${dest}`);
}

const commands = {
  add,
  list: () => {
    const cfg = load();
    for (const a of Object.values(cfg.accounts)) print(`${a.username === cfg.active ? '*' : ' '} @${a.username} (${a.accountType || '?'})`);
    if (!Object.keys(cfg.accounts).length) print('(sin cuentas)');
  },
  use: () => {
    const cfg = load();
    const key = norm(args[0]);
    if (!cfg.accounts[key]) throw new Error(`No configurada: ${key}`);
    if (isBlocked(key, cfg)) throw new Error(`@${key} está bloqueada.`);
    cfg.active = key;
    save(cfg);
    print(`Activa: @${key}`);
  },
  remove: () => {
    const cfg = load();
    delete cfg.accounts[norm(args[0])];
    if (cfg.active === norm(args[0])) cfg.active = Object.keys(cfg.accounts)[0] || null;
    save(cfg);
    print('Eliminada.');
  },
  block: () => {
    const cfg = load();
    const key = norm(args[0]);
    cfg.blocklist = [...new Set([...cfg.blocklist, key])];
    delete cfg.accounts[key];
    if (cfg.active === key) cfg.active = Object.keys(cfg.accounts)[0] || null;
    save(cfg);
    print(`@${key} bloqueada.`);
  },
  refresh: async () => {
    const cfg = load();
    const acc = cfg.accounts[norm(args[0] || cfg.active)];
    if (!acc) throw new Error('Cuenta no encontrada');
    const r = await refreshToken(acc.token);
    acc.token = r.access_token;
    acc.expiresAt = Date.now() + r.expires_in * 1000;
    save(cfg);
    print(`✓ Token renovado hasta ${new Date(acc.expiresAt).toISOString().slice(0, 10)}`);
  },
  doctor,
  inbox: async () => print(await inbox(await client(args[0]))),
  export: async () => print(await exportAll(await client(args.find((a) => !a.startsWith('--'))), { withDms: args.includes('--dms') })),
  install,
  help: () => print(HELP),
  '--help': () => print(HELP),
};

try {
  if (!cmd || cmd === 'serve') {
    const { main } = await import('../src/server.js');
    await main();
  } else if (commands[cmd]) {
    await commands[cmd]();
  } else {
    print(HELP);
    process.exitCode = 1;
  }
} catch (e) {
  console.error(`✗ ${e.message}`);
  process.exitCode = 1;
}
