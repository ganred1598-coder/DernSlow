import {ApiError,assertThaiPhone,cleanText} from './domain';
import {ReservationExpiry} from './reservation-expiry';
export {ReservationExpiry};

type CartItem={product_id:string;quantity:number};
type CreateOrderBody={request_id:string;customer_key:string;customer_name:string;phone:string;address:string;payment_method:'prepaid'|'cod';payment_account_id?:string;items:CartItem[]};

const json=(data:unknown,status=200)=>Response.json(data,{status,headers:{'cache-control':'no-store'}});

async function readJson<T>(request:Request):Promise<T>{
  const type=request.headers.get('content-type')||'';
  if(!type.includes('application/json'))throw new ApiError(415,'UNSUPPORTED_MEDIA_TYPE','คำขอต้องเป็น JSON');
  return await request.json() as T;
}

async function createOrder(request:Request,env:Env):Promise<Response>{
  const body=await readJson<CreateOrderBody>(request);
  const requestId=cleanText(body.request_id,100);
  const customerKey=cleanText(body.customer_key,100);
  const name=cleanText(body.customer_name,150);
  const address=cleanText(body.address,1000);
  const phone=assertThaiPhone(body.phone);
  if(!/^[A-Za-z0-9_-]{12,100}$/.test(requestId))throw new ApiError(400,'INVALID_REQUEST_ID','รหัสคำขอจองไม่ถูกต้อง');
  if(!/^[A-Za-z0-9_-]{16,100}$/.test(customerKey))throw new ApiError(400,'INVALID_CUSTOMER_KEY','รหัสลูกค้าไม่ถูกต้อง');
  if(!name)throw new ApiError(400,'CUSTOMER_NAME_REQUIRED','กรุณากรอกชื่อลูกค้า');
  if(!address)throw new ApiError(400,'ADDRESS_REQUIRED','กรุณากรอกที่อยู่จัดส่ง');
  if(!Array.isArray(body.items)||body.items.length===0||body.items.length>50)throw new ApiError(400,'INVALID_CART','ตะกร้าว่างหรือมีรายการเกินกำหนด');

  const existing=await env.DB.prepare('SELECT id AS order_id,order_no,total,reserved_until FROM orders WHERE request_id=?').bind(requestId).first();
  if(existing)return json({ok:true,...existing,idempotent:true});

  const quantities=new Map<string,number>();
  for(const raw of body.items){
    const id=cleanText(raw.product_id,100);
    const qty=Number(raw.quantity);
    if(!id||!Number.isInteger(qty)||qty<1)throw new ApiError(400,'INVALID_CART_ITEM','จำนวนสินค้าไม่ถูกต้อง');
    quantities.set(id,(quantities.get(id)||0)+qty);
  }
  const products=[];
  for(const [id,quantity] of quantities){
    const product=await env.DB.prepare(`SELECT id,code,name,stock_units,active,price_1,price_5,price_10,price_30,price_50,price_100,price_500,price_1000
      FROM products WHERE id=?`).bind(id).first<{id:string;code:string;name:string;stock_units:number;active:number;price_1:number|null;price_5:number|null;price_10:number|null;price_30:number|null;price_50:number|null;price_100:number|null;price_500:number|null;price_1000:number|null}>();
    if(!product||!product.active)throw new ApiError(409,'PRODUCT_UNAVAILABLE','สินค้าไม่พร้อมจำหน่าย');
    if(product.stock_units<quantity)throw new ApiError(409,'INSUFFICIENT_STOCK',product.name+' สต็อกไม่เพียงพอ เหลือ '+product.stock_units);
    const price=product[`price_${quantity}` as keyof typeof product];
    if(typeof price!=='number'||price<0)throw new ApiError(409,'INVALID_PRODUCT_SIZE',product.name+' ไม่มีราคาสำหรับขนาด '+quantity);
    products.push({...product,price,quantity});
  }

  let paymentAccountId:string|null=null;
  if(body.payment_method==='prepaid'){
    paymentAccountId=cleanText(body.payment_account_id,100);
    const account=await env.DB.prepare('SELECT id FROM payment_accounts WHERE id=? AND active=1').bind(paymentAccountId).first();
    if(!account)throw new ApiError(400,'PAYMENT_ACCOUNT_REQUIRED','กรุณาเลือกบัญชีรับชำระที่เปิดใช้งาน');
  }else if(body.payment_method!=='cod')throw new ApiError(400,'INVALID_PAYMENT_METHOD','วิธีชำระเงินไม่ถูกต้อง');

  const now=new Date();
  const minutes=Number(await env.DB.prepare("SELECT value FROM settings WHERE key='reservation_minutes'").first<string>('value'))||40;
  const reservedUntil=new Date(now.getTime()+minutes*60000).toISOString();
  const orderId=crypto.randomUUID();
  const savedCustomer=await env.DB.prepare('SELECT id FROM customers WHERE customer_key=? OR phone=? LIMIT 1').bind(customerKey,phone).first<{id:string}>();
  const customerId=savedCustomer?.id||crypto.randomUUID();
  const orderNo='DS'+now.toISOString().replace(/\D/g,'').slice(2,14)+crypto.randomUUID().slice(0,4).toUpperCase();
  const total=products.reduce((sum,p)=>sum+p.price*p.quantity,0);
  const customerStatement=savedCustomer
    ? env.DB.prepare('UPDATE customers SET name=?,phone=?,address=?,updated_at=? WHERE id=?').bind(name,phone,address,now.toISOString(),customerId)
    : env.DB.prepare('INSERT INTO customers(id,customer_key,name,phone,address,created_at,updated_at) VALUES(?,?,?,?,?,?,?)').bind(customerId,customerKey,name,phone,address,now.toISOString(),now.toISOString());
  const statements:D1PreparedStatement[]=[
    customerStatement,
    env.DB.prepare(`INSERT INTO orders(id,order_no,request_id,customer_id,customer_key,customer_name,phone,address,total,status,payment_status,payment_method,payment_account_id,reserved_until,created_at,updated_at)
      VALUES(?,?,?,?,?,?,?,?,?,'reserved','unpaid',?,?,?,?,?)`).bind(orderId,orderNo,requestId,customerId,customerKey,name,phone,address,total,body.payment_method,paymentAccountId,reservedUntil,now.toISOString(),now.toISOString())
  ];
  for(const p of products){
    // The CHECK(stock_units >= 0) constraint makes the entire D1 batch roll back
    // if concurrent requests consume the remaining stock before this transaction.
    statements.push(env.DB.prepare('UPDATE products SET stock_units=stock_units-?,updated_at=? WHERE id=? AND active=1').bind(p.quantity,now.toISOString(),p.id));
    statements.push(env.DB.prepare('INSERT INTO order_items(id,order_id,product_id,product_code,product_name,quantity,unit_price,total) VALUES(?,?,?,?,?,?,?,?)').bind(crypto.randomUUID(),orderId,p.id,p.code,p.name,p.quantity,p.price,p.price*p.quantity));
    statements.push(env.DB.prepare('INSERT INTO stock_log(id,product_id,order_id,change_units,balance_units,reason,created_at) SELECT ?,?,?,?,stock_units,?,? FROM products WHERE id=?').bind(crypto.randomUUID(),p.id,orderId,-p.quantity,'reservation_created',now.toISOString(),p.id));
  }
  await env.DB.batch(statements);
  const reservation=env.RESERVATIONS.getByName(orderId) as DurableObjectStub<ReservationExpiry>;
  await reservation.schedule(orderId,reservedUntil);
  return json({ok:true,order_id:orderId,order_no:orderNo,total,reserved_until:reservedUntil,reservation_minutes:minutes},201);
}

async function uploadSlip(request:Request,env:Env,orderId:string):Promise<Response>{
  const order=await env.DB.prepare("SELECT id,status FROM orders WHERE id=? AND status='reserved'").bind(orderId).first();
  if(!order)throw new ApiError(404,'ORDER_NOT_FOUND','ไม่พบออเดอร์ที่รอชำระเงิน');
  const form=await request.formData();
  const file=form.get('file');
  if(!(file instanceof File))throw new ApiError(400,'SLIP_REQUIRED','กรุณาเลือกไฟล์สลิป');
  if(!['image/jpeg','image/png','image/webp','application/pdf'].includes(file.type))throw new ApiError(400,'INVALID_SLIP_TYPE','รองรับ JPG, PNG, WebP หรือ PDF เท่านั้น');
  if(file.size>10*1024*1024)throw new ApiError(413,'SLIP_TOO_LARGE','ไฟล์สลิปต้องไม่เกิน 10 MB');
  const key=`slips/${orderId}/${crypto.randomUUID()}`;
  await env.FILES.put(key,file.stream(),{httpMetadata:{contentType:file.type}});
  await env.DB.prepare("UPDATE orders SET payment_slip_key=?,payment_status='submitted',updated_at=datetime('now') WHERE id=?").bind(key,orderId).run();
  return json({ok:true,order_id:orderId,payment_status:'submitted'});
}

type AdminSession={id:string;display_name:string;role:string};
type AdminEnv=Env&{ADMIN_SETUP_CODE:string};
const adminCookie=(r:Request)=>r.headers.get('cookie')?.match(/(?:^|;\s*)ds_admin_device=([^;]+)/)?.[1]||'';
async function hashToken(v:string){const d=await crypto.subtle.digest('SHA-256',new TextEncoder().encode(v));return [...new Uint8Array(d)].map(x=>x.toString(16).padStart(2,'0')).join('')}
async function requireAdmin(request:Request,env:Env):Promise<AdminSession>{const token=adminCookie(request);if(!token)throw new ApiError(401,'ADMIN_DEVICE_REQUIRED','เครื่องนี้ยังไม่ได้รับอนุญาต');const a=await env.DB.prepare('SELECT a.id,a.display_name,a.role FROM admin_devices d JOIN admin_users a ON a.id=d.admin_id WHERE d.token_hash=? AND d.active=1 AND a.active=1').bind(await hashToken(token)).first<AdminSession>();if(!a)throw new ApiError(401,'ADMIN_DEVICE_REQUIRED','สิทธิ์เครื่องนี้หมดอายุหรือถูกยกเลิก');return a}
async function activateFirstOwner(request:Request,env:AdminEnv){if(await env.DB.prepare("SELECT id FROM admin_users WHERE role='main_owner' AND active=1").first())throw new ApiError(409,'OWNER_EXISTS','ระบบมี Owner หลักแล้ว');const b=await readJson<{code:string;device_name?:string}>(request);if(cleanText(b.code,20)!==env.ADMIN_SETUP_CODE)throw new ApiError(403,'INVALID_SETUP_CODE','รหัสเปิดใช้งานไม่ถูกต้อง');const now=new Date().toISOString(),id=crypto.randomUUID(),token=crypto.randomUUID()+crypto.randomUUID(),hash=await hashToken(token),device=cleanText(b.device_name||'เครื่อง Owner หลัก',80);await env.DB.batch([env.DB.prepare("INSERT INTO admin_users(id,display_name,role,created_at,updated_at) VALUES(?,'Owner หลัก','main_owner',?,?)").bind(id,now,now),env.DB.prepare('INSERT INTO admin_devices(id,admin_id,token_hash,device_name,last_seen_at,created_at) VALUES(?,?,?,?,?,?)').bind(crypto.randomUUID(),id,hash,device,now,now)]);return new Response(JSON.stringify({ok:true}),{headers:{'content-type':'application/json','set-cookie':`ds_admin_device=${token}; Path=/; HttpOnly; Secure; SameSite=Strict; Max-Age=31536000`}})}

async function adminBootstrap(env:Env,identity:AdminSession):Promise<Response>{
  const bangkokDate=new Intl.DateTimeFormat('en-CA',{timeZone:'Asia/Bangkok',year:'numeric',month:'2-digit',day:'2-digit'}).format(new Date());
  const todayStart=new Date(bangkokDate+'T00:00:00+07:00').toISOString();
  const [products,orders,customers,payments,closings,totalProducts,lowStock,totalCustomers,totalOrders,todayOrders,todaySales]=await Promise.all([
    env.DB.prepare(`SELECT id,code,name,category,description,images_json,stock_units,unit_name,active,price_1,price_5,price_10,price_30,price_50,price_100,price_500,price_1000,updated_at FROM products ORDER BY active DESC,name`).all(),
    env.DB.prepare(`SELECT o.id,o.order_no,o.customer_name,o.phone,o.address,o.total,o.status,o.payment_status,o.payment_method,o.reserved_until,o.created_at,o.updated_at,COUNT(oi.id) item_lines,COALESCE(SUM(oi.quantity),0) item_units FROM orders o LEFT JOIN order_items oi ON oi.order_id=o.id GROUP BY o.id ORDER BY o.created_at DESC LIMIT 150`).all(),
    env.DB.prepare(`SELECT id,name,phone,address,points,verified,created_at,updated_at FROM customers ORDER BY updated_at DESC LIMIT 150`).all(),
    env.DB.prepare(`SELECT id,type,provider,account_name,account_number,active,sort_order FROM payment_accounts ORDER BY active DESC,sort_order,provider`).all(),
    env.DB.prepare(`SELECT id,closing_date,closed_by,created_at FROM daily_closings ORDER BY closing_date DESC LIMIT 30`).all(),
    env.DB.prepare('SELECT COUNT(*) value FROM products WHERE active=1').first<{value:number}>(),
    env.DB.prepare('SELECT COUNT(*) value FROM products WHERE active=1 AND stock_units<=5').first<{value:number}>(),
    env.DB.prepare('SELECT COUNT(*) value FROM customers').first<{value:number}>(),
    env.DB.prepare('SELECT COUNT(*) value FROM orders').first<{value:number}>(),
    env.DB.prepare('SELECT COUNT(*) value FROM orders WHERE created_at>=?').bind(todayStart).first<{value:number}>(),
    env.DB.prepare("SELECT COALESCE(SUM(total),0) value FROM orders WHERE created_at>=? AND status NOT IN ('cancelled','expired')").bind(todayStart).first<{value:number}>()
  ]);
  const {results:paymentSummary}=await env.DB.prepare(`SELECT payment_status,COUNT(*) orders,COALESCE(SUM(total),0) total FROM orders WHERE status NOT IN ('cancelled','expired') GROUP BY payment_status`).all();
  const {results:settingRows}=await env.DB.prepare('SELECT key,value FROM settings').all<{key:string;value:string}>();
  const systemSettings=Object.fromEntries(settingRows.map(x=>[x.key,x.value]));
  return json({ok:true,admin:{email:identity.display_name,role:identity.role},summary:{total_products:totalProducts?.value||0,low_stock:lowStock?.value||0,total_customers:totalCustomers?.value||0,total_orders:totalOrders?.value||0,today_orders:todayOrders?.value||0,today_sales:todaySales?.value||0},payment_summary:paymentSummary,settings:systemSettings,products:products.results,orders:orders.results,customers:customers.results,payment_accounts:payments.results,daily_closings:closings.results});
}

async function saveAdminSettings(request:Request,env:Env,admin:AdminSession):Promise<Response>{
  if(!['main_owner','co_owner'].includes(admin.role))throw new ApiError(403,'OWNER_REQUIRED','เฉพาะ Owner เท่านั้นที่แก้การตั้งค่าระบบได้');
  const body=await readJson<{settings:Record<string,unknown>}>(request);
  const allowed:Record<string,{max:number;test?:(v:string)=>boolean}>={store_name:{max:80},brand_primary_color:{max:7,test:v=>/^#[0-9a-fA-F]{6}$/.test(v)},contact_line_label:{max:80},public_heading:{max:120},public_description:{max:500},public_notice:{max:500},reservation_minutes:{max:3,test:v=>/^\d+$/.test(v)&&Number(v)>=5&&Number(v)<=1440},low_stock_threshold:{max:5,test:v=>/^\d+$/.test(v)&&Number(v)>=0},currency_label:{max:10},timezone:{max:40,test:v=>v==='Asia/Bangkok'},carry_forward_enabled:{max:5,test:v=>['true','false'].includes(v)},commission_trigger:{max:20,test:v=>['paid','completed'].includes(v)},dashboard_default_period:{max:20,test:v=>['day','week','month'].includes(v)},pos_default_payment:{max:20,test:v=>['cod','prepaid'].includes(v)}};
  const now=new Date().toISOString(),statements:D1PreparedStatement[]=[];
  for(const [key,raw] of Object.entries(body.settings||{})){const rule=allowed[key];if(!rule)throw new ApiError(400,'SETTING_NOT_ALLOWED','ไม่อนุญาตให้แก้การตั้งค่า '+key);const value=cleanText(raw,rule.max);if(rule.test&&!rule.test(value))throw new ApiError(400,'INVALID_SETTING','ค่าของ '+key+' ไม่ถูกต้อง');statements.push(env.DB.prepare('INSERT INTO settings(key,value,updated_at) VALUES(?,?,?) ON CONFLICT(key) DO UPDATE SET value=excluded.value,updated_at=excluded.updated_at').bind(key,value,now))}
  if(statements.length)await env.DB.batch(statements);
  await env.DB.prepare('INSERT INTO admin_audit_log(id,admin_id,admin_name_snapshot,action,entity_type,entity_id,detail_json,created_at) VALUES(?,?,?,?,?,?,?,?)').bind(crypto.randomUUID(),admin.id,admin.display_name,'update_settings','settings','system',JSON.stringify({keys:Object.keys(body.settings||{})}),now).run();
  return json({ok:true,updated:Object.keys(body.settings||{})});
}
async function updateAdminOrder(request:Request,env:Env,orderId:string):Promise<Response>{
  const body=await readJson<{status?:string;payment_status?:string}>(request);
  const allowedStatus=['reserved','confirmed','packing','shipped','completed','cancelled','expired'];
  const allowedPayment=['unpaid','submitted','paid','rejected','cod_pending','cod_paid'];
  const current=await env.DB.prepare('SELECT id,status,payment_status FROM orders WHERE id=?').bind(orderId).first<{id:string;status:string;payment_status:string}>();
  if(!current)throw new ApiError(404,'ORDER_NOT_FOUND','ไม่พบออเดอร์');
  const status=body.status===undefined?current.status:cleanText(body.status,30);
  const payment=body.payment_status===undefined?current.payment_status:cleanText(body.payment_status,30);
  if(!allowedStatus.includes(status))throw new ApiError(400,'INVALID_ORDER_STATUS','สถานะออเดอร์ไม่ถูกต้อง');
  if(!allowedPayment.includes(payment))throw new ApiError(400,'INVALID_PAYMENT_STATUS','สถานะชำระเงินไม่ถูกต้อง');
  await env.DB.prepare('UPDATE orders SET status=?,payment_status=?,updated_at=? WHERE id=?').bind(status,payment,new Date().toISOString(),orderId).run();
  return json({ok:true,order_id:orderId,status,payment_status:payment});
}

async function adjustAdminStock(request:Request,env:Env):Promise<Response>{
  const body=await readJson<{product_id:string;change:number;reason?:string}>(request);
  const productId=cleanText(body.product_id,100),change=Number(body.change),reason=cleanText(body.reason||'manual_admin_adjustment',150);
  if(!productId||!Number.isInteger(change)||change===0)throw new ApiError(400,'INVALID_STOCK_CHANGE','จำนวนปรับสต็อกไม่ถูกต้อง');
  const product=await env.DB.prepare('SELECT id,name,stock_units FROM products WHERE id=?').bind(productId).first<{id:string;name:string;stock_units:number}>();
  if(!product)throw new ApiError(404,'PRODUCT_NOT_FOUND','ไม่พบสินค้า');
  const balance=product.stock_units+change;
  if(balance<0)throw new ApiError(409,'NEGATIVE_STOCK','สต็อกคงเหลือต้องไม่ติดลบ');
  const now=new Date().toISOString();
  await env.DB.batch([
    env.DB.prepare('UPDATE products SET stock_units=?,updated_at=? WHERE id=?').bind(balance,now,productId),
    env.DB.prepare('INSERT INTO stock_log(id,product_id,order_id,change_units,balance_units,reason,created_at) VALUES(?,?,NULL,?,?,?,?)').bind(crypto.randomUUID(),productId,change,balance,reason,now)
  ]);
  return json({ok:true,product_id:productId,stock_units:balance});
}
export default {
  async fetch(request:Request,env:Env,ctx:ExecutionContext):Promise<Response>{
    const url=new URL(request.url);
    try{
      if(request.method==='POST'&&url.pathname==='/api/admin/device/activate')return await activateFirstOwner(request,env as AdminEnv);
      if(url.pathname.startsWith('/api/admin/')){
        const identity=await requireAdmin(request,env);
        if(request.method==='GET'&&url.pathname==='/api/admin/bootstrap')return await adminBootstrap(env,identity);
        if(request.method==='PUT'&&url.pathname==='/api/admin/settings')return await saveAdminSettings(request,env,identity);
        if(request.method==='POST'&&url.pathname==='/api/admin/pos')return await createOrder(request,env);
        if(request.method==='POST'&&url.pathname==='/api/admin/stock/adjust')return await adjustAdminStock(request,env);
        const adminOrder=url.pathname.match(/^\/api\/admin\/orders\/([^/]+)$/);
        if(request.method==='PATCH'&&adminOrder)return await updateAdminOrder(request,env,decodeURIComponent(adminOrder[1]));
        throw new ApiError(404,'NOT_FOUND','ไม่พบ Admin API ที่เรียก');
      }
      if(request.method==='GET'&&url.pathname==='/api/health')return json({ok:true,service:'dernslow-os',time:new Date().toISOString()});
      if(request.method==='GET'&&url.pathname==='/api/config'){
        const {results}=await env.DB.prepare("SELECT key,value FROM settings WHERE key IN ('contact_line_label','store_name','brand_primary_color','public_heading','public_description','public_notice')").all<{key:string;value:string}>();
        const config=Object.fromEntries(results.map(x=>[x.key,x.value]));
        return json({ok:true,line_oa_id:config.contact_line_label||'@highdernslow',config});
      }
      if(request.method==='GET'&&url.pathname==='/api/products'){
        const {results}=await env.DB.prepare(`SELECT id,code,name,category,images_json,category_template,unit_name
          FROM products WHERE active=1 ORDER BY name`).all();
        return json({ok:true,products:results});
      }
      if(request.method==='GET'&&url.pathname==='/api/orders'){
        const customerKey=cleanText(url.searchParams.get('customer_key'),100);
        if(!/^[A-Za-z0-9_-]{16,100}$/.test(customerKey))throw new ApiError(400,'INVALID_CUSTOMER_KEY','รหัสลูกค้าไม่ถูกต้อง');
        const {results}=await env.DB.prepare(`SELECT id AS order_id,order_no,total,status,payment_status,payment_method,
          payment_account_id,reserved_until,created_at,updated_at FROM orders WHERE customer_key=? ORDER BY created_at DESC LIMIT 50`).bind(customerKey).all();
        return json({ok:true,orders:results});
      }
      if(request.method==='POST'&&url.pathname==='/api/orders')return await createOrder(request,env);
      const slip=url.pathname.match(/^\/api\/orders\/([^/]+)\/slip$/);
      if(request.method==='POST'&&slip)return await uploadSlip(request,env,decodeURIComponent(slip[1]));
      if(url.pathname.startsWith('/api/'))throw new ApiError(404,'NOT_FOUND','ไม่พบ API ที่เรียก');
      if(request.method==='GET'&&(url.pathname==='/admin'||url.pathname.startsWith('/admin/'))){
        
        const adminUrl=new URL('/admin/index.html',url);
        return env.ASSETS.fetch(new Request(adminUrl,request));
      }
      return env.ASSETS.fetch(request);
    }catch(error){
      const known=error instanceof ApiError;
      console.error(JSON.stringify({event:'request_error',path:url.pathname,method:request.method,code:known?error.code:'INTERNAL_ERROR',message:error instanceof Error?error.message:String(error)}));
      return json({ok:false,error:{code:known?error.code:'INTERNAL_ERROR',message:known?error.message:'ระบบขัดข้อง กรุณาลองใหม่'}},known?error.status:500);
    }
  }
} satisfies ExportedHandler<Env>;
