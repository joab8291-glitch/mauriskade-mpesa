const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const { PGlite } = require('@electric-sql/pglite');
const { registerRentWorkflowRoutes, runRentAutomation, parseCsv, csvDate } = require('../rent-workflows');
const { createReceipt, generateCharges } = require('../rent');

const schema = fs.readFileSync(path.join(__dirname, '..', 'schema.sql'), 'utf8');
const today = () => new Date(Date.now() + 3 * 3600000).toISOString().slice(0, 10);
const addCalendarMonth = value => { const d=new Date(value+'T00:00:00Z'),day=d.getUTCDate();d.setUTCDate(1);d.setUTCMonth(d.getUTCMonth()+1);d.setUTCDate(Math.min(day,new Date(Date.UTC(d.getUTCFullYear(),d.getUTCMonth()+1,0)).getUTCDate()));return d.toISOString().slice(0,10); };

async function fixture(env = {}) {
  const db = new PGlite();
  const query = async (sql, args = []) => {
    const r = await db.query(sql, args);
    return { ...r, rowCount: r.rows.length ? r.rows.length : (r.affectedRows ?? 0) };
  };
  const pool = { query, connect: async () => ({ query, release() {} }) };
  await db.exec('CREATE ROLE anon; CREATE ROLE authenticated;');
  await db.exec(schema);
  const routes = {};
  const app = {
    get: (p, ...h) => routes['GET ' + p] = h,
    post: (p, ...h) => routes['POST ' + p] = h,
    patch: (p, ...h) => routes['PATCH ' + p] = h,
  };
  registerRentWorkflowRoutes({ app, pool, env });
  async function call(method, url, body = {}, role = 'manager', id = 'manager-1', headers = {}) {
    const [pathname, search=''] = url.split('?');
    const query = Object.fromEntries(new URLSearchParams(search));
    const found = Object.entries(routes).find(([key]) => {
      const [m, pattern] = key.split(' ');
      const re = new RegExp('^' + pattern.split('/').map(x => x.startsWith(':') ? '[^/]+' : x.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')).join('/') + '$');
      return m === method && re.test(pathname);
    });
    assert.ok(found, `Route not registered: ${method} ${url}`);
    const pattern = found[0].split(' ')[1], actual = pathname.split('/'), params = {};
    pattern.split('/').forEach((part, i) => { if (part.startsWith(':')) params[part.slice(1)] = actual[i]; });
    const req = { body, params, query, adminActor: { id, displayName: id, role }, get: name => headers[String(name).toLowerCase()] || '' };
    const res = {
      statusCode: 200, body: null, headers: {},
      status(n) { this.statusCode = n; return this; },
      json(v) { this.body = v; return this; },
      send(v) { this.body = v; return this; },
      setHeader(k, v) { this.headers[k] = v; },
    };
    let i = 0;
    const next = async () => { const handler = found[1][i++]; if (handler) await handler(req, res, next); };
    await next();
    return res;
  }
  async function lease({ meter = 'TEST-1', tenant = 'Test Tenant', unit = 'A1', ref = 'RENT-TEST1', rent = 5000, deposit = 0, start = today() } = {}) {
    await query('INSERT INTO meters(meter_code,tenant_name,flat,phone) VALUES($1,$2,$3,$4) ON CONFLICT(meter_code) DO NOTHING', [meter, tenant, unit, '254700000001']);
    return (await query(`INSERT INTO rent_leases(meter_code,tenant_name,unit_label,rent_account_ref,rent_amount,billing_frequency,start_date,due_day,security_deposit)
      VALUES($1,$2,$3,$4,$5,'monthly',$6::date,1,$7) RETURNING *`, [meter, tenant, unit, ref, rent, start, deposit])).rows[0];
  }
  return { db, pool, query, call, lease, close: () => db.close() };
}

test('CSV statement parser handles quoted fields and rejects malformed dates', () => {
  const rows = parseCsv('date,amount,reference,description\n2026-11-28,1500,ABC-1,"Rent, unit A1"\n2026-11-29,2500,ABC-2,"Quoted ""receipt"""');
  assert.equal(rows.length, 3);
  assert.equal(rows[1][3], 'Rent, unit A1');
  assert.equal(rows[2][3], 'Quoted "receipt"');
  assert.equal(csvDate('28/11/2026'), '2026-11-28');
  assert.equal(csvDate('2026-02-31'), null);
  assert.throws(() => parseCsv('a,b\n"unclosed,1'), /unclosed/);
});

test('deposit refunds require independent approval and actual payment reference', async () => {
  const f = await fixture();
  try {
    const l = await f.lease({ deposit: 10000 });
    let r = await f.call('POST', `/api/admin/rent/deposits/${l.id}/receive`, { amount: 10000, reference: 'DEP-TEST-1', note: 'Matched to verified bank credit' }, 'finance', 'finance-maker');
    assert.equal(r.statusCode, 201);
    r = await f.call('POST', '/api/admin/rent/approvals', { actionType: 'deposit_refund', leaseId: l.id, payload: { amount: 2500, note: 'Approved partial deposit return' }, reason: 'Move-out inspection completed and refund amount confirmed' }, 'manager', 'manager-maker');
    assert.equal(r.statusCode, 201);
    const approvalId = r.body.approval.id;
    r = await f.call('POST', `/api/admin/rent/approvals/${approvalId}/decide`, { decision: 'approved', note: 'Verified inspection and deposit ledger' }, 'manager', 'manager-maker');
    assert.equal(r.statusCode, 409, 'maker cannot approve their own request');
    r = await f.call('POST', `/api/admin/rent/approvals/${approvalId}/decide`, { decision: 'approved', note: 'Verified inspection and deposit ledger' }, 'finance', 'finance-checker');
    assert.equal(r.statusCode, 200);
    let pending = (await f.query("SELECT id FROM rent_deposit_transactions WHERE lease_id=$1 AND kind='refund' AND status='approved_pending'", [l.id])).rows[0];
    assert.ok(pending);
    r = await f.call('POST', `/api/admin/rent/deposits/refunds/${pending.id}/mark-paid`, { externalReference: 'BANK-DEP-REFUND-1', note: 'Bank transfer verified' }, 'finance', 'finance-checker');
    assert.equal(r.statusCode, 200);
    const deposit = (await f.query("SELECT status,reference FROM rent_deposit_transactions WHERE id=$1", [pending.id])).rows[0];
    assert.equal(deposit.status, 'paid');
    assert.equal(deposit.reference, 'BANK-DEP-REFUND-1');
  } finally { await f.close(); }
});

test('approved payment reversal preserves the receipt and releases allocations', async () => {
  const f = await fixture();
  try {
    const l = await f.lease();
    const charge = (await f.query("INSERT INTO rent_charges(lease_id,period_start,period_end,due_date,amount,charge_type) VALUES($1,current_date-interval '1 month',current_date-interval '1 day',current_date-interval '1 month',5000,'rent') RETURNING id", [l.id])).rows[0];
    const pay = (await f.query("INSERT INTO rent_payments(lease_id,rent_account_ref,amount,method,status,transaction_time,external_reference,verified_by,verification_note) VALUES($1,$2,5000,'manual','confirmed',current_date,'REV-TEST-1','finance','Verified') RETURNING id", [l.id, l.rent_account_ref])).rows[0];
    await f.query('INSERT INTO rent_allocations(payment_id,charge_id,amount) VALUES($1,$2,5000)', [pay.id, charge.id]);
    await createReceipt(f.pool, pay.id);
    let r = await f.call('POST', '/api/admin/rent/approvals', { actionType: 'payment_reversal', leaseId: l.id, payload: { paymentId: pay.id }, reason: 'Duplicate bank posting confirmed against original statement' }, 'manager', 'maker-2');
    assert.equal(r.statusCode, 201);
    r = await f.call('POST', `/api/admin/rent/approvals/${r.body.approval.id}/decide`, { decision: 'approved', note: 'Duplicate confirmed; reverse original posting' }, 'finance', 'checker-2');
    assert.equal(r.statusCode, 200);
    assert.equal((await f.query('SELECT status FROM rent_payments WHERE id=$1', [pay.id])).rows[0].status, 'reversed');
    assert.ok((await f.query('SELECT reversed_at FROM rent_allocations WHERE payment_id=$1', [pay.id])).rows[0].reversed_at);
    assert.equal((await f.query('SELECT status FROM rent_receipts WHERE payment_id=$1', [pay.id])).rows[0].status, 'reversed');
  } finally { await f.close(); }
});

test('bank statement import stages, matches and posts verified transactions once', async () => {
  const f = await fixture();
  try {
    const l = await f.lease();
    await f.query("INSERT INTO rent_payment_reports(lease_id,transaction_code,amount,description) VALUES($1,'BANK-TEST-1',3000,'Tenant reported bank transfer')",[l.id]);
    let r = await f.call('POST', '/api/admin/rent/bank-imports', { fileName: 'bank.csv', csv: 'date,amount,reference,account_reference,description\n2026-11-28,3000,BANK-TEST-1,RENT-TEST1,Rent transfer' }, 'finance', 'finance-1');
    assert.equal(r.statusCode, 201);
    const line = (await f.query('SELECT id FROM rent_bank_statement_lines WHERE import_id=$1', [r.body.importId])).rows[0];
    r = await f.call('POST', `/api/admin/rent/bank-lines/${line.id}/match`, { leaseId: l.id, note: 'Account and amount match the original statement' }, 'finance', 'finance-1');
    assert.equal(r.statusCode, 200);
    r = await f.call('POST', `/api/admin/rent/bank-lines/${line.id}/post`, { verificationNote: 'Original bank statement checked and approved' }, 'finance', 'finance-1');
    assert.equal(r.statusCode, 200);
    const payment = (await f.query("SELECT method,status FROM rent_payments WHERE external_reference='BANK-TEST-1'", [])).rows[0];
    assert.equal(payment.method, 'bank_import');
    assert.equal(payment.status, 'allocated');
    assert.equal((await f.query("SELECT status FROM rent_payment_reports WHERE lease_id=$1 AND transaction_code='BANK-TEST-1'",[l.id])).rows[0].status,'resolved');
    assert.equal((await f.query("SELECT count(*)::int n FROM rent_payments WHERE external_reference='BANK-TEST-1'", [])).rows[0].n, 1);
  } finally { await f.close(); }
});

test('final move-out proration releases over-allocation and approved rent credit refund', async () => {
  const f = await fixture();
  try {
    const start = (await f.query("SELECT date_trunc('month',current_date)::date d", [])).rows[0].d;
    const endMonth = (await f.query("SELECT (date_trunc('month',current_date)+interval '1 month - 1 day')::date d", [])).rows[0].d;
    const l = await f.lease({ meter: 'PRORATE-1', ref: 'RENT-PROR1', start });
    const tenantUser=(await f.query("INSERT INTO users(meter_code,rent_lease_id,username,password_hash) VALUES($1,$2,'former.tenant','scrypt$test$hash') RETURNING id",['PRORATE-1',l.id])).rows[0];
    await f.query("INSERT INTO sessions(token_hash,user_id,expires_at) VALUES('former-tenant-session',$1,now()+interval '1 day')",[tenantUser.id]);
    const charge = (await f.query("INSERT INTO rent_charges(lease_id,period_start,period_end,due_date,amount,charge_type) VALUES($1,$2,$3,$3,5000,'rent') RETURNING id", [l.id, start, endMonth])).rows[0];
    const pay = (await f.query("INSERT INTO rent_payments(lease_id,rent_account_ref,amount,method,status,transaction_time,external_reference,verified_by,verification_note) VALUES($1,$2,5000,'manual','confirmed',current_date,'PRORATE-PAY-1','finance','Full rent received') RETURNING id", [l.id, l.rent_account_ref])).rows[0];
    await f.query('INSERT INTO rent_allocations(payment_id,charge_id,amount) VALUES($1,$2,5000)', [pay.id, charge.id]);
    const futureStart = new Date(new Date(endMonth instanceof Date ? endMonth : endMonth+'T00:00:00Z').getTime()+86400000).toISOString().slice(0,10);
    const futureEnd = new Date(new Date(futureStart+'T00:00:00Z').getTime()+29*86400000).toISOString().slice(0,10);
    const futureCharge=(await f.query("INSERT INTO rent_charges(lease_id,period_start,period_end,due_date,amount,charge_type) VALUES($1,$2::date,$3::date,$2::date,1500,'rent') RETURNING id",[l.id,futureStart,futureEnd])).rows[0];
    const advance=(await f.query("INSERT INTO rent_payments(lease_id,rent_account_ref,amount,method,status,transaction_time,external_reference,verified_by,verification_note) VALUES($1,$2,1500,'manual','confirmed',current_date,'ADVANCE-PRORATE-1','finance','Verified advance rent') RETURNING id",[l.id,l.rent_account_ref])).rows[0];
    await f.query('INSERT INTO rent_allocations(payment_id,charge_id,amount) VALUES($1,$2,1500)',[advance.id,futureCharge.id]);
    const end = new Date(new Date(start instanceof Date ? start : start + 'T00:00:00Z').getTime() + 14 * 86400000).toISOString().slice(0, 10);
    let r = await f.call('POST', `/api/admin/rent/settlements/${l.id}`, { endDate: end }, 'manager', 'settlement-maker');
    assert.equal(r.statusCode, 201);
    assert.equal((await f.query('SELECT disabled FROM users WHERE id=$1',[tenantUser.id])).rows[0].disabled,true,'tenant portal is disabled as soon as move-out settlement is prepared');
    assert.equal((await f.query('SELECT count(*)::int n FROM sessions WHERE user_id=$1',[tenantUser.id])).rows[0].n,0,'all existing tenant sessions are revoked');
    const settlementApproval = r.body.approval.id, creditApproval = r.body.creditRefundApproval.id;
    r = await f.call('POST', `/api/admin/rent/approvals/${settlementApproval}/decide`, { decision: 'approved', note: 'Move-out proration and final ledger checked' }, 'finance', 'settlement-checker');
    assert.equal(r.statusCode, 200);
    assert.equal((await f.query('SELECT disabled FROM users WHERE id=$1',[tenantUser.id])).rows[0].disabled,true,'approved former tenant remains disabled');
    assert.equal((await f.query('SELECT status FROM rent_leases WHERE id=$1',[l.id])).rows[0].status,'ended');
    const pdf = await f.call('GET', `/api/admin/rent/settlements/${r.body.approval?.payload?.settlementId || (await f.query('SELECT id FROM rent_settlements WHERE lease_id=$1',[l.id])).rows[0].id}/statement.pdf`, {}, 'finance', 'settlement-checker');
    assert.equal(pdf.statusCode, 200);
    assert.equal(pdf.body.subarray(0,4).toString(), '%PDF');
    const newCharge = Number((await f.query('SELECT amount FROM rent_charges WHERE id=$1', [charge.id])).rows[0].amount);
    const newAllocation = Number((await f.query('SELECT amount FROM rent_allocations WHERE payment_id=$1 AND charge_id=$2 AND reversed_at IS NULL', [pay.id, charge.id])).rows[0].amount);
    assert.ok(newCharge < 5000);
    assert.equal(newAllocation, newCharge);
    assert.ok((await f.query('SELECT count(*)::int n FROM rent_allocation_adjustments', [])).rows[0].n > 0);
    r = await f.call('POST', `/api/admin/rent/approvals/${creditApproval}/decide`, { decision: 'approved', note: 'Rent credit refund independently approved' }, 'finance', 'settlement-checker');
    assert.equal(r.statusCode, 200);
    const refund = (await f.query('SELECT id,amount FROM rent_credit_refunds WHERE lease_id=$1', [l.id])).rows[0];
    assert.equal(Number(refund.amount), 5000 - newCharge + 1500);
    assert.ok((await f.query('SELECT voided_at FROM rent_charges WHERE id=$1',[futureCharge.id])).rows[0].voided_at);
    assert.ok((await f.query('SELECT reversed_at FROM rent_allocations WHERE payment_id=$1',[advance.id])).rows[0].reversed_at);
    r = await f.call('POST', `/api/admin/rent/credit-refunds/${refund.id}/mark-paid`, { externalReference: 'BANK-PRORATE-REFUND', note: 'Refund transfer checked against bank statement' }, 'finance', 'settlement-checker');
    assert.equal(r.statusCode, 200);
  } finally { await f.close(); }
});

test('reminders are held without a configured provider and seven-day arrears create staff follow-up', async () => {
  const f = await fixture();
  try {
    const l = await f.lease({ meter: 'REMINDER-1', ref: 'RENT-REM1' });
    const due = new Date(new Date(today() + 'T00:00:00Z').getTime() - 7 * 86400000).toISOString().slice(0, 10);
    const start = new Date(new Date(due + 'T00:00:00Z').getTime() - 20 * 86400000).toISOString().slice(0, 10);
    const periodEnd = new Date(new Date(due + 'T00:00:00Z').getTime() - 10 * 86400000).toISOString().slice(0, 10);
    await f.query("INSERT INTO rent_charges(lease_id,period_start,period_end,due_date,amount,charge_type) VALUES($1,$2::date,$3::date,$4::date,3000,'rent')", [l.id, start, periodEnd, due]);
    await runRentAutomation(f.pool, {});
    assert.equal((await f.query("SELECT status FROM rent_reminder_jobs WHERE lease_id=$1 AND reminder_type='overdue_7'", [l.id])).rows[0].status, 'blocked_config');
    assert.ok((await f.query("SELECT count(*)::int n FROM rent_followup_tasks WHERE lease_id=$1 AND task_type='overdue_followup'", [l.id])).rows[0].n > 0);
  } finally { await f.close(); }
});

test('encrypted backup can be decrypted and restored into temporary staging tables', async () => {
  const key = 'test-backup-encryption-key-longer-than-32-chars';
  const f = await fixture({ RENT_BACKUP_ENCRYPTION_KEY: key });
  try {
    const r = await f.call('GET', '/api/admin/rent/backups/export', {}, 'owner', 'legacy-owner');
    assert.equal(r.statusCode, 200);
    assert.ok(Buffer.isBuffer(r.body));
    const verified = await f.call('POST', '/api/admin/rent/backups/verify', { fileBase64: r.body.toString('base64') }, 'owner', 'legacy-owner');
    assert.equal(verified.statusCode, 200);
    assert.equal(verified.body.verified, true);
    assert.match(verified.body.mode, /temporary-table restore test/);
  } finally { await f.close(); }
});

test('unit transfer preserves tenancy history and deposit transfer requires approval', async () => {
  const f = await fixture();
  try {
    await f.query("INSERT INTO meters(meter_code,tenant_name,flat,phone) VALUES('OLD-UNIT','Moving Tenant','A1','254700000011'),('NEW-UNIT','Previous Tenant','A2','254700000012')");
    const property = (await f.query("INSERT INTO properties(name) VALUES('Transfer Property') RETURNING id", [])).rows[0];
    await f.query("INSERT INTO property_units(property_id,meter_code,unit_label) VALUES($1,'OLD-UNIT','A1'),($1,'NEW-UNIT','A2')", [property.id]);
    const l = (await f.query("INSERT INTO rent_leases(meter_code,tenant_name,unit_label,rent_account_ref,rent_amount,billing_frequency,start_date,due_day,security_deposit) VALUES('OLD-UNIT','Moving Tenant','A1','RENT-OLD01',5000,'monthly',current_date-interval '20 days',1,5000) RETURNING *", [])).rows[0];
    await f.query("INSERT INTO rent_deposit_transactions(lease_id,kind,amount,reference,note,created_by) VALUES($1,'received',5000,'DEP-OLD-UNIT','Verified security deposit','owner')", [l.id]);
    const moveIn = new Date(Date.now() + 3 * 3600000 + 86400000).toISOString().slice(0, 10);
    const futureEnd = new Date(new Date(moveIn+'T00:00:00Z').getTime()+30*86400000).toISOString().slice(0,10);
    const futureCharge=(await f.query("INSERT INTO rent_charges(lease_id,period_start,period_end,due_date,amount,charge_type) VALUES($1,$2::date,$3::date,$2::date,2000,'rent') RETURNING id",[l.id,moveIn,futureEnd])).rows[0];
    const advance=(await f.query("INSERT INTO rent_payments(lease_id,rent_account_ref,amount,method,status,transaction_time,external_reference,verified_by,verification_note) VALUES($1,$2,2000,'manual','confirmed',current_date,'ADVANCE-OLD-UNIT','finance','Verified advance rent') RETURNING id",[l.id,l.rent_account_ref])).rows[0];
    await f.query('INSERT INTO rent_allocations(payment_id,charge_id,amount) VALUES($1,$2,2000)',[advance.id,futureCharge.id]);
    let r = await f.call('POST', `/api/admin/rent/leases/${l.id}/transfer`, { newMeterCode: 'NEW-UNIT', newUnitLabel: 'A2', newRentAccountRef: 'RENT-NEW01', rentAmount: 6000, billingFrequency: 'monthly', startDate: moveIn, dueDay: 1 }, 'manager', 'property-manager');
    assert.equal(r.statusCode, 201);
    assert.ok(r.body.depositTransferApproval);
    assert.ok(r.body.creditTransferApproval);
    assert.equal(Number(r.body.newLease.security_deposit), 5000);
    const newLeaseId = r.body.newLease.id;
    r = await f.call('POST', `/api/admin/rent/approvals/${r.body.depositTransferApproval.id}/decide`, { decision: 'approved', note: 'Deposit transfer checked against the old tenancy ledger' }, 'finance', 'finance-checker');
    assert.equal(r.statusCode, 200);
    const oldBalance = (await f.query("SELECT COALESCE(sum(CASE WHEN kind IN ('received','transfer_in') THEN amount ELSE -amount END),0)::int n FROM rent_deposit_transactions WHERE lease_id=$1", [l.id])).rows[0].n;
    const newBalance = (await f.query("SELECT COALESCE(sum(CASE WHEN kind IN ('received','transfer_in') THEN amount ELSE -amount END),0)::int n FROM rent_deposit_transactions WHERE lease_id=$1", [newLeaseId])).rows[0].n;
    assert.equal(Number(oldBalance), 0);
    assert.equal(Number(newBalance), 5000);
    const creditApprovalId = (await f.query("SELECT id FROM rent_approvals WHERE action_type='rent_credit_transfer' AND lease_id=$1 ORDER BY created_at DESC LIMIT 1",[l.id])).rows[0].id;
    r = await f.call('POST', `/api/admin/rent/approvals/${creditApprovalId}/decide`, { decision: 'approved', note: 'Unused rent credit transferred to the new tenancy' }, 'finance', 'finance-checker');
    assert.equal(r.statusCode, 200);
    const newLeaseIdForCredit=(await f.query("SELECT id FROM rent_leases WHERE rent_account_ref='RENT-NEW01'",[])).rows[0].id;
    assert.equal((await f.query("SELECT count(*)::int n FROM rent_credit_transfers WHERE from_lease_id=$1 AND to_lease_id=$2",[l.id,newLeaseIdForCredit])).rows[0].n,1);
    const movedCredit=(await f.query("SELECT COALESCE(sum(amount),0)::int n FROM rent_payments WHERE lease_id=$1 AND method='credit_adjustment'",[newLeaseIdForCredit])).rows[0].n;
    assert.equal(Number(movedCredit),2000);
  } finally { await f.close(); }
});

test('payment plans require approval, generate installments and can be marked paid against allocated payments', async () => {
  const f = await fixture();
  try {
    const l = await f.lease({ meter: 'PLAN-1', ref: 'RENT-PLAN1' });
    const start = today();
    let r = await f.call('POST', `/api/admin/rent/payment-plans/${l.id}`, { totalAmount: 6000, installmentAmount: 3000, frequency: 'weekly', startDate: start, reason: 'Tenant requested a structured arrears repayment schedule' }, 'manager', 'plan-maker');
    assert.equal(r.statusCode, 201);
    const planId = r.body.plan.id, approvalId = r.body.approval.id;
    r = await f.call('POST', `/api/admin/rent/approvals/${approvalId}/decide`, { decision: 'approved', note: 'Repayment schedule reviewed and approved' }, 'finance', 'plan-checker');
    assert.equal(r.statusCode, 200);
    const installments = (await f.query('SELECT * FROM rent_payment_plan_installments WHERE plan_id=$1 ORDER BY due_date', [planId])).rows;
    assert.equal(installments.length, 2);
    const charge = (await f.query("INSERT INTO rent_charges(lease_id,period_start,period_end,due_date,amount,charge_type) VALUES($1,current_date,current_date,current_date,3000,'rent') RETURNING id", [l.id])).rows[0];
    const payment = (await f.query("INSERT INTO rent_payments(lease_id,rent_account_ref,amount,method,status,transaction_time,external_reference,verified_by,verification_note) VALUES($1,$2,3000,'manual','confirmed',current_date,'PLAN-PAY-1','finance','Verified plan installment') RETURNING id", [l.id, l.rent_account_ref])).rows[0];
    await f.query('INSERT INTO rent_allocations(payment_id,charge_id,amount) VALUES($1,$2,3000)', [payment.id, charge.id]);
    r = await f.call('POST', `/api/admin/rent/payment-plans/${planId}/installments/${installments[0].id}/mark-paid`, { paymentId: payment.id, note: 'Confirmed payment allocated to the scheduled installment' }, 'finance', 'finance-checker');
    assert.equal(r.statusCode, 200);
    assert.equal((await f.query('SELECT status FROM rent_payment_plan_installments WHERE id=$1', [installments[0].id])).rows[0].status, 'paid');
  } finally { await f.close(); }
});

test('scheduled rent increase preserves historical billing and changes future periods only', async () => {
  const f = await fixture();
  try {
    const start = (await f.query("SELECT (current_date-interval '60 days')::date d", [])).rows[0].d;
    const l = await f.lease({ meter: 'CHANGE-1', ref: 'RENT-CHANGE1', rent: 5000, start });
    const effective = today();
    let r = await f.call('POST', `/api/admin/rent/leases/${l.id}/scheduled-changes`, { effectiveDate: new Date(Date.now() + 3 * 3600000 + 86400000).toISOString().slice(0, 10), newRentAmount: 7000 }, 'manager', 'rent-manager');
    assert.equal(r.statusCode, 201);
    await f.query('UPDATE rent_scheduled_changes SET effective_date=$2::date WHERE id=$1', [r.body.change.id, effective]);
    await runRentAutomation(f.pool, {});
    const updated = (await f.query('SELECT rent_amount FROM rent_leases WHERE id=$1', [l.id])).rows[0];
    assert.equal(Number(updated.rent_amount), 7000);
    const oldPeriods = (await f.query("SELECT count(*)::int n FROM rent_charges WHERE lease_id=$1 AND period_start<$2::date AND amount=5000", [l.id, effective])).rows[0].n;
    const futurePeriods = (await f.query("SELECT count(*)::int n FROM rent_charges WHERE lease_id=$1 AND period_start>=$2::date AND amount=7000", [l.id, effective])).rows[0].n;
    assert.ok(oldPeriods > 0, 'historical periods remain at the original rent');
    assert.equal(futurePeriods, 0, 'unallocated future periods are voided now and regenerated at the new rate when the next billing period begins');
    assert.ok((await f.query('SELECT count(*)::int n FROM rent_charges WHERE lease_id=$1 AND period_start>=$2::date AND voided_at IS NOT NULL',[l.id,effective])).rows[0].n>0);
    assert.equal((await f.query('SELECT status FROM rent_scheduled_changes WHERE id=$1', [r.body.change.id])).rows[0].status, 'applied');
  } finally { await f.close(); }
});

test('approved formal notices are sent only through a configured provider and delivery callback updates history', async () => {
  const env = { RENT_NOTIFICATION_WEBHOOK_URL: 'https://notification-provider.invalid/send', RENT_NOTIFICATION_WEBHOOK_SECRET: 'notify-secret', CALLBACK_BASE_URL: 'https://api.mauriskade.co.ke' };
  const f = await fixture(env);
  const originalFetch = global.fetch;
  try {
    const l = await f.lease({ meter: 'NOTICE-1', ref: 'RENT-NOTICE1' });
    let r = await f.call('POST', `/api/admin/rent/notices/${l.id}`, { title: 'Rent arrears notice', body: 'Please contact the office about the outstanding rent balance.' }, 'manager', 'notice-maker');
    assert.equal(r.statusCode, 201);
    const noticeId = r.body.notice.id, approvalId = r.body.approval.id;
    r = await f.call('POST', `/api/admin/rent/approvals/${approvalId}/decide`, { decision: 'approved', note: 'Notice text and account balance reviewed' }, 'finance', 'notice-checker');
    assert.equal(r.statusCode, 200);
    global.fetch = async () => ({ ok: true, status: 200, text: async () => JSON.stringify({ messageId: 'provider-notice-1' }) });
    r = await f.call('POST', `/api/admin/rent/notices/${noticeId}/send`, {}, 'finance', 'notice-checker');
    assert.equal(r.statusCode, 200);
    assert.equal((await f.query("SELECT status FROM rent_communication_log WHERE provider_reference='provider-notice-1'", [])).rows[0].status, 'sent');
    r = await f.call('POST', '/api/rent/notifications/delivery', { providerReference: 'provider-notice-1', status: 'delivered' }, 'manager', 'callback', { 'x-notification-secret': 'notify-secret' });
    assert.equal(r.statusCode, 200);
    assert.equal((await f.query("SELECT status FROM rent_communication_log WHERE provider_reference='provider-notice-1'", [])).rows[0].status, 'delivered');
  } finally { global.fetch = originalFetch; await f.close(); }
});

test('owner can create individual staff accounts with a one-time temporary password', async () => {
  const f = await fixture();
  try {
    const r = await f.call('POST', '/api/admin/staff', { username: 'finance.operator', displayName: 'Finance Operator', role: 'finance' }, 'owner', 'legacy-owner');
    assert.equal(r.statusCode, 201);
    assert.equal(r.body.staff.role, 'finance');
    assert.ok(r.body.temporaryPassword.length >= 20);
    const row = (await f.query("SELECT role,must_change_password,active FROM admin_staff WHERE username='finance.operator'", [])).rows[0];
    assert.equal(row.role, 'finance');
    assert.equal(row.must_change_password, true);
    assert.equal(row.active, true);
  } finally { await f.close(); }
});

test('rejecting a proposed move-out restores the original full-period charge and tenancy dates', async () => {
  const f = await fixture();
  try {
    const start = (await f.query("SELECT (current_date-interval '15 days')::date d", [])).rows[0].d;
    const l = await f.lease({ meter: 'REJECT-SETTLE', ref: 'RENT-REJ01', start, rent: 8000 });
    const tenantUser=(await f.query("INSERT INTO users(meter_code,rent_lease_id,username,password_hash) VALUES($1,$2,'reject.tenant','scrypt$test$hash') RETURNING id",['REJECT-SETTLE',l.id])).rows[0];
    await f.query("INSERT INTO sessions(token_hash,user_id,expires_at) VALUES('rejected-tenant-session',$1,now()+interval '1 day')",[tenantUser.id]);
    const end = today();
    let r = await f.call('POST', `/api/admin/rent/settlements/${l.id}`, { endDate: end }, 'manager', 'settlement-maker');
    assert.equal(r.statusCode, 201);
    assert.equal((await f.query('SELECT disabled FROM users WHERE id=$1',[tenantUser.id])).rows[0].disabled,true);
    assert.equal((await f.query('SELECT count(*)::int n FROM sessions WHERE user_id=$1',[tenantUser.id])).rows[0].n,0);
    const partial = (await f.query('SELECT id,amount,period_end FROM rent_charges WHERE lease_id=$1 AND voided_at IS NULL ORDER BY period_start DESC LIMIT 1', [l.id])).rows[0];
    assert.ok(Number(partial.amount) < 8000);
    r = await f.call('POST', `/api/admin/rent/approvals/${r.body.approval.id}/decide`, { decision: 'rejected', note: 'Move-out date was entered incorrectly; tenancy continues' }, 'finance', 'settlement-checker');
    assert.equal(r.statusCode, 200);
    const restored = (await f.query('SELECT amount,period_end,voided_at FROM rent_charges WHERE id=$1', [partial.id])).rows[0];
    assert.equal(Number(restored.amount), 8000);
    assert.ok(String(restored.period_end).slice(0, 10) > end);
    assert.equal(restored.voided_at, null);
    const lease = (await f.query('SELECT end_date,status FROM rent_leases WHERE id=$1', [l.id])).rows[0];
    assert.equal(lease.end_date, null);
    assert.equal(lease.status, 'active');
    assert.equal((await f.query('SELECT disabled FROM users WHERE id=$1',[tenantUser.id])).rows[0].disabled,false,'rejected move-out restores the former active login account');
    assert.equal((await f.query('SELECT count(*)::int n FROM sessions WHERE user_id=$1',[tenantUser.id])).rows[0].n,0,'revoked sessions are not resurrected; tenant must sign in again');
  } finally { await f.close(); }
});

test('arrears ageing and CSV export can be filtered by property, unit and date range', async () => {
  const f = await fixture();
  try {
    const property = (await f.query("INSERT INTO properties(name) VALUES('Ageing Test Property') RETURNING id", [])).rows[0];
    await f.query("INSERT INTO meters(meter_code,tenant_name,flat) VALUES('AGE-1','Ageing Tenant','B-01')");
    const unit = (await f.query("INSERT INTO property_units(property_id,meter_code,unit_label) VALUES($1,'AGE-1','B-01') RETURNING id", [property.id])).rows[0];
    const l = (await f.query("INSERT INTO rent_leases(meter_code,tenant_name,unit_label,rent_account_ref,rent_amount,billing_frequency,start_date,due_day,property_unit_id) VALUES('AGE-1','Ageing Tenant','B-01','RENT-AGE01',5000,'monthly',current_date-interval '60 days',1,$1) RETURNING id", [unit.id])).rows[0];
    const due = new Date(new Date(today()+'T00:00:00Z').getTime()-45*86400000).toISOString().slice(0,10);
    const period = new Date(new Date(due+'T00:00:00Z').getTime()-20*86400000).toISOString().slice(0,10);
    const charge = (await f.query("INSERT INTO rent_charges(lease_id,period_start,period_end,due_date,amount,charge_type) VALUES($1,$2::date,$3::date,$4::date,5000,'rent') RETURNING id", [l.id,period,due,due])).rows[0];
    const pay = (await f.query("INSERT INTO rent_payments(lease_id,rent_account_ref,amount,method,status,transaction_time,external_reference,verified_by,verification_note) VALUES($1,'RENT-AGE01',1000,'manual','confirmed',current_date,'AGE-PAY-1','finance','Partial payment') RETURNING id", [l.id])).rows[0];
    await f.query('INSERT INTO rent_allocations(payment_id,charge_id,amount) VALUES($1,$2,1000)', [pay.id,charge.id]);
    const from = new Date(new Date(due+'T00:00:00Z').getTime()-5*86400000).toISOString().slice(0,10), to=today();
    const query = new URLSearchParams({from,to,propertyId:property.id,unitId:unit.id});
    let r = await f.call('GET', '/api/admin/rent/reports/ageing?'+query, {}, 'finance', 'ageing-finance');
    assert.equal(r.statusCode, 200);
    assert.equal(r.body.items.length, 1);
    assert.equal(Number(r.body.items[0].total_due), 4000);
    r = await f.call('GET', '/api/admin/rent/reports/ageing.csv?'+query, {}, 'finance', 'ageing-finance');
    assert.equal(r.statusCode, 200);
    assert.match(r.body, /Ageing Test Property/);
    assert.match(r.body, /Ageing Tenant/);
    assert.match(r.body, /4000/);
  } finally { await f.close(); }
});

test('same-unit renewal keeps the current tenant login active until the renewal start date', async () => {
  const f = await fixture();
  try {
    await f.query("INSERT INTO meters(meter_code,tenant_name,flat) VALUES('RENEW-1','Renewing Tenant','R-01')");
    const l = (await f.query("INSERT INTO rent_leases(meter_code,tenant_name,unit_label,rent_account_ref,rent_amount,billing_frequency,start_date,due_day) VALUES('RENEW-1','Renewing Tenant','R-01','RENT-RENEW1',5000,'monthly',current_date-interval '30 days',1) RETURNING *", [])).rows[0];
    const user = (await f.query("INSERT INTO users(meter_code,username,password_hash) VALUES('RENEW-1','renew.user','scrypt$dummy') RETURNING id", [])).rows[0];
    await f.query("INSERT INTO sessions(token_hash,user_id,expires_at) VALUES('renew-session',$1,now()+interval '1 day')", [user.id]);
    const moveIn = new Date(Date.now()+3*3600000+86400000).toISOString().slice(0,10);
    const r = await f.call('POST', `/api/admin/rent/leases/${l.id}/transfer`, { newMeterCode: 'RENEW-1', newUnitLabel: 'R-01', newRentAccountRef: 'RENT-RENEW2', rentAmount: 5200, billingFrequency: 'monthly', startDate: moveIn, dueDay: 1 }, 'manager', 'renewal-manager');
    assert.equal(r.statusCode, 201);
    assert.equal(r.body.previousDestinationLoginDisabled, false);
    assert.equal((await f.query('SELECT disabled FROM users WHERE id=$1',[user.id])).rows[0].disabled, false);
    assert.equal((await f.query('SELECT count(*)::int n FROM sessions WHERE user_id=$1',[user.id])).rows[0].n, 1);
    const current = (await f.query("SELECT id FROM rent_leases WHERE meter_code='RENEW-1' AND start_date<=current_date AND (end_date IS NULL OR end_date>=current_date) ORDER BY start_date DESC LIMIT 1", [])).rows[0];
    assert.equal(current.id, l.id);
  } finally { await f.close(); }
});

test('property units can be moved between properties only while vacant and cannot be disabled while occupied', async () => {
  const f = await fixture();
  try {
    const p1 = (await f.query("INSERT INTO properties(name) VALUES('Block A') RETURNING id", [])).rows[0];
    const p2 = (await f.query("INSERT INTO properties(name) VALUES('Block B') RETURNING id", [])).rows[0];
    await f.query("INSERT INTO meters(meter_code,tenant_name,flat) VALUES('UNIT-1','Unit Tenant','A1')");
    let r = await f.call('POST', '/api/admin/rent/units', { propertyId: p1.id, meterCode: 'UNIT-1', unitLabel: 'A1', status: 'available' }, 'manager', 'property-manager');
    assert.equal(r.statusCode, 201);
    const unitId = r.body.unit.id;
    r = await f.call('PATCH', `/api/admin/rent/units/${unitId}`, { propertyId: p2.id, meterCode: 'UNIT-1', unitLabel: 'B1', status: 'available' }, 'manager', 'property-manager');
    assert.equal(r.statusCode, 200);
    assert.equal(r.body.unit.property_id, p2.id);
    const l = (await f.query("INSERT INTO rent_leases(meter_code,tenant_name,unit_label,rent_account_ref,rent_amount,billing_frequency,start_date,due_day,property_unit_id) VALUES('UNIT-1','Unit Tenant','B1','RENT-UNIT01',4000,'monthly',current_date,1,$1) RETURNING id", [unitId])).rows[0];
    r = await f.call('PATCH', `/api/admin/rent/units/${unitId}`, { propertyId: p1.id, meterCode: 'UNIT-1', unitLabel: 'A1', status: 'available' }, 'manager', 'property-manager');
    assert.equal(r.statusCode, 409);
    r = await f.call('PATCH', `/api/admin/rent/units/${unitId}`, { propertyId: p2.id, meterCode: 'UNIT-1', unitLabel: 'B1', status: 'unavailable' }, 'manager', 'property-manager');
    assert.equal(r.statusCode, 409);
    assert.ok(l.id);
  } finally { await f.close(); }
});

test('caretaker role can read occupancy and unit records but cannot edit units', async () => {
  const f = await fixture();
  try {
    const p = (await f.query("INSERT INTO properties(name) VALUES('Caretaker Property') RETURNING id", [])).rows[0];
    const u = (await f.query("INSERT INTO property_units(property_id,unit_label,status) VALUES($1,'C-01','available') RETURNING id", [p.id])).rows[0];
    let r = await f.call('GET', '/api/admin/rent/occupancy', {}, 'caretaker', 'caretaker-1');
    assert.equal(r.statusCode, 200);
    assert.equal(r.body.items[0].property_name, 'Caretaker Property');
    r = await f.call('GET', '/api/admin/rent/units', {}, 'caretaker', 'caretaker-1');
    assert.equal(r.statusCode, 200);
    assert.equal(r.body.items.length, 1);
    r = await f.call('PATCH', `/api/admin/rent/units/${u.id}`, { propertyId: p.id, unitLabel: 'C-01', status: 'unavailable' }, 'caretaker', 'caretaker-1');
    assert.equal(r.statusCode, 403);
  } finally { await f.close(); }
});

test('cross-unit transfer keeps outgoing access until move-out then scheduled worker revokes it', async () => {
  const f = await fixture();
  try {
    await f.query("INSERT INTO meters(meter_code,tenant_name,flat) VALUES('MOVE-OLD','Moving Tenant','M-01'),('MOVE-NEW','Previous Occupant','M-02')");
    const l = (await f.query("INSERT INTO rent_leases(meter_code,tenant_name,unit_label,rent_account_ref,rent_amount,billing_frequency,start_date,due_day) VALUES('MOVE-OLD','Moving Tenant','M-01','RENT-MOVE01',5000,'monthly',current_date-interval '20 days',1) RETURNING *", [])).rows[0];
    const oldUser=(await f.query("INSERT INTO users(meter_code,username,password_hash) VALUES('MOVE-OLD','old.tenant','scrypt$dummy') RETURNING id",[])).rows[0];
    const newUser=(await f.query("INSERT INTO users(meter_code,username,password_hash) VALUES('MOVE-NEW','new.previous','scrypt$dummy') RETURNING id",[])).rows[0];
    await f.query("INSERT INTO sessions(token_hash,user_id,expires_at) VALUES('move-old-session',$1,now()+interval '1 day'),('move-new-session',$2,now()+interval '1 day')",[oldUser.id,newUser.id]);
    const moveIn=new Date(Date.now()+3*3600000+3*86400000).toISOString().slice(0,10);
    const r=await f.call('POST',`/api/admin/rent/leases/${l.id}/transfer`,{newMeterCode:'MOVE-NEW',newUnitLabel:'M-02',newRentAccountRef:'RENT-MOVE02',rentAmount:5200,billingFrequency:'monthly',startDate:moveIn,dueDay:1},'manager','move-manager');
    assert.equal(r.statusCode,201);
    assert.equal((await f.query('SELECT disabled FROM users WHERE id=$1',[oldUser.id])).rows[0].disabled,false);
    assert.equal((await f.query('SELECT disabled FROM users WHERE id=$1',[newUser.id])).rows[0].disabled,true);
    const yesterday=new Date(new Date(today()+'T00:00:00Z').getTime()-86400000).toISOString().slice(0,10);
    await f.query('UPDATE rent_leases SET end_date=$2::date WHERE id=$1',[l.id,yesterday]);
    await runRentAutomation(f.pool,{});
    assert.equal((await f.query('SELECT disabled FROM users WHERE id=$1',[oldUser.id])).rows[0].disabled,true);
    assert.equal((await f.query('SELECT count(*)::int n FROM sessions WHERE user_id=$1',[oldUser.id])).rows[0].n,0);
  } finally { await f.close(); }
});

test('standalone property units support meterless rent tenancies and tenant logins', async () => {
  const f = await fixture();
  try {
    const property = (await f.query("INSERT INTO properties(name,address) VALUES('Standalone Rent Property','Nairobi') RETURNING id")).rows[0];
    const unit = (await f.query("INSERT INTO property_units(property_id,meter_code,unit_label,status) VALUES($1,NULL,'Shop 01','available') RETURNING id", [property.id])).rows[0];
    const lease = (await f.query(`INSERT INTO rent_leases(meter_code,tenant_name,unit_label,rent_account_ref,rent_amount,billing_frequency,start_date,due_day,property_unit_id)
      VALUES(NULL,'Rent Only Tenant','Shop 01','RENT-SHOP1',12000,'monthly',$1::date,1,$2) RETURNING *`, [today(), unit.id])).rows[0];
    const user = (await f.query(`INSERT INTO users(meter_code,rent_lease_id,username,password_hash,must_change)
      VALUES(NULL,$1,'RENT-SHOP1','scrypt$test$hash',true) RETURNING *`, [lease.id])).rows[0];
    await f.query("INSERT INTO sessions(token_hash,user_id,expires_at) VALUES('rent-only-session',$1,now()+interval '1 day')", [user.id]);
    assert.equal(lease.meter_code, null);
    assert.equal(user.rent_lease_id, lease.id);
    assert.equal((await f.query("SELECT count(*)::int n FROM sessions s JOIN users u ON u.id=s.user_id JOIN rent_leases l ON l.id=u.rent_lease_id WHERE s.token_hash='rent-only-session' AND l.id=$1 AND l.status='active'", [lease.id])).rows[0].n, 1);
    assert.ok(await generateCharges(f.pool, lease.id));
    assert.ok((await f.query('SELECT count(*)::int n FROM rent_charges WHERE lease_id=$1', [lease.id])).rows[0].n > 0);
    await assert.rejects(() => f.query("INSERT INTO users(meter_code,username,password_hash) VALUES(NULL,'INVALID-NO-LEASE','scrypt$test$hash')"), /users_customer_identity_check/);
    await assert.rejects(() => f.query("INSERT INTO rent_leases(meter_code,tenant_name,unit_label,rent_account_ref,rent_amount,billing_frequency,start_date,due_day,property_unit_id) VALUES(NULL,'Second Tenant','Shop 01','RENT-SHOP2',10000,'monthly',$1::date,1,$2)", [today(), unit.id]), /rent_leases_active_property_unit_uidx/);
  } finally { await f.close(); }
});

test('tenant move-out notice enforces one calendar month and records the intended end date', async () => {
  const f = await fixture();
  try {
    const l = await f.lease({ meter: 'NOTICE-PERIOD-1', ref: 'RENT-NOTICE1' });
    const noticeDate = today();
    const earliest = addCalendarMonth(noticeDate);
    const tooEarly = new Date(new Date(earliest+'T00:00:00Z').getTime()-86400000).toISOString().slice(0,10);
    let r = await f.call('POST', `/api/admin/rent/leases/${l.id}/notice-date`, { noticeDate, noticeEndDate: tooEarly }, 'manager', 'notice-manager');
    assert.equal(r.statusCode, 400);
    assert.match(r.body.message, /one calendar month/i);
    r = await f.call('POST', `/api/admin/rent/leases/${l.id}/notice-date`, { noticeDate }, 'manager', 'notice-manager');
    assert.equal(r.statusCode, 200);
    assert.equal(new Date(r.body.lease.notice_date).toISOString().slice(0,10), noticeDate);
    assert.equal(new Date(r.body.lease.notice_end_date).toISOString().slice(0,10), earliest);
  } finally { await f.close(); }
});


test('new rent audit events record the authenticated actor and immutable event context', async () => {
  const f = await fixture();
  try {
    const l = await f.lease({ meter: 'AUDIT-ATTR-1', ref: 'RENT-AUDIT1' });
    const r = await f.call('POST', `/api/admin/rent/leases/${l.id}/notice-date`, { noticeDate: today() }, 'manager', 'audit.manager');
    assert.equal(r.statusCode, 200);
    const event = (await f.query("SELECT actor_id,actor_name,actor_role,actor_username,actor_source,entity_type,entity_id,created_at FROM admin_actions WHERE action='RENT_NOTICE_DATE_SET' ORDER BY id DESC LIMIT 1", [])).rows[0];
    assert.equal(event.actor_id, 'audit.manager');
    assert.equal(event.actor_name, 'audit.manager');
    assert.equal(event.actor_role, 'manager');
    assert.equal(event.actor_username, 'audit.manager');
    assert.equal(event.actor_source, 'staff_session');
    assert.equal(event.entity_type, 'tenancy');
    assert.equal(event.entity_id, l.id);
    assert.ok(event.created_at);
    await assert.rejects(() => f.query("UPDATE admin_actions SET actor_name='Changed' WHERE action='RENT_NOTICE_DATE_SET'"), /Audit identity and event context are immutable/);
    await assert.rejects(() => f.query("DELETE FROM admin_actions WHERE action='RENT_NOTICE_DATE_SET'"), /Audit history cannot be deleted/);
  } finally { await f.close(); }
});
