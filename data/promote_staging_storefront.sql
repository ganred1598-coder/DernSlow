-- Run only after DERNSLOW_OS_staging_import.sql and migrations 0001/0002.

INSERT INTO settings(key,value,updated_at)
SELECT key,COALESCE(value,''),COALESCE(updated_at,datetime('now')) FROM staging_settings
WHERE COALESCE(key,'')<>''
ON CONFLICT(key) DO UPDATE SET value=excluded.value,updated_at=excluded.updated_at;

INSERT INTO products(
  id,code,name,category,stock_units,unit_name,price,active,created_at,updated_at,
  description,images_json,category_template,price_1,price_5,price_10,price_30,
  price_50,price_100,price_500,price_1000,verified_only,snack_variants_json
)
SELECT
  id,code,name,COALESCE(category,''),MAX(0,CAST(COALESCE(stock_grams,'0') AS INTEGER)),
  COALESCE(NULLIF(unit_name,''),'กรัม'),
  CAST(COALESCE(NULLIF(price_1,''),NULLIF(price_5,''),NULLIF(price_10,''),NULLIF(price_30,''),NULLIF(price_50,''),NULLIF(price_100,''),NULLIF(price_500,''),NULLIF(price_1000,''),'0') AS INTEGER),
  CASE WHEN lower(COALESCE(active,'')) IN ('true','1','yes','on') THEN 1 ELSE 0 END,
  COALESCE(NULLIF(created_at,''),datetime('now')),COALESCE(NULLIF(updated_at,''),datetime('now')),
  COALESCE(description,''),COALESCE(NULLIF(images_json,''),'[]'),COALESCE(NULLIF(category_template,''),'default'),
  CAST(NULLIF(price_1,'') AS INTEGER),CAST(NULLIF(price_5,'') AS INTEGER),CAST(NULLIF(price_10,'') AS INTEGER),
  CAST(NULLIF(price_30,'') AS INTEGER),CAST(NULLIF(price_50,'') AS INTEGER),CAST(NULLIF(price_100,'') AS INTEGER),
  CAST(NULLIF(price_500,'') AS INTEGER),CAST(NULLIF(price_1000,'') AS INTEGER),
  CASE WHEN lower(COALESCE(verified_only,'')) IN ('true','1','yes','on') THEN 1 ELSE 0 END,
  COALESCE(NULLIF(snack_variants_json,''),'[]')
FROM staging_products WHERE COALESCE(id,'')<>'' AND COALESCE(code,'')<>''
ON CONFLICT(id) DO UPDATE SET
  code=excluded.code,name=excluded.name,category=excluded.category,stock_units=excluded.stock_units,
  unit_name=excluded.unit_name,price=excluded.price,active=excluded.active,updated_at=excluded.updated_at,
  description=excluded.description,images_json=excluded.images_json,category_template=excluded.category_template,
  price_1=excluded.price_1,price_5=excluded.price_5,price_10=excluded.price_10,price_30=excluded.price_30,
  price_50=excluded.price_50,price_100=excluded.price_100,price_500=excluded.price_500,price_1000=excluded.price_1000,
  verified_only=excluded.verified_only,snack_variants_json=excluded.snack_variants_json;

INSERT INTO payment_accounts(id,type,provider,account_name,account_number,qr_object_key,active,sort_order,created_at,updated_at,qr_url)
SELECT id,COALESCE(type,'bank'),COALESCE(provider,''),COALESCE(account_name,''),COALESCE(account_number,''),'',
  CASE WHEN lower(COALESCE(active,'')) IN ('true','1','yes','on') THEN 1 ELSE 0 END,
  CAST(COALESCE(NULLIF(sort_order,''),'0') AS INTEGER),COALESCE(NULLIF(created_at,''),datetime('now')),
  COALESCE(NULLIF(updated_at,''),datetime('now')),COALESCE(qr_image_url,'')
FROM staging_paymentaccounts WHERE COALESCE(id,'')<>''
ON CONFLICT(id) DO UPDATE SET type=excluded.type,provider=excluded.provider,account_name=excluded.account_name,
  account_number=excluded.account_number,active=excluded.active,sort_order=excluded.sort_order,
  updated_at=excluded.updated_at,qr_url=excluded.qr_url;
