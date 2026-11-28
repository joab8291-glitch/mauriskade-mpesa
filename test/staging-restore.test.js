'use strict';
const test=require('node:test');
const assert=require('node:assert/strict');
const {assertStagingTarget,safeObjectPath}=require('../scripts/restore-staging');
const prod='glqwedodptzgjvmbbceh';
test('staging restore rejects production project references and database targets',()=>{
 assert.throws(()=>assertStagingTarget(prod,'postgresql://postgres@db.'+prod+'.supabase.co:5432/postgres'),/non-production/);
 assert.throws(()=>assertStagingTarget('abcdefghijklmnopqrst','postgresql://postgres@db.'+prod+'.supabase.co:5432/postgres'),/does not identify/);
});
test('staging restore accepts matching direct and pooler database targets',()=>{
 assert.doesNotThrow(()=>assertStagingTarget('abcdefghijklmnopqrst','postgresql://postgres:pw@db.abcdefghijklmnopqrst.supabase.co:5432/postgres'));
 assert.doesNotThrow(()=>assertStagingTarget('abcdefghijklmnopqrst','postgresql://postgres.abcdefghijklmnopqrst:pw@aws-0-eu-west-1.pooler.supabase.com:6543/postgres'));
});
test('staging restore rejects unsafe storage paths',()=>{
 assert.equal(safeObjectPath('leases/2026/receipt.pdf'),'leases/2026/receipt.pdf');
 assert.throws(()=>safeObjectPath('../secret'),/Unsafe/);
 assert.throws(()=>safeObjectPath('/absolute'),/Unsafe/);
});
