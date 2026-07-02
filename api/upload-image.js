import { put } from '@vercel/blob';

// Accepts { filename, dataBase64, contentType } and stores the decoded image
// in Vercel Blob storage, returning its public URL. The client reads the
// selected file via FileReader.readAsDataURL() and posts the base64 payload
// as JSON (simpler than multipart parsing in a Vercel serverless function).
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
    if (!contentType.startsWith('image/')) {
      return res.status(400).json({ error: 'Only image uploads are allowed' });
    }

    const buffer = Buffer.from(dataBase64, 'base64');
    if (buffer.length > MAX_BYTES) {
      return res.status(413).json({ error: `Image too large — max ${Math.round(MAX_BYTES / 1024 / 1024)}MB` });
    }

    const token = process.env.BLOB_READ_WRITE_TOKEN;
    if (!token) {
      return res.status(403).json({ error: 'blob_not_configured', message: 'BLOB_READ_WRITE_TOKEN non configurato.' });
    }

    const safeName = filename.replace(/[^a-zA-Z0-9_.-]/g, '_');
    const blob = await put(`uploads/${Date.now()}-${safeName}`, buffer, {
      access: 'public',
      contentType,
      token
    });

    return res.status(200).json({ success: true, url: blob.url });
  } catch (error) {
    console.error('[UPLOAD-IMAGE] Error:', error);
    return res.status(500).json({ error: error.message });
  }
}
