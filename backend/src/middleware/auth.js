import jwt from 'jsonwebtoken';

/** Проверить JWT в заголовке Authorization: Bearer <token> */
export function requireAuth(req, res, next) {
  const header = req.headers.authorization || '';
  const token = header.startsWith('Bearer ') ? header.slice(7) : null;

  if (!token) {
    return res.status(401).json({ error: 'Требуется вход' });
  }

  try {
    req.user = jwt.verify(token, process.env.JWT_SECRET);
    next();
  } catch {
    return res.status(401).json({ error: 'Сессия истекла. Войдите снова.' });
  }
}

/** Ограничить доступ по ролям. Использование: requireRole('admin', 'editor') */
export function requireRole(...roles) {
  return (req, res, next) => {
    if (!req.user) return res.status(401).json({ error: 'Требуется вход' });
    if (!roles.includes(req.user.role)) {
      return res.status(403).json({ error: 'Недостаточно прав' });
    }
    next();
  };
}