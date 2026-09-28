import 'dotenv/config';
import express from 'express';
import cors from 'cors';
import helmet from 'helmet';
import multer from 'multer';
import { v4 as uuidv4 } from 'uuid';
import bcrypt from 'bcrypt';
import jwt from 'jsonwebtoken';
import Database from 'better-sqlite3';
import { Pool } from 'pg';
import path from 'path';
import fs from 'fs';

const app = express();
const PORT = process.env.PORT || 3000;
const JWT_SECRET = process.env.JWT_SECRET || 'change-this-secret';
const SALT_ROUNDS = 12;

app.use(helmet());
app.use(cors({ origin: true, credentials: true }));
app.use(express.json({ limit: '50mb' }));
app.use(express.urlencoded({ extended: true, limit: '50mb' }));

// Storage
const storage = multer.diskStorage({
  destination: (req, file, cb) => {
    const dir = path.join(process.cwd(), 'uploads');
    if (!fs.existsSync(dir)) fs.mkdirSync(dir, { recursive: true });
    cb(null, dir);
  },
  filename: (req, file, cb) => {
    const ext = file.originalname.split('.').pop();
    cb(null, `${uuidv4()}.${ext}`);
  },
});
const upload = multer({ storage, limits: { fileSize: 100 * 1024 * 1024 } });

// DB
let db;
let pg;
function initDb() {
  const usePg = process.env.DATABASE_URL;
  if (usePg) {
    pg = new Pool({ connectionString: usePg });
    return;
  }
  const dbPath = path.join(process.cwd(), 'data.db');
  db = new Database(dbPath);
  db.pragma('journal_mode = WAL');

  // Users
  db.prepare(`
    CREATE TABLE IF NOT EXISTS users (
      id INTEGER PRIMARY KEY AUTOINCREMENT,
      email TEXT UNIQUE NOT NULL,
      name TEXT NOT NULL,
      password TEXT NOT NULL,
      role TEXT NOT NULL CHECK(role IN ('admin','editor','guest')),
      created_at TEXT NOT NULL
    )
  `).run();

  // Albums
  db.prepare(`
    CREATE TABLE IF NOT EXISTS albums (
      id INTEGER PRIMARY KEY AUTOINCREMENT,
      user_id INTEGER NOT NULL,
      title TEXT NOT NULL,
      description TEXT,
      created_at TEXT NOT NULL,
      FOREIGN KEY(user_id) REFERENCES users(id) ON DELETE CASCADE
    )
  `).run();

  // Media
  db.prepare(`
    CREATE TABLE IF NOT EXISTS media (
      id INTEGER PRIMARY KEY AUTOINCREMENT,
      album_id INTEGER,
      user_id INTEGER NOT NULL,
      filename TEXT NOT NULL,
      url TEXT NOT NULL,
      thumbUrl TEXT,
      kind TEXT NOT NULL CHECK(kind IN ('image','video')),
      size INTEGER,
      width INTEGER,
      height INTEGER,
      duration REAL,
      is_favorite INTEGER DEFAULT 0,
      created_at TEXT NOT NULL,
      FOREIGN KEY(album_id) REFERENCES albums(id) ON DELETE SET NULL,
      FOREIGN KEY(user_id) REFERENCES users(id) ON DELETE CASCADE
    )
  `).run();

  // Invites
  db.prepare(`
    CREATE TABLE IF NOT EXISTS invites (
      token TEXT PRIMARY KEY,
      email TEXT NOT NULL,
      role TEXT NOT NULL,
      expires_at TEXT NOT NULL,
      used INTEGER DEFAULT 0,
      created_at TEXT NOT NULL
    )
  `).run();
}

// Middleware
function requireAuth(req, res, next) {
  const auth = req.headers.authorization;
  if (!auth?.startsWith('Bearer ')) return res.status(401).json({ error: 'Missing token' });
  const token = auth.slice(7);
  try {
    const payload = jwt.verify(token, JWT_SECRET);
    req.user = payload;
    next();
  } catch {
    return res.status(401).json({ error: 'Invalid token' });
  }
}

// Helpers
function respondWithMedia(rows) {
  return rows.map(r => ({
    id: r.id,
    albumId: r.album_id ?? null,
    userId: r.user_id,
    filename: r.filename,
    url: r.url,
    thumbUrl: r.thumbUrl,
    kind: r.kind,
    size: r.size,
    width: r.width,
    height: r.height,
    duration: r.duration,
    is_favorite: !!r.is_favorite,
    created_at: r.created_at,
  }));
}

// Auth
app.post('/api/auth/login', async (req, res) => {
  const { email, password } = req.body;
  if (!email || !password) return res.status(400).json({ error: 'Email and password required' });
  const row = db.prepare('SELECT * FROM users WHERE email = ?').get(email);
  if (!row) return res.status(401).json({ error: 'Invalid credentials' });
  const valid = await bcrypt.compare(password, row.password);
  if (!valid) return res.status(401).json({ error: 'Invalid credentials' });
  const token = jwt.sign({ id: row.id, email: row.email, name: row.name, role: row.role }, JWT_SECRET, { expiresIn: '7d' });
  res.json({ token, user: { id: row.id, email: row.email, name: row.name, role: row.role } });
});

app.get('/api/auth/me', requireAuth, (req, res) => {
  const row = db.prepare('SELECT id, email, name, role FROM users WHERE id = ?').get(req.user.id);
  if (!row) return res.status(404).json({ error: 'User not found' });
  res.json({ user: { id: row.id, email: row.email, name: row.name, role: row.role } });
});

// Invites
app.post('/api/invites/login', async (req, res) => {
  const { token: inviteToken } = req.body;
  if (!inviteToken) return res.status(400).json({ error: 'Invite token required' });
  const row = db.prepare('SELECT * FROM invites WHERE token = ? AND used = 0 AND expires_at > datetime("now")').get(inviteToken);
  if (!row) return res.status(400).json({ error: 'Invalid or expired invite' });
  const existing = db.prepare('SELECT id FROM users WHERE email = ?').get(row.email);
  if (existing) return res.status(400).json({ error: 'User already exists' });
  const password = Math.random().toString(36).slice(-10);
  const hash = await bcrypt.hash(password, SALT_ROUNDS);
  const now = new Date().toISOString();
  const user = db.prepare('INSERT INTO users (email, name, password, role, created_at) VALUES (?,?,?,?,?)').run(row.email, row.email, hash, row.role, now);
  db.prepare('UPDATE invites SET used = 1 WHERE token = ?').run(inviteToken);
  const jwtToken = jwt.sign({ id: user.lastInsertRowid, email: row.email, name: row.email, role: row.role }, JWT_SECRET, { expiresIn: '7d' });
  res.json({ token: jwtToken, user: { id: user.lastInsertRowid, email: row.email, name: row.email, role: row.role } });
});

// Albums
app.get('/api/albums', requireAuth, (req, res) => {
  const rows = db.prepare('SELECT * FROM albums WHERE user_id = ? ORDER BY created_at DESC').all(req.user.id);
  res.json({ albums: rows });
});

app.post('/api/albums', requireAuth, (req, res) => {
  const { title, description } = req.body;
  if (!title) return res.status(400).json({ error: 'Title required' });
  const now = new Date().toISOString();
  const row = db.prepare('INSERT INTO albums (user_id, title, description, created_at) VALUES (?,?,?,?)').run(req.user.id, title, description || '', now);
  res.json({ album: { id: row.lastInsertRowid, user_id: req.user.id, title, description: description || '', created_at: now } });
});

// Media
app.get('/api/media', requireAuth, (req, res) => {
  const albumId = req.query.albumId ? Number(req.query.albumId) : null;
  const fav = req.query.favorite === '1';
  let sql = 'SELECT * FROM media WHERE user_id = ?';
  const params = [req.user.id];
  if (albumId) { sql += ' AND album_id IS ?'; params.push(albumId); }
  if (fav) { sql += ' AND is_favorite = 1'; }
  sql += ' ORDER BY created_at DESC LIMIT 500';
  const rows = db.prepare(sql).all(...params);
  res.json({ media: respondWithMedia(rows) });
});

app.post('/api/media/upload', requireAuth, upload.single('file'), async (req, res) => {
  if (!req.file) return res.status(400).json({ error: 'No file' });
  const { albumId } = req.body;
  const kind = req.file.mimetype.startsWith('video/') ? 'video' : 'image';
  const filename = req.file.originalname;
  const url = `/uploads/${req.file.filename}`;
  const thumbUrl = kind === 'image' ? url : undefined;
  const now = new Date().toISOString();
  const row = db.prepare('INSERT INTO media (album_id, user_id, filename, url, thumbUrl, kind, created_at) VALUES (?,?,?,?,?,?,?)').run(
    albumId || null, req.user.id, filename, url, thumbUrl, kind, now
  );
  res.json({ media: { id: row.lastInsertRowid, albumId: albumId || null, userId: req.user.id, filename, url, thumbUrl, kind, created_at: now } });
});

app.put('/api/media/:id/favorite', requireAuth, (req, res) => {
  const id = Number(req.params.id);
  const row = db.prepare('SELECT * FROM media WHERE id = ? AND user_id = ?').get(id, req.user.id);
  if (!row) return res.status(404).json({ error: 'Not found' });
  const value = row.is_favorite ? 0 : 1;
  db.prepare('UPDATE media SET is_favorite = ? WHERE id = ?').run(value, id);
  res.json({ success: true, is_favorite: !!value });
});

// Static
app.use('/uploads', express.static(path.join(process.cwd(), 'uploads')));

// Health
app.get('/api/health', (req, res) => res.json({ ok: true, ts: new Date().toISOString() }));

// Start
initDb();
app.listen(PORT, () => console.log(`API listening on ${PORT}`));