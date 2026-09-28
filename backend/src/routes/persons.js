import { Router } from 'express';
import { query, queryOne } from '../db.js';
import { requireAuth, requireRole } from '../middleware/auth.js';
import { mediaToDto } from '../utils/media.js';

const router = Router();

/**
 * GET /api/persons — список людей с количеством фото
 */
router.get('/', requireAuth, async (req, res) => {
  const result = await query(
    `SELECT p.id, p.name, p.avatar_media_id,
            COUNT(mp.media_id) AS photo_count
     FROM persons p
     LEFT JOIN media_persons mp ON mp.person_id = p.id
     LEFT JOIN media m ON m.id = mp.media_id AND m.deleted_at IS NULL
     GROUP BY p.id
     ORDER BY photo_count DESC`
  );
  res.json({ persons: result.rows });
});

/**
 * GET /api/persons/:id — одна персона + её фото
 */
router.get('/:id', requireAuth, async (req, res) => {
  const person = await queryOne(
    `SELECT p.id, p.name, p.avatar_media_id,
            COUNT(mp.media_id) AS photo_count
     FROM persons p
     LEFT JOIN media_persons mp ON mp.person_id = p.id
     LEFT JOIN media m ON m.id = mp.media_id AND m.deleted_at IS NULL
     WHERE p.id = $1
     GROUP BY p.id`,
    [req.params.id]
  );
  if (!person) return res.status(404).json({ error: 'Человек не найден' });

  const result = await query(
    `SELECT m.*
     FROM media m
     JOIN media_persons mp ON mp.media_id = m.id
     WHERE mp.person_id = $1 AND m.deleted_at IS NULL
     ORDER BY COALESCE(m.date_taken, m.created_at) DESC`,
    [req.params.id]
  );
  const media = await Promise.all(result.rows.map(mediaToDto));
  res.json({ person, media });
});

/**
 * PATCH /api/persons/:id — переименовать человека
 * Body: { name }
 */
router.patch('/:id', requireAuth, requireRole('admin', 'editor'), async (req, res) => {
  const { name } = req.body || {};
  if (!name || !String(name).trim()) {
    return res.status(400).json({ error: 'Введите имя' });
  }
  const person = await queryOne(
    'UPDATE persons SET name = $1 WHERE id = $2 RETURNING id, name',
    [String(name).trim(), req.params.id]
  );
  if (!person) return res.status(404).json({ error: 'Человек не найден' });
  res.json({ person });
});

/**
 * POST /api/media/:id/faces — поставить задачу распознавания для фото
 * (ставит face_jobs, воркер обработает в фоне)
 */
router.post('/media/:id/faces', requireAuth, requireRole('admin', 'editor'), async (req, res) => {
  const media = await queryOne(
    'SELECT id, kind FROM media WHERE id = $1 AND deleted_at IS NULL',
    [req.params.id]
  );
  if (!media) return res.status(404).json({ error: 'Фото не найдено' });
  if (media.kind !== 'image') return res.status(400).json({ error: 'Распознавание только для фото' });

  await query(
    `INSERT INTO face_jobs (media_id, status) VALUES ($1, 'pending')
     ON CONFLICT (media_id) DO UPDATE SET status = 'pending', updated_at = now()`,
    [media.id]
  );
  res.json({ ok: true, message: 'Задача распознавания поставлена' });
});

export default router;