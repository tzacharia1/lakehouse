# Lakehouse POC: Trino, Apache Iceberg, Postgres

A local lakehouse you can start with Docker Compose.

| Piece | Role | Where to look |
| --- | --- | --- |
| [Trino](https://trino.io/) 484 | SQL query engine and Iceberg writer | http://localhost:8080 |
| [Apache Iceberg](https://iceberg.apache.org/) | Table format (Parquet data files, snapshot metadata) | `s3://warehouse/` |
| PostgreSQL 16 | Iceberg JDBC catalog (namespace and table pointers) | `localhost:5432`, database `iceberg` |
| [SeaweedFS](https://github.com/seaweedfs/seaweedfs) 4.53 | S3-compatible object storage for data and Iceberg metadata files | S3 http://localhost:8333, filer http://localhost:8888 |

Trino's `iceberg` catalog uses `iceberg.catalog.type=jdbc`. Postgres stores two catalog tables, `iceberg_tables` and `iceberg_namespace_properties`. Those rows point at Iceberg metadata JSON in the object store. The Parquet data files live next to that metadata. Postgres does not store the table rows.

SeaweedFS is the warehouse because the community `minio/minio` image is no longer published on Docker Hub. Trino still talks to it with the S3 API (`s3://warehouse/`).

```
  trino  ----SQL---->  iceberg.sales.customers
    |                  iceberg.sales.orders
    |                         |
    | JDBC catalog            | Parquet + metadata JSON
    v                         v
 postgres                  seaweedfs  (s3://warehouse)
```

## Example tables

Both tables are created in the `iceberg.sales` schema on first startup.

* `sales.customers` is an unpartitioned dimension table (5 rows).
* `sales.orders` is a fact table partitioned by `month(order_date)` (8 rows). `customer_id` joins to `customers`.

## Prerequisites

Docker with Compose.

These host ports must be free: `5432`, `8000`, `8080`, `8333`, `8888`.

## Start

```bash
docker compose up -d
docker compose logs -f seed
```

Wait until the seed container prints `Ready. Query iceberg.sales.customers and iceberg.sales.orders.` Then it exits successfully.

## Web app

http://localhost:8000 lists the tables Trino can see, runs a SQL statement, renders the rows in the page, and downloads that result as CSV. The on-screen table stops at 500 rows. The CSV includes up to 10,000. There is no login. It is meant for this local stack.

Click a table name to query it. Cmd-Enter or Ctrl-Enter also runs the statement in the editor.

## Query

Open a Trino shell:

```bash
docker compose exec trino trino
```

```sql
SHOW SCHEMAS FROM iceberg;
SHOW TABLES FROM iceberg.sales;
SELECT * FROM iceberg.sales.customers;
SELECT * FROM iceberg.sales.orders;
```

More queries, including a join and Iceberg snapshot and partition metadata, are in `sql/03-sample-queries.sql`:

```bash
docker compose exec -T trino trino --file /sql/03-sample-queries.sql
```

## Inspect the catalog and the files

Postgres holds pointers, not rows:

```bash
docker compose exec postgres \
  psql -U iceberg -d iceberg \
  -c "SELECT table_namespace, table_name, metadata_location FROM iceberg_tables;"
```

The filer UI at http://localhost:8888 shows the `warehouse` bucket. Under `sales/customers` and `sales/orders` you will see `metadata/` and `data/`.

Credentials, local demo only:

| Service | User | Password |
| --- | --- | --- |
| Postgres | `iceberg` | `iceberg` |
| SeaweedFS S3 | `lakehouse` | `lakehouse12345` |

## Stop

```bash
docker compose down
```

`docker compose down -v` also deletes the Postgres catalog and the warehouse. The next `up` loads the example tables again. Postgres init SQL runs only when the data volume is empty.

## Layout

```
docker-compose.yml
postgres/init/01-iceberg-catalog.sql   JDBC catalog tables
trino/catalog/iceberg.properties       Iceberg connector
sql/01-ddl.sql                         schema and tables
sql/02-seed.sql                        sample rows
sql/03-sample-queries.sql              join, partitions, snapshots
scripts/seed.sh                        runs DDL, then loads rows once
web/                                   query page on port 8000
```
