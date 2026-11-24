# Mauriskade M-Pesa Water Credit

Customer water-credit portal and M-Pesa STK Push integration for Mauriskade Apartments (Hydro IoT company ID **10185**).

## Deployment architecture

- **Frontend:** Vercel serves `index.html` and `admin.html`.
- **Backend:** Render runs `server.js` as an Express web service.
- **Database:** Render PostgreSQL stores meter mappings, customer login hashes, sessions and payment transactions.
- **Integrations:** The backend alone calls Safaricom Daraja and the Hydro STS API. Never put Hydro or Daraja credentials in browser code.

For browser requests to remain same-origin (and keep the customer session cookie working), configure Vercel rewrites after the Render service URL is known:

```json
{
  "rewrites": [
    { "source": "/api/:path*", "destination": "https://YOUR-RENDER-SERVICE.onrender.com/api/:path*" },
    { "source": "/admin", "destination": "/admin.html" }
  ]
}
```

Replace the Render hostname with the actual service URL. Keep the frontend API calls relative (`/api/...`); do not add a browser-side secret or expose the Hydro token.

## Run locally

```bash
npm install
cp .env.example .env
# Fill in every required value in .env
npm start
```

Open `http://localhost:3000/` for the customer portal and `http://localhost:3000/admin` for the admin dashboard. The server creates/updates the PostgreSQL schema from `schema.sql` on startup.

## Required backend environment variables

- `DATABASE_URL` — PostgreSQL connection string.
- `HYDRO_BASE_URL` — Hydro API base URL, normally `http://8.217.30.113:8027/api1`.
- `HYDRO_TOKEN` — server-side permanent API token scoped by the provider to Mauriskade where possible.
- `HYDRO_COMPANY_ID` — `10185`.
- `MPESA_ENV` — `sandbox` for testing, `production` only after Daraja Go-Live.
- `MPESA_CONSUMER_KEY`, `MPESA_CONSUMER_SECRET`, `MPESA_SHORTCODE`, `MPESA_PASSKEY`.
- `CALLBACK_BASE_URL` — public HTTPS backend URL used to construct the Safaricom callback URL.
- `CALLBACK_SECRET` — long random secret in the callback path.
- `ADMIN_KEY` — at least 20 characters; required to use the admin API/dashboard.

Optional settings: `PORT`, `BUSINESS_NAME`, `PRICE_PER_M3` (default 120 KSh), `MIN_AMOUNT` (default 10), `MAX_AMOUNT` (default 20000), `MPESA_TXN_TYPE`, `SESSION_DAYS`, `CONTACT_EMAIL` and `CONTACT_PHONE`.

## Legal pages

`privacy.html`, `terms.html` and `copyright.html` are static pages served by Vercel at `/privacy`, `/terms` and `/copyright` (routes are in `vercel.json`). They share `legal.css` and `legal.js`, and the customer portal links to them from its footer, the sign-in form and the payment form.

Set `CONTACT_EMAIL` and `CONTACT_PHONE` on the backend so the pages show who residents should contact. Without them the pages say "the Mauriskade Apartments management office".

These pages describe what the system actually stores and does. If you change that (add SMS, analytics, a new payment method, a refund process or a data-retention job), update the text and the "Last updated" date. Have a Kenyan lawyer review them before relying on them.

Do not commit `.env`, real API tokens, Daraja keys, passkeys, callback secrets, admin keys, or database credentials. If a real secret was previously shared or committed, revoke/rotate it.

## Customer flow

1. The customer signs in with their meter number and the password allocated by the admin.
2. The backend verifies the account and meter association.
3. The customer enters an amount and Safaricom number; the backend sends an STK Push.
4. Safaricom calls `POST /api/mpesa/callback/:secret`.
5. After confirmed payment, the backend calls Hydro `POST /api/recharge/sts/amountRecharge` with `meterNumber` and `rechargeAmount`.
6. The 20-digit token is displayed to the customer. The credited water volume is read back from Hydro recharge records when available.

## Admin dashboard

Open `/admin` on the Vercel site. Enter the `ADMIN_KEY` configured on Render; the page keeps it in memory only and does not save it in local storage or the URL.

The dashboard can:
- Sync Mauriskade meters from Hydro company 10185.
- Search meters and filter those without customer logins.
- Add flat, tenant and phone details.
- Create customer logins, reset passwords, and disable/enable accounts.
- Review transactions that need manual reconciliation.

Generated passwords are shown once when created or reset. Give them to tenants securely; they must change the initial password at first sign-in.

## Backend API

| Method | Path | Purpose |
|---|---|---|
| GET | `/health` | Render health check |
| GET | `/api/config` | Public business name, price and amount limits |
| GET | `/api/quote?amount=100` | Estimate water volume at the configured rate |
| POST | `/api/auth/login` | Customer sign-in |
| POST | `/api/auth/logout` | End customer session |
| POST | `/api/auth/change-password` | Change initial/current password |
| GET | `/api/me` | Current customer profile |
| GET | `/api/me/transactions` | Customer's recent top-ups |
| POST | `/api/pay` | Start STK Push for the signed-in customer's meter |
| GET | `/api/pay/:id` | Read payment state and token when ready |
| POST | `/api/mpesa/callback/:secret` | Safaricom callback |
| GET/POST | `/api/admin/*` | Admin operations; requires `x-admin-key` |

Customer sessions use an HttpOnly cookie. The Vercel rewrite is intentional: it makes browser API calls same-origin instead of relying on cross-site cookies between Vercel and Render.

## Hydro STS API integration

Based on **STS API Document V1.1 (29 July 2026)**. The document covers non-remote STS meters with `deviceType = 26`.

| Purpose | Hydro endpoint |
|---|---|
| Query meters | `POST /stsMeter/queryPage` |
| Meter detail | `GET /stsMeter/code/{meterCode}` |
| Recharge by amount | `POST /api/recharge/sts/amountRecharge` |
| Recharge records | `POST /business/recharge/stsRecord/queryPage` |
| Recharge record detail | `GET /business/recharge/stsRecord/detail/{id}` |

For non-remote STS meters, `meterNumber` in recharge/debug requests is the same value as `meterCode` in meter archive queries. The amount recharge API calculates water volume using the meter's pricing strategy and returns the 20-digit token. Hydro fixes the payment method to `CUSTOMER_API`.

The current application uses the amount recharge endpoint because M-Pesa collects a KSh amount. The screen estimate uses `PRICE_PER_M3`; the actual credited volume is read from Hydro records.

## Payment safety

- The backend checks meter ownership against company 10185 before starting a payment.
- A second pending prompt for the same meter is blocked.
- Callback processing is idempotent and checks the paid amount against the requested amount.
- Hydro's duplicate pending recharge response is retried with backoff.
- A timeout or ambiguous token-issuance result is moved to `NEEDS_REVIEW`; the worker does not blindly issue a second token.
- The admin must check Hydro recharge records before adopting a token or retrying.

## Before production

1. Confirm the Hydro token is current, reissued if previously exposed, and appropriately scoped by the provider.
2. Confirm the Paybill/Till details and Daraja Go-Live status with Mauriskade.
3. Set `MPESA_ENV=production` only after successful sandbox tests and approval.
4. Confirm the callback URL is public HTTPS and reachable by Safaricom.
5. Test with one client-approved meter and a small agreed amount.
6. Agree who handles reconciliation, refunds and customer support for paid-but-unissued cases.

## Known limitations

- Token display is in the customer portal; SMS delivery is not implemented.
- A transaction UUID is treated as a private reference. Do not share transaction URLs publicly.
- Render's free PostgreSQL plan is temporary and expires; use a persistent database plan for production records.
