import { spawn } from 'child_process';
import fs from 'fs/promises';
import os from 'os';
import path from 'path';
import { uploadFile, getPresignedUrl } from './s3.js';

/**
 * Перегнать исходный файл в уменьшенное превью (JPEG ~1600px) через sharp.
 */
export async function createThumbnail({ inputPath, mimeType }) {
  if (!mimeType.startsWith('image/')) return null;
  try {
    const sharp = (await import('sharp')).default;
    const outputKey = `thumbs/${Date.now()}-${Math.random().toString(36).slice(2, 8)}.jpg`;
    const buffer = await sharp(inputPath)
      .rotate()
      .resize({ width: 1600, withoutEnlargement: true })
      .jpeg({ quality: 80 })
      .toBuffer();
    await uploadFile(outputKey, buffer, 'image/jpeg');
    return outputKey;
  } catch (err) {
    console.error('Не удалось создать превью:', err.message);
    return null;
  }
}

/**
 * Конвертировать видео в MP4/H.264 + poster-кадр
 */
export async function convertVideo({ inputPath }) {
  const base = `videos/${Date.now()}-${Math.random().toString(36).slice(2, 8)}`;
  const convertedKey = `${base}.mp4`;
  const posterKey = `${base}-poster.jpg`;
  const tmpConverted = path.join(os.tmpdir(), `${Date.now()}-converted.mp4`);
  const tmpPoster = path.join(os.tmpdir(), `${Date.now()}-poster.jpg`);

  try {
    await runFfmpeg([
      '-i', inputPath,
      '-c:v', 'libx264', '-preset', 'medium',
      '-crf', '23', '-pix_fmt', 'yuv420p',
      '-c:a', 'aac', '-b:a', '128k',
      '-movflags', '+faststart',
      '-y', tmpConverted,
    ]);
    await runFfmpeg([
      '-i', inputPath, '-ss', '1',
      '-frames:v', '1', '-vf', 'scale=800:-2',
      '-y', tmpPoster,
    ]);
    const [convertedBuffer, posterBuffer] = await Promise.all([
      fs.readFile(tmpConverted), fs.readFile(tmpPoster),
    ]);
    await uploadFile(convertedKey, convertedBuffer, 'video/mp4');
    await uploadFile(posterKey, posterBuffer, 'image/jpeg');
    return { convertedKey, posterKey };
  } catch (err) {
    console.error('Ошибка конвертации видео:', err.message);
    return null;
  } finally {
    await fs.rm(tmpConverted, { force: true }).catch(() => {});
    await fs.rm(tmpPoster, { force: true }).catch(() => {});
  }
}

function runFfmpeg(args) {
  return new Promise((resolve, reject) => {
    const proc = spawn('ffmpeg', args, { stdio: ['ignore', 'ignore', 'pipe'] });
    let stderr = '';
    proc.stderr.on('data', (d) => (stderr += d.toString()));
    proc.on('error', reject);
    proc.on('close', (code) => {
      if (code === 0) resolve();
      else reject(new Error(`ffmpeg код ${code}: ${stderr.slice(-300)}`));
    });
  });
}

/** Собрать DTO медиа для фронтенда (presigned URL вместо storage_key) */
export async function mediaToDto(row) {
  const urlKey = row.kind === 'video' && row.converted_key ? row.converted_key : row.storage_key;
  const [url, thumbUrl, posterUrl] = await Promise.all([
    getPresignedUrl(urlKey),
    getPresignedUrl(row.thumb_key),
    row.kind === 'video' ? getPresignedUrl(row.poster_key) : Promise.resolve(null),
  ]);

  return {
    id: row.id,
    albumId: row.album_id,
    filename: row.filename,
    mimeType: row.mime_type,
    kind: row.kind,
    sizeBytes: row.size_bytes,
    width: row.width,
    height: row.height,
    dateTaken: row.date_taken,
    latitude: Number(row.latitude) || null,
    longitude: Number(row.longitude) || null,
    isConverted: row.is_converted,
    isFavorite: !!row.is_favorite,
    revealAt: row.reveal_at || null,
    deletedAt: row.deleted_at,
    url, thumbUrl, posterUrl,
    createdAt: row.created_at,
  };
}