# Mauriskade rent management

The rent module runs alongside the existing water-credit service. Rent and water use separate ledgers and payment handlers. A rent payment is never passed to Hydro and never creates an STS token.

## Admin workflow

1. Open the administrator panel and select **Rent management**.
2. Create a tenancy against a registered Hydro meter. Enter the tenant, unit, unique rent account reference, amount per period, billing frequency, start date and due day.
3. The service generates rent charges through the next 18 months. The admin can edit rent details and schedule future rent changes. Existing allocations are preserved. An actual move-out must use final settlement; the direct tenancy editor will not bypass prorating or release prepaid rent.
4. Use **Agreement** to draft or revise the tenancy agreement. Save a draft, then issue it. Issued agreements appear in the customer's rent account.
5. The shortcode uses the existing Webazi Daraja shared C2B callback registration. Do not register Mauriskade-specific callback URLs from the Mauriskade admin panel. Webazi routes `RENT-` references here and `WATER-` references into the Hydro recharge workflow. Both Render services must have the same `MAURISKADE_C2B_SECRET`; Webazi also needs `MAURISKADE_C2B_URL=https://api.mauriskade.co.ke/api/mpesa/shared-c2b`.
6. Paybill C2B confirmations are matched using the exact rent account reference. Unknown references appear in **Unmatched Paybill payments**. Verify the M-Pesa statement, enter the correct rent account reference and reconcile.

## Payment and ledger rules

- Monthly, quarterly, half-yearly and annual billing periods are supported.
- A tenant may pay any whole-shilling amount, including a partial amount or an advance.
- Confirmed payments are allocated oldest outstanding rent first. Any amount not yet needed remains as tenant credit and is applied as future charges are generated.
- Arrears are the unpaid balance of charges whose due date has passed.
- Rent STK requests use a separate rent-payments table. Shared Paybill `RENT-` confirmations are sent to the rent ledger; `WATER-` confirmations create water transactions and initiate Hydro recharge. Rent can never trigger water-token issuance.
- For shared Paybill water payments, a 20-digit token is not shown as issued until Hydro's recharge record matches the same meter, token and amount. Ambiguous or unverified outcomes go to review and must not be blindly recharged.
- A rent receipt is created for confirmed STK and Paybill payments. The customer can download the receipt PDF from their account.
- Annual tenants are warned to verify the official Paybill and their unique rent account reference before sending funds.
- Customer logins continue to use the existing account system. Create or disable a tenant login in **Meter registry** after the rent account reference has been assigned.

## Database and security

Rental and operations tables include `rent_leases`, `rent_charges`, `rent_payments`, `rent_allocations`, `tenancy_agreements`, `rent_receipts`, `rent_payment_reports`, `properties`, `property_units`, `rent_approvals`, `rent_deposit_transactions`, `rent_credit_refunds`, `rent_credit_transfers`, `rent_allocation_adjustments`, `rent_scheduled_changes`, `rent_settlements`, `rent_bank_imports`, `rent_bank_statement_lines`, `rent_reminder_jobs`, `rent_followup_tasks`, `rent_payment_plans`, `rent_payment_plan_installments`, `rent_disputes`, `rent_communication_log`, `rent_formal_notices`, `rent_backup_runs` and `rent_backup_tests`. Application-owned tables have RLS enabled, browser-role grants revoked and restrictive deny policies for `anon` and `authenticated`. The trusted backend connection performs rent operations.

No water transactions, Hydro meter records, customer passwords, or existing audit records are removed or rewritten by the rent module.


## Dashboard, occupancy and reports

- Rent dashboard KPIs are calculated from rent charges, confirmed rent payments, arrears and current meter/tenancy assignments for the selected date range.
- The default report period is the current calendar month. Administrators can choose another date range.
- Occupancy is measured against registered meter units: active leases with no end date or an end date on/after today are occupied; the remaining registered meters are vacant.
- Tenancy creation and editing support an optional end date. Expired tenancies stop receiving new generated charges, cannot initiate rent STK payments, and do not match new incoming Paybill confirmations.
- Monthly collection reports show expected charges and confirmed collections by month.
- Arrears exports list overdue unpaid charges by tenant and unit.
- Tenant statement CSVs include opening balance, dated rent charges, confirmed payments, M-Pesa receipt references, allocations and running/closing balance.
- Payment reconciliation detail distinguishes unmatched payments, partial allocations and customer credit not yet applied. CSV exports are generated server-side and require the admin key.
- Reports do not fabricate records: a new installation with no lease/payment records will correctly show zero financial activity and all registered units vacant.


## Client brief additions (November 2026)

- New rent account references use the `RENT-` prefix, are uppercase and no longer than 12 characters for Daraja STK compatibility; references are not reused across former tenancies. Creating a new tenancy on a previously leased meter disables the prior meter login and revokes its active sessions; issue/reset credentials for the incoming tenancy before portal access. This also prevents stale sessions from exposing the former tenant ledger.
- Billing schedules are generated idempotently with a unique tenancy/period key. A partial final period is prorated when it is generated or when an unallocated final charge is shortened at move-out.
- The payment allocation policy is stored centrally. The default is oldest due rent first; administrators can select oldest period first or newest due rent first.
- Staff can record a verified cash/bank payment with a unique external reference and verification note. Repeating the same request for the same tenancy and amount is idempotent; a reused reference for another payment is rejected.
- Tenants can view a running rent statement and submit a missing-payment report using an M-Pesa transaction code. Reports enter an admin review queue and are never auto-posted. A matching Paybill confirmation or verified manual payment resolves the report. A transaction-code collision between manual and Paybill records is held in the admin audit log instead of double-posting.
- Rent receipts show allocations to rental periods and any remaining unallocated credit. Payment polling and receipt downloads are scoped to the latest tenancy on the signed-in meter.

## Expanded operations, controls and remaining configuration

The administrator's **Deposits, approvals & operations** page provides:

- Property and unit registration, meter mapping, occupancy and unavailable status.
- Verified deposit receipts, deposit liability and available deposit balance.
- Independent approval queue for deposit refunds/deductions/transfers, rent-credit refunds/transfers, payment reversals, rent adjustments, opening balances, write-offs, payment plans, final settlements and formal notices.
- Bank statement CSV staging, line-to-tenancy matching, verification and controlled posting.
- Arrears ageing by property, unit and date, with CSV download.
- Future rent changes, tenancy renewal/unit transfer, advance-rent release and final move-out settlement.
- Payment plans, disputes, reminder queue, communication history and staff follow-up tasks.
- Owner-only individual staff account management and encrypted backup export/verification.

### Deposit and credit handling

Security deposits are recorded in `rent_deposit_transactions` and never included in rent collections. Deposit refunds are reserved after independent approval and are only marked paid when the actual bank/cash reference and verification note are entered. Rent credit is tracked separately; approved credit refunds and transfers reduce the source tenancy balance. A transfer creates a corresponding credit on the destination tenancy only after independent approval.

### Move-out and renewal

Use **Prepare final settlement** for an actual move-out. It calculates the final rental period, releases any future allocated rent into tenant credit, calculates deposit deductions/refunds and any rent-credit refund, and requests independent approval. An approved settlement stops billing and produces a downloadable final statement PDF. A rejected request restores the previous tenancy dates and full-period rent charge. Use **Renew tenancy or transfer to another unit** for a new lease record; former lease, receipts, agreements and ledger history remain preserved. For a cross-unit transfer, the destination meter’s previous login is disabled immediately and fresh credentials must be issued for the incoming tenancy. The outgoing tenant retains access only until the effective move-out date; the scheduled worker then revokes that session unless the same meter has a new active tenancy. For a same-unit renewal, the existing tenant login remains active and switches to the new lease on its start date.

### Staff roles

- **Manager:** tenancy/unit operations, approvals and operational controls.
- **Finance:** payments, reconciliation, bank import, reports, refund completion and approval decisions.
- **Caretaker:** read-only occupancy and tenancy details.
- **Property owner:** legacy owner key and staff account administration.

Sensitive actions use maker/checker approval; the requester cannot approve their own request. Older events recorded under the legacy shared owner key cannot be retrospectively attributed to an individual staff member.

### Notification and backup configuration

Set these environment variables on the backend only when the client has selected providers and approved the associated costs/policies:

- `RENT_NOTIFICATION_WEBHOOK_URL`
- `RENT_NOTIFICATION_WEBHOOK_SECRET`
- `RENT_NOTIFICATION_CHANNELS` (`sms`, `whatsapp`, `email`)
- `RENT_BACKUP_WEBHOOK_URL`
- `RENT_BACKUP_WEBHOOK_SECRET`
- `RENT_BACKUP_ENCRYPTION_KEY` (separate 32+ character secret)
- `RENT_BACKUP_HOUR` (default `2`, East Africa time)

The notification adapter expects the provider to return a message ID and call `/api/rent/notifications/delivery` with the configured secret header. Without a provider URL, the system records a blocked configuration state; it does not claim that reminders were sent. The backup adapter sends an encrypted archive to the configured durable remote endpoint. Admin backup verification restores the archive into temporary staging tables and checks table/row counts; it does not overwrite production data and is not a substitute for a separately approved full restore drill.

### Known boundaries

- Rent tenancies still require Hydro meter-backed customer login identities. Property/unit registry supports non-metered unit records, but independent non-metered tenant accounts are not yet supported.
- Former tenant history is preserved for authorized administrators; former tenants do not keep a separate archived portal login after the meter login is revoked for a new occupant.
- Internet/service charges and authorized cross-ledger transfers are not included; rent and water/Hydro remain strictly separate.
- Live Daraja transactions, Android-device end-to-end acceptance and production database restore were not performed in the isolated code tests. Complete those during the client's controlled acceptance window.
