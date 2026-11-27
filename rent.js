'use strict';
const crypto = require('crypto');
const FREQUENCIES = {monthly:1,quarterly:3,half_yearly:6,annually:12};
const todayNairobi = () => iso(new Date(Date.now()+3*3600000));
const iso = d => d.toISOString().slice(0,10);
const addMonths = (s,n) => { const d=new Date(s+'T00:00:00Z'),day=d.getUTCDate();d.setUTCDate(1);d.setUTCMonth(d.getUTCMonth()+n);d.setUTCDate(Math.min(day,new Date(Date.UTC(d.getUTCFullYear(),d.getUTCMonth()+1,0)).getUTCDate()));return d; };
const dueDate = (s,day) => {const d=new Date(s+'T00:00:00Z');d.setUTCDate(Math.min(Number(day)||1,new Date(Date.UTC(d.getUTCFullYear(),d.getUTCMonth()+1,0)).getUTCDate()));return iso(d);};
const esc = v => String(v??'').replace(/[&<>"']/g,c=>({'&':'&amp;','<':'&lt;','>':'&gt;','"':'&quot;',"'":'&#39;'}[c]));
const wrap = fn => (req,res,next)=>Promise.resolve(fn(req,res,next)).catch(e=>{console.error('rent route',req.method,req.path,e.message);if(!res.headersSent)res.status(500).json({ok:false,message:'Rental service error. Please try again.'});});

async function allocateRentPayment(pool,id){
 const client=await pool.connect();
 try{
  await client.query('BEGIN');
  const p=(await client.query('SELECT * FROM rent_payments WHERE id=$1 FOR UPDATE',[id])).rows[0];
  if(!p||!p.lease_id||!['confirmed','unallocated','allocated'].includes(p.status)){await client.query('COMMIT');return;}
  let left=Number(p.amount)-Number((await client.query('SELECT COALESCE(sum(amount),0)::int n FROM rent_allocations WHERE payment_id=$1',[id])).rows[0].n);
  const charges=(await client.query("SELECT c.id,c.amount-COALESCE(a.paid,0)::int balance FROM rent_charges c LEFT JOIN (SELECT charge_id,sum(amount) paid FROM rent_allocations GROUP BY charge_id) a ON a.charge_id=c.id WHERE c.lease_id=$1 AND c.amount>COALESCE(a.paid,0) ORDER BY c.period_start FOR UPDATE OF c",[p.lease_id])).rows;
  for(const c of charges){if(left<=0)break;const n=Math.min(left,Number(c.balance));if(n>0){await client.query('INSERT INTO rent_allocations(payment_id,charge_id,amount) VALUES($1,$2,$3) ON CONFLICT(payment_id,charge_id) DO NOTHING',[id,c.id,n]);left-=n;}}
  await client.query("UPDATE rent_payments SET status='allocated',updated_at=now() WHERE id=$1",[id]);
  await client.query('COMMIT');
 }catch(e){await client.query('ROLLBACK').catch(()=>{});throw e;}finally{client.release();}
}
async function generateCharges(pool,id){
 const l=(await pool.query("SELECT * FROM rent_leases WHERE id=$1 AND status='active'",[id])).rows[0];if(!l)return 0;
 const step=FREQUENCIES[l.billing_frequency],today=todayNairobi(),horizon=addMonths(today,18);let period=String(l.start_date).slice(0,10),count=0;
 for(let n=0;n<240;n++){if(new Date(period+'T00:00:00Z')>horizon)break;const next=addMonths(period,step),periodEnd=new Date(next.getTime()-86400000);if(l.end_date&&period>String(l.end_date).slice(0,10))break;const end=l.end_date&&String(l.end_date).slice(0,10)<iso(periodEnd)?new Date(String(l.end_date).slice(0,10)+'T00:00:00Z'):periodEnd;
  const r=await pool.query('INSERT INTO rent_charges(lease_id,period_start,period_end,due_date,amount) VALUES($1,$2,$3,$4,$5) ON CONFLICT(lease_id,period_start) DO NOTHING',[id,period,iso(end),dueDate(period,l.due_day),l.rent_amount]);count+=r.rowCount;period=iso(next);}
 const ps=(await pool.query("SELECT id FROM rent_payments WHERE lease_id=$1 AND status IN ('confirmed','unallocated','allocated') ORDER BY created_at",[id])).rows;for(const p of ps)await allocateRentPayment(pool,p.id);return count;
}
async function createReceipt(pool,id){
 const p=(await pool.query('SELECT p.*,l.tenant_name,l.unit_label FROM rent_payments p LEFT JOIN rent_leases l ON l.id=p.lease_id WHERE p.id=$1',[id])).rows[0];if(!p||p.status==='pending'||p.status==='failed'||p.status==='review')return;
 const n='MR-'+new Date().toISOString().slice(0,10).replace(/-/g,'')+'-'+crypto.randomBytes(3).toString('hex').toUpperCase();
 await pool.query('INSERT INTO rent_receipts(payment_id,receipt_number) VALUES($1,$2) ON CONFLICT(payment_id) DO NOTHING',[id,n]);
}

function makeReceiptPdf(lines) {
 const clean=v=>{const s=String(v??'').normalize('NFKD').replace(/[^\x20-\x7E]/g,'?');return s.split('\\').join('\\\\').split('(').join('\\(').split(')').join('\\)');};
 const nl=String.fromCharCode(10);
 const ops=['BT /F1 20 Tf 50 790 Td ('+clean('Mauriskade Apartments')+') Tj','/F1 15 Tf 0 -34 Td ('+clean('RENT PAYMENT RECEIPT')+') Tj','/F1 10 Tf 0 -22 Td ('+clean('Official payment record')+') Tj','/F1 11 Tf'];
 for(const line of lines)ops.push('0 -25 Td ('+clean(line)+') Tj');
 ops.push('ET');
 const stream=ops.join(nl),objects=[
  '<< /Type /Catalog /Pages 2 0 R >>',
  '<< /Type /Pages /Kids [3 0 R] /Count 1 >>',
  '<< /Type /Page /Parent 2 0 R /MediaBox [0 0 595 842] /Resources << /Font << /F1 5 0 R >> >> /Contents 4 0 R >>',
  '<< /Length '+Buffer.byteLength(stream)+' >>'+nl+'stream'+nl+stream+nl+'endstream',
  '<< /Type /Font /Subtype /Type1 /BaseFont /Helvetica >>'
 ];
 let pdf='%PDF-1.4'+nl,offsets=[0];
 for(let i=0;i<objects.length;i++){offsets.push(Buffer.byteLength(pdf));pdf+=(i+1)+' 0 obj'+nl+objects[i]+nl+'endobj'+nl;}
 const xref=Buffer.byteLength(pdf);pdf+='xref'+nl+'0 6'+nl+'0000000000 65535 f '+nl;
 for(let i=1;i<offsets.length;i++)pdf+=String(offsets[i]).padStart(10,'0')+' 00000 n '+nl;
 pdf+='trailer'+nl+'<< /Size 6 /Root 1 0 R >>'+nl+'startxref'+nl+xref+nl+'%%EOF';
 return Buffer.from(pdf,'binary');
}
async function processRentStkCallback(pool,checkoutId,cb){
 const p=(await pool.query('SELECT * FROM rent_payments WHERE checkout_request_id=$1',[checkoutId])).rows[0];if(!p)return false;
 if(Number(cb.ResultCode)!==0){await pool.query("UPDATE rent_payments SET status='failed',raw_payload=$2,notes=$3,updated_at=now() WHERE id=$1 AND status='pending'",[p.id,JSON.stringify(cb),cb.ResultDesc||'M-Pesa payment failed']);return true;}
 const items=Object.fromEntries(((cb.CallbackMetadata||{}).Item||[]).map(x=>[x.Name,x.Value])),amount=Number(items.Amount),receipt=items.MpesaReceiptNumber?String(items.MpesaReceiptNumber):null;
 if(amount!==Number(p.amount)||!receipt){await pool.query("UPDATE rent_payments SET status='review',requested_amount=COALESCE(requested_amount,amount),amount=CASE WHEN $4::int IS NOT NULL THEN $4 ELSE amount END,mpesa_receipt=COALESCE(mpesa_receipt,$2),raw_payload=$3,notes=$5,updated_at=now() WHERE id=$1",[p.id,receipt,JSON.stringify(cb),Number.isFinite(amount)?amount:null,'M-Pesa amount/receipt mismatch; requested KSh '+p.amount+', callback amount '+(Number.isFinite(amount)?amount:'unknown')+'. Verify before allocating.']);return true;}
 await pool.query("UPDATE rent_payments SET status='confirmed',mpesa_receipt=$2,payer_phone=COALESCE($3,payer_phone),raw_payload=$4,updated_at=now() WHERE id=$1 AND status='pending'",[p.id,receipt,items.PhoneNumber?String(items.PhoneNumber):null,JSON.stringify(cb)]);
 await allocateRentPayment(pool,p.id);await createReceipt(pool,p.id);return true;
}
function registerRentRoutes({app,pool,requireUser,requireReady,normPhone,darajaPost,payLimit,mpesaShortcode,callbackBaseUrl,callbackSecret}){
 const customer=[requireUser,requireReady],admin='/api/admin/rent';
 app.get('/api/me/rent',...customer,wrap(async(req,res)=>{
  const l=(await pool.query("SELECT * FROM rent_leases WHERE meter_code=$1 ORDER BY created_at DESC LIMIT 1",[req.user.meter_code])).rows[0];
  if(!l)return res.json({ok:true,lease:null,charges:[],payments:[],credit:0,arrears:0});
  await generateCharges(pool,l.id);
  const charges=(await pool.query('SELECT c.id,c.period_start,c.period_end,c.due_date,c.amount,COALESCE(sum(a.amount),0)::int paid,(c.amount-COALESCE(sum(a.amount),0))::int balance FROM rent_charges c LEFT JOIN rent_allocations a ON a.charge_id=c.id WHERE c.lease_id=$1 GROUP BY c.id ORDER BY c.period_start DESC LIMIT 36',[l.id])).rows;
  const payments=(await pool.query('SELECT p.id,p.amount,p.method,p.status,p.mpesa_receipt,p.created_at,r.id receipt_id,r.receipt_number FROM rent_payments p LEFT JOIN rent_receipts r ON r.payment_id=p.id WHERE p.lease_id=$1 ORDER BY p.created_at DESC LIMIT 50',[l.id])).rows;
  const credit=(await pool.query("SELECT COALESCE(sum(p.amount),0)-COALESCE((SELECT sum(a.amount) FROM rent_allocations a JOIN rent_payments x ON x.id=a.payment_id WHERE x.lease_id=$1),0) n FROM rent_payments p WHERE p.lease_id=$1 AND p.status IN ('confirmed','allocated')",[l.id])).rows[0].n;
  const agreement=(await pool.query("SELECT title,body,version,issued_at FROM tenancy_agreements WHERE lease_id=$1 AND status='issued' ORDER BY version DESC LIMIT 1",[l.id])).rows[0]||null;
  res.json({ok:true,lease:l,charges,payments,agreement,credit:Number(credit)||0,paybill:mpesaShortcode,arrears:charges.filter(c=>c.due_date<todayNairobi()&&Number(c.balance)>0).reduce((n,c)=>n+Number(c.balance),0)});
 }));
 app.post('/api/me/rent/pay',...customer,...(payLimit?[payLimit]:[]),wrap(async(req,res)=>{
  const amount=Number(req.body&&req.body.amount),phone=normPhone(req.body&&req.body.phone);
  if(!Number.isSafeInteger(amount)||amount<1||amount>1000000)return res.status(400).json({ok:false,message:'Enter a valid rent amount.'});
  if(!phone)return res.status(400).json({ok:false,message:'Enter a valid Safaricom number.'});
  const l=(await pool.query("SELECT * FROM rent_leases WHERE meter_code=$1 AND status='active'",[req.user.meter_code])).rows[0];if(!l)return res.status(404).json({ok:false,message:'No active rent account is linked to this login.'});
  await generateCharges(pool,l.id);
  const client=await pool.connect();let id;
  try{await client.query('BEGIN');await client.query('SELECT pg_advisory_xact_lock(hashtext($1))',['rent:'+l.id]);
   const pending=(await client.query("SELECT 1 FROM rent_payments WHERE lease_id=$1 AND status='pending' AND created_at>now()-interval '2 minutes'",[l.id])).rowCount;
   if(pending){await client.query('ROLLBACK');return res.status(429).json({ok:false,message:'A rent payment prompt is already pending. Approve it or wait for it to expire before trying again.'});}
   id=(await client.query("INSERT INTO rent_payments(lease_id,rent_account_ref,payer_phone,amount,requested_amount,method,status) VALUES($1,$2,$3,$4,$4,'mpesa_stk','pending') RETURNING id",[l.id,l.rent_account_ref,phone,amount])).rows[0].id;await client.query('COMMIT');
  }catch(e){await client.query('ROLLBACK').catch(()=>{});throw e;}finally{client.release();}
  try{const stamp=new Date(Date.now()+10800000).toISOString().replace(/[-:T]/g,'').slice(0,14),pass=Buffer.from(String(mpesaShortcode)+process.env.MPESA_PASSKEY+stamp).toString('base64');
   const j=await darajaPost('/mpesa/stkpush/v1/processrequest',{BusinessShortCode:mpesaShortcode,Password:pass,Timestamp:stamp,TransactionType:process.env.MPESA_TXN_TYPE||'CustomerPayBillOnline',Amount:amount,PartyA:phone,PartyB:process.env.MPESA_PARTYB||mpesaShortcode,PhoneNumber:phone,CallBackURL:callbackBaseUrl.replace(/\/$/,'')+'/api/mpesa/callback/'+callbackSecret,AccountReference:String(l.rent_account_ref).slice(0,12),TransactionDesc:'House rent'});
   if(String(j.ResponseCode)!=='0'||!j.CheckoutRequestID)throw new Error(j.errorMessage||j.ResponseDescription||'M-Pesa rejected the request.');
   await pool.query('UPDATE rent_payments SET checkout_request_id=$2,merchant_request_id=$3,updated_at=now() WHERE id=$1',[id,j.CheckoutRequestID,j.MerchantRequestID||null]);res.json({ok:true,paymentId:id});
  }catch(e){await pool.query("UPDATE rent_payments SET status='failed',notes=$2,updated_at=now() WHERE id=$1",[id,e.message]);res.status(502).json({ok:false,message:'Could not start the rent payment prompt. Please try again.'});}
 }));
 app.get('/api/me/rent/payment/:id',...customer,wrap(async(req,res)=>{const p=(await pool.query('SELECT id,status,amount,mpesa_receipt,created_at FROM rent_payments WHERE id=$1 AND lease_id IN (SELECT id FROM rent_leases WHERE meter_code=$2)',[req.params.id,req.user.meter_code])).rows[0];if(!p)return res.status(404).json({ok:false,message:'Rent payment not found.'});res.json({ok:true,payment:p});}));
 app.get('/api/me/rent/receipt/:id',...customer,wrap(async(req,res)=>{
  const p=(await pool.query('SELECT p.*,r.receipt_number,l.tenant_name,l.unit_label,l.rent_account_ref FROM rent_payments p JOIN rent_receipts r ON r.payment_id=p.id JOIN rent_leases l ON l.id=p.lease_id WHERE r.id=$1 AND l.meter_code=$2',[req.params.id,req.user.meter_code])).rows[0];if(!p)return res.status(404).send('Receipt not found');
  const lines=[
   'Receipt: '+p.receipt_number,
   'Tenant: '+p.tenant_name,
   'Unit: '+p.unit_label,
   'Rent account: '+p.rent_account_ref,
   'Amount received: KSh '+Number(p.amount).toLocaleString('en-KE'),
   'Payment method: '+p.method,
   'M-Pesa receipt: '+(p.mpesa_receipt||'Not applicable'),
   'Date: '+new Date(p.created_at).toLocaleString('en-KE',{timeZone:'Africa/Nairobi'}),
   'Status: Confirmed'
  ];
  const pdf=makeReceiptPdf(lines);
  res.setHeader('Content-Type','application/pdf');
  res.setHeader('Content-Disposition','attachment; filename="'+p.receipt_number+'.pdf"');
  res.send(pdf);
 }));
 app.get(admin+'/leases',wrap(async(_req,res)=>{
  const items=(await pool.query('SELECT l.*,m.phone FROM rent_leases l JOIN meters m ON m.meter_code=l.meter_code ORDER BY l.created_at DESC')).rows;res.json({ok:true,items});
 }));
 app.post(admin+'/leases',wrap(async(req,res)=>{
  const b=req.body||{},meter=String(b.meterCode||''),tenant=String(b.tenantName||'').trim(),unit=String(b.unitLabel||'').trim(),ref=String(b.rentAccountRef||'').trim(),amount=Number(b.rentAmount),freq=String(b.billingFrequency||'monthly'),start=String(b.startDate||'').slice(0,10),end=b.endDate?String(b.endDate).slice(0,10):null,day=Number(b.dueDay||1);
  if(!meter||!tenant||!unit||!ref||!Number.isSafeInteger(amount)||amount<1||!FREQUENCIES[freq]||!/^\d{4}-\d{2}-\d{2}$/.test(start)||(end&&(!/^\d{4}-\d{2}-\d{2}$/.test(end)||end<start))||day<1||day>28)return res.status(400).json({ok:false,message:'Complete all tenancy fields with valid values.'});
  if(!(await pool.query('SELECT 1 FROM meters WHERE meter_code=$1',[meter])).rowCount)return res.status(404).json({ok:false,message:'Select a registered meter.'});
  if((await pool.query("SELECT 1 FROM rent_leases WHERE meter_code=$1 AND status='active'",[meter])).rowCount)return res.status(409).json({ok:false,message:'This meter already has an active tenancy. End the old tenancy before creating another.'});
  if((await pool.query("SELECT 1 FROM rent_leases WHERE rent_account_ref=$1 AND status='active'",[ref])).rowCount)return res.status(409).json({ok:false,message:'Rent account reference is already assigned.'});
  await pool.query('UPDATE meters SET rent_account_ref=$2,tenant_name=$3,flat=$4 WHERE meter_code=$1',[meter,ref,tenant,unit]);
  const l=(await pool.query('INSERT INTO rent_leases(meter_code,tenant_name,unit_label,rent_account_ref,rent_amount,billing_frequency,start_date,end_date,due_day,agreement_terms) VALUES($1,$2,$3,$4,$5,$6,$7,$8,$9,$10) RETURNING *',[meter,tenant,unit,ref,amount,freq,start,end,day,String(b.terms||'')])).rows[0];
  await generateCharges(pool,l.id);await pool.query("INSERT INTO admin_actions(action,meter_number,detail,status) VALUES('RENT_LEASE_CREATED',$1,$2,'DONE')",[meter,JSON.stringify({leaseId:l.id,tenant,unit,amount,frequency:freq,accountRef:ref})]);res.json({ok:true,lease:l});
 }));
 app.patch(admin+'/leases/:id',wrap(async(req,res)=>{
  const b=req.body||{},amount=Number(b.rentAmount),freq=String(b.billingFrequency||''),day=Number(b.dueDay||1),status=String(b.status||'active'),end=b.endDate?String(b.endDate).slice(0,10):null;
  if(!Number.isSafeInteger(amount)||amount<1||!FREQUENCIES[freq]||day<1||day>28||!['active','ended','suspended'].includes(status))return res.status(400).json({ok:false,message:'Enter a valid rent amount, billing frequency, due day and status.'});
  const client=await pool.connect();
  try{await client.query('BEGIN');
   const old=(await client.query('SELECT * FROM rent_leases WHERE id=$1 FOR UPDATE',[req.params.id])).rows[0];if(!old){await client.query('ROLLBACK');return res.status(404).json({ok:false,message:'Tenancy not found.'});}
   const changed=old.billing_frequency!==freq;
   await client.query('UPDATE rent_leases SET rent_amount=$2,billing_frequency=$3,due_day=$4,status=$5,end_date=$6,updated_at=now() WHERE id=$1',[old.id,amount,freq,day,status,end]);
   if(changed)await client.query('DELETE FROM rent_charges c WHERE c.lease_id=$1 AND c.period_start >= $2 AND NOT EXISTS(SELECT 1 FROM rent_allocations a WHERE a.charge_id=c.id)',[old.id,todayNairobi()]);
   else await client.query("UPDATE rent_charges c SET amount=$2,due_date=(date_trunc('month',c.period_start)::date + (LEAST($3,extract(day from (date_trunc('month',c.period_start)+interval '1 month - 1 day'))::int)-1)) WHERE c.lease_id=$1 AND c.period_start >= $4 AND NOT EXISTS(SELECT 1 FROM rent_allocations a WHERE a.charge_id=c.id)",[old.id,amount,day,todayNairobi()]);
   await client.query('COMMIT');
  }catch(e){await client.query('ROLLBACK').catch(()=>{});throw e;}finally{client.release();}
  if(status==='active')await generateCharges(pool,req.params.id);
  await pool.query("INSERT INTO admin_actions(action,detail,status) VALUES('RENT_LEASE_UPDATED',$1,'DONE')",[JSON.stringify({leaseId:req.params.id,rentAmount:amount,billingFrequency:freq,dueDay:day,status})]);
  res.json({ok:true});
 }));
 app.post(admin+'/leases/:id/generate',wrap(async(req,res)=>res.json({ok:true,created:await generateCharges(pool,req.params.id)})));
 app.get(admin+'/payments/unallocated',wrap(async(_req,res)=>res.json({ok:true,items:(await pool.query("SELECT * FROM rent_payments WHERE status IN ('unallocated','review') OR (lease_id IS NULL AND status='confirmed') ORDER BY created_at DESC LIMIT 200")).rows})));
 app.post(admin+'/payments/:id/reconcile',wrap(async(req,res)=>{
  const ref=String(req.body&&req.body.rentAccountRef||'').trim(),l=(await pool.query("SELECT * FROM rent_leases WHERE rent_account_ref=$1 AND status='active'",[ref])).rows[0];if(!l)return res.status(404).json({ok:false,message:'No active tenancy matches that rent account.'});
  const p=(await pool.query('SELECT * FROM rent_payments WHERE id=$1',[req.params.id])).rows[0];if(!p||p.status==='failed')return res.status(404).json({ok:false,message:'Payment not found or failed.'});if(p.lease_id&&p.lease_id!==l.id)return res.status(409).json({ok:false,message:'Payment belongs to another tenancy.'});
  await pool.query("UPDATE rent_payments SET lease_id=$2,rent_account_ref=$3,status='confirmed',updated_at=now() WHERE id=$1",[p.id,l.id,l.rent_account_ref]);await generateCharges(pool,l.id);await allocateRentPayment(pool,p.id);await createReceipt(pool,p.id);
  await pool.query("INSERT INTO admin_actions(action,meter_number,detail,status) VALUES('RENT_PAYMENT_RECONCILED',$1,$2,'DONE')",[l.meter_code,JSON.stringify({paymentId:p.id,amount:p.amount,accountRef:ref})]);res.json({ok:true});
 }));
 
 const csvCell=v=>'"'+String(v??'').replace(/"/g,'""')+'"';
 const sendCsv=(res,name,rows)=>{const body=rows.map(row=>row.map(csvCell).join(',')).join('\r\n');res.setHeader('Content-Type','text/csv; charset=utf-8');res.setHeader('Content-Disposition','attachment; filename="'+name+'"');res.send('\uFEFF'+body);};
 app.get(admin+'/reports',wrap(async(req,res)=>{
  const from=/^\d{4}-\d{2}-\d{2}$/.test(String(req.query.from||''))?String(req.query.from):iso(addMonths(todayNairobi(),-1));
  const to=/^\d{4}-\d{2}-\d{2}$/.test(String(req.query.to||''))?String(req.query.to):todayNairobi();
  if(from>to)return res.status(400).json({ok:false,message:'Start date must be before end date.'});
  const summary=(await pool.query(`
   WITH period_charges AS (
    SELECT c.id,c.lease_id,c.amount,c.due_date, c.amount-COALESCE(sum(a.amount),0)::int balance
    FROM rent_charges c LEFT JOIN rent_allocations a ON a.charge_id=c.id
    WHERE c.period_start BETWEEN $1::date AND $2::date GROUP BY c.id
   ), period_payments AS (
    SELECT p.id,p.lease_id,p.amount,p.status,COALESCE(p.transaction_time,p.created_at) paid_at
    FROM rent_payments p WHERE p.status IN ('confirmed','allocated') AND COALESCE(p.transaction_time,p.created_at)::date BETWEEN $1::date AND $2::date
   )
   SELECT
    COALESCE((SELECT sum(amount) FROM period_charges),0)::bigint expected,
    COALESCE((SELECT sum(amount) FROM period_payments),0)::bigint collected,
    COALESCE((SELECT sum(balance) FROM period_charges),0)::bigint outstanding,
    COALESCE((SELECT sum(balance) FROM period_charges WHERE due_date<current_date AND balance>0),0)::bigint overdue,
    (SELECT count(*) FROM period_charges WHERE balance>0)::int accounts_with_balance,
    (SELECT count(*) FROM rent_leases WHERE status='active' AND (end_date IS NULL OR end_date>=current_date))::int occupied,
    (SELECT count(*) FROM meters)::int units,
    (SELECT count(*) FROM meters m WHERE NOT EXISTS(SELECT 1 FROM rent_leases l WHERE l.meter_code=m.meter_code AND l.status='active' AND (l.end_date IS NULL OR l.end_date>=current_date)))::int vacant
  `,[from,to])).rows[0];
  const months=(await pool.query(`
   SELECT to_char(date_trunc('month',d)::date,'YYYY-MM') month,
    COALESCE((SELECT sum(c.amount) FROM rent_charges c WHERE c.period_start>=date_trunc('month',d)::date AND c.period_start<(date_trunc('month',d)+interval '1 month')::date),0)::bigint expected,
    COALESCE((SELECT sum(p.amount) FROM rent_payments p WHERE p.status IN ('confirmed','allocated') AND COALESCE(p.transaction_time,p.created_at)>=date_trunc('month',d) AND COALESCE(p.transaction_time,p.created_at)<date_trunc('month',d)+interval '1 month'),0)::bigint collected
   FROM generate_series(date_trunc('month',$1::date),date_trunc('month',$2::date),interval '1 month') d ORDER BY d
  `,[from,to])).rows;
  const arrears=(await pool.query(`
   SELECT l.id,l.tenant_name,l.unit_label,l.rent_account_ref,l.rent_amount,
    sum(c.amount)::bigint charged,COALESCE(sum(x.paid),0)::bigint paid,
    sum(c.amount-COALESCE(x.paid,0))::bigint balance,min(c.due_date) oldest_due
   FROM rent_leases l JOIN rent_charges c ON c.lease_id=l.id
   LEFT JOIN (SELECT charge_id,sum(amount) paid FROM rent_allocations GROUP BY charge_id) x ON x.charge_id=c.id
   WHERE c.due_date<current_date AND c.amount>COALESCE(x.paid,0)
   GROUP BY l.id HAVING sum(c.amount-COALESCE(x.paid,0))>0 ORDER BY balance DESC
  `)).rows;
  res.json({ok:true,from,to,summary:{...summary,collectionRate:Number(summary.expected)>0?Math.round(Number(summary.collected)/Number(summary.expected)*10000)/100:0},months,arrears});
 }));
 app.get(admin+'/reports/export',wrap(async(req,res)=>{
  const type=String(req.query.type||'collections'),from=String(req.query.from||'2000-01-01'),to=String(req.query.to||todayNairobi());
  if(!/^\d{4}-\d{2}-\d{2}$/.test(from)||!/^\d{4}-\d{2}-\d{2}$/.test(to)||from>to)return res.status(400).send('Invalid date range');
  if(type==='arrears'){
   const rows=(await pool.query(`SELECT l.tenant_name,l.unit_label,l.rent_account_ref,c.period_start,c.due_date,c.amount,COALESCE(sum(a.amount),0)::int paid,(c.amount-COALESCE(sum(a.amount),0))::int balance FROM rent_charges c JOIN rent_leases l ON l.id=c.lease_id LEFT JOIN rent_allocations a ON a.charge_id=c.id WHERE c.due_date<current_date GROUP BY c.id,l.id HAVING c.amount>COALESCE(sum(a.amount),0) ORDER BY c.due_date,l.unit_label`)).rows;
   return sendCsv(res,'mauriskade-arrears-'+from+'-'+to+'.csv',[['Tenant','Unit','Rent account','Period start','Due date','Charged KSh','Paid KSh','Balance KSh'],...rows.map(x=>[x.tenant_name,x.unit_label,x.rent_account_ref,x.period_start,x.due_date,x.amount,x.paid,x.balance])]);
  }
  if(type==='statements'){
   const leaseId=String(req.query.leaseId||'');if(!leaseId)return res.status(400).send('Select a tenancy for its statement');
   const l=(await pool.query('SELECT * FROM rent_leases WHERE id=$1',[leaseId])).rows[0];if(!l)return res.status(404).send('Tenancy not found');
   const charges=(await pool.query(`SELECT c.period_start::text date,'Rent charge' kind,c.amount::bigint amount,COALESCE(sum(a.amount),0)::bigint allocated FROM rent_charges c LEFT JOIN rent_allocations a ON a.charge_id=c.id WHERE c.lease_id=$1 AND c.period_start BETWEEN $2::date AND $3::date GROUP BY c.id ORDER BY c.period_start`,[leaseId,from,to])).rows;
   const payments=(await pool.query(`SELECT COALESCE(p.transaction_time,p.created_at)::date::text date,'Payment '+p.method kind,p.amount::bigint amount,COALESCE(sum(a.amount),0)::bigint allocated FROM rent_payments p LEFT JOIN rent_allocations a ON a.payment_id=p.id WHERE p.lease_id=$1 AND p.status IN ('confirmed','allocated') AND COALESCE(p.transaction_time,p.created_at)::date BETWEEN $2::date AND $3::date GROUP BY p.id ORDER BY date`,[leaseId,from,to])).rows;
   const entries=[...charges.map(x=>[x.date,x.kind,x.amount,x.allocated]),...payments.map(x=>[x.date,x.kind,-Number(x.amount),x.allocated])].sort((a,b)=>String(a[0]).localeCompare(String(b[0])));
   return sendCsv(res,'statement-'+l.rent_account_ref+'-'+from+'-'+to+'.csv',[['Tenant',l.tenant_name],['Unit',l.unit_label],['Rent account',l.rent_account_ref],[],['Date','Description','Debit/Credit KSh','Allocated KSh'],...entries]);
  }
  const rows=(await pool.query(`SELECT p.created_at::date date,l.tenant_name,l.unit_label,p.rent_account_ref,p.amount,p.method,p.status,p.mpesa_receipt,r.receipt_number FROM rent_payments p LEFT JOIN rent_leases l ON l.id=p.lease_id LEFT JOIN rent_receipts r ON r.payment_id=p.id WHERE p.status IN ('confirmed','allocated') AND COALESCE(p.transaction_time,p.created_at)::date BETWEEN $1::date AND $2::date ORDER BY p.created_at`,[from,to])).rows;
  return sendCsv(res,'mauriskade-collections-'+from+'-'+to+'.csv',[['Date','Tenant','Unit','Rent account','Amount KSh','Method','Status','M-Pesa receipt','Receipt number'],...rows.map(x=>[x.date,x.tenant_name,x.unit_label,x.rent_account_ref,x.amount,x.method,x.status,x.mpesa_receipt,x.receipt_number])]);
 }));

 app.post(admin+'/c2b/register',wrap(async(_req,res)=>res.status(409).json({ok:false,message:'This shortcode uses the shared Webazi C2B gateway. Registering Mauriskade-specific URLs here would overwrite the shared callbacks. Manage registration from the Webazi Daraja service only.'})));
 app.get(admin+'/agreements/:leaseId',wrap(async(req,res)=>{
  const l=(await pool.query('SELECT * FROM rent_leases WHERE id=$1',[req.params.leaseId])).rows[0];if(!l)return res.status(404).json({ok:false,message:'Tenancy not found.'});res.json({ok:true,lease:l,agreements:(await pool.query('SELECT * FROM tenancy_agreements WHERE lease_id=$1 ORDER BY version DESC',[l.id])).rows});
 }));
 app.post(admin+'/agreements/:leaseId',wrap(async(req,res)=>{
  const l=(await pool.query('SELECT * FROM rent_leases WHERE id=$1',[req.params.leaseId])).rows[0],body=String(req.body&&req.body.body||'').trim(),title=String(req.body&&req.body.title||'Tenancy Agreement').trim();if(!l)return res.status(404).json({ok:false,message:'Tenancy not found.'});if(body.length<100||body.length>30000)return res.status(400).json({ok:false,message:'Agreement must be between 100 and 30,000 characters.'});
  const v=Number((await pool.query('SELECT COALESCE(max(version),0)+1 n FROM tenancy_agreements WHERE lease_id=$1',[l.id])).rows[0].n);const a=(await pool.query("INSERT INTO tenancy_agreements(lease_id,version,title,body,status) VALUES($1,$2,$3,$4,'draft') RETURNING *",[l.id,v,title,body])).rows[0];res.json({ok:true,agreement:a});
 }));
 app.post(admin+'/agreements/:id/issue',wrap(async(req,res)=>{
  const a=(await pool.query("UPDATE tenancy_agreements SET status='issued',issued_at=now() WHERE id=$1 AND status='draft' RETURNING *",[req.params.id])).rows[0];if(!a)return res.status(404).json({ok:false,message:'Draft agreement not found.'});await pool.query("UPDATE tenancy_agreements SET status='superseded' WHERE lease_id=$1 AND id<>$2 AND status='issued'",[a.lease_id,a.id]);await pool.query("INSERT INTO admin_actions(action,detail,status) VALUES('TENANCY_AGREEMENT_ISSUED',$1,'DONE')",[JSON.stringify({agreementId:a.id,leaseId:a.lease_id,version:a.version})]);res.json({ok:true,agreement:a});
 }));
 app.post('/api/mpesa/rent-c2b/:secret/validation',(req,res)=>{if(String(req.params.secret)!==String(callbackSecret))return res.sendStatus(403);res.json({ResultCode:0,ResultDesc:'Accepted'});});
 app.post('/api/mpesa/rent-c2b/:secret/confirmation',wrap(async(req,res)=>{
  if(String(req.params.secret)!==String(callbackSecret))return res.sendStatus(403);const b=req.body||{},receipt=String(b.TransID||'').trim(),ref=String(b.BillRefNumber||'').trim(),amount=Number(b.TransAmount);if(!receipt||!ref||!Number.isSafeInteger(amount)||amount<1)return res.json({ResultCode:0,ResultDesc:'Accepted'});
  const l=(await pool.query("SELECT * FROM rent_leases WHERE rent_account_ref=$1 AND status='active'",[ref])).rows[0],t=String(b.TransTime||''),time=/^\d{14}$/.test(t)?new Date(Date.UTC(+t.slice(0,4),+t.slice(4,6)-1,+t.slice(6,8),+t.slice(8,10)-3,+t.slice(10,12),+t.slice(12,14))).toISOString():null;
  const p=(await pool.query("INSERT INTO rent_payments(lease_id,rent_account_ref,payer_phone,amount,method,status,mpesa_receipt,transaction_time,raw_payload) VALUES($1,$2,$3,$4,'mpesa_paybill',$5,$6,$7,$8) ON CONFLICT(mpesa_receipt) DO NOTHING RETURNING id",[l?l.id:null,ref,b.MSISDN?String(b.MSISDN):null,amount,l?'confirmed':'unallocated',receipt,time,JSON.stringify(b)])).rows[0];
  if(p){if(l){await generateCharges(pool,l.id);await allocateRentPayment(pool,p.id);await createReceipt(pool,p.id);}await pool.query("INSERT INTO admin_actions(action,meter_number,detail,status) VALUES('RENT_C2B_RECEIVED',$1,$2,'DONE')",[l?l.meter_code:null,JSON.stringify({receipt,amount,accountRef:ref,matched:!!l})]);}
  res.json({ResultCode:0,ResultDesc:'Accepted'});
 }));
}

async function processRentC2B(pool,b){
 const receipt=String(b.TransID||'').trim(),ref=String(b.BillRefNumber||'').trim(),amount=Number(b.TransAmount);
 if(!receipt||!/^RENT-/i.test(ref)||!Number.isSafeInteger(amount)||amount<1)throw new Error('Invalid Mauriskade rent C2B payload');
 const l=(await pool.query("SELECT * FROM rent_leases WHERE rent_account_ref=$1 AND status='active'",[ref])).rows[0];
 const t=String(b.TransTime||''),time=/^\d{14}$/.test(t)?new Date(Date.UTC(+t.slice(0,4),+t.slice(4,6)-1,+t.slice(6,8),+t.slice(8,10)-3,+t.slice(10,12),+t.slice(12,14))).toISOString():null;
 const p=(await pool.query("INSERT INTO rent_payments(lease_id,rent_account_ref,payer_phone,amount,method,status,mpesa_receipt,transaction_time,raw_payload) VALUES($1,$2,$3,$4,'mpesa_paybill',$5,$6,$7,$8) ON CONFLICT(mpesa_receipt) DO NOTHING RETURNING id",[l?l.id:null,ref,b.MSISDN?String(b.MSISDN):null,amount,l?'confirmed':'unallocated',receipt,time,JSON.stringify(b)])).rows[0];
 if(p){if(l){await generateCharges(pool,l.id);await allocateRentPayment(pool,p.id);await createReceipt(pool,p.id);}await pool.query("INSERT INTO admin_actions(action,meter_number,detail,status) VALUES('RENT_C2B_RECEIVED',$1,$2,'DONE')",[l?l.meter_code:null,JSON.stringify({receipt,amount,accountRef:ref,matched:!!l})]);}
 return {duplicate:!p,matched:!!l};
}

module.exports={registerRentRoutes,processRentStkCallback,processRentC2B,generateCharges,allocateRentPayment,makeReceiptPdf};
