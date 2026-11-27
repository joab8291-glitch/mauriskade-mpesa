# Mauriskade rent management

The rent module runs alongside the existing water-credit service. Rent and water use separate ledgers and payment handlers. A rent payment is never passed to Hydro and never creates an STS token.

## Admin workflow

1. Open the administrator panel and select **Rent management**.
2. Create a tenancy against a registered Hydro meter. Enter the tenant, unit, unique rent account reference, amount per period, billing frequency, start date and due day.
3. The service generates rent charges through the next 18 months. The admin can edit the rent amount, frequency, due day and tenancy status later. Already allocated payments are preserved.
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

Rental tables: `rent_leases`, `rent_charges`, `rent_payments`, `rent_allocations`, `tenancy_agreements`, and `rent_receipts`. All have RLS enabled, browser-role grants revoked, and restrictive deny policies for `anon` and `authenticated`. The existing trusted backend connection continues to perform all rent operations.

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

The following client-brief items still require agreed policy, credentials, or a larger workflow before they can safely be enabled: deposit accounting and refund/deduction approvals; waivers, write-offs and reversals; opening-balance migration and approved adjustments; multi-property/unit registry beyond Hydro meter-backed units; staff roles and two-person approval; scheduled SMS/WhatsApp/email reminders and delivery tracking; payment-plan and formal-notice workflows; bank-statement import; backup/restore testing; and complete move-out deposit settlement. The current shared `ADMIN_KEY` is a single administrator credential, not role-based access control.
