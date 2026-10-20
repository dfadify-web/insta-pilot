// Instagram operations on top of the Graph client. Every write goes through `write()`.
import fs from 'node:fs';
import path from 'node:path';
import { HOME } from './config.js';
import { assertWritable, audit } from './guard.js';
import { stage } from './staging.js';

export const PROFILE_FIELDS =
  'id,user_id,username,name,account_type,biography,website,profile_picture_url,followers_count,follows_count,media_count';
export const MEDIA_FIELDS =
  'id,caption,media_type,media_product_type,permalink,media_url,thumbnail_url,timestamp,like_count,comments_count,is_comment_enabled';
const COMMENT_FIELDS = 'id,text,timestamp,username,like_count,hidden,from,replies{id,text,timestamp,username,from}';

const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
const own = (c) => c.account.username.toLowerCase();

async function write(c, action, detail, dryRun, fn) {
  assertWritable(action);
  if (dryRun) return { dry_run: true, account: c.account.username, action, would_do: detail };
  try {
    const result = await fn();
    audit({ account: c.account.username, action, detail, ok: true, result });
    return result;
  } catch (e) {
    audit({ account: c.account.username, action, detail, ok: false, error: e.message });
    throw e;
  }
}

// ── Profile & insights ────────────────────────────────────────────────────────

export const whoami = (c) => c.get('me', { params: { fields: PROFILE_FIELDS } });

export function accountInsights(c, { metrics, since, until, breakdown } = {}) {
  if (breakdown) {
    return c.get('me/insights', {
      params: { metric: 'follower_demographics', period: 'lifetime', metric_type: 'total_value', timeframe: 'this_month', breakdown },
    });
  }
  const day = 86400;
  const now = Math.floor(Date.now() / 1000);
  return c.get('me/insights', {
    params: {
      metric: metrics || 'views,reach,accounts_engaged,total_interactions,likes,comments,shares,saves,replies,follows_and_unfollows,profile_links_taps',
      period: 'day',
      metric_type: 'total_value',
      since: since ? toUnix(since) : now - 28 * day,
      until: until ? toUnix(until) : now,
    },
  });
}

const toUnix = (d) => (/^\d+$/.test(String(d)) ? Number(d) : Math.floor(new Date(d).getTime() / 1000));

const MEDIA_METRICS = {
  REELS: 'views,reach,likes,comments,shares,saved,total_interactions,ig_reels_avg_watch_time,ig_reels_video_view_total_time',
  FEED: 'views,reach,likes,comments,shares,saved,total_interactions,profile_visits,follows',
  STORY: 'views,reach,replies,shares,total_interactions,navigation',
};

export async function mediaInsights(c, mediaId, productType) {
  const type = productType || (await c.get(mediaId, { params: { fields: 'media_product_type' } })).media_product_type;
  try {
    const r = await c.get(`${mediaId}/insights`, { params: { metric: MEDIA_METRICS[type] || MEDIA_METRICS.FEED } });
    return flattenInsights(r);
  } catch {
    // Older media / albums do not support every metric.
    const r = await c.get(`${mediaId}/insights`, { params: { metric: 'reach,likes,comments,saved,shares' } });
    return flattenInsights(r);
  }
}

export const flattenInsights = (r) =>
  Object.fromEntries((r.data || []).map((m) => [m.name, m.total_value?.value ?? m.values?.[0]?.value ?? null]));

// ── Media ─────────────────────────────────────────────────────────────────────

export const listMedia = (c, { limit = 25 } = {}) =>
  c.paginate('me/media', { fields: MEDIA_FIELDS, limit: Math.min(limit, 100) }, limit);

export const getMedia = (c, id) => c.get(id, { params: { fields: `${MEDIA_FIELDS},children{id,media_type,media_url}` } });

// ── Comments ──────────────────────────────────────────────────────────────────

export const listComments = (c, mediaId, { limit = 100 } = {}) =>
  c.paginate(`${mediaId}/comments`, { fields: COMMENT_FIELDS, limit: 50 }, limit);

export const replyComment = (c, commentId, message, dryRun) =>
  write(c, 'comment.reply', { commentId, message }, dryRun, () => c.post(`${commentId}/replies`, { params: { message } }));

export const hideComment = (c, commentId, hide = true, dryRun) =>
  write(c, hide ? 'comment.hide' : 'comment.unhide', { commentId }, dryRun, () => c.post(commentId, { params: { hide } }));

export const deleteComment = (c, commentId, dryRun) =>
  write(c, 'comment.delete', { commentId }, dryRun, () => c.del(commentId));

export const setCommentsEnabled = (c, mediaId, enabled, dryRun) =>
  write(c, 'media.comments_enabled', { mediaId, enabled }, dryRun, () => c.post(mediaId, { params: { comment_enabled: enabled } }));

export function isAnswered(comment, me) {
  if ((comment.username || '').toLowerCase() === me) return true;
  return (comment.replies?.data || []).some((r) => (r.username || '').toLowerCase() === me);
}

// Comments from other people on the latest `posts` posts that the account has not replied to.
export async function unansweredComments(c, { posts = 10, maxAgeDays = 30 } = {}) {
  const me = own(c);
  const cutoff = Date.now() - maxAgeDays * 86_400_000;
  const media = await listMedia(c, { limit: posts });
  const out = [];
  for (const m of media) {
    if (!m.comments_count) continue;
    for (const cm of await listComments(c, m.id)) {
      if (new Date(cm.timestamp).getTime() < cutoff || cm.hidden || isAnswered(cm, me)) continue;
      out.push({
        comment_id: cm.id,
        username: cm.username,
        text: cm.text,
        timestamp: cm.timestamp,
        like_count: cm.like_count,
        media_id: m.id,
        media_caption: (m.caption || '').slice(0, 120),
        permalink: m.permalink,
      });
    }
  }
  return out.sort((a, b) => b.timestamp.localeCompare(a.timestamp));
}

// ── Publishing ────────────────────────────────────────────────────────────────

export async function waitContainer(c, id, { timeoutMs = 10 * 60_000, intervalMs = 5000 } = {}) {
  const end = Date.now() + timeoutMs;
  while (true) {
    const s = await c.get(id, { params: { fields: 'status_code,status' } });
    if (s.status_code === 'FINISHED' || s.status_code === 'PUBLISHED') return s;
    if (s.status_code === 'ERROR' || s.status_code === 'EXPIRED') throw new Error(`Contenedor ${id} falló: ${s.status || s.status_code}`);
    if (Date.now() > end) throw new Error(`Timeout esperando al contenedor ${id} (último estado: ${s.status_code})`);
    await sleep(intervalMs);
  }
}

async function createAndPublish(c, params, timing) {
  const { id } = await c.post('me/media', { params });
  await waitContainer(c, id, timing);
  const pub = await c.post('me/media_publish', { params: { creation_id: id } });
  const media = await c.get(pub.id, { params: { fields: 'id,permalink,media_product_type,timestamp' } });
  return { container_id: id, ...media };
}

const mediaKind = (src) => (/\.(mp4|mov)(\?|$)/i.test(src) ? 'VIDEO' : 'IMAGE');

export function publishReel(c, { video, caption, cover, share_to_feed = true, thumb_offset, collaborators, location_id, audio_name, dry_run, timing }) {
  const detail = { video, caption, cover, share_to_feed, thumb_offset, collaborators, location_id, audio_name };
  return write(c, 'publish.reel', detail, dry_run, async () => {
    const { urls, cleanup } = await stage(cover ? [video, cover] : [video]);
    try {
      return await createAndPublish(
        c,
        {
          media_type: 'REELS',
          video_url: urls[0],
          cover_url: urls[1],
          caption,
          share_to_feed,
          thumb_offset,
          collaborators: collaborators?.length ? collaborators : undefined,
          location_id,
          audio_name,
        },
        timing
      );
    } finally {
      await cleanup();
    }
  });
}

export function publishImage(c, { image, caption, alt_text, location_id, dry_run, timing }) {
  return write(c, 'publish.image', { image, caption, alt_text, location_id }, dry_run, async () => {
    const { urls, cleanup } = await stage([image]);
    try {
      return await createAndPublish(c, { image_url: urls[0], caption, alt_text, location_id }, timing);
    } finally {
      await cleanup();
    }
  });
}

export function publishCarousel(c, { items, caption, location_id, dry_run, timing }) {
  if (!items?.length || items.length < 2 || items.length > 10) throw new Error('Un carrusel necesita entre 2 y 10 elementos.');
  return write(c, 'publish.carousel', { items, caption }, dry_run, async () => {
    const { urls, cleanup } = await stage(items);
    try {
      const children = [];
      for (let i = 0; i < urls.length; i++) {
        const video = mediaKind(items[i]) === 'VIDEO';
        const { id } = await c.post('me/media', {
          params: video ? { media_type: 'VIDEO', video_url: urls[i], is_carousel_item: true } : { image_url: urls[i], is_carousel_item: true },
        });
        await waitContainer(c, id, timing);
        children.push(id);
      }
      return await createAndPublish(c, { media_type: 'CAROUSEL', children: children.join(','), caption, location_id }, timing);
    } finally {
      await cleanup();
    }
  });
}

export function publishStory(c, { media, dry_run, timing }) {
  return write(c, 'publish.story', { media }, dry_run, async () => {
    const { urls, cleanup } = await stage([media]);
    try {
      const key = mediaKind(media) === 'VIDEO' ? 'video_url' : 'image_url';
      return await createAndPublish(c, { media_type: 'STORIES', [key]: urls[0] }, timing);
    } finally {
      await cleanup();
    }
  });
}

export const publishingLimit = (c) => c.get('me/content_publishing_limit', { params: { fields: 'quota_usage,config' } });

// ── Direct messages ───────────────────────────────────────────────────────────

const LAST_MSG = 'messages.limit(1){id,message,from,created_time}';

export async function listConversations(c, { limit = 20 } = {}) {
  const rows = await c.paginate('me/conversations', { platform: 'instagram', fields: `id,updated_time,participants,${LAST_MSG}`, limit: 25 }, limit);
  const me = own(c);
  return rows.map((cv) => {
    const last = cv.messages?.data?.[0];
    const other = (cv.participants?.data || []).find((p) => (p.username || '').toLowerCase() !== me);
    return {
      conversation_id: cv.id,
      updated_time: cv.updated_time,
      with: other ? { id: other.id, username: other.username } : null,
      last_message: last ? { id: last.id, text: last.message, from: last.from?.username, created_time: last.created_time } : null,
      awaiting_reply: !!last && (last.from?.username || '').toLowerCase() !== me,
    };
  });
}

export async function listMessages(c, conversationId, { limit = 30 } = {}) {
  const r = await c.get(conversationId, {
    params: { fields: `participants,messages.limit(${Math.min(limit, 100)}){id,created_time,from,to,message,attachments,story,reactions}` },
  });
  return (r.messages?.data || []).map((m) => ({
    id: m.id,
    created_time: m.created_time,
    from: m.from?.username,
    from_id: m.from?.id,
    text: m.message,
    attachments: m.attachments?.data,
    story: m.story,
  }));
}

// Instagram only allows replies within 24h of the user's last message (standard messaging window).
export const sendMessage = (c, recipientId, text, dryRun) =>
  write(c, 'dm.send', { recipientId, text }, dryRun, () =>
    c.post('me/messages', { json: { recipient: { id: recipientId }, message: { text } } })
  );

// ── Triage ────────────────────────────────────────────────────────────────────

export async function inbox(c, { posts = 10, maxAgeDays = 14, conversations = 30 } = {}) {
  const [comments, dms] = await Promise.allSettled([
    unansweredComments(c, { posts, maxAgeDays }),
    listConversations(c, { limit: conversations }),
  ]);
  return {
    account: c.account.username,
    unanswered_comments: comments.status === 'fulfilled' ? comments.value : { error: comments.reason.message },
    dms_awaiting_reply:
      dms.status === 'fulfilled' ? dms.value.filter((d) => d.awaiting_reply) : { error: dms.reason.message },
  };
}

// ── Full export ───────────────────────────────────────────────────────────────

export async function exportAll(c, { outDir, withComments = true, withInsights = true, withDms = false, maxMedia = Infinity } = {}) {
  const stamp = new Date().toISOString().slice(0, 19).replace(/[:T]/g, '-');
  const dir = outDir || path.join(HOME, 'exports', c.account.username, stamp);
  fs.mkdirSync(dir, { recursive: true });
  const dump = (name, data) => fs.writeFileSync(path.join(dir, name), JSON.stringify(data, null, 2));
  const errors = [];

  const profile = await whoami(c);
  dump('profile.json', profile);

  const media = await listMedia(c, { limit: maxMedia });
  for (const m of media) {
    if (withComments && m.comments_count) {
      m.comments = await listComments(c, m.id, { limit: 1000 }).catch((e) => (errors.push(`${m.id} comments: ${e.message}`), []));
    }
    if (withInsights) {
      m.insights = await mediaInsights(c, m.id, m.media_product_type).catch((e) => (errors.push(`${m.id} insights: ${e.message}`), null));
    }
  }
  dump('media.json', media);
  fs.writeFileSync(path.join(dir, 'media.csv'), toCsv(media));

  if (withInsights) dump('account_insights_28d.json', await accountInsights(c).catch((e) => ({ error: e.message })));

  let conversations = [];
  if (withDms) {
    conversations = await listConversations(c, { limit: 500 }).catch((e) => (errors.push(`dms: ${e.message}`), []));
    for (const cv of conversations) cv.messages = await listMessages(c, cv.conversation_id, { limit: 100 }).catch(() => []);
    dump('conversations.json', conversations);
  }

  const summary = {
    dir,
    username: profile.username,
    followers: profile.followers_count,
    media: media.length,
    comments: media.reduce((n, m) => n + (m.comments?.length || 0), 0),
    conversations: conversations.length,
    errors,
  };
  dump('summary.json', summary);
  return summary;
}

const CSV_COLS = ['id', 'timestamp', 'media_product_type', 'media_type', 'permalink', 'like_count', 'comments_count', 'views', 'reach', 'shares', 'saved', 'caption'];

export function toCsv(media) {
  const esc = (v) => (v == null ? '' : /[",\n]/.test(String(v)) ? `"${String(v).replace(/"/g, '""')}"` : String(v));
  const rows = media.map((m) => CSV_COLS.map((k) => esc(m[k] ?? m.insights?.[k])).join(','));
  return [CSV_COLS.join(','), ...rows].join('\n') + '\n';
}
