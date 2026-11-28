'use strict';
const crypto = require('crypto');
const FREQUENCIES = {monthly:1,quarterly:3,half_yearly:6,annually:12};
const VALID_DATE = /^\d{4}-\d{2}-\d{2}$/;
const validDate = value => VALID_DATE.test(String(value||'')) && Number.isFinite(Date.parse(String(value)+'T00:00:00Z')) && iso(new Date(String(value)+'T00:00:00Z'))===String(value);
const validRentReference = value => /^RENT-[A-Z0-9]{1,7}$/.test(String(value||''));
const todayNairobi = () => iso(new Date(Date.now()+3*3600000));
const iso = d => { if (!(d instanceof Date) || !Number.isFinite(d.getTime())) throw new TypeError('Invalid date supplied to rent schedule'); return d.toISOString().slice(0,10); };
const dateOnly = value => {
 if (value instanceof Date) return iso(value);
 const s=String(value??'').trim();
 if (s.length===10 && s[4]==='-' && s[7]==='-' && Number.isFinite(Date.parse(s+'T00:00:00Z'))) return s;
 const d=new Date(s);
 if (!Number.isFinite(d.getTime())) throw new TypeError('Invalid tenancy date: '+s);
 return iso(d);
};
const addMonths = (s,n) => { const d=new Date(dateOnly(s)+'T00:00:00Z'),day=d.getUTCDate();d.setUTCDate(1);d.setUTCMonth(d.getUTCMonth()+n);d.setUTCDate(Math.min(day,new Date(Date.UTC(d.getUTCFullYear(),d.getUTCMonth()+1,0)).getUTCDate()));return d; };
const dueDate = (s,day) => {const d=new Date(dateOnly(s)+'T00:00:00Z');d.setUTCDate(Math.min(Number(day)||1,new Date(Date.UTC(d.getUTCFullYear(),d.getUTCMonth()+1,0)).getUTCDate()));return iso(d);};
const esc = v => String(v??'').replace(/[&<>"']/g,c=>({'&':'&amp;','<':'&lt;','>':'&gt;','"':'&quot;',"'":'&#39;'}[c]));
const adminActor = req => req.adminActor || {id:'legacy-owner',displayName:'Property Owner',role:'owner'};
const tenantPassword = () => crypto.randomBytes(9).toString('base64url');
const tenantPasswordHash = password => {const salt=crypto.randomBytes(16),hash=crypto.scryptSync(password,salt,64);return `scrypt${salt.toString('base64')}${hash.toString('base64')}`;};
async function customerLease(pool,user){
 if(user.rent_lease_id)return (await pool.query("SELECT * FROM rent_leases WHERE id=$1 AND status='active' AND start_date<=$2::date AND (end_date IS NULL OR end_date>=$2::date)",[user.rent_lease_id,todayNairobi()])).rows[0]||null;
 if(!user.meter_code)return null;
 return (await pool.query("SELECT * FROM rent_leases WHERE meter_code=$1 AND status='active' AND start_date<=$2::date AND (end_date IS NULL OR end_date>=$2::date) ORDER BY start_date DESC,created_at DESC LIMIT 1",[user.meter_code,todayNairobi()])).rows[0]||null;
}
const wrap = fn => (req,res,next)=>Promise.resolve(fn(req,res,next)).catch(e=>{console.error('rent route',req.method,req.path,e.message);if(!res.headersSent)res.status(500).json({ok:false,message:'Rental service error. Please try again.'});});

async function allocateRentPayment(pool,id){
 const client=await pool.connect();
 try{
  await client.query('BEGIN');
  const p=(await client.query('SELECT * FROM rent_payments WHERE id=$1 FOR UPDATE',[id])).rows[0];
  if(!p||!p.lease_id||!['confirmed','unallocated','allocated'].includes(p.status)){await client.query('COMMIT');return;}
  let left=Number(p.amount)-Number((await client.query('SELECT COALESCE(sum(amount),0)::int n FROM rent_allocations WHERE payment_id=$1 AND reversed_at IS NULL',[id])).rows[0].n);
  const setting=(await client.query("SELECT allocation_rule FROM rent_settings WHERE singleton=true")).rows[0];
  const orderBy=({oldest_due_first:'c.due_date ASC,c.period_start ASC',oldest_period_first:'c.period_start ASC,c.due_date ASC',newest_due_first:'c.due_date DESC,c.period_start DESC'})[setting&&setting.allocation_rule]||'c.due_date ASC,c.period_start ASC';
  const charges=(await client.query("SELECT c.id,c.amount-COALESCE(a.paid,0)::int balance FROM rent_charges c LEFT JOIN (SELECT charge_id,sum(amount) paid FROM rent_allocations WHERE reversed_at IS NULL GROUP BY charge_id) a ON a.charge_id=c.id WHERE c.lease_id=$1 AND c.voided_at IS NULL AND c.due_date<=$2::date AND c.amount>COALESCE(a.paid,0) ORDER BY "+orderBy+" FOR UPDATE OF c",[p.lease_id,todayNairobi()])).rows;
  for(const c of charges){if(left<=0)break;const n=Math.min(left,Number(c.balance));if(n>0){await client.query('INSERT INTO rent_allocations(payment_id,charge_id,amount) VALUES($1,$2,$3) ON CONFLICT(payment_id,charge_id) DO UPDATE SET amount=rent_allocations.amount+EXCLUDED.amount',[id,c.id,n]);left-=n;}}
  await client.query("UPDATE rent_payments SET status='allocated',updated_at=now() WHERE id=$1",[id]);
  await client.query('COMMIT');
 }catch(e){await client.query('ROLLBACK').catch(()=>{});throw e;}finally{client.release();}
}
async function generateCharges(pool,id){
 const l=(await pool.query("SELECT * FROM rent_leases WHERE id=$1 AND status='active'",[id])).rows[0];if(!l)return 0;
 const step=FREQUENCIES[l.billing_frequency],today=todayNairobi(),horizon=addMonths(today,18);let period=dateOnly(l.start_date),count=0;const leaseEnd=l.end_date?dateOnly(l.end_date):null;
 for(let n=0;n<240;n++){if(new Date(period+'T00:00:00Z')>horizon)break;const next=addMonths(period,step),periodEnd=new Date(next.getTime()-86400000);if(leaseEnd&&period>leaseEnd)break;const end=leaseEnd&&leaseEnd<iso(periodEnd)?new Date(leaseEnd+'T00:00:00Z'):periodEnd;
  const fullDays=Math.max(1,Math.round((next.getTime()-new Date(period+'T00:00:00Z').getTime())/86400000));
  const occupiedDays=Math.max(1,Math.round((end.getTime()-new Date(period+'T00:00:00Z').getTime())/86400000)+1);
  const chargeAmount=occupiedDays<fullDays?Math.max(1,Math.round(Number(l.rent_amount)*occupiedDays/fullDays)):Number(l.rent_amount);
  const r=await pool.query("INSERT INTO rent_charges(lease_id,period_start,period_end,due_date,amount,charge_type) VALUES($1,$2,$3,$4,$5,'rent') ON CONFLICT(lease_id,period_start,charge_type) WHERE voided_at IS NULL DO NOTHING",[id,period,iso(end),dueDate(period,l.due_day),chargeAmount]);count+=r.rowCount;period=iso(next);}
 if(typeof pool.connect==='function'){const ps=(await pool.query("SELECT id FROM rent_payments WHERE lease_id=$1 AND status IN ('confirmed','unallocated','allocated') ORDER BY created_at",[id])).rows;for(const p of ps)await allocateRentPayment(pool,p.id);}return count;
}
async function createReceipt(pool,id){
 const p=(await pool.query('SELECT p.*,l.tenant_name,l.unit_label FROM rent_payments p LEFT JOIN rent_leases l ON l.id=p.lease_id WHERE p.id=$1',[id])).rows[0];if(!p||p.status==='pending'||p.status==='failed'||p.status==='review'||p.method==='credit_adjustment'||p.status==='reversed')return;
 const n='MR-'+new Date().toISOString().slice(0,10).replace(/-/g,'')+'-'+crypto.randomBytes(3).toString('hex').toUpperCase();
 await pool.query('INSERT INTO rent_receipts(payment_id,receipt_number) VALUES($1,$2) ON CONFLICT(payment_id) DO NOTHING',[id,n]);
}

function makeReceiptPdf(lines) {
 const nl=String.fromCharCode(10),pageH=842,ops=[];
 const clean=v=>String(v??'').normalize('NFKD').replace(/[^\x20-\x7E]/g,'?').replace(/\\/g,'\\\\').replace(/\(/g,'\\(').replace(/\)/g,'\\)');
 const fill=(r,g,b)=>ops.push(r+' '+g+' '+b+' rg');
 const stroke=(r,g,b)=>ops.push(r+' '+g+' '+b+' RG');
 const rect=(x,top,w,h,r,g,b)=>{fill(r,g,b);ops.push(x+' '+(pageH-top-h)+' '+w+' '+h+' re f');};
 const line=(x1,y1,x2,y2,r,g,b,width)=>{stroke(r,g,b);ops.push(width+' w '+x1+' '+(pageH-y1)+' m '+x2+' '+(pageH-y2)+' l S');};
 const txt=(value,x,top,size,font,color,align)=>{
   const str=clean(value),approx=str.length*size*(font==='F2'?.56:.51),xx=align==='right'?x-approx:align==='center'?x-approx/2:x;
   fill(color[0],color[1],color[2]);ops.push('BT /'+font+' '+size+' Tf 1 0 0 1 '+xx.toFixed(2)+' '+(pageH-top-size).toFixed(2)+' Tm ('+str+') Tj ET');
 };
 const source=Array.isArray(lines)?lines.map(v=>String(v??'')):[];
 const first=source[0]||'PAYMENT RECEIPT',settlement=/SETTLEMENT/i.test(first),title=settlement?'FINAL TENANCY SETTLEMENT':/WATER/i.test(first)?'WATER PAYMENT RECEIPT':'RENT PAYMENT RECEIPT';
 const fields=source.slice(1).map(v=>{const i=v.indexOf(':');return i>0?{label:v.slice(0,i).trim(),value:v.slice(i+1).trim()}:{label:'Details',value:v};});
 const amount=fields.find(x=>/^amount received$/i.test(x.label)||(settlement&&/^final rent due$/i.test(x.label)));
 const details=fields.filter(x=>x!==amount);
 const receipt=fields.find(x=>/^receipt( \/ mpesa code)?$/i.test(x.label));
 const status=fields.find(x=>/^status$/i.test(x.label));
 rect(0,0,595,150,.035,.20,.31);rect(0,140,595,10,.035,.57,.56);
 txt('MAURISKADE MANAGEMENT',42,34,10,'F2',[.63,.94,.91]);
 txt(title,42,64,22,'F2',[1,1,1]);
 txt(settlement?'OFFICIAL TENANCY SETTLEMENT STATEMENT':'OFFICIAL PAYMENT CONFIRMATION',42,101,8,'F1',[.78,.88,.92]);
 rect(433,35,120,28,.08,.34,.31);txt(settlement?'FINAL STATEMENT':'PAYMENT VERIFIED',493,44,7,'F2',[.88,1,.96],'center');
 rect(34,174,527,112,.94,.97,.97);rect(34,174,4,112,.02,.58,.56);
 txt(settlement?'FINAL RENT DUE':'AMOUNT RECEIVED',57,195,8,'F2',[.38,.49,.54]);
 txt(amount?amount.value:'See payment details',57,220,25,'F2',[.035,.28,.36]);
 if(receipt)txt('REFERENCE  '+receipt.value,57,261,8,'F1',[.34,.47,.53]);
 txt('TRANSACTION DETAILS',42,315,9,'F2',[.035,.32,.40]);line(42,337,553,337,.84,.89,.91,.8);
 let y=352;const rowStep=settlement?21:31;
 for(const item of details){
   const val=item.value||'—';
   txt(item.label.toUpperCase(),48,y,settlement?6.4:7.4,'F2',[.43,.53,.58]);
   if(val.length>48){
     const parts=[];for(let i=0;i<val.length;i+=65)parts.push(val.slice(i,i+65));
     txt(parts[0],545,y,settlement?7:8.3,'F1',[.13,.25,.32],'right');
     if(parts[1])txt(parts.slice(1).join(' '),545,y+10,settlement?6.8:8,'F1',[.13,.25,.32],'right');
     y+=settlement?29:40;
   }else{txt(val,545,y,settlement?7.2:8.8,'F1',[.13,.25,.32],'right');y+=rowStep;}
   line(48,y-8,547,y-8,.91,.94,.95,.55);
 }
 const footY=Math.min(786,Math.max(settlement?710:735,y+12));
 rect(34,footY,527,44,.93,.97,.96);
 txt(settlement?'SETTLEMENT SUMMARY':'THANK YOU',50,footY+9,8,'F2',[.04,.42,.39]);
 txt(status?status.value:'Payment recorded successfully.',50,footY+23,7.5,'F1',[.28,.43,.46]);
 txt('Mauriskade Management  |  Keep this receipt for your records',297.5,817,7,'F1',[.48,.56,.60],'center');
 const stream=ops.join(nl);
 const objects=[
  '<< /Type /Catalog /Pages 2 0 R >>',
  '<< /Type /Pages /Kids [3 0 R] /Count 1 >>',
  '<< /Type /Page /Parent 2 0 R /MediaBox [0 0 595 842] /Resources << /Font << /F1 5 0 R /F2 6 0 R >> >> /Contents 4 0 R >>',
  '<< /Length '+Buffer.byteLength(stream)+' >>'+nl+'stream'+nl+stream+nl+'endstream',
  '<< /Type /Font /Subtype /Type1 /BaseFont /Helvetica >>',
  '<< /Type /Font /Subtype /Type1 /BaseFont /Helvetica-Bold >>'
 ];
 let pdf='%PDF-1.4'+nl,offsets=[0];
 for(let i=0;i<objects.length;i++){offsets.push(Buffer.byteLength(pdf));pdf+=(i+1)+' 0 obj'+nl+objects[i]+nl+'endobj'+nl;}
 const xref=Buffer.byteLength(pdf);pdf+='xref'+nl+'0 7'+nl+'0000000000 65535 f '+nl;
 for(let i=1;i<offsets.length;i++)pdf+=String(offsets[i]).padStart(10,'0')+' 00000 n '+nl;
 pdf+='trailer'+nl+'<< /Size 7 /Root 1 0 R >>'+nl+'startxref'+nl+xref+nl+'%%EOF';
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
  const l=await customerLease(pool,req.user);
  if(!l)return res.json({ok:true,lease:null,charges:[],payments:[],credit:0,arrears:0});
  await generateCharges(pool,l.id);
  const charges=(await pool.query('SELECT c.id,c.period_start,c.period_end,c.due_date,c.amount,(c.due_date<$2::date) AS overdue,COALESCE(sum(a.amount),0)::int paid,(c.amount-COALESCE(sum(a.amount),0))::int balance FROM rent_charges c LEFT JOIN rent_allocations a ON a.charge_id=c.id AND a.reversed_at IS NULL WHERE c.lease_id=$1 AND c.voided_at IS NULL GROUP BY c.id ORDER BY c.period_start DESC LIMIT 36',[l.id,todayNairobi()])).rows;
  const payments=(await pool.query("SELECT p.id,p.amount,p.method,p.status,p.mpesa_receipt,p.external_reference,p.created_at,r.id receipt_id,r.receipt_number,r.status receipt_status FROM rent_payments p LEFT JOIN rent_receipts r ON r.payment_id=p.id WHERE p.lease_id=$1 AND p.method<>'credit_adjustment' ORDER BY p.created_at DESC LIMIT 50",[l.id])).rows;
  const credit=(await pool.query("SELECT GREATEST(0,COALESCE(sum(p.amount),0)-COALESCE((SELECT sum(a.amount) FROM rent_allocations a JOIN rent_payments x ON x.id=a.payment_id WHERE x.lease_id=$1 AND x.status IN ('confirmed','allocated') AND a.reversed_at IS NULL),0)-COALESCE((SELECT sum(amount) FROM rent_credit_refunds WHERE lease_id=$1 AND status IN ('approved','paid')),0)-COALESCE((SELECT sum(amount) FROM rent_credit_transfers WHERE from_lease_id=$1 AND status='posted'),0)) n FROM rent_payments p WHERE p.lease_id=$1 AND p.status IN ('confirmed','allocated')",[l.id])).rows[0].n;
  const arrears=(await pool.query("SELECT COALESCE(sum(c.amount-COALESCE(a.paid,0)),0)::bigint n FROM rent_charges c LEFT JOIN (SELECT charge_id,sum(amount) paid FROM rent_allocations WHERE reversed_at IS NULL GROUP BY charge_id) a ON a.charge_id=c.id WHERE c.lease_id=$1 AND c.voided_at IS NULL AND c.due_date<$2::date AND c.amount>COALESCE(a.paid,0)",[l.id,todayNairobi()])).rows[0].n;
  const agreement=(await pool.query("SELECT id,title,version,issued_at,split_part(body,'|',2) AS file_mime,split_part(body,'|',3) AS file_name FROM tenancy_agreements WHERE lease_id=$1 AND status='issued' AND body LIKE 'MAURISKADE_AGREEMENT_FILE_V1%' ORDER BY version DESC LIMIT 1",[l.id])).rows[0]||null;
  res.json({ok:true,lease:l,charges,payments,agreement,credit:Number(credit)||0,paybill:mpesaShortcode,arrears:Number(arrears)||0});
 }));
 app.get('/api/me/rent/statement',...customer,wrap(async(req,res)=>{
  const l=await customerLease(pool,req.user);if(!l)return res.json({ok:true,lease:null,entries:[],balance:0});
  const rows=(await pool.query(`SELECT date,description,amount,reference,allocated FROM (
   SELECT c.period_start::date date,'Rent charge '||to_char(c.period_start,'YYYY-MM-DD') description,c.amount::bigint amount,NULL::text reference,COALESCE((SELECT sum(a.amount) FROM rent_allocations a WHERE a.charge_id=c.id AND a.reversed_at IS NULL),0)::bigint allocated FROM rent_charges c WHERE c.lease_id=$1 AND c.voided_at IS NULL
   UNION ALL
   SELECT COALESCE(p.transaction_time,p.created_at)::date,CASE WHEN p.method='credit_adjustment' THEN 'Approved ledger credit' ELSE 'Payment · '||p.method END,-p.amount::bigint,COALESCE(p.mpesa_receipt,p.external_reference),COALESCE((SELECT sum(a.amount) FROM rent_allocations a WHERE a.payment_id=p.id AND a.reversed_at IS NULL),0)::bigint FROM rent_payments p WHERE p.lease_id=$1 AND p.status IN ('confirmed','allocated')
   UNION ALL
   SELECT created_at::date,'Rent credit refund ('||status||')',amount::bigint,external_reference,0::bigint FROM rent_credit_refunds WHERE lease_id=$1 AND status IN ('approved','paid')
   UNION ALL
   SELECT created_at::date,'Rent credit transfer out',amount::bigint,NULL::text,0::bigint FROM rent_credit_transfers WHERE from_lease_id=$1 AND status='posted'
   UNION ALL
   SELECT COALESCE(p.transaction_time,p.created_at)::date,'Payment reversal · '||COALESCE(p.mpesa_receipt,p.external_reference),p.amount::bigint,COALESCE(p.mpesa_receipt,p.external_reference),0::bigint FROM rent_payments p WHERE p.lease_id=$1 AND p.status='reversed'
  ) ledger ORDER BY date,CASE WHEN amount>0 THEN 0 ELSE 1 END`,[l.id])).rows;
  let balance=0;const entries=rows.map(x=>{balance+=Number(x.amount);return {...x,running_balance:balance};});
  res.json({ok:true,lease:{tenant_name:l.tenant_name,unit_label:l.unit_label,rent_account_ref:l.rent_account_ref},entries,balance,credit:Math.max(0,-balance),amount_due:Math.max(0,balance)});
 }));
 app.post('/api/me/rent/pay',...customer,...(payLimit?[payLimit]:[]),wrap(async(req,res)=>{
  const amount=Number(req.body&&req.body.amount),phone=normPhone(req.body&&req.body.phone);
  if(!Number.isSafeInteger(amount)||amount<1||amount>1000000)return res.status(400).json({ok:false,message:'Enter a valid rent amount.'});
  if(!phone)return res.status(400).json({ok:false,message:'Enter a valid Safaricom number.'});
  const l=await customerLease(pool,req.user);if(!l)return res.status(404).json({ok:false,message:'No active rent account is linked to this login.'});if((await pool.query("SELECT 1 FROM rent_settlements WHERE lease_id=$1 AND status='awaiting_approval'",[l.id])).rowCount)return res.status(409).json({ok:false,message:'Your final rent settlement is being reviewed. Please contact the property office before making another payment.'});
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
  }catch(e){console.error(new Date().toISOString(),'RENT_STK_PUSH_FAILED',{paymentId:id,phone:String(phone).slice(0,5)+'****'+String(phone).slice(-3),error:e.message});await pool.query("UPDATE rent_payments SET status='failed',notes=$2,updated_at=now() WHERE id=$1",[id,e.message]);res.status(502).json({ok:false,message:'Could not start the rent payment prompt. Please try again.'});}
 }));
 app.get('/api/me/rent/payment/:id',...customer,wrap(async(req,res)=>{const lease=await customerLease(pool,req.user);const p=lease?(await pool.query('SELECT id,status,amount,mpesa_receipt,created_at FROM rent_payments WHERE id=$1 AND lease_id=$2',[req.params.id,lease.id])).rows[0]:null;if(!p)return res.status(404).json({ok:false,message:'Rent payment not found.'});res.json({ok:true,payment:p});}));
 app.get('/api/me/rent/receipt/:id',...customer,wrap(async(req,res)=>{
  const lease=await customerLease(pool,req.user);const p=lease?(await pool.query('SELECT p.*,r.receipt_number,l.tenant_name,l.unit_label,l.rent_account_ref FROM rent_payments p JOIN rent_receipts r ON r.payment_id=p.id JOIN rent_leases l ON l.id=p.lease_id WHERE r.id=$1 AND l.id=$2',[req.params.id,lease.id])).rows[0]:null;if(!p)return res.status(404).send('Receipt not found');
  const allocations=(await pool.query('SELECT c.period_start,c.period_end,a.amount FROM rent_allocations a JOIN rent_charges c ON c.id=a.charge_id WHERE a.payment_id=$1 AND a.reversed_at IS NULL ORDER BY c.period_start',[p.id])).rows;
  const allocated=allocations.reduce((n,a)=>n+Number(a.amount),0);
  const lines=[
   'Receipt: '+p.receipt_number,
   'Tenant: '+p.tenant_name,
   'Unit: '+p.unit_label,
   'Rent account: '+p.rent_account_ref,
   'Amount received: KSh '+Number(p.amount).toLocaleString('en-KE'),
   'Payment method: '+p.method,
   'M-Pesa / bank reference: '+(p.mpesa_receipt||p.external_reference||'Not applicable'),
   'Paper receipt number: '+(p.paper_receipt_number||'Not recorded'),
   'Date: '+new Date(p.transaction_time||p.created_at).toLocaleString('en-KE',{timeZone:'Africa/Nairobi'}),
   ...allocations.map(a=>'Allocated to '+dateOnly(a.period_start)+' – '+dateOnly(a.period_end)+': KSh '+Number(a.amount).toLocaleString('en-KE')),
   'Unallocated rent credit: KSh '+Math.max(0,Number(p.amount)-allocated).toLocaleString('en-KE'),
   'Status: '+(p.status==='reversed'||p.receipt_status==='reversed'?'REVERSED — DO NOT USE AS PAYMENT PROOF':'Confirmed')
  ];
  const pdf=makeReceiptPdf(lines);
  res.setHeader('Content-Type','application/pdf');
  res.setHeader('Content-Disposition','attachment; filename="'+p.receipt_number+'.pdf"');
  res.send(pdf);
 }));
 app.get(admin+'/leases',wrap(async(req,res)=>{
  const sql=req.adminActor&&req.adminActor.role==='caretaker'?'SELECT l.id,l.meter_code,l.tenant_name,l.unit_label,l.start_date,l.end_date,l.status FROM rent_leases l LEFT JOIN meters m ON m.meter_code=l.meter_code ORDER BY l.created_at DESC':'SELECT l.*,m.phone FROM rent_leases l LEFT JOIN meters m ON m.meter_code=l.meter_code ORDER BY l.created_at DESC';
  const items=(await pool.query(sql)).rows;res.json({ok:true,items});
 }));
 app.post(admin+'/leases',wrap(async(req,res)=>{
  const b=req.body||{},meter=String(b.meterCode||'').trim()||null,propertyUnitId=String(b.propertyUnitId||'').trim()||null,tenant=String(b.tenantName||'').trim(),unit=String(b.unitLabel||'').trim(),ref=String(b.rentAccountRef||'').trim().toUpperCase(),amount=Number(b.rentAmount),freq=String(b.billingFrequency||'monthly'),start=String(b.startDate||'').slice(0,10),end=b.endDate?String(b.endDate).slice(0,10):null,day=Number(b.dueDay||1),deposit=Number(b.securityDeposit||0),email=String(b.tenantEmail||'').trim().toLowerCase();
  if((!meter&&!propertyUnitId)||!tenant||!unit||!validRentReference(ref)||!Number.isSafeInteger(amount)||amount<1||!FREQUENCIES[freq]||!/^[0-9]{4}-[0-9]{2}-[0-9]{2}$/.test(start)||(end&&(!/^[0-9]{4}-[0-9]{2}-[0-9]{2}$/.test(end)||end<start))||day<1||day>28||!Number.isSafeInteger(deposit)||deposit<0||deposit>10000000||(email&&!/^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(email)))return res.status(400).json({ok:false,message:'Complete all tenancy fields with valid values.'});
  if(!validDate(start)||(end&&!validDate(end)))return res.status(400).json({ok:false,message:'Enter valid tenancy dates.'});
  const client=await pool.connect();let l,previousLoginDisabled=false,temporaryCredentials=null,unitId=propertyUnitId;
  try{await client.query('BEGIN');await client.query('SELECT pg_advisory_xact_lock(hashtext($1))',['rent-unit:'+(propertyUnitId||meter)]);await client.query('SELECT pg_advisory_xact_lock(hashtext($1))',['rent-ref:'+ref]);
   if(meter&&!(await client.query('SELECT 1 FROM meters WHERE meter_code=$1',[meter])).rowCount){await client.query('ROLLBACK');return res.status(404).json({ok:false,message:'Select a registered meter.'});}
   if(unitId){const u=(await client.query('SELECT * FROM property_units WHERE id=$1 FOR UPDATE',[unitId])).rows[0];if(!u){await client.query('ROLLBACK');return res.status(404).json({ok:false,message:'Select a registered property unit.'});}if(u.status==='unavailable'){await client.query('ROLLBACK');return res.status(409).json({ok:false,message:'This unit is marked unavailable and cannot receive a new tenancy.'});}if(meter&&u.meter_code&&u.meter_code!==meter){await client.query('ROLLBACK');return res.status(409).json({ok:false,message:'The selected property unit is linked to a different Hydro meter.'});}if(meter&&!u.meter_code)await client.query('UPDATE property_units SET meter_code=$2,updated_at=now() WHERE id=$1',[unitId,meter]);}
   else if(meter)unitId=(await client.query('SELECT id FROM property_units WHERE meter_code=$1',[meter])).rows[0]?.id||null;
   if(meter&&!unitId&&(await client.query("SELECT 1 FROM property_units WHERE meter_code=$1 AND status='unavailable'",[meter])).rowCount){await client.query('ROLLBACK');return res.status(409).json({ok:false,message:'This unit is marked unavailable and cannot receive a new tenancy.'});}
   if(meter){await client.query("UPDATE rent_leases SET status='ended',updated_at=now() WHERE meter_code=$1 AND status='active' AND end_date<$2::date",[meter,todayNairobi()]);if((await client.query("SELECT 1 FROM rent_leases WHERE meter_code=$1 AND status='active' AND (end_date IS NULL OR end_date>=$2::date)",[meter,todayNairobi()])).rowCount){await client.query('ROLLBACK');return res.status(409).json({ok:false,message:'This unit already has an active tenancy. End the old tenancy before creating another.'});}}
   if(unitId){await client.query("UPDATE rent_leases SET status='ended',updated_at=now() WHERE property_unit_id=$1 AND status='active' AND end_date<$2::date",[unitId,todayNairobi()]);if((await client.query("SELECT 1 FROM rent_leases WHERE property_unit_id=$1 AND status='active' AND (end_date IS NULL OR end_date>=$2::date)",[unitId,todayNairobi()])).rowCount){await client.query('ROLLBACK');return res.status(409).json({ok:false,message:'This property unit already has an active tenancy. End or transfer the current tenancy first.'});}}
   if((await client.query('SELECT 1 FROM rent_leases WHERE rent_account_ref=$1',[ref])).rowCount){await client.query('ROLLBACK');return res.status(409).json({ok:false,message:'Rent account reference has already been used by a current or former tenancy. Use a new reference.'});}
   if(meter){const previous=(await client.query('SELECT tenant_name FROM rent_leases WHERE meter_code=$1 ORDER BY created_at DESC LIMIT 1',[meter])).rows[0];if(previous){const revoked=(await client.query('UPDATE users SET disabled=true WHERE meter_code=$1 RETURNING id',[meter])).rows;if(revoked.length){previousLoginDisabled=true;await client.query('DELETE FROM sessions WHERE user_id=ANY($1::uuid[])',[revoked.map(x=>x.id)]);}}}
   if(unitId){const oldUsers=(await client.query("UPDATE users SET disabled=true WHERE rent_lease_id IN (SELECT id FROM rent_leases WHERE property_unit_id=$1 AND status='ended') RETURNING id",[unitId])).rows;if(oldUsers.length){previousLoginDisabled=true;await client.query('DELETE FROM sessions WHERE user_id=ANY($1::uuid[])',[oldUsers.map(x=>x.id)]);}}
   if(meter)await client.query('UPDATE meters SET rent_account_ref=$2,tenant_name=$3,flat=$4,tenant_email=$5 WHERE meter_code=$1',[meter,ref,tenant,unit,email||null]);
   l=(await client.query(`INSERT INTO rent_leases(meter_code,tenant_name,unit_label,rent_account_ref,rent_amount,billing_frequency,start_date,end_date,due_day,agreement_terms,security_deposit,tenant_email,property_unit_id) VALUES($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,$11,$12,$13) RETURNING *`,[meter,tenant,unit,ref,amount,freq,start,end,day,String(b.terms||''),deposit,email||null,unitId])).rows[0];
   if(!meter){if((await client.query('SELECT 1 FROM users WHERE username=$1',[ref])).rowCount){await client.query('ROLLBACK');return res.status(409).json({ok:false,message:'That rent account reference is already used as a customer login username.'});}const password=tenantPassword();await client.query('INSERT INTO users(meter_code,rent_lease_id,username,password_hash,must_change,disabled) VALUES(NULL,$1,$2,$3,true,false)',[l.id,ref,tenantPasswordHash(password)]);temporaryCredentials={username:ref,password};}
   await client.query('COMMIT');
  }catch(e){await client.query('ROLLBACK').catch(()=>{});throw e;}finally{client.release();}
  await generateCharges(pool,l.id);await pool.query("INSERT INTO admin_actions(action,meter_number,detail,status,actor_id,actor_name,actor_role) VALUES('RENT_LEASE_CREATED',$1,$2,'DONE',$3,$4,$5)",[meter,JSON.stringify({leaseId:l.id,tenant,unit,amount,frequency:freq,accountRef:ref,propertyUnitId:unitId,meterLinked:!!meter,rentOnlyLoginCreated:!!temporaryCredentials}),adminActor(req).id,adminActor(req).displayName,adminActor(req).role]);res.json({ok:true,lease:l,previousLoginDisabled,temporaryCredentials});
 }));
 app.patch(admin+'/leases/:id',wrap(async(req,res)=>{
  const b=req.body||{},amount=Number(b.rentAmount),freq=String(b.billingFrequency||''),day=Number(b.dueDay||1),status=String(b.status||'active'),end=b.endDate?String(b.endDate).slice(0,10):null;
  const tenant=String(b.tenantName||'').trim(),unit=String(b.unitLabel||'').trim(),ref=String(b.rentAccountRef||'').trim().toUpperCase();
  const deposit=Number(b.securityDeposit??0),email=String(b.tenantEmail||'').trim().toLowerCase(),noticeDate=b.noticeDate?String(b.noticeDate):null;
  if(!tenant||tenant.length>100||!unit||unit.length>60||!validRentReference(ref)||!Number.isSafeInteger(deposit)||deposit<0||deposit>10000000||(email&&!/^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(email))||(noticeDate&&!validDate(noticeDate))||!Number.isSafeInteger(amount)||amount<1||!FREQUENCIES[freq]||day<1||day>28||!['active','ended','suspended'].includes(status)||(end&&!validDate(end)))return res.status(400).json({ok:false,message:'Enter valid tenant, room, rent account, rent amount, frequency, due day and tenancy status.'});
  if(status==='ended'&&!end)return res.status(400).json({ok:false,message:'Enter the actual tenancy end date before ending this tenancy.'});
  if(status==='ended'&&end>todayNairobi())return res.status(400).json({ok:false,message:'A tenancy with a future move-out date must remain active until that date.'});
  const client=await pool.connect();let loginDisabled=false;
  try{await client.query('BEGIN');
   const old=(await client.query('SELECT * FROM rent_leases WHERE id=$1 FOR UPDATE',[req.params.id])).rows[0];if(!old){await client.query('ROLLBACK');return res.status(404).json({ok:false,message:'Tenancy not found.'});}
   if(end&&end<dateOnly(old.start_date)){await client.query('ROLLBACK');return res.status(400).json({ok:false,message:'Tenancy end date cannot be before its start date.'});}
   if(status==='ended'||(end&&end<todayNairobi())){await client.query('ROLLBACK');return res.status(409).json({ok:false,message:'Use the final move-out settlement workflow to end a tenancy, calculate prorated rent and settle deposits/credits.'});}
   if((old.status==='ended'||(old.end_date&&old.end_date<todayNairobi()))&&(tenant!==old.tenant_name||unit!==old.unit_label||ref!==old.rent_account_ref)){await client.query('ROLLBACK');return res.status(409).json({ok:false,message:'This tenancy is closed. Its tenant and room history are locked; create a new tenancy for the incoming occupant.'});}
   await client.query('SELECT pg_advisory_xact_lock(hashtext($1))',['rent-ref:'+ref]);
   if(ref!==old.rent_account_ref&&(await client.query("SELECT 1 FROM rent_leases WHERE rent_account_ref=$1 AND id<>$2",[ref,old.id])).rowCount){await client.query('ROLLBACK');return res.status(409).json({ok:false,message:'That rent account reference is already assigned to another active tenancy.'});}
   if(status==='active'&&(await client.query("SELECT 1 FROM rent_leases WHERE meter_code=$1 AND status='active' AND (end_date IS NULL OR end_date>=$3::date) AND id<>$2",[old.meter_code,old.id,todayNairobi()])).rowCount){await client.query('ROLLBACK');return res.status(409).json({ok:false,message:'This room already has another active tenancy. End it before activating this tenancy.'});}
   const changed=old.billing_frequency!==freq;
   await client.query('UPDATE rent_leases SET tenant_name=$2,unit_label=$3,rent_account_ref=$4,rent_amount=$5,billing_frequency=$6,due_day=$7,status=$8,end_date=$9,security_deposit=$10,tenant_email=$11,notice_date=$12,updated_at=now() WHERE id=$1',[old.id,tenant,unit,ref,amount,freq,day,status,end,deposit,email||null,noticeDate]);
   if(status==='active')await client.query('UPDATE meters SET tenant_name=$2,flat=$3,rent_account_ref=$4,tenant_email=$5 WHERE meter_code=$1',[old.meter_code,tenant,unit,ref,email||null]);
   if(tenant.toLowerCase()!==String(old.tenant_name).toLowerCase()){
    const revoked=(await client.query('UPDATE users SET disabled=true WHERE meter_code=$1 RETURNING id',[old.meter_code])).rows;
    if(revoked.length){loginDisabled=true;await client.query('DELETE FROM sessions WHERE user_id=ANY($1::uuid[])',[revoked.map(x=>x.id)]);await client.query("INSERT INTO admin_actions(action,meter_number,detail,status) VALUES('RENT_TENANT_IDENTITY_CHANGED_LOGIN_DISABLED',$1,$2,'DONE')",[old.meter_code,JSON.stringify({leaseId:old.id,previousTenant:old.tenant_name,newTenant:tenant})]);}
   }
   if(changed){if((await client.query('SELECT 1 FROM rent_charges c JOIN rent_allocations a ON a.charge_id=c.id AND a.reversed_at IS NULL WHERE c.lease_id=$1 AND c.period_start >= $2 AND c.voided_at IS NULL LIMIT 1',[old.id,todayNairobi()])).rowCount){await client.query('ROLLBACK');return res.status(409).json({ok:false,message:'Future rent charges are already allocated. Schedule a future rent/billing change instead of rewriting prepayments.'});}await client.query("UPDATE rent_charges SET voided_at=now(),void_reason='Billing frequency changed; future schedule regenerated' WHERE lease_id=$1 AND voided_at IS NULL AND period_start >= $2",[old.id,todayNairobi()]);}
   else await client.query("UPDATE rent_charges c SET amount=$2,due_date=(date_trunc('month',c.period_start)::date + (LEAST($3,extract(day from (date_trunc('month',c.period_start)+interval '1 month - 1 day'))::int)-1)) WHERE c.lease_id=$1 AND c.period_start >= $4 AND NOT EXISTS(SELECT 1 FROM rent_allocations a WHERE a.charge_id=c.id AND a.reversed_at IS NULL)",[old.id,amount,day,todayNairobi()]);
   if(end){
    if((await client.query('SELECT 1 FROM rent_charges c JOIN rent_allocations a ON a.charge_id=c.id AND a.reversed_at IS NULL WHERE c.lease_id=$1 AND c.voided_at IS NULL AND c.period_start<=$2::date AND c.period_end>$2::date LIMIT 1',[old.id,end])).rowCount){await client.query('ROLLBACK');return res.status(409).json({ok:false,message:'The final billing period has allocated payments. Use the final settlement workflow to prorate rent and release any excess credit safely.'});}
    if((await client.query('SELECT 1 FROM rent_charges c JOIN rent_allocations a ON a.charge_id=c.id AND a.reversed_at IS NULL WHERE c.lease_id=$1 AND c.voided_at IS NULL AND c.period_start>$2::date LIMIT 1',[old.id,end])).rowCount){await client.query('ROLLBACK');return res.status(409).json({ok:false,message:'Prepaid future rent exists. Use the final settlement workflow so the advance can be released and reconciled.'});}
    await client.query("UPDATE rent_charges SET voided_at=now(),void_reason='Tenancy end date changed; future billing stopped' WHERE lease_id=$1 AND voided_at IS NULL AND period_start>$2::date",[old.id,end]);
    await client.query("UPDATE rent_charges c SET period_end=$2::date,amount=GREATEST(1,round(c.amount * (($2::date-c.period_start)+1)::numeric / NULLIF((c.period_end-c.period_start)+1,0))) WHERE c.lease_id=$1 AND c.voided_at IS NULL AND c.period_start<=$2::date AND c.period_end>$2::date",[old.id,end]);
   }
   if(status==='ended')await client.query("UPDATE rent_leases SET status='ended' WHERE id=$1",[old.id]);
   await client.query('COMMIT');
  }catch(e){await client.query('ROLLBACK').catch(()=>{});throw e;}finally{client.release();}
  if(status==='active')await generateCharges(pool,req.params.id);
  await pool.query("INSERT INTO admin_actions(action,detail,status,actor_id,actor_name,actor_role) VALUES('RENT_LEASE_UPDATED',$1,'DONE',$2,$3,$4)",[JSON.stringify({leaseId:req.params.id,tenant,unit,rentAccountRef:ref,rentAmount:amount,billingFrequency:freq,dueDay:day,status,endDate:end}),adminActor(req).id,adminActor(req).displayName,adminActor(req).role]);
  res.json({ok:true,loginDisabled});
 }));
 app.post(admin+'/leases/:id/generate',wrap(async(req,res)=>res.json({ok:true,created:await generateCharges(pool,req.params.id)})));
 app.get(admin+'/payments/unallocated',wrap(async(_req,res)=>res.json({ok:true,items:(await pool.query("SELECT * FROM rent_payments WHERE status IN ('unallocated','review') OR (lease_id IS NULL AND status='confirmed') ORDER BY created_at DESC LIMIT 200")).rows})));
 app.post(admin+'/payments/:id/reconcile',wrap(async(req,res)=>{
  const ref=String(req.body&&req.body.rentAccountRef||'').trim(),verificationNote=String(req.body&&req.body.verificationNote||'').trim(),l=(await pool.query("SELECT * FROM rent_leases WHERE rent_account_ref=$1 ORDER BY created_at DESC LIMIT 1",[ref,todayNairobi()])).rows[0];if(!l)return res.status(404).json({ok:false,message:'No active tenancy matches that rent account.'});
  if(verificationNote.length<5||verificationNote.length>500)return res.status(400).json({ok:false,message:'Add a verification note after checking the M-Pesa statement.'});
  const p=(await pool.query('SELECT * FROM rent_payments WHERE id=$1',[req.params.id])).rows[0];if(!p||p.status==='failed')return res.status(404).json({ok:false,message:'Payment not found or failed.'});if(p.lease_id&&p.lease_id!==l.id)return res.status(409).json({ok:false,message:'Payment belongs to another tenancy.'});
  await pool.query("UPDATE rent_payments SET lease_id=$2,rent_account_ref=$3,status='confirmed',verified_by=$5,verification_note=$4,updated_at=now() WHERE id=$1",[p.id,l.id,l.rent_account_ref,verificationNote,adminActor(req).id]);await generateCharges(pool,l.id);await allocateRentPayment(pool,p.id);await createReceipt(pool,p.id);
  if(p.mpesa_receipt)await pool.query("UPDATE rent_payment_reports SET status='resolved',staff_note='Matched to reconciled payment '||$2::text,updated_at=now() WHERE lease_id=$1 AND upper(transaction_code)=upper($2) AND status IN ('open','investigating')",[l.id,p.mpesa_receipt]);
  await pool.query("INSERT INTO admin_actions(action,meter_number,detail,status,actor_id,actor_name,actor_role) VALUES('RENT_PAYMENT_RECONCILED',$1,$2,'DONE',$3,$4,$5)",[l.meter_code,JSON.stringify({paymentId:p.id,amount:p.amount,accountRef:ref,verificationNote}),adminActor(req).id,adminActor(req).displayName,adminActor(req).role]);res.json({ok:true});
 }));
 
 app.get(admin+'/settings',wrap(async(_req,res)=>{const row=(await pool.query("SELECT allocation_rule,updated_at FROM rent_settings WHERE singleton=true")).rows[0]||{allocation_rule:'oldest_due_first'};res.json({ok:true,settings:row});}));
 app.patch(admin+'/settings',wrap(async(req,res)=>{const rule=String(req.body&&req.body.allocationRule||'');if(!['oldest_due_first','oldest_period_first','newest_due_first'].includes(rule))return res.status(400).json({ok:false,message:'Choose a supported payment allocation rule.'});const row=(await pool.query("INSERT INTO rent_settings(singleton,allocation_rule,updated_by,updated_at) VALUES(true,$1,$2,now()) ON CONFLICT(singleton) DO UPDATE SET allocation_rule=EXCLUDED.allocation_rule,updated_by=EXCLUDED.updated_by,updated_at=now() RETURNING allocation_rule,updated_at",[rule,adminActor(req).id])).rows[0];await pool.query("INSERT INTO admin_actions(action,detail,status,actor_id,actor_name,actor_role) VALUES('RENT_ALLOCATION_RULE_CHANGED',$1,'DONE',$2,$3,$4)",[JSON.stringify(row),adminActor(req).id,adminActor(req).displayName,adminActor(req).role]);res.json({ok:true,settings:row});}));
 app.post(admin+'/payments/manual',wrap(async(req,res)=>{
  const b=req.body||{},leaseId=String(b.leaseId||''),amount=Number(b.amount),reference=String(b.reference||'').trim(),note=String(b.note||'').trim(),paperReceipt=String(b.paperReceiptNumber||'').trim(),date=b.paymentDate?String(b.paymentDate):todayNairobi();
  if(!leaseId||!Number.isSafeInteger(amount)||amount<1||amount>10000000||reference.length<3||reference.length>100||!note||note.length>500||paperReceipt.length>80||!validDate(date)||date>todayNairobi())return res.status(400).json({ok:false,message:'Enter a valid tenancy, amount, payment reference, payment date and verification note. Payment date cannot be in the future.'});
  const l=(await pool.query('SELECT * FROM rent_leases WHERE id=$1',[leaseId])).rows[0];if(!l)return res.status(404).json({ok:false,message:'Tenancy not found.'});
  let payment;
  const prior=(await pool.query('SELECT id,lease_id,amount FROM rent_payments WHERE external_reference=$1 OR mpesa_receipt=$1 LIMIT 1',[reference])).rows[0];
  if(prior){if(prior.lease_id===l.id&&Number(prior.amount)===amount)payment=prior;else return res.status(409).json({ok:false,message:'That transaction reference has already been recorded against another payment.'});}
  else try{payment=(await pool.query("INSERT INTO rent_payments(lease_id,rent_account_ref,amount,method,status,transaction_time,external_reference,verified_by,verification_note,notes,raw_payload,paper_receipt_number) VALUES($1,$2,$3,'manual','confirmed',$4::date,$5,$7,$6,$6,jsonb_build_object('source','admin_manual_entry'),$8) RETURNING id",[l.id,l.rent_account_ref,amount,date,reference,note,adminActor(req).id,paperReceipt||null])).rows[0];}
  catch(e){if(e.code==='23505'){const duplicate=(await pool.query('SELECT id,lease_id,amount FROM rent_payments WHERE external_reference=$1 OR mpesa_receipt=$1 LIMIT 1',[reference])).rows[0];if(duplicate&&duplicate.lease_id===l.id&&Number(duplicate.amount)===amount)payment=duplicate;else return res.status(409).json({ok:false,message:'That transaction reference has already been recorded against another payment.'});}else throw e;}
  await generateCharges(pool,l.id);await allocateRentPayment(pool,payment.id);await createReceipt(pool,payment.id);
  await pool.query("UPDATE rent_payment_reports SET status='resolved',staff_note='Matched to verified manual payment '||$2::text,updated_at=now() WHERE lease_id=$1 AND upper(transaction_code)=upper($2) AND status IN ('open','investigating')",[l.id,reference]);
  await pool.query("INSERT INTO admin_actions(action,meter_number,detail,status,actor_id,actor_name,actor_role) VALUES('RENT_MANUAL_PAYMENT_RECORDED',$1,$2,'DONE',$3,$4,$5)",[l.meter_code,JSON.stringify({paymentId:payment.id,leaseId:l.id,amount,reference,note,date,paperReceipt}),adminActor(req).id,adminActor(req).displayName,adminActor(req).role]);
  res.json({ok:true,paymentId:payment.id});
 }));
 app.post('/api/me/rent/missing-payment',...customer,wrap(async(req,res)=>{
  const b=req.body||{},code=String(b.transactionCode||'').trim().toUpperCase(),amount=b.amount==null||b.amount===''?null:Number(b.amount),description=String(b.description||'').trim();
  if(!/^[A-Z0-9]{6,24}$/.test(code)||(amount!==null&&(!Number.isSafeInteger(amount)||amount<1||amount>10000000))||description.length>500)return res.status(400).json({ok:false,message:'Enter a valid M-Pesa transaction code and optional amount or description.'});
  const l=await customerLease(pool,req.user);if(!l)return res.status(404).json({ok:false,message:'No active rent account is linked to this login.'});
  try{const report=(await pool.query('INSERT INTO rent_payment_reports(lease_id,transaction_code,amount,description) VALUES($1,$2,$3,$4) RETURNING id,created_at,status',[l.id,code,amount,description||null])).rows[0];res.status(201).json({ok:true,report});}
  catch(e){if(e.code==='23505')return res.status(409).json({ok:false,message:'This transaction code has already been reported for your tenancy.'});throw e;}
 }));
 app.get(admin+'/payments/reports',wrap(async(_req,res)=>{const items=(await pool.query("SELECT r.*,l.tenant_name,l.unit_label,l.rent_account_ref FROM rent_payment_reports r JOIN rent_leases l ON l.id=r.lease_id ORDER BY CASE r.status WHEN 'open' THEN 0 WHEN 'investigating' THEN 1 ELSE 2 END,r.created_at DESC LIMIT 300")).rows;res.json({ok:true,items});}));
 app.patch(admin+'/payments/reports/:id',wrap(async(req,res)=>{const status=String(req.body&&req.body.status||''),note=String(req.body&&req.body.staffNote||'').trim();if(!['investigating','resolved','rejected'].includes(status)||!note||note.length>500)return res.status(400).json({ok:false,message:'Choose a valid case status and add a staff note.'});const row=(await pool.query('UPDATE rent_payment_reports SET status=$2,staff_note=$3,updated_at=now() WHERE id=$1 RETURNING id,lease_id,status,staff_note',[req.params.id,status,note])).rows[0];if(!row)return res.status(404).json({ok:false,message:'Payment report not found.'});await pool.query("INSERT INTO admin_actions(action,detail,status) VALUES('RENT_MISSING_PAYMENT_REVIEWED',$1,'DONE')",[JSON.stringify(row)]);res.json({ok:true,report:row});}));

 const csvCell=v=>'"'+String(v??'').replace(/"/g,'""')+'"';
 const sendCsv=(res,name,rows)=>{const body=rows.map(row=>row.map(csvCell).join(',')).join('\r\n');res.setHeader('Content-Type','text/csv; charset=utf-8');res.setHeader('Content-Disposition','attachment; filename="'+name+'"');res.send('\uFEFF'+body);};
 app.get(admin+'/reports',wrap(async(req,res)=>{
  const from=/^\d{4}-\d{2}-\d{2}$/.test(String(req.query.from||''))?String(req.query.from):(todayNairobi().slice(0,8)+'01');
  const to=/^\d{4}-\d{2}-\d{2}$/.test(String(req.query.to||''))?String(req.query.to):todayNairobi();
  if(from>to)return res.status(400).json({ok:false,message:'Start date must be before end date.'});
  const summary=(await pool.query(`
   WITH period_charges AS (
    SELECT c.id,c.lease_id,c.amount,c.due_date, c.amount-COALESCE(sum(a.amount),0)::int balance
    FROM rent_charges c LEFT JOIN rent_allocations a ON a.charge_id=c.id AND a.reversed_at IS NULL
    WHERE c.voided_at IS NULL AND c.period_start BETWEEN $1::date AND $2::date GROUP BY c.id
   ), period_payments AS (
    SELECT p.id,p.lease_id,p.amount,p.status,COALESCE(p.transaction_time,p.created_at) paid_at
    FROM rent_payments p WHERE p.status IN ('confirmed','allocated') AND p.method<>'credit_adjustment' AND COALESCE(p.transaction_time,p.created_at)::date BETWEEN $1::date AND $2::date
   )
   SELECT
    COALESCE((SELECT sum(amount) FROM period_charges),0)::bigint expected,
    COALESCE((SELECT sum(amount) FROM period_payments),0)::bigint collected,
    COALESCE((SELECT sum(balance) FROM period_charges),0)::bigint outstanding,
    COALESCE((SELECT sum(balance) FROM period_charges WHERE due_date<$3::date AND balance>0),0)::bigint overdue,
    (SELECT count(*) FROM period_charges WHERE balance>0)::int accounts_with_balance,
    (SELECT count(*) FROM rent_leases WHERE status='active' AND start_date<=$3::date AND (end_date IS NULL OR end_date>=$3::date))::int occupied,
    (SELECT count(*) FROM meters)::int units,
    (SELECT count(*) FROM meters m WHERE NOT EXISTS(SELECT 1 FROM rent_leases l WHERE l.meter_code=m.meter_code AND l.status='active' AND l.start_date<=$3::date AND (l.end_date IS NULL OR l.end_date>=$3::date)))::int vacant,
    (SELECT count(*) FROM rent_payments p WHERE (p.status IN ('unallocated','review') OR p.lease_id IS NULL) AND COALESCE(p.transaction_time,p.created_at)::date BETWEEN $1::date AND $2::date)::int unmatched_payments,
    (SELECT count(*) FROM (SELECT p.id FROM rent_payments p JOIN rent_allocations a ON a.payment_id=p.id AND a.reversed_at IS NULL WHERE COALESCE(p.transaction_time,p.created_at)::date BETWEEN $1::date AND $2::date GROUP BY p.id,p.amount HAVING sum(a.amount)>0 AND sum(a.amount)<p.amount) partials)::int partial_payments,
    (COALESCE((SELECT sum(p.amount-COALESCE((SELECT sum(a.amount) FROM rent_allocations a WHERE a.payment_id=p.id AND a.reversed_at IS NULL),0)) FROM rent_payments p WHERE p.status IN ('confirmed','allocated') AND p.lease_id IS NOT NULL),0)-COALESCE((SELECT sum(amount) FROM rent_credit_refunds WHERE status IN ('approved','paid')),0)-COALESCE((SELECT sum(amount) FROM rent_credit_transfers WHERE status='posted'),0))::bigint excess_credit
  `,[from,to,todayNairobi()])).rows[0];
  const months=(await pool.query(`
   SELECT to_char(date_trunc('month',d)::date,'YYYY-MM') AS month_label,
    COALESCE((SELECT sum(c.amount) FROM rent_charges c WHERE c.voided_at IS NULL AND c.period_start>=date_trunc('month',d)::date AND c.period_start<(date_trunc('month',d)+interval '1 month')::date),0)::bigint expected,
    COALESCE((SELECT sum(p.amount) FROM rent_payments p WHERE p.status IN ('confirmed','allocated') AND p.method<>'credit_adjustment' AND COALESCE(p.transaction_time,p.created_at)>=date_trunc('month',d) AND COALESCE(p.transaction_time,p.created_at)<date_trunc('month',d)+interval '1 month'),0)::bigint collected
   FROM generate_series(date_trunc('month',$1::date),date_trunc('month',$2::date),interval '1 month') d ORDER BY d
  `,[from,to])).rows;
  const reconciliations=(await pool.query(`SELECT p.id,p.created_at,p.rent_account_ref,p.amount,p.status,p.method,p.mpesa_receipt,l.tenant_name,l.unit_label,COALESCE(sum(a.amount),0)::int allocated,(max(p.amount)-COALESCE(sum(a.amount),0))::int unallocated FROM rent_payments p LEFT JOIN rent_leases l ON l.id=p.lease_id LEFT JOIN rent_allocations a ON a.payment_id=p.id AND a.reversed_at IS NULL WHERE COALESCE(p.transaction_time,p.created_at)::date BETWEEN $1::date AND $2::date AND p.status NOT IN ('failed','pending','reversed') GROUP BY p.id,l.id ORDER BY p.created_at DESC LIMIT 250`,[from,to])).rows;
  const arrears=(await pool.query(`
   SELECT l.id,l.tenant_name,l.unit_label,l.rent_account_ref,l.rent_amount,
    sum(c.amount)::bigint charged,COALESCE(sum(x.paid),0)::bigint paid,
    sum(c.amount-COALESCE(x.paid,0))::bigint balance,min(c.due_date) oldest_due
   FROM rent_leases l JOIN rent_charges c ON c.lease_id=l.id
   LEFT JOIN (SELECT charge_id,sum(amount) paid FROM rent_allocations WHERE reversed_at IS NULL GROUP BY charge_id) x ON x.charge_id=c.id
   WHERE c.voided_at IS NULL AND c.due_date<$1::date AND c.amount>COALESCE(x.paid,0)
   GROUP BY l.id HAVING sum(c.amount-COALESCE(x.paid,0))>0 ORDER BY balance DESC
  `,[todayNairobi()])).rows;
  res.json({ok:true,from,to,summary:{...summary,collectionRate:Number(summary.expected)>0?Math.round(Number(summary.collected)/Number(summary.expected)*10000)/100:0},months,arrears,reconciliations});
 }));
 app.get(admin+'/reports/export',wrap(async(req,res)=>{
  const type=String(req.query.type||'collections'),from=String(req.query.from||'2000-01-01'),to=String(req.query.to||todayNairobi());
  if(!/^\d{4}-\d{2}-\d{2}$/.test(from)||!/^\d{4}-\d{2}-\d{2}$/.test(to)||from>to)return res.status(400).send('Invalid date range');
  if(type==='arrears'){
   const rows=(await pool.query(`SELECT l.tenant_name,l.unit_label,l.rent_account_ref,c.period_start,c.due_date,c.amount,COALESCE(sum(a.amount),0)::int paid,(c.amount-COALESCE(sum(a.amount),0))::int balance FROM rent_charges c JOIN rent_leases l ON l.id=c.lease_id LEFT JOIN rent_allocations a ON a.charge_id=c.id AND a.reversed_at IS NULL WHERE c.voided_at IS NULL AND c.due_date<$3::date AND c.due_date BETWEEN $1::date AND $2::date GROUP BY c.id,l.id HAVING c.amount>COALESCE(sum(a.amount),0) ORDER BY c.due_date,l.unit_label`,[from,to,todayNairobi()])).rows;
   return sendCsv(res,'mauriskade-arrears-'+from+'-'+to+'.csv',[['Tenant','Unit','Rent account','Period start','Due date','Charged KSh','Paid KSh','Balance KSh'],...rows.map(x=>[x.tenant_name,x.unit_label,x.rent_account_ref,x.period_start,x.due_date,x.amount,x.paid,x.balance])]);
  }
  if(type==='statements'){
   const leaseId=String(req.query.leaseId||'');if(!leaseId)return res.status(400).send('Select a tenancy for its statement');
   const l=(await pool.query('SELECT * FROM rent_leases WHERE id=$1',[leaseId])).rows[0];if(!l)return res.status(404).send('Tenancy not found');
   const opening=(await pool.query(`SELECT COALESCE((SELECT sum(amount) FROM rent_charges WHERE lease_id=$1 AND voided_at IS NULL AND period_start<$2::date),0)-COALESCE((SELECT sum(amount) FROM rent_payments WHERE lease_id=$1 AND status IN ('confirmed','allocated') AND COALESCE(transaction_time,created_at)::date<$2::date),0)+COALESCE((SELECT sum(amount) FROM rent_credit_refunds WHERE lease_id=$1 AND status IN ('approved','paid') AND created_at::date<$2::date),0)+COALESCE((SELECT sum(amount) FROM rent_credit_transfers WHERE from_lease_id=$1 AND status='posted' AND created_at::date<$2::date),0)-COALESCE((SELECT sum(amount) FROM rent_payments WHERE lease_id=$1 AND status='reversed' AND COALESCE(transaction_time,created_at)::date<$2::date),0) balance`,[leaseId,from])).rows[0].balance;
   const charges=(await pool.query(`SELECT c.period_start::text date,'Rent charge' kind,c.amount::bigint amount,COALESCE(sum(a.amount),0)::bigint allocated,'—'::text mpesa_receipt FROM rent_charges c LEFT JOIN rent_allocations a ON a.charge_id=c.id AND a.reversed_at IS NULL WHERE c.lease_id=$1 AND c.voided_at IS NULL AND c.period_start BETWEEN $2::date AND $3::date GROUP BY c.id ORDER BY c.period_start`,[leaseId,from,to])).rows;
   const payments=(await pool.query(`SELECT COALESCE(p.transaction_time,p.created_at)::date::text date,CASE WHEN p.method='credit_adjustment' THEN 'Approved ledger credit' ELSE 'Payment '+p.method END kind,p.amount::bigint amount,COALESCE(sum(a.amount),0)::bigint allocated,max(p.mpesa_receipt) mpesa_receipt FROM rent_payments p LEFT JOIN rent_allocations a ON a.payment_id=p.id AND a.reversed_at IS NULL WHERE p.lease_id=$1 AND p.status IN ('confirmed','allocated') AND COALESCE(p.transaction_time,p.created_at)::date BETWEEN $2::date AND $3::date GROUP BY p.id ORDER BY date`,[leaseId,from,to])).rows;
   const entries=[...charges.map(x=>[x.date,x.kind,Number(x.amount),x.allocated,x.mpesa_receipt]),...payments.map(x=>[x.date,x.kind,-Number(x.amount),x.allocated,x.mpesa_receipt||'—'])].sort((a,b)=>String(a[0]).localeCompare(String(b[0])));
   let balance=Number(opening)||0;const ledger=entries.map(x=>{balance+=Number(x[2]);return [...x,balance];});
   return sendCsv(res,'statement-'+l.rent_account_ref+'-'+from+'-'+to+'.csv',[['Tenant',l.tenant_name],['Unit',l.unit_label],['Rent account',l.rent_account_ref],['Opening balance KSh',opening],[],['Date','Description','Debit/Credit KSh','Allocated KSh','M-Pesa receipt','Running balance KSh'],...ledger,['','','','','Closing balance KSh',balance]]);
  }
  const rows=(await pool.query(`SELECT p.created_at::date date,l.tenant_name,l.unit_label,p.rent_account_ref,p.amount,p.method,p.status,p.mpesa_receipt,r.receipt_number FROM rent_payments p LEFT JOIN rent_leases l ON l.id=p.lease_id LEFT JOIN rent_receipts r ON r.payment_id=p.id WHERE p.status IN ('confirmed','allocated') AND p.method<>'credit_adjustment' AND COALESCE(p.transaction_time,p.created_at)::date BETWEEN $1::date AND $2::date ORDER BY p.created_at`,[from,to])).rows;
  return sendCsv(res,'mauriskade-collections-'+from+'-'+to+'.csv',[['Date','Tenant','Unit','Rent account','Amount KSh','Method','Status','M-Pesa receipt','Receipt number'],...rows.map(x=>[x.date,x.tenant_name,x.unit_label,x.rent_account_ref,x.amount,x.method,x.status,x.mpesa_receipt,x.receipt_number])]);
 }));

 app.post(admin+'/c2b/register',wrap(async(_req,res)=>res.status(409).json({ok:false,message:'This shortcode uses the shared Webazi C2B gateway. Registering Mauriskade-specific URLs here would overwrite the shared callbacks. Manage registration from the Webazi Daraja service only.'})));
 const agreementMeta = "id,lease_id,version,title,status,issued_at,created_at,CASE WHEN body LIKE 'MAURISKADE_AGREEMENT_FILE_V1%' THEN split_part(body,'|',2) ELSE NULL END AS file_mime,CASE WHEN body LIKE 'MAURISKADE_AGREEMENT_FILE_V1%' THEN split_part(body,'|',3) ELSE NULL END AS file_name,CASE WHEN body LIKE 'MAURISKADE_AGREEMENT_FILE_V1%' THEN length(split_part(body,'|',4))*3/4 ELSE 0 END AS file_size";
 const agreementFile = async (id) => {
  const row=(await pool.query('SELECT id,lease_id,title,body,version,status FROM tenancy_agreements WHERE id=$1',[id])).rows[0];
  if(!row||!row.body.startsWith('MAURISKADE_AGREEMENT_FILE_V1|'))return null;
  const parts=row.body.split('|');if(parts.length!==4)return null;
  return {row,mime:parts[1],name:parts[2],buffer:Buffer.from(parts[3],'base64')};
 };
 const sendAgreementFile = (res,file) => {res.setHeader('Content-Type',file.mime);res.setHeader('Content-Length',file.buffer.length);res.setHeader('Content-Disposition','inline; filename="tenancy-agreement"');res.setHeader('X-Content-Type-Options','nosniff');res.setHeader('Cache-Control','private, no-store');res.send(file.buffer);};
 app.get(admin+'/agreements/:leaseId',wrap(async(req,res)=>{
  const l=(await pool.query('SELECT * FROM rent_leases WHERE id=$1',[req.params.leaseId])).rows[0];if(!l)return res.status(404).json({ok:false,message:'Tenancy not found.'});
  const agreements=(await pool.query('SELECT '+agreementMeta+' FROM tenancy_agreements WHERE lease_id=$1 ORDER BY version DESC',[l.id])).rows;res.json({ok:true,lease:l,agreements});
 }));
 app.post(admin+'/agreements/:leaseId',wrap(async(req,res)=>{
  const l=(await pool.query('SELECT * FROM rent_leases WHERE id=$1',[req.params.leaseId])).rows[0];if(!l)return res.status(404).json({ok:false,message:'Tenancy not found.'});
  const title=String(req.body&&req.body.title||'Tenancy Agreement').trim().slice(0,120),mime=String(req.body&&req.body.mime||'').toLowerCase(),name=String(req.body&&req.body.name||'').replace(/[\\r\\n"|\\\\]/g,'_').slice(0,180),encoded=String(req.body&&req.body.data||'').replace(/^data:[^,]+;base64,/,'');
  if(!['application/pdf','image/jpeg','image/png','image/webp'].includes(mime))return res.status(400).json({ok:false,message:'Upload a PDF, JPG, PNG or WebP file.'});
  if(!name||!encoded||encoded.length>Math.ceil(5*1024*1024*4/3)+8||!/^[A-Za-z0-9+/]+={0,2}$/.test(encoded))return res.status(400).json({ok:false,message:'Choose a valid agreement file up to 5 MB.'});
  const bytes=Buffer.from(encoded,'base64');if(!bytes.length||bytes.length>5*1024*1024)return res.status(400).json({ok:false,message:'Agreement file must be 5 MB or smaller.'});
  const isPdf=bytes.subarray(0,5).toString()==='%PDF-',isJpg=bytes[0]===0xff&&bytes[1]===0xd8&&bytes[2]===0xff,isPng=bytes.subarray(0,8).equals(Buffer.from([137,80,78,71,13,10,26,10])),isWebp=bytes.subarray(0,4).toString()==='RIFF'&&bytes.subarray(8,12).toString()==='WEBP';
  if(!((mime==='application/pdf'&&isPdf)||(mime==='image/jpeg'&&isJpg)||(mime==='image/png'&&isPng)||(mime==='image/webp'&&isWebp)))return res.status(400).json({ok:false,message:'The selected file does not match its actual file type.'});
  const v=Number((await pool.query('SELECT COALESCE(max(version),0)+1 n FROM tenancy_agreements WHERE lease_id=$1',[l.id])).rows[0].n),stored='MAURISKADE_AGREEMENT_FILE_V1|'+mime+'|'+name+'|'+bytes.toString('base64');
  const saved=(await pool.query("INSERT INTO tenancy_agreements(lease_id,version,title,body,status) VALUES($1,$2,$3,$4,'draft') RETURNING id,lease_id,version,title,status,created_at",[l.id,v,title,stored])).rows[0];
  await pool.query("INSERT INTO admin_actions(action,meter_number,detail,status) VALUES('TENANCY_AGREEMENT_UPLOADED',$1,$2,'DONE')",[l.meter_code,JSON.stringify({agreementId:saved.id,leaseId:l.id,version:v,fileName:name,mime,size:bytes.length})]);
  res.json({ok:true,agreement:{...saved,file_name:name,file_mime:mime,file_size:bytes.length}});
 }));
 app.get(admin+'/agreements/:id/file',wrap(async(req,res)=>{const file=await agreementFile(req.params.id);if(!file)return res.status(404).json({ok:false,message:'Uploaded agreement file not found.'});sendAgreementFile(res,file);}));
 app.post(admin+'/agreements/:id/issue',wrap(async(req,res)=>{
  const file=await agreementFile(req.params.id);if(!file)return res.status(409).json({ok:false,message:'Upload a valid agreement file before issuing it.'});
  const a=(await pool.query("UPDATE tenancy_agreements SET status='issued',issued_at=now() WHERE id=$1 AND status='draft' RETURNING id,lease_id,version,title,status,issued_at",[req.params.id])).rows[0];if(!a)return res.status(404).json({ok:false,message:'Draft agreement not found.'});
  await pool.query("UPDATE tenancy_agreements SET status='superseded' WHERE lease_id=$1 AND id<>$2 AND status='issued'",[a.lease_id,a.id]);
  await pool.query("INSERT INTO admin_actions(action,detail,status) VALUES('TENANCY_AGREEMENT_ISSUED',$1,'DONE')",[JSON.stringify({agreementId:a.id,leaseId:a.lease_id,version:a.version})]);res.json({ok:true,agreement:a});
 }));
 app.get('/api/me/rent/agreement/file',...customer,wrap(async(req,res)=>{
  const lease=await customerLease(pool,req.user);if(!lease)return res.status(404).json({ok:false,message:'No active tenancy found.'});
  const row=(await pool.query("SELECT id FROM tenancy_agreements WHERE lease_id=$1 AND status='issued' ORDER BY version DESC LIMIT 1",[lease.id])).rows[0];if(!row)return res.status(404).json({ok:false,message:'No issued tenancy agreement is available.'});
  const file=await agreementFile(row.id);if(!file)return res.status(404).json({ok:false,message:'No uploaded agreement file is available.'});sendAgreementFile(res,file);
 }));
 app.post('/api/mpesa/rent-c2b/:secret/validation',(req,res)=>{if(String(req.params.secret)!==String(callbackSecret))return res.sendStatus(403);res.json({ResultCode:0,ResultDesc:'Accepted'});});
 app.post('/api/mpesa/rent-c2b/:secret/confirmation',wrap(async(req,res)=>{
  if(String(req.params.secret)!==String(callbackSecret))return res.sendStatus(403);const b=req.body||{},receipt=String(b.TransID||'').trim(),ref=String(b.BillRefNumber||'').trim(),amount=Number(b.TransAmount);if(!receipt||!ref||!Number.isSafeInteger(amount)||amount<1)return res.json({ResultCode:0,ResultDesc:'Accepted'});
  const l=(await pool.query("SELECT * FROM rent_leases WHERE rent_account_ref=$1 AND status='active' AND start_date<=$2::date AND (end_date IS NULL OR end_date>=$2::date) ORDER BY start_date DESC,created_at DESC LIMIT 1",[ref,todayNairobi()])).rows[0],t=String(b.TransTime||''),time=/^\d{14}$/.test(t)?new Date(Date.UTC(+t.slice(0,4),+t.slice(4,6)-1,+t.slice(6,8),+t.slice(8,10)-3,+t.slice(10,12),+t.slice(12,14))).toISOString():null;
  const collision=(await pool.query('SELECT id,mpesa_receipt,external_reference FROM rent_payments WHERE mpesa_receipt=$1 OR external_reference=$1 LIMIT 1',[receipt])).rows[0];
  if(collision&&collision.mpesa_receipt!==receipt){await pool.query("INSERT INTO admin_actions(action,detail,status) VALUES('RENT_TRANSACTION_REFERENCE_COLLISION',$1,'NEEDS_REVIEW')",[JSON.stringify({receipt,amount,accountRef:ref,existingPaymentId:collision.id,existingExternalReference:collision.external_reference})]);return res.json({ResultCode:0,ResultDesc:'Accepted for review'});}
  const p=(await pool.query("INSERT INTO rent_payments(lease_id,rent_account_ref,payer_phone,amount,method,status,mpesa_receipt,transaction_time,raw_payload) VALUES($1,$2,$3,$4,'mpesa_paybill',$5,$6,$7,$8) ON CONFLICT(mpesa_receipt) DO NOTHING RETURNING id",[l?l.id:null,ref,b.MSISDN?String(b.MSISDN):null,amount,l?'confirmed':'unallocated',receipt,time,JSON.stringify(b)])).rows[0];
  if(p){if(l){await generateCharges(pool,l.id);await allocateRentPayment(pool,p.id);await createReceipt(pool,p.id);await pool.query("UPDATE rent_payment_reports SET status='resolved',staff_note='Matched automatically to confirmed Paybill transaction '||$2::text,updated_at=now() WHERE lease_id=$1 AND upper(transaction_code)=upper($2) AND status IN ('open','investigating')",[l.id,receipt]);}await pool.query("INSERT INTO admin_actions(action,meter_number,detail,status) VALUES('RENT_C2B_RECEIVED',$1,$2,'DONE')",[l?l.meter_code:null,JSON.stringify({receipt,amount,accountRef:ref,matched:!!l})]);}
  res.json({ResultCode:0,ResultDesc:'Accepted'});
 }));
}

async function processRentC2B(pool,b){
 const receipt=String(b.TransID||'').trim(),ref=String(b.BillRefNumber||'').trim(),amount=Number(b.TransAmount);
 if(!receipt||!/^RENT-/i.test(ref)||!Number.isSafeInteger(amount)||amount<1)throw new Error('Invalid Mauriskade rent C2B payload');
 const l=(await pool.query("SELECT * FROM rent_leases WHERE rent_account_ref=$1 AND status='active' AND start_date<=$2::date AND (end_date IS NULL OR end_date>=$2::date) ORDER BY start_date DESC,created_at DESC LIMIT 1",[ref,todayNairobi()])).rows[0];
 const t=String(b.TransTime||''),time=/^\d{14}$/.test(t)?new Date(Date.UTC(+t.slice(0,4),+t.slice(4,6)-1,+t.slice(6,8),+t.slice(8,10)-3,+t.slice(10,12),+t.slice(12,14))).toISOString():null;
 const collision=(await pool.query('SELECT id,mpesa_receipt,external_reference FROM rent_payments WHERE mpesa_receipt=$1 OR external_reference=$1 LIMIT 1',[receipt])).rows[0];
 if(collision&&collision.mpesa_receipt!==receipt){await pool.query("INSERT INTO admin_actions(action,detail,status) VALUES('RENT_TRANSACTION_REFERENCE_COLLISION',$1,'NEEDS_REVIEW')",[JSON.stringify({receipt,amount,accountRef:ref,existingPaymentId:collision.id,existingExternalReference:collision.external_reference})]);return {duplicate:true,matched:false,referenceCollision:true};}
 const p=(await pool.query("INSERT INTO rent_payments(lease_id,rent_account_ref,payer_phone,amount,method,status,mpesa_receipt,transaction_time,raw_payload) VALUES($1,$2,$3,$4,'mpesa_paybill',$5,$6,$7,$8) ON CONFLICT(mpesa_receipt) DO NOTHING RETURNING id",[l?l.id:null,ref,b.MSISDN?String(b.MSISDN):null,amount,l?'confirmed':'unallocated',receipt,time,JSON.stringify(b)])).rows[0];
 if(p){if(l){await generateCharges(pool,l.id);await allocateRentPayment(pool,p.id);await createReceipt(pool,p.id);await pool.query("UPDATE rent_payment_reports SET status='resolved',staff_note='Matched automatically to confirmed Paybill transaction '||$2::text,updated_at=now() WHERE lease_id=$1 AND upper(transaction_code)=upper($2) AND status IN ('open','investigating')",[l.id,receipt]);}await pool.query("INSERT INTO admin_actions(action,meter_number,detail,status) VALUES('RENT_C2B_RECEIVED',$1,$2,'DONE')",[l?l.meter_code:null,JSON.stringify({receipt,amount,accountRef:ref,matched:!!l})]);}
 return {duplicate:!p,matched:!!l};
}

module.exports={registerRentRoutes,processRentStkCallback,processRentC2B,generateCharges,allocateRentPayment,createReceipt,makeReceiptPdf,validDate,validRentReference,addMonths,dueDate};
