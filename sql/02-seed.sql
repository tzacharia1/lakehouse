INSERT INTO iceberg.sales.customers (customer_id, full_name, email, country, signup_date)
VALUES
    (1, 'Ava Chen', 'ava.chen@example.com', 'US', DATE '2024-01-15'),
    (2, 'Noah Patel', 'noah.patel@example.com', 'UK', DATE '2024-02-03'),
    (3, 'Mia Rossi', 'mia.rossi@example.com', 'IT', DATE '2024-03-21'),
    (4, 'Leo Kim', 'leo.kim@example.com', 'KR', DATE '2024-06-11'),
    (5, 'Sofia Alvarez', 'sofia.alvarez@example.com', 'ES', DATE '2024-11-02');

INSERT INTO iceberg.sales.orders (order_id, customer_id, order_date, status, amount)
VALUES
    (1001, 1, DATE '2024-11-03', 'shipped', DECIMAL '128.50'),
    (1002, 1, DATE '2024-12-14', 'shipped', DECIMAL '42.00'),
    (1003, 2, DATE '2024-11-18', 'shipped', DECIMAL '89.99'),
    (1004, 3, DATE '2024-12-01', 'returned', DECIMAL '210.00'),
    (1005, 3, DATE '2025-01-09', 'shipped', DECIMAL '15.75'),
    (1006, 4, DATE '2025-01-22', 'processing', DECIMAL '64.20'),
    (1007, 5, DATE '2025-02-02', 'shipped', DECIMAL '310.40'),
    (1008, 2, DATE '2025-02-17', 'shipped', DECIMAL '27.10');
