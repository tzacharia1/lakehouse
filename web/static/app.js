const sqlInput = document.querySelector("#sql");
const sqlGutter = document.querySelector("#sql-gutter");
const form = document.querySelector("#query-form");
const runButton = document.querySelector("#run");
const downloadButton = document.querySelector("#download");
const statusNode = document.querySelector("#status");
const messageNode = document.querySelector("#message");
const tableHead = document.querySelector("#results thead");
const tableBody = document.querySelector("#results tbody");
const tableList = document.querySelector("#table-list");
const filterInput = document.querySelector("#filter");
const lineageSection = document.querySelector("#lineage");
const lineageTitle = document.querySelector("#lineage-title");
const lineageNote = document.querySelector("#lineage-note");
const lineageTrack = document.querySelector("#lineage-track");

let tables = [];
let activeSql = "";

function quoteIdent(name) {
  return `"${String(name).replaceAll('"', '""')}"`;
}

function selectSql(table) {
  return `SELECT *\nFROM ${quoteIdent(table.catalog)}.${quoteIdent(table.schema)}.${quoteIdent(table.name)}\nLIMIT 100`;
}

function snapshotSql(table, snapshotId) {
  return `SELECT *\nFROM ${quoteIdent(table.catalog)}.${quoteIdent(table.schema)}.${quoteIdent(table.name)}\nFOR VERSION AS OF ${snapshotId}`;
}

function syncLineNumbers() {
  const count = Math.max(sqlInput.value.split("\n").length, 1);
  const numbers = Array.from({ length: count }, (_, index) => String(index + 1)).join("\n");
  if (sqlGutter.textContent !== numbers) sqlGutter.textContent = numbers;
  sqlGutter.scrollTop = sqlInput.scrollTop;
}

function setMessage(text, isError) {
  if (!text) {
    messageNode.hidden = true;
    messageNode.textContent = "";
    messageNode.className = "message";
    return;
  }
  messageNode.hidden = false;
  messageNode.textContent = text;
  messageNode.className = isError ? "message error" : "message";
}

function renderResults(payload) {
  tableHead.replaceChildren();
  tableBody.replaceChildren();
  if (!payload.columns.length) {
    statusNode.textContent = `Finished in ${payload.elapsed_ms} ms. No result set.`;
    return;
  }

  const headRow = document.createElement("tr");
  for (const column of payload.columns) {
    const cell = document.createElement("th");
    cell.textContent = column;
    headRow.append(cell);
  }
  tableHead.append(headRow);

  for (const row of payload.rows) {
    const tr = document.createElement("tr");
    for (const value of row) {
      const cell = document.createElement("td");
      if (value === null) {
        cell.textContent = "null";
        cell.className = "null";
      } else {
        cell.textContent = String(value);
      }
      tr.append(cell);
    }
    tableBody.append(tr);
  }

  const shown = payload.truncated
    ? `Showing ${payload.row_count} rows (limited to ${payload.limit})`
    : `${payload.row_count} row${payload.row_count === 1 ? "" : "s"}`;
  statusNode.textContent = `${shown} · ${payload.elapsed_ms} ms`;
}

async function runQuery(sql) {
  const statement = sql.trim();
  if (!statement) {
    setMessage("Enter a SQL statement.", true);
    return;
  }
  runButton.disabled = true;
  downloadButton.disabled = true;
  statusNode.textContent = "Running…";
  setMessage("");
  try {
    const response = await fetch("/api/query", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ sql: statement }),
    });
    const payload = await response.json();
    if (!response.ok) {
      tableHead.replaceChildren();
      tableBody.replaceChildren();
      statusNode.textContent = "";
      setMessage(payload.detail || "Query failed.", true);
      return;
    }
    activeSql = statement;
    renderResults(payload);
    downloadButton.disabled = payload.columns.length === 0;
  } catch (error) {
    statusNode.textContent = "";
    setMessage(error.message, true);
  } finally {
    runButton.disabled = false;
  }
}

function addText(parent, tag, className, text) {
  const node = document.createElement(tag);
  if (className) node.className = className;
  node.textContent = text;
  parent.append(node);
  return node;
}

function renderLineage(payload) {
  lineageSection.hidden = false;
  lineageTitle.textContent = `Lineage · ${payload.catalog}.${payload.schema}.${payload.table}`;
  lineageNote.textContent = payload.row_lineage_error
    ? "Click a snapshot to query it. Row ids are unavailable until the table is Iceberg format version 3 and a new commit is written."
    : "Click a snapshot to run SELECT * FOR VERSION AS OF that snapshot. Chips are current rows last changed there.";
  lineageTrack.replaceChildren();
  if (!payload.snapshots.length) {
    addText(lineageTrack, "p", "muted", "This table has no snapshots yet.");
    return;
  }
  payload.snapshots.forEach((snapshot, index) => {
    if (index > 0) addText(lineageTrack, "span", "lineage-arrow", "→");
    const snapshotId = String(snapshot.snapshot_id ?? "");
    const card = document.createElement("button");
    card.type = "button";
    card.className = snapshot.is_head ? "lineage-card head" : "lineage-card";
    card.dataset.snapshotId = snapshotId;
    const operation = snapshot.operation || "snapshot";
    card.setAttribute("aria-pressed", "false");
    card.setAttribute("aria-label", `Query ${operation} snapshot ${snapshotId}`);
    addText(card, "span", "op", operation);
    addText(card, "p", "when", snapshot.committed_at || "");
    const sequence = snapshot.sequence_number ? `sequence ${snapshot.sequence_number}` : "sequence unknown";
    const totals = [
      sequence,
      snapshot.added_records ? `+${snapshot.added_records} added` : "",
      snapshot.deleted_records ? `−${snapshot.deleted_records} deleted` : "",
      snapshot.total_records ? `${snapshot.total_records} total` : "",
    ].filter(Boolean).join(" · ");
    addText(card, "p", "meta", totals);
    addText(
      card,
      "p",
      "rows",
      snapshot.current_row_count
        ? `${snapshot.current_row_count} current row${snapshot.current_row_count === 1 ? "" : "s"}`
        : "No current rows",
    );
    if (snapshot.row_ids.length) {
      const list = document.createElement("ul");
      list.className = "row-ids";
      for (const rowId of snapshot.row_ids) addText(list, "li", "", rowId);
      if (snapshot.row_ids_truncated) addText(list, "li", "", "…");
      card.append(list);
    }
    card.addEventListener("click", () => {
      if (!/^\d+$/.test(snapshotId)) {
        setMessage("This snapshot id cannot be queried.", true);
        return;
      }
      sqlInput.value = snapshotSql(
        { catalog: payload.catalog, schema: payload.schema, name: payload.table },
        snapshotId,
      );
      syncLineNumbers();
      for (const other of lineageTrack.querySelectorAll(".lineage-card")) {
        other.setAttribute("aria-pressed", "false");
      }
      card.setAttribute("aria-pressed", "true");
      runQuery(sqlInput.value);
    });
    lineageTrack.append(card);
  });
}

async function loadLineage(table) {
  lineageSection.hidden = false;
  lineageTitle.textContent = `Lineage · ${table.catalog}.${table.schema}.${table.name}`;
  lineageNote.textContent = "Loading snapshot history…";
  lineageTrack.replaceChildren();
  const params = new URLSearchParams({
    catalog: table.catalog,
    schema: table.schema,
    table: table.name,
  });
  try {
    const response = await fetch(`/api/lineage?${params}`);
    const payload = await response.json();
    if (!response.ok) {
      lineageNote.textContent = payload.detail || "Could not load lineage.";
      return;
    }
    renderLineage(payload);
  } catch (error) {
    lineageNote.textContent = error.message;
  }
}

function renderTables() {
  const query = filterInput.value.trim().toLowerCase();
  tableList.replaceChildren();
  const groups = new Map();
  for (const table of tables) {
    const label = `${table.schema}.${table.name}`;
    const haystack = `${table.catalog}.${label}`.toLowerCase();
    if (query && !haystack.includes(query)) continue;
    const key = `${table.catalog}.${table.schema}`;
    if (!groups.has(key)) groups.set(key, []);
    groups.get(key).push(table);
  }
  if (groups.size === 0) {
    const empty = document.createElement("p");
    empty.className = "muted";
    empty.textContent = tables.length ? "No tables match that filter." : "No tables found.";
    tableList.append(empty);
    return;
  }
  for (const [key, group] of groups) {
    const section = document.createElement("section");
    const title = document.createElement("h2");
    title.className = "group-title";
    title.textContent = key;
    section.append(title);
    for (const table of group) {
      const button = document.createElement("button");
      button.type = "button";
      button.className = "table-button";
      button.textContent = table.name;
      button.dataset.sql = selectSql(table);
      if (button.dataset.sql === sqlInput.value) button.setAttribute("aria-current", "true");
      button.addEventListener("click", () => {
        sqlInput.value = button.dataset.sql;
        syncLineNumbers();
        for (const other of tableList.querySelectorAll(".table-button")) {
          other.removeAttribute("aria-current");
        }
        button.setAttribute("aria-current", "true");
        runQuery(sqlInput.value);
        loadLineage(table);
      });
      section.append(button);
    }
    tableList.append(section);
  }
}

form.addEventListener("submit", (event) => {
  event.preventDefault();
  runQuery(sqlInput.value);
});

sqlInput.addEventListener("keydown", (event) => {
  if ((event.metaKey || event.ctrlKey) && event.key === "Enter") {
    event.preventDefault();
    runQuery(sqlInput.value);
  }
});

sqlInput.addEventListener("input", syncLineNumbers);
sqlInput.addEventListener("scroll", syncLineNumbers);
syncLineNumbers();

downloadButton.addEventListener("click", async () => {
  const statement = (activeSql || sqlInput.value).trim();
  if (!statement) return;
  downloadButton.disabled = true;
  statusNode.textContent = "Preparing CSV…";
  try {
    const response = await fetch("/api/download", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ sql: statement }),
    });
    if (!response.ok) {
      const payload = await response.json();
      setMessage(payload.detail || "Download failed.", true);
      return;
    }
    const blob = await response.blob();
    const link = document.createElement("a");
    link.href = URL.createObjectURL(blob);
    link.download = "query-results.csv";
    link.click();
    URL.revokeObjectURL(link.href);
    const count = response.headers.get("X-Row-Count");
    const truncated = response.headers.get("X-Export") === "truncated";
    statusNode.textContent = truncated
      ? `Downloaded ${count} rows (CSV limited to 10000).`
      : `Downloaded ${count} rows.`;
  } catch (error) {
    setMessage(error.message, true);
  } finally {
    downloadButton.disabled = false;
  }
});

filterInput.addEventListener("input", renderTables);

async function loadTables() {
  try {
    const response = await fetch("/api/tables");
    const payload = await response.json();
    if (!response.ok) {
      tableList.textContent = payload.detail || "Could not load tables.";
      return;
    }
    tables = payload.tables;
    renderTables();
    runQuery(sqlInput.value);
    const customers = tables.find((table) => table.catalog === "iceberg" && table.schema === "sales" && table.name === "customers");
    if (customers) loadLineage(customers);
  } catch (error) {
    tableList.textContent = error.message;
  }
}

loadTables();
