// Offline analysis over media + insights: what works and when to post.
import { listMedia, mediaInsights } from './ops.js';

const DAYS = ['domingo', 'lunes', 'martes', 'miércoles', 'jueves', 'viernes', 'sábado'];

export function engagement(m) {
  const i = m.insights || {};
  return (m.like_count || 0) + (m.comments_count || 0) * 3 + (i.shares || 0) * 4 + (i.saved || 0) * 4;
}

export function summarize(media, { timeZone = 'Europe/Madrid' } = {}) {
  if (!media.length) return { posts: 0 };
  const fmt = new Intl.DateTimeFormat('en-US', { timeZone, weekday: 'short', hour: 'numeric', hourCycle: 'h23' });
  const wd = { Sun: 0, Mon: 1, Tue: 2, Wed: 3, Thu: 4, Fri: 5, Sat: 6 };
  const byDay = {};
  const byHour = {};
  const bucket = (map, k, v) => ((map[k] ||= { posts: 0, total: 0 }), map[k].posts++, (map[k].total += v));

  const scored = media.map((m) => {
    const parts = Object.fromEntries(fmt.formatToParts(new Date(m.timestamp)).map((p) => [p.type, p.value]));
    const score = engagement(m);
    bucket(byDay, DAYS[wd[parts.weekday]], score);
    bucket(byHour, Number(parts.hour), score);
    return { id: m.id, permalink: m.permalink, type: m.media_product_type, timestamp: m.timestamp, score, views: m.insights?.views ?? null, caption: (m.caption || '').slice(0, 80) };
  });

  const rank = (map) =>
    Object.entries(map)
      .map(([k, v]) => ({ slot: k, posts: v.posts, avg_engagement: Math.round(v.total / v.posts) }))
      .sort((a, b) => b.avg_engagement - a.avg_engagement);
  const views = scored.map((s) => s.views).filter((v) => v != null);

  return {
    posts: media.length,
    avg_engagement: Math.round(scored.reduce((n, s) => n + s.score, 0) / scored.length),
    avg_views: views.length ? Math.round(views.reduce((a, b) => a + b, 0) / views.length) : null,
    top: [...scored].sort((a, b) => b.score - a.score).slice(0, 5),
    worst: [...scored].sort((a, b) => a.score - b.score).slice(0, 3),
    best_days: rank(byDay).slice(0, 3),
    best_hours: rank(byHour).slice(0, 3).map((h) => ({ ...h, slot: `${h.slot}:00 (${timeZone})` })),
    engagement_formula: 'likes + 3·comments + 4·shares + 4·saves',
  };
}

export async function analyze(c, { posts = 30, withInsights = true, timeZone } = {}) {
  const media = await listMedia(c, { limit: posts });
  if (withInsights) {
    for (const m of media) m.insights = await mediaInsights(c, m.id, m.media_product_type).catch(() => null);
  }
  return summarize(media, { timeZone });
}
