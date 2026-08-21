import {DurableObject} from 'cloudflare:workers';

export class ReservationExpiry extends DurableObject<Env> {
  async schedule(orderId:string,reservedUntil:string):Promise<void>{
    await this.ctx.storage.put('orderId',orderId);
    await this.ctx.storage.setAlarm(new Date(reservedUntil).getTime());
  }

  async cancel():Promise<void>{
    await this.ctx.storage.deleteAlarm();
    await this.ctx.storage.delete('orderId');
  }

  async alarm():Promise<void>{
    const orderId=await this.ctx.storage.get<string>('orderId');
    if(!orderId)return;
    const order=await this.env.DB.prepare('SELECT id,status FROM orders WHERE id=?').bind(orderId).first<{id:string;status:string}>();
    if(!order || order.status!=='reserved')return;
    const items=await this.env.DB.prepare('SELECT product_id,quantity FROM order_items WHERE order_id=?').bind(orderId).all<{product_id:string;quantity:number}>();
    const statements: D1PreparedStatement[]=[];
    for(const item of items.results){
      statements.push(this.env.DB.prepare("UPDATE products SET stock_units=stock_units+?,updated_at=datetime('now') WHERE id=? AND EXISTS(SELECT 1 FROM orders WHERE id=? AND status='reserved')").bind(item.quantity,item.product_id,orderId));
    }
    statements.push(this.env.DB.prepare("UPDATE orders SET status='expired',updated_at=datetime('now') WHERE id=? AND status='reserved'").bind(orderId));
    await this.env.DB.batch(statements);
    await this.ctx.storage.delete('orderId');
  }
}
