import { Router } from 'express';
import { query } from '../db.js';
import { requireAuth } from '../middleware/auth.js';
import { mediaToDto } from '../utils/media.js';

const router = Router();

/**
 * GET /api/map/qr?text=... — SVG-код QR для ссылки (поделиться/приглашение)
 */
router.get('/qr', requireAuth, async (req, res) => {
  const text = String(req.query.text || '').slice(0, 2000);
  if (!text) return res.status(400).json({ error: 'Укажите text' });
  try {
    const { default: QRCode } = await import('qrcode');
    const svg = await QRCode.toString(text, {
      type: 'svg',
      margin: 1,
      width: 260,
      color: { dark: '#14181f', light: '#ffffff' },
    });
    res.setHeader('Content-Type', 'image/svg+xml');
    res.send(svg);
  } catch (err) {
    console.error('QR ошибка:', err.message);
    res.status(500).json({ error: 'Не удалось сгенерировать QR' });
  }
});

/**
 * GET /api/map — все фото с GPS-координатами (для Leaflet)
 */
router.get('/', requireAuth, async (req, res) => {
  const result = await query(
    `SELECT id, latitude, longitude, date_taken, thumb_key, storage_key, filename
     FROM media
     WHERE deleted_at IS NULL
       AND latitude IS NOT NULL AND longitude IS NOT NULL
     ORDER BY COALESCE(date_taken, created_at) DESC
     LIMIT 2000`
  );

  const media = await Promise.all(
    result.rows.map(async (r) => {
      const dto = await mediaToDto(r);
      return {
        id: dto.id,
        lat: Number(r.latitude),
        lng: Number(r.longitude),
        dateTaken: dto.dateTaken,
        thumbUrl: dto.thumbUrl,
        filename: dto.filename,
      };
    })
  );

  res.json({ media });
});

/**
 * GET /api/stats — общая статистика архива
 * Роли: все (гость видит базовую)
 */
router.get('/stats', requireAuth, async (req, res) => {
  const totals = await query(
    `SELECT
       COUNT(*) FILTER (WHERE kind = 'image' AND deleted_at IS NULL) AS photos,
       COUNT(*) FILTER (WHERE kind = 'video' AND deleted_at IS NULL) AS videos,
       COUNT(*) FILTER (WHERE deleted_at IS NOT NULL)               AS trashed,
       COALESCE(SUM(size_bytes) FILTER (WHERE deleted_at IS NULL), 0) AS total_bytes
     FROM media`
  );

  const byYear = await query(
    `SELECT EXTRACT(YEAR FROM COALESCE(date_taken, created_at))::int AS year,
            COUNT(*) AS count,
            COALESCE(SUM(size_bytes), 0) AS bytes
     FROM media
     WHERE deleted_at IS NULL
     GROUP BY year
     ORDER BY year DESC`
  );

  const t = totals.rows[0];
  res.json({
    photos: parseInt(t.photos, 10) || 0,
    videos: parseInt(t.videos, 10) || 0,
    trashed: parseInt(t.trashed, 10) || 0,
    totalBytes: parseInt(t.total_bytes, 10) || 0,
    byYear: byYear.rows.map((r) => ({
      year: r.year,
      count: parseInt(r.count, 10),
      bytes: parseInt(r.bytes, 10) || 0,
    })),
  });
});

/**
 * GET /api/tags/export — выгрузить все теги/метки в CSV (для архива).
 * Колонки: tag;media_count
 */
router.get('/tags/export', requireAuth, async (req, res) => {
  const result = await query(
    `SELECT t.name,
            COUNT(mt.media_id) AS media_count
     FROM tags t
     LEFT JOIN media_tags mt ON mt.tag_id = t.id
     GROUP BY t.name
     ORDER BY t.name ASC`
  );

  // CSV с BOM для корректной кириллицы в Excel
  const rows = result.rows.map((r) => `${csvEscape(r.name)};${r.media_count}`);
  const csv = '\uFEFF' + ['метка;количество_файлов', ...rows].join('\r\n');

  res.setHeader('Content-Type', 'text/csv; charset=utf-8');
  res.setHeader('Content-Disposition', 'attachment; filename="tags.csv"');
  res.send(csv);
});

function csvEscape(v) {
  const s = String(v ?? '');
  return /[;"\r\n]/.test(s) ? `"${s.replace(/"/g, '""')}"` : s;
}

export default router;