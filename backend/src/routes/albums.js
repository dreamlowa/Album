import { Router } from 'express';
import { query, queryOne } from '../db.js';
import { requireAuth, requireRole } from '../middleware/auth.js';
import { mediaToDto } from '../utils/media.js';

const router = Router();

/**
 * GET /api/albums — список альбомов + количество медиа
 * Все роли (гость тоже видит)
 */
router.get('/', requireAuth, async (req, res) => {
  const result = await query(
    `SELECT a.id, a.title, a.description, a.created_at,
            (SELECT COUNT(*) FROM media m WHERE m.album_id = a.id AND m.deleted_at IS NULL) AS media_count
     FROM albums a
     ORDER BY a.created_at ASC`
  );
  res.json({ albums: result.rows });
});

/**
 * GET /api/albums/:id — альбом + его медиа
 */
router.get('/:id', requireAuth, async (req, res) => {
  const album = await queryOne('SELECT * FROM albums WHERE id = $1', [req.params.id]);
  if (!album) return res.status(404).json({ error: 'Альбом не найден' });

  const result = await query(
    'SELECT * FROM media WHERE album_id = $1 AND deleted_at IS NULL ORDER BY COALESCE(date_taken, created_at) DESC',
    [req.params.id]
  );
  const media = await Promise.all(result.rows.map(mediaToDto));

  res.json({ album, media });
});

/**
 * POST /api/albums — создать альбом
 * Роли: admin, editor
 */
router.post('/', requireAuth, requireRole('admin', 'editor'), async (req, res) => {
  const { title, description = '' } = req.body || {};
  if (!title || !String(title).trim()) {
    return res.status(400).json({ error: 'Введите название альбома' });
  }
  const album = await queryOne(
    `INSERT INTO albums (title, description, created_by) VALUES ($1, $2, $3) RETURNING *`,
    [String(title).trim(), description, req.user.id]
  );
  res.status(201).json({ album });
});

/**
 * PATCH /api/albums/:id — переименовать/обновить альбом
 * Body: { title?, description? }
 * Роли: admin, editor
 */
router.patch('/:id', requireAuth, requireRole('admin', 'editor'), async (req, res) => {
  const { title, description } = req.body || {};
  if (title !== undefined && !String(title).trim()) {
    return res.status(400).json({ error: 'Название не может быть пустым' });
  }
  const album = await queryOne(
    `UPDATE albums SET
       title = COALESCE($1, title),
       description = COALESCE($2, description)
     WHERE id = $3
     RETURNING *`,
    [
      title !== undefined ? String(title).trim() : null,
      description !== undefined ? String(description).trim() : null,
      req.params.id,
    ]
  );
  if (!album) return res.status(404).json({ error: 'Альбом не найден' });
  res.json({ album });
});

/**
 * DELETE /api/albums/:id — удалить альбом (медиа остаются, album_id = NULL)
 * Только админ. ВНИМАНИЕ: файлы не удаляются из хранилища.
 */
router.delete('/:id', requireAuth, requireRole('admin'), async (req, res) => {
  const album = await queryOne('SELECT * FROM albums WHERE id = $1', [req.params.id]);
  if (!album) return res.status(404).json({ error: 'Альбом не найден' });

  await query(`UPDATE media SET album_id = NULL WHERE album_id = $1`, [req.params.id]);
  await query(`DELETE FROM albums WHERE id = $1`, [req.params.id]);
  res.json({ ok: true });
});

export default router;