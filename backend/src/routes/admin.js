import { Router } from 'express';
import bcrypt from 'bcryptjs';
import { existsSync, mkdirSync, rmSync, readdirSync, statSync, copyFileSync, writeFileSync } from 'node:fs';
import { dirname, join, basename } from 'node:path';
import { fileURLToPath } from 'node:url';
import { copyFile } from 'node:fs/promises';
import multer from 'multer';
import { spawn, execFile } from 'node:child_process';
import { promisify } from 'node:util';
import { query, queryOne } from '../db.js';
import { requireAuth, requireRole } from '../middleware/auth.js';
import { deleteFile } from '../utils/s3.js';
import { mediaToDto } from '../utils/media.js';

const router = Router();
const __dirname = dirname(fileURLToPath(import.meta.url));
// admin.js лежит в backend/src/routes → вверх на 3 уровня до корня проекта
const PROJECT_ROOT = join(__dirname, '..', '..', '..');
const SNAP_DIR = join(PROJECT_ROOT, 'data', 'snapshots');
const execFileP = promisify(execFile);
router.use(requireAuth, requireRole('admin'));

// ---------- Пользователи ----------

/** GET /api/admin/users — список пользователей */
router.get('/users', async (req, res) => {
  const result = await query('SELECT id, email, name, role, created_at FROM users ORDER BY id');
  res.json({ users: result.rows });
});

/** PATCH /api/admin/users/:id — изменить роль/имя */
router.patch('/users/:id', async (req, res) => {
  const { name, role } = req.body || {};
  if (role && !['admin', 'editor', 'guest'].includes(role)) {
    return res.status(400).json({ error: 'Недопустимая роль' });
  }
  const user = await queryOne(
    `UPDATE users SET name = COALESCE($1, name), role = COALESCE($2, role)
     WHERE id = $3 RETURNING id, email, name, role`,
    [name, role, req.params.id]
  );
  if (!user) return res.status(404).json({ error: 'Пользователь не найден' });
  res.json({ user });
});

/** DELETE /api/admin/users/:id — удалить пользователя */
router.delete('/users/:id', async (req, res) => {
  if (parseInt(req.params.id, 10) === req.user.id) {
    return res.status(400).json({ error: 'Нельзя удалить самого себя' });
  }
  await query('DELETE FROM users WHERE id = $1', [req.params.id]);
  res.json({ ok: true });
});

/** POST /api/admin/users/:id/reset-password — сбросить пароль */
router.post('/users/:id/reset-password', async (req, res) => {
  const { password } = req.body || {};
  if (String(password || '').length < 8) {
    return res.status(400).json({ error: 'Пароль должен быть не короче 8 символов' });
  }
  const hash = await bcrypt.hash(password, 10);
  const user = await queryOne(
    'UPDATE users SET password_hash = $1 WHERE id = $2 RETURNING id, email',
    [hash, req.params.id]
  );
  if (!user) return res.status(404).json({ error: 'Пользователь не найден' });
  res.json({ ok: true });
});

// ---------- Корзина ----------

/** GET /api/admin/trash — список медиа в корзине */
router.get('/trash', async (req, res) => {
  const result = await query('SELECT * FROM media WHERE deleted_at IS NOT NULL ORDER BY deleted_at DESC');
  const media = await Promise.all(result.rows.map(mediaToDto));
  res.json({ media });
});

/** POST /api/admin/trash/:id/restore — вернуть из корзины */
router.post('/trash/:id/restore', async (req, res) => {
  const media = await queryOne('SELECT * FROM media WHERE id = $1 AND deleted_at IS NOT NULL', [req.params.id]);
  if (!media) return res.status(404).json({ error: 'Файл не найден в корзине' });
  await query('UPDATE media SET deleted_at = NULL WHERE id = $1', [req.params.id]);
  res.json({ ok: true });
});

/** DELETE /api/admin/trash/:id — удалить навсегда (файл + записи БД) */
router.delete('/trash/:id', async (req, res) => {
  const media = await queryOne('SELECT * FROM media WHERE id = $1 AND deleted_at IS NOT NULL', [req.params.id]);
  if (!media) return res.status(404).json({ error: 'Файл не найден в корзине' });
  await permanentlyDelete(media);
  res.json({ ok: true });
});

/** DELETE /api/admin/trash — очистить всю корзину */
router.delete('/trash', async (req, res) => {
  const result = await query('SELECT * FROM media WHERE deleted_at IS NOT NULL');
  for (const m of result.rows) {
    await permanentlyDelete(m);
  }
  res.json({ ok: true, deleted: result.rows.length });
});

/** Удалить файлы из MinIO и строки из БД */
async function permanentlyDelete(media) {
  const keys = [media.storage_key, media.thumb_key, media.converted_key, media.poster_key]
    .filter(Boolean);
  for (const key of keys) {
    await deleteFile(key).catch((err) => console.error(`Не удалось удалить ${key}:`, err.message));
  }
  await query('DELETE FROM media WHERE id = $1', [media.id]);
}

// ============================================================
//   СНИМКИ (backup из браузера, только админ)
// ============================================================

function snapList() {
  if (!existsSync(SNAP_DIR)) return [];
  return readdirSync(SNAP_DIR)
    .filter((f) => f.endsWith('.zip'))
    .map((f) => {
      const p = join(SNAP_DIR, f);
      return { name: f, size: statSync(p).size, created: statSync(p).mtime };
    })
    .sort((a, b) => b.created - a.created);
}

/** Консистентная копия БД (в WAL-режиме нельзя просто копировать файл) */
async function makeDbSnapshot(tmpDir) {
  const dbFile = join(tmpDir, 'archive.db');
  const rawDb = (await import('../db.js')).default;
  await rawDb.exec(`VACUUM INTO ${dbFile.includes("'") ? '"' + dbFile + '"' : "'" + dbFile + "'"}`);
  return dbFile;
}

/** POST /api/admin/snapshot — создать zip: БД + серверный код */
router.post('/snapshot', async (req, res) => {
  try {
    mkdirSync(SNAP_DIR, { recursive: true });
    const ts = new Date().toISOString().replace(/[:T]/g, '-').slice(0, 19);
    const zipName = `snapshot-${ts}.zip`;
    const tmpDir = join(SNAP_DIR, `.tmp-${Date.now()}`);
    mkdirSync(tmpDir, { recursive: true });

    // 1) БД (консистентная копия)
    await makeDbSnapshot(tmpDir);

    // 2) Копируем исходники (backend + frontend + схема БД)
    const staging = join(tmpDir, 'project');
    mkdirSync(staging, { recursive: true });
    await copyTree(join(PROJECT_ROOT, 'backend'), join(staging, 'backend'));
    await copyTree(join(PROJECT_ROOT, 'frontend'), join(staging, 'frontend'));
    await copyTree(join(PROJECT_ROOT, 'db'), join(staging, 'db'));
    // БД кладём рядом наглядно
    copyFileSync(join(tmpDir, 'archive.db'), join(staging, 'archive.db'));

    // 3) Zip через системную утилиту (Windows PowerShell) или tar
    const destZip = join(SNAP_DIR, zipName);
    await zipDir(staging, destZip);

    rmSync(tmpDir, { recursive: true, force: true });
    res.json({ ok: true, name: zipName, files: snapList() });
  } catch (err) {
    console.error('Snapshot error:', err);
    res.status(500).json({ error: 'Не удалось создать снимок: ' + err.message });
  }
});

/** GET /api/admin/snapshot — список созданных снимков */
router.get('/snapshot', (req, res) => {
  res.json({ files: snapList() });
});

/** GET /api/admin/snapshot/:name — скачать снимок */
router.get('/snapshot/:name', (req, res) => {
  const name = basename(String(req.params.name || ''));
  const p = join(SNAP_DIR, name);
  if (!name.endsWith('.zip') || !existsSync(p)) return res.status(404).json({ error: 'Снимок не найден' });
  res.setHeader('Content-Disposition', `attachment; filename="${name}"`);
  res.sendFile(p);
});

/** DELETE /api/admin/snapshot/:name — удалить снимок */
router.delete('/snapshot/:name', (req, res) => {
  const name = basename(String(req.params.name || ''));
  const p = join(SNAP_DIR, name);
  if (!name.endsWith('.zip') || !existsSync(p)) return res.status(404).json({ error: 'Снимок не найден' });
  rmSync(p, { force: true });
  res.json({ ok: true, files: snapList() });
});

// ---------- Восстановление из снимка ----------
const uploadZip = multer({ storage: multer.memoryStorage(), limits: { fileSize: 1024 * 1024 * 1024 } });

function needsEsc(p) { return `'${p.replace(/'/g, "''")}'`; }

async function unzipBuffer(buf, destDir) {
  mkdirSync(destDir, { recursive: true });
  writeFileSync(join(destDir, 'upload.zip'), buf);
  await execFileP('powershell.exe', [
    '-NoProfile', '-Command',
    `Expand-Archive -Path ${needsEsc(join(destDir, 'upload.zip'))} -DestinationPath ${needsEsc(destDir)} -Force`,
  ], { timeout: 120000 });
  rmSync(join(destDir, 'upload.zip'), { force: true });
}

/** Найти файл или папку внутри распакованного архива по имени */
function findFile(root, name) {
  const stack = [root];
  while (stack.length) {
    const d = stack.pop();
    for (const e of readdirSync(d, { withFileTypes: true })) {
      const p = join(d, e.name);
      if (e.name === name) return p;
      if (e.isDirectory()) stack.push(p);
    }
  }
  return null;
}

/** POST /api/admin/snapshot/restore — восстановить состояние из снимка */
router.post('/snapshot/restore', uploadZip.single('file'), async (req, res) => {
  if (!req.file) return res.status(400).json({ error: 'Приложите файл снимка (.zip)' });
  const tmp = join(SNAP_DIR, `.restore-${Date.now()}`);
  try {
    await unzipBuffer(req.file.buffer, tmp);
    const extracted = join(tmp, 'project');
    const rootExists = existsSync(extracted) ? extracted : tmp;

    // 1) БД — из архива. Пишем в очередь восстановления (применяется до старта коннектора)
    const dbFrom = findFile(rootExists, 'archive.db') || findFile(rootExists, 'archive.db.sqlite');
    if (!dbFrom) return res.status(400).json({ error: 'В архиве не найден архив БД' });
    const dbQueue = join(PROJECT_ROOT, 'data', 'archive.db.restore');
    copyFileSync(dbFrom, dbQueue);
    writeFileSync(join(PROJECT_ROOT, 'data', '.restore-pending'), '1');

    // Авто-бэкап текущей БД берётся при применении очереди (до открытия коннектора)

    // 2) Медиа-файлы (data/files)
    const filesFrom = findFile(rootExists, 'files');
    if (filesFrom && statSync(filesFrom).isDirectory()) {
      const filesTarget = join(PROJECT_ROOT, 'data', 'files');
      rmSync(filesTarget, { recursive: true, force: true });
      mkdirSync(filesTarget, { recursive: true });
      await copyDirContents(filesFrom, filesTarget);
    }

    // 3) Фронтенд (public) — применяется сразу (статика)
    const frontendFrom = findFile(rootExists, 'public');
    if (frontendFrom && statSync(frontendFrom).isDirectory()) {
      const frontTarget = join(PROJECT_ROOT, 'frontend', 'public');
      rmSync(frontTarget, { recursive: true, force: true });
      mkdirSync(frontTarget, { recursive: true });
      await copyDirContents(frontendFrom, frontTarget);
    }

    // 4) Серверный код (backend/src + package.json) из снимка
    const backendFrom = findFile(rootExists, 'backend');
    const codeApplied = Boolean(backendFrom && statSync(backendFrom).isDirectory());
    if (codeApplied) {
      const backendTarget = join(PROJECT_ROOT, 'backend');
      rmSync(join(backendTarget, 'src'), { recursive: true, force: true });
      mkdirSync(join(backendTarget, 'src'), { recursive: true });
      await copyDirContents(join(backendFrom, 'src'), join(backendTarget, 'src'));
      const pkgFrom = join(backendFrom, 'package.json');
      if (existsSync(pkgFrom)) copyFileSync(pkgFrom, join(backendTarget, 'package.json'));
    }

    rmSync(tmp, { recursive: true, force: true });
    const restartScheduled = codeApplied ? scheduleRestart() : true;
    res.json({
      ok: true,
      note: 'Данные и БД восстановлены (применяются при следующем старте сервера).' + (codeApplied ? ' Код обновлён, сервер перезапускается автоматически…' : ''),
      restartScheduled,
      pendingRestart: true,
    });
  } catch (err) {
    rmSync(tmp, { recursive: true, force: true });
    console.error('Restore error:', err);
    res.status(500).json({ error: 'Не удалось восстановить: ' + err.message });
  }
});

/** Запланировать автоперезапуск сервера через временный .ps1, запускаемый отдельным cmd процессом */
function scheduleRestart() {
  const backendDir = join(PROJECT_ROOT, 'backend');
  const nodePath = process.execPath;
  const psPath = join(PROJECT_ROOT, 'data', `.restart-${Date.now()}.ps1`);
  const lines = [
    'Start-Sleep -Seconds 3',
    `Get-CimInstance Win32_Process -Filter "Name='node.exe'" | Where-Object { $_.CommandLine -like '*src/index.js*' } | ForEach-Object { Stop-Process -Id $_.ProcessId -Force -ErrorAction SilentlyContinue }`,
    'Start-Sleep -Seconds 2',
    `Start-Process -FilePath '${nodePath.replace(/'/g, "''")}' -ArgumentList 'src/index.js' -WorkingDirectory '${backendDir.replace(/'/g, "''")}' -WindowStyle Hidden`,
    `Remove-Item -LiteralPath '${psPath.replace(/'/g, "''")}' -Force -ErrorAction SilentlyContinue`,
  ];
  try {
    if (!existsSync(SNAP_DIR)) mkdirSync(SNAP_DIR, { recursive: true });
    writeFileSync(psPath, lines.join('\r\n'), 'utf-8');
    // detached-процесс через `cmd /c start` — надёжно переживает завершение запроса
    const psForward = psPath.replace(/\\/g, '/');
    execFile('cmd.exe', ['/c', 'start', '', 'powershell.exe', '-NoProfile', '-ExecutionPolicy', 'Bypass', '-File', psForward], { windowsHide: true }, () => {});
    console.log('Restart scheduled:', psPath);
    return true;
  } catch (err) {
    console.error('Restart schedule error:', err.message);
    return false;
  }
}

/** Рекурсивно скопировать содержимое */
async function copyDirContents(src, dst) {
  for (const entry of readdirSync(src, { withFileTypes: true })) {
    if (['node_modules', '.git', 'snapshots'].includes(entry.name)) continue;
    const s = join(src, entry.name);
    const d = join(dst, entry.name);
    if (entry.isDirectory()) { mkdirSync(d, { recursive: true }); await copyDirContents(s, d); }
    else copyFileSync(s, d);
  }
}

/** Рекурсивно копировать дерево */
async function copyTree(src, dst) {
  if (!existsSync(src)) return;
  mkdirSync(dst, { recursive: true });
  for (const entry of readdirSync(src, { withFileTypes: true })) {
    if (['node_modules', '.git', 'snapshots', 'data'].includes(entry.name)) continue;
    const s = join(src, entry.name);
    const d = join(dst, entry.name);
    if (entry.isDirectory()) await copyTree(s, d);
    else if (entry.isFile()) copyFileSync(s, d);
  }
}

/** Запаковать папку в zip (PowerShell на Windows, tar+zip fallback) */
async function zipDir(srcDir, destZip) {
  const needsEsc = (p) => `'${p.replace(/'/g, "''")}'`;
  try {
    await execFileP('powershell.exe', [
      '-NoProfile', '-Command',
      `Compress-Archive -Path ${needsEsc(join(srcDir, '*'))} -DestinationPath ${needsEsc(destZip)} -Force`,
    ], { timeout: 120000 });
  } catch {
    // POSIX fallback: tar to zip (не под Windows, но для надёжности)
    await execFileP('tar', ['-czf', destZip, '-C', srcDir, '.'], { timeout: 120000 });
  }
}

export default router;