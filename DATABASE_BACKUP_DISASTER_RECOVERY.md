# Mauriskade database backup and disaster recovery

The production backup job runs in GitHub Actions daily at 02:00 Africa/Nairobi (23:00 UTC), with a manual workflow-dispatch option.

## Backup scope

PostgreSQL 17 pg_dump custom format captures the application-owned public schema, including table definitions and data, indexes, constraints, sequences, views, functions, triggers, and row-level-security policies. Supabase-managed control-plane schemas such as auth, storage, and platform internals are excluded and remain under Supabase platform backup/recovery scope.

Archives are encrypted with AES-256-GCM and uploaded to the private mauriskade-db-backups bucket. Objects older than 90 days are removed only after the current archive passes restore verification.

## Isolated restore verification

Before upload, the workflow authenticates/decrypts the archive, inspects its PostgreSQL archive directory, and restores it with pg_restore --exit-on-error into a fresh PostgreSQL 17 service database named restore_test. It checks that application tables, indexes, sequences, policies, and key rent/payment tables exist. The restore target is an ephemeral CI database and is never production. A failed restore blocks upload.

## Required GitHub Actions secrets

GitHub repository Settings -> Secrets and variables -> Actions -> New repository secret:

- DATABASE_URL: the private PostgreSQL connection string used by the Render backend. Use Supabase direct connection if reachable from GitHub Actions, otherwise the session pooler connection string.
- SUPABASE_URL: project API URL.
- SUPABASE_SERVICE_ROLE_KEY: server-side Supabase secret/service-role API key.
- RENT_BACKUP_ENCRYPTION_KEY: the independently generated 64-character hexadecimal key. Keep an offline copy.

Render environment variables are not automatically available to GitHub Actions. The workflow fails closed when a secret is missing.

## Recovery procedure

1. Provision a new isolated PostgreSQL 17 database (or a separate Supabase project). Create the Supabase API roles anon, authenticated, and service_role before restoring.
2. Download the chosen .mrbk object from the private bucket and decrypt it using the original RENT_BACKUP_ENCRYPTION_KEY.
3. Restore the resulting PostgreSQL custom archive with pg_restore --exit-on-error --no-owner --no-acl --dbname="$RECOVERY_DATABASE_URL" database.dump.
4. Validate table counts, tenancy/payment records, indexes, sequences, policies, and application smoke tests before any cutover.
5. Never point the restore command at the live production database.

The automated test proves restorability of the application-owned public schema into a clean PostgreSQL 17 database. A separate operational disaster-recovery exercise against a newly provisioned Supabase project is still required before claiming end-to-end platform recovery, because Supabase-managed schemas, project configuration, and secrets are outside this application-schema archive.
