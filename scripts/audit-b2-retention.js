'use strict';
// Read-only policy audit: never mutates bucket lifecycle rules.
function required(env, name, min = 1) { const value = String(env[name] || '').trim(); if (value.length < min) throw new Error('Missing required GitHub Actions secret/configuration: ' + name); return value; }
function hasRecommendedRetention(rules) { return Array.isArray(rules) && rules.some(rule => rule && rule.fileNamePrefix === 'database/' && Number(rule.daysFromUploadingToHiding) === 90 && Number(rule.daysFromHidingToDeleting) === 1); }
async function audit(env = process.env) {
  const keyId = required(env, 'B2_APPLICATION_KEY_ID', 5), key = required(env, 'B2_APPLICATION_KEY', 10), bucketName = required(env, 'B2_BUCKET');
  const authResponse = await fetch('https://api.backblazeb2.com/b2api/v4/b2_authorize_account', { headers: { authorization: 'Basic ' + Buffer.from(keyId + ':' + key).toString('base64') }, signal: AbortSignal.timeout(30000) });
  if (!authResponse.ok) throw new Error('Backblaze authorization failed (' + authResponse.status + ').');
  const auth = await authResponse.json(), storage = auth.apiInfo && auth.apiInfo.storageApi, allowed = storage && storage.allowed || {}, capabilities = Array.isArray(allowed.capabilities) ? allowed.capabilities : [];
  for (const capability of ['listBuckets', 'readBucketLifecycleRules']) if (!capabilities.includes(capability)) throw new Error('B2 key lacks read-only retention audit capability: ' + capability);
  const response = await fetch(storage.apiUrl.replace(/\/$/, '') + '/b2api/v4/b2_list_buckets', { method: 'POST', headers: { authorization: auth.authorizationToken, 'content-type': 'application/json' }, body: JSON.stringify({ accountId: auth.accountId, bucketName }), signal: AbortSignal.timeout(30000) });
  if (!response.ok) throw new Error('Backblaze bucket metadata request failed (' + response.status + ').');
  const data = await response.json(), bucket = (data.buckets || []).find(item => item && item.bucketName === bucketName);
  if (!bucket) throw new Error('Configured B2 bucket was not returned by the account-scoped metadata request.');
  const rules = Array.isArray(bucket.lifecycleRules) ? bucket.lifecycleRules : [];
  const result = { bucket: bucket.bucketName, bucketType: bucket.bucketType, private: bucket.bucketType === 'allPrivate', lifecycleRules: rules, recommended90DayRetention: hasRecommendedRetention(rules), serverSideEncryption: bucket.defaultServerSideEncryption || null };
  console.log(JSON.stringify({ status: 'b2_retention_audit_complete', ...result }));
  if (!result.private) throw new Error('B2 backup bucket is not private.');
  if (!result.recommended90DayRetention) throw new Error('B2 bucket is private, but the recommended 90-day database/ lifecycle rule (hide after 90 days, delete hidden versions after 1 day) is not configured.');
  return result;
}
if (require.main === module) audit().catch(error => { console.error('B2 retention audit failed: ' + error.message); process.exitCode = 1; });
module.exports = { hasRecommendedRetention, audit };
