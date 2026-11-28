'use strict';
const test = require('node:test');
const assert = require('node:assert/strict');
const { safeObjectPath, encodeObjectPath, hasAuthUsersEntry } = require('../scripts/backup-supabase-managed');
const { hasAuthUsersEntry: hasRecoveryAuthUsersEntry } = require('../scripts/recovery-drill-supabase-managed');

test('Storage object paths preserve nested keys without permitting traversal', () => {
  assert.equal(safeObjectPath('tenant-documents/2026/lease.pdf'), 'tenant-documents/2026/lease.pdf');
  assert.throws(() => safeObjectPath('../secrets.txt'), /unsafe object path/);
  assert.throws(() => safeObjectPath('/absolute/file'), /unsafe object path/);
  assert.throws(() => safeObjectPath('folder//file'), /unsafe object path/);
});

test('Storage API path encoding preserves hierarchy and encodes unsafe segments', () => {
  assert.equal(encodeObjectPath('folder with spaces/lease #1.pdf'), 'folder%20with%20spaces/lease%20%231.pdf');
});

test('Auth dump validation recognizes pg_restore listing format', () => {
  const listing = '; 1259; 16384 TABLE auth users supabase_admin\n; 1259; 16385 TABLE auth identities supabase_admin';
  assert.equal(hasAuthUsersEntry(listing), true);
  assert.equal(hasRecoveryAuthUsersEntry(listing), true);
  assert.equal(hasAuthUsersEntry('; 1259; 16384 TABLE public users postgres'), false);
});
