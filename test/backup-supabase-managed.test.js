'use strict';
const test = require('node:test');
const assert = require('node:assert/strict');
const { safeObjectPath, encodeObjectPath } = require('../scripts/backup-supabase-managed');

test('Storage object paths preserve nested keys without permitting traversal', () => {
  assert.equal(safeObjectPath('tenant-documents/2026/lease.pdf'), 'tenant-documents/2026/lease.pdf');
  assert.throws(() => safeObjectPath('../secrets.txt'), /unsafe object path/);
  assert.throws(() => safeObjectPath('/absolute/file'), /unsafe object path/);
  assert.throws(() => safeObjectPath('folder//file'), /unsafe object path/);
});

test('Storage API path encoding preserves hierarchy and encodes unsafe segments', () => {
  assert.equal(encodeObjectPath('folder with spaces/lease #1.pdf'), 'folder%20with%20spaces/lease%20%231.pdf');
});
