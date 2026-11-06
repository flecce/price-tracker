// Tiny static server for local development: `node dev-server.js` → http://localhost:8080
// (Google login requires http://localhost or https — opening index.html as file:// won't work.)
const http = require('http');
const fs = require('fs');
const path = require('path');

const PORT = Number(process.env.PORT) || 8080;
const ROOT = __dirname;
const TYPES = {
  '.html': 'text/html; charset=utf-8',
  '.js': 'text/javascript; charset=utf-8',
  '.css': 'text/css; charset=utf-8',
  '.svg': 'image/svg+xml',
  '.png': 'image/png',
  '.json': 'application/json',
  '.webmanifest': 'application/manifest+json',
};

http
  .createServer((req, res) => {
    let p = decodeURIComponent(new URL(req.url, 'http://x').pathname);
    if (p.endsWith('/')) p += 'index.html';
    const file = path.normalize(path.join(ROOT, p));
    if (!file.startsWith(ROOT)) return res.writeHead(403).end();
    fs.readFile(file, (err, data) => {
      if (err) return res.writeHead(404).end('Not found');
      res.writeHead(200, { 'Content-Type': TYPES[path.extname(file)] || 'application/octet-stream', 'Cache-Control': 'no-cache' });
      res.end(data);
    });
  })
  .listen(PORT, () => console.log(`Price Tracker → http://localhost:${PORT}`));
