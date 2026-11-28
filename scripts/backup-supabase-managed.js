'use strict';
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const crypto = require('node:crypto');
const { promisify } = require('node:util');
const { execFile } = require('node:child_process');
const { encryptArchive, decryptArchive, localDate } = require('./backup-database');
const execFileAsync = promisify(execFile);
function hasAuthUsersEntry(listing) { return String(listing).includes('TABLE auth users'); }

function required(env, name, min = 1) {
  const value = String(env[name] || '');
  if (value.length < min) throw new Error('Missing or invalid required secret/configuration: ' + name);
  return value;
}
function safeObjectPath(value) {
  if (typeof value !== 'string' || !value || value.startsWith('/') || value.split('/').some(p => !p || p === '.' || p === '..')) {
    throw new Error('Storage returned an unsafe object path.');
  }
  return value;
}
function encodeObjectPath(value) {
  return value.split('/').map(encodeURIComponent).join('/');
}
async function run(command, args, options = {}) {
  try { return await execFileAsync(command, args, { maxBuffer: 32 * 1024 * 1024, ...options }); }
  catch (error) { throw new Error(command + ' failed: ' + String(error.stderr || error.message || '').slice(-4000)); }
}
async function apiRequest(base, key, route, options = {}) {
  const response = await fetch(base.replace(/\/$/, '') + route, {
    ...options,
    headers: { apikey: key, authorization: 'Bearer ' + key, ...(options.headers || {}) },
    signal: AbortSignal.timeout(120000)
  });
  if (!response.ok) throw new Error('Supabase API ' + response.status + ' for ' + route + ': ' + (await response.text()).slice(0, 600));
  return response;
}
async function listBucketObjects(base, key, bucket) {
  const found = [];
  const visited = new Set();
  async function walk(prefix) {
    if (visited.has(prefix)) throw new Error('Repeated Storage folder while traversing bucket: ' + prefix);
    visited.add(prefix);
    let offset = 0;
    for (;;) {
      const response = await apiRequest(base, key, '/storage/v1/object/list/' + encodeURIComponent(bucket), {
        method: 'POST',
        headers: { 'content-type': 'application/json' },
        body: JSON.stringify({ prefix, limit: 1000, offset, sortBy: { column: 'name', order: 'asc' } })
      });
      const rows = await response.json();
      if (!Array.isArray(rows)) throw new Error('Supabase Storage returned an invalid listing for bucket ' + bucket);
      for (const row of rows) {
        if (!row || typeof row.name !== 'string' || row.name.includes('/') || row.name === '.' || row.name === '..') {
          throw new Error('Supabase Storage returned an invalid object/folder name.');
        }
        if (row.id === null || (row.id === undefined && !row.metadata)) {
          await walk(prefix ? prefix + row.name + '/' : row.name + '/');
        } else {
          const objectPath = safeObjectPath(prefix + row.name);
          found.push({ path: objectPath, size: Number(row.metadata && row.metadata.size || 0), contentType: row.metadata && row.metadata.mimetype || null, updatedAt: row.updated_at || null, createdAt: row.created_at || null });
        }
      }
      offset += rows.length;
      if (rows.length < 1000) break;
    }
  }
  await walk('');
  return found.sort((a, b) => a.path.localeCompare(b.path));
}
async function downloadStorageObject(base, key, bucket, objectPath, destination) {
  const response = await apiRequest(base, key, '/storage/v1/object/' + encodeURIComponent(bucket) + '/' + encodeObjectPath(objectPath));
  const bytes = Buffer.from(await response.arrayBuffer());
  fs.mkdirSync(path.dirname(destination), { recursive: true, mode: 0o700 });
  fs.writeFileSync(destination, bytes, { mode: 0o600, flag: 'wx' });
  return bytes.length;
}
async function getProjectConfig(projectRef, token) {
  const response = await fetch('https://api.supabase.com/v2/projects/' + encodeURIComponent(projectRef) + '/config', {
    headers: { authorization: 'Bearer ' + token, accept: 'application/json' },
    signal: AbortSignal.timeout(120000)
  });
  if (!response.ok) throw new Error('Supabase Management API config export failed (' + response.status + '): ' + (await response.text()).slice(0, 600));
  return response.json();
}
async function main(env = process.env) {
  const databaseUrl = required(env, 'DATABASE_URL');
  const supabaseUrl = required(env, 'SUPABASE_URL');
  const serviceKey = required(env, 'SUPABASE_SERVICE_ROLE_KEY', 20);
  const encryptionKey = required(env, 'RENT_BACKUP_ENCRYPTION_KEY', 32);
  const projectRef = required(env, 'SUPABASE_PROJECT_REF', 10);
  const managementToken = required(env, 'SUPABASE_ACCESS_TOKEN', 20);
  const b2Endpoint = required(env, 'B2_S3_ENDPOINT');
  const b2Region = required(env, 'B2_REGION');
  const b2Bucket = required(env, 'B2_BUCKET');
  const b2KeyId = required(env, 'B2_APPLICATION_KEY_ID', 5);
  const b2Key = required(env, 'B2_APPLICATION_KEY', 10);
  if (!/^https:\/\/[a-z0-9-]+\.supabase\.co$/.test(supabaseUrl)) throw new Error('SUPABASE_URL must be the project HTTPS URL.');
  if (!/^[a-z0-9]{20}$/.test(projectRef)) throw new Error('SUPABASE_PROJECT_REF must be the 20-character project reference.');
  const endpointMatch = b2Endpoint.match(/^https:\/\/s3\.([a-z0-9-]+)\.backblazeb2\.com\/?$/);
  if (!endpointMatch || endpointMatch[1] !== b2Region) throw new Error('B2 endpoint and region are invalid or do not match.');
  const work = fs.mkdtempSync(path.join(os.tmpdir(), 'mauriskade-supabase-managed-'));
  const payloadRoot = path.join(work, 'payload');
  const storageRoot = path.join(payloadRoot, 'storage');
  fs.mkdirSync(storageRoot, { recursive: true, mode: 0o700 });
  const date = localDate();
  const name = 'mauriskade-supabase-managed-' + date + '.tar.gz.mrbk';
  const authDump = path.join(payloadRoot, 'auth-schema.dump');
  try {
    // Auth's users, password hashes, identities and session records live in the managed auth schema.
    await run('pg_dump', ['--format=custom', '--compress=6', '--schema=auth', '--no-owner', '--no-acl', '--file', authDump, databaseUrl]);
    const authListing = await run('pg_restore', ['--list', authDump]);
    if (!hasAuthUsersEntry(authListing.stdout)) {
      throw new Error('Auth schema dump did not contain the expected auth.users table.');
    }
    const bucketsResponse = await apiRequest(supabaseUrl, serviceKey, '/storage/v1/bucket');
    const buckets = await bucketsResponse.json();
    if (!Array.isArray(buckets)) throw new Error('Supabase Storage returned an invalid bucket list.');
    const storageSummary = [];
    for (const bucket of buckets) {
      if (!bucket || typeof bucket.name !== 'string') throw new Error('Supabase returned a bucket without a valid name.');
      const objects = await listBucketObjects(supabaseUrl, serviceKey, bucket.name);
      const bucketDir = path.join(storageRoot, bucket.name);
      fs.mkdirSync(bucketDir, { recursive: true, mode: 0o700 });
      let bytes = 0;
      for (const object of objects) {
        const target = path.join(bucketDir, ...object.path.split('/'));
        const actual = await downloadStorageObject(supabaseUrl, serviceKey, bucket.name, object.path, target);
        if (object.size && object.size !== actual) throw new Error('Storage object size mismatch for ' + bucket.name + '/' + object.path);
        object.downloadedBytes = actual;
        bytes += actual;
      }
      storageSummary.push({ name: bucket.name, id: bucket.id || null, public: Boolean(bucket.public), fileSizeLimit: bucket.file_size_limit ?? null, allowedMimeTypes: bucket.allowed_mime_types ?? null, objects: objects.length, bytes });
      fs.writeFileSync(path.join(bucketDir, '.objects-manifest.json'), JSON.stringify(objects, null, 2), { mode: 0o600 });
    }
    const projectConfig = await getProjectConfig(projectRef, managementToken);
    fs.writeFileSync(path.join(payloadRoot, 'project-config.json'), JSON.stringify(projectConfig, null, 2), { mode: 0o600 });
    fs.writeFileSync(path.join(payloadRoot, 'storage-buckets.json'), JSON.stringify(storageSummary, null, 2), { mode: 0o600 });
    fs.writeFileSync(path.join(payloadRoot, 'BACKUP-MANIFEST.json'), JSON.stringify({
      format: 'mauriskade-supabase-managed-v1',
      createdAt: new Date().toISOString(),
      projectRef,
      auth: { file: 'auth-schema.dump', includes: 'Supabase auth schema database objects and records, including user password hashes and identities' },
      storage: storageSummary,
      configuration: { file: 'project-config.json', endpoint: '/v2/projects/{ref}/config', alpha: true, note: 'Auth secret values are returned as HMACs by Supabase; not plaintext credentials.' }
    }, null, 2), { mode: 0o600 });
    const tarPath = path.join(work, 'managed.tar.gz');
    await run('tar', ['-czf', tarPath, '-C', payloadRoot, '.']);
    const encryptedPath = path.join(work, name);
    const encrypted = encryptArchive(fs.readFileSync(tarPath), encryptionKey);
    fs.writeFileSync(encryptedPath, encrypted, { mode: 0o600 });
    const decrypted = decryptArchive(fs.readFileSync(encryptedPath), encryptionKey);
    if (!decrypted.equals(fs.readFileSync(tarPath))) throw new Error('Managed backup AES-256-GCM round-trip verification failed.');
    const digest = crypto.createHash('sha256').update(encrypted).digest('hex');
    const objectKey = 'supabase-managed/' + name;
    const awsEnv = {
      ...process.env,
      AWS_ACCESS_KEY_ID: b2KeyId,
      AWS_SECRET_ACCESS_KEY: b2Key,
      AWS_DEFAULT_REGION: b2Region,
      AWS_REGION: b2Region,
      AWS_EC2_METADATA_DISABLED: 'true',
      AWS_RETRY_MODE: 'standard',
      AWS_MAX_ATTEMPTS: '5'
    };
    const endpointArgs = ['--endpoint-url', b2Endpoint.replace(/\/$/, ''), '--region', b2Region];
    console.log(JSON.stringify({ status: 'managed_archive_ready_for_b2', bytes: encrypted.length, storageBuckets: storageSummary.length, storageObjects: storageSummary.reduce((sum, item) => sum + item.objects, 0) }));
    await run('aws', ['s3api', 'put-object', '--bucket', b2Bucket, '--key', objectKey, '--body', encryptedPath, '--metadata', 'sha256=' + digest, ...endpointArgs], { env: awsEnv });
    const head = await run('aws', ['s3api', 'head-object', '--bucket', b2Bucket, '--key', objectKey, ...endpointArgs, '--output', 'json'], { env: awsEnv });
    const meta = JSON.parse(head.stdout);
    if (Number(meta.ContentLength) !== encrypted.length || !meta.Metadata || meta.Metadata.sha256 !== digest) throw new Error('Managed backup B2 HEAD verification failed.');
    const downloaded = path.join(work, 'b2-verified.mrbk');
    await run('aws', ['s3api', 'get-object', '--bucket', b2Bucket, '--key', objectKey, ...endpointArgs, downloaded], { env: awsEnv });
    const downloadDigest = crypto.createHash('sha256').update(fs.readFileSync(downloaded)).digest('hex');
    if (downloadDigest !== digest) throw new Error('Managed backup B2 download SHA-256 verification failed.');
    console.log(JSON.stringify({
      status: 'supabase_managed_backup_verified',
      fileName: name,
      bucket: b2Bucket,
      objectKey,
      bytes: encrypted.length,
      sha256: digest,
      authDumpBytes: fs.statSync(authDump).size,
      storage: storageSummary,
      configSections: Object.keys(projectConfig || {}),
      verifiedByDownload: true
    }));
  } finally {
    fs.rmSync(work, { recursive: true, force: true });
  }
}
if (require.main === module) main().catch(error => { console.error(error.message); process.exitCode = 1; });
module.exports = { safeObjectPath, encodeObjectPath, listBucketObjects, getProjectConfig, hasAuthUsersEntry };
