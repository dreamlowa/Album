import { query } from '../db.js';
import { deleteFile } from './s3.js';

/**
 * Фоновая очистка корзины:
 * файлы, помеченные deleted_at старше N дней (по умолчанию 30),
 * удаляются физически из MinIO и из БД.
 *
 * Запускается периодически из index.js (setInterval).
 */
export async function cleanupTrash() {
  const days = parseInt(process.env.TRASH_RETENTION_DAYS || '30', 10);
  const cutoff = new Date(Date.now() - days * 24 * 60 * 60 * 1000);

  try {
    const result = await query(
      `SELECT id, storage_key, thumb_key, converted_key, poster_key
       FROM media
       WHERE deleted_at IS NOT NULL AND deleted_at < $1
       LIMIT 200`,
      [cutoff]
    );

    if (result.rows.length === 0) return { deleted: 0 };

    let deleted = 0;
    for (const m of result.rows) {
      const keys = [m.storage_key, m.thumb_key, m.converted_key, m.poster_key].filter(Boolean);
      for (const key of keys) {
        await deleteFile(key).catch((err) => {
          console.error(`Очистка корзины: не удалось удалить ${key}:`, err.message);
        });
      }
      await query('DELETE FROM media WHERE id = $1', [m.id]);
      deleted++;
    }

    console.log(`Очистка корзины: удалено файлов из корзины: ${deleted}`);
    return { deleted };
  } catch (err) {
    console.error('Очистка корзины: ошибка:', err.message);
    return { deleted: 0, error: err.message };
  }
}