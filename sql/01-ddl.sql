-- sales.customers: small unpartitioned dimension table.
CREATE SCHEMA IF NOT EXISTS iceberg.sales
WITH (location = 's3://warehouse/sales');

CREATE TABLE IF NOT EXISTS iceberg.sales.customers (
    customer_id BIGINT,
    full_name VARCHAR,
    email VARCHAR,
    country VARCHAR,
    signup_date DATE
);

-- sales.orders: fact table partitioned by order month.
-- Partitioning is an Iceberg spec, stored in table metadata, not a Postgres partition.
CREATE TABLE IF NOT EXISTS iceberg.sales.orders (
    order_id BIGINT,
    customer_id BIGINT,
    order_date DATE,
    status VARCHAR,
    amount DECIMAL(10, 2)
)
WITH (
    partitioning = ARRAY['month(order_date)'],
    format = 'PARQUET'
);
