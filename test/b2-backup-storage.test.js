'use strict';
const test = require('node:test');
const assert = require('node:assert/strict');
const { b2Config, sha256File } = require('../scripts/b2-backup-storage');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');

const config = {
  B2_S3_ENDPOINT: 'https://s3.us-west-004.backblazeb2.com',
  B2_REGION: 'us-west-004',
  B2_BUCKET: 'mauriskade-offsite-backups',
  B2_APPLICATION_KEY_ID: 'key-id-example',
  B2_APPLICATION_KEY: 'application-key-example-long'
};

test('B2 configuration accepts a valid regional endpoint and private bucket name', () => {
  assert.deepEqual(b2Config(config), {
    endpoint: 'https://s3.us-west-004.backblazeb2.com',
    region: 'us-west-004',
    bucket: 'mauriskade-offsite-backups'
  });
});
test('B2 configuration rejects AWS endpoints and missing credentials', () => {
  assert.throws(() => b2Config({ ...config, B2_S3_ENDPOINT: 'https://s3.amazonaws.com' }), /B2_S3_ENDPOINT/);
  assert.throws(() => b2Config({ ...config, B2_APPLICATION_KEY: '' }), /B2_APPLICATION_KEY/);
});
test('B2 bucket names must be DNS-compatible', () => {
  assert.throws(() => b2Config({ ...config, B2_BUCKET: 'Invalid Bucket' }), /valid bucket name/);
});
test('SHA-256 helper hashes the exact encrypted object bytes', () => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'mauriskade-b2-test-'));
  try {
    const file = path.join(dir, 'backup.mrbk');
    fs.writeFileSync(file, 'encrypted-fixture');
    assert.equal(sha256File(file), 'c671e7a6b1b08d8d7e9e8f0a5d16c7ec4f6c6e3b0a4b7e2c7d4a8b9b9c7c9f15');
  } finally { fs.rmSync(dir, { recursive: true, force: true }); }
});
