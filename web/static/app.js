const sqlInput = document.querySelector("#sql");
const form = document.querySelector("#query-form");
const runButton = document.querySelector("#run");
const downloadButton = document.querySelector("#download");
const statusNode = document.querySelector("#status");
const messageNode = document.querySelector("#message");
const tableHead = document.querySelector("#results thead");
const tableBody = document.querySelector("#results tbody");
const tableList = document.querySelector("#table-list");
const filterInput = document.querySelector("#filter");

let tables = [];
let activeSql = "";

function quoteIdent(name) {
  return `"${String(name).replaceAll('"', '""')}"`;
}

function selectSql(table) {
  return `SELECT *\nFROM ${quoteIdent(table.catalog)}.${quoteIdent(table.schema)}.${quoteIdent(table.name)}\nLIMIT 100`;
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
        for (const other of tableList.querySelectorAll(".table-button")) {
          other.removeAttribute("aria-current");
        }
        button.setAttribute("aria-current", "true");
        runQuery(sqlInput.value);
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
  } catch (error) {
    tableList.textContent = error.message;
  }
}

loadTables();
