#!/usr/bin/env bash
# ============================================================
# Бэкап: PostgreSQL (дамп) + MinIO (файлы) в одну папку с датой.
# Поставить в cron: 0 3 * * * /path/to/backup.sh >> /var/log/archive-backup.log 2>&1
# ============================================================
set -euo pipefail

BACKUP_DIR="${BACKUP_DIR:-/var/backups/family-archive}"
KEEP_DAYS="${KEEP_DAYS:-14}"
STAMP="$(date +%Y-%m-%d_%H-%M)"
DEST="$BACKUP_DIR/$STAMP"
mkdir -p "$DEST"

echo "[$(date)] === Начинаю бэкап ==="

# ---------- 1. Дамп базы ----------
docker compose exec -T db pg_dump -U "${POSTGRES_USER:-archive}" "${POSTGRES_DB:-archive}" \
  | gzip > "$DEST/db.sql.gz"
echo "[$(date)] База: $DEST/db.sql.gz ($(du -h "$DEST/db.sql.gz" | cut -f1))"

# ---------- 2. Файлы MinIO (весь бакет) ----------
# Используем клиент mc внутри контейнера minio, чтобы не ставить ничего на хост
docker compose exec -T minio sh -c '
  mc alias set local http://localhost:9000 "$MINIO_ROOT_USER" "$MINIO_ROOT_PASSWORD" >/dev/null 2>&1
  mc mirror --overwrite local/media /backup-media
' || {
  # Альтернатива: если mc в контейнере недоступен — копируем том напрямую
  echo "[$(date)] mc недоступен, копирую том minio_data..."
  # Пример с tar тома (нужен путь volume). Меняется под вашу систему.
  docker run --rm -v archive_minio_data:/data -v "$DEST":/backup alpine \
    sh -c "tar czf /backup/minio.tar.gz -C /data ."
  echo "[$(date)] MinIO том запакован в $DEST/minio.tar.gz"
}

# ---------- 3. Ротация: удаляем старые бэкапы ----------
find "$BACKUP_DIR" -mindepth 1 -maxdepth 1 -mtime +"$KEEP_DAYS" -exec rm -rf {} \;
echo "[$(date)] Бэкапы старее $KEEP_DAYS дней удалены."

echo "[$(date)] === Готово: $DEST ==="