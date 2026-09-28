import { DatabaseSync } from 'node:sqlite';
import { existsSync } from 'node:fs';

const DB = 'C:/Users/user/Documents/MultiTool/HomeChats/Chat-7/family-archive/data/archive.db';
if (!existsSync(DB)) {
  console.log('БД ещё нет — схема создастся при старте.');
  process.exit(0);
}
const db = new DatabaseSync(DB);

// Проверяем наличие колонки is_favorite
const cols = db.prepare(`PRAGMA table_info(media)`).all();
const hasFav = cols.some((c) => c.name === 'is_favorite');
console.log('Колонка is_favorite в media:', hasFav ? 'ЕСТЬ' : 'НЕТ');

if (!hasFav) {
  db.exec('ALTER TABLE media ADD COLUMN is_favorite INTEGER NOT NULL DEFAULT 0');
  console.log('Добавил колонку is_favorite (INTEGER DEFAULT 0)');
}

// Проверка
const cols2 = db.prepare(`PRAGMA table_info(media)`).all();
console.log('Все колонки media:', cols2.map((c) => c.name).join(', '));