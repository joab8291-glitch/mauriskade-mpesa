'use strict';
const crypto = require('node:crypto');
const { promisify } = require('node:util');
const { execFile } = require('node:child_process');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const execFileAsync = promisify(execFile);
const PREFIX = 'mauriskade-system-backup-';
const PATTERN = /^mauriskade-system-backup-(\d{4}-\d{2}-\d{2})\.mrbk$/;

function requiredEnv(env, name, min = 1) {
  const value = String(env[name] || '').trim();
  if (value.length < min) throw new Error('Missing or invalid required secret/configuration: ' + name);
  return value;
}
function b2Config(env = process.env) {
  const endpoint = requiredEnv(env, 'B2_S3_ENDPOINT');
  const region = requiredEnv(env, 'B2_REGION');
  const bucket = requiredEnv(env, 'B2_BUCKET');
  requiredEnv(env, 'B2_APPLICATION_KEY_ID', 5);
  requiredEnv(env, 'B2_APPLICATION_KEY', 10);
  const endpointMatch = endpoint.match(/^https:\/\/s3\.([a-z0-9-]+)\.backblazeb2\.com\/?$/);
  if (!endpointMatch) throw new Error('B2_S3_ENDPOINT must be the HTTPS S3 endpoint shown for the bucket in Backblaze.');
  if (region !== endpointMatch[1]) throw new Error('B2_REGION must match the region embedded in B2_S3_ENDPOINT.');
  if (!/^[a-z0-9][a-z0-9.-]{1,61}[a-z0-9]$/.test(bucket)) throw new Error('B2_BUCKET is not a valid bucket name.');
  return { endpoint: endpoint.replace(/\/$/, ''), region, bucket };
}
async function aws(args, env = process.env) {
  try {
    const region = requiredEnv(env, 'B2_REGION');
    const keyId = requiredEnv(env, 'B2_APPLICATION_KEY_ID', 5);
    const key = requiredEnv(env, 'B2_APPLICATION_KEY', 10);
    const result = await execFileAsync('aws', args, {
      maxBuffer: 16 * 1024 * 1024,
      env: { ...process.env, ...env, AWS_ACCESS_KEY_ID: keyId, AWS_SECRET_ACCESS_KEY: key, AWS_DEFAULT_REGION: region, AWS_REGION: region, AWS_EC2_METADATA_DISABLED: 'true', AWS_RETRY_MODE: 'standard', AWS_MAX_ATTEMPTS: '5' }
    });
    return result.stdout;
  } catch (error) {
    throw new Error('Backblaze B2 S3 operation failed: ' + String(error.stderr || error.message || '').slice(-3000));
  }
}

async function authorizeB2(env = process.env) {
  const keyId = requiredEnv(env, 'B2_APPLICATION_KEY_ID', 5);
  const key = requiredEnv(env, 'B2_APPLICATION_KEY', 10);
  const bucketName = requiredEnv(env, 'B2_BUCKET');
  const response = await fetch('https://api.backblazeb2.com/b2api/v4/b2_authorize_account', {
    headers: { authorization: 'Basic ' + Buffer.from(keyId + ':' + key).toString('base64') },
    signal: AbortSignal.timeout(30000)
  });
  if (!response.ok) throw new Error('Backblaze B2 Native API authorization failed (' + response.status + '). Check the B2 application key ID and key in GitHub Secrets.');
  const auth = await response.json();
  const storage = auth.apiInfo && auth.apiInfo.storageApi;
  const allowed = storage && storage.allowed || {};
  const capabilities = Array.isArray(allowed.capabilities) ? allowed.capabilities : [];
  if (!capabilities.includes('listFiles')) throw new Error('Backblaze B2 application key is missing listFiles capability.');
  if (!capabilities.includes('readFiles')) throw new Error('Backblaze B2 application key is missing readFiles capability.');
  let bucket = Array.isArray(allowed.buckets) ? allowed.buckets.find(item => item && item.name === bucketName) : null;
  if (!bucket && Array.isArray(allowed.buckets)) throw new Error('Backblaze B2 key is not authorized for the configured bucket.');
  if (!bucket) {
    const listResponse = await fetch(storage.apiUrl.replace(/\/$/, '') + '/b2api/v4/b2_list_buckets', {
      method: 'POST',
      headers: { authorization: auth.authorizationToken, 'content-type': 'application/json' },
      body: JSON.stringify({ accountId: auth.accountId }),
      signal: AbortSignal.timeout(30000)
    });
    if (!listResponse.ok) throw new Error('Backblaze B2 could not resolve the configured bucket for this application key.');
    const listed = await listResponse.json();
    bucket = (listed.buckets || []).find(item => item && item.bucketName === bucketName);
  }
  if (!bucket || !bucket.bucketId && !bucket.id) throw new Error('Backblaze B2 did not return the configured bucket ID.');
  return {
    apiUrl: storage.apiUrl,
    authorizationToken: auth.authorizationToken,
    bucketId: bucket.bucketId || bucket.id,
    bucketName,
    namePrefix: allowed.namePrefix || null
  };
}
async function listB2Files(scope, prefix) {
  const files = [];
  let startFileName;
  for (;;) {
    const body = { bucketId: scope.bucketId, prefix, maxFileCount: 1000 };
    if (startFileName) body.startFileName = startFileName;
    const response = await fetch(scope.apiUrl.replace(/\/$/, '') + '/b2api/v4/b2_list_file_names', {
      method: 'POST',
      headers: { authorization: scope.authorizationToken, 'content-type': 'application/json' },
      body: JSON.stringify(body),
      signal: AbortSignal.timeout(60000)
    });
    if (!response.ok) throw new Error('Backblaze B2 Native API file listing failed (' + response.status + '): ' + (await response.text()).slice(0, 500));
    const result = await response.json();
    if (!Array.isArray(result.files)) throw new Error('Backblaze B2 returned an invalid file listing.');
    files.push(...result.files.filter(item => item && item.action === 'upload'));
    if (!result.nextFileName || result.nextFileName === startFileName) break;
    startFileName = result.nextFileName;
  }
  return files;
}

function sha256File(filePath) {
  const hash = crypto.createHash('sha256');
  const fs = require('node:fs');
  hash.update(fs.readFileSync(filePath));
  return hash.digest('hex');
}
async function replicateToB2(filePath, fileName, env = process.env) {
  const config = b2Config(env);
  if (!PATTERN.test(fileName)) throw new Error('Refusing to replicate an unexpected backup filename.');
  const digest = sha256File(filePath);
  const key = 'database/' + fileName;
  await aws(['s3api', 'put-object', '--bucket', config.bucket, '--key', key, '--body', filePath, '--metadata', 'sha256=' + digest, '--endpoint-url', config.endpoint, '--region', config.region], env);
  const head = JSON.parse(await aws(['s3api', 'head-object', '--bucket', config.bucket, '--key', key, '--endpoint-url', config.endpoint, '--output', 'json'], env));
  if (Number(head.ContentLength) !== require('node:fs').statSync(filePath).size || !head.Metadata || head.Metadata.sha256 !== digest) {
    throw new Error('Backblaze B2 object verification failed after upload.');
  }
  const fs = require('node:fs');
  const os = require('node:os');
  const path = require('node:path');
  const temp = fs.mkdtempSync(path.join(os.tmpdir(), 'mauriskade-b2-check-'));
  const downloaded = path.join(temp, 'verified.mrbk');
  try {
    await aws(['s3api', 'get-object', '--bucket', config.bucket, '--key', key, '--endpoint-url', config.endpoint, '--region', config.region, downloaded], env);
    if (sha256File(downloaded) !== digest) throw new Error('Backblaze B2 upload/download SHA-256 verification failed.');
  } finally { fs.rmSync(temp, { recursive: true, force: true }); }
  return { provider: 'backblaze_b2', bucket: config.bucket, key, bytes: head.ContentLength, sha256: digest, verifiedByDownload: true };
}
async function latestB2Archive(env = process.env) {
  const config = b2Config(env);
  const scope = await authorizeB2(env);
  const prefix = scope.namePrefix || 'database/';
  const files = await listB2Files(scope, prefix);
  const candidates = files
    .filter(item => item && typeof item.fileName === 'string' && PATTERN.test(item.fileName.split('/').pop()) && item.fileName.startsWith('database/'))
    .sort((a, b) => a.fileName.localeCompare(b.fileName));
  if (!candidates.length) throw new Error('No dated Mauriskade database backup exists in the Backblaze B2 bucket.');
  const latest = candidates[candidates.length - 1];
  return { config, key: latest.fileName, object: { Key: latest.fileName, Size: latest.contentLength }, scope };
}
async function downloadLatestFromB2(destinationPath, env = process.env) {
  const latest = await latestB2Archive(env);
  await aws(['s3api', 'get-object', '--bucket', latest.config.bucket, '--key', latest.key, '--endpoint-url', latest.config.endpoint, '--region', latest.config.region, destinationPath], env);
  const digest = sha256File(destinationPath);
  if (latest.object.Size !== undefined && Number(latest.object.Size) !== require('node:fs').statSync(destinationPath).size) {
    throw new Error('Downloaded Backblaze B2 archive size does not match the listed object.');
  }
  return { ...latest, sha256: digest, bytes: require('node:fs').statSync(destinationPath).size };
}
module.exports = { b2Config, replicateToB2, latestB2Archive, downloadLatestFromB2, sha256File, authorizeB2, listB2Files };
