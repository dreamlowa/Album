#!/usr/bin/env python3
"""
Face Recognition Worker — sidecar для семейного архива.

Алгоритм:
1. Опрашивает таблицу face_jobs — ищет pending-задачи.
2. Скачивает превью (thumb) изображения из MinIO.
3. Детектирует лица (face_recognition / dlib).
4. Сравнивает эмбеддинги с известными персонами (по центроидам).
5. Если лицо совпало с confidence > 0.5 — привязывает к существующей персоне.
6. Если лицо незнакомое — создаёт персону «Кто-то #ID» (админ переименует позже).
7. Сохраняет результаты в media_persons.
8. Помечает задачу как done (или error).

Запуск:  python worker.py
Зависимости: pip install face-recognition numpy psycopg2-binary boto3 requests
"""

import os
import io
import time
import logging
import traceback
from datetime import datetime, timezone

import numpy as np
import psycopg2
import psycopg2.extras
import boto3
from botocore.client import Config
import face_recognition

logging.basicConfig(level=logging.INFO, format="%(asctime)s [%(levelname)s] %(message)s")
log = logging.getLogger(__name__)

# ---------- Конфигурация из переменных окружения ----------

DB_URL = os.environ.get("DATABASE_URL", "postgres://archive:password@db:5432/archive")

S3_ENDPOINT = os.environ.get("S3_ENDPOINT", "minio")
S3_PORT = os.environ.get("S3_PORT", "9000")
S3_ACCESS_KEY = os.environ.get("MINIO_ROOT_USER", "archive")
S3_SECRET_KEY = os.environ.get("MINIO_ROOT_PASSWORD", "password")
S3_BUCKET = os.environ.get("S3_BUCKET", "media")

POLL_INTERVAL = int(os.environ.get("FACE_POLL_INTERVAL", "30"))  # секунд между опросами
CONFIDENCE_THRESHOLD = float(os.environ.get("FACE_CONFIDENCE", "0.5"))

# ---------- S3 клиент ----------

s3_client = boto3.client(
    "s3",
    endpoint_url=f"http://{S3_ENDPOINT}:{S3_PORT}",
    aws_access_key_id=S3_ACCESS_KEY,
    aws_secret_access_key=S3_SECRET_KEY,
    config=Config(signature_version="s3v4"),
    region_name="us-east-1",
)


def download_thumb(thumb_key: str) -> bytes | None:
    """Скачать превью из MinIO. Возвращает байты или None."""
    if not thumb_key:
        return None
    try:
        obj = s3_client.get_object(Bucket=S3_BUCKET, Key=thumb_key)
        return obj["Body"].read()
    except Exception as e:
        log.warning("Не удалось скачать %s: %s", thumb_key, e)
        return None


# ---------- База данных ----------

def get_db():
    conn = psycopg2.connect(DB_URL)
    conn.autocommit = True
    return conn


def fetch_pending_jobs(conn):
    """Выбрать до 5 pending задач, отсортированных по oldest first."""
    cur = conn.cursor(cursor_factory=psycopg2.extras.RealDictCursor)
    cur.execute("""
        SELECT m.id, m.thumb_key, m.storage_key
        FROM face_jobs fj
        JOIN media m ON m.id = fj.media_id
        WHERE fj.status = 'pending'
        ORDER BY fj.updated_at ASC
        LIMIT 5
    """)
    rows = cur.fetchall()
    cur.close()
    return rows


def get_all_person_embeddings(conn):
    """Загрузить всех известных персон и их центроиды."""
    cur = conn.cursor(cursor_factory=psycopg2.extras.RealDictCursor)
    cur.execute("SELECT id, name, embedding FROM persons WHERE embedding IS NOT NULL")
    rows = cur.fetchall()
    cur.close()

    persons = []
    for r in rows:
        emb = np.array(r["embedding"], dtype=np.float64)
        persons.append({"id": r["id"], "name": r["name"], "embedding": emb})
    return persons


def find_or_create_person(conn, face_encoding, known_persons):
    """
    Сравнить эмбеддинг с известными. Если не нашли — создать новую персону.
    Возвращает (person_id, confidence, is_new).
    """
    if len(known_persons) == 0:
        return _create_person(conn, face_encoding), 1.0, True

    face_vec = np.array(face_encoding, dtype=np.float64)
    best_id = None
    best_dist = float("inf")

    for p in known_persons:
        # Евклидово расстояние (меньше = ближе)
        dist = np.linalg.norm(face_vec - p["embedding"])
        if dist < best_dist:
            best_dist = dist
            best_id = p["id"]

    # face_recognition: typical "match" distance < 0.6
    # Чем меньше расстояние, тем выше "уверенность"
    confidence = max(0.0, 1.0 - best_dist)

    if best_id is not None and best_dist < (1.0 - CONFIDENCE_THRESHOLD):
        # Обновляем центроид персоны (скользящее среднее)
        _update_person_centroid(conn, best_id, face_encoding)
        return best_id, confidence, False

    # Незнакомое лицо — создаём новую персону
    return _create_person(conn, face_encoding), 1.0, True


def _create_person(conn, face_encoding):
    """Создать персону с заданным эмбеддингом."""
    cur = conn.cursor()
    emb_json = psycopg2.extras.Json(face_encoding.tolist() if isinstance(face_encoding, np.ndarray) else face_encoding)
    cur.execute(
        "INSERT INTO persons (name, embedding) VALUES (%s, %s) RETURNING id",
        ("Кто-то (переименуйте)", emb_json),
    )
    person_id = cur.fetchone()[0]
    conn.commit()
    cur.close()
    log.info("Создана новая персона #%s", person_id)
    return person_id


def _update_person_centroid(conn, person_id, face_encoding):
    """Обновить центроид персоны как среднее нового и старого."""
    cur = conn.cursor(cursor_factory=psycopg2.extras.RealDictCursor)
    cur.execute("SELECT embedding FROM persons WHERE id = %s", (person_id,))
    row = cur.fetchone()
    cur.close()
    if row is None or row["embedding"] is None:
        emb = np.array(face_encoding, dtype=np.float64)
    else:
        old = np.array(row["embedding"], dtype=np.float64)
        emb = (old + np.array(face_encoding, dtype=np.float64)) / 2.0

    cur = conn.cursor()
    cur.execute(
        "UPDATE persons SET embedding = %s WHERE id = %s",
        (psycopg2.extras.Json(emb.tolist()), person_id),
    )
    conn.commit()
    cur.close()


def process_image(conn, media_id, image_bytes, known_persons):
    """Найти лица на изображении и обновить БД."""
    # face_recognition принимает numpy array (H, W, 3)
    import PIL.Image
    try:
        pil_img = PIL.Image.open(io.BytesIO(image_bytes))
        # Конвертировать в RGB (на случай RGBA/другого)
        img_array = np.array(pil_img.convert("RGB"))
    except Exception as e:
        raise ValueError(f"Не удалось декодировать изображение: {e}")

    # face_recognition работает с RGB
    face_locations = face_recognition.face_locations(img_array, model="hog")
    face_encodings = face_recognition.face_encodings(img_array, face_locations)

    if len(face_encodings) == 0:
        log.info("media #%s: лиц не найдено", media_id)
        return 0

    log.info("media #%s: найдено лиц: %s", media_id, len(face_encodings))

    for i, (encoding, loc) in enumerate(zip(face_encodings, face_locations)):
        person_id, confidence, is_new = find_or_create_person(conn, encoding, known_persons)

        box = {"top": loc[0], "right": loc[1], "bottom": loc[2], "left": loc[3]}
        emb_json = psycopg2.extras.Json(encoding.tolist())

        cur = conn.cursor()
        cur.execute(
            """INSERT INTO media_persons (media_id, person_id, confidence, embedding, box)
               VALUES (%s, %s, %s, %s, %s)
               ON CONFLICT DO NOTHING""",
            (media_id, person_id, round(float(confidence), 4), emb_json, psycopg2.extras.Json(box)),
        )
        conn.commit()
        cur.close()

        log.info(
            "  лицо #%d → персона #%s (%s), уверенность %.2f",
            i, person_id, "новая" if is_new else "известная", confidence,
        )

    return len(face_encodings)


def mark_job(conn, media_id, status, error=None):
    cur = conn.cursor()
    cur.execute(
        "UPDATE face_jobs SET status = %s, error = %s, updated_at = %s WHERE media_id = %s",
        (status, error, datetime.now(timezone.utc), media_id),
    )
    conn.commit()
    cur.close()


def main():
    log.info("Face Recognition Worker запущен. Опрос каждые %dс.", POLL_INTERVAL)

    while True:
        try:
            conn = get_db()
            jobs = fetch_pending_jobs(conn)
            if not jobs:
                conn.close()
                time.sleep(POLL_INTERVAL)
                continue

            known_persons = get_all_person_embeddings(conn)
            log.info("Известных персон: %d, задач: %d", len(known_persons), len(jobs))

            for job in jobs:
                media_id = job["id"]
                thumb_key = job["thumb_key"]
                storage_key = job["storage_key"]

                # Сначала пробуем превью (обычно хватает для лиц)
                image_data = download_thumb(thumb_key)
                if image_data is None:
                    # Если превью нет — скачиваем оригинал
                    image_data = download_thumb(storage_key)
                if image_data is None:
                    log.warning("media #%s: нет данных для скачивания", media_id)
                    mark_job(conn, media_id, "error", "Не удалось скачать файл из MinIO")
                    continue

                try:
                    found = process_image(conn, media_id, image_data, known_persons)
                    mark_job(conn, media_id, "done")
                    log.info("media #%s: обработано, лиц: %d", media_id, found)
                except Exception as e:
                    log.error("media #%s: ошибка: %s", media_id, e)
                    log.debug(traceback.format_exc())
                    mark_job(conn, media_id, "error", str(e)[:500])

                # Обновляем кэш персон после каждой задачи
                known_persons = get_all_person_embeddings(conn)

            conn.close()
        except Exception as e:
            log.error("Глобальная ошибка цикла: %s", e)
            log.debug(traceback.format_exc())
            time.sleep(POLL_INTERVAL)


if __name__ == "__main__":
    main()