import 'dotenv/config';
import bcrypt from 'bcryptjs';
import { query, queryOne } from './db.js';

/** Создать начального администратора из переменных окружения */
export async function bootstrapAdmin() {
  const email = process.env.ADMIN_EMAIL;
  const password = process.env.ADMIN_PASSWORD;
  const name = process.env.ADMIN_NAME || 'Администратор';

  if (!email || !password) {
    console.warn('ADMIN_EMAIL / ADMIN_PASSWORD не заданы — начальный админ не создан.');
    return;
  }

  const existing = await queryOne('SELECT id FROM users WHERE email = $1', [email]);
  if (existing) {
    console.log('Администратор уже существует, пропускаю.');
    return;
  }

  const hash = await bcrypt.hash(password, 10);
  await query(
    `INSERT INTO users (email, password_hash, name, role) VALUES ($1, $2, $3, 'admin')`,
    [email, hash, name]
  );
  console.log(`Создан начальный администратор: ${email}`);
}