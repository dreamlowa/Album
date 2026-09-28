#!/usr/bin/env bash
# ============================================================
# HTTPS через Let's Encrypt (Certbot) + автоматическое продление
# Требование: у вас есть домен, A-запись которого указывает на VPS.
# Запуск:  bash deploy-https.sh  (sudo)
# ============================================================
set -euo pipefail

DOMAIN="${1:-}"
if [ -z "$DOMAIN" ]; then
  echo "Укажите домен: bash deploy-https.sh example.ru"
  exit 1
fi

echo "==> 1/4 Установка Certbot"
sudo apt-get update
sudo apt-get install -y certbot python3-certbot-nginx

echo "==> 2/4 Выпуск сертификата (веб-порт 80 уже занят nginx)"
# Останавливаем веб-контейнер, чтобы certbot мог занять порт 80
cd "$(dirname "$0")/.."
docker compose stop web
sudo certbot certonly --standalone -d "$DOMAIN" --non-interactive --agree-tos --email "admin@$DOMAIN" --redirect || \
  sudo certbot certonly --standalone -d "$DOMAIN"

echo "==> 3/4 Настройка nginx на HTTPS"
# Простейший вариант: включаем TLS в nginx-конфиге фронтенда
cat > frontend/nginx/default.conf <<EOF
server {
    listen 80;
    server_name $DOMAIN;
    return 301 https://\$host\$request_uri;
}
server {
    listen 443 ssl http2;
    server_name $DOMAIN;

    ssl_certificate     /etc/letsencrypt/live/$DOMAIN/fullchain.pem;
    ssl_certificate_key /etc/letsencrypt/live/$DOMAIN/privkey.pem;
    ssl_protocols TLSv1.2 TLSv1.3;

    root /usr/share/nginx/html;
    index index.html;

    gzip on;
    gzip_types text/plain text/css application/javascript application/json image/svg+xml;

    location ~* \.(css|js|png|jpg|jpeg|gif|webp|svg|ico)$ {
        expires 30d;
        add_header Cache-Control "public, immutable";
        try_files \$uri =404;
    }
    location / {
        try_files \$uri \$uri/ /index.html;
    }
    location /api/ {
        proxy_pass http://api:3000;
        proxy_http_version 1.1;
        proxy_set_header Host \$host;
        proxy_set_header X-Real-IP \$remote_addr;
        proxy_set_header X-Forwarded-For \$proxy_add_x_forwarded_for;
        proxy_set_header X-Forwarded-Proto \$scheme;
        client_max_body_size 600m;
        proxy_read_timeout 600s;
        proxy_send_timeout 600s;
    }
}
EOF

# Монтируем сертификаты в контейнер nginx
cat > docker-compose.https.yml <<EOF
services:
  web:
    volumes:
      - /etc/letsencrypt:/etc/letsencrypt:ro
EOF

echo "==> 4/4 Пересборка и запуск"
docker compose -f docker-compose.yml -f docker-compose.https.yml up -d --build

echo ""
echo "Готово! Сайт доступен по адресу: https://$DOMAIN"
echo "Продление сертификата автоматическое (systemd timer certbot)."