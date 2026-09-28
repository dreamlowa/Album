-- ============================================================
-- Семейный архив — схема базы данных (PostgreSQL)
-- Автоматически выполняется при первом старте контейнера db
-- (монтируется в /docker-entrypoint-initdb.d)
-- ============================================================

-- ---------- Пользователи / роли ----------
CREATE TABLE IF NOT EXISTS users (
  id            SERIAL PRIMARY KEY,
  email         TEXT UNIQUE NOT NULL,
  password_hash TEXT NOT NULL,
  name          TEXT NOT NULL,
  role          TEXT NOT NULL DEFAULT 'guest'
                CHECK (role IN ('admin', 'editor', 'guest')),
  avatar_key    TEXT,
  bio           TEXT,
  created_at    TIMESTAMPTZ NOT NULL DEFAULT now()
);

-- ---------- Альбомы ----------
CREATE TABLE IF NOT EXISTS albums (
  id          SERIAL PRIMARY KEY,
  title       TEXT NOT NULL,
  description TEXT DEFAULT '',
  created_by  INTEGER REFERENCES users(id) ON DELETE SET NULL,
  created_at  TIMESTAMPTZ NOT NULL DEFAULT now()
);

-- ---------- Медиафайлы ----------
-- deleted_at = NULL — файл на месте;
-- deleted_at задан — файл в «корзине» (скрыт из галереи, удаляется физически через 30 дней)
CREATE TABLE IF NOT EXISTS media (
  id             SERIAL PRIMARY KEY,
  album_id       INTEGER REFERENCES albums(id) ON DELETE CASCADE,
  uploaded_by    INTEGER REFERENCES users(id) ON DELETE SET NULL,
  filename       TEXT NOT NULL,               -- оригинальное имя файла
  storage_key    TEXT NOT NULL UNIQUE,        -- ключ объекта в MinIO (путь в бакете)
  thumb_key      TEXT,                        -- ключ превью в MinIO
  poster_key     TEXT,                        -- ключ poster-кадра для видео
  converted_key  TEXT,                        -- ключ конвертированного MP4 (если видео)
  mime_type      TEXT NOT NULL,
  kind           TEXT NOT NULL CHECK (kind IN ('image', 'video')),
  size_bytes     BIGINT NOT NULL DEFAULT 0,
  width          INTEGER,
  height         INTEGER,
  date_taken     TIMESTAMPTZ,                 -- дата съёмки (из EXIF, если есть)
  latitude       DOUBLE PRECISION,            -- GPS-широта (EXIF)
  longitude      DOUBLE PRECISION,            -- GPS-долгота (EXIF)
  is_converted   BOOLEAN NOT NULL DEFAULT FALSE, -- TRUE, если видео уже перекодировано в MP4/H.264
  is_favorite    BOOLEAN NOT NULL DEFAULT FALSE, -- избранное (❤)
  reveal_at      TIMESTAMPTZ,                 -- капсула времени: дата раскрытия
  deleted_at     TIMESTAMPTZ,                 -- корзина
  created_at     TIMESTAMPTZ NOT NULL DEFAULT now()
);

CREATE INDEX IF NOT EXISTS idx_media_album     ON media(album_id);
CREATE INDEX IF NOT EXISTS idx_media_deleted   ON media(deleted_at);
CREATE INDEX IF NOT EXISTS idx_media_date      ON media(date_taken);

-- ---------- Ретро-миграция для существующих установок ----------
-- Если колонки latitude/longitude добавлены позже — добавляем их (идемпотентно)
DO $$
BEGIN
  IF NOT EXISTS (SELECT 1 FROM information_schema.columns WHERE table_name='media' AND column_name='latitude') THEN
    ALTER TABLE media ADD COLUMN latitude DOUBLE PRECISION;
  END IF;
  IF NOT EXISTS (SELECT 1 FROM information_schema.columns WHERE table_name='media' AND column_name='longitude') THEN
    ALTER TABLE media ADD COLUMN longitude DOUBLE PRECISION;
  END IF;
END $$;

-- ---------- Начальный альбом ----------
-- Создаётся в schema.sql, чтобы у гостя сразу был раздел «Общие фото».
-- (idempotent: повторный запуск скрипта ошибку не даст)
INSERT INTO albums (title, description)
SELECT 'Семья', 'Общие фотографии'
WHERE NOT EXISTS (SELECT 1 FROM albums WHERE title = 'Семья');

-- ============================================================
-- Распознавание лиц (ML-сервис sidecar, см. docker-compose.ml.yml)
-- ============================================================

-- Люди (персоны)
CREATE TABLE IF NOT EXISTS persons (
  id              SERIAL PRIMARY KEY,
  name            TEXT NOT NULL,                      -- имя («Бабушка Люда»)
  embedding       JSONB,                              -- центроид (среднее) дескрипторов лиц
  avatar_media_id INTEGER REFERENCES media(id) ON DELETE SET NULL, -- фото для аватара
  created_at      TIMESTAMPTZ NOT NULL DEFAULT now()
);

-- Связь лицо ↔ медиа (много-ко-многим)
CREATE TABLE IF NOT EXISTS media_persons (
  media_id    INTEGER NOT NULL REFERENCES media(id) ON DELETE CASCADE,
  person_id   INTEGER NOT NULL REFERENCES persons(id) ON DELETE CASCADE,
  confidence  REAL NOT NULL DEFAULT 1.0,             -- уверенность 0..1
  embedding   JSONB,                                 -- дескриптор конкретного лица
  box         JSONB,                                 -- координаты лица [l,t,r,b]
  PRIMARY KEY (media_id, person_id)
);

-- Очередь распознавания: pending -> done/error
CREATE TABLE IF NOT EXISTS face_jobs (
  media_id    INTEGER PRIMARY KEY REFERENCES media(id) ON DELETE CASCADE,
  status      TEXT NOT NULL DEFAULT 'pending' CHECK (status IN ('pending','done','error')),
  error       TEXT,
  updated_at  TIMESTAMPTZ NOT NULL DEFAULT now()
);

-- Теги (свободные метки: «Выпускной», «Море 2025», «Маша»)
CREATE TABLE IF NOT EXISTS tags (
  id          SERIAL PRIMARY KEY,
  name        TEXT UNIQUE NOT NULL
);

CREATE TABLE IF NOT EXISTS media_tags (
  media_id    INTEGER NOT NULL REFERENCES media(id) ON DELETE CASCADE,
  tag_id      INTEGER NOT NULL REFERENCES tags(id) ON DELETE CASCADE,
  PRIMARY KEY (media_id, tag_id)
);

CREATE INDEX IF NOT EXISTS idx_media_persons_person ON media_persons(person_id);
CREATE INDEX IF NOT EXISTS idx_media_persons_media  ON media_persons(media_id);
CREATE INDEX IF NOT EXISTS idx_media_tags_tag       ON media_tags(tag_id);
CREATE INDEX IF NOT EXISTS idx_face_jobs_status     ON face_jobs(status);

-- ============================================================
-- Ссылки-приглашения (гость смотрит архив без пароля)
-- ============================================================
CREATE TABLE IF NOT EXISTS invites (
  token       TEXT PRIMARY KEY,
  role        TEXT NOT NULL DEFAULT 'guest' CHECK (role IN ('guest', 'editor')),
  expires_at  TIMESTAMPTZ NOT NULL,
  max_uses    INTEGER NOT NULL DEFAULT 1,
  used_count  INTEGER NOT NULL DEFAULT 0,
  created_by  INTEGER REFERENCES users(id) ON DELETE SET NULL,
  created_at  TIMESTAMPTZ NOT NULL DEFAULT now()
);

-- ============================================================
-- Версионирование: история правок медиафайла
-- ============================================================
CREATE TABLE IF NOT EXISTS media_versions (
  id                 SERIAL PRIMARY KEY,
  media_id           INTEGER NOT NULL REFERENCES media(id) ON DELETE CASCADE,
  version_media_id   INTEGER NOT NULL REFERENCES media(id) ON DELETE CASCADE,
  note               TEXT DEFAULT '',
  created_by         INTEGER REFERENCES users(id) ON DELETE SET NULL,
  created_at         TIMESTAMPTZ NOT NULL DEFAULT now()
);
CREATE INDEX IF NOT EXISTS idx_media_versions_media ON media_versions(media_id);

-- ============================================================
-- Сброс пароля
-- ============================================================
CREATE TABLE IF NOT EXISTS password_resets (
  token       TEXT PRIMARY KEY,
  user_id     INTEGER NOT NULL REFERENCES users(id) ON DELETE CASCADE,
  expires_at  TIMESTAMPTZ NOT NULL,
  used        INTEGER NOT NULL DEFAULT 0,
  created_at  TIMESTAMPTZ NOT NULL DEFAULT now()
);

-- ============================================================
-- Комментарии к фото
-- ============================================================
CREATE TABLE IF NOT EXISTS media_comments (
  id         SERIAL PRIMARY KEY,
  media_id   INTEGER NOT NULL REFERENCES media(id) ON DELETE CASCADE,
  user_id    INTEGER REFERENCES users(id) ON DELETE SET NULL,
  body       TEXT NOT NULL,
  created_at TIMESTAMPTZ NOT NULL DEFAULT now()
);
CREATE INDEX IF NOT EXISTS idx_media_comments_media ON media_comments(media_id);

-- ============================================================
-- Публичные ссылки на альбомы
-- ============================================================
CREATE TABLE IF NOT EXISTS album_shares (
  token      TEXT PRIMARY KEY,
  album_id   INTEGER NOT NULL REFERENCES albums(id) ON DELETE CASCADE,
  created_by INTEGER REFERENCES users(id) ON DELETE SET NULL,
  created_at TIMESTAMPTZ NOT NULL DEFAULT now()
);
CREATE INDEX IF NOT EXISTS idx_album_shares_album ON album_shares(album_id);