'use strict';
const crypto = require('node:crypto');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const { promisify } = require('node:util');
const { execFile } = require('node:child_process');
const execFileAsync = promisify(execFile);
const PREFIX = 'mauriskade-system-backup-';
const BUCKET_DEFAULT = 'mauriskade-db-backups';

function requiredEnv(name, min) {
  const value = String(process.env[name] || '');
  if (value.length < (min || 1)) throw new Error('Missing or invalid required secret: ' + name);
  return value;
}
function localDate() {
  const parts = new Intl.DateTimeFormat('en-CA', { timeZone: 'Africa/Nairobi', year: 'numeric', month: '2-digit', day: '2-digit' }).formatToParts(new Date());
  const p = Object.fromEntries(parts.map(x => [x.type, x.value]));
  return p.year + '-' + p.month + '-' + p.day;
}
function deriveKey(secret) { return crypto.createHash('sha256').update(secret, 'utf8').digest(); }
function encryptArchive(plain, secret) {
  const iv = crypto.randomBytes(12);
  const cipher = crypto.createCipheriv('aes-256-gcm', deriveKey(secret), iv);
  const encrypted = Buffer.concat([cipher.update(plain), cipher.final()]);
  return Buffer.concat([Buffer.from('MRBK2'), iv, cipher.getAuthTag(), encrypted]);
}
function decryptArchive(payload, secret) {
  if (!Buffer.isBuffer(payload) || payload.length < 33 || payload.subarray(0, 5).toString() !== 'MRBK2') throw new Error('Encrypted database backup header is invalid.');
  const decipher = crypto.createDecipheriv('aes-256-gcm', deriveKey(secret), payload.subarray(5, 17));
  decipher.setAuthTag(payload.subarray(17, 33));
  return Buffer.concat([decipher.update(payload.subarray(33)), decipher.final()]);
}
async function run(command, args) {
  try { return await execFileAsync(command, args, { maxBuffer: 16 * 1024 * 1024 }); }
  catch (error) { throw new Error(command + ' failed: ' + String(error.stderr || error.message || '').slice(-4000)); }
}
async function restoreAndVerify(dumpPath, restoreUrl) {
  if (!restoreUrl) throw new Error('RESTORE_DATABASE_URL is required; refusing to publish an unverified backup.');
  const target = new URL(restoreUrl);
  if (target.pathname.split('/').filter(Boolean).join('/') !== 'restore_test') throw new Error('Restore target must be the isolated restore_test database.');
  const listing = await run('pg_restore', ['--list', dumpPath]);
  if (!/TABLE DATA|TABLE public\./.test(listing.stdout)) throw new Error('PostgreSQL archive is missing expected public schema entries.');
  await run('pg_restore', ['--exit-on-error', '--clean', '--if-exists', '--no-owner', '--no-acl', '--dbname', restoreUrl, dumpPath]);
  const sql = "SELECT json_build_object(" +
    "'tables',(SELECT count(*) FROM information_schema.tables WHERE table_schema='public' AND table_type='BASE TABLE')," +
    "'indexes',(SELECT count(*) FROM pg_indexes WHERE schemaname='public')," +
    "'sequences',(SELECT count(*) FROM information_schema.sequences WHERE sequence_schema='public')," +
    "'policies',(SELECT count(*) FROM pg_policies WHERE schemaname='public')," +
    "'key_tables',(SELECT count(*) FROM information_schema.tables WHERE table_schema='public' AND table_name IN ('meters','users','transactions','admin_actions','rent_leases','rent_payments','rent_allocations','rent_settlements','tenancy_agreements'))" +
    ")::text;";
  const result = await run('psql', [restoreUrl, '-X', '-v', 'ON_ERROR_STOP=1', '-Atc', sql]);
  const verified = JSON.parse(result.stdout.trim());
  if (verified.tables < 10 || verified.key_tables !== 9 || verified.indexes < 10 || verified.sequences < 1) throw new Error('Isolated restore verification failed: ' + JSON.stringify(verified));
  return verified;
}
async function storageRequest(url, key, route, options) {
  const response = await fetch(url.replace(/\/$/, '') + '/storage/v1' + route, {
    ...(options || {}),
    headers: { apikey: key, authorization: 'Bearer ' + key, ...((options && options.headers) || {}) },
    signal: AbortSignal.timeout(120000)
  });
  if (!response.ok) throw new Error('Supabase Storage HTTP ' + response.status + ': ' + (await response.text()).slice(0, 500));
  return response;
}
async function uploadAndPrune(env, fileName, payload) {
  const bucket = env.RENT_BACKUP_STORAGE_BUCKET || BUCKET_DEFAULT;
  const bucketPath = encodeURIComponent(bucket);
  await storageRequest(env.SUPABASE_URL, env.SUPABASE_SERVICE_ROLE_KEY, '/object/' + bucketPath + '/' + encodeURIComponent(fileName), {
    method: 'POST',
    headers: { 'content-type': 'application/octet-stream', 'cache-control': 'no-store', 'x-upsert': 'true' },
    body: payload
  });
  const retention = Math.max(7, Math.min(3650, Number.parseInt(env.RENT_BACKUP_RETENTION_DAYS || '90', 10) || 90));
  const cutoff = new Date(Date.now() + 3 * 3600000 - retention * 86400000).toISOString().slice(0, 10);
  let offset = 0, page, stale = [];
  do {
    const response = await storageRequest(env.SUPABASE_URL, env.SUPABASE_SERVICE_ROLE_KEY, '/object/list/' + bucketPath, {
      method: 'POST', headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ prefix: '', limit: 1000, offset, sortBy: { column: 'name', order: 'asc' } })
    });
    page = await response.json();
    if (!Array.isArray(page)) throw new Error('Storage returned an invalid object listing.');
    for (const item of page) {
      const match = item && typeof item.name === 'string' && item.name.match(/^mauriskade-system-backup-(\d{4}-\d{2}-\d{2})\.mrbk$/);
      if (match && match[1] < cutoff) stale.push(item.name);
    }
    offset += page.length;
  } while (page.length === 1000);
  for (let i = 0; i < stale.length; i += 1000) {
    await storageRequest(env.SUPABASE_URL, env.SUPABASE_SERVICE_ROLE_KEY, '/object/' + bucketPath, {
      method: 'DELETE', headers: { 'content-type': 'application/json' }, body: JSON.stringify({ prefixes: stale.slice(i, i + 1000) })
    });
  }
  return { bucket, retentionDays: retention, deletedExpiredArchives: stale.length };
}
async function main() {
  const env = {
    DATABASE_URL: requiredEnv('DATABASE_URL'),
    SUPABASE_URL: requiredEnv('SUPABASE_URL'),
    SUPABASE_SERVICE_ROLE_KEY: requiredEnv('SUPABASE_SERVICE_ROLE_KEY', 20),
    RENT_BACKUP_ENCRYPTION_KEY: requiredEnv('RENT_BACKUP_ENCRYPTION_KEY', 32),
    RENT_BACKUP_STORAGE_BUCKET: process.env.RENT_BACKUP_STORAGE_BUCKET || BUCKET_DEFAULT,
    RENT_BACKUP_RETENTION_DAYS: process.env.RENT_BACKUP_RETENTION_DAYS || '90'
  };
  if (!env.SUPABASE_URL.startsWith('https://')) throw new Error('SUPABASE_URL must use HTTPS.');
  const date = localDate(), fileName = PREFIX + date + '.mrbk';
  const workDir = fs.mkdtempSync(path.join(os.tmpdir(), 'mauriskade-db-backup-'));
  const dumpPath = path.join(workDir, 'database.dump'), encryptedPath = path.join(workDir, fileName);
  try {
    await run('pg_dump', ['--format=custom', '--compress=6', '--schema=public', '--no-owner', '--no-acl', '--file', dumpPath, env.DATABASE_URL]);
    const plain = fs.readFileSync(dumpPath);
    if (plain.length < 100) throw new Error('pg_dump produced an unexpectedly small archive.');
    const encrypted = encryptArchive(plain, env.RENT_BACKUP_ENCRYPTION_KEY);
    fs.writeFileSync(encryptedPath, encrypted, { mode: 0o600 });
    const recovered = decryptArchive(fs.readFileSync(encryptedPath), env.RENT_BACKUP_ENCRYPTION_KEY);
    if (!recovered.equals(plain)) throw new Error('AES-256-GCM round-trip verification failed.');
    fs.writeFileSync(dumpPath, recovered, { mode: 0o600 });
    const restore = await restoreAndVerify(dumpPath, process.env.RESTORE_DATABASE_URL);
    const storage = await uploadAndPrune(env, fileName, fs.readFileSync(encryptedPath));
    const digest = crypto.createHash('sha256').update(encrypted).digest('hex');
    console.log(JSON.stringify({ status: 'verified_and_uploaded', fileName, bytes: encrypted.length, sha256: digest, restore, storage }));
  } finally { fs.rmSync(workDir, { recursive: true, force: true }); }
}
if (require.main === module) main().catch(error => { console.error(error.message); process.exitCode = 1; });
module.exports = { encryptArchive, decryptArchive, localDate, restoreAndVerify };
