import csv
import io
import os
import threading
import time
from datetime import date, datetime
from decimal import Decimal

import trino
from fastapi import FastAPI, HTTPException
from fastapi.responses import FileResponse, Response
from fastapi.staticfiles import StaticFiles
from pydantic import BaseModel, Field
from trino.exceptions import TrinoQueryError

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
