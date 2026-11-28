'use strict';
const crypto = require('node:crypto');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const { promisify } = require('node:util');
const { execFile } = require('node:child_process');
const { decryptArchive } = require('./backup-database');
const execFileAsync = promisify(execFile);
const BUCKET_DEFAULT = 'mauriskade-db-backups';
const ARCHIVE_PATTERN = /^mauriskade-system-backup-(\\d{4}-\\d{2}-\\d{2})\\.mrbk$/;

function requiredEnv(name, min = 1) {
  const value = String(process.env[name] || '');
  if (value.length < min) throw new Error('Missing or invalid required secret: ' + name);
  return value;
}
function selectLatestArchive(objects) {
  if (!Array.isArray(objects)) throw new Error('Supabase Storage returned an invalid object listing.');
  const candidates = objects
    .filter(item => item && typeof item.name === 'string' && ARCHIVE_PATTERN.test(item.name))
    .map(item => item.name)
    .sort();
  if (!candidates.length) throw new Error('No dated Mauriskade backup archive exists in the configured Storage bucket.');
  return candidates[candidates.length - 1];
}
function assertRecoveryTarget(databaseUrl) {
  if (!databaseUrl) throw new Error('RECOVERY_DATABASE_URL is required.');
  const target = new URL(databaseUrl);
  if (target.pathname.split('/').filter(Boolean).join('/') !== 'recovery_drill') {
    throw new Error('Recovery target must be the isolated recovery_drill database; production restore is refused.');
  }
  return target;
}
async function run(command, args) {
  try { return await execFileAsync(command, args, { maxBuffer: 16 * 1024 * 1024 }); }
  catch (error) { throw new Error(command + ' failed: ' + String(error.stderr || error.message || '').slice(-4000)); }
}
async function storageRequest(baseUrl, key, route, options) {
  const response = await fetch(baseUrl.replace(/\\/$/, '') + '/storage/v1' + route, {
    ...(options || {}),
    headers: { apikey: key, authorization: 'Bearer ' + key, ...((options && options.headers) || {}) },
    signal: AbortSignal.timeout(120000)
  });
  if (!response.ok) throw new Error('Supabase Storage HTTP ' + response.status + ': ' + (await response.text()).slice(0, 500));
  return response;
}
async function verifyRestoredDatabase(databaseUrl) {
  const sql = "SELECT json_build_object(" +
    "'tables',(SELECT count(*) FROM information_schema.tables WHERE table_schema='public' AND table_type='BASE TABLE')," +
    "'indexes',(SELECT count(*) FROM pg_indexes WHERE schemaname='public')," +
    "'sequences',(SELECT count(*) FROM information_schema.sequences WHERE sequence_schema='public')," +
    "'policies',(SELECT count(*) FROM pg_policies WHERE schemaname='public')," +
    "'key_tables',(SELECT count(*) FROM information_schema.tables WHERE table_schema='public' AND table_name IN ('meters','users','transactions','admin_actions','rent_leases','rent_payments','rent_allocations','rent_settlements','tenancy_agreements'))" +
    ")::text;";
  const result = await run('psql', [databaseUrl, '-X', '-v', 'ON_ERROR_STOP=1', '-Atc', sql]);
  const counts = JSON.parse(result.stdout.trim());
  if (counts.tables < 10 || counts.key_tables !== 9 || counts.indexes < 10 || counts.sequences < 1) {
    throw new Error('Independent recovery verification failed: ' + JSON.stringify(counts));
  }
  return counts;
}
async function main() {
  const supabaseUrl = requiredEnv('SUPABASE_URL');
  const serviceKey = requiredEnv('SUPABASE_SERVICE_ROLE_KEY', 20);
  const encryptionKey = requiredEnv('RENT_BACKUP_ENCRYPTION_KEY', 32);
  const bucket = process.env.RENT_BACKUP_STORAGE_BUCKET || BUCKET_DEFAULT;
  const recoveryUrl = requiredEnv('RECOVERY_DATABASE_URL');
  assertRecoveryTarget(recoveryUrl);
  if (!supabaseUrl.startsWith('https://')) throw new Error('SUPABASE_URL must use HTTPS.');
  const bucketPath = encodeURIComponent(bucket);
  const listingResponse = await storageRequest(supabaseUrl, serviceKey, '/object/list/' + bucketPath, {
    method: 'POST',
    headers: { 'content-type': 'application/json' },
    body: JSON.stringify({ prefix: '', limit: 1000, offset: 0, sortBy: { column: 'name', order: 'asc' } })
  });
  const fileName = selectLatestArchive(await listingResponse.json());
  const download = await storageRequest(supabaseUrl, serviceKey, '/object/' + bucketPath + '/' + encodeURIComponent(fileName));
  const encrypted = Buffer.from(await download.arrayBuffer());
  if (encrypted.length < 100) throw new Error('Downloaded backup archive is unexpectedly small.');
  const plain = decryptArchive(encrypted, encryptionKey);
  if (plain.length < 100) throw new Error('Decrypted PostgreSQL archive is unexpectedly small.');
  const workDir = fs.mkdtempSync(path.join(os.tmpdir(), 'mauriskade-recovery-drill-'));
  const dumpPath = path.join(workDir, 'recovered-database.dump');
  try {
    fs.writeFileSync(dumpPath, plain, { mode: 0o600 });
    const listing = await run('pg_restore', ['--list', dumpPath]);
    if (!/TABLE DATA|TABLE public\\./.test(listing.stdout)) throw new Error('Decrypted file is not a valid PostgreSQL custom archive.');
    await run('pg_restore', ['--exit-on-error', '--clean', '--if-exists', '--no-owner', '--no-acl', '--dbname', recoveryUrl, dumpPath]);
    const counts = await verifyRestoredDatabase(recoveryUrl);
    const sha256 = crypto.createHash('sha256').update(encrypted).digest('hex');
    console.log(JSON.stringify({
      status: 'independent_recovery_drill_passed',
      source: 'private_supabase_storage',
      bucket,
      fileName,
      encryptedBytes: encrypted.length,
      decryptedBytes: plain.length,
      sha256,
      restoreDatabase: 'recovery_drill',
      verification: counts
    }));
  } finally {
    fs.rmSync(workDir, { recursive: true, force: true });
  }
}
if (require.main === module) main().catch(error => { console.error(error.message); process.exitCode = 1; });
module.exports = { selectLatestArchive, assertRecoveryTarget };
