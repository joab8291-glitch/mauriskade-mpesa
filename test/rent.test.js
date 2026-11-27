'use strict';
const test = require('node:test');
const assert = require('node:assert/strict');
const { validDate, validRentReference, addMonths, dueDate, generateCharges, allocateRentPayment, makeReceiptPdf, processRentC2B } = require('../rent');

test('date validation rejects impossible calendar dates', () => {
  assert.equal(validDate('2026-02-28'), true);
  assert.equal(validDate('2026-02-29'), false);
  assert.equal(validDate('2026-13-01'), false);
  assert.equal(validDate('not-a-date'), false);
});

test('rent references use the uppercase RENT prefix and fit the Daraja limit', () => {
  assert.equal(validRentReference('RENT-ROOM1'), true);
  assert.equal(validRentReference('rent-room1'), false);
  assert.equal(validRentReference('RENT-TOO-LONG'), false);
});

test('billing dates clamp month ends without rolling into the next month', () => {
  assert.equal(addMonths('2027-01-31', 1).toISOString().slice(0, 10), '2027-02-28');
  assert.equal(dueDate('2027-02-01', 31), '2027-02-28');
});

test('a partial final rental period is prorated and a rerun cannot duplicate the charge', async () => {
  const inserts = [];
  let duplicate = false;
  const pool = { query: async (sql, args) => {
    if (sql.includes('SELECT * FROM rent_leases')) return { rows: [{ id: 'lease-1', status: 'active', billing_frequency: 'monthly', start_date: '2026-11-01', end_date: '2026-11-15', rent_amount: 30000, due_day: 1 }] };
    if (sql.startsWith('INSERT INTO rent_charges')) { inserts.push(args); return { rowCount: duplicate ? 0 : 1, rows: [] }; }
    if (sql.includes('SELECT id FROM rent_payments')) return { rows: [] };
    throw new Error('Unexpected SQL: ' + sql);
  }};
  assert.equal(await generateCharges(pool, 'lease-1'), 1);
  assert.equal(inserts[0][4], 15000); // 15 of 30 occupied days
  duplicate = true;
  assert.equal(await generateCharges(pool, 'lease-1'), 0);
  assert.equal(inserts.length, 2);
});

test('payment allocation uses the configured oldest-due-first policy', async () => {
  const statements = [], allocations = [];
  const client = { query: async (sql, args) => {
    statements.push(sql);
    if (sql.includes('SELECT * FROM rent_payments')) return { rows: [{ id: 'pay-1', lease_id: 'lease-1', amount: 1500, status: 'confirmed' }] };
    if (sql.includes('SELECT COALESCE(sum(amount)')) return { rows: [{ n: 0 }] };
    if (sql.includes('SELECT allocation_rule')) return { rows: [{ allocation_rule: 'oldest_due_first' }] };
    if (sql.includes('SELECT c.id,c.amount')) return { rows: [{ id: 'charge-old', balance: 1000 }, { id: 'charge-new', balance: 1000 }] };
    if (sql.startsWith('INSERT INTO rent_allocations')) { allocations.push(args); return { rowCount: 1, rows: [] }; }
    return { rowCount: 1, rows: [] };
  }, release() {} };
  await allocateRentPayment({ connect: async () => client }, 'pay-1');
  const chargeQuery = statements.find(x => x.includes('SELECT c.id,c.amount'));
  assert.match(chargeQuery, /ORDER BY c\.due_date ASC,c\.period_start ASC/);
  assert.deepEqual(allocations, [['pay-1', 'charge-old', 1000], ['pay-1', 'charge-new', 500]]);
});

test('receipt generator produces a PDF buffer', () => {
  const pdf = makeReceiptPdf(['RENT PAYMENT RECEIPT', 'Receipt: MR-TEST-001', 'Amount received: KSh 1,500', 'Allocated to 2026-11-01 – 2026-11-30: KSh 1,000']);
  assert.ok(Buffer.isBuffer(pdf));
  assert.equal(pdf.subarray(0, 8).toString(), '%PDF-1.4');
  assert.match(pdf.toString('latin1'), /xref/);
});


test('a Paybill transaction code already used as a manual reference is held for review, not double-posted', async () => {
  const calls = [];
  const pool = { query: async (sql, args) => {
    calls.push(sql);
    if (sql.includes('SELECT * FROM rent_leases')) return { rows: [] };
    if (sql.includes('SELECT id,mpesa_receipt,external_reference')) return { rows: [{ id: 'manual-1', mpesa_receipt: null, external_reference: 'QABC123XYZ' }] };
    if (sql.includes('INSERT INTO admin_actions')) return { rows: [], rowCount: 1 };
    throw new Error('Unexpected SQL: ' + sql);
  }};
  const result = await processRentC2B(pool, { TransID: 'QABC123XYZ', BillRefNumber: 'RENT-ROOM1', TransAmount: 5000 });
  assert.equal(result.referenceCollision, true);
  assert.equal(calls.some(sql => sql.includes('INSERT INTO rent_payments')), false);
});
