// Instagram Login only accepts public media URLs. Local files are staged in the user's own
// Vercel Blob store (INSTA_PILOT_BLOB_TOKEN) and deleted right after publishing.
import fs from 'node:fs';
import path from 'node:path';

const BLOB_API = 'https://blob.vercel-storage.com';
const MIME = { '.mp4': 'video/mp4', '.mov': 'video/quicktime', '.jpg': 'image/jpeg', '.jpeg': 'image/jpeg', '.png': 'image/png' };

export const isUrl = (s) => /^https?:\/\//i.test(String(s || ''));

const blobToken = () => process.env.INSTA_PILOT_BLOB_TOKEN || process.env.BLOB_READ_WRITE_TOKEN;

// Resolves each source (URL or local path) to a public URL. Returns { urls, cleanup }.
export async function stage(sources) {
  const uploaded = [];
  const urls = [];
  try {
    for (const src of sources) {
      if (isUrl(src)) {
        urls.push(src);
        continue;
      }
      const abs = path.resolve(src);
      if (!fs.existsSync(abs)) throw new Error(`No existe el archivo: ${abs}`);
      const token = blobToken();
      if (!token) {
        throw new Error(
          `"${abs}" es un archivo local y la API oficial solo acepta URLs públicas. ` +
            'Configura INSTA_PILOT_BLOB_TOKEN (token read-write de un Vercel Blob store) o pasa una URL pública. ' +
            'Alternativa sin API: la skill instagram-reel-upload (Chrome).'
        );
      }
      const ext = path.extname(abs).toLowerCase();
      const res = await fetch(`${BLOB_API}/insta-pilot/${path.basename(abs)}`, {
        method: 'PUT',
        headers: {
          authorization: `Bearer ${token}`,
          'x-api-version': '7',
          'x-add-random-suffix': '1',
          'x-content-type': MIME[ext] || 'application/octet-stream',
        },
        body: fs.readFileSync(abs),
      });
      const body = await res.json().catch(() => ({}));
      if (!res.ok || !body.url) throw new Error(`Error subiendo a Vercel Blob (${res.status}): ${JSON.stringify(body)}`);
      uploaded.push(body.url);
      urls.push(body.url);
    }
  } catch (e) {
    await remove(uploaded);
    throw e;
  }
  return { urls, cleanup: () => remove(uploaded) };
}

async function remove(urls) {
  if (!urls.length) return;
  try {
    await fetch(`${BLOB_API}/delete`, {
      method: 'POST',
      headers: { authorization: `Bearer ${blobToken()}`, 'x-api-version': '7', 'content-type': 'application/json' },
      body: JSON.stringify({ urls }),
    });
  } catch {
    // Best effort; staged files are under insta-pilot/ for manual cleanup.
  }
}
