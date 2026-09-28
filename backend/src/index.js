import 'dotenv/config';
import express from 'express';
import cors from 'cors';
import rateLimit from 'express-rate-limit';
import { createReadStream } from 'node:fs';
import { dirname, join, normalize } from 'node:path';
import { fileURLToPath } from 'node:url';

import { initS3, getBucket, getFile } from './utils/s3.js';
import authRouter from './routes/auth.js';
import mediaRouter from './routes/media.js';
import albumsRouter from './routes/albums.js';
import adminRouter from './routes/admin.js';
import personsRouter from './routes/persons.js';
import tagsRouter from './routes/tags.js';
import extrasRouter from './routes/extras.js';
import invitesRouter from './routes/invites.js';
import downloadsRouter from './routes/downloads.js';
import passwordRouter from './routes/password.js';
import { bootstrapAdmin } from './init-admin.js';
import { cleanupTrash } from './utils/cleanup.js';

const __dirname = dirname(fileURLToPath(import.meta.url));
const PROJECT_ROOT = join(__dirname, '..', '..');

const app = express();
const PORT = process.env.PORT || 3000;
const useMinio = (process.env.STORAGE_DRIVER === 'minio') || !!process.env.MINIO_ROOT_PASSWORD;

// ---------- CORS ----------
// В docker: строго свой домен. В local: всё на одном порту — разрешаем всё.
const allowedOrigin = process.env.APP_URL || 'http://localhost';
app.use(cors(
  useMinio
    ? { origin: allowedOrigin, credentials: true, methods: ['GET','POST','DELETE','PUT','PATCH','OPTIONS'], allowedHeaders: ['Content-Type','Authorization'] }
    : { origin: true, credentials: true }
));

// ---------- Общие middleware ----------
app.use(express.json());

// Ограничение запросов: защита от перебора паролей и флуда
const authLimiter = rateLimit({
  windowMs: 15 * 60 * 1000,
  max: 100,
  standardHeaders: true,
  legacyHeaders: false,
  message: { error: 'Слишком много запросов. Попробуйте позже.' },
});
app.use('/api/auth', authLimiter);

// ---------- Маршруты API ----------
app.use('/api/auth', authRouter);
app.use('/api/albums', albumsRouter);
app.use('/api/media', mediaRouter);
app.use('/api/admin', adminRouter);
app.use('/api/persons', personsRouter);
app.use('/api/tags', tagsRouter);
app.use('/api/map', extrasRouter);
app.use('/api/invites', invitesRouter);
app.use('/api/password', passwordRouter);
app.use('/api', downloadsRouter);

app.get('/api/health', (req, res) => res.json({ ok: true }));

// ---------- Локальные файлы (только режим local) ----------
// В MinIO presigned URL работают напрямую; в local файлы раздаём через API.
if (!useMinio) {
  const filesRoot = join(PROJECT_ROOT, 'data', 'files');
  app.get('/api/files/*', (req, res) => {
    try {
      const key = decodeURIComponent(req.path.replace('/api/files/', ''));
      const safe = String(key).replace(/[^a-zA-Z0-9/._-]/g, '_');
      const p = join(filesRoot, normalize(safe));
      if (!p.startsWith(filesRoot)) return res.status(403).end('Forbidden');
      res.sendFile(p, (err) => {
        if (err) res.status(404).end('Not Found');
      });
    } catch {
      res.status(400).end('Bad Request');
    }
  });
  console.log('Локальный режим: раздаю файлы через /api/files/*');

  // ---------- Раздача фронтенда (только local) ----------
  const publicDir = join(PROJECT_ROOT, 'frontend', 'public');
  // Запрещаем кэширование HTML/JS/CSS, чтобы браузер всегда брал свежую версию
  app.use((req, res, next) => {
    if (req.path.startsWith('/api/')) return next();
    res.set('Cache-Control', 'no-store, no-cache, must-revalidate, proxy-revalidate');
    res.set('Pragma', 'no-cache');
    res.set('Expires', '0');
    next();
  });
  app.use(express.static(publicDir));

  // SPA fallback
  app.get(/^\/(?!api).*/, (req, res) => {
    res.set('Cache-Control', 'no-store, no-cache, must-revalidate, proxy-revalidate');
    res.sendFile(join(publicDir, 'index.html'));
  });
}

// ---------- Запуск ----------
await initS3();
await bootstrapAdmin();

app.listen(PORT, () => {
  console.log(`API запущен на порту ${PORT}`);
  if (!useMinio) console.log(`Откройте: http://localhost:${PORT}`);
});

// ---------- Фоновая очистка корзины (раз в 6 часов) ----------
const CLEANUP_INTERVAL_MS = 6 * 60 * 60 * 1000;
setInterval(cleanupTrash, CLEANUP_INTERVAL_MS);
cleanupTrash(); // при старте тоже выполняем