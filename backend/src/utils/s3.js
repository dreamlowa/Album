/**
 * Двурежимное хранилище:
 * - локальная папка ./data/files — режим local (без MinIO)
 * - MinIO (S3) — режим docker
 *
 * Единый интерфейс:
 *   initS3(), uploadFile(key, buffer, mime), getFile(key) → stream,
 *   deleteFile(key), getPresignedUrl(key) → URL (в local — /api/files/...),
 *   getBucket()
 */
import { mkdirSync, existsSync, createWriteStream, createReadStream, readFileSync } from 'node:fs';
import { dirname, join, normalize } from 'node:path';
import { fileURLToPath } from 'node:url';

const __dirname = dirname(fileURLToPath(import.meta.url));
const PROJECT_ROOT = join(__dirname, '..', '..', '..');

const useMinio = (process.env.STORAGE_DRIVER === 'minio') || !!process.env.MINIO_ROOT_PASSWORD;

let client = null;
let presignClient = null;
let bucket = process.env.S3_BUCKET || 'media';

// ================= MinIO (docker) =================
async function initMinio() {
  const { S3Client, PutObjectCommand } = await import('@aws-sdk/client-s3');

  const internalEndpoint = `http://${process.env.S3_ENDPOINT || 'minio'}:${process.env.S3_PORT || '9000'}`;
  const creds = {
    accessKeyId: process.env.MINIO_ROOT_USER,
    secretAccessKey: process.env.MINIO_ROOT_PASSWORD,
  };

  client = new S3Client({
    endpoint: internalEndpoint,
    region: process.env.S3_REGION || 'us-east-1',
    credentials: creds,
    forcePathStyle: true,
  });

  const publicEndpoint = process.env.S3_PUBLIC_ENDPOINT || internalEndpoint;
  presignClient = new S3Client({
    endpoint: publicEndpoint,
    region: process.env.S3_REGION || 'us-east-1',
    credentials: creds,
    forcePathStyle: true,
  });

  // Создать bucket
  try {
    await client.send(new PutObjectCommand({ Bucket: bucket, Key: '.init', Body: '' }));
  } catch { /* уже есть */ }

  console.log('Хранилище: MinIO, bucket:', bucket);
}

// ================= Локальная папка =================
const filesRoot = join(PROJECT_ROOT, 'data', 'files');

function initLocal() {
  mkdirSync(filesRoot, { recursive: true });
  console.log('Хранилище: локальная папка', filesRoot);
}

function localPath(key) {
  // безопасный ключ: только a-z0-9/._-
  const safe = String(key).replace(/[^a-zA-Z0-9/._-]/g, '_');
  const p = join(filesRoot, normalize(safe));
  if (!p.startsWith(filesRoot)) throw new Error('Недопустимый ключ файла');
  return p;
}

// ================= Инициализация =================
export async function initS3() {
  if (useMinio) await initMinio();
  else initLocal();
}

// ================= Операции =================
export async function uploadFile(key, body, contentType) {
  if (useMinio) {
    const { PutObjectCommand } = await import('@aws-sdk/client-s3');
    await client.send(new PutObjectCommand({ Bucket: bucket, Key: key, Body: body, ContentType: contentType }));
    return;
  }

  // локально: тело может быть Buffer или Uint8Array
  const p = localPath(key);
  mkdirSync(dirname(p), { recursive: true });
  const { writeFileSync } = await import('node:fs');
  writeFileSync(p, Buffer.from(body));
}

export async function getFile(key) {
  if (useMinio) {
    const { GetObjectCommand } = await import('@aws-sdk/client-s3');
    const resp = await client.send(new GetObjectCommand({ Bucket: bucket, Key: key }));
    return resp.Body; // Readable stream
  }
  return createReadStream(localPath(key));
}

export async function deleteFile(key) {
  if (useMinio) {
    const { DeleteObjectCommand } = await import('@aws-sdk/client-s3');
    return client.send(new DeleteObjectCommand({ Bucket: bucket, Key: key }));
  }
  const { rm } = await import('node:fs/promises');
  await rm(localPath(key), { force: true });
}

export async function getPresignedUrl(key, expirySeconds) {
  if (!key) return null;

  if (useMinio) {
    const { GetObjectCommand } = await import('@aws-sdk/client-s3');
    const { getSignedUrl } = await import('@aws-sdk/s3-request-presigner');
    const expiry = expirySeconds || parseInt(process.env.PRESIGNED_EXPIRY || '3600', 10);
    const command = new GetObjectCommand({ Bucket: bucket, Key: key });
    return getSignedUrl(presignClient, command, { expiresIn: expiry });
  }

  // Локально: отдаём через API (index.js раздаёт /api/files/*)
  return `/api/files/${encodeURIComponent(key)}`;
}

export async function listObjects(prefix) {
  if (useMinio) {
    const { ListObjectsV2Command } = await import('@aws-sdk/client-s3');
    const result = await client.send(new ListObjectsV2Command({ Bucket: bucket, Prefix: prefix }));
    return result.Contents || [];
  }
  const { readdirSync } = await import('node:fs');
  const dir = dirname(localPath(prefix));
  if (!existsSync(dir)) return [];
  return readdirSync(dir).map((f) => ({ Key: join(prefix, f).replace(/\\/g, '/') }));
}

export function getBucket() {
  return bucket;
}

export { client };