const VERSION='PAYMENT-CORE-ROBUST-END2END-20261005-4';
const EVENT_NAME='Kailash Yatra Payment Core';
const LIVE='LIVE';
const MANUAL='MANUAL';
const cors=o=>({'Access-Control-Allow-Origin':o||'*','Access-Control-Allow-Methods':'GET,POST,OPTIONS','Access-Control-Allow-Headers':'Content-Type,Authorization,X-Razorpay-Signature,X-Razorpay-Event-Id','Access-Control-Expose-Headers':'Content-Type','Access-Control-Max-Age':'86400'});
const json=(d,s=200,o='')=>new Response(JSON.stringify(d),{status:s,headers:{'Content-Type':'application/json; charset=UTF-8','Cache-Control':'no-store',...cors(o)}});
const clean=v=>typeof v==='string'?v.trim():'';
const money=v=>Math.round(Number(v||0)*100)/100;
let liveSchemaPromise=null,manualSchemaPromise=null;
function b64(buf){let s='';for(const b of new Uint8Array(buf))s+=String.fromCharCode(b);return btoa(s)}
async function hmac(secret,data){const k=await crypto.subtle.importKey('raw',new TextEncoder().encode(secret),{name:'HMAC',hash:'SHA-256'},false,['sign']);return b64(await crypto.subtle.sign('HMAC',k,new TextEncoder().encode(data)))}
async function validHmac(secret,data,sig){if(!secret||!sig)return false;const a=await hmac(secret,data),x=atob(a),y=atob(sig);if(x.length!==y.length)return false;let d=0;for(let i=0;i<x.length;i++)d|=x.charCodeAt(i)^y.charCodeAt(i);return d===0}
function auth(req,env){const a=req.headers.get('Authorization')||'',token=a.startsWith('Bearer ')?a.slice(7).trim():'';const expected=clean(env.PAYMENT_ADMIN_ACCESS_CODE)||clean(env.ADMIN_ACCESS_CODE);return !!expected&&!!token&&token===expected}
async function ensureTargetSchema(db,which){
  const slot=which===LIVE?'live':'manual';
  if(slot==='live'&&liveSchemaPromise)return liveSchemaPromise;
  if(slot==='manual'&&manualSchemaPromise)return manualSchemaPromise;
  const p=(async()=>{
    await db.prepare(`CREATE TABLE IF NOT EXISTS payment_links (id INTEGER PRIMARY KEY AUTOINCREMENT, registration_id INTEGER NOT NULL, source TEXT NOT NULL, razorpay_payment_link_id TEXT NOT NULL UNIQUE, reference_id TEXT NOT NULL UNIQUE, short_url TEXT NOT NULL, amount REAL NOT NULL, paid_amount REAL NOT NULL DEFAULT 0, status TEXT NOT NULL DEFAULT 'created', created_at TEXT NOT NULL DEFAULT CURRENT_TIMESTAMP, updated_at TEXT NOT NULL DEFAULT CURRENT_TIMESTAMP, expires_at TEXT, raw_response TEXT)`).run();
    await db.prepare(`CREATE INDEX IF NOT EXISTS idx_payment_links_registration ON payment_links(registration_id,id DESC)`).run();
    await db.prepare(`CREATE TABLE IF NOT EXISTS payment_transactions (id INTEGER PRIMARY KEY AUTOINCREMENT, registration_id INTEGER NOT NULL, source TEXT NOT NULL, provider_payment_id TEXT NOT NULL UNIQUE, provider_link_id TEXT, amount REAL NOT NULL, payment_method TEXT, payment_time TEXT, status TEXT NOT NULL, raw_response TEXT, created_at TEXT NOT NULL DEFAULT CURRENT_TIMESTAMP)`).run();
    await db.prepare(`CREATE INDEX IF NOT EXISTS idx_payment_transactions_registration ON payment_transactions(registration_id,id DESC)`).run();
    await db.prepare(`CREATE TABLE IF NOT EXISTS payment_history (id INTEGER PRIMARY KEY AUTOINCREMENT, registration_id INTEGER NOT NULL, event_type TEXT NOT NULL, source TEXT NOT NULL, amount_before REAL NOT NULL DEFAULT 0, amount_added REAL NOT NULL DEFAULT 0, amount_after REAL NOT NULL DEFAULT 0, payment_method TEXT, transaction_id TEXT, utr TEXT, note TEXT, payment_time TEXT, verified_at TEXT NOT NULL DEFAULT CURRENT_TIMESTAMP, metadata TEXT)`).run();
    await db.prepare(`CREATE INDEX IF NOT EXISTS idx_payment_history_registration ON payment_history(registration_id,id DESC)`).run();
  })();
  if(slot==='live')liveSchemaPromise=p.catch(e=>{liveSchemaPromise=null;throw e});
  else manualSchemaPromise=p.catch(e=>{manualSchemaPromise=null;throw e});
  return slot==='live'?liveSchemaPromise:manualSchemaPromise;
}
function dbFor(env,source){return source===LIVE?env.YATRA_DB:env.REGISTER_DB}
async function getRegistration(env,rid){
  const id=clean(rid).toUpperCase();
  if(!/^KEDAR-\d{3,}$/.test(id))throw Error('Enter a valid Registration ID.');

  // Do not hide database/binding/schema failures as "Registration ID not found".
  // Read registrations first and payment separately so a missing payment row
  // cannot make an otherwise valid registration disappear from the payment portal.
  async function readSource(db,source){
    if(!db)throw Error(`${source} payment database binding is missing.`);
    try{
      const registration=await db.prepare(`SELECT id,registration_id,room_type,traveller_count,price_per_person,total_amount,registration_amount,payment_mode,status FROM registrations WHERE registration_id=? LIMIT 1`).bind(id).first();
      if(!registration)return null;
      let payment=null;
      try{
        payment=await db.prepare(`SELECT paid_amount,status AS payment_status,payment_method,payment_time,razorpay_payment_id FROM payments WHERE registration_id=? LIMIT 1`).bind(registration.id).first();
      }catch(e){
        console.error(`${source} payment lookup failed for ${id}`,e);
        throw Error(`${source} payment database schema is unavailable.`);
      }
      return {registration,payment};
    }catch(e){
      if(e?.message===`${source} payment database schema is unavailable.`)throw e;
      console.error(`${source} registration lookup failed for ${id}`,e);
      throw Error(`${source} payment database is unavailable.`);
    }
  }

  const [liveResult,manualResult]=await Promise.all([
    readSource(env.YATRA_DB,LIVE),
    readSource(env.REGISTER_DB,MANUAL)
  ]);
  const live=liveResult?.registration||null,manual=manualResult?.registration||null;
  if(live&&manual)throw Error('This Registration ID exists in both systems. Payment routing is blocked for safety.');
  const source=live?LIVE:manual?MANUAL:null;
  if(!source)throw Error('Registration ID not found.');
  const db=dbFor(env,source),registration=live||manual;
  const payment=(liveResult?.payment||manualResult?.payment)||{};
  const traveller=await db.prepare(`SELECT full_name,mobile_number FROM travellers WHERE registration_id=? AND traveller_number=1 LIMIT 1`).bind(registration.id).first();
  const total=money(registration.total_amount),paid=money(payment.paid_amount||0),due=Math.max(0,total-paid);
  return {
    source,db,
    record:{...registration,...payment},
    traveller:traveller||{},
    total,paid,due,
    registrationAmount:money(registration.registration_amount||0),
    paymentMode:clean(registration.payment_mode)||'FULL_PAYMENT'
  };
}
function publicView(x){
  const r=x.record,t=x.traveller||{};
  return {registrationId:r.registration_id,source:x.source,primaryTravellerName:t.full_name||'',mobileLast4:String(t.mobile_number||'').replace(/\D/g,'').slice(-4)||'',roomType:r.room_type,travellerCount:r.traveller_count,totalAmount:x.total,paidAmount:x.paid,balanceAmount:x.due,paymentStatus:x.paid>=x.total&&x.total>0?'PAID':x.paid>0?'PARTIALLY_PAID':'PENDING'};
}
async function razorpay(path,env,method='GET',body){
  const keyId=clean(env.RAZORPAY_KEY_ID)||clean(env.RAZORPAY_LIVE_KEY_ID);
  const keySecret=clean(env.RAZORPAY_KEY_SECRET)||clean(env.RAZORPAY_LIVE_KEY_SECRET);
  if(!keyId||!keySecret)throw Error('Razorpay API credentials are not configured in Payment Core.');
  const authValue=btoa(`${keyId}:${keySecret}`);
  const r=await fetch(`https://api.razorpay.com/v1${path}`,{method,headers:{Authorization:`Basic ${authValue}`,'Content-Type':'application/json'},body:body?JSON.stringify(body):undefined});
  const text=await r.text();let d={};try{d=JSON.parse(text||'{}')}catch{d={error:{description:text}}}
  if(!r.ok){
    const desc=d?.error?.description||`Razorpay API error ${r.status}`;
    if(r.status===401)throw Error('Razorpay authentication failed. Payment Core is using an invalid or mismatched Razorpay API Key ID/Secret.');
    throw Error(desc);
  }
  return d;
}
async function ensureLegacyPaymentHistory(x){
  await ensureTargetSchema(x.db,x.source);
  const existing=await x.db.prepare(`SELECT id FROM payment_history WHERE registration_id=? LIMIT 1`).bind(x.record.id).first();
  if(existing)return;
  const p=await x.db.prepare(`SELECT paid_amount,status,payment_method,payment_time,razorpay_payment_id,manual_utr,manual_note FROM payments WHERE registration_id=? LIMIT 1`).bind(x.record.id).first();
  const paid=money(p?.paid_amount||0);
  if(paid<=0)return;
  await x.db.prepare(`INSERT INTO payment_history(registration_id,event_type,source,amount_before,amount_added,amount_after,payment_method,transaction_id,utr,note,payment_time,verified_at,metadata) VALUES(?,?,?,?,?,?,?,?,?,?,?,?,?)`).bind(x.record.id,'INITIAL_PAYMENT_SNAPSHOT',x.source,0,paid,paid,clean(p?.payment_method)||'Existing Payment',clean(p?.razorpay_payment_id)||null,clean(p?.manual_utr)||null,clean(p?.manual_note)||'Imported from the existing payment record.',p?.payment_time||null,new Date().toISOString(),JSON.stringify({kind:'legacy_snapshot'})).run();
}
async function createPaymentLink(env,x,amount,actor){
  const value=money(amount);if(value<100)throw Error('Payment amount must be at least ₹100.');if(value>x.due)throw Error(`Payment amount cannot exceed the current due amount of ₹${x.due.toLocaleString('en-IN')}.`);
  const rid=x.record.registration_id;
  const reference=`KM-${x.source[0]}-${rid}-${Date.now()}`.slice(0,40);
  const expire=Math.floor(Date.now()/1000)+172800;
  const contact=String(x.traveller?.mobile_number||'').replace(/\D/g,'');
  const payload={amount:Math.round(value*100),currency:'INR',accept_partial:false,reference_id:reference,description:`Shri Kedar Badrinath Yatra 2026 - ${rid} - Payment`,customer:{name:String(x.traveller?.full_name||'Yatra Traveller').slice(0,50),contact:contact?`+91${contact.slice(-10)}`:undefined},notify:{sms:false,email:false},reminder_enable:false,expire_by:expire,notes:{registration_id:rid,source:x.source,purpose:'YATRA_PAYMENT',actor:String(actor||'public').slice(0,40)}};
  if(!payload.customer.contact)delete payload.customer.contact;
  const link=await razorpay('/payment_links',env,'POST',payload);
  await ensureLegacyPaymentHistory(x);
  const expiresAt=new Date(expire*1000).toISOString();
  await x.db.batch([
    x.db.prepare(`INSERT INTO payment_links(registration_id,source,razorpay_payment_link_id,reference_id,short_url,amount,paid_amount,status,expires_at,raw_response) VALUES(?,?,?,?,?,?,0,?,?,?)`).bind(x.record.id,x.source,link.id,reference,link.short_url,value,link.status||'created',expiresAt,JSON.stringify(link)),
    x.db.prepare(`INSERT INTO payment_history(registration_id,event_type,source,amount_before,amount_added,amount_after,payment_method,transaction_id,utr,note,payment_time,verified_at,metadata) VALUES(?,?,?,?,?,?,?,?,?,?,?,?,?)`).bind(x.record.id,'PAYMENT_LINK_CREATED',x.source,x.paid,0,x.paid,null,link.id,null,'Recovery link created for ₹'+value.toLocaleString('en-IN')+'.',null,new Date().toISOString(),JSON.stringify({shortUrl:link.short_url,amount:value,expiresAt}))
  ]);
  return {success:true,registrationId:rid,source:x.source,amount:value,dueAmount:x.due,linkId:link.id,shortUrl:link.short_url,referenceId:reference,expiresAt};
}
async function applyCapturedPayment(env,x,payment){
  const db=x.db;await ensureTargetSchema(db,x.source);
  const paymentId=clean(payment?.id||payment?.payment_id);if(!paymentId)throw Error('Payment ID missing in Payment Link event.');
  const exists=await db.prepare(`SELECT id FROM payment_transactions WHERE provider_payment_id=? LIMIT 1`).bind(paymentId).first();
  if(exists)return {success:true,duplicate:true};
  const amount=money(Number(payment?.amount||0)/100);if(amount<=0)throw Error('Captured payment amount is invalid.');
  const before=money((await db.prepare(`SELECT paid_amount FROM payments WHERE registration_id=?`).bind(x.record.id).first())?.paid_amount||0);
  const after=money(Math.min(x.total,before+amount));
  const status=x.source===LIVE?(after>0?'SUCCESS':'PENDING'):(after>=x.total&&x.total>0?'SUCCESS':after>0?'PARTIALLY_PAID':'PENDING');
  const regStatus=after>=x.total?'PAID':x.source===LIVE?'PAYMENT_PENDING':'PARTIALLY_PAID';
  const paymentTime=payment?.created_at?new Date(Number(payment.created_at)*1000).toISOString().slice(0,19).replace('T',' '):new Date().toISOString().slice(0,19).replace('T',' ');
  const method=clean(payment?.method)||'Razorpay';
  const utr=clean(payment?.acquirer_data?.rrn||payment?.acquirer_data?.upi_transaction_id||payment?.acquirer_data?.bank_transaction_id);
  const linkId=clean(payment?.plink_id||payment?.payment_link_id);
  const history=JSON.stringify({provider:'razorpay_payment_link',paymentId,linkId});
  const statements=[
    db.prepare(`UPDATE registrations SET status=?,updated_at=CURRENT_TIMESTAMP WHERE id=?`).bind(regStatus,x.record.id),
    db.prepare(`UPDATE payments SET paid_amount=?,status=?,payment_method=?,payment_time=?,manual_utr=COALESCE(?,manual_utr),raw_response=?,updated_at=CURRENT_TIMESTAMP WHERE registration_id=?`).bind(after,status,method,paymentTime,utr||null,JSON.stringify(payment),x.record.id),
    db.prepare(`INSERT INTO payment_transactions(registration_id,source,provider_payment_id,provider_link_id,amount,payment_method,payment_time,status,raw_response) VALUES(?,?,?,?,?,?,?,?,?)`).bind(x.record.id,x.source,paymentId,linkId||null,amount,method,paymentTime,'CAPTURED',JSON.stringify(payment)),
    db.prepare(`INSERT INTO payment_history(registration_id,event_type,source,amount_before,amount_added,amount_after,payment_method,transaction_id,utr,note,payment_time,verified_at,metadata) VALUES(?,?,?,?,?,?,?,?,?,?,?,?,?)`).bind(x.record.id,'PAYMENT_LINK_CAPTURED',x.source,before,Math.max(0,after-before),after,method,paymentId,utr||null,null,paymentTime,new Date().toISOString(),history)
  ];
  if(linkId)statements.push(db.prepare(`UPDATE payment_links SET paid_amount=paid_amount+?,status='paid',raw_response=?,updated_at=CURRENT_TIMESTAMP WHERE razorpay_payment_link_id=?`).bind(amount,JSON.stringify(payment),linkId));
  await db.batch(statements);
  return {success:true,registrationId:x.record.registration_id,source:x.source,amountAdded:amount,paidAmount:after,balance:Math.max(0,x.total-after)};
}
async function webhook(req,env){
  // Razorpay may send either a payment entity directly or only the payment-link entity.
  // Resolve the captured payment deterministically before mutating the database.
  const raw=await req.text(),sig=req.headers.get('X-Razorpay-Signature')||'',eid=req.headers.get('X-Razorpay-Event-Id')||'';
  if(!await validHmac(env.RAZORPAY_WEBHOOK_SECRET,raw,sig))return json({success:false,message:'Invalid webhook signature.'},401);
  let p;try{p=JSON.parse(raw)}catch{return json({success:false,message:'Invalid webhook JSON.'},400)}
  const e=String(p.event||'');
  if(!['payment_link.paid','payment_link.partially_paid'].includes(e))return json({success:true,ignored:true});
  const link=p?.payload?.payment_link?.entity||p?.payload?.payment_link||{};
  let payment=link?.payments?.[0]||p?.payload?.payment?.entity||{};
  if(!payment?.id && link?.id){
    try{
      const payments=await razorpay('/payment_links/'+encodeURIComponent(link.id)+'/payments',env);
      payment=(payments?.items||[]).find(x=>String(x?.status||'').toLowerCase()==='captured')||(payments?.items||[])[0]||{};
    }catch{}
  }
  const notes=link?.notes||{};const rid=clean(notes.registration_id||link?.reference_id?.match(/KEDAR-\d+/)?.[0]);
  if(!rid)return json({success:true,ignored:true});
  if(!payment?.id)return json({success:false,message:'Payment Link event did not contain a resolvable payment.'},422);
  const x=await getRegistration(env,rid);
  if(notes.source&&String(notes.source).toUpperCase()!==x.source)return json({success:false,message:'Payment source mismatch.'},409);
  return json(await applyCapturedPayment(env,x,payment),200);
}
async function lookup(req,env){const u=new URL(req.url);return publicView(await getRegistration(env,u.searchParams.get('registrationId')))}
export default{async fetch(req,env){const u=new URL(req.url),o=req.headers.get('Origin')||'';if(req.method==='OPTIONS')return new Response(null,{status:204,headers:cors(o)});try{
  if(req.method==='GET'&&u.pathname==='/')return json({success:true,service:EVENT_NAME,version:VERSION,status:'online',sources:['LIVE','MANUAL']},200,o);
  if(req.method==='POST'&&u.pathname==='/webhook/razorpay')return await webhook(req,env);
  if(req.method==='GET'&&u.pathname==='/api/health')return json({success:true,service:EVENT_NAME,version:VERSION,status:'online',publicRoutes:['GET /api/health','GET /api/payment/lookup','POST /api/payment/create'],adminRoutes:['GET /admin/payment','POST /admin/payment-link','GET /admin/payment-history'],webhook:'/webhook/razorpay'},200,o);
  if(req.method==='GET'&&u.pathname==='/api/payment/lookup')return json({success:true,registration:await lookup(req,env)},200,o);
  if(req.method==='POST'&&u.pathname==='/api/payment/create'){
    if((req.headers.get('Content-Type')||'').toLowerCase().split(';')[0]!=='application/json')return json({success:false,message:'Content-Type must be application/json.'},415,o);
    const d=await req.json().catch(()=>({})),x=await getRegistration(env,clean(d.registrationId)),amount=money(d.amount||x.due);if(amount<=0)throw Error('There is no amount due for this registration.');return json(await createPaymentLink(env,x,amount,'public'),200,o);
  }
  if(u.pathname.startsWith('/admin/')){
    if(!auth(req,env))return json({success:false,message:'Unauthorized.'},401,o);
    if(req.method==='GET'&&u.pathname==='/admin/payment')return json({success:true,registration:publicView(await getRegistration(env,u.searchParams.get('registrationId')))},200,o);
    if(req.method==='POST'&&u.pathname==='/admin/payment-link'){
      const d=await req.json().catch(()=>({})),x=await getRegistration(env,clean(d.registrationId)),amount=money(d.amount||x.due);return json(await createPaymentLink(env,x,amount,'admin'),200,o);
    }
    if(req.method==='GET'&&u.pathname==='/admin/payment-history'){
      const x=await getRegistration(env,clean(u.searchParams.get('registrationId')));await ensureLegacyPaymentHistory(x);let r={results:[]};try{r=await x.db.prepare(`SELECT id,event_type,source,amount_before,amount_added,amount_after,payment_method,transaction_id,utr,note,payment_time,verified_at,metadata FROM payment_history WHERE registration_id=? ORDER BY id DESC`).bind(x.record.id).all()}catch{}return json({success:true,registrationId:x.record.registration_id,history:r.results||[]},200,o);
    }
  }
  return json({success:false,message:'Not found.'},404,o);
}catch(e){return json({success:false,message:e?.message||'Request failed.'},400,o)}}};
