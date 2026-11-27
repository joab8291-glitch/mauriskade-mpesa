# Mauriskade Apartments — System Development Requirements Audit

**Source:** `System development.pdf` (3 pages, client brief)  
**Repository:** `joab8291-glitch/mauriskade-mpesa`  
**Audit date:** 28 November 2026  
**Scope:** Existing customer portal, admin portal, Node/Express API, PostgreSQL schema and rent ledger. The original PDF is intentionally left unchanged; this companion checklist records the implementation review.

## Status key

- **✓ IMPLEMENTED** — present in the application and supported by code/tests reviewed in this audit.
- **◐ PARTIALLY IMPLEMENTED** — some of the requested workflow exists, but one or more material requirements remain incomplete.
- **✗ NOT IMPLEMENTED** — no working implementation was found.

## Requirement-by-requirement checklist

| # | Client requirement | Status | Findings / evidence |
|---|---|---|---|
| 1 | Register properties and units; track vacant, occupied and unavailable units. | ◐ PARTIALLY IMPLEMENTED | Hydro meters are used as the unit registry; rent leases are attached to meter-backed units. Occupancy/vacancy is derived from active tenancies. There is no first-class multi-property registry or an independent `unavailable` unit state. |
| 2 | Assign tenants to units and preserve occupancy/transfer history. | ✓ IMPLEMENTED | Each tenancy is a separate `rent_leases` record; closed tenancy identity is locked and a new occupant receives a new lease. A new tenancy on a previously leased meter disables the old meter login and revokes its sessions to prevent stale access. |
| 3 | Record rent, deposit, billing cycle, due date, start/end and notice dates; store signed agreements and renewals. | ◐ PARTIALLY IMPLEMENTED | Rent amount, billing frequency, due day, start/end dates and agreement file/version/issue workflow exist. Security deposits, notice dates, formal renewal workflow and scheduled rent changes are not modelled. |
| 4 | Support scheduled rent changes, unit transfers and move-out. | ◐ PARTIALLY IMPLEMENTED | Tenancy/rent fields can be edited while open; former tenant and room history is preserved; a new tenancy can be created for an incoming occupant. There is no dedicated unit-transfer workflow or future-dated rent-change schedule. |
| 5 | Generate recurring rent charges with rental period and due date; support proration, opening arrears/credits, approved adjustments and duplicate prevention. | ◐ PARTIALLY IMPLEMENTED | The scheduler generates charges across the supported billing frequencies, with a unique `(lease_id, period_start)` key. Partial final periods are prorated; end-dated tenancies have later unallocated charges removed/adjusted. Opening-balance migration and an approved adjustment workflow are absent. |
| 6 | Maintain a ledger of charges, payments, allocations and tenant credits. | ◐ PARTIALLY IMPLEMENTED | Rent charges, payment records, allocations and unallocated credit are persisted separately from water transactions. Refunds, waivers, write-offs and payment reversals are not represented as controlled ledger events. |
| 7 | Make payment allocation configurable, starting with oldest outstanding rent first. | ✓ IMPLEMENTED | Allocation policy is stored in `rent_settings`. Default is `oldest_due_first`; admin can select oldest-period-first or newest-due-first. A changed rule affects future allocation runs; it does not silently rewrite past allocations. |
| 8 | Support M-Pesa STK, Paybill, partial/advance payments, bank transfers and authorized manual entries. | ◐ PARTIALLY IMPLEMENTED | Existing STK and shared Paybill callbacks are retained; partial/advance payments are allocated and excess remains as credit. Admin can record verified cash/bank payments with a unique external reference and verification note. There is no direct bank API or statement import. |
| 9 | Use unique tenancy payment references and unique transaction IDs; prevent duplicate confirmation posting. | ✓ IMPLEMENTED | New rent account references use the uppercase `RENT-` prefix, are not reused across tenancy history and are limited to 12 characters to avoid silent STK truncation. M-Pesa receipt and checkout IDs are unique; manual external references have a unique index; duplicate C2B receipts are ignored. |
| 10 | Reconcile wrong references/unmatched payments and review exceptions against provider/bank statements. | ◐ PARTIALLY IMPLEMENTED | Unmatched Paybill items can be assigned to a tenancy; reconciliation now requires a staff verification note. Historical tenancy references can be reconciled. Tenant-reported missing payments enter a review queue and matching Paybill receipts resolve the case. No bank-statement import or formal reversal workflow exists. |
| 11 | Issue numbered downloadable receipts showing payment reference and allocation; maintain reversed receipt history and paper receipt number. | ◐ PARTIALLY IMPLEMENTED | Confirmed payments receive unique downloadable PDF receipts. Receipts now show allocation by rental period and remaining credit; statement rows show a running balance. Reversed receipt states and printed-book receipt references are not implemented. |
| 12 | Retain overpayments as credit; track security deposits separately; approve refunds/deductions/transfers. | ◐ PARTIALLY IMPLEMENTED | Excess rent remains as tenant credit and can be applied to future due charges. There is no separate deposit ledger or two-person approval process for refunds, deductions or transfers. |
| 13 | Tenant portal: view rent, arrears, credits, due dates, statements, receipts, documents; pay and report missing payments. | ◐ PARTIALLY IMPLEMENTED | Portal exposes the latest tenancy, charges, arrears, credit, payment history, issued agreement, running statement and a missing-payment report form. Payment reports are not auto-posted. Tenant access is tied to a meter login; when a new tenancy is assigned, the previous login is disabled and fresh credentials must be issued. Independent former-tenant portal accounts are not implemented. |
| 14 | Move-out: stop billing, calculate final rent, approve deductions, settle deposit and issue final statement; preserve former balances. | ◐ PARTIALLY IMPLEMENTED | Effective end dates stop later charge generation and remove later unallocated scheduled charges; an unallocated final period can be prorated. Historical charges/payments remain available to admin and former account references can receive follow-up payments. Deposit settlement, approved deductions and a formal final-settlement workflow are absent. |
| 15 | Dashboard: billed, current-month recovered, prior arrears recovered, cash, overdue, credits, deposits, occupancy and unmatched payments. | ◐ PARTIALLY IMPLEMENTED | Existing rent dashboard reports expected/collected/outstanding/overdue, occupancy/vacancy, unmatched payments, partial allocations and excess credit. It does not separately report prior-arrears recovery or deposits. |
| 16 | Arrears ageing and downloadable reports by property, unit and period. | ◐ PARTIALLY IMPLEMENTED | Monthly collections, arrears CSV and tenant statement CSV exist. Arrears totals in the tenant portal now aggregate all historical charges rather than only the 36 displayed rows. Ageing buckets and property/unit report filters are missing. |
| 17 | Role-specific manager, finance and caretaker access; approvals for sensitive actions. | ✗ NOT IMPLEMENTED | Admin API is protected by one shared `ADMIN_KEY`. There are no distinct staff identities, role permissions, maker/checker approvals or separate finance/caretaker scopes. |
| 18 | Record who changed what and when. | ◐ PARTIALLY IMPLEMENTED | Sensitive rent actions are recorded in `admin_actions` with action details and timestamps; manual entries and reconciliation require notes. The shared admin key does not identify the actual staff member, and before/after field snapshots are not consistently recorded. |
| 19 | Agree backup schedule, test restoration and provide data export. | ◐ PARTIALLY IMPLEMENTED | CSV exports are available for selected rent reports. No application-controlled backup schedule or documented restore test was found; database-provider backup settings were not verified in this repository audit. |
| 20 | Keep water/internet payments separate from rent unless an authorized reallocation occurs. | ◐ PARTIALLY IMPLEMENTED | Water token transactions and rent ledgers are separate; rent payments do not issue STS tokens. Internet/service-charge categories and an authorized cross-ledger reallocation workflow are absent. |
| 21 | Reminders 3 days before, on due date, 3/7 days overdue; live balance checks, pending holds, payment plans, channel history and staff follow-up. | ✗ NOT IMPLEMENTED | No scheduled reminder worker, SMS/WhatsApp/email provider integration, delivery-status history, failed-message queue, payment-plan follow-up or staff-reviewed formal notice workflow was found. These must not be simulated as if sent. |
| 22 | Complete the eight delivery acceptance tests in the client brief. | ◐ PARTIALLY IMPLEMENTED | Seven automated unit tests pass and an isolated PostgreSQL-compatible schema/route exercise was run. The full eight business acceptance scenarios have not been executed against the live customer database, live Daraja callbacks, real devices or a reminder provider. |

## Work completed in this audit

1. Added a persistent, configurable rent allocation rule with **oldest due rent first** as the default.
2. Added final-period proration when a rent charge is generated for a tenancy ending mid-period, and improved move-out handling for later unallocated charges.
3. Added verified manual cash/bank payment entry with a unique external reference, verification note, allocation and downloadable receipt. A retry for the same tenancy/reference/amount is idempotent.
4. Added a tenant missing-payment report using the M-Pesa transaction code, with an admin review queue. It never credits the tenant automatically; a matching Paybill confirmation can resolve the report.
5. Added a tenant running rent statement and allocation detail on PDF receipts.
6. Corrected the tenant portal arrears total so it is not limited to the latest 36 displayed charges.
7. Tightened tenant data isolation: payment polling and receipt downloads are scoped to the latest tenancy on the meter; a new tenancy revokes prior meter sessions and requires fresh credentials.
8. Prevented rent account reference reuse across tenancy history and enforced the 12-character Daraja STK account-reference limit for new/edited references.
9. Required a written verification note when staff reconcile an unmatched Paybill payment, and allowed former tenancy references to be reconciled for follow-up.
10. Added this checklist and updated rent-management documentation without modifying the client's original PDF.

## Validation performed

- `npm test`: **5 passed, 0 failed**.
- `node --check server.js` and `node --check rent.js`: passed.
- Extracted customer and admin inline JavaScript and ran `node --check`: passed.
- Executed the full `schema.sql` against an isolated PGlite PostgreSQL-compatible database: passed.
- Exercised the manual payment, allocation/receipt, missing-payment report and allocation-setting routes against an isolated database: passed.
- Generated and parsed a sample PDF receipt: one valid PDF page.

**Not performed:** live production database migration, live M-Pesa/STK/Paybill transaction, Android device end-to-end test, actual bank statement import, scheduled reminder delivery, deposit settlement, refund/reversal approvals or production backup restoration. These require controlled access, business policy and/or external provider setup.

## Items requiring client decisions / configuration before completion

- Deposit amount policy, custody/holding treatment, deductions, refund rules and approval authority.
- Opening arrears/credits migration source and sign-off procedure.
- Whether rent adjustments, waivers, write-offs and reversals require one or two approvers; define reversal evidence and receipt status.
- Property, unit and unavailable-unit model if the portfolio extends beyond Hydro-meter-backed units.
- Staff identities and roles; replace the shared admin key with individual accounts and permission scopes before multi-staff use.
- SMS, WhatsApp and email providers, approved message templates, sender identity, delivery callbacks and reminder schedule.
- Bank statement format/provider and reconciliation policy.
- Backup owner, frequency, retention, recovery point/time objectives and restoration-test approval.
- Whether former tenants need separate portal logins to view their closed tenancy after a new occupant is assigned.

## Deployment note

The changes are prepared in the repository working copy. They should be merged/deployed only after the final review and the production database migration window is approved. The live database and live Daraja credentials were not used for this audit. Do not treat the unimplemented items above as delivered functionality.
