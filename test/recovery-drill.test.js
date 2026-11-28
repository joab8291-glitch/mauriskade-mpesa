'use strict';
const test = require('node:test');
const assert = require('node:assert/strict');
const { selectLatestArchive, assertRecoveryTarget } = require('../scripts/recovery-drill');

test('independent recovery chooses the newest correctly named archive', () => {
  assert.equal(selectLatestArchive([
    { name: 'unrelated.txt' },
    { name: 'mauriskade-system-backup-2026-11-27.mrbk' },
    { name: 'mauriskade-system-backup-2026-11-28.mrbk' }
  ]), 'mauriskade-system-backup-2026-11-28.mrbk');
});

test('independent recovery refuses an empty or invalid archive listing', () => {
  assert.throws(() => selectLatestArchive([]), /No dated Mauriskade backup archive/);
  assert.throws(() => selectLatestArchive(null), /invalid object listing/);
});

test('independent recovery is restricted to a fresh recovery_drill database', () => {
  assert.equal(assertRecoveryTarget('postgresql://postgres:secret@localhost:5432/recovery_drill').pathname, '/recovery_drill');
  assert.throws(() => assertRecoveryTarget('postgresql://postgres:secret@localhost:5432/postgres'), /production restore is refused/);
  assert.throws(() => assertRecoveryTarget(''), /RECOVERY_DATABASE_URL is required/);
});
