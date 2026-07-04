/* ================================================================
   TRIMIO — LOCAL DEV SERVER
   Serves the static app AND routes any /api/<name> request to the matching
   api/<name>.js handler, using the credentials from .env.local (same
   values `vercel dev` would use). Does not require Vercel CLI login.

   NOTE: this talks to the SAME live Vercel/Upstash KV database as the
   production deployment (https://trimio-two.vercel.app/) — bookings,
   logins and salon changes made here are real and will also be visible
   in production, they are not sandboxed.

   Run with: node dev-server.js
================================================================ */
import http from 'http';
import fs from 'fs';
import path from 'path';
import { fileURLToPath, pathToFileURL } from 'url';

const __dirname = path.dirname(fileURLToPath(import.meta.url));

function loadDotEnvLocal() {
  const envPath = path.join(__dirname, '.env.local');
  if (!fs.existsSync(envPath)) return;
  for (const line of fs.readFileSync(envPath, 'utf8').split('\n')) {
    const m = line.match(/^\s*([A-Z0-9_]+)\s*=\s*"?([^"\r\n]*)"?\s*$/i);
    if (m && !(m[1] in process.env)) process.env[m[1]] = m[2];
  }
}
loadDotEnvLocal();

const PORT = process.env.PORT || 3000;

const MIME = {
  '.html': 'text/html; charset=utf-8',
  '.js': 'text/javascript; charset=utf-8',
  '.css': 'text/css; charset=utf-8',
  '.json': 'application/json; charset=utf-8',
  '.svg': 'image/svg+xml',
  '.png': 'image/png',
  '.ico': 'image/x-icon',
  '.webmanifest': 'application/manifest+json'
};

// Any request to /api/<name> is routed to api/<name>.js if that file exists
// — mirrors Vercel's own automatic routing convention, so a new file under
// api/ never needs a matching entry added here by hand (a previous
// hardcoded-map version of this silently 404'd new endpoints locally while
// they worked fine on real Vercel, which is exactly the kind of gap that's
// easy to forget and hard to notice).
const apiDir = path.join(__dirname, 'api');
function resolveApiRoute(pathname) {
  const match = pathname.match(/^\/api\/([\w-]+)$/);
  if (!match) return null;
  const file = path.join(apiDir, `${match[1]}.js`);
  return fs.existsSync(file) ? file : null;
}

function readBody(req) {
  return new Promise((resolve, reject) => {
    let data = '';
    req.on('data', chunk => { data += chunk; });
    req.on('end', () => {
      if (!data) return resolve(undefined);
      try { resolve(JSON.parse(data)); } catch { resolve(data); }
    });
    req.on('error', reject);
  });
}

const server = http.createServer(async (req, res) => {
  const url = new URL(req.url, `http://${req.headers.host}`);
  const { pathname } = url;
  const apiFile = resolveApiRoute(pathname);

  if (apiFile) {
    res.status = (code) => { res.statusCode = code; return res; };
    res.json = (body) => { res.setHeader('Content-Type', 'application/json'); res.end(JSON.stringify(body)); return res; };
    try {
      const mod = await import(`${pathToFileURL(apiFile)}?t=${Date.now()}`);
      req.body = await readBody(req);
      // Vercel populates req.query from the URL's search params — handlers
      // like api/manifest.js rely on it, so mirror that here too.
      req.query = Object.fromEntries(url.searchParams);
      await mod.default(req, res);
    } catch (e) {
      console.error(`[dev-server] ${pathname} error:`, e);
      res.statusCode = 500;
      res.end(JSON.stringify({ error: e.message }));
    }
    return;
  }

  const filePath = path.join(__dirname, pathname === '/' ? 'index.html' : pathname);
  if (!filePath.startsWith(__dirname)) { res.statusCode = 403; res.end('Forbidden'); return; }
  fs.readFile(filePath, (err, content) => {
    if (err) { res.statusCode = 404; res.end('Not found'); return; }
    res.setHeader('Content-Type', MIME[path.extname(filePath)] || 'application/octet-stream');
    res.end(content);
  });
});

server.listen(PORT, () => {
  console.log(`Trimio dev server running at http://localhost:${PORT}`);
  console.log(`KV configured: ${process.env.KV_REST_API_URL ? 'yes (from .env.local)' : 'NO — /api/* will return database_suspended'}`);
});
