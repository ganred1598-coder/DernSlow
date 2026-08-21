# การนำข้อมูล Google Sheets เข้า D1 — Staging

ไฟล์ `data/DERNSLOW_OS_staging_import.sql` เก็บข้อมูลจาก Google Sheets ไว้ในตารางชื่อ `staging_*` เพื่อให้ตรวจเทียบก่อนย้ายเข้าตาราง Production

## นำเข้า

```text
npx wrangler d1 execute dernslow-db --remote --file data/DERNSLOW_OS_staging_import.sql
```

## ตรวจจำนวนข้อมูล

```text
npx wrangler d1 execute dernslow-db --remote --command "SELECT key,value FROM migration_metadata"
```

## กติกาความปลอดภัย

- ไม่แก้ Google Sheet ต้นฉบับ
- ไม่ย้าย `AdminSessions` เพราะ session token เดิมต้องหมดอายุและสร้างใหม่บน Cloudflare
- ข้อมูลถูกพักใน `staging_*` ก่อน ยังไม่เขียนทับตาราง Production
- `DailyClosings` ไม่มีอยู่ในไฟล์ต้นทาง จึงยังไม่มีข้อมูลปิดยอดให้ย้าย
- ไฟล์ SQL มีข้อมูลลูกค้า บัญชีรับเงิน และข้อมูลแอดมิน ต้องเก็บ repository เป็น Private เท่านั้น
