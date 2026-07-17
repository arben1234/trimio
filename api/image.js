// Serves images stored in Upstash KV by api/upload-image.js (the "img:<id>"
// keys, saved as "contentType|base64"). Used as the storage backend while
// the Vercel Blob store is suspended — URLs look like /api/image?id=abc123.
// Long-lived caching is critical here: the id never changes content, so
// browsers and the CDN may cache forever (vercel.json carves this path out
// of the global no-store rule).
export default async function handler(req, res) {
  const id = typeof req.query.id === 'string' ? req.query.id : '';
  if (!/^[\w-]{1,40}$/.test(id)) {
    return res.status(400).json({ error: 'Invalid image id' });
  }

  const kvUrl = process.env.KV_REST_API_URL;
  const kvToken = process.env.KV_REST_API_TOKEN;
  if (!kvUrl || !kvToken) {
    return res.status(500).json({ error: 'KV database not configured' });
  }

  try {
    const resp = await fetch(`${kvUrl}/get/img:${id}`, {
      headers: { Authorization: `Bearer ${kvToken}` }
    });
    if (!resp.ok) return res.status(502).json({ error: 'KV read failed' });
    const data = await resp.json();
    if (!data.result) return res.status(404).json({ error: 'Image not found' });

    let val = data.result;
    // Values are written as JSON strings by the REST API — unwrap if needed.
    if (typeof val === 'string' && val.startsWith('"')) {
      try { val = JSON.parse(val); } catch { /* keep as-is */ }
    }
    const sep = val.indexOf('|');
    if (sep < 1) return res.status(500).json({ error: 'Corrupt image record' });
    const contentType = val.slice(0, sep);
    const buffer = Buffer.from(val.slice(sep + 1), 'base64');

    res.setHeader('Content-Type', contentType);
    res.setHeader('Cache-Control', 'public, max-age=31536000, s-maxage=31536000, immutable');
    // Magic-byte validation at upload time (api/upload-image.js) can't rule
    // out an image/HTML polyglot (a file that's simultaneously a valid GIF/
    // JPEG and valid HTML/script) — without this, a sniff-happy user agent
    // could still render the response body as HTML instead of the declared
    // image type. Explicit here (in addition to the global header in
    // vercel.json) since this is the one response most worth guaranteeing
    // it on regardless of how the two might interact.
    res.setHeader('X-Content-Type-Options', 'nosniff');
    return res.status(200).end(buffer);
  } catch (err) {
    console.error('[IMAGE] Error:', err);
    return res.status(500).json({ error: 'Errore del server.' });
  }
}
