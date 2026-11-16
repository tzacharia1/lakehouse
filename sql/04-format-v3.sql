-- Existing tables created before format version 3 stay on version 2 until altered.
ALTER TABLE iceberg.sales.customers SET PROPERTIES format_version = 3;
ALTER TABLE iceberg.sales.orders SET PROPERTIES format_version = 3;
