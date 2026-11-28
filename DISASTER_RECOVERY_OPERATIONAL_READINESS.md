# Mauriskade disaster recovery operational readiness

Last reviewed: 2026-11-28

## 1. Recovery objectives

These are operating targets, not measured guarantees:

- **RPO: 24 hours maximum.** The application database, Auth, Storage and project-configuration exports currently run daily. The actual data-loss window can approach one day if a failure occurs immediately before the next successful backup.
- **RTO: 8 hours target.** This is the planning target for restoring the database, re-establishing Auth and Storage, validating the application and completing a controlled cutover. It has not yet been demonstrated by a full fresh-project rehearsal.

A full staging restore and timed application validation are required before describing either objective as achieved. If the business requires a lower RPO for rent and M-Pesa ledger data, move to a supported point-in-time recovery tier or add a separately tested higher-frequency transaction-log/backup strategy.

## 2. Existing recovery evidence

- PostgreSQL 17 custom-format public-schema backup, AES-256-GCM encryption and restore verification before upload.
- Off-site replication to private Backblaze B2 with HEAD metadata/size checks and download/SHA-256 verification.
- Independent B2 recovery drill into a fresh isolated PostgreSQL database named recovery_drill.
- Auth schema export includes auth.users table data and the other exported Auth table-data entries.
- Storage backup includes actual object bytes, bucket metadata and object manifests.
- Supabase project configuration response is archived; Auth secrets returned by that endpoint are redacted/HMAC values.
- The managed-services archive is decrypted and its Auth, Storage and configuration contents are checked by an independent drill.

The independent drills do not perform a complete new-Supabase-project restore. Auth import and configuration reapplication remain controlled, platform-aware operator actions.

## 3. Application smoke test

Run .github/workflows/mauriskade-operational-readiness.yml manually or inspect its daily run. It performs read-only checks:

1. GET https://api.mauriskade.co.ke/health.
2. GET https://api.mauriskade.co.ke/health/mpesa to confirm Daraja OAuth authentication without sending an STK request.
3. A read-only PostgreSQL query confirming the required rent/payment/audit tables exist and every public base table has RLS enabled.
4. A Backblaze bucket metadata check confirming the bucket is private and has the expected retention rule.

It does not create payments, send STK prompts, issue water tokens, mutate tenant records or modify production data.

## 4. Security review snapshot

The Supabase security advisor returned no findings on 2026-11-28. A direct catalog audit of the production project found:

- 35 public base tables; all 35 have RLS enabled.
- No RLS-enabled public table without a policy.
- No SECURITY DEFINER functions in the exposed public schema.
- No public views missing security_invoker = true.
- No direct table privileges granted to anon or authenticated in public.

The performance advisor separately reported 18 foreign-key columns without covering indexes and 10 unused indexes. These are performance notices, not security findings. Do not remove the unused indexes without workload evidence. Review the 18 missing foreign-key indexes against actual query patterns and apply in a staging rehearsal before production.

## 5. Backblaze retention and access controls

The backup bucket must remain private. The read-only audit checks the configured bucket metadata and the lifecycle rule:

- fileNamePrefix: database/
- daysFromUploadingToHiding: 90
- daysFromHidingToDeleting: 1

This means current backup objects are hidden after 90 days and hidden versions are deleted after a further day. The rule is intended to cover both database/ application backups and database/supabase-managed/ exports.

The 2026-11-28 live audit confirmed that the configured B2 bucket is private (allPrivate) and has default SSE-B2 encryption, but its lifecycleRules array is empty. Therefore the recommended 90-day rule is NOT configured. The audit workflow reports failure until the rule is present. It does not change lifecycle settings. A missing rule must be reviewed before it is applied because lifecycle deletion is destructive.

The current B2 key has read access to bucket lifecycle metadata and the backup workflows use bucket-scoped file permissions. Never grant backup jobs account-wide delete-bucket or key-management permissions. Preserve an independently stored copy of RENT_BACKUP_ENCRYPTION_KEY; the encrypted archives are unusable without it.

## 6. Full staging restoration — required before declaring recovery complete

Create a separate Supabase project in the same organization and a compatible region/Postgres major version. Do not use the production project reference or production database as a restore target.

The repository includes the manual workflow `.github/workflows/mauriskade-staging-recovery.yml`. After provisioning the staging project, add these repository Actions secrets: `STAGING_PROJECT_REF`, `STAGING_DATABASE_URL`, `STAGING_SUPABASE_URL`, and `STAGING_SUPABASE_SERVICE_ROLE_KEY`. The workflow is manual-only, rejects the production project reference/host, refuses a non-empty staging public schema or Storage bucket list, restores the public database, recreates Storage buckets and upload/download-verifies every archived object. It validates the Auth archive but deliberately does not import the managed Auth schema or reapply project configuration; those remain platform-aware operator steps.

Controlled sequence:

1. Provision a separate staging Supabase project and record its project reference, direct database connection string, API URL and server-side service-role secret in GitHub Actions secrets. Never place secrets in source control or chat.
2. Restore the latest public PostgreSQL archive to staging with pg_restore --exit-on-error --no-owner --no-acl. Verify roles, extensions, schema objects, table counts, indexes, sequences and RLS policies.
3. Restore Auth through the supported Supabase Auth migration procedure. Review platform-owned objects and version compatibility; do not blindly overwrite the managed auth schema. Verify user identities and password sign-in. Users may need to re-authenticate if signing keys differ.
4. Recreate Storage buckets/settings from the manifest and upload the archived file bytes to their original paths. Verify object counts and SHA-256/byte lengths.
5. Review the project configuration snapshot and reapply settings manually. Maintain SMTP/OAuth provider credentials, JWT signing keys, API keys and other secrets separately; the configuration export does not contain plaintext values.
6. Configure staging-only M-Pesa/Daraja and Hydro credentials. Do not point staging callbacks at production payment processing. Use sandbox credentials and controlled test accounts.
7. Run the application smoke test against staging and manually verify administrator login, tenant login, rent schedule/charge views, payment history, lease access boundaries, Storage downloads, RLS and audit attribution.
8. Verify that no staging test can create a live M-Pesa transaction or issue a real Hydro token. Record elapsed restore time and latest backup timestamp, then compare against the RTO/RPO targets.
9. Only after approval, plan a separate DNS/cutover procedure with a rollback point. Never use the staging rehearsal to overwrite production.

## 7. Secret rotation and access review

- Keep GitHub Actions secrets limited to the repository workflows that require them.
- Use a scoped Supabase Personal Access Token with read-only project configuration permissions for configuration export.
- Use a bucket-restricted B2 application key. The backup writer requires list/read/write file capabilities; the audit additionally needs bucket metadata/lifecycle read capabilities.
- Rotate provider/API keys after suspected exposure, staff departure or unauthorized access. Update GitHub secrets first, run the backup and recovery workflows, then revoke the old key.
- Keep the database encryption key in at least two separately controlled secure locations. Test recovery of that key without printing it or placing it in Git.
- Review Render environment access, GitHub repository collaborators, Supabase organization members and B2 application keys quarterly.

## 8. Outstanding gates

- Full fresh-project Supabase restore and timed end-to-end staging acceptance.
- The initial 2026-11-28 smoke check targeted the Render-generated `onrender.com` hostname even though Render service metadata shows that generated subdomain is disabled. Render startup logs identify `https://api.mauriskade.co.ke` as the primary service URL. The smoke workflow now targets that custom API hostname and is manual/scheduled only, so it does not probe production before a feature branch has been deployed. Render's service metadata still has no health-check path configured; configure `/health/ready` in the Render service settings after the route is deployed. External custom-domain endpoint verification remains pending.
- Confirmation that the B2 lifecycle rule is actually configured by the read-only audit.
- Manual staging functional tests for login, tenant boundaries, rent records, M-Pesa sandbox and Storage downloads.
- Measured RTO and RPO from a complete rehearsal.
- Decide whether the 24-hour RPO is acceptable for financial ledger operations or whether a lower RPO is required.
