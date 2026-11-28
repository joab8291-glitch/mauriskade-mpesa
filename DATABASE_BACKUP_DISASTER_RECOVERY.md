# Mauriskade database backup and disaster recovery

The production backup job runs in GitHub Actions daily at 02:00 Africa/Nairobi (23:00 UTC), with a manual workflow-dispatch option.

## Backup scope

PostgreSQL 17 `pg_dump` custom format captures the application-owned `public` schema, including table definitions and data, indexes, constraints, sequences, views, functions, triggers, and row-level-security policies. Supabase-managed control-plane schemas such as `auth`, `storage`, and platform internals are excluded and remain under Supabase platform backup/recovery scope.

Archives are encrypted with AES-256-GCM and uploaded to the private Supabase `mauriskade-db-backups` bucket. The same encrypted archive is then replicated to the separate private Backblaze B2 bucket under `database/`. The B2 upload is not treated as successful until the object metadata/size is checked and the object is downloaded again and its SHA-256 digest matches. The existing Supabase copy is retained with its 90-day application-level pruning.

## Pre-upload restore verification

Before upload, the daily backup workflow decrypts its newly created archive, inspects its PostgreSQL archive directory, and restores it with `pg_restore --exit-on-error` into a fresh PostgreSQL 17 service database named `restore_test`. It checks that application tables, indexes, sequences, policies, and key rent/payment tables exist. The restore target is an ephemeral CI database and is never production. A failed restore blocks upload.

## Independent stored-archive recovery drill

The separate workflow `.github/workflows/mauriskade-recovery-drill.yml` performs a recovery test from the independent Backblaze B2 object rather than from the backup job's local temporary file:

1. Starts a new, isolated PostgreSQL 17 service database named `recovery_drill`.
2. Lists the private Backblaze B2 bucket and selects the newest correctly named dated archive.
3. Downloads that object through the Backblaze S3-compatible API using the bucket-scoped B2 application key.
4. Authenticates and decrypts the archive using the original `RENT_BACKUP_ENCRYPTION_KEY`; AES-GCM authentication failure stops the run.
5. Inspects the decrypted PostgreSQL custom archive and restores it into `recovery_drill`.
6. Verifies application table, index, sequence, policy and nine key rent/payment table counts. The output includes the selected archive name, encrypted/decrypted byte counts and SHA-256 digest.

This workflow is scheduled quarterly at 04:00 Africa/Nairobi on 1 January, 1 April, 1 July and 1 October. It can also be run on demand using GitHub Actions -> Mauriskade independent backup recovery drill -> Run workflow. A successful run is the evidence that an already-uploaded off-site B2 object can be retrieved, decrypted and restored into a separate clean database. The first post-merge run must be completed before recording the independent drill as passed.

The restore script explicitly refuses any database whose name is not `recovery_drill`. It never connects to the production database for restoration.

## Required GitHub Actions secrets

GitHub repository Settings -> Secrets and variables -> Actions -> New repository secret:

- `DATABASE_URL`: the private PostgreSQL connection string used by the Render backend. Use Supabase direct connection if reachable from GitHub Actions, otherwise the session pooler connection string. Used only by the daily backup workflow.
- `SUPABASE_URL`: project API URL (daily backup uploads the encrypted archive to the Supabase backup bucket).
- `SUPABASE_SERVICE_ROLE_KEY`: server-side Supabase secret/service-role API key (daily backup only).
- `RENT_BACKUP_ENCRYPTION_KEY`: the same independently generated key used by the backup job (64-character hexadecimal recommended). Keep an offline copy.
- `B2_S3_ENDPOINT`: complete HTTPS S3 endpoint shown on the B2 bucket details page.
- `B2_REGION`: region code embedded in that endpoint (must match exactly).
- `B2_BUCKET`: exact private B2 bucket name.
- `B2_APPLICATION_KEY_ID` and `B2_APPLICATION_KEY`: bucket-restricted application key ID and secret. The recovery drill reads from B2; the daily job writes and verifies objects.

Render environment variables are not automatically available to GitHub Actions. Never put secret values in source control or workflow logs.

## Backblaze B2 setup and retention

Create a private bucket named `mauriskade-offsite-backups` (or another globally available lowercase bucket name) in the region assigned to your Backblaze account. Do not make it public. Copy the exact S3 endpoint shown beside the bucket. Create a standard application key restricted to this bucket, with list-files, read-files and write-files capabilities; do not use the account master key. Do not grant bucket deletion or file deletion permissions to the backup key. The workflow uses the S3-compatible API with AWS Signature Version 4. The application key ID maps to `B2_APPLICATION_KEY_ID`; the one-time application key value maps to `B2_APPLICATION_KEY`.\n\nConfigure the bucket lifecycle in Backblaze to hide current backup objects after 90 days and delete noncurrent versions after 1 day (if the console exposes a previous-version retention setting). Keep the bucket private. B2 buckets are versioned, so lifecycle settings matter for controlling old versions and storage use. The archive is already encrypted client-side with AES-256-GCM before it reaches either provider.\n\nThe daily job requires the AWS CLI in the runner (`pipx install awscli`). It writes `database/mauriskade-system-backup-YYYY-MM-DD.mrbk`, verifies the upload with HEAD metadata/size, downloads it and verifies SHA-256. The quarterly recovery workflow downloads from B2 and restores only to the isolated `recovery_drill` database. It no longer depends on the Supabase backup bucket for its recovery source.\n\n## Manual recovery procedure

1. Provision a new isolated PostgreSQL 17 database (or a separate Supabase project). Create the Supabase API roles `anon`, `authenticated`, and `service_role` before restoring.
2. Download the chosen `.mrbk` object from the private bucket and decrypt it using the original `RENT_BACKUP_ENCRYPTION_KEY`.
3. Restore the resulting PostgreSQL custom archive with `pg_restore --exit-on-error --no-owner --no-acl --dbname="$RECOVERY_DATABASE_URL" database.dump`.
4. Validate table counts, tenancy/payment records, indexes, sequences, policies, and application smoke tests before any cutover.
5. Never point the restore command at the live production database.

## Recovery boundaries

The application-owned `public` database archive remains separate from Supabase-managed services. The companion workflows documented in `SUPABASE_MANAGED_SERVICES_BACKUP.md` separately export the `auth` schema, actual Storage object bytes and effective project configuration into a second encrypted B2 artifact. The managed-services recovery drill validates those downloaded artifacts without mutating production. It is a controlled recovery export, not an automatic in-place restore: Auth must be migrated with Supabase's platform-aware procedure, Storage buckets/objects must be recreated/uploaded, and project settings must be reviewed and reapplied. The Management API configuration endpoint is Alpha and redacts Auth secrets; maintain provider credentials, SMTP secrets, signing keys and API keys separately in an approved secret manager.
