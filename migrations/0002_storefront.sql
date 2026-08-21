ALTER TABLE products ADD COLUMN description TEXT NOT NULL DEFAULT '';
ALTER TABLE products ADD COLUMN images_json TEXT NOT NULL DEFAULT '[]';
ALTER TABLE products ADD COLUMN category_template TEXT NOT NULL DEFAULT 'default';
ALTER TABLE products ADD COLUMN price_1 INTEGER;
ALTER TABLE products ADD COLUMN price_5 INTEGER;
ALTER TABLE products ADD COLUMN price_10 INTEGER;
ALTER TABLE products ADD COLUMN price_30 INTEGER;
ALTER TABLE products ADD COLUMN price_50 INTEGER;
ALTER TABLE products ADD COLUMN price_100 INTEGER;
ALTER TABLE products ADD COLUMN price_500 INTEGER;
ALTER TABLE products ADD COLUMN price_1000 INTEGER;
ALTER TABLE products ADD COLUMN verified_only INTEGER NOT NULL DEFAULT 0;
ALTER TABLE products ADD COLUMN snack_variants_json TEXT NOT NULL DEFAULT '[]';
ALTER TABLE payment_accounts ADD COLUMN qr_url TEXT NOT NULL DEFAULT '';

CREATE INDEX IF NOT EXISTS products_active_name ON products(active,name);
CREATE INDEX IF NOT EXISTS payment_accounts_active_sort ON payment_accounts(active,sort_order);
