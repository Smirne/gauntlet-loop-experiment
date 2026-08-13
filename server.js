// Zero-dependency static file server for the MICRO GAUNTLET dev preview.
//
// macOS/Linux port of server.ps1. Same contract, byte for byte where it
// matters: same port, same no-cache headers, same /__shot capture sink that
// writes shots/<name>.png from a POSTed data URL. Keep the two in step — the
// capture pipeline and every review agent depend on that endpoint existing.
//
//   node server.js
//
// Node ships with macOS dev setups; the Windows box this started on had
// neither Node nor Python, which is why the .NET HttpListener version exists.

const http = require('node:http');
const fs = require('node:fs');
const path = require('node:path');

const ROOT = __dirname;
const PORT = process.env.MG_PORT ? Number(process.env.MG_PORT) : 8791;

const MIME = {
  '.html': 'text/html; charset=utf-8',
  '.js': 'text/javascript; charset=utf-8',
  '.mjs': 'text/javascript; charset=utf-8',
  '.css': 'text/css; charset=utf-8',
  '.json': 'application/json; charset=utf-8',
  '.svg': 'image/svg+xml',
  '.png': 'image/png',
  '.jpg': 'image/jpeg',
  '.webp': 'image/webp',
  '.ico': 'image/x-icon',
  '.wasm': 'application/wasm',
  '.map': 'application/json; charset=utf-8',
  '.woff2': 'font/woff2',
  '.bin': 'application/octet-stream',
};

const server = http.createServer((req, res) => {
  let rel;
  try {
    rel = decodeURIComponent(new URL(req.url, 'http://localhost').pathname);
  } catch {
    res.writeHead(400).end('400 Bad Request');
    return;
  }

  // Capture sink: the page POSTs a PNG data URL here and we write it to
  // shots/. This is how screenshots get to disk for review agents without
  // depending on the browser pane compositing frames.
  if (rel === '/__shot') {
    const chunks = [];
    req.on('data', (c) => chunks.push(c));
    req.on('end', () => {
      try {
        const payload = Buffer.concat(chunks).toString('utf8');
        const q = new URL(req.url, 'http://localhost').searchParams;
        const name = (q.get('name') || 'shot').replace(/[^A-Za-z0-9_\-.]/g, '_');
        const comma = payload.indexOf(',');
        const b64 = payload.startsWith('data:') && comma > 0 ? payload.slice(comma + 1) : payload;
        const shotDir = path.join(ROOT, 'shots');
        fs.mkdirSync(shotDir, { recursive: true });
        const outPath = path.join(shotDir, name + '.png');
        fs.writeFileSync(outPath, Buffer.from(b64, 'base64'));
        res.writeHead(200, { 'Content-Type': 'application/json; charset=utf-8' });
        res.end(JSON.stringify({ ok: true, path: 'shots/' + name + '.png' }));
        console.log(`SHOT shots/${name}.png (${Math.round(b64.length / 1365)} KB)`);
      } catch (err) {
        res.writeHead(500).end('500 ' + err.message);
        console.log('500 /__shot :: ' + err.message);
      }
    });
    return;
  }

  if (rel === '/' || rel === '') rel = '/index.html';

  // Contain every request inside the served root.
  const full = path.resolve(ROOT, '.' + rel);
  if (full !== ROOT && !full.startsWith(ROOT + path.sep)) {
    res.writeHead(403).end('403 Forbidden');
    return;
  }

  fs.stat(full, (err, st) => {
    if (err || !st.isFile()) {
      res.writeHead(404, { 'Content-Type': 'text/plain; charset=utf-8' });
      res.end('404 Not Found: ' + rel);
      console.log('404 ' + rel);
      return;
    }
    const ct = MIME[path.extname(full).toLowerCase()] || 'application/octet-stream';
    res.writeHead(200, {
      'Content-Type': ct,
      'Content-Length': st.size,
      'Cache-Control': 'no-store, no-cache, must-revalidate, max-age=0',
      Pragma: 'no-cache',
    });
    fs.createReadStream(full).pipe(res);
    console.log('200 ' + rel);
  });
});

server.listen(PORT, '127.0.0.1', () => {
  console.log(`MICRO GAUNTLET dev server listening on http://localhost:${PORT}/`);
  console.log(`Serving root: ${ROOT}`);
});
