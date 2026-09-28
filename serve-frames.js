// Мини-сервер для просмотра набросков фоторамки.
// Раздаёт frame-designs на порту 8090.
// Запуск: node serve-frames.js → http://localhost:8090
import { createServer } from 'node:http';
import { readFile } from 'node:fs/promises';
import { extname, join, normalize, dirname } from 'node:path';
import { fileURLToPath } from 'node:url';

const __filename = fileURLToPath(import.meta.url);
const __dirname = dirname(__filename);
const ROOT = join(__dirname, 'frame-designs');
const PORT = 8090;

const MIME = {
  '.html': 'text/html; charset=utf-8',
  '.css': 'text/css; charset=utf-8',
  '.js': 'application/javascript; charset=utf-8',
  '.svg': 'image/svg+xml',
  '.png': 'image/png',
};

createServer(async (req, res) => {
  try {
    let pathname = decodeURIComponent(new URL(req.url, `http://${req.headers.host}`).pathname);
    if (pathname === '/') pathname = '/index.html';

    const rel = normalize(pathname).replace(/^([/\\])+/, '');
    const filePath = join(ROOT, rel);
    if (!filePath.startsWith(ROOT)) { res.writeHead(403).end('Forbidden'); return; }

    try {
      const data = await readFile(filePath);
      const ext = extname(filePath);
      res.writeHead(200, { 'Content-Type': MIME[ext] || 'application/octet-stream', 'Cache-Control': 'no-cache' });
      res.end(data);
    } catch {
      // Листинг директории
      const { readdir } = await import('node:fs/promises');
      const files = await readdir(ROOT);
      const links = files.filter((f) => f.endsWith('.html'))
        .map((f) => `<li><a href="/${f}">${f}</a></li>`).join('\n');
      res.writeHead(200, { 'Content-Type': 'text/html; charset=utf-8' });
      res.end(`<meta charset="utf-8"><h2>Наброски фоторамки</h2><ul>${links}</ul>`);
    }
  } catch (err) {
    res.writeHead(500).end('Error');
    console.error(err);
  }
}).listen(PORT, () => {
  console.log(`Наброски фоторамки: http://localhost:${PORT}`);
});