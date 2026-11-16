import * as duckdb from "@duckdb/duckdb-wasm";

const ANALYZE_LIMIT = 10000;
const MAX_PIVOT_COLUMNS = 24;
const MAX_REPORT_ROWS = 500;
const MAX_FILTER_VALUES = 200;
const NULL_KEY = "\u0000";
const NUMERIC = /^-?\d+(\.\d+)?$/;

const AGGREGATES = [
  ["count", "count", false],
  ["count_distinct", "distinct count", false],
  ["sum", "sum", true],
  ["avg", "average", true],
  ["min", "min", false],
  ["max", "max", false],
];

const section = document.querySelector("#analyze");
const note = document.querySelector("#analyze-note");
const moreButton = document.querySelector("#analyze-more");
const tray = document.querySelector("#analyze-columns");
const filterList = document.querySelector("#analyze-filters");
const statusNode = document.querySelector("#analyze-status");
const errorNode = document.querySelector("#analyze-error");
const sqlWrap = document.querySelector("#analyze-sql-wrap");
const sqlNode = document.querySelector("#analyze-sql");
const pivotHead = document.querySelector("#pivot thead");
const pivotBody = document.querySelector("#pivot tbody");

const layout = { filters: [], rows: [], columns: [], values: [] };
let dataset = null;
let db = null;
let conn = null;
let dbPromise = null;
let generation = 0;
let reportToken = 0;
let reportTimer = 0;
let chain = Promise.resolve();
let applied = null;

function enqueue(task) {
  const run = chain.then(task, task);
  chain = run.then(() => {}, () => {});
  return run;
}

function quoteIdent(name) {
  return `"${String(name).replaceAll('"', '""')}"`;
}

function sqlString(value) {
  return `'${String(value).replaceAll("'", "''")}'`;
}

function columnType(name) {
  return dataset?.columns.find((column) => column.name === name)?.type || "VARCHAR";
}

function uniqueNames(names) {
  const seen = new Map();
  return names.map((name) => {
    const count = seen.get(name) || 0;
    seen.set(name, count + 1);
    return count === 0 ? name : `${name} (${count + 1})`;
  });
}

function inferType(rows, index) {
  let sawValue = false;
  for (const row of rows) {
    const value = row[index];
    if (value === null || value === undefined || value === "") continue;
    sawValue = true;
    if (typeof value === "number" && Number.isFinite(value)) continue;
    if (typeof value === "string" && NUMERIC.test(value)) continue;
    return "VARCHAR";
  }
  return sawValue ? "DOUBLE" : "VARCHAR";
}

function jsonValue(value, type) {
  if (value === null || value === undefined || value === "") return null;
  if (type === "DOUBLE") {
    if (typeof value === "number" && Number.isFinite(value)) return value;
    if (typeof value === "string" && NUMERIC.test(value)) return Number(value);
    return null;
  }
  return String(value);
}

function literal(column, value) {
  if (value === null || value === undefined) return "NULL";
  if (columnType(column) === "DOUBLE") {
    const text = String(value);
    if (NUMERIC.test(text)) return text;
  }
  return sqlString(value);
}

function optionKey(value) {
  if (value === null || value === undefined) return NULL_KEY;
  return String(value);
}

function optionLabel(value) {
  if (value === null || value === undefined) return "(empty)";
  if (value === "") return "(blank)";
  return String(value);
}

function aggregateExpr(value) {
  const column = quoteIdent(value.column);
  if (value.agg === "count") return `count(${column})`;
  if (value.agg === "count_distinct") return `count(DISTINCT ${column})`;
  if (value.agg === "sum") return `sum(${column})`;
  if (value.agg === "avg") return `avg(${column})`;
  if (value.agg === "min") return `min(${column})`;
  return `max(${column})`;
}

function measureLabel(value) {
  const names = { count: "count", count_distinct: "distinct count", sum: "sum", avg: "average", min: "min", max: "max" };
  return `${names[value.agg] || value.agg} of ${value.column}`;
}

function setError(text) {
  errorNode.hidden = !text;
  errorNode.textContent = text || "";
}

function clearPivot() {
  pivotHead.replaceChildren();
  pivotBody.replaceChildren();
}

function resetLayout() {
  layout.filters = [];
  layout.rows = [];
  layout.columns = [];
  layout.values = [];
}

function sameColumns(columns) {
  if (!dataset || dataset.columns.length !== columns.length) return false;
  return dataset.columns.every((column, index) => column.name === columns[index].name);
}

function formatCell(value) {
  if (value === null || value === undefined) return null;
  if (typeof value === "bigint") return value.toString();
  if (typeof value === "number" && Number.isFinite(value)) {
    const rounded = Math.abs(value - Math.round(value)) < 1e-9 ? Math.round(value) : value;
    return rounded.toLocaleString("en-US", { maximumFractionDigits: 2 });
  }
  if (typeof value === "object") return String(value);
  return String(value);
}

function updateNote() {
  if (!dataset) {
    note.textContent = "";
    moreButton.hidden = true;
    return;
  }
  const count = dataset.rowCount.toLocaleString("en-US");
  const scope = dataset.truncated ? `the first ${count} rows` : `${count} row${dataset.rowCount === 1 ? "" : "s"}`;
  note.textContent = `Drag a column into Rows, Columns, Values, or Filters. DuckDB summarizes ${scope} in your browser.`;
  moreButton.hidden = !dataset.truncated || dataset.limit >= ANALYZE_LIMIT;
}

async function ensureDb() {
  if (!dbPromise) {
    dbPromise = startDuckDb().catch((error) => {
      dbPromise = null;
      throw error;
    });
  }
  await dbPromise;
}

async function startDuckDb() {
  const bundle = await duckdb.selectBundle(duckdb.getJsDelivrBundles());
  const workerUrl = URL.createObjectURL(
    new Blob([`importScripts("${bundle.mainWorker}");`], { type: "text/javascript" }),
  );
  const worker = new Worker(workerUrl);
  const database = new duckdb.AsyncDuckDB(new duckdb.VoidLogger(), worker);
  await database.instantiate(bundle.mainModule, bundle.pthreadWorker);
  URL.revokeObjectURL(workerUrl);
  db = database;
  conn = await db.connect();
}

async function queryRowsNow(sql) {
  const table = await conn.query(sql);
  const fields = table.schema.fields.map((field) => field.name);
  const rows = table.toArray().map((row) => {
    const record = typeof row.toJSON === "function" ? row.toJSON() : row;
    return fields.map((name) => normalizeArrow(record[name]));
  });
  return { fields, rows };
}

function normalizeArrow(value) {
  if (typeof value === "bigint") {
    const asNumber = Number(value);
    return Number.isSafeInteger(asNumber) ? asNumber : value.toString();
  }
  return value ?? null;
}

async function createResultTable(columns, records) {
  if (!records.length) {
    const defs = columns.map((column) => `${quoteIdent(column.name)} ${column.type}`).join(", ");
    await conn.query(`CREATE OR REPLACE TABLE result (${defs})`);
    return;
  }
  try { await db.dropFile("result.json"); } catch { /* The file is absent on the first load. */ }
  await db.registerFileText("result.json", JSON.stringify(records));
  const projections = columns.map((column) => (
    `TRY_CAST(${quoteIdent(column.name)} AS ${column.type}) AS ${quoteIdent(column.name)}`
  ));
  await conn.query(
    `CREATE OR REPLACE TABLE result AS SELECT ${projections.join(", ")} FROM read_json_auto('result.json')`,
  );
}

function describeColumns(payload) {
  const names = uniqueNames(payload.columns.map((name) => String(name)));
  const columns = names.map((name, index) => ({ name, type: inferType(payload.rows, index) }));
  const records = payload.rows.map((row) => {
    const record = {};
    columns.forEach((column, index) => {
      record[column.name] = jsonValue(row[index], column.type);
    });
    return record;
  });
  return { columns, records };
}

async function loadPayload(payload) {
  const token = ++generation;
  if (!payload?.columns?.length) {
    section.hidden = true;
    dataset = null;
    resetLayout();
    clearPivot();
    sqlWrap.hidden = true;
    setError("");
    return;
  }
  section.hidden = false;
  setError("");
  note.textContent = "Starting DuckDB in your browser…";
  await ensureDb();
  if (token !== generation) return;
  const described = describeColumns(payload);
  await createResultTable(described.columns, described.records);
  if (token !== generation) return;
  const keep = sameColumns(described.columns);
  dataset = {
    columns: described.columns,
    rowCount: payload.row_count,
    truncated: Boolean(payload.truncated),
    limit: payload.limit,
    sql: payload.sql || "",
  };
  if (!keep) resetLayout();
  renderBuilder();
  updateNote();
  if (keep) layout.filters.forEach((filter) => loadFilterOptions(filter));
  scheduleReport();
}

function onResults(payload) {
  if (!payload || payload === applied) return;
  applied = payload;
  enqueue(() => loadPayload(payload));
}

function predicate(filter) {
  const column = quoteIdent(filter.column);
  const type = columnType(filter.column);
  if (filter.op === "empty") return `(${column} IS NULL OR CAST(${column} AS VARCHAR) = '')`;
  if (filter.op === "contains") {
    if (!filter.text) return null;
    return `position(lower(${sqlString(filter.text)}) IN lower(CAST(${column} AS VARCHAR))) > 0`;
  }
  if (filter.op === "eq" || filter.op === "gt" || filter.op === "lt") {
    if (filter.text === "") return null;
    const operator = { eq: "=", gt: ">", lt: "<" }[filter.op];
    const expr = type === "DOUBLE" ? column : `CAST(${column} AS VARCHAR)`;
    return `${expr} ${operator} ${literal(filter.column, filter.text)}`;
  }
  if (!filter.options || filter.selected === null) return null;
  if (filter.selected.size === 0) return "FALSE";
  if (filter.selected.size === filter.options.length) return null;
  const parts = [];
  const keys = [...filter.selected];
  if (keys.includes(NULL_KEY)) parts.push(`${column} IS NULL`);
  const values = keys.filter((key) => key !== NULL_KEY);
  if (values.length) parts.push(`${column} IN (${values.map((key) => literal(filter.column, key)).join(", ")})`);
  return parts.length ? `(${parts.join(" OR ")})` : "FALSE";
}

function filteredSource() {
  const clauses = layout.filters.map(predicate).filter(Boolean);
  if (!clauses.length) return "result";
  return `(SELECT * FROM result WHERE ${clauses.join(" AND ")}) AS filtered`;
}

function measures() {
  if (layout.values.length) {
    return layout.values.map((value) => ({ ...value, label: measureLabel(value), expr: aggregateExpr(value) }));
  }
  return [{ label: "rows", expr: "count(*)", agg: "count" }];
}

function summarySql(source, group, selectedMeasures) {
  const select = [
    ...group,
    ...selectedMeasures.map((measure) => `${measure.expr} AS ${quoteIdent(measure.label)}`),
  ];
  return [
    `SELECT ${select.join(", ")}`,
    `FROM ${source}`,
    group.length ? `GROUP BY ${group.map((_, index) => index + 1).join(", ")}` : "",
    group.length ? `ORDER BY ${group.map((_, index) => index + 1).join(", ")}` : "",
    `LIMIT ${MAX_REPORT_ROWS + 1}`,
  ].filter(Boolean).join("\n");
}

async function reportSql() {
  const hasSummary = layout.rows.length || layout.columns.length || layout.values.length;
  const hasFilter = layout.filters.length > 0;
  if (!hasSummary && !hasFilter) return null;
  const source = filteredSource();
  if (!hasSummary) {
    const names = dataset.columns.map((column) => quoteIdent(column.name)).join(", ");
    return `SELECT ${names}\nFROM ${source}\nLIMIT ${MAX_REPORT_ROWS + 1}`;
  }
  const selectedMeasures = measures();
  if (!layout.columns.length) return summarySql(source, layout.rows.map(quoteIdent), selectedMeasures);

  const columnList = layout.columns.map(quoteIdent);
  const distinct = await queryRowsNow([
    `SELECT ${columnList.join(", ")}`,
    `FROM ${source}`,
    `GROUP BY ${columnList.map((_, index) => index + 1).join(", ")}`,
    `ORDER BY ${columnList.map((_, index) => index + 1).join(", ")}`,
    `LIMIT ${MAX_PIVOT_COLUMNS + 1}`,
  ].join("\n"));
  if (distinct.rows.length > MAX_PIVOT_COLUMNS) {
    throw new Error(`This pivot has more than ${MAX_PIVOT_COLUMNS} column values. Filter them, or move a column field to Rows.`);
  }
  const group = layout.rows.map(quoteIdent);
  const usedLabels = new Set(layout.rows);
  const aggregates = [];
  for (const bucket of distinct.rows) {
    const bucketLabel = bucket.map((value) => {
      if (value === null || value === undefined) return "(empty)";
      if (value === "") return "(blank)";
      return String(value);
    }).join(" · ");
    const conditions = layout.columns.map((column, index) => {
      const value = bucket[index];
      if (value === null || value === undefined) return `${quoteIdent(column)} IS NULL`;
      return `${quoteIdent(column)} = ${literal(column, value)}`;
    });
    for (const measure of selectedMeasures) {
      const base = selectedMeasures.length > 1 ? `${measure.label} · ${bucketLabel}` : bucketLabel;
      let label = base;
      let suffix = 2;
      while (usedLabels.has(label)) {
        label = `${base} (${suffix})`;
        suffix += 1;
      }
      usedLabels.add(label);
      aggregates.push({
        expr: `${measure.expr} FILTER (WHERE ${conditions.join(" AND ")})`,
        label,
      });
    }
  }
  if (!aggregates.length) return summarySql(source, group, [{ label: "rows", expr: "count(*)" }]);
  return summarySql(source, group, aggregates);
}

function dragPayload(event, payload) {
  const text = JSON.stringify(payload);
  event.dataTransfer.setData("application/x-lakehouse", text);
  event.dataTransfer.setData("text/plain", text);
  event.dataTransfer.effectAllowed = "copy";
}

function readDrag(event) {
  const raw = event.dataTransfer.getData("application/x-lakehouse") || event.dataTransfer.getData("text/plain");
  if (!raw) return null;
  try {
    const payload = JSON.parse(raw);
    if (!payload || typeof payload.column !== "string") return null;
    return payload;
  } catch {
    return { column: raw, from: "tray" };
  }
}

function removeField(from, payload) {
  if (from === "rows" || from === "columns") {
    layout[from] = layout[from].filter((name) => name !== payload.column);
    return;
  }
  if (from === "filters") {
    layout.filters = layout.filters.filter((filter) => filter.column !== payload.column);
    return;
  }
  if (from === "values" && Number.isInteger(payload.index)) layout.values.splice(payload.index, 1);
}

function placeField(zone, payload) {
  if (!dataset?.columns.some((column) => column.name === payload.column)) return;
  setError("");
  if (zone === "columns" && payload.from !== "columns" && layout.columns.length >= 2 && !layout.columns.includes(payload.column)) {
    setError("Use at most two column fields.");
    return;
  }
  if (payload.from && payload.from !== "tray") removeField(payload.from, payload);
  if (zone === "rows") layout.columns = layout.columns.filter((name) => name !== payload.column);
  if (zone === "columns") layout.rows = layout.rows.filter((name) => name !== payload.column);
  if (zone === "rows" || zone === "columns") {
    if (!layout[zone].includes(payload.column)) layout[zone].push(payload.column);
  } else if (zone === "filters") {
    if (!layout.filters.some((filter) => filter.column === payload.column)) {
      const filter = { column: payload.column, op: "in", selected: null, text: "", options: null, tooMany: false };
      layout.filters.push(filter);
      loadFilterOptions(filter);
    }
  } else if (zone === "values") {
    const agg = columnType(payload.column) === "DOUBLE" ? "sum" : "count";
    if (!layout.values.some((value) => value.column === payload.column && value.agg === agg)) {
      layout.values.push({ column: payload.column, agg });
    }
  }
  renderBuilder();
  scheduleReport();
}

function loadFilterOptions(filter) {
  enqueue(async () => {
    const token = generation;
    if (!conn || !layout.filters.includes(filter)) return;
    const result = await queryRowsNow(
      `SELECT ${quoteIdent(filter.column)} AS value, count(*) AS n FROM result GROUP BY 1 ORDER BY 2 DESC, 1 LIMIT ${MAX_FILTER_VALUES + 1}`,
    );
    if (token !== generation || !layout.filters.includes(filter)) return;
    if (result.rows.length > MAX_FILTER_VALUES) {
      filter.tooMany = true;
      filter.options = [];
      if (filter.op === "in") filter.op = "contains";
    } else {
      filter.tooMany = false;
      filter.options = result.rows.map((row) => ({
        key: optionKey(row[0]),
        label: optionLabel(row[0]),
        count: row[1],
      }));
      if (filter.selected) {
        const keys = new Set(filter.options.map((option) => option.key));
        filter.selected = new Set([...filter.selected].filter((key) => keys.has(key)));
      }
    }
    renderBuilder();
  });
}

function renderChip(parent, label, payload) {
  const chip = document.createElement("div");
  chip.className = "field-chip";
  const grip = document.createElement("span");
  grip.className = "grip";
  grip.draggable = true;
  grip.textContent = label;
  grip.addEventListener("dragstart", (event) => dragPayload(event, payload));
  chip.append(grip);
  return chip;
}

function renderBuilder() {
  tray.replaceChildren();
  for (const column of dataset?.columns || []) {
    const chip = document.createElement("div");
    chip.className = "tray-chip";
    const grip = document.createElement("span");
    grip.className = "grip";
    grip.draggable = true;
    grip.textContent = column.name;
    grip.addEventListener("dragstart", (event) => dragPayload(event, { column: column.name, from: "tray" }));
    const add = document.createElement("select");
    add.className = "add-field";
    add.setAttribute("aria-label", `Add ${column.name}`);
    for (const [value, text] of [["", "Add…"], ["rows", "Rows"], ["columns", "Columns"], ["values", "Values"], ["filters", "Filters"]]) {
      const option = document.createElement("option");
      option.value = value;
      option.textContent = text;
      add.append(option);
    }
    add.addEventListener("change", () => {
      const zone = add.value;
      add.value = "";
      if (zone) placeField(zone, { column: column.name, from: "tray" });
    });
    chip.append(grip, add);
    tray.append(chip);
  }

  for (const zone of document.querySelectorAll(".zone")) {
    const chips = zone.querySelector(".zone-chips");
    chips.replaceChildren();
    const name = zone.dataset.zone;
    const entries = name === "filters"
      ? layout.filters.map((filter) => filter.column)
      : name === "values"
        ? layout.values.map((value) => measureLabel(value))
        : layout[name];
    if (!entries.length) {
      const hint = document.createElement("p");
      hint.className = "drop-hint";
      hint.textContent = "Drop here";
      chips.append(hint);
      continue;
    }
    entries.forEach((label, index) => {
      const column = name === "filters" ? layout.filters[index].column : name === "values" ? layout.values[index].column : label;
      const payload = { column, from: name, index };
      const chip = renderChip(chips, name === "values" ? layout.values[index].column : label, payload);
      if (name === "values") {
        const select = document.createElement("select");
        select.className = "agg-select";
        select.setAttribute("aria-label", `Aggregation for ${column}`);
        const numeric = columnType(column) === "DOUBLE";
        for (const [agg, text, numericOnly] of AGGREGATES) {
          if (numericOnly && !numeric) continue;
          const option = document.createElement("option");
          option.value = agg;
          option.textContent = text;
          select.append(option);
        }
        select.value = layout.values[index].agg;
        select.addEventListener("change", () => {
          layout.values[index].agg = select.value;
          renderBuilder();
          scheduleReport();
        });
        select.addEventListener("mousedown", (event) => event.stopPropagation());
        chip.append(select);
      }
      const remove = document.createElement("button");
      remove.type = "button";
      remove.className = "chip-remove";
      remove.textContent = "×";
      remove.setAttribute("aria-label", `Remove ${column}`);
      remove.addEventListener("click", () => {
        removeField(name, payload);
        renderBuilder();
        scheduleReport();
      });
      chip.append(remove);
      chips.append(chip);
    });
  }

  filterList.replaceChildren();
  for (const filter of layout.filters) {
    const editor = document.createElement("div");
    editor.className = "filter-editor";
    const title = document.createElement("h3");
    title.textContent = filter.column;
    const controls = document.createElement("div");
    controls.className = "filter-controls";
    const operator = document.createElement("select");
    operator.className = "filter-op";
    operator.setAttribute("aria-label", `Filter ${filter.column}`);
    const operators = [["in", "is any of"], ["contains", "contains"], ["eq", "equals"], ["gt", "greater than"], ["lt", "less than"], ["empty", "is empty"]];
    for (const [value, text] of operators) {
      const option = document.createElement("option");
      option.value = value;
      option.textContent = text;
      operator.append(option);
    }
    operator.value = filter.op;
    operator.addEventListener("change", () => {
      filter.op = operator.value;
      renderBuilder();
      scheduleReport();
    });
    controls.append(operator);
    const text = document.createElement("input");
    text.className = "filter-text";
    text.type = "text";
    text.value = filter.text;
    text.placeholder = "Value";
    text.setAttribute("aria-label", `${filter.column} filter value`);
    text.hidden = filter.op === "in" || filter.op === "empty";
    text.addEventListener("input", () => {
      filter.text = text.value;
      scheduleReport();
    });
    controls.append(text);
    editor.append(title, controls);
    if (filter.op === "in") {
      const values = document.createElement("div");
      values.className = "filter-values";
      if (!filter.options) {
        const waiting = document.createElement("p");
        waiting.className = "muted";
        waiting.textContent = filter.tooMany ? "Too many values to list. Use contains or a comparison." : "Loading values…";
        values.append(waiting);
      } else {
        for (const option of filter.options) {
          const label = document.createElement("label");
          const box = document.createElement("input");
          box.type = "checkbox";
          box.checked = filter.selected === null || filter.selected.has(option.key);
          box.addEventListener("change", () => {
            if (filter.selected === null) filter.selected = new Set(filter.options.map((item) => item.key));
            if (box.checked) filter.selected.add(option.key);
            else filter.selected.delete(option.key);
            scheduleReport();
          });
          const name = document.createElement("span");
          name.textContent = option.label;
          const count = document.createElement("span");
          count.className = "count";
          count.textContent = formatCell(option.count) ?? "";
          label.append(box, name, count);
          values.append(label);
        }
      }
      editor.append(values);
    }
    filterList.append(editor);
  }
}

function wireZones() {
  for (const zone of document.querySelectorAll(".zone")) {
    zone.addEventListener("dragover", (event) => {
      event.preventDefault();
      zone.classList.add("drag-over");
    });
    zone.addEventListener("dragleave", () => zone.classList.remove("drag-over"));
    zone.addEventListener("drop", (event) => {
      event.preventDefault();
      zone.classList.remove("drag-over");
      const payload = readDrag(event);
      if (payload) placeField(zone.dataset.zone, payload);
    });
  }
}

function renderReportTable(fields, rows) {
  const shown = rows.slice(0, MAX_REPORT_ROWS);
  const truncated = rows.length > MAX_REPORT_ROWS;
  clearPivot();
  const head = document.createElement("tr");
  for (const field of fields) {
    const cell = document.createElement("th");
    cell.textContent = field;
    head.append(cell);
  }
  pivotHead.append(head);
  for (const row of shown) {
    const tr = document.createElement("tr");
    for (const value of row) {
      const cell = document.createElement("td");
      const text = formatCell(value);
      if (text === null) {
        cell.textContent = "null";
        cell.className = "null";
      } else {
        cell.textContent = text;
      }
      tr.append(cell);
    }
    pivotBody.append(tr);
  }
  return { shown: shown.length, truncated };
}

function scheduleReport() {
  window.clearTimeout(reportTimer);
  const token = ++reportToken;
  reportTimer = window.setTimeout(() => {
    enqueue(async () => {
      if (token !== reportToken) return;
      await renderReport(token);
    });
  }, 80);
}

async function renderReport(token) {
  if (!dataset || !conn) return;
  const hasSummary = layout.rows.length || layout.columns.length || layout.values.length || layout.filters.length;
  if (!hasSummary) {
    clearPivot();
    sqlWrap.hidden = true;
    statusNode.textContent = "Drag a column into Rows, Columns, or Values.";
    return;
  }
  statusNode.textContent = "Summarizing…";
  setError("");
  try {
    const sql = await reportSql();
    if (token !== reportToken) return;
    if (!sql) {
      clearPivot();
      sqlWrap.hidden = true;
      statusNode.textContent = "";
      return;
    }
    const result = await queryRowsNow(sql);
    if (token !== reportToken) return;
    const rendered = renderReportTable(result.fields, result.rows);
    sqlNode.textContent = sql;
    sqlWrap.hidden = false;
    const rows = `${rendered.shown} row${rendered.shown === 1 ? "" : "s"}`;
    statusNode.textContent = rendered.truncated ? `${rows} (limited to ${MAX_REPORT_ROWS})` : rows;
  } catch (error) {
    if (token !== reportToken) return;
    clearPivot();
    sqlWrap.hidden = true;
    statusNode.textContent = "";
    setError(error?.message || "DuckDB could not build this report.");
  }
}

moreButton.addEventListener("click", () => {
  const sql = dataset?.sql;
  if (!sql) return;
  moreButton.disabled = true;
  note.textContent = "Loading up to 10,000 rows…";
  enqueue(async () => {
    try {
      const response = await fetch("/api/query", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ sql, limit: ANALYZE_LIMIT }),
      });
      const payload = await response.json();
      if (!response.ok) throw new Error(payload.detail || "Could not load more rows.");
      payload.sql = sql;
      applied = null;
      await loadPayload(payload);
    } catch (error) {
      setError(error.message);
      updateNote();
    } finally {
      moreButton.disabled = false;
    }
  });
});

wireZones();
document.addEventListener("lakehouse-results", (event) => onResults(event.detail));
if (window.__lakehouseResult) onResults(window.__lakehouseResult);
