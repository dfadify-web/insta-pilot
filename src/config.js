// Account store: ~/.insta-pilot/accounts.json (tokens never leave this machine).
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';

export const HOME = process.env.INSTA_PILOT_HOME || path.join(os.homedir(), '.insta-pilot');
const FILE = () => path.join(HOME, 'accounts.json');

// Accounts that insta-pilot refuses to touch, whatever the token says.
// Extend with INSTA_PILOT_BLOCKLIST="user1,user2" or `insta-pilot block <user>`.
export const HARD_BLOCKLIST = ['fabregueees_'];

const empty = () => ({ active: null, accounts: {}, blocklist: [] });

export function load() {
  try {
    return { ...empty(), ...JSON.parse(fs.readFileSync(FILE(), 'utf8')) };
  } catch {
    return empty();
  }
}

export function save(cfg) {
  fs.mkdirSync(HOME, { recursive: true });
  fs.writeFileSync(FILE(), JSON.stringify(cfg, null, 2), { mode: 0o600 });
}

export function blocklist(cfg = load()) {
  const env = (process.env.INSTA_PILOT_BLOCKLIST || '').split(',');
  return [...new Set([...HARD_BLOCKLIST, ...cfg.blocklist, ...env].map(norm).filter(Boolean))];
}

export const norm = (u) => String(u || '').trim().replace(/^@/, '').toLowerCase();

export function isBlocked(username, cfg) {
  return blocklist(cfg).includes(norm(username));
}

export function upsertAccount(cfg, acc) {
  const key = norm(acc.username);
  cfg.accounts[key] = { ...cfg.accounts[key], ...acc, username: key };
  if (!cfg.active) cfg.active = key;
  return cfg;
}

export function getAccount(cfg, username) {
  const key = norm(username || cfg.active);
  const acc = cfg.accounts[key];
  if (!acc) {
    const known = Object.keys(cfg.accounts);
    throw new Error(
      known.length
        ? `Cuenta "${key}" no configurada. Disponibles: ${known.join(', ')}`
        : 'No hay cuentas. Ejecuta: insta-pilot add <ACCESS_TOKEN>'
    );
  }
  return acc;
}
