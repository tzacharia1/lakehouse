import csv
import io
import os
import re
import threading
import time
from datetime import date, datetime
from decimal import Decimal

import trino
from fastapi import FastAPI, HTTPException, Query
from fastapi.responses import FileResponse, Response
from fastapi.staticfiles import StaticFiles
from pydantic import BaseModel, Field
from trino.exceptions import TrinoQueryError

IDENT = re.compile(r"^[A-Za-z_][A-Za-z0-9_]*$")

PREVIEW_LIMIT = 500
CSV_LIMIT = 10_000
MAX_SQL_CHARS = 100_000
SKIP_CATALOGS = {"system", "jmx"}
TABLE_CACHE_SECONDS = 15

app = FastAPI(title="Lakehouse")
app.mount("/static", StaticFiles(directory="static"), name="static")

_cache_lock = threading.Lock()
_table_cache: dict = {"at": 0.0, "tables": None}


class QueryRequest(BaseModel):
    sql: str = Field(min_length=1, max_length=MAX_SQL_CHARS)


def trino_connect():
    return trino.dbapi.connect(
        host=os.environ.get("TRINO_HOST", "localhost"),
        port=int(os.environ.get("TRINO_PORT", "8080")),
        user=os.environ.get("TRINO_USER", "trino"),
        http_scheme="http",
        request_timeout=60,
    )


def quote_ident(name: str) -> str:
    return '"' + name.replace('"', '""') + '"'


def require_ident(value: str, label: str) -> str:
    if not IDENT.match(value):
        raise HTTPException(status_code=400, detail=f"Invalid {label}.")
    return value


def qualified_name(catalog: str, schema: str, table: str) -> str:
    return ".".join(quote_ident(part) for part in (catalog, schema, table))


def fetch_all(sql: str):
    connection = trino_connect()
    try:
        cursor = connection.cursor()
        cursor.execute(sql)
        if not cursor.description:
            return []
        return cursor.fetchall()
    except TrinoQueryError as exc:
        raise HTTPException(status_code=400, detail=exc.message) from exc
    except HTTPException:
        raise
    except Exception as exc:
        raise HTTPException(status_code=502, detail=f"Could not query Trino: {exc}") from exc
    finally:
        connection.close()


def as_text(value):
    if value is None:
        return None
    return str(value)


def json_cell(value):
    if value is None or isinstance(value, (str, int, float, bool)):
        return value
    if isinstance(value, (datetime, date)):
        return value.isoformat()
    if isinstance(value, Decimal):
        return format(value, "f")
    if isinstance(value, bytes):
        return value.hex()
    return str(value)


def clean_sql(sql: str) -> str:
    statement = sql.strip()
    if statement.endswith(";"):
        statement = statement[:-1].strip()
    if not statement:
        raise HTTPException(status_code=400, detail="Enter a SQL statement.")
    return statement


def run_sql(sql: str, limit: int):
    started = time.perf_counter()
    connection = trino_connect()
    try:
        cursor = connection.cursor()
        cursor.execute(sql)
        if not cursor.description:
            elapsed_ms = int((time.perf_counter() - started) * 1000)
            return [], [], False, elapsed_ms
        columns = [column[0] for column in cursor.description]
        rows = []
        truncated = False
        while len(rows) < limit:
            batch = cursor.fetchmany(min(200, limit - len(rows)))
            if not batch:
                break
            rows.extend(batch)
        if len(rows) == limit and cursor.fetchmany(1):
            truncated = True
        elapsed_ms = int((time.perf_counter() - started) * 1000)
        return columns, [[json_cell(value) for value in row] for row in rows], truncated, elapsed_ms
    except TrinoQueryError as exc:
        raise HTTPException(status_code=400, detail=exc.message) from exc
    except HTTPException:
        raise
    except Exception as exc:
        raise HTTPException(status_code=502, detail=f"Could not query Trino: {exc}") from exc
    finally:
        connection.close()


def list_tables():
    now = time.monotonic()
    with _cache_lock:
        cached = _table_cache["tables"]
        if cached is not None and now - _table_cache["at"] < TABLE_CACHE_SECONDS:
            return cached

    connection = trino_connect()
    try:
        cursor = connection.cursor()
        cursor.execute("SHOW CATALOGS")
        catalogs = [row[0] for row in cursor.fetchall() if row[0] not in SKIP_CATALOGS]
        tables = []
        for catalog in catalogs:
            catalog_cursor = connection.cursor()
            try:
                catalog_cursor.execute(
                    f"SELECT table_schema, table_name "
                    f"FROM {quote_ident(catalog)}.information_schema.tables "
                    f"WHERE table_schema <> 'information_schema' "
                    f"ORDER BY table_schema, table_name"
                )
                for schema, name in catalog_cursor.fetchall():
                    tables.append({"catalog": catalog, "schema": schema, "name": name})
            except TrinoQueryError:
                continue
    except TrinoQueryError as exc:
        raise HTTPException(status_code=400, detail=exc.message) from exc
    except Exception as exc:
        raise HTTPException(status_code=502, detail=f"Could not list tables: {exc}") from exc
    finally:
        connection.close()

    tables.sort(key=lambda table: (table["catalog"] != "iceberg", table["catalog"], table["schema"], table["name"]))
    with _cache_lock:
        _table_cache["at"] = time.monotonic()
        _table_cache["tables"] = tables
    return tables


@app.get("/")
def index():
    return FileResponse("static/index.html")


@app.get("/api/tables")
def tables():
    return {"tables": list_tables()}


@app.post("/api/query")
def query(body: QueryRequest):
    columns, rows, truncated, elapsed_ms = run_sql(clean_sql(body.sql), PREVIEW_LIMIT)
    return {
        "columns": columns,
        "rows": rows,
        "row_count": len(rows),
        "truncated": truncated,
        "limit": PREVIEW_LIMIT,
        "elapsed_ms": elapsed_ms,
    }


@app.get("/api/lineage")
def lineage(
    catalog: str = Query(min_length=1),
    schema: str = Query(min_length=1),
    table: str = Query(min_length=1),
):
    catalog = require_ident(catalog, "catalog")
    schema = require_ident(schema, "schema")
    table = require_ident(table, "table")
    table_name = qualified_name(catalog, schema, table)
    snapshots_name = qualified_name(catalog, schema, f"{table}$snapshots")
    log_name = qualified_name(catalog, schema, f"{table}$metadata_log_entries")

    snapshot_rows = fetch_all(
        "SELECT CAST(committed_at AS varchar), CAST(snapshot_id AS varchar), "
        "CAST(parent_id AS varchar), operation, "
        "element_at(summary, 'added-records'), "
        "element_at(summary, 'deleted-records'), "
        "element_at(summary, 'total-records') "
        f"FROM {snapshots_name} ORDER BY committed_at"
    )
    sequence_rows = fetch_all(
        "SELECT CAST(latest_snapshot_id AS varchar), CAST(max(latest_sequence_number) AS varchar) "
        f"FROM {log_name} GROUP BY 1"
    )
    sequence_by_snapshot = {snapshot_id: sequence for snapshot_id, sequence in sequence_rows}

    row_lineage_error = None
    rows_by_sequence: dict[str, dict] = {}
    try:
        lineage_rows = fetch_all(
            f"SELECT CAST({quote_ident('$last_updated_sequence_number')} AS varchar), "
            f"CAST({quote_ident('$row_id')} AS varchar) "
            f"FROM {table_name} "
            f"ORDER BY 1, 2 "
            "LIMIT 1000"
        )
    except HTTPException as exc:
        row_lineage_error = exc.detail if isinstance(exc.detail, str) else "Row lineage is not available for this table."
        lineage_rows = []
    for sequence, row_id in lineage_rows:
        bucket = rows_by_sequence.setdefault(sequence or "", {"count": 0, "ids": [], "truncated": False})
        bucket["count"] += 1
        if row_id is None:
            continue
        if len(bucket["ids"]) < 12:
            bucket["ids"].append(row_id)
        else:
            bucket["truncated"] = True

    snapshots = []
    for committed_at, snapshot_id, parent_id, operation, added, deleted, total in snapshot_rows:
        sequence = sequence_by_snapshot.get(snapshot_id)
        bucket = rows_by_sequence.get(sequence or "", {"count": 0, "ids": [], "truncated": False})
        snapshots.append({
            "committed_at": as_text(committed_at),
            "snapshot_id": as_text(snapshot_id),
            "parent_id": as_text(parent_id),
            "operation": as_text(operation),
            "sequence_number": as_text(sequence),
            "added_records": as_text(added),
            "deleted_records": as_text(deleted),
            "total_records": as_text(total),
            "current_row_count": bucket["count"],
            "row_ids": bucket["ids"],
            "row_ids_truncated": bucket["truncated"],
        })
    parent_ids = {item["parent_id"] for item in snapshots if item["parent_id"]}
    for item in snapshots:
        item["is_head"] = item["snapshot_id"] not in parent_ids

    return {
        "catalog": catalog,
        "schema": schema,
        "table": table,
        "snapshots": snapshots,
        "row_lineage_error": row_lineage_error,
    }


@app.post("/api/download")
def download(body: QueryRequest):
    columns, rows, truncated, _elapsed_ms = run_sql(clean_sql(body.sql), CSV_LIMIT)
    if not columns:
        raise HTTPException(status_code=400, detail="This statement did not return rows to download.")
    buffer = io.StringIO()
    writer = csv.writer(buffer)
    writer.writerow(columns)
    writer.writerows(rows)
    filename = "query-results.csv"
    note = "truncated" if truncated else "complete"
    return Response(
        content="\ufeff" + buffer.getvalue(),
        media_type="text/csv; charset=utf-8",
        headers={
            "Content-Disposition": f'attachment; filename="{filename}"',
            "X-Row-Count": str(len(rows)),
            "X-Export": note,
        },
    )
