// MCP server (stdio). Every tool accepts an optional `account`; writes accept `dry_run`.
import { McpServer } from '@modelcontextprotocol/sdk/server/mcp.js';
import { StdioServerTransport } from '@modelcontextprotocol/sdk/server/stdio.js';
import { z } from 'zod';
import { load, save, norm, blocklist, isBlocked } from './config.js';
import { client } from './graph.js';
import { readOnly } from './guard.js';
import * as ops from './ops.js';
import { analyze } from './analytics.js';

const account = z.string().optional().describe('Usuario de Instagram configurado (por defecto la cuenta activa)');
const dryRun = z.boolean().optional().describe('true = solo muestra lo que haría, sin ejecutar');
const ok = (data) => ({ content: [{ type: 'text', text: typeof data === 'string' ? data : JSON.stringify(data, null, 2) }] });
const fail = (e) => ({ isError: true, content: [{ type: 'text', text: e.message || String(e) }] });

export const TOOLS = [];
function tool(name, description, shape, run, { write = false } = {}) {
  TOOLS.push({ name, description, shape, run, write });
}
const withClient = (fn) => async (args) => fn(await client(args.account), args);

// ── Accounts ──
tool('ig_accounts', 'Lista las cuentas configuradas, la activa y la lista de bloqueo.', {}, async () => {
  const cfg = load();
  return {
    active: cfg.active,
    read_only: readOnly(),
    accounts: Object.values(cfg.accounts).map((a) => ({
      username: a.username,
      account_type: a.accountType,
      token_expires: a.expiresAt ? new Date(a.expiresAt).toISOString().slice(0, 10) : 'desconocido',
    })),
    blocklist: blocklist(cfg),
  };
});

tool('ig_use_account', 'Cambia la cuenta activa.', { username: z.string() }, async ({ username }) => {
  const cfg = load();
  const key = norm(username);
  if (isBlocked(key, cfg)) throw new Error(`@${key} está bloqueada.`);
  if (!cfg.accounts[key]) throw new Error(`No configurada: ${key}`);
  cfg.active = key;
  save(cfg);
  return `Cuenta activa: @${key}`;
});

// ── Profile, media, insights ──
tool('ig_profile', 'Perfil de la cuenta: bio, seguidores, seguidos, nº de publicaciones.', { account }, withClient((c) => ops.whoami(c)));

tool(
  'ig_media_list',
  'Lista publicaciones (reels, posts, carruseles) con likes, comentarios y permalink, de más reciente a más antigua.',
  { account, limit: z.number().int().min(1).max(1000).default(25) },
  withClient((c, a) => ops.listMedia(c, a))
);

tool('ig_media_get', 'Detalle de una publicación (incluye hijos de carrusel).', { account, media_id: z.string() }, withClient((c, a) => ops.getMedia(c, a.media_id)));

tool(
  'ig_media_insights',
  'Métricas de una publicación: views, reach, shares, saves, tiempo medio de visionado (reels)…',
  { account, media_id: z.string() },
  withClient((c, a) => ops.mediaInsights(c, a.media_id))
);

tool(
  'ig_account_insights',
  'Métricas de la cuenta en un rango (por defecto últimos 28 días). Con `breakdown` (age|gender|country|city) devuelve demografía de seguidores.',
  {
    account,
    since: z.string().optional().describe('Fecha ISO o unix'),
    until: z.string().optional(),
    metrics: z.string().optional().describe('Métricas separadas por comas'),
    breakdown: z.enum(['age', 'gender', 'country', 'city']).optional(),
  },
  withClient((c, a) => ops.accountInsights(c, a))
);

tool(
  'ig_analytics',
  'Análisis de rendimiento: top/peores publicaciones, mejores días y horas para publicar, medias de engagement y views.',
  { account, posts: z.number().int().min(1).max(200).default(30), time_zone: z.string().default('Europe/Madrid') },
  withClient((c, a) => analyze(c, { posts: a.posts, timeZone: a.time_zone }))
);

tool(
  'ig_export',
  'Scrapea TODA la cuenta a disco (perfil, todas las publicaciones, comentarios, métricas y opcionalmente DMs) en JSON + CSV.',
  {
    account,
    out_dir: z.string().optional(),
    with_comments: z.boolean().default(true),
    with_insights: z.boolean().default(true),
    with_dms: z.boolean().default(false),
    max_media: z.number().int().optional(),
  },
  withClient((c, a) =>
    ops.exportAll(c, { outDir: a.out_dir, withComments: a.with_comments, withInsights: a.with_insights, withDms: a.with_dms, maxMedia: a.max_media })
  )
);

// ── Comments ──
tool(
  'ig_comments',
  'Comentarios de una publicación con sus respuestas.',
  { account, media_id: z.string(), limit: z.number().int().default(100) },
  withClient((c, a) => ops.listComments(c, a.media_id, a))
);

tool(
  'ig_comments_unanswered',
  'Comentarios de otras personas a los que la cuenta aún no ha respondido, en las últimas N publicaciones.',
  { account, posts: z.number().int().default(10), max_age_days: z.number().int().default(30) },
  withClient((c, a) => ops.unansweredComments(c, { posts: a.posts, maxAgeDays: a.max_age_days }))
);

tool(
  'ig_comment_reply',
  'Responde a un comentario.',
  { account, comment_id: z.string(), message: z.string().min(1).max(2200), dry_run: dryRun },
  withClient((c, a) => ops.replyComment(c, a.comment_id, a.message, a.dry_run)),
  { write: true }
);

tool(
  'ig_comment_hide',
  'Oculta (o muestra con hide=false) un comentario.',
  { account, comment_id: z.string(), hide: z.boolean().default(true), dry_run: dryRun },
  withClient((c, a) => ops.hideComment(c, a.comment_id, a.hide, a.dry_run)),
  { write: true }
);

tool(
  'ig_comment_delete',
  'Elimina un comentario (irreversible).',
  { account, comment_id: z.string(), dry_run: dryRun },
  withClient((c, a) => ops.deleteComment(c, a.comment_id, a.dry_run)),
  { write: true }
);

tool(
  'ig_comments_toggle',
  'Activa o desactiva los comentarios de una publicación.',
  { account, media_id: z.string(), enabled: z.boolean(), dry_run: dryRun },
  withClient((c, a) => ops.setCommentsEnabled(c, a.media_id, a.enabled, a.dry_run)),
  { write: true }
);

// ── Publishing ──
const src = z.string().describe('URL pública o ruta local (local requiere INSTA_PILOT_BLOB_TOKEN)');

tool(
  'ig_publish_reel',
  'Publica un reel (MP4 vertical 9:16, 3s–15min). Espera a que Instagram procese el vídeo y devuelve el permalink.',
  {
    account,
    video: src,
    caption: z.string().max(2200).optional(),
    cover: src.optional().describe('Imagen de portada (URL o ruta)'),
    thumb_offset: z.number().int().optional().describe('ms del frame de portada si no hay cover'),
    share_to_feed: z.boolean().default(true),
    collaborators: z.array(z.string()).max(3).optional(),
    location_id: z.string().optional(),
    audio_name: z.string().optional(),
    dry_run: dryRun,
  },
  withClient((c, a) => ops.publishReel(c, a)),
  { write: true }
);

tool(
  'ig_publish_image',
  'Publica una foto (JPEG).',
  { account, image: src, caption: z.string().max(2200).optional(), alt_text: z.string().optional(), location_id: z.string().optional(), dry_run: dryRun },
  withClient((c, a) => ops.publishImage(c, a)),
  { write: true }
);

tool(
  'ig_publish_carousel',
  'Publica un carrusel de 2–10 fotos/vídeos.',
  { account, items: z.array(src).min(2).max(10), caption: z.string().max(2200).optional(), location_id: z.string().optional(), dry_run: dryRun },
  withClient((c, a) => ops.publishCarousel(c, a)),
  { write: true }
);

tool(
  'ig_publish_story',
  'Publica una historia (imagen o vídeo).',
  { account, media: src, dry_run: dryRun },
  withClient((c, a) => ops.publishStory(c, a)),
  { write: true }
);

tool('ig_publishing_limit', 'Cuota de publicaciones usada en las últimas 24 h (límite de la API).', { account }, withClient((c) => ops.publishingLimit(c)));

// ── DMs ──
tool(
  'ig_conversations',
  'Lista conversaciones de DM con el último mensaje y si esperan respuesta.',
  { account, limit: z.number().int().default(20), only_awaiting_reply: z.boolean().default(false) },
  withClient(async (c, a) => {
    const rows = await ops.listConversations(c, a);
    return a.only_awaiting_reply ? rows.filter((r) => r.awaiting_reply) : rows;
  })
);

tool(
  'ig_messages',
  'Mensajes de una conversación (más recientes primero).',
  { account, conversation_id: z.string(), limit: z.number().int().default(30) },
  withClient((c, a) => ops.listMessages(c, a.conversation_id, a))
);

tool(
  'ig_send_message',
  'Envía un DM de texto. Solo funciona si la persona escribió en las últimas 24 h (regla de Instagram). recipient_id = `with.id` de ig_conversations.',
  { account, recipient_id: z.string(), text: z.string().min(1).max(1000), dry_run: dryRun },
  withClient((c, a) => ops.sendMessage(c, a.recipient_id, a.text, a.dry_run)),
  { write: true }
);

// ── Triage ──
tool(
  'ig_inbox',
  'Bandeja unificada: comentarios sin responder + DMs que esperan respuesta. Punto de partida para "responde a todo".',
  { account, posts: z.number().int().default(10), max_age_days: z.number().int().default(14) },
  withClient((c, a) => ops.inbox(c, { posts: a.posts, maxAgeDays: a.max_age_days }))
);

export function buildServer() {
  const server = new McpServer({ name: 'insta-pilot', version: '1.0.0' });
  for (const t of TOOLS) {
    if (t.write && readOnly()) continue;
    server.registerTool(
      t.name,
      { description: t.description, inputSchema: t.shape, annotations: { readOnlyHint: !t.write, destructiveHint: t.name.includes('delete') } },
      async (args) => {
        try {
          return ok(await t.run(args || {}));
        } catch (e) {
          return fail(e);
        }
      }
    );
  }
  return server;
}

export async function main() {
  await buildServer().connect(new StdioServerTransport());
}
