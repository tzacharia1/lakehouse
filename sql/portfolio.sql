CREATE SCHEMA IF NOT EXISTS iceberg.wlcr
WITH (location = 's3://warehouse/wlcr');

CREATE TABLE IF NOT EXISTS iceberg.wlcr.portfolios (
    fiscal_year int, accounting_period int,
    unique_rowid VARCHAR,
    gfcid VARCHAR,
    tosuc_amt DECIMAL(10, 2),
    orr int
)
WITH (
    partitioning = ARRAY['fiscal_year'],
    format = 'PARQUET',
    format_version = 3
);

INSERT INTO iceberg.wlcr.portfolios
VALUES
    (2026, 1, '123', 'C123', DECIMAL '128.50',5),
    (2026, 1, '234', 'c123', DECIMAL '42.00',7),
    (2026, 2, '123', 'c345', DECIMAL '89.99',5),
    (2026, 2, '234', 'c456', DECIMAL '210.00',7),
    (2026, 3, '123', 'c123', DECIMAL '15.75',8),
    (2026, 3, '345', 'c123', DECIMAL '64.20',8),
    (2026, 3, '456', 'c456', DECIMAL '310.40',7),
    (2026, 3, '567', 'c567', DECIMAL '27.10',7);

