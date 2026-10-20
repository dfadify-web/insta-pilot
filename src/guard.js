// Safety layer: blocklist, read-only mode and an append-only audit log of every write.
import fs from 'node:fs';
import path from 'node:path';
import { HOME, isBlocked } from './config.js';

export class BlockedAccountError extends Error {}

export function assertAllowed(username, cfg) {
  if (isBlocked(username, cfg)) {
    throw new BlockedAccountError(
      `@${username} está en la lista de bloqueo de insta-pilot. No se realizará ninguna acción con esta cuenta.`
    );
  }
}

export const readOnly = () => /^(1|true|yes)$/i.test(process.env.INSTA_PILOT_READ_ONLY || '');

export function assertWritable(action) {
  if (readOnly()) throw new Error(`Modo solo lectura activo (INSTA_PILOT_READ_ONLY): "${action}" bloqueado.`);
}

export function audit(entry) {
  try {
    fs.mkdirSync(HOME, { recursive: true });
    fs.appendFileSync(
      path.join(HOME, 'audit.jsonl'),
      JSON.stringify({ at: new Date().toISOString(), ...entry }) + '\n'
    );
  } catch {
    // Auditing must never break the action itself.
  }
}
