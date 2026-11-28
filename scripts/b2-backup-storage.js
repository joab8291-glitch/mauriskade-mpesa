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
  const value = String(env[name] || '');
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
  const configPath = path.join(os.tmpdir(), 'mauriskade-aws-' + process.pid + '.config');
  const region = requiredEnv(env, 'B2_REGION');
  fs.writeFileSync(configPath, '[default]\\nregion = ' + region + '\\ns3 =\\n  addressing_style = path\\n  signature_version = s3v4\\n', { mode: 0o600 });
  try {
    const result = await execFileAsync('aws', args, {
      maxBuffer: 16 * 1024 * 1024,
      env: { ...process.env, ...env, AWS_CONFIG_FILE: configPath, AWS_ACCESS_KEY_ID: env.B2_APPLICATION_KEY_ID, AWS_SECRET_ACCESS_KEY: env.B2_APPLICATION_KEY, AWS_DEFAULT_REGION: region, AWS_REGION: region, AWS_EC2_METADATA_DISABLED: 'true' }
    });
    return result.stdout;
  } catch (error) {
    throw new Error('Backblaze B2 S3 operation failed: ' + String(error.stderr || error.message || '').slice(-3000));
  } finally { fs.rmSync(configPath, { force: true }); }
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
  const head = JSON.parse(await aws(['s3api', 'head-object', '--bucket', config.bucket, '--key', key, '--endpoint-url', config.endpoint, '--region', config.region, '--output', 'json'], env));
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
  const output = await aws(['s3api', 'list-objects-v2', '--bucket', config.bucket, '--prefix', 'database/', '--endpoint-url', config.endpoint, '--region', config.region, '--output', 'json'], env);
  const parsed = JSON.parse(output || '{}');
  const objects = (parsed.Contents || []).filter(item => item && typeof item.Key === 'string' && /^database\/mauriskade-system-backup-\d{4}-\d{2}-\d{2}\.mrbk$/.test(item.Key));
  objects.sort((a, b) => a.Key.localeCompare(b.Key));
  if (!objects.length) throw new Error('No dated Mauriskade database backup exists in the Backblaze B2 bucket.');
  return { config, key: objects[objects.length - 1].Key, object: objects[objects.length - 1] };
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
module.exports = { b2Config, replicateToB2, latestB2Archive, downloadLatestFromB2, sha256File };
