#!/usr/bin/env bash
# ============================================================
# Универсальный деплой Семейного архива на VPS (Ubuntu 22.04/24.04)
# Одна команда:  bash deploy-vps.sh
#
# Что делает:
#  1. Устанавливает Docker + Compose (если нет)
#  2. Копирует .env.example → .env (если нет)
#  3. Собирает и запускает контейнеры
#  4. Показывает логин/пароль для входа
# ============================================================
set -euo pipefail

echo "============================================"
echo "  Семейный архив — деплой на VPS"
echo "============================================"

# ---------- 1. Docker ----------
if ! command -v docker >/dev/null 2>&1; then
  echo "==> Устанавливаю Docker..."
  sudo apt-get update
  sudo apt-get install -y ca-certificates curl gnupg lsb-release
  sudo install -m 0755 -d /etc/apt/keyrings
  curl -fsSL https://download.docker.com/linux/ubuntu/gpg | sudo gpg --dearmor -o /etc/apt/keyrings/docker.gpg
  echo "deb [arch=$(dpkg --print-architecture) signed-by=/etc/apt/keyrings/docker.gpg] https://download.docker.com/linux/ubuntu $(. /etc/os-release && echo "$VERSION_CODENAME") stable" | sudo tee /etc/apt/sources.list.d/docker.list >/dev/null
  sudo apt-get update
  sudo apt-get install -y docker-ce docker-ce-cli containerd.io docker-compose-plugin
  sudo usermod -aG docker "$USER"
  echo "Docker установлен."
else
  echo "==> Docker уже есть: $(docker --version)"
fi

# ---------- 2. .env ----------
if [ ! -f .env ]; then
  echo "==> Создаю .env из шаблона..."
  cp .env.example .env
  # Генерируем случайные пароли
  sed -i "s/СМЕНИ!-long-random-password-1/$(openssl rand -hex 16)/" .env
  sed -i "s/СМЕНИ!-long-random-password-2/$(openssl rand -hex 16)/" .env
  sed -i "s/СМЕНИ!-openssl-rand-hex-32/$(openssl rand -hex 32)/" .env
  sed -i "s/СМЕНИ!-you@example.com/$(whoami)@localhost/" .env
  sed -i "s/СМЕНИ!-initial-admin-password/$(openssl rand -hex 8)/" .env
  echo "  .env создан с случайными паролями."
  echo "  ВАЖНО: отредактируйте ADMIN_PASSWORD и APP_URL:  nano .env"
else
  echo "==> .env уже существует."
fi

# ---------- 3. Сборка и запуск ----------
echo "==> Собираю и запускаю контейнеры..."
sudo docker compose up -d --build

# ---------- 4. Проверка ----------
echo "==> Проверяю API..."
sleep 6
if curl -sf http://localhost/api/health >/dev/null; then
  echo "  API работает!"
else
  echo "  API ещё поднимается — проверьте: docker compose logs api"
fi

IP=$(curl -s ifconfig.me 2>/dev/null || hostname -I | awk '{print $1}')
echo ""
echo "============================================"
echo "  ГОТОВО!"
echo "  Сайт:      http://$IP"
echo "  Вход:      admin / (ADMIN_PASSWORD из .env)"
echo "  Настройки: nano .env → docker compose up -d"
echo "  HTTPS:     sudo bash deploy/deploy-https.sh ваш-домен.ru"
echo "============================================"