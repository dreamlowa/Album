import { Router } from 'express';
import bcrypt from 'bcryptjs';
import jwt from 'jsonwebtoken';
import multer from 'multer';
import crypto from 'crypto';
import path from 'path';
import { query, queryOne } from '../db.js';
import { requireAuth } from '../middleware/auth.js';
import { uploadFile, deleteFile, getPresignedUrl } from '../utils/s3.js';

const router = Router();

function toUserDto(row) {
  return {
    id: row.id,
    email: row.email,
    name: row.name,
    role: row.role,
    bio: row.bio || '',
    avatarKey: row.avatar_key || null,
    createdAt: row.created_at,
  };
}

async function attachAvatar(dto) {
  const avatarUrl = dto.avatarKey ? await getPresignedUrl(dto.avatarKey) : null;
  return { ...dto, avatar: avatarUrl };
}

// Аватар: только изображения
const avatarUpload = multer({
  storage: multer.memoryStorage(),
  limits: { fileSize: 8 * 1024 * 1024 },
});

function isImage(buf) {
  // magic bytes: PNG, JPEG, GIF, WebP
  if (!buf || buf.length < 12) return false;
  if (buf[0] === 0x89 && buf[1] === 0x50 && buf[2] === 0x4e && buf[3] === 0x47) return true; // PNG
  if (buf[0] === 0xff && buf[1] === 0xd8 && buf[2] === 0xff) return true; // JPEG
  if (buf[0] === 0x47 && buf[1] === 0x49 && buf[2] === 0x46) return true; // GIF
  if (buf[0] === 0x52 && buf[1] === 0x49 && buf[2] === 0x46 && buf[3] === 0x46) return true; // WEBP/RIFF
  return false;
}

/**
 /**
 * POST /api/auth/register — открытая регистрация гостя (только просмотр).
 * Роль всегда 'guest' — редактором/админом делает владелец вручную.
 * Body: { email, password, name }
 */
router.post('/register', async (req, res) => {
  const { email, password, name } = req.body || {};
  if (!email || !password || !name) {
    return res.status(400).json({ error: 'Заполните email, пароль и имя' });
  }
  if (String(password).length < 8) {
    return res.status(400).json({ error: 'Пароль должен быть не короче 8 символов' });
  }

  const exists = await queryOne('SELECT id FROM users WHERE email = $1', [email]);
  if (exists) return res.status(409).json({ error: 'Пользователь с таким email уже есть' });

  const password_hash = await bcrypt.hash(password, 10);
  const user = await queryOne(
    `INSERT INTO users (email, password_hash, name, role) VALUES ($1, $2, $3, 'guest')
     RETURNING id, email, name, role, created_at`,
    [email, password_hash, name]
  );
  res.status(201).json({ user });
});

/**
 * POST /api/auth/login — вход
 * Body: { email, password }
 */
router.post('/login', async (req, res) => {
  const { email, password } = req.body || {};
  if (!email || !password) {
    return res.status(400).json({ error: 'Введите email и пароль' });
  }

  const user = await queryOne('SELECT * FROM users WHERE email = $1', [email]);
  if (!user) return res.status(401).json({ error: 'Неверный email или пароль' });

  const ok = await bcrypt.compare(password, user.password_hash);
  if (!ok) return res.status(401).json({ error: 'Неверный email или пароль' });

  const token = jwt.sign(
    { id: user.id, email: user.email, role: user.role, name: user.name },
    process.env.JWT_SECRET,
    { expiresIn: '30d' }
  );

  res.json({
    token,
    user: await attachAvatar(toUserDto(user)),
  });
});

/** GET /api/auth/me — кто я (для восстановления сессии при F5) */
router.get('/me', requireAuth, async (req, res) => {
  const user = await queryOne(
    'SELECT id, email, name, role, avatar_key, bio, created_at FROM users WHERE id = $1',
    [req.user.id]
  );
  if (!user) return res.status(404).json({ error: 'Пользователь не найден' });
  res.json({ user: await attachAvatar(toUserDto(user)) });
});

/** PUT /api/auth/password — смена своего пароля */
router.put('/password', requireAuth, async (req, res) => {
  const { oldPassword, newPassword } = req.body || {};
  const user = await queryOne('SELECT * FROM users WHERE id = $1', [req.user.id]);
  if (!user) return res.status(404).json({ error: 'Пользователь не найден' });

  const ok = await bcrypt.compare(oldPassword || '', user.password_hash);
  if (!ok) return res.status(400).json({ error: 'Старый пароль неверный' });
  if (String(newPassword || '').length < 8) {
    return res.status(400).json({ error: 'Новый пароль должен быть не короче 8 символов' });
  }

  const password_hash = await bcrypt.hash(newPassword, 10);
  await query('UPDATE users SET password_hash = $1 WHERE id = $2', [password_hash, user.id]);
  res.json({ ok: true });
});

/** PATCH /api/auth/profile — обновить имя и биографию */
router.patch('/profile', requireAuth, async (req, res) => {
  const { name, bio } = req.body || {};
  const updates = [];
  const params = [];
  let idx = 0;
  if (name !== undefined) { updates.push(`name = $${++idx}`); params.push(String(name).trim()); }
  if (bio !== undefined) { updates.push(`bio = $${++idx}`); params.push(String(bio).trim()); }
  if (!updates.length) return res.status(400).json({ error: 'Нет данных для обновления' });
  params.push(req.user.id);
  const row = await queryOne(
    `UPDATE users SET ${updates.join(', ')} WHERE id = $${idx + 1} RETURNING *`,
    params
  );
  if (!row) return res.status(404).json({ error: 'Пользователь не найден' });
  res.json({ user: await attachAvatar(toUserDto(row)) });
});

/** POST /api/auth/avatar — загрузить аватар */
router.post('/avatar', requireAuth, avatarUpload.single('avatar'), async (req, res) => {
  if (!req.file || !isImage(req.file.buffer)) {
    return res.status(400).json({ error: 'Загрузите изображение (PNG/JPEG/GIF/WebP)' });
  }
  const ext = path.extname(req.file.originalname || '.png').toLowerCase();
  const key = `avatars/${req.user.id}-${crypto.randomBytes(6).toString('hex')}${ext || '.png'}`;
  await uploadFile(key, req.file.buffer, req.file.mimetype);

  // Удаляем старый аватар
  const old = await queryOne('SELECT avatar_key FROM users WHERE id = $1', [req.user.id]);
  if (old?.avatar_key) await deleteFile(old.avatar_key).catch(() => {});

  await query('UPDATE users SET avatar_key = $1 WHERE id = $2', [key, req.user.id]);
  const url = await getPresignedUrl(key);
  res.json({ ok: true, avatarKey: key, avatar: url });
});

export default router;