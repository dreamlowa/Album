import { Router } from 'express';
import multer from 'multer';
import path from 'path';
import fs from 'fs/promises';
import os from 'os';
import crypto from 'crypto';
import { query, queryOne, run } from '../db.js';
import { requireAuth, requireRole } from '../middleware/auth.js';
import { uploadFile, getPresignedUrl } from '../utils/s3.js';
import { createThumbnail, convertVideo, mediaToDto } from '../utils/media.js';
import { readExif } from '../utils/exif.js';

const router = Router();

// ---------- Валидация типов файлов ----------
// Разрешены ТОЛЬКО изображения и видео. Исполняемые файлы, скрипты,
// HTML (XSS), архивы — отклоняются и по MIME, и по расширению.
const ALLOWED_MIME = new Set([
  'image/jpeg', 'image/png', 'image/gif', 'image/webp', 'image/heic', 'image/heif',
  'video/mp4', 'video/quicktime', 'video/webm', 'video/x-matroska', 'video/x-msvideo', 'video/3gpp',
]);

const BLOCKED_EXT = new Set([
  '.exe', '.bat', '.cmd', '.sh', '.com', '.msi', '.dll', '.scr',
  '.html', '.htm', '.svg', '.php', '.js', '.jsp', '.asp', '.aspx',
  '.zip', '.rar', '.7z', '.tar', '.gz',
]);

function isAllowed(filename, mimeType) {
  if (!ALLOWED_MIME.has(mimeType)) return false;
  const ext = path.extname(filename || '').toLowerCase();
  if (BLOCKED_EXT.has(ext)) return false;
  // Двойное расширение (photo.jpg.exe) — запрещаем
  if ((filename || '').split('.').length > 2) return false;
  return true;
}

// ---------- Multer: файлы в память/временную папку ----------
const upload = multer({
  storage: multer.diskStorage({
    destination: os.tmpdir(),   // системная временная папка (Windows/Linux)
    filename: (req, file, cb) => {
      cb(null, `${Date.now()}-${crypto.randomBytes(6).toString('hex')}`);
    },
  }),
  limits: {
    fileSize: parseInt(process.env.MAX_FILE_SIZE || '524288000', 10),
  },
});

// ---------- Загрузка ----------
/**
 * POST /api/media/upload
 * multipart/form-data: file, albumId (optional)
 * Роли: admin, editor
 */
router.post('/upload', requireAuth, requireRole('admin', 'editor'), upload.single('file'), async (req, res) => {
  if (!req.file) return res.status(400).json({ error: 'Файл не передан' });

  const { albumId, parentId } = req.body;
  const mimeType = req.file.mimetype;
  const filename = req.file.originalname || 'file';

  if (!isAllowed(filename, mimeType)) {
    await fs.rm(req.file.path, { force: true });
    return res.status(415).json({
      error: 'Такой тип файла загружать нельзя. Разрешены фото (JPG, PNG, WebP, HEIC) и видео (MP4, MOV).',
    });
  }

  try {
    const kind = mimeType.startsWith('video/') ? 'video' : 'image';
    const ext = path.extname(filename).toLowerCase() || (kind === 'image' ? '.jpg' : '.mp4');

    // Конвертация HEIC/HEIF (iPhone) → JPEG — чтобы превью и просмотр работали везде
    let storedMime = mimeType;
    let storedExt = ext;
    let convertedHeic = false;

    if (kind === 'image' && (mimeType === 'image/heic' || mimeType === 'image/heif')) {
      try {
        const sharp = (await import('sharp')).default;
        const jpegBuffer = await sharp(req.file.path)
          .rotate()
          .jpeg({ quality: 90 })
          .toBuffer();
        await fs.writeFile(req.file.path + '.jpg', jpegBuffer);
        req.file.path = req.file.path + '.jpg';
        req.file.size = jpegBuffer.length;
        storedMime = 'image/jpeg';
        storedExt = '.jpg';
        convertedHeic = true;
        console.log('HEIC → JPEG конвертирован:', filename);
      } catch (err) {
        console.warn('Не удалось сконвертировать HEIC:', err.message);
      }
    }

    const storageKey = `${kind}s/${crypto.randomUUID()}${storedExt}`;

    // 1) Залить оригинал в MinIO
    const fileBuffer = await fs.readFile(req.file.path);
    await uploadFile(storageKey, fileBuffer, storedMime);

    // 2) Превью для изображений
    let thumbKey = null;
    if (kind === 'image') {
      thumbKey = await createThumbnail({ inputPath: req.file.path, mimeType });
    }

    // 3) EXIF: дата съёмки + GPS (только для фото)
    let dateTaken = null;
    let latitude = null;
    let longitude = null;
    if (kind === 'image') {
      const exif = await readExif(req.file.path);
      dateTaken = exif.dateTaken;
      latitude = exif.latitude;
      longitude = exif.longitude;
    }

    // 3) Конвертация видео (MP4/H.264) + poster — асинхронно после ответа
    let convertedKey = null;
    let posterKey = null;
    let isConverted = false;

    let mediaRow;
    if (kind === 'video') {
      // Сначала сохраняем запись, потом догоняем конвертацию
      mediaRow = await queryOne(
        `INSERT INTO media (album_id, uploaded_by, filename, storage_key, thumb_key, mime_type, kind, size_bytes)
         VALUES ($1, $2, $3, $4, $5, $6, $7, $8)
         RETURNING *`,
        [albumId || null, req.user.id, filename, storageKey, thumbKey, mimeType, kind, req.file.size]
      );
      res.status(201).json({ media: await mediaToDto(mediaRow) });

      // Фоновая конвертация
      convertVideo({ inputPath: req.file.path })
        .then(async (result) => {
          if (!result) return;
          await query(
            `UPDATE media SET converted_key = $1, poster_key = $2, is_converted = TRUE WHERE id = $3`,
            [result.convertedKey, result.posterKey, mediaRow.id]
          );
          console.log(`Видео #${mediaRow.id} сконвертировано`);
        })
        .catch((err) => console.error('Фоновая конвертация упала:', err.message))
        .finally(() => fs.rm(req.file.path, { force: true }).catch(() => {}));
      return;
    }

    // Для изображений — синхронно
    mediaRow = await queryOne(
      `INSERT INTO media (album_id, uploaded_by, filename, storage_key, thumb_key, mime_type, kind, size_bytes, date_taken, latitude, longitude)
       VALUES ($1, $2, $3, $4, $5, $6, $7, $8, $9, $10, $11)
       RETURNING *`,
      [albumId || null, req.user.id, filename, storageKey, thumbKey, mimeType, kind, req.file.size,
       dateTaken, latitude, longitude]
    );
    await fs.rm(req.file.path, { force: true }).catch(() => {});

    // Ставим задачу распознавания лиц, если ML-сервис подключён
    // (таблица face_jobs существует — см. db/schema.sql; если ML не включён,
    //  INSERT просто ждёт — воркер обработает позже)
    if (kind === 'image') {
      try {
        await query(
          `INSERT INTO face_jobs (media_id, status) VALUES ($1, 'pending')
           ON CONFLICT (media_id) DO UPDATE SET status = 'pending', updated_at = now()`,
          [mediaRow.id]
        );
      } catch (err) {
        console.warn('face_jobs недоступна (ML не подключён):', err.message);
      }
    }

    res.status(201).json({ media: await mediaToDto(mediaRow) });

    // Если передан parentId — создаём версию (история правок)
    if (parentId) {
      const parent = await queryOne('SELECT id FROM media WHERE id = $1 AND deleted_at IS NULL', [parentId]);
      if (parent) {
        await query(
          `INSERT INTO media_versions (media_id, version_media_id, note, created_by)
           VALUES ($1, $2, $3, $4)`,
          [parentId, mediaRow.id, 'Отредактировано через редактор', req.user.id]
        );
      }
    }
  } catch (err) {
    console.error('Ошибка загрузки:', err);
    await fs.rm(req.file.path, { force: true }).catch(() => {});
    res.status(500).json({ error: 'Не удалось сохранить файл. Попробуйте ещё раз.' });
  }
});

// ---------- Список медиа (с пагинацией) ----------
/**
 * GET /api/media?albumId=1&includeDeleted=1&limit=50&offset=100
 * Все роли (гость — только просмотр)
 * limit: по умолчанию 50, макс 200
 * offset: по умолчанию 0
 * Ответ содержит also "total" — общее количество медиа в текущем фильтре.
 */
router.get('/', requireAuth, async (req, res) => {
  const { albumId, includeDeleted, search, tag, sort, favorite, capsules } = req.query;
  const limit = Math.min(parseInt(req.query.limit) || 50, 200);
  const offset = parseInt(req.query.offset) || 0;

  let where = 'WHERE m.deleted_at IS NULL';
  const params = [];
  let paramIdx = 0;

  if (albumId) {
    params.push(parseInt(albumId, 10));
    where += ` AND m.album_id = $${++paramIdx}`;
  }
  if (favorite === '1') {
    where += ` AND m.is_favorite = TRUE`;
  }
  // Капсулы времени: обычные списки не показывают ещё не открытые файлы
  if (capsules === '1') {
    where += ` AND m.reveal_at IS NOT NULL`;
  } else {
    where += ` AND (m.reveal_at IS NULL OR m.reveal_at <= $${++paramIdx})`;
    params.push(new Date().toISOString());
  }
  if (includeDeleted === '1' && req.user.role === 'admin') {
    where = where.replace('m.deleted_at IS NULL', '1=1');
  }
  if (search && String(search).trim()) {
    params.push(`%${String(search).trim()}%`);
    where += ` AND m.filename ILIKE $${++paramIdx}`;
  }
  if (tag && String(tag).trim()) {
    params.push(String(tag).trim().toLowerCase());
    where += ` AND m.id IN (
      SELECT mt.media_id FROM media_tags mt
      JOIN tags t ON t.id = mt.tag_id
      WHERE LOWER(t.name) = $${++paramIdx}
    )`;
  }

  // ---------- Сортировка ----------
  // date  — по дате съёмки (по умолчанию)
  // added — по дате загрузки
  // name  — по имени файла
  let orderBy = 'COALESCE(m.date_taken, m.created_at) DESC';
  if (sort === 'added') orderBy = 'm.created_at DESC';
  else if (sort === 'name') orderBy = 'm.filename ASC COLLATE NOCASE';
  else if (sort === 'date_asc') orderBy = 'COALESCE(m.date_taken, m.created_at) ASC';

  // Сначала считаем total (без limit/offset)
  const countParams = [...params];
  const countResult = await query(
    `SELECT COUNT(*) FROM media m ${where}`,
    countParams
  );
  const total = parseInt(countResult.rows[0].count, 10);

  params.push(limit);
  params.push(offset);
  const sql = `SELECT m.* FROM media m ${where} ORDER BY ${orderBy} LIMIT $${++paramIdx} OFFSET $${++paramIdx}`;

  const result = await query(sql, params);
  const items = await Promise.all(result.rows.map(mediaToDto));

  res.json({ media: items, total, limit, offset });
});

// ---------- Корзина ----------
/**
 * DELETE /api/media/:id — в корзину (deleted_at), не физическое удаление
 * Роли: admin, editor
 */
router.delete('/:id', requireAuth, requireRole('admin', 'editor'), async (req, res) => {
  const media = await queryOne('SELECT * FROM media WHERE id = $1', [req.params.id]);
  if (!media) return res.status(404).json({ error: 'Файл не найден' });

  await query('UPDATE media SET deleted_at = now() WHERE id = $1', [req.params.id]);
  res.json({ ok: true, message: 'Файл перемещён в корзину' });
});

// ---------- Массовые операции ----------
/**
 * POST /api/media/bulk-delete — удалить несколько файлов в корзину
 * Body: { ids: [1,2,3] }
 */
router.post('/bulk-delete', requireAuth, requireRole('admin', 'editor'), async (req, res) => {
  const ids = Array.isArray(req.body?.ids) ? req.body.ids.map(Number).filter(Boolean) : [];
  if (ids.length === 0) return res.status(400).json({ error: 'Не выбрано ни одного файла' });

  await query(
    `UPDATE media SET deleted_at = now() WHERE id = ANY($1::int[]) AND deleted_at IS NULL`,
    [ids]
  ).catch(async () => {
    // SQLite не поддерживает ANY($1) — перебираем по одному
    for (const id of ids) {
      await query('UPDATE media SET deleted_at = now() WHERE id = $1 AND deleted_at IS NULL', [id]);
    }
  });

  res.json({ ok: true, deleted: ids.length });
});

/**
 * POST /api/media/bulk-move — переместить файлы в альбом
 * Body: { ids: [1,2,3], albumId: 5 }
 */
router.post('/bulk-move', requireAuth, requireRole('admin', 'editor'), async (req, res) => {
  const ids = Array.isArray(req.body?.ids) ? req.body.ids.map(Number).filter(Boolean) : [];
  const albumId = req.body?.albumId ? parseInt(req.body.albumId, 10) : null;
  if (ids.length === 0) return res.status(400).json({ error: 'Не выбрано ни одного файла' });
  if (!albumId) return res.status(400).json({ error: 'Укажите альбом' });

  const album = await queryOne('SELECT id FROM albums WHERE id = $1', [albumId]);
  if (!album) return res.status(404).json({ error: 'Альбом не найден' });

  await query(
    `UPDATE media SET album_id = $1 WHERE id = ANY($2::int[]) AND deleted_at IS NULL`,
    [albumId, ids]
  ).catch(async () => {
    for (const id of ids) {
      await query('UPDATE media SET album_id = $1 WHERE id = $2 AND deleted_at IS NULL', [albumId, id]);
    }
  });

  res.json({ ok: true, moved: ids.length });
});

// ---------- Скачать оригинал ----------
/**
 * GET /api/media/:id/download — presigned URL на оригинал
 */
router.get('/:id/download', requireAuth, async (req, res) => {
  const media = await queryOne(
    'SELECT * FROM media WHERE id = $1 AND deleted_at IS NULL',
    [req.params.id]
  );
  if (!media) return res.status(404).json({ error: 'Файл не найден' });

  res.json({ url: await getPresignedUrl(media.storage_key) });
});

// ---------- Избранное ----------
/**
 * PUT /api/media/:id/favorite — переключить избранное (❤)
 * Body: { favorite: true | false }
 */
router.put('/:id/favorite', requireAuth, requireRole('admin', 'editor'), async (req, res) => {
  const favorite = req.body?.favorite === true || req.body?.favorite === 1;
  const media = await queryOne(
    'UPDATE media SET is_favorite = $1 WHERE id = $2 AND deleted_at IS NULL RETURNING *',
    [favorite, req.params.id]
  );
  if (!media) return res.status(404).json({ error: 'Файл не найден' });
  res.json({ ok: true, isFavorite: favorite });
});

// ---------- Капсулы времени ----------
/**
 * PUT /api/media/:id/capsule — запечатать/открыть капсулу времени
 * Body: { revealDate: "YYYY-MM-DD" | null } — null открывает сразу
 * Пока дата не наступила, файл скрыт из обычных списков и отдаёт заглушку.
 */
router.put('/:id/capsule', requireAuth, requireRole('admin', 'editor'), async (req, res) => {
  const media = await queryOne(
    'SELECT * FROM media WHERE id = $1 AND deleted_at IS NULL',
    [req.params.id]
  );
  if (!media) return res.status(404).json({ error: 'Файл не найден' });

  const raw = req.body?.revealDate ?? null;
  let revealAt = null;
  if (raw) {
    const d = new Date(raw);
    if (isNaN(d.getTime())) return res.status(400).json({ error: 'Неверная дата' });
    revealAt = d.toISOString();
  }

  await query(
    'UPDATE media SET reveal_at = $1 WHERE id = $2',
    [revealAt, media.id]
  );
  res.json({ ok: true, revealAt });
});

// ---------- Версионирование ----------
/**
 * GET /api/media/:id/versions — история версий (список)
 */
router.get('/:id/versions', requireAuth, async (req, res) => {
  const result = await query(
    `SELECT mv.id, mv.note, mv.created_at, mv.version_media_id,
            u.name AS created_by_name
     FROM media_versions mv
     LEFT JOIN users u ON u.id = mv.created_by
     WHERE mv.media_id = $1
     ORDER BY mv.created_at DESC`,
    [req.params.id]
  );
  const versions = await Promise.all(
    result.rows.map(async (r) => {
      const versionMedia = await queryOne('SELECT * FROM media WHERE id = $1', [r.version_media_id]);
      if (!versionMedia) return null;
      return {
        id: r.id,
        note: r.note,
        createdAt: r.created_at,
        createdByName: r.created_by_name,
        versionMedia: await mediaToDto(versionMedia),
      };
    })
  );
  res.json({ versions: versions.filter(Boolean) });
});

/** Вернуть все версии обрабатываемого файла (для UI) */
export async function getMediaVersions(mediaId) {
  const result = await query(
    `SELECT * FROM media_versions WHERE media_id = $1 ORDER BY created_at DESC`,
    [mediaId]
  );
  return result.rows;
}

// ---------- Восстановление версии ----------
/**
 * POST /api/media/:id/restore-version
 * Body: { versionMediaId }
 * Копирует файлы выбранной версии в основную запись (storage_key, thumb, poster, converted).
 */
router.post('/:id/restore-version', requireAuth, requireRole('admin', 'editor'), async (req, res) => {
  const { versionMediaId } = req.body || {};
  if (!versionMediaId) return res.status(400).json({ error: 'Укажите versionMediaId' });

  // Версия должна принадлежать этому media
  const version = await queryOne(
    'SELECT * FROM media_versions WHERE media_id = $1 AND version_media_id = $2',
    [req.params.id, versionMediaId]
  );
  if (!version) return res.status(404).json({ error: 'Версия не найдена' });

  const versionMedia = await queryOne('SELECT * FROM media WHERE id = $1', [versionMediaId]);
  if (!versionMedia) return res.status(404).json({ error: 'Файл версии не найден' });

  // Копируем все ключи версии в основную запись
  await query(
    `UPDATE media SET
       storage_key = $1, thumb_key = $2, poster_key = $3, converted_key = $4,
       mime_type = $5, size_bytes = $6, width = $7, height = $8, is_converted = $9
     WHERE id = $10`,
    [
      versionMedia.storage_key,
      versionMedia.thumb_key,
      versionMedia.poster_key,
      versionMedia.converted_key,
      versionMedia.mime_type,
      versionMedia.size_bytes,
      versionMedia.width,
      versionMedia.height,
      versionMedia.is_converted,
      req.params.id,
    ]
  );

  res.json({ ok: true });
});

// ---------- Комментарии ----------
/**
 * GET /api/media/:id/comments — список комментариев к фото
 */
router.get('/:id/comments', requireAuth, async (req, res) => {
  const result = await query(
    `SELECT c.id, c.media_id, c.user_id, c.body, c.created_at,
            u.name AS author_name
     FROM media_comments c
     LEFT JOIN users u ON u.id = c.user_id
     WHERE c.media_id = $1
     ORDER BY c.created_at ASC`,
    [req.params.id]
  );
  res.json({ comments: result.rows });
});

/**
 * POST /api/media/:id/comments — добавить комментарий
 * Body: { body }
 */
router.post('/:id/comments', requireAuth, async (req, res) => {
  const { body } = req.body || {};
  if (!body || !String(body).trim()) {
    return res.status(400).json({ error: 'Напишите комментарий' });
  }
  const text = String(body).trim().slice(0, 500);
  const now = new Date().toISOString();
  const row = await queryOne(
    `INSERT INTO media_comments (media_id, user_id, body, created_at)
     VALUES ($1, $2, $3, $4)
     RETURNING id, media_id, user_id, body, created_at`,
    [req.params.id, req.user.id, text, now]
  );
  res.status(201).json({ comment: { ...row, author_name: req.user.name } });
});

/**
 * DELETE /api/media/:id/comments/:commentId — удалить свой комментарий
 * (админ может удалить любой)
 */
router.delete('/:id/comments/:commentId', requireAuth, async (req, res) => {
  const comment = await queryOne(
    'SELECT * FROM media_comments WHERE id = $1 AND media_id = $2',
    [req.params.commentId, req.params.id]
  );
  if (!comment) return res.status(404).json({ error: 'Комментарий не найден' });

  const isOwner = comment.user_id === req.user.id;
  const isAdmin = req.user.role === 'admin';
  if (!isOwner && !isAdmin) return res.status(403).json({ error: 'У вас нет прав удалять этот комментарий' });

  await query('DELETE FROM media_comments WHERE id = $1', [comment.id]);
  res.json({ ok: true });
});

// ---------- Публичная ссылка на альбом ----------
/**
 * POST /api/media/share-album — создать публичную ссылку на альбом
 * Buck: { albumId }
 */
router.post('/share-album', requireAuth, requireRole('admin', 'editor'), async (req, res) => {
  const { albumId } = req.body || {};
  const album = await queryOne('SELECT id FROM albums WHERE id = $1', [albumId]);
  if (!album) return res.status(404).json({ error: 'Альбом не найден' });

  const token = crypto.randomBytes(6).toString('hex');
  await run(
    `INSERT INTO album_shares (token, album_id, created_by) VALUES ($1, $2, $3)`,
    [token, albumId, req.user.id]
  );
  const baseUrl = process.env.APP_URL || `http://localhost:${process.env.PORT || 3000}`;
  res.status(201).json({ token, link: `${baseUrl}/?share=${token}` });
});

/**
 * GET /api/media/shared/:token — открыть альбом по публичной ссылке (без входа)
 */
router.get('/shared/:token', async (req, res) => {
  const share = await queryOne(
    'SELECT * FROM album_shares WHERE token = $1',
    [req.params.token]
  );
  if (!share) return res.status(404).json({ error: 'Ссылка не найдена' });

  const album = await queryOne('SELECT * FROM albums WHERE id = $1', [share.album_id]);
  if (!album) return res.status(404).json({ error: 'Альбом не найден' });

  const result = await query(
    'SELECT * FROM media WHERE album_id = $1 AND deleted_at IS NULL ORDER BY COALESCE(date_taken, created_at) DESC',
    [album.id]
  );
  const media = await Promise.all(result.rows.map(mediaToDto));
  res.json({ album, media });
});

export default router;