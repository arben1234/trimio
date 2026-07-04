import fs from 'fs';
import path from 'path';

// Serves index.html for /s/SLUG salon pages with the CORRECT manifest link
// baked into the raw HTML. iOS Safari reads <link rel="manifest"> from the
// original document when adding to the Home Screen and ignores the href
// swap done later by JavaScript — with the static /manifest.json
// (start_url "/") in place, every installed icon opened the admin login no
// matter what the client-side code did. Baking /api/manifest?start=/s/SLUG
// server-side removes JavaScript from the equation entirely.
export default function handler(req, res) {
  let slug = typeof req.query.slug === 'string' ? req.query.slug : '';
  if (!/^[\w-]{1,60}$/.test(slug)) slug = '';

  let html;
  try {
    html = fs.readFileSync(path.join(process.cwd(), 'index.html'), 'utf8');
  } catch (e) {
    return res.status(500).json({ error: 'index.html not bundled: ' + e.message });
  }

  if (slug) {
    html = html.replace(
      'href="/manifest.json"',
      'href="/api/manifest?start=' + encodeURIComponent('/s/' + slug) + '"'
    );
  }

  res.setHeader('Content-Type', 'text/html; charset=utf-8');
  res.setHeader('Cache-Control', 'no-store');
  return res.status(200).end(html);
}
