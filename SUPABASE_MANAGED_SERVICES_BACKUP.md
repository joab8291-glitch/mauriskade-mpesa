# Supabase managed-services backup and recovery

This supplements the application-owned `public` PostgreSQL archive. It runs daily at 02:30 Africa/Nairobi and writes a separate encrypted artifact to the private Backblaze B2 bucket under `database/supabase-managed/`.

## Included in the encrypted artifact

- **Auth schema:** a PostgreSQL custom-format dump of `auth`, including `auth.users` and its user records/password hashes. The manifest records which Auth tables' data was included by `pg_dump`; the workflow refuses to publish an archive unless `auth.users` data is present. Auth data is highly sensitive and is encrypted with the same AES-256-GCM key as the main database backup.
- **Storage objects:** downloads every object in every bucket using the Storage API, recursively traversing folders and paginating listings. The artifact includes actual file bytes, per-object manifests and bucket metadata/settings returned by the API. Empty buckets are recorded too.
- **Project configuration:** GET `/v2/projects/{ref}/config` from the Supabase Management API, preserving the effective database, pooler, Auth, Data API, Realtime and Storage configuration. Supabase returns Auth secrets as HMAC values, not plaintext credentials; this is a configuration record, not a credential escrow.

The tar archive is encrypted before upload. The workflow checks the B2 object size and SHA-256 metadata, downloads it again, and compares SHA-256. B2 archive discovery uses the Backblaze Native API v4 (avoiding the S3 ListObjects signature issue seen in the previous recovery workflow); S3-compatible transfers are retained for object upload/download. Temporary files are deleted when the job exits.

## Required additional GitHub secret

Create a **scoped Supabase Personal Access Token** at https://supabase.com/dashboard/account/tokens and add it to repository Actions secrets as:

- `SUPABASE_ACCESS_TOKEN`: scoped token with read access to this project and the following permissions required by the project-config endpoint: `database_config_read`, `database_read`, `database_ssl_config_read`, `database_network_restrictions_read`, `auth_config_read`, `data_api_config_read`, `realtime_config_read`, and `storage_config_read`. Do not use a broad classic token if a scoped token is available.

The project reference is `glqwedodptzgjvmbbceh` and is configured in the workflow, not as a secret. All existing `DATABASE_URL`, `SUPABASE_URL`, `SUPABASE_SERVICE_ROLE_KEY`, `RENT_BACKUP_ENCRYPTION_KEY`, and B2 secrets remain required.

## Recovery drill and restoration

The quarterly workflow downloads the newest managed-services artifact from B2, authenticates/decrypts it, validates the archive, checks that the Auth archive contains `auth.users`, checks every Storage file against its manifest and byte count, and verifies the configuration JSON. It never writes to production.

For a full project recovery:
1. Provision a new Supabase project running a compatible Postgres/Auth/Storage version.
2. Restore the application database using the existing `public` database recovery procedure.
3. Restore Auth using Supabase's supported Auth migration procedure from the Auth schema dump. Review version compatibility and platform-owned objects before importing; do not blindly overwrite the target project's managed Auth schema. Users may need to sign in again if signing keys differ.
4. Recreate bucket definitions/settings from `storage-buckets.json` and upload the corresponding files from `storage/` using the Storage API or S3-compatible tooling. Preserve original object paths and verify byte counts.
5. Reapply project configuration manually through the Supabase Dashboard/Management API after review. The config export endpoint is currently Alpha and redacts Auth secrets; OAuth provider secrets, SMTP credentials, JWT/signing keys, API keys and other secrets must be maintained separately in an approved password manager/secret store and rotated as necessary.
6. Validate login, user identities, file downloads, RLS, API access, realtime and application smoke tests before DNS or production cutover.

This is a recoverability export plus isolated integrity drill, not an automatic in-place restore of Supabase-managed control-plane services. The drill verifies that the Auth dump, Storage objects and configuration artifact are recoverable; the actual new-project restore remains a controlled operator procedure.
