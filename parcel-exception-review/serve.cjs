"use strict";
const http = require('node:http');
const { readFile } = require('node:fs/promises');
const path = require('node:path');
const routes = new Map([
  ['/', ['index.html', 'text/html; charset=utf-8']],
  ['/index.html', ['index.html', 'text/html; charset=utf-8']],
  ['/styles.css', ['styles.css', 'text/css; charset=utf-8']],
  ['/app.mjs', ['app.mjs', 'text/javascript; charset=utf-8']],
  ['/review.mjs', ['review.mjs', 'text/javascript; charset=utf-8']],
  ['/audit.browser.mjs', ['audit.browser.mjs', 'text/javascript; charset=utf-8']],
  ['/example.json', ['example.json', 'application/json; charset=utf-8']],
  ['/README.md', ['README.md', 'text/plain; charset=utf-8']],
]);
function createServer() {
  return http.createServer(async (request, response) => {
    response.setHeader('X-Content-Type-Options', 'nosniff');
    response.setHeader('Referrer-Policy', 'no-referrer');
    response.setHeader('Cache-Control', 'no-store');
    if (!['GET', 'HEAD'].includes(request.method)) {
      response.writeHead(405, { Allow: 'GET, HEAD' }); response.end('Read-only static server'); return;
    }
    let url;
    try { url = new URL(request.url, 'http://localhost'); } catch { response.writeHead(400); response.end(); return; }
    const route = routes.get(url.pathname);
    if (!route) { response.writeHead(404); response.end('Not found'); return; }
    try {
      const bytes = await readFile(path.join(__dirname, route[0]));
      response.writeHead(200, { 'Content-Type': route[1], 'Content-Length': bytes.length });
      response.end(request.method === 'HEAD' ? undefined : bytes);
    } catch { response.writeHead(500); response.end('Local asset unavailable. Run build.cjs if the audit wrapper is missing.'); }
  });
}
module.exports = { createServer };
if (require.main === module) {
  const port = Number(process.env.PORT || 4173);
  const host = process.env.HOST || '127.0.0.1';
  const server = createServer();
  server.on('error', error => { console.error('Preview could not start: ' + error.message); process.exitCode = 1; });
  server.listen(port, host, () => console.log('Parcel exception review: http://' + host + ':' + server.address().port));
}
