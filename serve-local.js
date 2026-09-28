// Простой статический HTTP-сервер для локальной проверки index.html.
// Раздаёт файлы из frontend/public (то же, что nginx в проде).
// Запуск:  node serve-local.js
// Открыть: http://localhost:8080
import { createServer } from 'node:http';
import { readFile } from 'node:fs/promises';
import { extname, join, normalize, dirname } from 'node:path';
import { fileURLToPath } from 'node:url';

const __filename = fileURLToPath(import.meta.url);
const __dirname = dirname(__filename);

const ROOT = join(__dirname, 'frontend', 'public');
const PORT = process.env.PORT || 8080;

const MIME = {
  '.html': 'text/html; charset=utf-8',
  '.css': 'text/css; charset=utf-8',
  '.js': 'application/javascript; charset=utf-8',
  '.json': 'application/json; charset=utf-8',
  '.svg': 'image/svg+xml',
  '.png': 'image/png',
  '.jpg': 'image/jpeg',
  '.webp': 'image/webp',
  '.ico': 'image/x-icon',
};

const server = createServer(async (req, res) => {
  try {
    // Только GET
    if (req.method !== 'GET' && req.method !== 'HEAD') {
      res.writeHead(405).end('Method Not Allowed');
      return;
    }

    let pathname = decodeURIComponent(new URL(req.url, `http://${req.headers.host}`).pathname);

    // Защита от выхода за пределы public (../ и т.п.)
    const rel = normalize(pathname).replace(/^([/\\])+/, '');
    const filePath = join(ROOT, rel);

    if (!filePath.startsWith(ROOT)) {
      res.writeHead(403).end('Forbidden');
      return;
    }

    let data;
    try {
      data = await readFile(filePath);
    } catch {
      // Если файла нет, а путь без расширения — пробуем index.html (SPA)
      if (!extname(pathname)) {
        data = await readFile(join(ROOT, 'index.html'));
      } else {
        res.writeHead(404).end('Not Found');
        return;
      }
    }

    const ext = extname(filePath) || '.html';
    res.writeHead(200, {
      'Content-Type': MIME[ext] || 'application/octet-stream',
      'Cache-Control': 'no-cache',
    });
    res.end(data);
  } catch (err) {
    res.writeHead(500).end('Server Error');
    console.error(err);
  }
});

server.listen(PORT, () => {
  console.log(`Семейный архив (локально): http://localhost:${PORT}`);
  console.log(`Папка: ${ROOT}`);
});