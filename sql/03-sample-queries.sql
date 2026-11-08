-- Row counts
SELECT 'customers' AS table_name, count(*) AS rows FROM iceberg.sales.customers
UNION ALL
SELECT 'orders', count(*) FROM iceberg.sales.orders;

-- Join across the two Iceberg tables
SELECT
    c.full_name,
    c.country,
    count(*) AS orders,
    sum(o.amount) AS revenue
FROM iceberg.sales.orders AS o
JOIN iceberg.sales.customers AS c
    ON c.customer_id = o.customer_id
GROUP BY c.full_name, c.country
ORDER BY revenue DESC;

-- Iceberg partition metadata for orders (month(order_date))
SELECT * FROM iceberg.sales."orders$partitions";

-- Snapshots written by CREATE TABLE and INSERT
SELECT snapshot_id, committed_at, operation, summary
FROM iceberg.sales."orders$snapshots"
ORDER BY committed_at;
