-- ============================================================
-- Семейный архив — схема для SQLite (локальный режим, без Docker)
-- Используется backend/src/db.js когда не задан DATABASE_URL.
-- PostgreSQL-версия: db/schema.sql (docker)
-- ============================================================

PRAGMA foreign_keys = ON;

-- ---------- Пользователи / роли ----------
CREATE TABLE IF NOT EXISTS users (
  id            INTEGER PRIMARY KEY AUTOINCREMENT,
  email         TEXT UNIQUE NOT NULL,
  password_hash TEXT NOT NULL,
  name          TEXT NOT NULL,
  role          TEXT NOT NULL DEFAULT 'guest' CHECK (role IN ('admin', 'editor', 'guest')),
  avatar_key    TEXT,
  bio           TEXT,
  created_at    TEXT NOT NULL DEFAULT (datetime('now'))
);

-- ---------- Альбомы ----------
CREATE TABLE IF NOT EXISTS albums (
  id          INTEGER PRIMARY KEY AUTOINCREMENT,
  title       TEXT NOT NULL,
  description TEXT DEFAULT '',
  created_by  INTEGER REFERENCES users(id) ON DELETE SET NULL,
  created_at  TEXT NOT NULL DEFAULT (datetime('now'))
);

-- ---------- Медиафайлы ----------
CREATE TABLE IF NOT EXISTS media (
  id             INTEGER PRIMARY KEY AUTOINCREMENT,
  album_id       INTEGER REFERENCES albums(id) ON DELETE CASCADE,
  uploaded_by    INTEGER REFERENCES users(id) ON DELETE SET NULL,
  filename       TEXT NOT NULL,
  storage_key    TEXT NOT NULL UNIQUE,
  thumb_key      TEXT,
  poster_key     TEXT,
  converted_key  TEXT,
  mime_type      TEXT NOT NULL,
  kind           TEXT NOT NULL CHECK (kind IN ('image', 'video')),
  size_bytes     INTEGER NOT NULL DEFAULT 0,
  width          INTEGER,
  height         INTEGER,
  date_taken     TEXT,
  latitude       REAL,
  longitude      REAL,
  is_converted   INTEGER NOT NULL DEFAULT 0,
  is_favorite    INTEGER NOT NULL DEFAULT 0,
  reveal_at      TEXT,
  deleted_at     TEXT,
  created_at     TEXT NOT NULL DEFAULT (datetime('now'))
);

CREATE INDEX IF NOT EXISTS idx_media_album   ON media(album_id);
CREATE INDEX IF NOT EXISTS idx_media_deleted ON media(deleted_at);
CREATE INDEX IF NOT EXISTS idx_media_date    ON media(date_taken);

-- ---------- Распознавание лиц ----------
CREATE TABLE IF NOT EXISTS persons (
  id              INTEGER PRIMARY KEY AUTOINCREMENT,
  name            TEXT NOT NULL,
  embedding       TEXT,
  avatar_media_id INTEGER REFERENCES media(id) ON DELETE SET NULL,
  created_at      TEXT NOT NULL DEFAULT (datetime('now'))
);

CREATE TABLE IF NOT EXISTS media_persons (
  media_id    INTEGER NOT NULL REFERENCES media(id) ON DELETE CASCADE,
  person_id   INTEGER NOT NULL REFERENCES persons(id) ON DELETE CASCADE,
  confidence  REAL NOT NULL DEFAULT 1.0,
  embedding   TEXT,
  box         TEXT,
  PRIMARY KEY (media_id, person_id)
);

CREATE TABLE IF NOT EXISTS face_jobs (
  media_id    INTEGER PRIMARY KEY REFERENCES media(id) ON DELETE CASCADE,
  status      TEXT NOT NULL DEFAULT 'pending' CHECK (status IN ('pending','done','error')),
  error       TEXT,
  updated_at  TEXT NOT NULL DEFAULT (datetime('now'))
);

-- ---------- Теги ----------
CREATE TABLE IF NOT EXISTS tags (
  id   INTEGER PRIMARY KEY AUTOINCREMENT,
  name TEXT UNIQUE NOT NULL
);

CREATE TABLE IF NOT EXISTS media_tags (
  media_id INTEGER NOT NULL REFERENCES media(id) ON DELETE CASCADE,
  tag_id   INTEGER NOT NULL REFERENCES tags(id) ON DELETE CASCADE,
  PRIMARY KEY (media_id, tag_id)
);

CREATE INDEX IF NOT EXISTS idx_media_persons_person ON media_persons(person_id);
CREATE INDEX IF NOT EXISTS idx_media_persons_media  ON media_persons(media_id);
CREATE INDEX IF NOT EXISTS idx_media_tags_tag       ON media_tags(tag_id);
CREATE INDEX IF NOT EXISTS idx_face_jobs_status     ON face_jobs(status);

-- ---------- Приглашения ----------
CREATE TABLE IF NOT EXISTS invites (
  token       TEXT PRIMARY KEY,
  role        TEXT NOT NULL DEFAULT 'guest' CHECK (role IN ('guest', 'editor')),
  expires_at  TEXT NOT NULL,
  max_uses    INTEGER NOT NULL DEFAULT 1,
  used_count  INTEGER NOT NULL DEFAULT 0,
  created_by  INTEGER REFERENCES users(id) ON DELETE SET NULL,
  created_at  TEXT NOT NULL DEFAULT (datetime('now'))
);

-- ---------- Версионирование ----------
CREATE TABLE IF NOT EXISTS media_versions (
  id               INTEGER PRIMARY KEY AUTOINCREMENT,
  media_id         INTEGER NOT NULL REFERENCES media(id) ON DELETE CASCADE,
  version_media_id INTEGER NOT NULL REFERENCES media(id) ON DELETE CASCADE,
  note             TEXT DEFAULT '',
  created_by       INTEGER REFERENCES users(id) ON DELETE SET NULL,
  created_at       TEXT NOT NULL DEFAULT (datetime('now'))
);
CREATE INDEX IF NOT EXISTS idx_media_versions_media ON media_versions(media_id);

-- ---------- Сброс пароля ----------
CREATE TABLE IF NOT EXISTS password_resets (
  token       TEXT PRIMARY KEY,
  user_id     INTEGER NOT NULL REFERENCES users(id) ON DELETE CASCADE,
  expires_at  TEXT NOT NULL,
  used        INTEGER NOT NULL DEFAULT 0,
  created_at  TEXT NOT NULL DEFAULT (datetime('now'))
);

-- ---------- Комментарии к фото ----------
CREATE TABLE IF NOT EXISTS media_comments (
  id         INTEGER PRIMARY KEY AUTOINCREMENT,
  media_id   INTEGER NOT NULL REFERENCES media(id) ON DELETE CASCADE,
  user_id    INTEGER REFERENCES users(id) ON DELETE SET NULL,
  body       TEXT NOT NULL,
  created_at TEXT NOT NULL DEFAULT (datetime('now'))
);
CREATE INDEX IF NOT EXISTS idx_media_comments_media ON media_comments(media_id);

-- ---------- Публичные ссылки на альбомы ----------
CREATE TABLE IF NOT EXISTS album_shares (
  token       TEXT PRIMARY KEY,
  album_id    INTEGER NOT NULL REFERENCES albums(id) ON DELETE CASCADE,
  created_by  INTEGER REFERENCES users(id) ON DELETE SET NULL,
  created_at  TEXT NOT NULL DEFAULT (datetime('now'))
);
CREATE INDEX IF NOT EXISTS idx_album_shares_album ON album_shares(album_id);

-- ---------- Начальный альбом ----------
INSERT OR IGNORE INTO albums (title, description) VALUES ('Семья', 'Общие фотографии');