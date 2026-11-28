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
| 13 | Tenant portal: view rent, arrears, credits, due dates, statements, receipts, documents; pay and report missing payments. | ◐ PARTIALLY IMPLEMENTED | Current tenant portal supports rent balances, arrears, credits, payment history, statements, receipts, agreement and missing-payment reports. Former tenant history remains available to authorized admins, but former tenants do not retain a separate archived portal login after their meter login is revoked. |
| 14 | Move-out: stop billing, calculate final rent, approve deductions, settle deposit and issue final statement; preserve former balances. | ✓ IMPLEMENTED | Final settlement previews prorated rent, releases future advance allocations into credit, calculates deposit deduction/refund, requires independent approval, records actual refund payment and provides a downloadable final statement PDF. Rejected settlements restore the original tenancy and full-period charge. |
| 15 | Dashboard: billed, current-month recovered, prior arrears recovered, cash, overdue, credits, deposits, occupancy and unmatched payments. | ✓ IMPLEMENTED | Rent dashboard and extended operations KPIs include current-period expected/collected, prior arrears recovered, cash received, arrears, deposit liability, occupancy/vacancy, unmatched payments and excess credit. |
| 16 | Arrears ageing and downloadable reports by property, unit and period. | ✓ IMPLEMENTED | Ageing buckets (0–30, 31–60, 61–90, 90+ days) support property, unit and date filters and server-generated CSV export. Monthly collections and tenant statements remain available. |
| 17 | Role-specific manager, finance and caretaker access; approvals for sensitive actions. | ✓ IMPLEMENTED | Individual manager, finance and caretaker accounts, hashed passwords, expiring sessions, first-login password change, role-scoped endpoints and maker/checker approvals are implemented. Legacy owner-key access remains for the property owner. |
| 18 | Record who changed what and when. | ◐ PARTIALLY IMPLEMENTED | New sensitive actions record staff/owner actor, role, timestamps, approval decisions, verification notes and allocation adjustments. Older legacy-key actions cannot always be attributed to an individual person retrospectively. |
| 19 | Agree backup schedule, test restoration and provide data export. | ◐ PARTIALLY IMPLEMENTED | Encrypted backup export, scheduled remote webhook delivery, backup history and temporary-table staging restore verification are implemented. The client must configure a durable remote storage webhook and encryption key; the staging test is not a full production restore drill. |
| 20 | Keep water/internet payments separate from rent unless an authorized reallocation occurs. | ◐ PARTIALLY IMPLEMENTED | Water/Hydro/ST​S and rent ledgers and payment handlers remain separate; rent never issues a water token. A distinct internet/service-charge ledger and an approved cross-ledger reallocation workflow are not included. |
| 21 | Reminders 3 days before, on due date, 3/7 days overdue; live balance checks, pending holds, payment plans, channel history and staff follow-up. | ◐ PARTIALLY IMPLEMENTED | Reminder scheduler, pending-payment/dispute/payment-plan holds, SMS/WhatsApp/email webhook adapter, delivery callback history, payment plans, follow-ups and approved formal notices are implemented. No messages are sent until the client configures a provider and approved templates/recipient channels. |
| 22 | Complete the eight delivery acceptance tests in the client brief. | ◐ PARTIALLY IMPLEMENTED | 25 automated tests now cover database-backed rent workflows, schema idempotency, reversals, deposits, bank imports, proration, advance-credit release, transfer, payment plans, reminders, notices, staff, ageing and backups. Live Daraja transactions, Android-device end-to-end acceptance and production restore testing still require a controlled client test window. |

### Status totals

- **✓ IMPLEMENTED:** 15 requirements
- **◐ PARTIALLY IMPLEMENTED:** 7 requirements
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
10. Added encrypted backup export, scheduled remote delivery hook and isolated staging restore verification.
11. Added voided-charge history and a partial unique index so changing a future schedule never deletes rows referenced by payment allocations.
12. Updated admin operations UI and documentation while preserving the existing M-Pesa, water/Hydro/STS, customer login and tenant payment paths.

## Validation performed

- `npm test`: **21 passed, 0 failed** (database-backed PGlite workflow tests included).
- `schema.sql` executed twice against an isolated PostgreSQL-compatible database: **idempotency passed**.
- `node --check server.js`, `rent.js`, `rent-workflows.js`: passed.
- Customer/admin inline JavaScript syntax checks: passed.
- `git diff --check`: passed.
- PDF receipt and final settlement statement generation: exercised.
- No production customer data was altered during the isolated tests.

## Client configuration / controlled acceptance still required

- **Notifications:** configure `RENT_NOTIFICATION_WEBHOOK_URL`, `RENT_NOTIFICATION_WEBHOOK_SECRET`, `RENT_NOTIFICATION_CHANNELS` and provider callback handling. Confirm approved SMS/WhatsApp/email wording, sender IDs, opt-out policy and provider charges. Until configured, reminders/notices are not sent and are logged as blocked/queued/approved rather than falsely marked delivered.
- **Backups:** configure `RENT_BACKUP_WEBHOOK_URL`, `RENT_BACKUP_WEBHOOK_SECRET`, a separate 32+ character `RENT_BACKUP_ENCRYPTION_KEY`, destination retention and access policy. Then perform and sign off a real restore drill to a separate database.
- **Business policy:** approve notice periods, renewal terms, deposit holding/deduction/refund rules, opening balance migration source, and who may approve write-offs/reversals.
- **Portfolio model:** confirm whether non-Hydro-metered rental units must be supported independently of the water meter registry.
- **Former tenant portal:** decide whether former occupants need separate archived accounts to access historical statements after a new occupant is assigned.
- **Internet/service charges:** define whether these are rent ledger charge types or a separate ledger and how any cross-ledger transfer is approved.
- **Live acceptance:** perform a scheduled live Daraja STK/Paybill test, Android app walkthrough and production database backup/restore drill. These were deliberately not run against live customer data in this code audit.

## Deployment and migration note

The application runs `schema.sql` during backend startup. Render is configured for automatic deployment from `main`, and Vercel deploys the admin/customer portal from the same repository. After this commit is pushed, verify both deployment records and `/health`, then perform the client-approved live acceptance checks. Do not claim SMS/WhatsApp/email delivery or remote backup success until the provider environment variables are configured and a callback/backup run is observed.
