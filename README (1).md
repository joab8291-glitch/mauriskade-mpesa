# hydro-pay

M-Pesa payment to STS water token, for Mauriskade Apartments (Hydro IoT company 10185).

A customer opens the page, checks a meter, pays by M-Pesa STK Push, and the 20-digit token from the
Hydro API appears on the same page.

## Run

```bash
npm install
cp .env.example .env     # fill in every value
node server.js           # also creates the table from schema.sql
```

Open `http://localhost:3000/`. For real M-Pesa callbacks `CALLBACK_BASE_URL` must be a public HTTPS URL.

## How the pieces connect

```
Browser page ─► this server ─► Daraja (STK Push)      ◄─ callback ─ Safaricom
                    └────────► Hydro API (meter lookup, amountRecharge, recharge records)
```

The browser never talks to Daraja or Hydro. `HYDRO_TOKEN` stays in `.env` on the server.

## Hydro endpoints used (from the STS API document)

| Purpose | Call |
|---|---|
| Check a meter belongs to company 10185 | `GET /stsMeter/code/{meterCode}` |
| Issue the token after payment | `POST /api/recharge/sts/amountRecharge` |
| Read back volume and balance, find a token | `POST /business/recharge/stsRecord/queryPage` |

## This server's endpoints

| Call | Used by | What it does |
|---|---|---|
| `GET /api/config` | page | Business name, price per m3, amount limits |
| `GET /api/meter/:code` | page | Confirms the meter is Mauriskade's |
| `GET /api/quote?amount=100` | page | Estimated m3 for an amount (fixed price, rounded down) |
| `POST /api/pay` | page | `{meterNumber, phone, amount}`, sends the STK prompt |
| `GET /api/pay/:id` | page | Status, and the token when ready |
| `POST /api/mpesa/callback/:secret` | Safaricom | Payment result |
| `GET /api/admin/review` | you | Paid transactions that need a person, with matching Hydro records |
| `POST /api/admin/review/:id` | you | `adopt`, `retry` or `close` (needs `x-admin-key`) |

## Payment states

`PENDING_PAYMENT` → `PAID` → `ISSUING` → `TOKEN_ISSUED`, or `FAILED` (no money taken),
`RETRY` (Hydro said try later, retried with backoff), `NEEDS_REVIEW` (a person must look).

A timed-out `amountRecharge` call goes to `NEEDS_REVIEW`, never to an automatic retry, because the
meter could be credited twice. Use `/api/admin/review` to see which Hydro record matches, then adopt it
or retry.

## Admin examples

```bash
curl -H "x-admin-key: $ADMIN_KEY" https://your-server/api/admin/review

# the token is already in Hydro's records: attach it to the customer's purchase
curl -X POST -H "x-admin-key: $ADMIN_KEY" -H "Content-Type: application/json" \
  -d '{"action":"adopt","token":"12345678901234567890"}' https://your-server/api/admin/review/<id>

# no token was issued: run it again
curl -X POST -H "x-admin-key: $ADMIN_KEY" -H "Content-Type: application/json" \
  -d '{"action":"retry"}' https://your-server/api/admin/review/<id>
```

## Before going live

1. Ask the Hydro engineer for a token scoped to company 10185 and revoke the one shared during testing.
2. Complete Daraja Go-Live for the Paybill, then set `MPESA_ENV=production`.
3. Test on one agreed meter with a small amount (KSh 10 buys 0.08 m3 at 120 per m3).
4. If the price changes in the Hydro dashboard, update `PRICE_PER_M3` so the on-screen estimate stays right. The credited volume shown after payment always comes from Hydro.

## Known limits

- Anyone with a purchase's UUID can view its token. The UUID is unguessable, but treat the link as private.
- The page's recent purchases are stored in the browser only (ids, never tokens).
- Nothing here sends the token by SMS yet.
