'use strict';
const test = require('node:test');
const assert = require('node:assert/strict');
const crypto = require('node:crypto');
const { encryptArchive, decryptArchive } = require('../scripts/backup-database');

test('full database backup encryption authenticates archive and rejects wrong keys or tampering', () => {
  const key = crypto.randomBytes(32).toString('hex');
  const original = Buffer.from('PostgreSQL custom-format dump fixture');
  const encrypted = encryptArchive(original, key);
  assert.equal(encrypted.subarray(0, 5).toString(), 'MRBK2');
  assert.deepEqual(decryptArchive(encrypted, key), original);
  assert.throws(() => decryptArchive(encrypted, 'wrong-key-that-is-long-enough-to-pass'));
  const changed = Buffer.from(encrypted);
  changed[changed.length - 1] ^= 1;
  assert.throws(() => decryptArchive(changed, key));
});
