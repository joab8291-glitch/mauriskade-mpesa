'use strict';
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const crypto = require('node:crypto');
const { promisify } = require('node:util');
const { execFile } = require('node:child_process');
const { decryptArchive } = require('./backup-database');
const { b2Config, authorizeB2, listB2Files, aws } = require('./b2-backup-storage');
const execFileAsync = promisify(execFile);
const PROD_REF = 'glqwedodptzgjvmbbceh';
const ARCHIVE = /^mauriskade-supabase-managed-(\d{4}-\d{2}-\d{2})\.tar\.gz\.mrbk$/;
function required(env, name, min = 1) { const value = String(env[name] || '').trim(); if (value.length < min) throw new Error('Missing required staging secret/configuration: ' + name); return value; }
function assertStagingTarget(projectRef, databaseUrl) {
  if (!/^[a-z0-9]{20}$/.test(projectRef) || projectRef === PROD_REF) throw new Error('STAGING_PROJECT_REF must be a valid non-production Supabase project reference.');
  const url = new URL(databaseUrl);
  const directHost = url.hostname === 'db.' + projectRef + '.supabase.co';
  const poolerHost = url.hostname.endsWith('.pooler.supabase.com') && decodeURIComponent(url.username).endsWith('.' + projectRef);
  if (!directHost && !poolerHost) throw new Error('STAGING_DATABASE_URL does not identify the declared staging project; refusing restore.');
  if (url.pathname.replace(/^\//, '') !== 'postgres') throw new Error('Staging database must be the default postgres database.');
  if (url.hostname === 'db.' + PROD_REF + '.supabase.co' || decodeURIComponent(url.username).endsWith('.' + PROD_REF)) throw new Error('Production database target is explicitly blocked.');
  return url;
}
function safeObjectPath(value) { if (typeof value !== 'string' || !value || value.startsWith('/') || value.split('/').some(part => !part || part === '.' || part === '..')) throw new Error('Unsafe Storage object path in backup manifest.'); return value; }
function sha256(buffer) { return crypto.createHash('sha256').update(buffer).digest('hex'); }
async function run(command, args, options = {}) { try { return await execFileAsync(command, args, { maxBuffer: 32 * 1024 * 1024, ...options }); } catch (error) { throw new Error(command + ' failed: ' + String(error.stderr || error.message || '').slice(-3000)); } }
async function storageRequest(base, key, route, options = {}) {
  const response = await fetch(base.replace(/\/$/, '') + '/storage/v1' + route, { ...options, headers: { apikey: key, authorization: 'Bearer ' + key, ...(options.headers || {}) }, signal: AbortSignal.timeout(120000) });
  if (!response.ok) throw new Error('Staging Storage API returned HTTP ' + response.status + ' for ' + route + '.');
  return response;
}
async function main(env = process.env) {
  const projectRef = required(env, 'STAGING_PROJECT_REF', 20);
  const databaseUrl = required(env, 'STAGING_DATABASE_URL');
  const supabaseUrl = required(env, 'STAGING_SUPABASE_URL');
  const serviceKey = required(env, 'STAGING_SUPABASE_SERVICE_ROLE_KEY', 20);
  const encryptionKey = required(env, 'RENT_BACKUP_ENCRYPTION_KEY', 32);
  assertStagingTarget(projectRef, databaseUrl);
  if (supabaseUrl !== 'https://' + projectRef + '.supabase.co') throw new Error('STAGING_SUPABASE_URL does not match STAGING_PROJECT_REF.');
  const work = fs.mkdtempSync(path.join(os.tmpdir(), 'mauriskade-staging-restore-'));
  try {
    const config = b2Config(env), scope = await authorizeB2(env);
    const prefix = (scope.namePrefix || 'database/') + 'supabase-managed/';
    const files = await listB2Files(scope, prefix);
    const candidates = files.filter(item => item && item.action === 'upload' && typeof item.fileName === 'string' && ARCHIVE.test(item.fileName.split('/').pop())).sort((a,b) => a.fileName.localeCompare(b.fileName));
    if (!candidates.length) throw new Error('No dated Supabase-managed archive found in the authorized B2 prefix.');
    const latest = candidates[candidates.length - 1];
    const encryptedPath = path.join(work, 'managed.mrbk');
    await aws(['s3api','get-object','--bucket',config.bucket,'--key',latest.fileName,'--endpoint-url',config.endpoint,'--region',config.region,encryptedPath], env);
    const encrypted = fs.readFileSync(encryptedPath);
    if (latest.contentLength !== undefined && Number(latest.contentLength) !== encrypted.length) throw new Error('Managed archive size does not match B2 listing.');
    const plain = decryptArchive(encrypted, encryptionKey);
    const tarPath = path.join(work, 'managed.tar.gz'); fs.writeFileSync(tarPath, plain, { mode: 0o600 });
    const entries = (await run('tar',['-tzf',tarPath])).stdout.split('\n').filter(Boolean);
    if (entries.some(entry => entry.startsWith('/') || entry.split('/').includes('..'))) throw new Error('Managed archive contains an unsafe path.');
    const payload = path.join(work,'payload'); fs.mkdirSync(payload,{mode:0o700});
    await run('tar',['-xzf',tarPath,'-C',payload,'--no-same-owner','--no-same-permissions']);
    const manifest = JSON.parse(fs.readFileSync(path.join(payload,'BACKUP-MANIFEST.json'),'utf8'));
    if (manifest.projectRef !== PROD_REF) throw new Error('Managed archive does not belong to the configured production project.');
    const bucketManifest = JSON.parse(fs.readFileSync(path.join(payload,'storage-buckets.json'),'utf8'));
    const authDump = path.join(payload,'auth-schema.dump');
    const authListing = (await run('pg_restore',['--list',authDump])).stdout;
    if (!authListing.includes('TABLE auth users') || !authListing.includes('TABLE DATA auth users')) throw new Error('Auth backup is missing auth.users definition/data; staging restore stopped.');
    const existingBuckets = await (await storageRequest(supabaseUrl,serviceKey,'/bucket')).json();
    if (!Array.isArray(existingBuckets) || existingBuckets.length) throw new Error('Staging Storage must be empty before restore; refusing to overwrite existing buckets.');
    const tableCount = await run('psql',[databaseUrl,'-X','-v','ON_ERROR_STOP=1','-Atc',"SELECT count(*) FROM pg_class c JOIN pg_namespace n ON n.oid=c.relnamespace WHERE n.nspname='public' AND c.relkind='r'"]);
    if (Number(tableCount.stdout.trim()) > 0) throw new Error('Staging public schema is not empty; refusing to overwrite existing tables.');
    const roleCheck = await run('psql',[databaseUrl,'-X','-v','ON_ERROR_STOP=1','-Atc',"SELECT count(*) FROM pg_roles WHERE rolname IN ('anon','authenticated','service_role')"]);
    if (Number(roleCheck.stdout.trim()) !== 3) throw new Error('Staging Supabase database is missing expected API roles.');
    const dbArchive = path.join(work,'database.dump');
    // Obtain the separately encrypted public database archive from B2; target is guarded above.
    const { downloadLatestFromB2 } = require('./b2-backup-storage');
    const dbEncrypted = path.join(work,'database.mrbk');
    const dbSource = await downloadLatestFromB2(dbEncrypted,env);
    const dbPlain = decryptArchive(fs.readFileSync(dbEncrypted),encryptionKey);
    fs.writeFileSync(dbArchive,dbPlain,{mode:0o600});
    await run('pg_restore',['--exit-on-error','--no-owner','--no-acl','--dbname',databaseUrl,dbArchive]);
    const restoredTables = await run('psql',[databaseUrl,'-X','-v','ON_ERROR_STOP=1','-Atc',"SELECT json_build_object('tables',(SELECT count(*) FROM pg_class c JOIN pg_namespace n ON n.oid=c.relnamespace WHERE n.nspname='public' AND c.relkind='r'),'rlsTables',(SELECT count(*) FROM pg_class c JOIN pg_namespace n ON n.oid=c.relnamespace WHERE n.nspname='public' AND c.relkind='r' AND c.relrowsecurity),'policies',(SELECT count(*) FROM pg_policies WHERE schemaname='public'),'keyTables',(SELECT count(*) FROM information_schema.tables WHERE table_schema='public' AND table_name IN ('rent_leases','rent_payments','rent_allocations','rent_settlements','tenancy_agreements','admin_actions')) )::text"]);
    const verification = JSON.parse(restoredTables.stdout.trim());
    if (verification.tables < 10 || verification.rlsTables !== verification.tables || verification.policies < 1 || verification.keyTables !== 6) throw new Error('Staging public database restore verification failed: ' + JSON.stringify(verification));
    let restoredObjects = 0, restoredBytes = 0;
    for (const bucket of bucketManifest) {
      if (!bucket || !/^[a-z0-9][a-z0-9._-]{1,62}$/.test(bucket.name)) throw new Error('Invalid Storage bucket name in backup manifest.');
      const settings = bucket.bucketSettings || {};
      const bucketOptions = { name: bucket.name, public: Boolean(bucket.public) };
      if (settings.file_size_limit != null) bucketOptions.fileSizeLimit = settings.file_size_limit;
      if (settings.allowed_mime_types != null) bucketOptions.allowedMimeTypes = settings.allowed_mime_types;
      await storageRequest(supabaseUrl,serviceKey,'/bucket',{method:'POST',headers:{'content-type':'application/json'},body:JSON.stringify(bucketOptions)});
      const bucketDir = path.join(payload,'storage',bucket.name);
      const manifestPath = path.join(bucketDir,'.objects-manifest.json');
      const objects = JSON.parse(fs.readFileSync(manifestPath,'utf8'));
      for (const object of objects) {
        const objectPath = safeObjectPath(object.path);
        const localPath = path.resolve(bucketDir,...objectPath.split('/'));
        if (!localPath.startsWith(bucketDir + path.sep) || !fs.existsSync(localPath)) throw new Error('Storage object file missing or escaped its bucket directory.');
        const bytes = fs.readFileSync(localPath);
        if (object.downloadedBytes !== undefined && Number(object.downloadedBytes) !== bytes.length) throw new Error('Storage object byte count differs from backup manifest.');
        const route = '/object/' + encodeURIComponent(bucket.name) + '/' + objectPath.split('/').map(encodeURIComponent).join('/');
        await storageRequest(supabaseUrl,serviceKey,route,{method:'POST',headers:{'content-type':object.contentType || 'application/octet-stream','x-upsert':'false'},body:bytes});
        const downloaded = Buffer.from(await (await storageRequest(supabaseUrl,serviceKey,route)).arrayBuffer());
        if (sha256(downloaded) !== sha256(bytes)) throw new Error('Staging Storage download verification failed for ' + bucket.name + '/' + objectPath);
        restoredObjects++; restoredBytes += bytes.length;
      }
    }
    console.log(JSON.stringify({status:'staging_public_database_and_storage_restore_passed',targetProjectRef:projectRef,sourceDatabaseArchive:dbSource.key,sourceManagedArchive:latest.fileName,publicTables:verification.tables,rlsTables:verification.rlsTables,policies:verification.policies,storageBuckets:bucketManifest.length,storageObjects:restoredObjects,storageBytes:restoredBytes,authArchiveValidated:true,authRestore:'pending_platform_aware_operator_migration',projectConfig:'exported_for_manual_review',productionModified:false}));
  } finally { fs.rmSync(work,{recursive:true,force:true}); }
}
if (require.main === module) main().catch(error => { console.error('Staging restore failed: ' + error.message); process.exitCode = 1; });
module.exports = { assertStagingTarget, safeObjectPath };
