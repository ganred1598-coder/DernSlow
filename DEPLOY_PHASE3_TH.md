# DERNSLOW Cloudflare Phase 3 — Storefront

## สิ่งที่เพิ่ม

- หน้าแสดงสินค้าและรูปสินค้า
- ราคาหลายขนาด 1/5/10/30/50/100/500/1000 ตามข้อมูลเดิม
- ตะกร้าบันทึกในอุปกรณ์
- ฟอร์มลูกค้าและ normalize เบอร์ +66 เป็น 0
- บัญชีรับชำระและ COD
- Error แสดงค้างในหน้าสั่งซื้อ
- ป้องกัน double submit ด้วย request ID
- สำรองสต็อกตามเวลาตั้งค่า (ค่าเริ่มต้น 40 นาที)
- เปิดหน้าออเดอร์และแนบสลิปต่อทันที
- ดูออเดอร์ของอุปกรณ์นี้

## ลำดับฐานข้อมูลครั้งแรก

รันจากโฟลเดอร์ repository ด้วยบัญชี Cloudflare ที่เชื่อมไว้:

```text
npx wrangler d1 migrations apply dernslow-db --remote
npx wrangler d1 execute dernslow-db --remote --file data/DERNSLOW_OS_staging_import.sql
npx wrangler d1 execute dernslow-db --remote --file data/promote_staging_storefront.sql
```

จากนั้นตรวจจำนวนข้อมูล:

```text
npx wrangler d1 execute dernslow-db --remote --command "SELECT COUNT(*) AS products FROM products; SELECT COUNT(*) AS accounts FROM payment_accounts;"
```

ผลจากชุดข้อมูลต้นทางควรได้ Products = 40 และ Payment Accounts = 1

## Deploy

เมื่อ push เข้า branch `main` แล้ว Workers Builds จะรัน `npx wrangler deploy` ตามเดิม

ตรวจ URL ต่อไปนี้:

- `/api/health` ต้องได้ `ok: true`
- `/api/config` ต้องได้บัญชีชำระและ `reservation_minutes: 40`
- `/api/products` ต้องได้สินค้า
- `/` ต้องแสดง DERNSLOW STORE

## หมายเหตุ

- ยังไม่เปิดหน้า Admin/POS บน Cloudflare ใน Phase 3
- ยังไม่ย้าย session token เดิม
- ออเดอร์เก่าอยู่ใน staging เพื่อรอแปลง schema หลังบ้านใน Phase 4
