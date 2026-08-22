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

const ADMIN_EMAIL='ganred1598@gmail.com';

async function requireAdmin(ctx:ExecutionContext):Promise<CloudflareAccessIdentity>{
  const identity=await ctx.access?.getIdentity();
  const email=String(identity?.email||'').toLowerCase();
  if(email!==ADMIN_EMAIL)throw new ApiError(403,'ADMIN_ACCESS_REQUIRED','กรุณาเข้าสู่ระบบด้วยอีเมลแอดมินผ่าน Cloudflare Access');
  return identity!;
}

async function adminBootstrap(env:Env,identity:CloudflareAccessIdentity):Promise<Response>{
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
  return json({ok:true,admin:{email:String(identity.email||ADMIN_EMAIL)},summary:{total_products:totalProducts?.value||0,low_stock:lowStock?.value||0,total_customers:totalCustomers?.value||0,total_orders:totalOrders?.value||0,today_orders:todayOrders?.value||0,today_sales:todaySales?.value||0},products:products.results,orders:orders.results,customers:customers.results,payment_accounts:payments.results,daily_closings:closings.results});
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
      if(url.pathname.startsWith('/api/admin/')){
        const identity=await requireAdmin(ctx);
        if(request.method==='GET'&&url.pathname==='/api/admin/bootstrap')return await adminBootstrap(env,identity);
        if(request.method==='POST'&&url.pathname==='/api/admin/pos')return await createOrder(request,env);
        if(request.method==='POST'&&url.pathname==='/api/admin/stock/adjust')return await adjustAdminStock(request,env);
        const adminOrder=url.pathname.match(/^\/api\/admin\/orders\/([^/]+)$/);
        if(request.method==='PATCH'&&adminOrder)return await updateAdminOrder(request,env,decodeURIComponent(adminOrder[1]));
        throw new ApiError(404,'NOT_FOUND','ไม่พบ Admin API ที่เรียก');
      }
      if(request.method==='GET'&&url.pathname==='/api/health')return json({ok:true,service:'dernslow-os',time:new Date().toISOString()});
      if(request.method==='GET'&&url.pathname==='/api/config'){
        const lineOaId=await env.DB.prepare("SELECT value FROM settings WHERE key='contact_line_label'").first<string>('value')||'@highdernslow';
        return json({ok:true,line_oa_id:lineOaId});
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
      if(request.method==='GET'&&(url.pathname==='/admin'||url.pathname==='/admin/')){
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
