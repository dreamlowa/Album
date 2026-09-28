import { Router } from 'express';
import { query, queryOne } from '../db.js';
import { requireAuth, requireRole } from '../middleware/auth.js';

const router = Router();

/**
 * GET /api/tags — список всех тегов с количеством медиа
 */
router.get('/', requireAuth, async (req, res) => {
  const result = await query(
    `SELECT t.id, t.name,
            COUNT(mt.media_id) AS media_count
     FROM tags t
     LEFT JOIN media_tags mt ON mt.tag_id = t.id
     GROUP BY t.id
     ORDER BY t.name ASC`
  );
  res.json({ tags: result.rows });
});

/**
 * POST /api/tags — создать тег (admin, editor)
 * Body: { name }
 */
router.post('/', requireAuth, requireRole('admin', 'editor'), async (req, res) => {
  const { name } = req.body || {};
  if (!name || !String(name).trim()) {
    return res.status(400).json({ error: 'Введите название тега' });
  }
  try {
    const tag = await queryOne(
      `INSERT INTO tags (name) VALUES ($1) ON CONFLICT (name) DO UPDATE SET name = $1 RETURNING *`,
      [String(name).trim()]
    );
    res.status(201).json({ tag });
  } catch (err) {
    res.status(409).json({ error: 'Тег уже существует' });
  }
});

/**
 * DELETE /api/tags/:id — удалить тег (admin)
 */
router.delete('/:id', requireAuth, requireRole('admin'), async (req, res) => {
  await query('DELETE FROM tags WHERE id = $1', [req.params.id]);
  res.json({ ok: true });
});

/**
 * POST /api/media/:mediaId/tags — прикрепить тег к медиа (admin, editor)
 * Body: { tagId } или { name } — создаст тег, если не существует
 */
router.post('/media/:mediaId/tags', requireAuth, requireRole('admin', 'editor'), async (req, res) => {
  const { tagId, name } = req.body || {};
  const mediaId = parseInt(req.params.mediaId, 10);

  const media = await queryOne('SELECT id FROM media WHERE id = $1 AND deleted_at IS NULL', [mediaId]);
  if (!media) return res.status(404).json({ error: 'Файл не найден' });

  let tid = tagId;
  if (!tid && name) {
    const tag = await queryOne(
      `INSERT INTO tags (name) VALUES ($1) ON CONFLICT (name) DO UPDATE SET name = $1 RETURNING id`,
      [String(name).trim()]
    );
    tid = tag.id;
  }
  if (!tid) return res.status(400).json({ error: 'Укажите tagId или name' });

  await query(
    `INSERT INTO media_tags (media_id, tag_id) VALUES ($1, $2) ON CONFLICT DO NOTHING`,
    [mediaId, tid]
  );
  res.json({ ok: true });
});

/**
 * DELETE /api/media/:mediaId/tags/:tagId — открепить тег
 */
router.delete('/media/:mediaId/tags/:tagId', requireAuth, requireRole('admin', 'editor'), async (req, res) => {
  await query(
    'DELETE FROM media_tags WHERE media_id = $1 AND tag_id = $2',
    [req.params.mediaId, req.params.tagId]
  );
  res.json({ ok: true });
});

/**
 * GET /api/media/:id/tags — теги конкретного медиа
 */
router.get('/media/:mediaId/tags', requireAuth, async (req, res) => {
  const result = await query(
    `SELECT t.id, t.name
     FROM tags t
     JOIN media_tags mt ON mt.tag_id = t.id
     WHERE mt.media_id = $1
     ORDER BY t.name`,
    [req.params.mediaId]
  );
  res.json({ tags: result.rows });
});

export default router;