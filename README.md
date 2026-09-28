# Семейный архив фото и видео

Приватный семейный архив на собственном VPS: Docker Compose + PostgreSQL + MinIO (S3) + Node.js API + лёгкий фронтенд на HTML/JS. Никаких тяжёлых фреймворков — быстро грузится даже на слабом мобильном интернете.

## Возможности

- **Мобильная адаптация от 320px**: сетка 1 колонка на телефоне → 2–3 на планшете → 4+ на десктопе (CSS Grid + медиа-запросы).
- **Touch-friendly**: все кнопки ≥ 48×48px, крупные подписи, понятные надписи без IT-сленга (для пожилых родственников).
- **Lightbox на весь экран** со свайпами и стрелками.
- **Lazy loading** через `loading="lazy"` + Intersection Observer.
- **Превью** генерируются на сервере (sharp), на мобильных показываются только превью.
- **Видео** авто-конвертируется в MP4/H.264 (FFmpeg) + poster-кадр.
- **Корзина**: удаление не стирает файл, а помечает `deleted_at`; админ может вернуть или очистить корзину.
- **Роли**: админ / редактор (загрузка и удаление) / гость (только просмотр).
- **Безопасность**: JWT, bcrypt, presigned URL для всех файлов, валидация MIME/расширений, CORS только для своего домена.
- **Офлайн-индикатор**: «Нет интернета», статусы загрузки.
- **Офлайн-режим (Service Worker)**: статика и просмотренные фото кэшируются — открываются без интернета.
- **Распознавание лиц** (опционально): отдельный ML-сервис (Python + face_recognition) находит лица, группирует фото по людям, поиск и переименование персон.
- **EXIF-метаданные**: дата съёмки и GPS-координаты читаются при загрузке; сортировка по дате съёмки, поле `latitude`/`longitude` в БД.
- **Пагинация**: постраничная загрузка по 50 штук (кнопка «Показать ещё»), поиск по названию.
- **Кадрирование**: drag-прямоугольник на canvas (Pointer Events — мышь + тач), 4 угловых маркера, перемещение всей области, затемнение вне выделения.
- **Теги**: метки к фото (светбокс → «Добавить метку»), таблица `tags` + `media_tags` в БД.
- **Автоочистка корзины**: фоновый джоб на бэкенде, удаляет файлы старше 30 дней из MinIO и БД.
- **PWA**: manifest.json, SVG-иконки, установка на домашний экран телефона.

## Структура проекта

```
family-archive/
├── docker-compose.yml          # PostgreSQL + MinIO + API + Nginx
├── docker-compose.ml.yml       # (опционально) ML-сервис распознавания лиц
├── .env.example                # все переменные (копировать в .env)
├── db/
│   └── schema.sql              # таблицы users, albums, media, persons, tags
├── backend/
│   ├── Dockerfile              # Node 20 + FFmpeg
│   ├── package.json
│   └── src/
│       ├── index.js            # Express, CORS, rate limit
│       ├── db.js               # пул PostgreSQL
│       ├── init-admin.js       # создание первого админа из .env
│       ├── middleware/auth.js  # JWT + роли
│       ├── routes/
│       │   ├── auth.js         # login/register/me/password
│       │   ├── media.js        # upload/delete/download/list (+пагинация, поиск)
│       │   ├── albums.js       # CRUD альбомов
│       │   ├── persons.js      # люди (распознавание лиц)
│       │   ├── tags.js         # теги/метки
│       │   └── admin.js        # пользователи + корзина
│       └── utils/
│           ├── s3.js           # клиент MinIO, presigned URL
│           ├── media.js        # превью (sharp), конвертация (FFmpeg)
│           ├── exif.js         # чтение EXIF (дата, GPS)
│           └── cleanup.js      # автоочистка корзины
├── ml/                         # (опционально) распознавание лиц
│   ├── Dockerfile              # Python 3.11 + dlib
│   ├── requirements.txt
│   └── worker.py               # воркер: поиск лиц, группировка по персонам
├── frontend/
│   ├── Dockerfile              # Nginx + статика
│   ├── nginx/default.conf      # раздача статики + прокси на API
│   └── public/
│       ├── index.html          # SPA (вход, галерея, альбомы, люди, админка)
│       ├── sw.js               # Service Worker (офлайн)
│       ├── manifest.json       # PWA (установка на телефон)
│       ├── icons/              # SVG-иконки (192/512/maskable)
│       ├── css/style.css       # адаптивная сетка, светбокс, touch
│       └── js/app.js           # вся логика фронтенда
└── deploy/
    ├── deploy.sh               # установка Docker + запуск
    ├── deploy-https.sh         # HTTPS (Certbot)
    └── backup.sh               # бэкап БД + файлов
```

---

## Развёртывание на VPS (Ubuntu 22.04/24.04)

### Шаг 1. Скопировать проект на сервер

```bash
# локально
scp -r family-archive user@YOUR_SERVER_IP:~
```

### Шаг 2. Установить Docker и запустить

```bash
ssh user@YOUR_SERVER_IP
cd ~/family-archive
bash deploy/deploy.sh
```

Скрипт установит Docker, скопирует `.env.example` в `.env` (если его нет) и остановится — **нужно отредактировать `.env`**:

```bash
nano .env
```

Обязательно поменяйте:
- `APP_URL` → `http://ваш-ip` (или домен после HTTPS)
- `POSTGRES_PASSWORD`, `MINIO_ROOT_PASSWORD` — длинные случайные
- `JWT_SECRET` → `openssl rand -hex 32`
- `ADMIN_EMAIL`, `ADMIN_PASSWORD` — логин/пароль первого админа

Затем запустите:

```bash
docker compose up -d --build
```

Проверка: `curl http://localhost/api/health` → `{"ok":true}`

### Шаг 3. HTTPS (если есть домен)

```bash
# A-запись домена должна указывать на IP сервера
sudo bash deploy/deploy-https.sh example.ru
```

### Шаг 4. Создать пользователей

Войдите как админ → вкладка «Управление» → «Новый пользователь».
Роли:
- **Гость** — только смотреть (для бабушек и дедушек).
- **Редактор** — добавлять и удалять фото.
- **Админ** — всё, включая корзину и пользователей.

---

## Офлайн-режим (Service Worker)

Включён автоматически (работает только по HTTPS или localhost). Что кэшируется:
- Статика (CSS/JS/HTML) — cache-first, обновляется в фоне.
- Просмотренные фото — кэшируются при первом просмотре, открываются без интернета.
- API-ответы (`/api/media`, `/api/albums`) — network-first (при падении сети показывается устаревший кэш).
- Видео **не** кэшируются (могут быть огромными).

**Важно при обновлении фронтенда**: bump версии в `sw.js` (`CACHE_STATIC = 'archive-static-v2'`), чтобы браузеры подхватили новые файлы.

---

## Распознавание лиц (опционально)

Добавляет вкладку «Люди»: фото группируются по лицам, персон можно переименовывать.

```bash
# 1. Убедитесь, что таблицы persons/media_persons/face_jobs созданы
#    (они уже в db/schema.sql — при первом запуске создадутся автоматически)

# 2. Запуск ML-сервиса (образ ~2 ГБ — dlib):
docker compose -f docker-compose.yml -f docker-compose.ml.yml up -d --build

# Проверка
docker compose logs -f ml
```

Как работает:
1. При загрузке фото API ставит задачу в `face_jobs` (pending).
2. Воркер `ml/worker.py` опрашивает очередь, скачивает превью из MinIO.
3. `face_recognition` находит лица и сравнивает их эмбеддинги с известными.
4. Незнакомые лица → создаётся персона «Кто-то (переименуйте)» — админ переименовывает.
5. Результат — в `media_persons`; фронтенд показывает вкладку «Люди».

Параметры (env):
- `FACE_POLL_INTERVAL` — опрос очереди (сек, по умолчанию 30).
- `FACE_CONFIDENCE` — порог схожести 0..1 (по умолчанию 0.5; выше = строже).

Без ML-сервиса всё работает как раньше (`face_jobs` просто заполняется, никто её не читает).

---

## Бэкапы

```bash
# разово
bash deploy/backup.sh

# в cron (каждую ночь в 3:00):
crontab -e
# добавьте строку:
0 3 * * * cd ~/family-archive && bash deploy/backup.sh >> /var/log/archive-backup.log 2>&1
```

Бэкап: дамп PostgreSQL (gzip) + все файлы MinIO. Хранится 14 дней (меняется в `KEEP_DAYS`).

Восстановление:
```bash
# БД
docker compose exec -T db psql -U archive archive < db.sql.gz  # предварительно распаковать
# Файлы
docker compose exec -T minio sh -c 'mc mirror /backup-media local/media'
```

---

## API (кратко)

| Метод | Путь | Роль | Описание |
|---|---|---|---|
| POST | `/api/auth/login` | все | вход, возвращает JWT |
| GET | `/api/auth/me` | все | текущий пользователь |
| POST | `/api/auth/register` | admin | создать пользователя |
| POST | `/api/media/upload` | admin/editor | загрузка (multipart: `file`, `albumId`) |
| GET | `/api/media` | все | список медиа (`?albumId=` фильтр) |
| DELETE | `/api/media/:id` | admin/editor | в корзину |
| GET | `/api/albums` | все | альбомы |
| POST | `/api/albums` | admin/editor | создать альбом |
| GET | `/api/persons` | все | список людей (распознанные лица) |
| GET | `/api/persons/:id` | все | один человек + его фото |
| PATCH | `/api/persons/:id` | admin/editor | переименовать человека |
| GET/POST | `/api/admin/users`, `.../trash` | admin | админка |

---

## Что поменять под себя

- **`MAX_FILE_SIZE`** в `.env` — лимит загрузки (по умолчанию 500 МБ).
- **`PRESIGNED_EXPIRY`** — срок действия ссылок (по умолчанию 3600 с).
- **`frontend/nginx/default.conf`** — `client_max_body_size 600m` под ваш лимит.
- **Сетка галереи** — `frontend/public/css/style.css`, блок `.gallery` (media-запросы 360/600/900/1200px).

## Известные замечания

- Редактирование (кадрирование/фильтры) на клиенте через Canvas: результат сохраняется **новым файлом** поверх исходника не перезаписывается (исходник сохраняется — это безопаснее для семейного архива).
- Конвертация видео идёт в фоне после ответа сервера; в галерее первое время будет poster-кадр, затем MP4.
- `schema.sql` выполняется только при **первом** старте тома `db_data`. Если меняете схему после деплоя — нужен `docker compose down -v` (сотрёт все данные!) или ручной `ALTER TABLE`.

## Лицензия/приватность

Данные не покидают ваш сервер. Сервисы общаются внутри docker-сети; наружу открыт только порт 80/443 (nginx).