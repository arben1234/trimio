import { put } from '@vercel/blob';

// Accepts { filename, dataBase64, contentType } and stores the decoded image
// or short video in Vercel Blob storage, returning its public URL. The client
// reads the selected file via FileReader.readAsDataURL() and posts the base64
// payload as JSON (simpler than multipart parsing in a Vercel serverless
// function) — this keeps the request body limit as the hard cap, so videos
// must stay short/small (a few seconds), not full-length clips.
const MAX_BYTES = 4 * 1024 * 1024; // keep comfortably under Vercel's request body limit

export default async function handler(req, res) {
  res.setHeader('Access-Control-Allow-Credentials', 'true');
  res.setHeader('Access-Control-Allow-Origin', '*');
  res.setHeader('Access-Control-Allow-Methods', 'GET,OPTIONS,POST');
  res.setHeader('Access-Control-Allow-Headers', 'Content-Type');

  if (req.method === 'OPTIONS') {
    return res.status(200).end();
  }
  if (req.method !== 'POST') {
    return res.status(405).json({ error: 'Method not allowed' });
  }

  try {
    const body = typeof req.body === 'string' ? JSON.parse(req.body) : req.body;
    const { filename, dataBase64, contentType } = body || {};

    if (!filename || !dataBase64 || !contentType) {
      return res.status(400).json({ error: 'Missing filename, dataBase64 or contentType' });
    }
    if (!contentType.startsWith('image/') && !contentType.startsWith('video/')) {
      return res.status(400).json({ error: 'Only image or video uploads are allowed' });
    }

    const buffer = Buffer.from(dataBase64, 'base64');
    if (buffer.length > MAX_BYTES) {
      return res.status(413).json({ error: `File troppo grande — max ${Math.round(MAX_BYTES / 1024 / 1024)}MB` });
    }

    // Preferred backend: Vercel Blob (when the store works).
    const token = process.env.BLOB_READ_WRITE_TOKEN;
    if (token) {
      try {
        const safeName = filename.replace(/[^a-zA-Z0-9_.-]/g, '_');
        const blob = await put(`uploads/${Date.now()}-${safeName}`, buffer, {
          access: 'public',
          contentType,
          token
        });
        return res.status(200).json({ success: true, url: blob.url });
      } catch (blobErr) {
        // e.g. "This store has been suspended" — fall through to KV storage.
        console.warn('[UPLOAD-IMAGE] Blob failed, falling back to KV:', blobErr.message);
      }
    }

    // Fallback backend: Upstash KV ("img:<id>" = "contentType|base64"),
    // served back by /api/image?id=<id>. The client compresses images before
    // uploading, so they fit comfortably under Upstash's ~1MB request cap.
    const kvUrl = process.env.KV_REST_API_URL;
    const kvToken = process.env.KV_REST_API_TOKEN;
    if (!kvUrl || !kvToken) {
      return res.status(403).json({ error: 'storage_not_configured', message: 'Nessuno storage immagini configurato.' });
    }
    if (dataBase64.length > 900000) {
      return res.status(413).json({ error: 'Immagine troppo grande — riprova con una foto più piccola.' });
    }
    const id = Date.now().toString(36) + Math.random().toString(36).slice(2, 8);
    const setResp = await fetch(`${kvUrl}/set/img:${id}`, {
      method: 'POST',
      headers: { Authorization: `Bearer ${kvToken}`, 'Content-Type': 'application/json' },
      body: JSON.stringify(contentType + '|' + dataBase64)
    });
    if (!setResp.ok) {
      const t = await setResp.text().catch(() => '');
      throw new Error('KV write failed: ' + t.slice(0, 200));
    }
    return res.status(200).json({ success: true, url: `/api/image?id=${id}` });
  } catch (error) {
    console.error('[UPLOAD-IMAGE] Error:', error);
    return res.status(500).json({ error: error.message });
  }
}
