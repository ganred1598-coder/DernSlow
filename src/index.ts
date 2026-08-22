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

export default {
  async fetch(request:Request,env:Env,ctx:ExecutionContext):Promise<Response>{
    const url=new URL(request.url);
    try{
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
      return env.ASSETS.fetch(request);
    }catch(error){
      const known=error instanceof ApiError;
      console.error(JSON.stringify({event:'request_error',path:url.pathname,method:request.method,code:known?error.code:'INTERNAL_ERROR',message:error instanceof Error?error.message:String(error)}));
      return json({ok:false,error:{code:known?error.code:'INTERNAL_ERROR',message:known?error.message:'ระบบขัดข้อง กรุณาลองใหม่'}},known?error.status:500);
    }
  }
} satisfies ExportedHandler<Env>;
