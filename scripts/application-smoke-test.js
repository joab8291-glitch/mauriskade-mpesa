'use strict';
const { Pool } = require('pg');

function normalizeApiBaseUrl(value) {
  const url = new URL(String(value || '').trim());
  if (url.protocol !== 'https:' || url.username || url.password || url.search || url.hash) throw new Error('API_BASE_URL must be a clean HTTPS URL without credentials, query, or fragment.');
  return url.toString().replace(/\/+$/, '');
}
async function checkJsonEndpoint(url, expectedKeys = []) {
  const response = await fetch(url, { signal: AbortSignal.timeout(15000), headers: { accept: 'application/json' } });
  if (!response.ok) throw new Error('Health endpoint returned HTTP ' + response.status + '.');
  const body = await response.json();
  if (!body || body.ok !== true) throw new Error('Health endpoint did not return { ok: true }.');
  for (const key of expectedKeys) if (body[key] !== true) throw new Error('Health endpoint did not confirm ' + key + '.');
  return { status: response.status };
}
async function checkDatabase(connectionString) {
  if (!connectionString) throw new Error('DATABASE_URL is required.');
  const pool = new Pool({ connectionString, max: 1, connectionTimeoutMillis: 10000, idleTimeoutMillis: 1000, ssl: { rejectUnauthorized: true } });
  try {
    const sql = "SELECT current_database() AS database_name, current_setting('server_version_num')::integer AS server_version_num, count(*) FILTER (WHERE c.relkind='r')::integer AS public_tables, count(*) FILTER (WHERE c.relkind='r' AND c.relrowsecurity)::integer AS rls_tables, bool_and(to_regclass('public.' || required.table_name) IS NOT NULL) AS required_tables_present FROM pg_class c JOIN pg_namespace n ON n.oid=c.relnamespace CROSS JOIN (VALUES ('rent_leases'),('rent_payments'),('rent_allocations'),('rent_settlements'),('tenancy_agreements'),('admin_actions')) required(table_name) WHERE n.nspname='public'";
    const row = (await pool.query(sql)).rows[0];
    if (!row || !row.required_tables_present) throw new Error('One or more required Mauriskade tables are missing.');
    if (Number(row.public_tables) < 10 || Number(row.rls_tables) !== Number(row.public_tables)) throw new Error('Public schema table/RLS verification failed.');
    return { database: row.database_name, postgresMajor: Math.floor(Number(row.server_version_num) / 10000), publicTables: Number(row.public_tables), rlsTables: Number(row.rls_tables), requiredTablesPresent: true };
  } finally { await pool.end(); }
}
async function main(env = process.env) {
  const apiBase = normalizeApiBaseUrl(env.API_BASE_URL);
  const health = await checkJsonEndpoint(apiBase + '/health');
  const daraja = await checkJsonEndpoint(apiBase + '/health/mpesa', ['darajaAuth']);
  const database = await checkDatabase(env.DATABASE_URL);
  console.log(JSON.stringify({ status: 'application_smoke_test_passed', paymentActionsPerformed: false, endpoints: { health: health.status, darajaAuth: daraja.status }, database }));
}
if (require.main === module) main().catch(error => { console.error('Application smoke test failed: ' + error.message); process.exitCode = 1; });
module.exports = { normalizeApiBaseUrl, checkJsonEndpoint, checkDatabase };
