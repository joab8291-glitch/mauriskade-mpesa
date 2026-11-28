'use strict';
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const crypto = require('node:crypto');
const { promisify } = require('node:util');
const { execFile } = require('node:child_process');
const { decryptArchive } = require('./backup-database');
const execFileAsync = promisify(execFile);
function hasAuthUsersEntry(listing) { return String(listing).includes('TABLE auth users'); }
const NAME = /^mauriskade-supabase-managed-(\d{4}-\d{2}-\d{2})\.tar\.gz\.mrbk$/;
function required(name, min = 1) {
  const value = String(process.env[name] || '').trim();
  if (value.length < min) throw new Error('Missing or invalid required secret/configuration: ' + name);
  return value;
}
async function run(command, args, options = {}) {
  try { return await execFileAsync(command, args, { maxBuffer: 32 * 1024 * 1024, ...options }); }
  catch (error) { throw new Error(command + ' failed: ' + String(error.stderr || error.message || '').slice(-4000)); }
}
async function inspectB2Scope(keyId, applicationKey, expectedBucket) {
  const response = await fetch('https://api.backblazeb2.com/b2api/v4/b2_authorize_account', {
    headers: { authorization: 'Basic ' + Buffer.from(keyId + ':' + applicationKey).toString('base64') },
    signal: AbortSignal.timeout(30000)
  });
  if (!response.ok) throw new Error('Backblaze application-key authorization failed (' + response.status + ').');
  const auth = await response.json();
  const storage = auth.apiInfo && auth.apiInfo.storageApi;
  const allowed = storage && storage.allowed || {};
  const buckets = Array.isArray(allowed.buckets) ? allowed.buckets : null;
  let bucket = buckets ? buckets.find(item => item && item.name === expectedBucket) : null;
  if (buckets && !bucket) throw new Error('Backblaze application key is not authorized for the configured bucket.');
  const capabilities = Array.isArray(allowed.capabilities) ? allowed.capabilities : [];
  const missing = ['listFiles', 'readFiles'].filter(capability => !capabilities.includes(capability));
  if (missing.length) throw new Error('Backblaze application key is missing recovery capabilities: ' + missing.join(', '));
  if (!bucket) {
    const listResponse = await fetch(storage.apiUrl.replace(/\\/$/, '') + '/b2api/v4/b2_list_buckets', {
      method: 'POST',
      headers: { authorization: auth.authorizationToken, 'content-type': 'application/json' },
      body: JSON.stringify({ accountId: auth.accountId }),
      signal: AbortSignal.timeout(30000)
    });
    if (!listResponse.ok) throw new Error('Backblaze could not resolve the configured bucket for recovery.');
    const listed = await listResponse.json();
    bucket = (listed.buckets || []).find(item => item && item.bucketName === expectedBucket);
  }
  if (!bucket || !(bucket.bucketId || bucket.id)) throw new Error('Backblaze did not return the configured recovery bucket ID.');
  return {
    apiUrl: storage.apiUrl,
    authorizationToken: auth.authorizationToken,
    bucketId: bucket.bucketId || bucket.id,
    namePrefix: allowed.namePrefix || 'database/'
  };
}
async function listManagedArchives(scope) {
  const files = [];
  const prefix = scope.namePrefix + 'supabase-managed/';
  let startFileName;
  for (;;) {
    const body = { bucketId: scope.bucketId, prefix, maxFileCount: 1000 };
    if (startFileName) body.startFileName = startFileName;
    const response = await fetch(scope.apiUrl.replace(/\\/$/, '') + '/b2api/v4/b2_list_file_names', {
      method: 'POST',
      headers: { authorization: scope.authorizationToken, 'content-type': 'application/json' },
      body: JSON.stringify(body),
      signal: AbortSignal.timeout(60000)
    });
    if (!response.ok) throw new Error('Backblaze managed archive listing failed (' + response.status + '): ' + (await response.text()).slice(0, 500));
    const result = await response.json();
    if (!Array.isArray(result.files)) throw new Error('Backblaze returned an invalid managed archive listing.');
    files.push(...result.files.filter(item => item && item.action === 'upload' && typeof item.fileName === 'string' && NAME.test(item.fileName.split('/').pop())));
    if (!result.nextFileName || result.nextFileName === startFileName) break;
    startFileName = result.nextFileName;
  }
  return files.sort((a, b) => a.fileName.localeCompare(b.fileName));
}
async function main() {
  const encryptionKey = required('RENT_BACKUP_ENCRYPTION_KEY', 32);
  const endpoint = required('B2_S3_ENDPOINT');
  const region = required('B2_REGION');
  const bucket = required('B2_BUCKET');
  const keyId = required('B2_APPLICATION_KEY_ID', 5);
  const key = required('B2_APPLICATION_KEY', 10);
  const b2Scope = await inspectB2Scope(keyId, key, bucket);
  if (!/^https:\/\/s3\.([a-z0-9-]+)\.backblazeb2\.com\/?$/.test(endpoint) || !endpoint.includes('s3.' + region + '.')) throw new Error('B2 endpoint and region do not match.');
  const work = fs.mkdtempSync(path.join(os.tmpdir(), 'mauriskade-managed-recovery-'));
  try {
    const env = { ...process.env, AWS_ACCESS_KEY_ID: keyId, AWS_SECRET_ACCESS_KEY: key, AWS_DEFAULT_REGION: region, AWS_REGION: region, AWS_EC2_METADATA_DISABLED: 'true', AWS_RETRY_MODE: 'standard', AWS_MAX_ATTEMPTS: '5' };
    const args = ['--endpoint-url', endpoint.replace(/\/$/, ''), '--region', region];
    const objects = await listManagedArchives(b2Scope);
    if (!objects.length) throw new Error('No dated Supabase-managed backup archive found in B2.');
    const latest = objects[objects.length - 1];
    const encryptedPath = path.join(work, 'managed.mrbk');
    await run('aws', ['s3api', 'get-object', '--bucket', bucket, '--key', latest.fileName, '--endpoint-url', endpoint.replace(/\\/$/, ''), '--region', region, encryptedPath], { env });
    const encrypted = fs.readFileSync(encryptedPath);
    if (latest.Size !== undefined && Number(latest.Size) !== encrypted.length) throw new Error('Downloaded managed archive size mismatch.');
    const plain = decryptArchive(encrypted, encryptionKey);
    const tarPath = path.join(work, 'managed.tar.gz');
    fs.writeFileSync(tarPath, plain, { mode: 0o600 });
    const entries = await run('tar', ['-tzf', tarPath]);
    const names = entries.stdout.split('\n').filter(Boolean);
    for (const requiredEntry of ['auth-schema.dump', 'project-config.json', 'storage-buckets.json', 'BACKUP-MANIFEST.json']) {
      if (!names.includes('./' + requiredEntry) && !names.includes(requiredEntry)) throw new Error('Managed archive is missing ' + requiredEntry);
    }
    const payload = path.join(work, 'payload');
    fs.mkdirSync(payload, { mode: 0o700 });
    await run('tar', ['-xzf', tarPath, '-C', payload, '--no-same-owner', '--no-same-permissions']);
    const manifest = JSON.parse(fs.readFileSync(path.join(payload, 'BACKUP-MANIFEST.json'), 'utf8'));
    const buckets = JSON.parse(fs.readFileSync(path.join(payload, 'storage-buckets.json'), 'utf8'));
    const config = JSON.parse(fs.readFileSync(path.join(payload, 'project-config.json'), 'utf8'));
    const authListing = await run('pg_restore', ['--list', path.join(payload, 'auth-schema.dump')]);
    if (!hasAuthUsersEntry(authListing.stdout)) throw new Error('Auth dump does not contain auth.users.');
    let fileCount = 0, byteCount = 0;
    for (const b of buckets) {
      const root = path.join(payload, 'storage', b.name);
      const objectManifest = JSON.parse(fs.readFileSync(path.join(root, '.objects-manifest.json'), 'utf8'));
      if (objectManifest.length !== b.objects) throw new Error('Storage manifest count mismatch for bucket ' + b.name);
      for (const object of objectManifest) {
        const file = path.join(root, ...object.path.split('/'));
        if (!fs.existsSync(file) || fs.statSync(file).size !== object.downloadedBytes) throw new Error('Storage file missing or size mismatch: ' + b.name + '/' + object.path);
        fileCount++; byteCount += fs.statSync(file).size;
      }
    }
    if (!config || typeof config !== 'object' || !manifest || manifest.format !== 'mauriskade-supabase-managed-v1') throw new Error('Managed backup metadata validation failed.');
    const digest = crypto.createHash('sha256').update(encrypted).digest('hex');
    console.log(JSON.stringify({
      status: 'supabase_managed_recovery_drill_passed',
      source: 'backblaze_b2',
      bucket,
      objectKey: latest.fileName,
      encryptedBytes: encrypted.length,
      sha256: digest,
      authSchemaArchiveValid: true,
      storageBuckets: buckets.length,
      storageObjectsVerified: fileCount,
      storageBytesVerified: byteCount,
      projectConfigSections: Object.keys(config)
    }));
  } finally { fs.rmSync(work, { recursive: true, force: true }); }
}
if (require.main === module) main().catch(error => { console.error(error.message); process.exitCode = 1; });

module.exports = { hasAuthUsersEntry, inspectB2Scope, listManagedArchives };
