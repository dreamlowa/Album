# API: Node.js 20 + системные пакеты для работы с изображениями и видео
FROM node:20-bookworm-slim

# FFmpeg — конвертация видео в MP4/H.264 + генерация превью-кадра (poster)
RUN apt-get update \
  && apt-get install -y --no-install-recommends ffmpeg \
  && rm -rf /var/lib/apt/lists/*

WORKDIR /app

COPY package*.json ./
RUN npm ci --omit=dev

COPY src ./src

# Временная папка для конвертации видео
RUN mkdir -p /tmp/uploads

EXPOSE 3000

ENV NODE_ENV=production
CMD ["node", "src/index.js"]