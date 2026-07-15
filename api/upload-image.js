import { put } from '@vercel/blob';
import { getVerifiedSession } from '../lib/auth.js';

// Accepts { filename, dataBase64, contentType } and stores the decoded image
// in Vercel Blob storage, returning its public URL. The client reads the
// selected file via FileReader.readAsDataURL() and posts the base64 payload
// as JSON (simpler than multipart parsing in a Vercel serverless function).
const MAX_BYTES = 4 * 1024 * 1024; // keep comfortably under Vercel's request body limit

// The client declares contentType itself (it's just a string in the JSON
// body) — trusting it alone would let any file up to MAX_BYTES be stored and
// served back as if it were an image. This checks the actual leading bytes
// against the real format signatures instead, covering everything the
// client's own image-compression pipeline (canvas.toBlob) can produce.
function isRealImage(buffer, contentType) {
  if (buffer.length < 12) return false;
  if (contentType === 'image/jpeg') return buffer[0] === 0xFF && buffer[1] === 0xD8 && buffer[2] === 0xFF;
  if (contentType === 'image/png') {
    const sig = [0x89, 0x50, 0x4E, 0x47, 0x0D, 0x0A, 0x1A, 0x0A];
    return sig.every((b, i) => buffer[i] === b);
  }
  if (contentType === 'image/gif') return buffer.toString('ascii', 0, 4) === 'GIF8';
  if (contentType === 'image/webp') {
    return buffer.toString('ascii', 0, 4) === 'RIFF' && buffer.toString('ascii', 8, 12) === 'WEBP';
  }
  return false;
}

export default async function handler(req, res) {
  res.setHeader('Access-Control-Allow-Credentials', 'true');
  res.setHeader('Access-Control-Allow-Origin', '*');
  res.setHeader('Access-Control-Allow-Methods', 'GET,OPTIONS,POST');
  res.setHeader('Access-Control-Allow-Headers', 'Content-Type, Authorization');

  if (req.method === 'OPTIONS') {
    return res.status(200).end();
  }
  if (req.method !== 'POST') {
    return res.status(405).json({ error: 'Method not allowed' });
  }

  // Reachable from admin AND owner salon/worker photo pickers client-side
  // (owners can create/edit their own barbers, including photos) — any
  // verified session is enough here, since the actual write authorization
  // (which salon/worker a photo URL gets attached to) is enforced separately
  // by the salons[] bulk-save path in api/sync.js, not by this endpoint.
  const session = getVerifiedSession(req);
  if (!session) {
    return res.status(401).json({ error: 'invalid_session' });
  }

  try {
    const body = typeof req.body === 'string' ? JSON.parse(req.body) : req.body;
    const { filename, dataBase64, contentType } = body || {};

    if (!filename || !dataBase64 || !contentType) {
      return res.status(400).json({ error: 'Missing filename, dataBase64 or contentType' });
    }

    const buffer = Buffer.from(dataBase64, 'base64');
    if (buffer.length > MAX_BYTES) {
      return res.status(413).json({ error: `Image too large — max ${Math.round(MAX_BYTES / 1024 / 1024)}MB` });
    }
    if (!isRealImage(buffer, contentType)) {
      return res.status(400).json({ error: 'Only real JPEG, PNG, GIF or WEBP images are allowed' });
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
    return res.status(500).json({ error: 'Errore durante il caricamento dell\'immagine.' });
  }
}
