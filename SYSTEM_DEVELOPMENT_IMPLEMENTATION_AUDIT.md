# Mauriskade Apartments — System Development Requirements Audit

**Source:** `System development.pdf` (client requirements brief)
**Repository:** `joab8291-glitch/mauriskade-mpesa`
**Audit date:** 28 November 2026
**Scope:** Customer portal, administrator portal, Node/Express API, PostgreSQL schema, rent/water separation, payment and tenancy workflows.

## Status key

- **✓ IMPLEMENTED** — working code and automated coverage exist for the requirement.
- **◐ PARTIALLY IMPLEMENTED** — the core workflow exists, but a stated boundary, provider configuration, policy decision or live acceptance test remains outstanding.
- **✗ NOT IMPLEMENTED** — no implementation exists.

## Final requirement checklist

| # | Client requirement | Status | Findings / remaining boundary |
|---|---|---|---|
| 1 | Register properties and units; track vacant, occupied and unavailable units. | ✓ IMPLEMENTED | Property units can be registered with or without a Hydro meter. Rent tenancies can be assigned directly to an unmetered unit, receive a separate rent-only customer username/password, and use the rent portal and M-Pesa rent ledger without a water account. Meter-linked tenancies and Hydro logins remain supported. Active tenancy uniqueness and unit occupancy are enforced by database constraints and server checks. |
| 2 | Assign tenants to units and preserve occupancy/transfer history. | ✓ IMPLEMENTED | Each tenancy is a separate lease. Transfer/renewal closes the former tenancy on the prior day, creates the new tenancy, preserves old ledger/agreement history, disables the destination meter login immediately for cross-unit transfers, retains the outgoing tenant login only until the effective end date, and keeps the login through a same-unit renewal. Deposits and rent credit require separate approval before transfer. |
| 3 | Record rent, deposit, billing cycle, due date, start/end and notice dates; store signed agreements and renewals. | ◐ PARTIALLY IMPLEMENTED | Rent, expected deposit, billing frequency, due day, dates, tenant email, agreement versions and issue workflow exist. Same-unit renewal is supported through the renewal/transfer workflow. The client must still approve formal notice periods, renewal terms and deposit custody policy. |
| 4 | Support scheduled rent changes, unit transfers and move-out. | ✓ IMPLEMENTED | Future rent changes preserve historical charges and only replace unallocated future periods. Transfer/renewal and final move-out settlement are separate workflows with history and approval controls. |
| 5 | Generate recurring rent charges with rental period and due date; support proration, opening arrears/credits, approved adjustments and duplicate prevention. | ✓ IMPLEMENTED | Monthly, quarterly, half-yearly and annual billing; final-period proration; approved opening debit/credit balances; approved adjustments/write-offs; voided-charge history; partial unique active-period index and idempotent generation. |
| 6 | Maintain a ledger of charges, payments, allocations and tenant credits. | ✓ IMPLEMENTED | Rent charges, payments, allocations, credit balances, refunds, transfers, adjustment history, reversals and receipts are separate auditable records. Water transactions remain outside the rent ledger. |
| 7 | Make payment allocation configurable, starting with oldest outstanding rent first. | ✓ IMPLEMENTED | Stored allocation policy supports oldest due first (default), oldest period first and newest due first. Existing allocations are not silently rewritten when policy changes. |
| 8 | Support M-Pesa STK, Paybill, partial/advance payments, bank transfers and authorized manual entries. | ✓ IMPLEMENTED | Existing STK and shared Paybill callbacks are preserved. Partial/advance payments, verified cash/bank entries and bank-statement CSV import are supported. Bank import is a controlled file workflow, not a direct bank API. |
| 9 | Use unique tenancy payment references and unique transaction IDs; prevent duplicate confirmation posting. | ✓ IMPLEMENTED | New references use uppercase `RENT-` format and fit Daraja's 12-character account-reference limit. Historical references are not reused; duplicate manual, bank and M-Pesa transaction codes are guarded across payment paths. |
| 10 | Reconcile wrong references/unmatched payments and review exceptions against provider/bank statements. | ✓ IMPLEMENTED | Unmatched Paybill assignment, missing-payment reports, verified reconciliation notes, bank statement import, line matching, duplicate guards and controlled posting are implemented. |
| 11 | Issue numbered downloadable receipts showing payment reference and allocation; maintain reversed receipt history and paper receipt number. | ✓ IMPLEMENTED | Numbered PDF receipts show rental-period allocations and remaining credit. Manual paper receipt numbers are stored. Approved reversals preserve the receipt and mark it reversed rather than deleting history. |
| 12 | Retain overpayments as credit; track security deposits separately; approve refunds/deductions/transfers. | ✓ IMPLEMENTED | Rent credit, rent-credit refunds/transfers, deposit receipts, deductions, deposit refunds and deposit transfers use separate ledgers. Refunds require independent approval and actual payment reference before marked paid. |
| 13 | Tenant portal: view rent, arrears, credits, due dates, statements, receipts, documents; pay and report missing payments. | ✓ IMPLEMENTED | Current tenants can view rent balances, arrears, credits, due dates, statements, receipts and agreements, pay rent and report missing payments. On final move-out, former-tenant portal access is ended completely; historical tenancy and financial records remain available to administrators only, as agreed. |
| 14 | Move-out: stop billing, calculate final rent, approve deductions, settle deposit and issue final statement; preserve former balances. | ✓ IMPLEMENTED | Final settlement previews prorated rent, releases future advance allocations into credit, calculates deposit deduction/refund, requires independent approval, records actual refund payment and provides a downloadable final statement PDF. Rejected settlements restore the original tenancy and full-period charge. |
| 15 | Dashboard: billed, current-month recovered, prior arrears recovered, cash, overdue, credits, deposits, occupancy and unmatched payments. | ✓ IMPLEMENTED | Rent dashboard and extended operations KPIs include current-period expected/collected, prior arrears recovered, cash received, arrears, deposit liability, occupancy/vacancy, unmatched payments and excess credit. |
| 16 | Arrears ageing and downloadable reports by property, unit and period. | ✓ IMPLEMENTED | Ageing buckets (0–30, 31–60, 61–90, 90+ days) support property, unit and date filters and server-generated CSV export. Monthly collections and tenant statements remain available. |
| 17 | Role-specific manager, finance and caretaker access; approvals for sensitive actions. | ✓ IMPLEMENTED | Individual manager, finance and caretaker accounts, hashed passwords, expiring sessions, first-login password change, role-scoped endpoints and maker/checker approvals are implemented. Legacy owner-key access remains for the property owner. |
| 18 | Record who changed what and when. | ✓ IMPLEMENTED | New administrative and rent-management audit events record actor ID, display name, username, role, authentication source, event timestamp, action, entity context, status and details. Audit identity/event context is written by the trusted backend and is not rewritten by application workflows; provider workflows may finalize status/detail. Public browser roles have no access to the audit table. Older legacy-key actions remain explicitly unattributed to a named individual where historical evidence does not exist. |
| 19 | Agree backup schedule, test restoration and provide data export. | ◐ PARTIALLY IMPLEMENTED | Daily PostgreSQL 17 custom-format backup of the application-owned `public` schema is AES-256-GCM encrypted and uploaded to the private Supabase Storage bucket only after a successful isolated `restore_test` restore. Configurable 90-day retention is applied. The first independent recovery drill passed on 28 November 2026 (GitHub Actions run `46142582788`): it downloaded `mauriskade-system-backup-2026-11-28.mrbk` from private Supabase Storage, decrypted it, and restored it into a fresh PostgreSQL 17 `recovery_drill` database. Verification found 35 tables, 92 indexes, 2 sequences, 35 RLS policies and all 9 key rent/payment tables. Independent off-project archive replication and recovery of Supabase-managed Auth/Storage/platform configuration remain outside this backup scope. |
| 20 | Keep water/internet payments separate from rent unless an authorized reallocation occurs. | ◐ PARTIALLY IMPLEMENTED | Water/Hydro/ST​S and rent ledgers and payment handlers remain separate; rent never issues a water token. A distinct internet/service-charge ledger and an approved cross-ledger reallocation workflow are not included. |
| 21 | Reminders 3 days before, on due date, 3/7 days overdue; live balance checks, pending holds, payment plans, channel history and staff follow-up. | ◐ PARTIALLY IMPLEMENTED | Reminder scheduler, pending-payment/dispute/payment-plan holds, SMS/WhatsApp/email webhook adapter, delivery callback history, payment plans, follow-ups and approved formal notices are implemented. No messages are sent until the client configures a provider and approved templates/recipient channels. |
| 22 | Complete the eight delivery acceptance tests in the client brief. | ◐ PARTIALLY IMPLEMENTED | 32 automated tests now cover database-backed rent workflows, schema idempotency, reversals, deposits, bank imports, proration, advance-credit release, transfer, payment plans, reminders, notices, staff, ageing, backup encryption and independent recovery-drill selection/target safeguards. Live Daraja transactions, Android-device end-to-end acceptance and production restore testing still require a controlled client test window. |

### Status totals

- **✓ IMPLEMENTED:** 17 requirements
- **◐ PARTIALLY IMPLEMENTED:** 5 requirements
- **✗ NOT IMPLEMENTED:** 0 requirements

The remaining partial items are explicit boundaries, not hidden or simulated functionality. Provider-dependent functions remain blocked until the client supplies/configures the relevant services and credentials.

## Additional work completed in this implementation pass

1. Added a multi-property/unit registry with available, occupied and unavailable status and Hydro-meter mapping.
2. Added individual manager, finance and caretaker accounts, first-login password change, session expiry and scoped permissions.
3. Added independent approval requests for deposit refunds/deductions/transfers, rent-credit refunds/transfers, payment reversals, rent adjustments, opening balances, write-offs, payment plans, final settlements and formal notices.
4. Added deposit and rent-credit refund payment completion, requiring the actual bank/cash reference and a verification note.
5. Added controlled bank statement CSV import, match-to-tenancy, verification and idempotent posting.
6. Added arrears ageing by property/unit/date with CSV export.
7. Added future rent changes, same-unit renewal/unit transfer, future-advance release and approved rent-credit/deposit transfer.
8. Added final move-out settlement, prorated final rent, released advance rent, deposit/credit settlement, downloadable PDF and rejection rollback.
9. Added payment plans, disputes, approved formal notices, reminder scheduling, delivery callback history and staff follow-up queue.
10. Replaced the table-only application snapshot scheduler with a dedicated GitHub Actions PostgreSQL 17 `pg_dump` workflow. It archives the complete application-owned `public` schema and data, encrypts with AES-256-GCM, restores into a disposable PostgreSQL 17 `restore_test` database before upload, and prunes private Storage objects after a successful restore check.
11. Added a separate quarterly/on-demand recovery-drill workflow that lists and downloads the newest dated archive from private Supabase Storage, authenticates/decrypts it, and restores it into a newly started PostgreSQL 17 `recovery_drill` database with explicit safeguards against production targets. First independent drill passed on 28 November 2026 in GitHub Actions run `46142582788`; the actual archive restore verified 35 tables, 92 indexes, 2 sequences, 35 RLS policies and 9 key rent/payment tables.
12. Added voided-charge history and a partial unique index so changing a future schedule never deletes rows referenced by payment allocations.
13. Updated admin operations UI and documentation while preserving the existing M-Pesa, water/Hydro/STS, customer login and tenant payment paths.
14. Completed actor attribution for new audit events, added entity context and immutable audit identity/event metadata, and exposed actor/role/source in the admin audit table.

## Validation performed

- `npm test`: **32 passed, 0 failed** on PR #15; the three new recovery-drill unit tests cover latest-archive selection, invalid listings and the production-target guard.
- Independent recovery drill: **passed** in GitHub Actions run [#46142582788](https://github.com/joab8291-glitch/mauriskade-mpesa/actions/runs/46142582788). The workflow downloaded the actual private Storage archive, decrypted it, and completed a restore into a fresh PostgreSQL 17 `recovery_drill` database; verification reported 35 tables, 92 indexes, 2 sequences, 35 RLS policies and 9 key tables.
- `schema.sql` executed twice against an isolated PostgreSQL-compatible database: **idempotency passed**.
- `node --check server.js`, `rent.js`, `rent-workflows.js`, `scripts/backup-database.js`, `scripts/recovery-drill.js`: passed.
- Customer/admin inline JavaScript syntax checks: passed.
- `git diff --check`: passed.
- PDF receipt and final settlement statement generation: exercised.
- No production customer data was altered during the isolated tests.

## Client configuration / controlled acceptance still required

- **Notifications:** configure `RENT_NOTIFICATION_WEBHOOK_URL`, `RENT_NOTIFICATION_WEBHOOK_SECRET`, `RENT_NOTIFICATION_CHANNELS` and provider callback handling. Confirm approved SMS/WhatsApp/email wording, sender IDs, opt-out policy and provider charges. Until configured, reminders/notices are not sent and are logged as blocked/queued/approved rather than falsely marked delivered.
- **Backups:** configure GitHub Actions repository secrets `DATABASE_URL`, `SUPABASE_URL`, `SUPABASE_SERVICE_ROLE_KEY`, and `RENT_BACKUP_ENCRYPTION_KEY` (64-character hex recommended). Render environment variables are not automatically available to GitHub Actions. The daily workflow runs at 02:00 Africa/Nairobi, performs a PostgreSQL 17 custom-format dump of the application-owned `public` schema, encrypts it, restores it into isolated `restore_test`, then uploads to the private `mauriskade-db-backups` bucket and applies 90-day retention. The quarterly/on-demand workflow downloads the latest stored archive, decrypts it and restores it into a separate fresh `recovery_drill` PostgreSQL 17 service database. Its first independent run passed on 28 November 2026 (GitHub Actions run `46142582788`). Requirement 19 remains partial only because independent off-project replication and recovery of Supabase-managed Auth/Storage/platform configuration are not covered. Supabase-managed Auth, Storage file contents and platform configuration are not included.
- **Business policy:** one-calendar-month tenant notice is configured and enforced; renewal terms, deposit holding/deduction/refund rules, opening balance migration source, and who may approve write-offs/reversals still require client approval.
- **Portfolio model:** confirm whether non-Hydro-metered rental units must be supported independently of the water meter registry.
- **Former tenant portal:** decide whether former occupants need separate archived accounts to access historical statements after a new occupant is assigned.
- **Internet/service charges:** define whether these are rent ledger charge types or a separate ledger and how any cross-ledger transfer is approved.
- **Live acceptance:** perform a scheduled live Daraja STK/Paybill test and Android app walkthrough. The independent backup recovery drill is automated (quarterly and on-demand); its first execution has passed. It restores only into an isolated CI database and does not alter production.

## Deployment and migration note

The application runs `schema.sql` during backend startup. Render is configured for automatic deployment from `main`, and Vercel deploys the admin/customer portal from the same repository. After this commit is pushed, verify both deployment records and `/health`, then perform the client-approved live acceptance checks. Do not claim SMS/WhatsApp/email delivery or remote backup success until the provider environment variables are configured and a callback/backup run is observed.
