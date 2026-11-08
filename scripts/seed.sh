#!/usr/bin/env bash
set -euo pipefail

TRINO=(trino --server http://trino:8080)

echo "Waiting for Trino to accept queries..."
ready=0
for _ in $(seq 1 60); do
  if "${TRINO[@]}" --execute "SELECT 1" >/dev/null 2>&1; then
    ready=1
    break
  fi
  sleep 2
done

if [[ "${ready}" -ne 1 ]]; then
  echo "Trino did not become ready in time" >&2
  exit 1
fi

echo "Creating schema and tables..."
ddl_ok=0
for _ in $(seq 1 30); do
  if "${TRINO[@]}" --file /sql/01-ddl.sql; then
    ddl_ok=1
    break
  fi
  echo "DDL failed, retrying..."
  sleep 3
done

if [[ "${ddl_ok}" -ne 1 ]]; then
  echo "Could not create the example tables" >&2
  exit 1
fi

count="$("${TRINO[@]}" --output-format CSV_UNQUOTED --execute "SELECT count(*) FROM iceberg.sales.customers" | tr -d '[:space:]')"
if [[ "${count}" == "0" ]]; then
  echo "Loading sample rows..."
  "${TRINO[@]}" --file /sql/02-seed.sql
else
  echo "Sample rows already present (${count} customers). Skipping load."
fi

echo "Ready. Query iceberg.sales.customers and iceberg.sales.orders."
