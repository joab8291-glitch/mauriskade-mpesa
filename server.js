require('dotenv').config();
const fs = require('fs');
const path = require('path');
const crypto = require('crypto');
const { promisify } = require('util');
const express = require('express');
const { Pool } = require('pg');
const { registerRentRoutes, processRentStkCallback } = require('./rent');

const scrypt = promisify(crypto.scrypt);

const {
  PORT = 3000,
  DATABASE_URL,
  HYDRO_BASE_URL,
  HYDRO_TOKEN,
  HYDRO_COMPANY_ID = '10185',
  BUSINESS_NAME = 'Mauriskade Apartments',
  PRICE_PER_M3 = '120',
  MPESA_ENV = 'sandbox',
  MPESA_CONSUMER_KEY,
  MPESA_CONSUMER_SECRET,
  MPESA_SHORTCODE,
  MPESA_PASSKEY,
  MPESA_TXN_TYPE = 'CustomerPayBillOnline',
  MPESA_PARTYB, // Till number for CustomerBuyGoodsOnline; defaults to MPESA_SHORTCODE (Paybill)
  CALLBACK_BASE_URL,
  CALLBACK_SECRET,
  MIN_AMOUNT = '60',
  MAX_AMOUNT = '20000',
  ADMIN_KEY,
  SESSION_DAYS = '7',
  CONTACT_EMAIL = '',
  CONTACT_PHONE = '',
} = process.env;

for (const k of ['DATABASE_URL', 'HYDRO_BASE_URL', 'HYDRO_TOKEN', 'MPESA_CONSUMER_KEY',
  'MPESA_CONSUMER_SECRET', 'MPESA_SHORTCODE', 'MPESA_PASSKEY', 'CALLBACK_BASE_URL', 'CALLBACK_SECRET']) {
  if (!process.env[k]) { console.error(`Missing env var ${k}`); process.exit(1); }
}
if (ADMIN_KEY && ADMIN_KEY.length < 12) {
  console.error('ADMIN_KEY must be at least 12 characters.');
  process.exit(1);
}
if (!ADMIN_KEY) console.warn('ADMIN_KEY is not set: the admin panel is switched off, so no logins can be created.');

const pool = new Pool({ connectionString: DATABASE_URL });
pool.on('error', (e) => console.error('pg pool error', e.message));

const DARAJA = MPESA_ENV === 'production'
  ? 'https://api.safaricom.co.ke'
  : 'https://sandbox.safaricom.co.ke';
const MAX_ATTEMPTS = 6;
const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;
const COOKIE = 'hp_session';
const CODE = /^\d{6,20}$/; // meter code
const UNCONFIRMED_STK = 'stk push unconfirmed'; // result_desc prefix: prompt may have reached the phone

/* ------------------------------ helpers ------------------------------ */

const log = (...a) => console.log(new Date().toISOString(), ...a);
const wrap = (fn) => (req, res, next) => Promise.resolve(fn(req, res, next)).catch((e) => {
  log('route error', req.method, req.path, e.message);
  if (!res.headersSent) res.status(500).json({ ok: false, message: 'Something went wrong. Try again.' });
});

// 2547XXXXXXXX (Safaricom 07.. and 01.. numbers)
function normPhone(p) {
  p = String(p || '').replace(/\D/g, '');
  if (/^0[17]\d{8}$/.test(p)) return '254' + p.slice(1);
  if (/^254[17]\d{8}$/.test(p)) return p;
  if (/^[17]\d{8}$/.test(p)) return '254' + p;
  return null;
}

const timestamp = () =>
  new Date(Date.now() + 3 * 3600e3).toISOString().replace(/[-:T]/g, '').slice(0, 14);

// Fixed price per m3, volume rounded DOWN to 2 decimals (matches the Hydro amountRecharge rule).
// This is only an estimate for the screen; the real volume is read back from Hydro after the recharge.
function quote(amount) {
  const price = Number(PRICE_PER_M3);
  const v100 = Math.floor((amount * 100) / price + 1e-9);
  const unused = Math.round((amount - (v100 * price) / 100) * 100) / 100;
  return { amount, volume: v100 / 100, unused, pricePerM3: price };
}

function validAmount(a) {
  return Number.isInteger(a) && a >= Number(MIN_AMOUNT) && a <= Number(MAX_AMOUNT);
}

function failReason(desc) {
  const d = String(desc || '').toLowerCase();
  if (d.includes('cancel')) return 'You cancelled the payment on your phone.';
  if (d.includes('insufficient') || d.includes('balance')) return 'Your M-Pesa balance was too low for this payment.';
  if (d.includes('timeout') || d.includes('timed out') || d.includes('did not') || d.includes('unreachable') || d.includes('cannot be reached')) {
    return 'The M-Pesa prompt timed out before it was approved.';
  }
  if (d.includes('initiator') || d.includes('pin')) return 'The M-Pesa PIN was not accepted. Try again and enter your PIN carefully.';
  return 'M-Pesa could not complete the payment. No money was taken.';
}

const viewOf = (s) => ({
  PENDING_PAYMENT: 'waiting_for_payment', FAILED: 'payment_failed', PAID: 'processing', ISSUING: 'processing',
  RETRY: 'processing', NEEDS_REVIEW: 'processing', TOKEN_ISSUED: 'done',
}[s]);
const stageOf = (s) => ({ PAID: 'preparing', ISSUING: 'preparing', RETRY: 'delayed', NEEDS_REVIEW: 'review' }[s]);

function rateLimit({ windowMs, max, key = (req) => req.ip }) {
  const hits = new Map();
  setInterval(() => {
    const now = Date.now();
    for (const [k, v] of hits) if (v.reset < now) hits.delete(k);
  }, Math.min(windowMs, 60000)).unref();
  return (req, res, next) => {
    const now = Date.now();
    const k = String(key(req) || 'unknown').slice(0, 160);
    let h = hits.get(k);
    if (!h || h.reset < now) {
      // Bound memory under high-cardinality/IP-flood traffic.
      if (hits.size >= 20000) {
        for (const [oldKey, value] of hits) if (value.reset < now) hits.delete(oldKey);
        if (hits.size >= 20000) return res.status(503).json({ ok: false, message: 'Temporarily busy. Try again shortly.' });
      }
      h = { n: 0, reset: now + windowMs };
      hits.set(k, h);
    }
    if (++h.n > max) return res.status(429).json({ ok: false, message: 'Too many requests. Wait a minute and try again.' });
    next();
  };
}

/* ----------------------- passwords, sessions, cookies ----------------------- */

const PW_ALPHABET = 'abcdefghjkmnpqrstuvwxyz23456789'; // no 0/o/1/l/i, easy to read out on the phone
function genPassword(len = 8) {
  let s = '';
  for (let i = 0; i < len; i++) s += PW_ALPHABET[crypto.randomInt(PW_ALPHABET.length)];
  return s;
}

async function hashPassword(pw) {
  const salt = crypto.randomBytes(16);
  const key = await scrypt(pw, salt, 64);
  return `scrypt$${salt.toString('base64')}$${key.toString('base64')}`;
}

async function verifyPassword(pw, stored) {
  const [alg, s, k] = String(stored || '').split('$');
  if (alg !== 'scrypt' || !s || !k) return false;
  const key = await scrypt(pw, Buffer.from(s, 'base64'), 64);
  const want = Buffer.from(k, 'base64');
  return key.length === want.length && crypto.timingSafeEqual(key, want);
}

let dummyHash = null; // so an unknown meter number takes as long to reject as a wrong password
hashPassword('not-a-real-password').then((h) => { dummyHash = h; });

const sha256 = (s) => crypto.createHash('sha256').update(s).digest('hex');

function parseCookies(header) {
  const out = {};
  for (const part of String(header || '').split(';')) {
    const i = part.indexOf('=');
    if (i > 0) {
      try { out[part.slice(0, i).trim()] = decodeURIComponent(part.slice(i + 1).trim()); } catch { /* skip bad cookie */ }
    }
  }
  return out;
}

async function startSession(req, res, userId) {
  const token = crypto.randomBytes(32).toString('base64url');
  await pool.query(
    `INSERT INTO sessions (token_hash, user_id, expires_at) VALUES ($1, $2, now() + ($3 || ' days')::interval)`,
    [sha256(token), userId, String(SESSION_DAYS)]);
  res.setHeader('Set-Cookie',
    `${COOKIE}=${token}; HttpOnly; SameSite=Lax; Path=/; Max-Age=${Number(SESSION_DAYS) * 86400}${req.secure ? '; Secure' : ''}`);
}

const requireUser = wrap(async (req, res, next) => {
  const tok = parseCookies(req.headers.cookie)[COOKIE];
  if (!tok) return res.status(401).json({ ok: false, message: 'Please sign in.' });
  const { rows } = await pool.query(
    `SELECT u.id, u.meter_code, u.must_change, u.disabled, m.flat, m.tenant_name, m.phone, m.rent_account_ref, m.water_account_ref, s.token_hash
       FROM sessions s
       JOIN users u  ON u.id = s.user_id
       JOIN meters m ON m.meter_code = u.meter_code
      WHERE s.token_hash = $1 AND s.expires_at > now()`, [sha256(tok)]);
  const u = rows[0];
  if (!u || u.disabled) return res.status(401).json({ ok: false, message: 'Please sign in.' });
  req.user = u;
  next();
});

const requireReady = (req, res, next) => (req.user.must_change
  ? res.status(403).json({ ok: false, mustChange: true, message: 'Choose a new password first.' })
  : next());

const meView = (u) => ({
  meterCode: u.meter_code, flat: u.flat || null, tenantName: u.tenant_name || null,
  phone: u.phone || null, rentAccountRef: u.rent_account_ref || null, waterAccountRef: u.water_account_ref || null, mustChange: !!u.must_change,
});

/* --------------------------- Hydro IoT client --------------------------- */

async function hydro(method, apiPath, body, timeoutMs = 20000) {
  const r = await fetch(`${HYDRO_BASE_URL}${apiPath}`, {
    method,
    headers: { Authorization: `Bearer ${HYDRO_TOKEN}`, 'Content-Type': 'application/json' },
    body: body ? JSON.stringify(body) : undefined,
    signal: AbortSignal.timeout(timeoutMs),
  });
  return r.json(); // throws if the body is not JSON, callers treat that as ambiguous
}

// Returns the meter object only if it belongs to our client, otherwise null.
async function lookupOwnedMeter(code) {
  if (!CODE.test(code)) return null;
  const res = await hydro('GET', `/stsMeter/code/${encodeURIComponent(code)}`);
  // Meter detail uses the same documented fields as the archive list and may
  // omit companyId. The meter was already registered from the companyId-scoped
  // queryPage sync, so verify the returned meterCode matches the requested code.
  if (res.code === 0 && res.data && String(res.data.meterCode || '') === String(code)) {
    return res.data;
  }
  return null;
}

// Every meter of our company, read page by page. Throws if any page fails, so a partial
// read is never mistaken for the full list.
async function pullHydroMeters() {
  const out = [];
  for (let pageNum = 1; pageNum <= 300; pageNum++) {
    const res = await hydro('POST', '/stsMeter/queryPage', {
      pageNum, pageSize: 100, companyId: Number(HYDRO_COMPANY_ID), searchCount: false,
    }, 45000);
    if (!res || res.code !== 0 || !res.data) {
      throw new Error(`page ${pageNum} failed (${res && res.code}: ${res && res.msg})`);
    }
    const list = Array.isArray(res.data.list) ? res.data.list : [];
    // The documented meter-list response does not include companyId on each
    // row. Scope the query by companyId in the request and trust that filtered
    // result; filtering rows by a missing companyId silently drops every meter.
    out.push(...list);
    const size = Number(res.data.pageSize) || 100;
    const pages = Number(res.data.pages) || 0;
    if (list.length === 0 || (pages > 0 ? pageNum >= pages : list.length < size)) return out;
  }
  throw new Error('more than 300 pages, refusing to continue');
}

// Recharge records for one meter made through this API (paymentMethod CUSTOMER_API), up to 3 pages.
async function fetchRecords(meter) {
  const all = [];
  for (let pageNum = 1; pageNum <= 3; pageNum++) {
    const res = await hydro('POST', '/business/recharge/stsRecord/queryPage', {
      meterCode: meter, orderType: 0, paymentMethod: 'CUSTOMER_API', pageNum, pageSize: 50, searchCount: false,
    });
    const list = res && res.code === 0 && res.data && res.data.list ? res.data.list : [];
    all.push(...list);
    if (list.length < 50) break;
  }
  return all.filter((r) => r.meterCode === meter);
}

// Read the volume and balance Hydro recorded for a token and store them. Best effort.
async function enrichFromRecords(id, meter, token) {
  try {
    const rec = (await fetchRecords(meter)).find((r) => r.rechargePassword === token);
    if (!rec) return false;
    await pool.query(
      `UPDATE transactions SET water_volume=$2, balance_after=$3, hydro_recharge_no=$4, updated_at=now() WHERE id=$1`,
      [id, rec.waterVolume ?? null, rec.balanceAfter ?? null, rec.rechargeNo ?? null]);
    return true;
  } catch (e) {
    log('enrich failed', id, e.message);
    return false;
  }
}

/* ------------------------------- Daraja ------------------------------- */

let darajaTok = { value: null, exp: 0 };
async function darajaToken(force = false) {
  if (!force && darajaTok.value && Date.now() < darajaTok.exp) return darajaTok.value;
  const auth = Buffer.from(`${MPESA_CONSUMER_KEY}:${MPESA_CONSUMER_SECRET}`).toString('base64');
  const r = await fetch(`${DARAJA}/oauth/v1/generate?grant_type=client_credentials`, {
    headers: { Authorization: `Basic ${auth}` },
    signal: AbortSignal.timeout(15000),
  });
  if (!r.ok) throw new Error(`Daraja auth failed (${r.status})`);
  const j = await r.json();
  if (!j.access_token) throw new Error('Daraja auth returned no access token.');
  const ttl = Number(j.expires_in);
  // Refresh a minute early; fall back to 50 minutes if expires_in is missing or odd.
  darajaTok = { value: j.access_token, exp: Date.now() + (ttl > 120 ? ttl - 60 : 3000) * 1000 };
  return darajaTok.value;
}

// Errors with `definite = true` mean Daraja answered and refused the request, so nothing was sent
// to the customer's phone. Anything else (timeout, network, unreadable reply) is ambiguous: the
// prompt may still have reached the phone.
const darajaError = (msg, definite) => Object.assign(new Error(msg), { definite });

async function darajaPost(apiPath, body, retriedAuth = false) {
  const r = await fetch(`${DARAJA}${apiPath}`, {
    method: 'POST',
    headers: { Authorization: `Bearer ${await darajaToken(retriedAuth)}`, 'Content-Type': 'application/json' },
    body: JSON.stringify(body),
    signal: AbortSignal.timeout(20000),
  });

  // An expired or revoked token is rejected before Daraja acts on the request, so one retry is safe.
  if (r.status === 401 && !retriedAuth) return darajaPost(apiPath, body, true);

  const raw = await r.text();
  let data;
  try { data = JSON.parse(raw); }
  catch { throw darajaError(`Daraja returned an invalid response (HTTP ${r.status}).`, false); }
  if (!r.ok) {
    throw darajaError(data.errorMessage || data.ResponseDescription || `Daraja request failed (HTTP ${r.status}).`,
      r.status >= 400 && r.status < 500);
  }
  return data;
}

const stkPassword = (t) => Buffer.from(`${MPESA_SHORTCODE}${MPESA_PASSKEY}${t}`).toString('base64');

// One validated entry point for every M-Pesa STK request.
async function stkPush({ amount, phone, meter }) {
  if (!Number.isInteger(amount) || amount < 1) throw darajaError('Invalid STK amount.', true);
  if (!/^254[17]\d{8}$/.test(String(phone))) throw darajaError('Invalid Safaricom phone number.', true);
  if (!CODE.test(String(meter))) throw darajaError('Invalid meter reference.', true);

  const t = timestamp();
  const response = await darajaPost('/mpesa/stkpush/v1/processrequest', {
    BusinessShortCode: MPESA_SHORTCODE,
    Password: stkPassword(t),
    Timestamp: t,
    TransactionType: MPESA_TXN_TYPE,
    Amount: amount,
    PartyA: phone,
    PartyB: MPESA_PARTYB || MPESA_SHORTCODE,
    PhoneNumber: phone,
    CallBackURL: `${CALLBACK_BASE_URL}/api/mpesa/callback/${CALLBACK_SECRET}`,
    // Daraja allows 12 AccountReference characters; the meter suffix is unique.
    AccountReference: meter.slice(-12),
    TransactionDesc: 'Water token',
  });

  if (String(response.ResponseCode) !== '0') {
    throw darajaError(response.errorMessage || response.ResponseDescription || 'Daraja rejected the STK request.', true);
  }
  if (!response.CheckoutRequestID) throw darajaError('Daraja accepted the STK request but returned no CheckoutRequestID.', false);
  return response;
}
function stkQuery(checkoutRequestId) {
  const t = timestamp();
  return darajaPost('/mpesa/stkpushquery/v1/query', {
    BusinessShortCode: MPESA_SHORTCODE,
    Password: stkPassword(t),
    Timestamp: t,
    CheckoutRequestID: checkoutRequestId,
  });
}

// Shared by the customer pay route and the admin panel: checks the meter, opens an STK prompt
// and records the transaction. Returns { status, body } for the route to send.
async function startPayment({ meter, phone, amount }) {
  let owned;
  try {
    owned = await lookupOwnedMeter(meter);
  } catch (e) {
    return { status: 502, body: { ok: false, message: 'We could not reach the meter system. Try again in a moment.' } };
  }
  if (!owned) {
    return { status: 409, body: { ok: false, message: `Your meter is not available on the system right now. Contact ${BUSINESS_NAME}.` } };
  }

  // Check-then-insert under a per-meter lock, so a double click cannot open two prompts.
  let id;
  const client = await pool.connect();
  try {
    await client.query('BEGIN');
    await client.query('SELECT pg_advisory_xact_lock(hashtext($1))', [`stk:${meter}`]);
    const dup = await client.query(
      `SELECT 1 FROM transactions
        WHERE meter_number=$1 AND status='PENDING_PAYMENT' AND created_at > now() - interval '2 minutes'`,
      [meter]);
    if (dup.rowCount) {
      await client.query('ROLLBACK');
      return { status: 429, body: { ok: false, message: 'A payment prompt is already open for this meter. Approve it on your phone or wait a minute.' } };
    }
    const ins = await client.query(
      `INSERT INTO transactions (meter_number, phone, amount) VALUES ($1,$2,$3) RETURNING id`,
      [meter, phone, amount]);
    id = ins.rows[0].id;
    await client.query('COMMIT');
  } catch (e) {
    await client.query('ROLLBACK').catch(() => {});
    throw e;
  } finally {
    client.release();
  }

  let stk;
  try {
    stk = await stkPush({ amount, phone, meter });
  } catch (e) {
    const unconfirmed = e.definite !== true;
    log('STK_PUSH_FAILED', { transactionId: id, unconfirmed, meter: String(meter).slice(-4), phone: String(phone).slice(0, 5) + '****' + String(phone).slice(-3), error: e.message });
    await pool.query(`UPDATE transactions SET status='FAILED', result_desc=$2, updated_at=now() WHERE id=$1`,
      [id, `${unconfirmed ? UNCONFIRMED_STK : 'stk push error'}: ${e.message}`]);
    return { status: 502, body: { ok: false, message: unconfirmed
      ? 'We could not confirm that the M-Pesa prompt was sent. If a prompt appears on your phone, approve it and your token will still be issued. Otherwise try again in a minute.'
      : 'M-Pesa could not start this payment. Please check the number and try once more. If it still fails, contact the property office.' } };
  }

  await pool.query(
    `UPDATE transactions SET checkout_request_id=$2, merchant_request_id=$3, updated_at=now() WHERE id=$1`,
    [id, stk.CheckoutRequestID, stk.MerchantRequestID]);
  await pool.query(`UPDATE meters SET phone=$2 WHERE meter_code=$1 AND phone IS NULL`, [meter, phone]);

  return { status: 200, body: { ok: true, transactionId: id } };
}

// A callback whose CheckoutRequestID matches no row. This happens when the prompt reached the phone
// but we never stored its id (the STK reply timed out, or the callback beat our own UPDATE). Match
// it to the recent transaction for the same phone and amount that is still missing an id.
async function adoptUnmatchedCallback(checkoutId, phone, amount) {
  if (!phone || !Number.isInteger(amount)) return false;
  const r = await pool.query(
    `UPDATE transactions
        SET checkout_request_id=$1, status='PENDING_PAYMENT', result_desc=NULL, updated_at=now()
      WHERE id = (
        SELECT id FROM transactions
         WHERE checkout_request_id IS NULL AND phone=$2 AND amount=$3
           AND created_at > now() - interval '15 minutes'
           AND (status='PENDING_PAYMENT' OR (status='FAILED' AND result_desc LIKE $4))
         ORDER BY created_at DESC LIMIT 1
         FOR UPDATE SKIP LOCKED)
      RETURNING id`,
    [checkoutId, phone, amount, `${UNCONFIRMED_STK}%`]);
  return r.rowCount > 0;
}

/* ------------------------- token issuing (core) ------------------------- */

async function issueToken(id) {
  // Atomic claim: only one caller can move PAID/RETRY -> ISSUING
  const { rows } = await pool.query(
    `UPDATE transactions
        SET status='ISSUING', attempts=attempts+1, updated_at=now()
      WHERE id=$1 AND status IN ('PAID','RETRY')
      RETURNING *`, [id]);
  const tx = rows[0];
  if (!tx) return;

  try {
    const res = await hydro('POST', '/api/recharge/sts/amountRecharge', {
      meterNumber: tx.meter_number,
      rechargeAmount: tx.amount,
    });

    if (res.code === 0 && /^\d{20}$/.test(String(res.data))) {
      const token = String(res.data);
      await pool.query(
        `UPDATE transactions SET status='TOKEN_ISSUED', token=$2,
                last_error = CASE WHEN last_error LIKE 'Amount mismatch%' THEN last_error ELSE NULL END,
                updated_at=now() WHERE id=$1`,
        [id, token]);
      log('token issued', id);
      enrichFromRecords(id, tx.meter_number, token).catch(() => {});
      return;
    }

    const msg = `${res.code}: ${res.msg}`;
    const retryable =
      (res.code === 30001 && /pending recharge command/i.test(res.msg || '')) || res.code === 20001;

    if (retryable && tx.attempts < MAX_ATTEMPTS) {
      const mins = Math.min(tx.attempts * 5, 30);
      await pool.query(
        `UPDATE transactions SET status='RETRY', last_error=$2,
                next_retry_at = now() + ($3 || ' minutes')::interval, updated_at=now() WHERE id=$1`,
        [id, msg, String(mins)]);
      log('will retry', id, msg);
    } else {
      await pool.query(
        `UPDATE transactions SET status='NEEDS_REVIEW', last_error=$2, updated_at=now() WHERE id=$1`,
        [id, msg]);
      log('NEEDS_REVIEW', id, msg);
    }
  } catch (e) {
    // Timeout, network error or non-JSON reply: we do not know whether Hydro issued a token.
    // Retrying blindly could credit the meter twice, so a person checks the records first
    // (see /api/admin/review, which lists the matching Hydro records).
    await pool.query(
      `UPDATE transactions SET status='NEEDS_REVIEW', last_error=$2, updated_at=now() WHERE id=$1`,
      [id, `ambiguous: ${e.message}`]);
    log('NEEDS_REVIEW (ambiguous)', id, e.message);
  }
}

/* ------------------------------- Express ------------------------------- */

const app = express();
app.set('trust proxy', 1); // Render terminates TLS at its trusted edge proxy.
app.disable('x-powered-by');

// Baseline browser/API hardening. Keep CSP configurable at the hosting edge because
// both portals currently use inline scripts/styles and load Google Fonts.
app.use((req, res, next) => {
  res.setHeader('X-Content-Type-Options', 'nosniff');
  res.setHeader('X-Frame-Options', 'DENY');
  res.setHeader('Referrer-Policy', 'strict-origin-when-cross-origin');
  res.setHeader('Permissions-Policy', 'camera=(), microphone=(), geolocation=()');
  res.setHeader('Cross-Origin-Resource-Policy', 'same-origin');
  if (req.secure) res.setHeader('Strict-Transport-Security', 'max-age=31536000; includeSubDomains');
  if (req.path.startsWith('/api/')) {
    res.setHeader('Cache-Control', 'no-store, no-cache, must-revalidate, private');
    res.setHeader('Pragma', 'no-cache');
  }
  next();
});

app.use(express.json({ limit: '32kb', strict: true, type: 'application/json' }));
app.use(express.static(path.join(__dirname, 'public'), {
  dotfiles: 'deny',
  etag: true,
  maxAge: '1h',
  setHeaders(res) {
    res.setHeader('X-Content-Type-Options', 'nosniff');
    res.setHeader('X-Frame-Options', 'DENY');
  },
}));
app.get('/admin', (_req, res) => res.sendFile(path.join(__dirname, 'admin.html')));

const lightLimit = rateLimit({ windowMs: 60000, max: 40 });
const loginLimit = rateLimit({ windowMs: 10 * 60000, max: 20 });
const byUser = (req) => (req.user ? req.user.id : req.ip);
const pollLimit = rateLimit({ windowMs: 60000, max: 120, key: byUser });
const payLimit = rateLimit({ windowMs: 10 * 60000, max: 6, key: byUser });
const adminLimit = rateLimit({ windowMs: 60000, max: 120 });

// What the pages need to know before they start
app.get('/api/config', (_req, res) => {
  res.json({
    ok: true,
    businessName: BUSINESS_NAME,
    pricePerM3: Number(PRICE_PER_M3),
    minAmount: Number(MIN_AMOUNT),
    maxAmount: Number(MAX_AMOUNT),
    // Shown on the Privacy, Terms and Copyright pages. Both are optional.
    contactEmail: CONTACT_EMAIL.trim() || undefined,
    contactPhone: CONTACT_PHONE.trim() || undefined,
  });
});

// How much water an amount buys
app.get('/api/quote', lightLimit, (req, res) => {
  const amount = Number(req.query.amount);
  if (!validAmount(amount)) {
    return res.status(400).json({ ok: false, message: `Enter a whole amount from KSh ${MIN_AMOUNT} to KSh ${MAX_AMOUNT}.` });
  }
  res.json({ ok: true, ...quote(amount) });
});

/* ---------------------------- customer sign-in ---------------------------- */

app.post('/api/auth/login', loginLimit, wrap(async (req, res) => {
  const username = String((req.body && req.body.username) || '').replace(/\s/g, '');
  const password = String((req.body && req.body.password) || '');
  const bad = () => res.status(401).json({ ok: false, message: 'Wrong meter number or password.' });
  if (!username || !password || password.length > 200) return bad();

  const u = (await pool.query(
    `SELECT u.*, m.flat, m.tenant_name, m.phone FROM users u JOIN meters m ON m.meter_code=u.meter_code
      WHERE u.username=$1`, [username])).rows[0];
  if (!u) {
    if (dummyHash) await verifyPassword(password, dummyHash);
    return bad();
  }
  if (u.locked_until && new Date(u.locked_until) > new Date()) {
    return res.status(429).json({ ok: false, message: 'Too many wrong attempts. Try again in 15 minutes.' });
  }
  if (!(await verifyPassword(password, u.password_hash))) {
    await pool.query(
      `UPDATE users
          SET failed_attempts = CASE WHEN failed_attempts + 1 >= 5 THEN 0 ELSE failed_attempts + 1 END,
              locked_until    = CASE WHEN failed_attempts + 1 >= 5 THEN now() + interval '15 minutes' ELSE locked_until END
        WHERE id=$1`, [u.id]);
    return bad();
  }
  if (u.disabled) {
    return res.status(403).json({ ok: false, message: `This login is switched off. Contact ${BUSINESS_NAME}.` });
  }
  await pool.query(`UPDATE users SET failed_attempts=0, locked_until=NULL, last_login_at=now() WHERE id=$1`, [u.id]);
  await startSession(req, res, u.id);
  res.json({ ok: true, me: meView(u) });
}));

app.post('/api/auth/logout', wrap(async (req, res) => {
  const tok = parseCookies(req.headers.cookie)[COOKIE];
  if (tok) await pool.query(`DELETE FROM sessions WHERE token_hash=$1`, [sha256(tok)]);
  res.setHeader('Set-Cookie', `${COOKIE}=; HttpOnly; SameSite=Lax; Path=/; Max-Age=0${req.secure ? '; Secure' : ''}`);
  res.json({ ok: true });
}));

app.get('/api/me', requireUser, (req, res) => res.json({ ok: true, me: meView(req.user) }));

// Total water actually issued to this signed-in meter during the current Nairobi calendar month.
app.get('/api/me/usage', requireUser, wrap(async (req, res) => {
  const { rows } = await pool.query(
    `SELECT COALESCE(sum(water_volume), 0)::numeric(12,2) AS volume
       FROM transactions
      WHERE meter_number=$1
        AND status='TOKEN_ISSUED'
        AND created_at >= date_trunc('month', now() AT TIME ZONE 'Africa/Nairobi') AT TIME ZONE 'Africa/Nairobi'
        AND created_at < (date_trunc('month', now() AT TIME ZONE 'Africa/Nairobi') + interval '1 month') AT TIME ZONE 'Africa/Nairobi'`,
    [req.user.meter_code]);
  res.json({ ok: true, meter: req.user.meter_code, monthVolume: Number(rows[0].volume) });
}));

app.post('/api/auth/change-password', requireUser, wrap(async (req, res) => {
  const current = String((req.body && req.body.current) || '');
  const next = String((req.body && req.body.next) || '');
  if (next.length < 8 || next.length > 100) {
    return res.status(400).json({ ok: false, message: 'Your new password must be at least 8 characters.' });
  }
  const row = (await pool.query(`SELECT password_hash FROM users WHERE id=$1`, [req.user.id])).rows[0];
  if (!row || !(await verifyPassword(current, row.password_hash))) {
    return res.status(400).json({ ok: false, message: 'The current password is not right.' });
  }
  // Compare the proposed password against the stored hash, not the two
  // submitted strings. This also catches browser autofill/current-password
  // field mixups without rejecting a genuinely new password incorrectly.
  if (await verifyPassword(next, row.password_hash)) {
    return res.status(400).json({ ok: false, message: 'Choose a password different from the current one.' });
  }
  await pool.query(`UPDATE users SET password_hash=$2, must_change=false WHERE id=$1`, [req.user.id, await hashPassword(next)]);
  await pool.query(`DELETE FROM sessions WHERE user_id=$1 AND token_hash<>$2`, [req.user.id, req.user.token_hash]);
  res.json({ ok: true });
}));

/* ------------------------------- payments ------------------------------- */

// Start a payment for the signed-in customer's own meter
app.post('/api/pay', requireUser, requireReady, payLimit, wrap(async (req, res) => {
  const meter = req.user.meter_code;
  const phone = normPhone(req.body && req.body.phone);
  const amount = Number(req.body && req.body.amount);

  if (!phone) return res.status(400).json({ ok: false, message: 'Enter a valid Safaricom number, like 0712 345 678.' });
  if (!validAmount(amount)) {
    return res.status(400).json({ ok: false, message: `Enter a whole amount from KSh ${MIN_AMOUNT} to KSh ${MAX_AMOUNT}.` });
  }

  const out = await startPayment({ meter, phone, amount });
  res.status(out.status).json(out.body);
}));

// The page polls this after /api/pay. A customer can only read purchases for their own meter.
app.get('/api/pay/:id', requireUser, requireReady, pollLimit, wrap(async (req, res) => {
  if (!UUID.test(req.params.id)) return res.status(400).json({ ok: false, message: 'Invalid purchase code.' });
  let t = (await pool.query(
    `SELECT id, status, meter_number, amount, token, mpesa_receipt, result_desc, water_volume, created_at
       FROM transactions WHERE id=$1 AND meter_number=$2`, [req.params.id, req.user.meter_code])).rows[0];
  if (!t) return res.status(404).json({ ok: false, message: 'We could not find that purchase.' });

  // Volume not stored yet? Ask Hydro once more.
  if (t.status === 'TOKEN_ISSUED' && t.water_volume === null) {
    if (await enrichFromRecords(t.id, t.meter_number, t.token)) {
      const r = (await pool.query(`SELECT water_volume FROM transactions WHERE id=$1`, [t.id])).rows[0];
      t = { ...t, water_volume: r.water_volume };
    }
  }

  res.json({
    ok: true,
    status: viewOf(t.status),
    stage: stageOf(t.status),
    meter: t.meter_number,
    amount: t.amount,
    receipt: t.mpesa_receipt || undefined,
    token: t.status === 'TOKEN_ISSUED' ? t.token : undefined,
    volume: t.water_volume === null ? undefined : Number(t.water_volume),
    reason: t.status === 'FAILED' ? failReason(t.result_desc) : undefined,
    createdAt: t.created_at,
  });
}));

// The customer's own recent top-ups, tokens included, so a lost token can be found again
app.get('/api/me/transactions', requireUser, requireReady, wrap(async (req, res) => {
  const { rows } = await pool.query(
    `SELECT id, status, amount, token, mpesa_receipt, water_volume, created_at
       FROM transactions WHERE meter_number=$1 ORDER BY created_at DESC LIMIT 20`, [req.user.meter_code]);
  res.json({
    ok: true,
    items: rows.map((t) => ({
      id: t.id,
      status: viewOf(t.status),
      stage: stageOf(t.status),
      amount: t.amount,
      receipt: t.mpesa_receipt || undefined,
      token: t.status === 'TOKEN_ISSUED' ? t.token : undefined,
      volume: t.water_volume === null ? undefined : Number(t.water_volume),
      createdAt: t.created_at,
    })),
  });
}));

// Safaricom callback
app.post('/api/mpesa/callback/:secret', async (req, res) => {
  const given = Buffer.from(String(req.params.secret));
  const want = Buffer.from(CALLBACK_SECRET);
  if (given.length !== want.length || !crypto.timingSafeEqual(given, want)) return res.sendStatus(403);
  res.json({ ResultCode: 0, ResultDesc: 'Accepted' }); // answer fast, process after

  try {
    const cb = req.body && req.body.Body && req.body.Body.stkCallback;
    if (!cb || !cb.CheckoutRequestID) return;
    const checkoutId = String(cb.CheckoutRequestID);
    if (await processRentStkCallback(pool, checkoutId, cb)) return; // Rent is a separate ledger: never pass rent into water-token issuance.
    const code = Number(cb.ResultCode);
    if (!Number.isFinite(code)) { log('callback without ResultCode', checkoutId); return; }

    if (code !== 0) {
      await pool.query(
        `UPDATE transactions SET status='FAILED', result_desc=$2, updated_at=now()
          WHERE checkout_request_id=$1 AND status='PENDING_PAYMENT'`,
        [checkoutId, cb.ResultDesc || `ResultCode ${code}`]);
      return;
    }

    const items = Object.fromEntries(((cb.CallbackMetadata || {}).Item || []).map((i) => [i.Name, i.Value]));
    const receipt = items.MpesaReceiptNumber ? String(items.MpesaReceiptNumber) : null;
    const paid = Number(items.Amount);
    const payer = items.PhoneNumber != null ? String(items.PhoneNumber) : null;

    // A success callback we cannot match to a row would otherwise mean money taken and no token.
    const known = (await pool.query(`SELECT 1 FROM transactions WHERE checkout_request_id=$1`, [checkoutId])).rowCount > 0
      || await adoptUnmatchedCallback(checkoutId, payer, paid);
    if (!known) {
      log('ORPHAN_PAYMENT: paid but no matching transaction, reconcile by receipt',
        { checkoutId, receipt, amount: items.Amount, phone: payer && payer.slice(0, 5) + '****' + payer.slice(-3) });
      return;
    }

    // Idempotent claim: a retried callback finds status != PENDING_PAYMENT and does nothing
    const claim = await pool.query(
      `UPDATE transactions
          SET status = CASE WHEN amount = $3::numeric THEN 'PAID' ELSE 'NEEDS_REVIEW' END,
              last_error = CASE WHEN amount = $3::numeric THEN last_error ELSE 'Amount mismatch, M-Pesa paid ' || $4::text END,
              mpesa_receipt = $2, updated_at = now()
        WHERE checkout_request_id = $1 AND status = 'PENDING_PAYMENT'
        RETURNING id, status`,
      [checkoutId, receipt, Number.isFinite(paid) ? paid : null, Number.isFinite(paid) ? String(paid) : 'unknown']);

    // If the reconciler already marked it paid, still record the receipt
    await pool.query(
      `UPDATE transactions SET mpesa_receipt=$2 WHERE checkout_request_id=$1 AND mpesa_receipt IS NULL`,
      [checkoutId, receipt]);

    // The reconciler confirms payment through an STK query, which carries no amount. When this
    // callback arrives second, it is the first time the paid amount can be checked, so do it now.
    // If no token has gone out yet, stop it and send the row to review. If one already has, it
    // cannot be taken back: flag the row (it keeps its status, so the customer still sees the token).
    if (!claim.rows[0] && Number.isFinite(paid)) {
      const late = await pool.query(
        `UPDATE transactions
            SET status = CASE WHEN status IN ('PAID','RETRY') THEN 'NEEDS_REVIEW' ELSE status END,
                last_error = 'Amount mismatch, M-Pesa paid ' || $3::text || ' but ' || amount::text || ' was requested (found after the payment was confirmed)',
                updated_at = now()
          WHERE checkout_request_id = $1
            AND status IN ('PAID','ISSUING','RETRY','TOKEN_ISSUED','NEEDS_REVIEW')
            AND amount <> $2::numeric
            AND (last_error IS NULL OR last_error NOT LIKE 'Amount mismatch%')
        RETURNING id, status`,
        [checkoutId, paid, String(paid)]);
      if (late.rows[0]) {
        log('AMOUNT_MISMATCH after confirmation', { transactionId: late.rows[0].id, status: late.rows[0].status, receipt, paid });
      }
    }

    if (claim.rows[0] && claim.rows[0].status === 'PAID') await issueToken(claim.rows[0].id);
  } catch (e) {
    log('callback processing error', e.message); // the reconciler picks it up via STK query
  }
});

/* ------------------------------- admin ------------------------------- */

function adminAuth(req, res, next) {
  const got = Buffer.from(req.get('x-admin-key') || '');
  const want = Buffer.from(ADMIN_KEY || '');
  if (!ADMIN_KEY || got.length !== want.length || !crypto.timingSafeEqual(got, want)) {
    return res.status(403).json({ ok: false, message: 'Forbidden' });
  }
  next();
}
app.use('/api/admin', adminLimit, adminAuth);

registerRentRoutes({ app, pool, requireUser, requireReady, normPhone, darajaPost,
  mpesaShortcode: MPESA_SHORTCODE, callbackBaseUrl: CALLBACK_BASE_URL, callbackSecret: CALLBACK_SECRET });

app.get('/api/admin/summary', wrap(async (_req, res) => {
  const r = (await pool.query(
    `SELECT (SELECT count(*) FROM meters)::int AS meters,
            (SELECT count(*) FROM users)::int AS logins,
            (SELECT count(*) FROM meters m LEFT JOIN users u ON u.meter_code=m.meter_code WHERE u.id IS NULL)::int AS without_login,
            (SELECT count(*) FROM transactions WHERE status='NEEDS_REVIEW')::int AS needs_review,
            (SELECT count(*) FROM transactions WHERE last_error LIKE 'Amount mismatch%' AND status <> 'NEEDS_REVIEW')::int AS amount_mismatches,
            COALESCE(m.n, 0)::int AS topups_month, COALESCE(m.amt, 0)::bigint AS revenue_month, COALESCE(m.vol, 0)::float AS volume_month
       FROM (SELECT 1) one
       LEFT JOIN (SELECT count(*) AS n, sum(amount) AS amt, sum(water_volume) AS vol FROM transactions
                   WHERE status='TOKEN_ISSUED'
                     AND created_at >= date_trunc('month', now() AT TIME ZONE 'Africa/Nairobi') AT TIME ZONE 'Africa/Nairobi') m ON true`)).rows[0];
  // amountMismatches: tokens already issued where M-Pesa reported a different amount than requested.
  // *Month figures count completed top-ups (token issued) since the 1st of this month, Nairobi time.
  res.json({ ok: true, meters: r.meters, logins: r.logins, withoutLogin: r.without_login, needsReview: r.needs_review,
    amountMismatches: r.amount_mismatches, topupsMonth: r.topups_month, revenueMonth: Number(r.revenue_month),
    volumeMonth: Number(r.volume_month) });
}));

// Completed top-ups per day (Nairobi time) for the dashboard chart. Days with none come back as zeros.
app.get('/api/admin/trends', wrap(async (req, res) => {
  const days = Math.min(60, Math.max(7, Number(req.query.days) || 14));
  const { rows } = await pool.query(
    `SELECT to_char(d::date, 'YYYY-MM-DD') AS day, COALESCE(t.n, 0)::int AS topups,
            COALESCE(t.amt, 0)::bigint AS amount, COALESCE(t.vol, 0)::float AS volume
       FROM generate_series(((now() AT TIME ZONE 'Africa/Nairobi')::date - ($1::int - 1))::timestamp,
                            (now() AT TIME ZONE 'Africa/Nairobi')::date::timestamp, interval '1 day') d
       LEFT JOIN (SELECT (created_at AT TIME ZONE 'Africa/Nairobi')::date AS day, count(*) AS n,
                         sum(amount) AS amt, sum(water_volume) AS vol
                    FROM transactions
                   WHERE status='TOKEN_ISSUED' AND created_at >= now() - (($1::int + 1) * interval '1 day')
                   GROUP BY 1) t ON t.day = d::date
      ORDER BY d`, [days]);
  res.json({ ok: true, days: rows.map((r) => ({ day: r.day, topups: r.topups, amount: Number(r.amount), volume: Number(r.volume) })) });
}));

// Ask Hydro for all of the company's meters and store any we have not seen before.
app.post('/api/admin/meters/sync', wrap(async (_req, res) => {
  let meters;
  try {
    meters = await pullHydroMeters();
  } catch (e) {
    return res.status(502).json({ ok: false, message: `Could not read the meter list from Hydro: ${e.message}` });
  }
  const existing = new Set((await pool.query(`SELECT meter_code FROM meters`)).rows.map((r) => r.meter_code));
  const seen = new Set();
  const newMeters = [];
  for (const m of meters) {
    const code = m.meterCode && String(m.meterCode).trim();
    if (!code) continue;
    seen.add(code);
    if (!existing.has(code)) newMeters.push(code);
    await pool.query(
      `INSERT INTO meters (meter_code, hydro_meter_id, hydro_label) VALUES ($1,$2,$3)
       ON CONFLICT (meter_code) DO UPDATE
         SET hydro_meter_id=EXCLUDED.hydro_meter_id, hydro_label=EXCLUDED.hydro_label, last_seen_at=now()`,
      [code, m.meterId ?? null, m.installationLocation ?? null]);
  }
  const missing = [...existing].filter((c) => !seen.has(c));
  const withoutLogin = (await pool.query(
    `SELECT count(*)::int AS n FROM meters m LEFT JOIN users u ON u.meter_code=m.meter_code WHERE u.id IS NULL`)).rows[0].n;
  res.json({ ok: true, total: seen.size, newMeters, missing, withoutLogin });
}));

app.get('/api/admin/meters', wrap(async (req, res) => {
  const q = String(req.query.q || '').trim();
  const onlyNoLogin = req.query.filter === 'nologin';
  const offset = Math.max(0, Number(req.query.offset) || 0);
  const { rows } = await pool.query(
    `SELECT m.meter_code, m.hydro_label, m.flat, m.tenant_name, m.phone, m.rent_account_ref, m.water_account_ref, m.first_seen_at, u.username,
            (u.id IS NOT NULL) AS has_login, COALESCE(u.disabled,false) AS disabled,
            COALESCE(u.must_change,false) AS must_change, u.last_login_at
       FROM meters m LEFT JOIN users u ON u.meter_code = m.meter_code
      WHERE ($1 = '' OR m.meter_code ILIKE '%' || $1 || '%' OR m.flat ILIKE '%' || $1 || '%' OR m.tenant_name ILIKE '%' || $1 || '%')
        AND ($2::boolean = false OR u.id IS NULL)
      ORDER BY m.first_seen_at DESC, m.meter_code
      LIMIT 201 OFFSET $3`, [q, onlyNoLogin, offset]);
  res.json({ ok: true, items: rows.slice(0, 200), more: rows.length > 200 });
}));

app.post('/api/admin/meters/:meter', wrap(async (req, res) => {
  const flat = String((req.body && req.body.flat) || '').trim().slice(0, 40) || null;
  const tenant = String((req.body && req.body.tenantName) || '').trim().slice(0, 80) || null;
  const rawPhone = String((req.body && req.body.phone) || '').trim();
  const phone = rawPhone ? normPhone(rawPhone) : null;
  if (rawPhone && !phone) return res.status(400).json({ ok: false, message: 'That phone number is not valid.' });
  const r = await pool.query(
    `UPDATE meters SET flat=$2, tenant_name=$3, phone=$4 WHERE meter_code=$1`, [req.params.meter, flat, tenant, phone]);
  if (!r.rowCount) return res.status(404).json({ ok: false, message: 'Meter not found.' });
  res.json({ ok: true });
}));

// Create logins for meters that have none (all of them, or only the codes sent in "meters").
// Passwords exist in the response only: they are stored hashed and cannot be shown again.
app.post('/api/admin/logins/create', wrap(async (req, res) => {
  const codes = Array.isArray(req.body && req.body.meters) ? req.body.meters.map(String) : null;
  const { rows } = await pool.query(
    `SELECT m.meter_code, m.flat, m.tenant_name, m.rent_account_ref, m.water_account_ref
       FROM meters m LEFT JOIN users u ON u.meter_code = m.meter_code
      WHERE u.id IS NULL AND m.rent_account_ref IS NOT NULL ${codes ? 'AND m.meter_code = ANY($1)' : ''}
      ORDER BY m.rent_account_ref LIMIT 500`, codes ? [codes] : []);
  const created = [];
  for (const m of rows) {
    const password = genPassword();
    const r = await pool.query(
      `INSERT INTO users (meter_code, username, password_hash) VALUES ($1,$3,$2) ON CONFLICT (meter_code) DO NOTHING RETURNING id`,
      [m.meter_code, await hashPassword(password), m.rent_account_ref]);
    if (r.rowCount) {
      created.push({ meterCode: m.meter_code, flat: m.flat, tenantName: m.tenant_name, rentAccountRef: m.rent_account_ref, waterAccountRef: m.water_account_ref, username: m.rent_account_ref, password });
    }
  }
  res.json({ ok: true, created });
}));

app.post('/api/admin/logins/reset-all', wrap(async (_req, res) => {
  const { rows } = await pool.query('SELECT meter_code, tenant_name, rent_account_ref, water_account_ref FROM meters WHERE rent_account_ref IS NOT NULL AND water_account_ref IS NOT NULL ORDER BY rent_account_ref');
  if (rows.length !== 10) return res.status(409).json({ ok: false, message: 'Expected 10 room accounts; found ' + rows.length + '. No logins were changed.' });
  const client = await pool.connect();
  const credentials = [];
  try {
    await client.query('BEGIN');
    for (const m of rows) {
      const password = genPassword(12);
      const hash = await hashPassword(password);
      await client.query('INSERT INTO users (meter_code, username, password_hash, must_change, disabled, failed_attempts, locked_until) VALUES ($1,$2,$3,true,false,0,NULL) ON CONFLICT (meter_code) DO UPDATE SET username=EXCLUDED.username, password_hash=EXCLUDED.password_hash, must_change=true, disabled=false, failed_attempts=0, locked_until=NULL', [m.meter_code, m.rent_account_ref, hash]);
      credentials.push({ room: m.tenant_name === 'Celestine' ? 'Room 10' : m.tenant_name, tenantName: m.tenant_name, rentAccountRef: m.rent_account_ref, waterAccountRef: m.water_account_ref, username: m.rent_account_ref, password });
    }
    await client.query('DELETE FROM sessions');
    await client.query('COMMIT');
    res.json({ ok: true, count: credentials.length, credentials });
  } catch (e) { await client.query('ROLLBACK').catch(() => {}); throw e; }
  finally { client.release(); }
}));

app.post('/api/admin/logins/:meter/reset', wrap(async (req, res) => {
  const password = genPassword();
  const r = await pool.query(
    `UPDATE users SET password_hash=$2, must_change=true, failed_attempts=0, locked_until=NULL
      WHERE meter_code=$1 RETURNING id, username`, [req.params.meter, await hashPassword(password)]);
  if (!r.rowCount) return res.status(404).json({ ok: false, message: 'That meter has no login yet.' });
  await pool.query(`DELETE FROM sessions WHERE user_id=$1`, [r.rows[0].id]);
  res.json({ ok: true, username: r.rows[0].username, meterCode: req.params.meter, password });
}));

app.post('/api/admin/logins/:meter/disable', wrap(async (req, res) => {
  const disabled = !!(req.body && req.body.disabled);
  const r = await pool.query(`UPDATE users SET disabled=$2 WHERE meter_code=$1 RETURNING id`, [req.params.meter, disabled]);
  if (!r.rowCount) return res.status(404).json({ ok: false, message: 'That meter has no login yet.' });
  if (disabled) await pool.query(`DELETE FROM sessions WHERE user_id=$1`, [r.rows[0].id]);
  res.json({ ok: true });
}));

// Transactions a person has to look at, with the Hydro records that could be theirs.
// Record times from Hydro come back in mixed time zones, so matching is by amount and by
// "token not already given to someone else". A person confirms before anything is adopted.
app.get('/api/admin/review', wrap(async (_req, res) => {
  const { rows } = await pool.query(
    `SELECT id, meter_number, phone, amount, mpesa_receipt, last_error, result_desc, created_at
       FROM transactions WHERE status='NEEDS_REVIEW' ORDER BY created_at DESC LIMIT 50`);
  const items = [];
  for (const tx of rows) {
    let candidates = [];
    let lookupError = null;
    try {
      const known = new Set((await pool.query(
        `SELECT token FROM transactions WHERE meter_number=$1 AND token IS NOT NULL`, [tx.meter_number]))
        .rows.map((r) => r.token));
      candidates = (await fetchRecords(tx.meter_number))
        .filter((r) => Number(r.rechargeAmount) === Number(tx.amount) && r.rechargePassword && !known.has(r.rechargePassword))
        .map((r) => ({
          rechargeNo: r.rechargeNo, token: r.rechargePassword, amount: r.rechargeAmount,
          waterVolume: r.waterVolume, rechargeTime: r.rechargeTime, status: r.rechargeStatus,
        }));
    } catch (e) {
      lookupError = e.message;
    }
    items.push({ ...tx, candidates, lookupError });
  }
  res.json({ ok: true, items });
}));

// Body: { action: "adopt", token } | { action: "retry" } | { action: "close", note }
// If no M-Pesa receipt is on file, also send { confirmedPaid: true, receipt: "XXXX" } after
// checking the Paybill statement.
app.post('/api/admin/review/:id', wrap(async (req, res) => {
  const id = req.params.id;
  if (!UUID.test(id)) return res.status(400).json({ ok: false, message: 'Invalid id' });
  const { action, token, receipt, confirmedPaid, note } = req.body || {};
  const cur = (await pool.query(`SELECT * FROM transactions WHERE id=$1`, [id])).rows[0];
  if (!cur || cur.status !== 'NEEDS_REVIEW') {
    return res.status(409).json({ ok: false, message: 'This transaction is not waiting for review.' });
  }

  if (action === 'close') {
    await pool.query(
      `UPDATE transactions SET status='FAILED', result_desc=$2, updated_at=now() WHERE id=$1`,
      [id, `Closed by admin: ${String(note || 'no note').slice(0, 200)}`]);
    return res.json({ ok: true });
  }
  if (action !== 'adopt' && action !== 'retry') {
    return res.status(400).json({ ok: false, message: 'Unknown action' });
  }

  // Both remaining actions give the customer water, so payment must be on record.
  if (!cur.mpesa_receipt) {
    if (confirmedPaid === true && receipt) {
      await pool.query(`UPDATE transactions SET mpesa_receipt=$2 WHERE id=$1`, [id, String(receipt)]);
    } else {
      return res.status(409).json({ ok: false, needsReceipt: true, message: 'No M-Pesa receipt on file. Check the Paybill statement, then send confirmedPaid: true and receipt.' });
    }
  }

  if (action === 'adopt') {
    if (!/^\d{20}$/.test(String(token || ''))) return res.status(400).json({ ok: false, message: 'token must be 20 digits' });
    const inRecords = (await fetchRecords(cur.meter_number)).some((r) => r.rechargePassword === token);
    if (!inRecords) return res.status(404).json({ ok: false, message: 'That token is not in this meter\'s recharge records.' });
    const used = await pool.query(`SELECT 1 FROM transactions WHERE token=$1`, [token]);
    if (used.rowCount) return res.status(409).json({ ok: false, message: 'That token already belongs to another transaction.' });
    await pool.query(
      `UPDATE transactions SET status='TOKEN_ISSUED', token=$2, last_error=NULL, updated_at=now() WHERE id=$1`,
      [id, token]);
    await enrichFromRecords(id, cur.meter_number, token);
    return res.json({ ok: true });
  }

  // retry: the person has checked the records and decided no token was issued
  await pool.query(
    `UPDATE transactions SET status='RETRY', attempts=0, next_retry_at=now(), updated_at=now() WHERE id=$1`, [id]);
  res.json({ ok: true, message: 'Queued. The worker will issue the token within 30 seconds.' });
}));


/* ------------------- admin: Hydro app features (meters, recharge, records) ------------------- */

const ADMIN_RECHARGE_ENABLED = String(process.env.ADMIN_RECHARGE_ENABLED || '').toLowerCase() === 'true';
const intOrNull = (v) => (v === '' || v == null || !Number.isInteger(Number(v)) ? null : Number(v));

async function audit(action, meter, detail, status = 'DONE') {
  const r = await pool.query(
    `INSERT INTO admin_actions (action, meter_number, detail, status) VALUES ($1,$2,$3,$4) RETURNING id`,
    [action, meter || null, JSON.stringify(detail || {}), status]);
  return r.rows[0].id;
}

app.get('/api/admin/features', (_req, res) => {
  res.json({ ok: true, rechargeEnabled: ADMIN_RECHARGE_ENABLED, pricePerM3: Number(PRICE_PER_M3),
    minAmount: Number(MIN_AMOUNT), maxAmount: Number(MAX_AMOUNT), companyId: HYDRO_COMPANY_ID, mpesaEnv: MPESA_ENV });
});

// Live meter list from Hydro (Device Info). Always scoped to our company.
app.post('/api/admin/hydro/meters', wrap(async (req, res) => {
  const b = req.body || {};
  const q = String(b.meterCode || '').trim();
  if (q && !/^\d{1,20}$/.test(q)) return res.status(400).json({ ok: false, message: 'Meter search must be digits only.' });
  const status = [0, 1, 2, 3].includes(Number(b.deviceStatus)) && b.deviceStatus !== '' && b.deviceStatus != null ? Number(b.deviceStatus) : undefined;
  const r = await hydro('POST', '/stsMeter/queryPage', {
    pageNum: Math.max(1, intOrNull(b.pageNum) || 1), pageSize: Math.min(50, Math.max(1, intOrNull(b.pageSize) || 20)),
    companyId: Number(HYDRO_COMPANY_ID), ...(q ? { meterCode: q } : {}), ...(status !== undefined ? { deviceStatus: status } : {}),
  });
  if (!r || r.code !== 0 || !r.data) return res.status(502).json({ ok: false, message: `Hydro: ${r && r.msg || 'no answer'}` });
  res.json({ ok: true, total: r.data.total ?? null, pages: r.data.pages ?? null, list: r.data.list || [] });
}));

// Meter counts by device status, from the full company list.
app.get('/api/admin/hydro/stats', wrap(async (_req, res) => {
  const all = await pullHydroMeters();
  const by = { 0: 0, 1: 0, 2: 0, 3: 0 };
  for (const m of all) if (by[m.deviceStatus] !== undefined) by[m.deviceStatus]++;
  res.json({ ok: true, total: all.length, offline: by[0], online: by[1], fault: by[2], maintenance: by[3] });
}));

app.get('/api/admin/hydro/meter/:code', wrap(async (req, res) => {
  const code = req.params.code;
  const known = CODE.test(code) && (await pool.query(`SELECT 1 FROM meters WHERE meter_code=$1`, [code])).rowCount;
  if (!known) return res.status(404).json({ ok: false, message: 'That meter is not in the Mauriskade registry.' });
  const m = await lookupOwnedMeter(code);
  if (!m) return res.status(404).json({ ok: false, message: 'Hydro does not return this meter.' });
  res.json({ ok: true, meter: m });
}));

// STS records (Hydro recharge history), scoped to our company.
app.post('/api/admin/hydro/records', wrap(async (req, res) => {
  const b = req.body || {};
  const body = { pageNum: Math.max(1, intOrNull(b.pageNum) || 1), pageSize: Math.min(50, Math.max(1, intOrNull(b.pageSize) || 20)),
    companyId: Number(HYDRO_COMPANY_ID), orderType: 0 };
  if (b.meterCode) { if (!/^\d{1,20}$/.test(String(b.meterCode))) return res.status(400).json({ ok: false, message: 'Meter search must be digits only.' }); body.meterCode = String(b.meterCode); }
  const st = intOrNull(b.rechargeStatus); if (st !== null && st >= 0 && st <= 3) body.rechargeStatus = st;
  if (b.paymentMethod) body.paymentMethod = String(b.paymentMethod).slice(0, 30);
  for (const k of ['startTime', 'endTime']) if (b[k]) body[k] = String(b[k]).slice(0, 19);
  const r = await hydro('POST', '/business/recharge/stsRecord/queryPage', body);
  if (!r || r.code !== 0 || !r.data) return res.status(502).json({ ok: false, message: `Hydro: ${r && r.msg || 'no answer'}` });
  res.json({ ok: true, total: r.data.total ?? null, list: r.data.list || [] });
}));

// Our own M-Pesa transactions (M-Pesa Records).
app.get('/api/admin/transactions', wrap(async (req, res) => {
  const q = String(req.query.q || '').trim();
  const status = String(req.query.status || '');
  const offset = Math.max(0, Number(req.query.offset) || 0);
  const { rows } = await pool.query(
    `SELECT id, meter_number, phone, amount, status, mpesa_receipt, result_desc, last_error, token, water_volume, created_at
       FROM transactions
      WHERE ($1 = '' OR meter_number ILIKE '%' || $1 || '%' OR phone LIKE '%' || $1 || '%' OR mpesa_receipt ILIKE '%' || $1 || '%')
        AND ($2 = '' OR status = $2)
      ORDER BY created_at DESC LIMIT 101 OFFSET $3`, [q, status, offset]);
  res.json({ ok: true, items: rows.slice(0, 100), more: rows.length > 100 });
}));

// Admin sends an M-Pesa prompt for a registered meter. Same path as a customer payment, so the
// callback, receipt check and token issuing are identical.
app.post('/api/admin/pay', payLimit, wrap(async (req, res) => {
  const meter = String((req.body && req.body.meterNumber) || '');
  const phone = normPhone(req.body && req.body.phone);
  const amount = Number(req.body && req.body.amount);
  if (!phone) return res.status(400).json({ ok: false, message: 'Enter a valid Safaricom number, like 0712 345 678.' });
  if (!validAmount(amount)) return res.status(400).json({ ok: false, message: `Enter a whole amount from KSh ${MIN_AMOUNT} to KSh ${MAX_AMOUNT}.` });
  if (!CODE.test(meter) || !(await pool.query(`SELECT 1 FROM meters WHERE meter_code=$1`, [meter])).rowCount) {
    return res.status(404).json({ ok: false, message: 'That meter is not in the Mauriskade registry.' });
  }
  const out = await startPayment({ meter, phone, amount });
  await audit('mpesa_prompt', meter, { amount, phone: phone.slice(0, 5) + '****' + phone.slice(-3), ok: out.body.ok === true });
  res.status(out.status).json(out.body);
}));

// Issue a token without M-Pesa (STS Recharge). Off unless ADMIN_RECHARGE_ENABLED=true.
// Needs the meter typed again and a reason; each attempt is written to the audit log first.
// An unclear Hydro answer is never retried here: check STS records before anything else.
app.post('/api/admin/recharge', wrap(async (req, res) => {
  if (!ADMIN_RECHARGE_ENABLED) return res.status(403).json({ ok: false, message: 'Manual recharge is switched off. Set ADMIN_RECHARGE_ENABLED=true on the backend to use it.' });
  const b = req.body || {};
  const meter = String(b.meterNumber || '');
  const reason = String(b.reason || '').trim();
  const byVolume = b.mode === 'volume';
  const value = Number(b.value);
  if (!CODE.test(meter) || !(await pool.query(`SELECT 1 FROM meters WHERE meter_code=$1`, [meter])).rowCount) {
    return res.status(404).json({ ok: false, message: 'That meter is not in the Mauriskade registry.' });
  }
  if (String(b.confirmMeter || '') !== meter) return res.status(400).json({ ok: false, message: 'Type the meter number again to confirm.' });
  if (reason.length < 8) return res.status(400).json({ ok: false, message: 'Give a reason of at least 8 characters.' });
  const maxVol = Math.floor((Number(MAX_AMOUNT) / Number(PRICE_PER_M3)) * 100) / 100;
  if (byVolume ? !(value >= 0.01 && value <= maxVol && Math.abs(value * 100 - Math.round(value * 100)) < 1e-9)
               : !(Number.isInteger(value) && value >= 1 && value <= Number(MAX_AMOUNT))) {
    return res.status(400).json({ ok: false, message: byVolume ? `Volume must be 0.01 to ${maxVol} m³, two decimals at most.` : `Amount must be a whole number from 1 to ${MAX_AMOUNT}.` });
  }
  const busy = await pool.query(`SELECT 1 FROM transactions WHERE meter_number=$1 AND status IN ('PAID','ISSUING','RETRY','NEEDS_REVIEW')`, [meter]);
  if (busy.rowCount) return res.status(409).json({ ok: false, message: 'A customer payment for this meter is still being processed or reviewed. Finish that first.' });
  const owned = await lookupOwnedMeter(meter).catch(() => null);
  if (!owned) return res.status(409).json({ ok: false, message: 'Hydro does not return this meter right now.' });

  const auditId = await audit('sts_recharge', meter, { mode: byVolume ? 'volume' : 'amount', value, reason: reason.slice(0, 300) }, 'STARTED');
  try {
    const r = byVolume
      ? await hydro('POST', '/api/recharge/sts/stsRecharge', { meterNumber: meter, waterVolume: value })
      : await hydro('POST', '/api/recharge/sts/amountRecharge', { meterNumber: meter, rechargeAmount: value });
    if (r.code === 0 && /^\d{20}$/.test(String(r.data))) {
      await pool.query(`UPDATE admin_actions SET status='DONE', detail = detail || $2::jsonb WHERE id=$1`, [auditId, JSON.stringify({ token: String(r.data) })]);
      return res.json({ ok: true, token: String(r.data) });
    }
    await pool.query(`UPDATE admin_actions SET status='REFUSED', detail = detail || $2::jsonb WHERE id=$1`, [auditId, JSON.stringify({ error: `${r.code}: ${r.msg}` })]);
    return res.status(502).json({ ok: false, message: `Hydro refused it (${r.code}): ${r.msg}` });
  } catch (e) {
    await pool.query(`UPDATE admin_actions SET status='AMBIGUOUS', detail = detail || $2::jsonb WHERE id=$1`, [auditId, JSON.stringify({ error: e.message })]);
    return res.status(504).json({ ok: false, message: 'No clear answer from Hydro. A token may have been issued. Check STS records for this meter before trying again.' });
  }
}));

app.get('/api/admin/audit', wrap(async (_req, res) => {
  const { rows } = await pool.query(`SELECT id, action, meter_number, status, detail, created_at FROM admin_actions ORDER BY created_at DESC LIMIT 50`);
  res.json({ ok: true, items: rows });
}));

app.get('/health', (_req, res) => res.json({ ok: true }));

// Safe, non-payment Daraja connectivity check. Never exposes credentials or sends an STK prompt.
app.get('/health/mpesa', async (_req, res) => {
  try {
    await darajaToken();
    res.json({ ok: true, darajaAuth: true });
  } catch (e) {
    log('DARAJA_AUTH_CHECK_FAILED', e.message);
    res.status(503).json({ ok: false, darajaAuth: false });
  }
});

/* ------------------- background worker: retries + reconcile ------------------- */

let working = false;
async function worker() {
  if (working) return;
  working = true;
  try {
    // 0a. Paid but the process stopped before asking Hydro (restart or deploy between the two steps).
    //     Nothing was sent to Hydro yet, so issuing now is safe.
    const stuckPaid = await pool.query(
      `SELECT id FROM transactions WHERE status='PAID' AND updated_at < now() - interval '1 minute' LIMIT 10`);
    for (const r of stuckPaid.rows) await issueToken(r.id);

    // 0b. Stuck in ISSUING: the process stopped while the Hydro call was in flight. A token may or
    //     may not exist, so a person checks the Hydro records instead of us retrying blindly.
    await pool.query(
      `UPDATE transactions SET status='NEEDS_REVIEW', last_error='ambiguous: stopped while issuing the token', updated_at=now()
        WHERE status='ISSUING' AND updated_at < now() - interval '3 minutes'`);

    // 1. retry transactions Hydro told us to retry
    const due = await pool.query(
      `SELECT id FROM transactions WHERE status='RETRY' AND next_retry_at <= now() LIMIT 10`);
    for (const r of due.rows) await issueToken(r.id);

    // 2. callback never arrived? ask Daraja directly
    const stale = await pool.query(
      `SELECT id, checkout_request_id FROM transactions
        WHERE status='PENDING_PAYMENT' AND checkout_request_id IS NOT NULL
          AND created_at < now() - interval '90 seconds' AND created_at > now() - interval '30 minutes'
        ORDER BY created_at LIMIT 20`);
    for (const r of stale.rows) {
      try {
        const q = await stkQuery(r.checkout_request_id);
        if (q.ResultCode === undefined) continue; // still being processed
        if (String(q.ResultCode) === '0') {
          const c = await pool.query(
            `UPDATE transactions SET status='PAID', updated_at=now()
              WHERE id=$1 AND status='PENDING_PAYMENT' RETURNING id`, [r.id]);
          if (c.rows[0]) await issueToken(r.id);
        } else {
          await pool.query(
            `UPDATE transactions SET status='FAILED', result_desc=$2, updated_at=now()
              WHERE id=$1 AND status='PENDING_PAYMENT'`, [r.id, q.ResultDesc || 'Payment not completed']);
        }
      } catch (e) {
        // "Still being processed" comes back as an HTTP error; anything else is worth a log line.
        if (!/being processed/i.test(e.message)) log('stk query failed', r.id, e.message);
      }
    }

    // 3. anything unresolved after 30 minutes goes to a person
    await pool.query(
      `UPDATE transactions SET status='NEEDS_REVIEW', last_error='No callback or query result after 30 min', updated_at=now()
        WHERE status='PENDING_PAYMENT' AND created_at < now() - interval '30 minutes'`);

    // 4. housekeeping
    await pool.query(`DELETE FROM sessions WHERE expires_at < now()`);
  } catch (e) {
    log('worker error', e.message);
  } finally {
    working = false;
  }
}

(async () => {
  try {
    await pool.query(fs.readFileSync(path.join(__dirname, 'schema.sql'), 'utf8'));
  } catch (e) {
    console.error('Could not prepare the database:', e.message);
    process.exit(1);
  }
  setInterval(worker, 30000);
  app.listen(PORT, () => log(`hydro-pay listening on :${PORT} (${MPESA_ENV})`));
})();
