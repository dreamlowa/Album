#!/usr/bin/env bash
# ============================================================
# Деплой семейного архива на свежий VPS (Ubuntu 22.04/24.04)
# Запуск:  bash deploy.sh
# ============================================================
set -euo pipefail

echo "==> 1/5 Обновление системы и установка Docker"
sudo apt-get update
sudo apt-get install -y ca-certificates curl gnupg lsb-release

# Docker (официальный репозиторий)
sudo install -m 0755 -d /etc/apt/keyrings
curl -fsSL https://download.docker.com/linux/ubuntu/gpg | sudo gpg --dearmor -o /etc/apt/keyrings/docker.gpg
sudo chmod a+r /etc/apt/keyrings/docker.gpg
echo \
  "deb [arch=$(dpkg --print-architecture) signed-by=/etc/apt/keyrings/docker.gpg] https://download.docker.com/linux/ubuntu \
  $(. /etc/os-release && echo "$VERSION_CODENAME") stable" | \
  sudo tee /etc/apt/sources.list.d/docker.list > /dev/null

sudo apt-get update
sudo apt-get install -y docker-ce docker-ce-cli containerd.io docker-compose-plugin
sudo usermod -aG docker "$USER"

echo "==> 2/5 Перезапуск Docker (права группы)"
sudo systemctl enable --now docker
# Права группы docker применятся после повторного входа; поэтому для текущего запуска:

echo "==> 3/5 Подготовка .env"
if [ ! -f .env ]; then
  cp .env.example .env
  echo "Создан .env из шаблона. ОБЯЗАТЕЛЬНО отредактируйте его: nano .env"
  echo "Затем выполните: docker compose up -d --build"
  exit 0
fi

echo "==> 4/5 Сборка и запуск контейнеров"
docker compose up -d --build

echo "==> 5/5 Проверка"
sleep 5
curl -s http://localhost/api/health && echo " OK" || echo "API ещё не готов — подождите и повторите"
docker compose ps

echo ""
echo "Готово! Откройте http://<IP-сервера> в браузере."
echo "Для HTTPS (рекомендуется) выполните: bash deploy-https.sh"