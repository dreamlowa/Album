import { Router } from 'express';
import crypto from 'crypto';
import jwt from 'jsonwebtoken';
import { query, queryOne } from '../db.js';
import { requireAuth, requireRole } from '../middleware/auth.js';

const router = Router();

/**
 * POST /api/invites — создать ссылку-приглашение (admin, editor)
 * Body: { role, expiresInDays, maxUses }
 * Возвращает полную ссылку.
 */
router.post('/', requireAuth, requireRole('admin', 'editor'), async (req, res) => {
  const { role = 'guest', expiresInDays = 365, maxUses = 1 } = req.body || {};
  if (!['guest', 'editor'].includes(role)) {
    return res.status(400).json({ error: 'Недопустимая роль для приглашения' });
  }

  const token = crypto.randomBytes(32).toString('hex');
  const expiresAt = new Date(Date.now() + expiresInDays * 24 * 60 * 60 * 1000);

  await query(
    `INSERT INTO invites (token, role, expires_at, max_uses, created_by) VALUES ($1, $2, $3, $4, $5)`,
    [token, role, expiresAt.toISOString(), maxUses, req.user.id]
  );

  const baseUrl = process.env.APP_URL || `http://localhost:${process.env.PORT || 3000}`;
  const link = `${baseUrl}/?invite=${token}`;

  res.status(201).json({ link, token, role, expiresAt, maxUses });
});

/**
 * POST /api/auth/login-by-invite — войти по приглашению
 * Body: { token }
 */
router.post('/login', async (req, res) => {
  const { token } = req.body || {};
  if (!token) return res.status(400).json({ error: 'Укажите токен приглашения' });

  const invite = await queryOne(
    'SELECT * FROM invites WHERE token = $1', [token]
  );
  if (!invite) return res.status(404).json({ error: 'Приглашение не найдено' });
  if (new Date() > new Date(invite.expires_at)) {
    return res.status(410).json({ error: 'Срок приглашения истёк' });
  }
  if (invite.used_count >= invite.max_uses) {
    return res.status(410).json({ error: 'Приглашение уже использовано' });
  }

  // Создаём временного гостя или используем invite-роль
  // Проще всего: создаём пользователя-однодневку
  const email = `invite-${token}@invite.local`;
  const password_hash = ''; // не входит по паролю
  const name = `Гость (${invite.role === 'editor' ? 'редактор' : 'просмотр'})`;

  const user = await queryOne(
    `INSERT INTO users (email, password_hash, name, role)
     VALUES ($1, $2, $3, $4)
     ON CONFLICT (email) DO UPDATE SET role = $4
     RETURNING id, email, name, role`,
    [email, password_hash, name, invite.role]
  );

  // Увеличиваем счётчик
  await query('UPDATE invites SET used_count = used_count + 1 WHERE token = $1', [token]);

  const jwtToken = jwt.sign(
    { id: user.id, email: user.email, role: user.role, name: user.name },
    process.env.JWT_SECRET,
    { expiresIn: '1d' }  // короткий срок — гость смотрит архив и закрывает
  );

  res.json({
    token: jwtToken,
    user: { id: user.id, email: user.email, name: user.name, role: user.role },
  });
});

/**
 * GET /api/invites — список приглашений (admin)
 */
router.get('/', requireAuth, requireRole('admin'), async (req, res) => {
  const result = await query(
    `SELECT i.*, u.name AS created_by_name
     FROM invites i
     LEFT JOIN users u ON u.id = i.created_by
     ORDER BY i.created_at DESC`
  );
  res.json({ invites: result.rows });
});

export default router;