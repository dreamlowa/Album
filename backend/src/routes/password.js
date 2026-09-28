import { Router } from 'express';
import crypto from 'crypto';
import bcrypt from 'bcryptjs';
import { query, queryOne, run } from '../db.js';

const router = Router();

/**
 * POST /api/password/forgot — создать токен сброса.
 * Body: { email }
 *
 * Важно: пароли не отправляются по почте. Возвращает ТОКЕН прямо в ответе
 * (это приватный домашний архив одного VPS — владелец сервера сам передаёт
 * ссылку сброса родственнику любым удобным способом: телефоном, в мессенджере).
 */
router.post('/forgot', async (req, res) => {
  const { email } = req.body || {};
  if (!email || !String(email).trim()) {
    return res.status(400).json({ error: 'Введите логин' });
  }

  const user = await queryOne('SELECT id FROM users WHERE email = $1', [String(email).trim()]);
  if (!user) {
    return res.json({ ok: true, message: 'Если такой пользователь есть, ссылка будет создана.' });
  }

  const token = crypto.randomBytes(32).toString('hex');
  const expiresAt = new Date(Date.now() + 60 * 60 * 1000); // 1 час

  await run(
    `INSERT INTO password_resets (token, user_id, expires_at) VALUES ($1, $2, $3)`,
    [token, user.id, expiresAt.toISOString()]
  );

  const baseUrl = process.env.APP_URL || `http://localhost:${process.env.PORT || 3000}`;
  const link = `${baseUrl}/?reset=${token}`;

  console.log(`[Сброс пароля] пользователь ${String(email).trim()}: ${link}`);

  res.json({ ok: true, token, link });
});

/**
 * POST /api/password/reset — установить новый пароль.
 * Body: { token, password }
 * Токен одноразовый, живёт 1 час.
 */
router.post('/reset', async (req, res) => {
  const { token, password } = req.body || {};
  if (!token) return res.status(400).json({ error: 'Не указан токен' });
  if (!password || String(password).length < 8) {
    return res.status(400).json({ error: 'Пароль должен быть не короче 8 символов' });
  }

  const row = await queryOne(
    'SELECT * FROM password_resets WHERE token = $1 AND used = 0',
    [token]
  );
  if (!row) return res.status(404).json({ error: 'Ссылка недействительна или уже использована' });

  const expiresAt = new Date(row.expires_at);
  if (Number.isNaN(expiresAt.getTime()) || expiresAt.getTime() < Date.now()) {
    return res.status(410).json({ error: 'Срок действия ссылки истёк. Запросите новую.' });
  }

  const hash = await bcrypt.hash(password, 10);
  await run('UPDATE users SET password_hash = $1 WHERE id = $2', [hash, row.user_id]);
  await run('UPDATE password_resets SET used = 1 WHERE token = $1', [token]);

  res.json({ ok: true, message: 'Пароль изменён. Можете войти.' });
});

export default router;