# Mauriskade rent management

The rent module runs alongside the existing water-credit service. Rent and water use separate ledgers and payment handlers. A rent payment is never passed to Hydro and never creates an STS token.

## Admin workflow

1. Open the administrator panel and select **Rent management**.
2. Create a tenancy against a registered Hydro meter. Enter the tenant, unit, unique rent account reference, amount per period, billing frequency, start date and due day.
3. The service generates rent charges through the next 18 months. The admin can edit the rent amount, frequency, due day and tenancy status later. Already allocated payments are preserved.
4. Use **Agreement** to draft or revise the tenancy agreement. Save a draft, then issue it. Issued agreements appear in the customer's rent account.
5. The shortcode uses the existing Webazi Daraja shared C2B callback registration. Do not register Mauriskade-specific callback URLs from the Mauriskade admin panel. Webazi routes `RENT-` references here and `WATER-` references into the Hydro recharge workflow. Both Render services must have the same `MAURISKADE_C2B_SECRET`; Webazi also needs `MAURISKADE_C2B_URL=https://api.water.mauriskade.co.ke/api/mpesa/shared-c2b`.
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
