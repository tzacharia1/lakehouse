# Lakehouse POC: Trino, Apache Iceberg, Postgres

A local lakehouse you can start with Docker Compose.

| Piece | Role | Where to look |
| --- | --- | --- |
| [Trino](https://trino.io/) 484 | SQL query engine and Iceberg writer | http://localhost:8080 |
| [Apache Iceberg](https://iceberg.apache.org/) | Table format (Parquet data files, snapshot metadata) | `s3://warehouse/` |
| PostgreSQL 16 | Iceberg JDBC catalog (namespace and table pointers) | `localhost:5432`, database `iceberg` |
| [SeaweedFS](https://github.com/seaweedfs/seaweedfs) 4.53 | S3-compatible object storage for data and Iceberg metadata files | S3 http://localhost:8333, filer http://localhost:8888 |
| Iceberg REST fixture | Same JDBC catalog, exposed over HTTP for the in-browser DuckDB | http://localhost:8181 |

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

New tables use Iceberg format version 3. The starter tables are altered to version 3 on startup. Trino 484 already ships Iceberg 1.12.0, and its version 3 support is experimental. Row lineage columns are hidden. They are assigned on the first commit after a table becomes version 3:

```sql
SELECT "$row_id", "$last_updated_sequence_number", customer_id, full_name
FROM iceberg.sales.customers;
```

## Prerequisites

Docker with Compose.

These host ports must be free: `5432`, `5522`, `8000`, `8080`, `8181`, `8333`, `8888`.

## Start

```bash
docker compose up -d
docker compose logs -f seed
```

Wait until the seed container prints `Ready. Query iceberg.sales.customers and iceberg.sales.orders.` Then it exits successfully.

## Web app

http://localhost:8000 lists the tables Trino can see, runs a SQL statement, renders the rows in the page, and downloads that result as CSV. The on-screen table stops at 500 rows. The CSV includes up to 10,000. There is no login. It is meant for this local stack.

Click a table name to query it. Cmd-Enter or Ctrl-Enter also runs the statement in the editor.

http://localhost:8000/notebooks is a separate page for [Duck-UI](https://github.com/caioricciuti/duck-ui), an open-source DuckDB workbench with SQL, Python, and Markdown notebooks. DuckDB runs in the browser. On startup it attaches the Iceberg REST catalog, so a SQL cell can run `SELECT * FROM iceberg.sales.customers` against the same tables as the SQL page. Compose publishes the workbench on port 5522 and the catalog on port 8181. The browser reads Parquet directly from SeaweedFS.

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
Stop the S3 engine with colima stop, and start it again with colima start

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
catalog/                               Iceberg REST fixture and browser CORS proxy
duck-ui/                               notebook bootstrap that attaches the catalog
```
