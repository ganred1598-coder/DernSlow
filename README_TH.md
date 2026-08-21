# DERNSLOW OS Cloudflare — Migration Foundation

ชุดเริ่มต้นสำหรับย้ายจาก Google Apps Script ไป Cloudflare โดยยังไม่กระทบระบบร้านเดิม

## สิ่งที่มีในรอบแรก

- Worker API และ Static Assets
- D1 schema สำหรับสินค้า ลูกค้า ออเดอร์ รายการสินค้า สต็อก บัญชีชำระ และ Daily Closing
- API สร้างออเดอร์พร้อม idempotency, validation เบอร์ไทย, payment account และสต็อก
- D1 batch สำหรับบันทึกออเดอร์และตัดสต็อกเป็นชุดเดียว
- Durable Object alarm แยกตามออเดอร์ เพื่อคืนสต็อกเมื่อครบเวลาจอง
- R2 สำหรับอัปโหลดสลิป
- Structured error response ที่หน้าเว็บสามารถแสดงสาเหตุจริง

## ยังไม่ Deploy จริง

ต้องสร้าง D1 และ R2 ในบัญชี Cloudflare ก่อน แล้วนำ D1 database ID จริงไปแทนค่า placeholder ใน `wrangler.jsonc`

หมายเหตุ: เครื่องมือตรวจ Cloudflare ยังไม่ได้ติดตั้งในชุด ZIP (`node_modules` ไม่ถูกรวมอยู่แล้ว) ให้รัน `npm install` บนเครื่องที่เชื่อมต่ออินเทอร์เน็ตก่อนตรวจและ Deploy

## ขั้นตอนทดสอบในเครื่อง

```text
npm install
npx wrangler types src/worker-configuration.d.ts
npx wrangler d1 migrations apply dernslow-db --local
npm run check
npm run dev
```

## ขั้นตอนก่อนเปิด Production

1. Export Google Sheets ทุกชีตเป็น CSV
2. แปลงและ Import ข้อมูลเข้า D1 staging
3. ย้ายรูป/สลิปไป R2
4. แปลง Customer/Admin UI ให้เรียก `/api/*`
5. ทดสอบ Order, POS, COD, Commission, Daily Closing และ A6/A9
6. สำรองข้อมูลและสลับโดเมนเมื่อผลเทียบตรงกัน
