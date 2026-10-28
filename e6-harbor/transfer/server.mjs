import { createServer } from 'node:http';
import { readFile } from 'node:fs/promises';
import { fileURLToPath, pathToFileURL } from 'node:url';
import path from 'node:path';
const root = fileURLToPath(new URL('.', import.meta.url));
const assets = new Map([['index.html', 'text/html'], ['app.mjs', 'text/javascript'], ['rota.mjs', 'text/javascript'], ['styles.css', 'text/css'], ['README.md', 'text/plain'], ['examples/harbor-rota.json', 'application/json'], ['examples/harbor-rota.csv', 'text/csv']]);
export async function startServer(port = 4173) {
  const server = createServer(async (req, res) => {
    if (!['GET', 'HEAD'].includes(req.method)) { res.writeHead(405, { Allow: 'GET, HEAD' }); res.end(); return; }
    let pathname; try { pathname = decodeURIComponent(new URL(req.url, 'http://localhost').pathname).slice(1) || 'index.html'; } catch { res.writeHead(400); res.end(); return; }
    if (!assets.has(pathname)) { res.writeHead(404); res.end('Not found'); return; }
    try {
      const data = await readFile(path.join(root, pathname));
      res.writeHead(200, { 'Content-Type': assets.get(pathname) + '; charset=utf-8', 'Cache-Control': 'no-store', 'X-Content-Type-Options': 'nosniff', 'Referrer-Policy': 'no-referrer', 'Content-Security-Policy': "default-src 'self'; script-src 'self'; style-src 'self'; img-src 'self' data:; connect-src 'self'; object-src 'none'; base-uri 'none'; frame-ancestors 'none'; form-action 'none'" });
      res.end(req.method === 'HEAD' ? undefined : data);
    } catch { res.writeHead(500); res.end('Unable to read app asset'); }
  });
  await new Promise((resolve, reject) => { server.once('error', reject); server.listen(port, '127.0.0.1', resolve); });
  return server;
}
if (process.argv[1] && import.meta.url === pathToFileURL(path.resolve(process.argv[1])).href) {
  const port = Number(process.env.PORT || 4173);
  if (!Number.isInteger(port) || port < 0 || port > 65535) throw new Error('PORT must be an integer from 0 to 65535.');
  const server = await startServer(port);
  console.log(`Harbor companion: http://127.0.0.1:${server.address().port}/`);
}
