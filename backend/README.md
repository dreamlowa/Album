# Backend API: Family Archive

## Overview
Node.js + Express API для семейного архива: альбомы, медиа (фото/видео), избранное, приглашения. Поддержка SQLite (по умолчанию) и PostgreSQL через DATABASE_URL.

## Стек
- Node.js 18+, TypeScript
- Express, CORS, Helmet
- better-sqlite3 (или pg)
- multer (загрузка файлов)
- bcrypt, jsonwebtoken, dotenv

## Скрипты
- `npm run dev` — запуск с tsx watch
- `npm run build` — tsc
- `npm start` — node dist/index.js

## Переменные окружения
- PORT — порт (по умолчанию 3000)
- JWT_SECRET — секрет JWT
- DATABASE_URL — строка подключения PostgreSQL (опционально)

## Основные эндпоинты
- POST /api/auth/login — вход
- GET /api/auth/me — профиль
- POST /api/invites/login — вход по приглашению
- GET /api/albums — список альбомов
- POST /api/albums — создать альбом
- GET /api/media — медиа (фильтры: albumId, favorite)
- POST /api/media/upload — загрузка
- PUT /api/media/:id/favorite — переключить избранное
- GET /api/health — проверка здоровья

## Файлы
- src/index.ts — сервер и маршруты
- package.json — зависимости и скрипты
- tsconfig.json — TypeScript
- uploads/ — загруженные файлы
- data.db — SQLite (если не задана БД Postgres)

## Быстрый старт
1) cd backend
2) npm ci
3) npm run dev
4) API доступен на http://localhost:3000