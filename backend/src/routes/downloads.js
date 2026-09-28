import { Router } from 'express';
import { query } from '../db.js';
import { requireAuth } from '../middleware/auth.js';
import { getFile } from '../utils/s3.js';
import stream from 'stream';
import { promisify } from 'util';

const pipeline = promisify(stream.pipeline);
const router = Router();

/**
 * GET /api/albums/:id/download — скачать альбом ZIP-архивом
 * Роли: admin, editor (гость — только просмотр)
 */
router.get('/albums/:id/download', requireAuth, async (req, res) => {
  // Проверка роли
  if (!['admin', 'editor'].includes(req.user.role)) {
    return res.status(403).json({ error: 'Недостаточно прав' });
  }

  const album = await query('SELECT * FROM albums WHERE id = $1', [req.params.id]);
  if (!album.rows[0]) return res.status(404).json({ error: 'Альбом не найден' });

  const media = await query(
    'SELECT * FROM media WHERE album_id = $1 AND deleted_at IS NULL ORDER BY COALESCE(date_taken, created_at)',
    [req.params.id]
  );

  // Имя файла: транслит названия альбома
  const safeTitle = album.rows[0].title
    .toLowerCase()
    .replace(/[^a-z0-9]+/gi, '-')
    .replace(/^-+|-+$/g, '') || 'album';
  const zipName = `${safeTitle}.zip`;

  res.setHeader('Content-Type', 'application/zip');
  res.setHeader('Content-Disposition', `attachment; filename="${zipName}"`);
  res.setHeader('Cache-Control', 'no-store');

  // Archiver — потоковая упаковка в ZIP (не грузит всё в память)
  let archiver;
  try {
    archiver = (await import('archiver')).default;
  } catch {
    return res.status(500).json({ error: 'Модуль архивации недоступен' });
  }

  const archive = archiver('zip', { zlib: { level: 6 } });

  archive.on('warning', (err) => {
    if (err.code === 'ENOENT') console.warn('ZIP: пропущен файл', err.message);
  });
  archive.on('error', (err) => {
    console.error('ZIP ошибка:', err.message);
    if (!res.headersSent) res.status(500).end('Ошибка при создании архива');
  });

  // Отдаём ZIP браузеру
  archive.pipe(res);

  // Добавляем каждый файл из MinIO в архив (потоково)
  let added = 0;
  for (const m of media.rows) {
    try {
      const body = await getFile(m.storage_key);
      const ext = m.mime_type.split('/')[1] || 'bin';
      archive.append(body, { name: `${m.id}-${sanitize(m.filename) || `file.${ext}`}` });
      added++;
    } catch (err) {
      console.error(`ZIP: не удалось добавить файл #${m.id}:`, err.message);
    }
  }

  archive.finalize();
});

function sanitize(name) {
  // Безопасное имя файла в архиве (без путей, слэшей)
  return String(name || '').replace(/[^\w.\-а-яА-ЯёЁ ]+/g, '_').slice(0, 80);
}

export default router;