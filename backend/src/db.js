/**
 * Двурежимный драйвер БД:
 * - SQLite (встроенный node:sqlite) — режим local (без DATABASE_URL)
 * - PostgreSQL (pg) — режим docker (с DATABASE_URL)
 *
 * Единый интерфейс:
 *   query(sql, params)  → { rows: [...] }
 *   queryOne(sql, params) → row | null
 *   run(sql, params)    → для INSERT/UPDATE без возврата
 *
 * SQL-запросы в коде пишутся под PostgreSQL; адаптер переводит их в SQLite
 * (SERIAL→AUTOINCREMENT, $1→?1, ILIKE→LIKE, TIMESTAMPTZ→TEXT, EXTRACT→strftime,
 *  COUNT()FILTER→CASE, RETURNING эмулируется через last_insert_rowid).
 */
import { mkdirSync, existsSync, readFileSync, copyFileSync, rmSync } from 'node:fs';
import { dirname, join, basename } from 'node:path';
import { fileURLToPath } from 'node:url';

const __dirname = dirname(fileURLToPath(import.meta.url));
// db.js лежит в backend/src → вверх на 2 уровня до корня проекта
const PROJECT_ROOT = join(__dirname, '..', '..');
const usePg = !!process.env.DATABASE_URL;

// ================= Реализация PostgreSQL =================
async function createPgImpl() {
  const { default: pg } = await import('pg');
  const pool = new pg.Pool({ connectionString: process.env.DATABASE_URL });

  try {
    const schema = readFileSync(join(PROJECT_ROOT, 'db', 'schema.sql'), 'utf-8');
    await pool.query(schema);
    console.log('PostgreSQL: схема применена (или уже была)');
  } catch (err) {
    console.warn('PostgreSQL: схема не применена:', err.message.slice(0, 120));
  }

  return {
    impl: 'pg',
    pool,
    query: async (text, params = []) => {
      const r = await pool.query(text, params);
      return { rows: r.rows };
    },
    queryOne: async (text, params = []) => {
      const r = await pool.query(text, params);
      return r.rows[0] || null;
    },
    run: async (text, params = []) => {
      await pool.query(text, params);
    },
  };
}

// ================= Реализация SQLite =================
async function createSqliteImpl() {
  const { DatabaseSync } = await import('node:sqlite');

  const dataDir = join(PROJECT_ROOT, 'data');
  mkdirSync(dataDir, { recursive: true });

  // --- Применение очереди восстановления (до открытия коннектора) ---
  // restore кладёт БД в archive.db.restore + флаг .restore-pending,
  // чтобы не трогать «живую» БД под открытым коннектором (иначе WAL → malformed).
  const pendingFlag = join(dataDir, '.restore-pending');
  const queuedDb = join(dataDir, 'archive.db.restore');
  if (existsSync(pendingFlag) && existsSync(queuedDb)) {
    try {
      const liveDb = join(dataDir, 'archive.db');
      // Авто-бэкап текущей БД перед заменой
      if (existsSync(liveDb)) {
        const bak = join(dataDir, `archive.pre-restore-${Date.now()}.db`);
        copyFileSync(liveDb, bak);
        console.log(`Снимок: БД сохранена в ${basename(bak)}`);
      }
      // Убираем старые WAL/SHM (они больше не соответствуют БД)
      for (const suffix of ['', '-wal', '-shm']) {
        const p = join(dataDir, 'archive.db' + suffix);
        if (existsSync(p)) rmSync(p, { force: true });
      }
      copyFileSync(queuedDb, liveDb);
      rmSync(queuedDb, { force: true });
      console.log('Снимок: БД восстановлена из очереди.');
    } catch (err) {
      console.warn('Снимок: не удалось применить очередь БД:', err.message.slice(0, 120));
    } finally {
      rmSync(pendingFlag, { force: true });
    }
  }

  const db = new DatabaseSync(join(dataDir, 'archive.db'));
  db.exec('PRAGMA journal_mode=WAL');
  db.exec('PRAGMA foreign_keys=ON');

  // ------------ Адаптер SQL: PostgreSQL → SQLite для рантайм-запросов ------------
  function adapt(sql) {
    return sql
      .replace(/\bSERIAL\s+PRIMARY\s+KEY\b/gi, 'INTEGER PRIMARY KEY AUTOINCREMENT')
      .replace(/\bSERIAL\b/gi, 'INTEGER PRIMARY KEY AUTOINCREMENT')
      .replace(/\bTIMESTAMPTZ\b/gi, 'TEXT')
      .replace(/\bDOUBLE\s+PRECISION\b/gi, 'REAL')
      .replace(/\bJSONB\b/gi, 'TEXT')
      .replace(/\bBIGINT\b/gi, 'INTEGER')
      // EXTRACT(YEAR FROM expr) → CAST(strftime('%Y', expr) AS INTEGER)
      .replace(/EXTRACT\s*\(\s*YEAR\s+FROM\s+((?:[^()]|\([^)]*\))+)\s*\)\s*::\w+/gi, "CAST(strftime('%Y', $1) AS INTEGER)")
      .replace(/EXTRACT\s*\(\s*YEAR\s+FROM\s+((?:[^()]|\([^)]*\))+)\s*\)/gi, "CAST(strftime('%Y', $1) AS INTEGER)")
      .replace(/\bnow\(\)/gi, "(datetime('now'))")
      .replace(/\bCOALESCE\s*\(/gi, 'IFNULL(')
      .replace(/\bILIKE\b/gi, 'LIKE')
      .replace(/\$(\d+)/g, '?$1')
      .replace(/\s::\s*[\w\[\]]+\s*/g, ' ')
      .replace(/COUNT\(\*\)\s+FILTER\s+\(WHERE\s+([^)]+)\s*\)/gi, "SUM(CASE WHEN $1 THEN 1 ELSE 0 END)")
      .replace(/\b(SUM|MAX|MIN|AVG)\(([^()]*)\)\s+FILTER\s+\(WHERE\s+([^)]+)\s*\)/gi, "$1(CASE WHEN $3 THEN $2 ELSE 0 END)")
      .replace(/^\s*DO\s+\$\$[\s\S]*?\$\$\s*;\s*$/gim, '');
  }

  function stripReturning(sql) {
    return sql.replace(/\s+RETURNING\s+\*?\s*$/i, '');
  }
  function lastInsertId() {
    return db.prepare('SELECT last_insert_rowid() AS id').get().id;
  }
  function tableFromInsert(sql) {
    const m = sql.match(/INTO\s+(\w+)/i);
    return m ? m[1] : null;
  }
  function selectById(table, id) {
    const row = db.prepare(`SELECT * FROM ${table} WHERE id = ?`).get(id);
    return row || null;
  }

  // ------------ Схема (SQLite-версия, готовая, без адаптации) ------------
  const schemaSqlite = join(PROJECT_ROOT, 'db', 'schema.sqlite.sql');
  const schemaPg = join(PROJECT_ROOT, 'db', 'schema.sql');
  const schemaPath = existsSync(schemaSqlite) ? schemaSqlite : schemaPg;
  if (existsSync(schemaPath)) {
    // Сначала убираем все построчные комментарии
    const raw = readFileSync(schemaPath, 'utf-8');
    const noComments = raw
      .split('\n')
      .map((line) => line.replace(/--.*$/, ''))
      .join('\n');
    const isSqliteFile = schemaPath === schemaSqlite;
    const stmts = (isSqliteFile ? noComments : adapt(noComments))
      .split(';')
      .map((s) => s.trim())
      .filter((s) => s && !s.startsWith('--'));

    for (const stmt of stmts) {
      if (!stmt) continue;
      try {
        db.exec(stmt);
      } catch (err) {
        if (!/already exists|duplicate|duplicate column/i.test(err.message)) {
          console.warn('SQLite schema:', err.message.slice(0, 100));
        }
      }
    }
    console.log('SQLite: БД инициализирована (' + join(dataDir, 'archive.db') + '), схема: ' + (isSqliteFile ? 'schema.sqlite.sql' : 'schema.sql (адаптированная)'));
  }

  // ------------ Миграции (мягкое добавление колонок) ------------
  try {
    db.exec(`ALTER TABLE media ADD COLUMN reveal_at TEXT`);
  } catch (err) { /* колонка уже есть */ }
  try {
    db.exec(`ALTER TABLE media ADD COLUMN uploaded_by INTEGER`);
  } catch (err) { /* колонка уже есть */ }
  try {
    db.exec(`ALTER TABLE users ADD COLUMN avatar_key TEXT`);
  } catch (err) { /* колонка уже есть */ }
  try {
    db.exec(`ALTER TABLE users ADD COLUMN bio TEXT`);
  } catch (err) { /* колонка уже есть */ }

  // ------------ API ------------
  function query(text, params = []) {
    const sql = adapt(text);
    if (/^\s*SELECT/i.test(sql)) {
      const rows = db.prepare(sql).all(...params);
      return { rows };
    }
    const info = db.prepare(stripReturning(sql)).run(...params);
    return { rows: [], rowCount: info.changes };
  }

  function queryOne(text, params = []) {
    // INSERT / UPDATE с RETURNING — эмулируем через last_insert_rowid
    if (/^\s*(INSERT|UPDATE)/i.test(text) && /\s+RETURNING\b/i.test(text)) {
      const sql = adapt(text);
      const bare = stripReturning(sql);
      db.prepare(bare).run(...params);

      // Для INSERT — находим по last_insert_rowid
      if (/^\s*INSERT/i.test(text)) {
        const table = tableFromInsert(text);
        const id = lastInsertId();
        if (table) return selectById(table, id) || { id };
        return { id };
      }

      // Для UPDATE — находим по последнему параметру (WHERE id = ?)
      const updId = params[params.length - 1];
      if (updId !== undefined) {
        // Угадываем таблицу через UPDATE table
        const m = text.match(/UPDATE\s+(\w+)/i);
        if (m) {
          const row = db.prepare(`SELECT * FROM ${m[1]} WHERE id = ?`).get(updId);
          return row || { id: updId };
        }
      }
      return { changes: info?.changes };
    }
    // Обычный INSERT без RETURNING — возвращаем созданную строку
    if (/^\s*INSERT/i.test(text)) {
      const sql = adapt(text);
      db.prepare(stripReturning(sql)).run(...params);
      const table = tableFromInsert(text);
      const id = lastInsertId();
      if (table) return selectById(table, id) || { id };
      return { id };
    }
    // SELECT
    if (/^\s*SELECT/i.test(text)) {
      return db.prepare(adapt(text)).get(...params) || null;
    }
    // UPDATE / DELETE
    const info = db.prepare(stripReturning(adapt(text))).run(...params);
    return { changes: info.changes };
  }

  function run(text, params = []) {
    return db.prepare(stripReturning(adapt(text))).run(...params);
  }

  return {
    impl: 'sqlite',
    db,
    query,
    queryOne,
    run,
  };
}

// ================= Инициализация =================
const driver = usePg ? await createPgImpl() : await createSqliteImpl();

// ================= Публичный API =================
export const query = driver.query;
export const queryOne = driver.queryOne;
export const run = driver.run;
export const isSqlite = driver.impl === 'sqlite';
export default driver.db || driver.pool;