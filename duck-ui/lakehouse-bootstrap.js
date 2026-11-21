// Attaches the local Iceberg REST catalog to the in-browser DuckDB.
// One statement per query(): this WASM build rejects multi-statement SQL.
(function () {
  var host = location.hostname || "localhost";
  var secretSql =
    "CREATE OR REPLACE SECRET lakehouse_s3 (" +
    "TYPE S3, " +
    "KEY_ID 'lakehouse', " +
    "SECRET 'lakehouse12345', " +
    "ENDPOINT '" + host + ":8333', " +
    "URL_STYLE 'path', " +
    "USE_SSL false, " +
    "REGION 'us-east-1'" +
    ")";
  var attachSql =
    "ATTACH OR REPLACE 'warehouse' AS iceberg (" +
    "TYPE ICEBERG, " +
    "ENDPOINT 'http://" + host + ":8181', " +
    "AUTHORIZATION_TYPE 'none', " +
    "ACCESS_DELEGATION_MODE 'none'" +
    ")";

  function mark(status, detail) {
    try {
      sessionStorage.setItem(
        "lakehouse-catalog",
        JSON.stringify({ status: status, detail: String(detail || "") })
      );
    } catch (ignored) {}
  }

  async function run(connection, sql) {
    await connection.query(sql);
  }

  globalThis.__lakehouseAttachIceberg = async function (connection) {
    if (!connection || typeof connection.query !== "function") {
      mark("failed", "DuckDB connection is not ready");
      console.error("Lakehouse: DuckDB connection is not ready");
      return;
    }
    var steps = [
      "INSTALL httpfs",
      "LOAD httpfs",
      "INSTALL iceberg",
      "LOAD iceberg",
      secretSql,
      attachSql,
    ];
    for (var i = 0; i < steps.length; i++) {
      try {
        await run(connection, steps[i]);
      } catch (error) {
        mark("failed", steps[i] + " :: " + (error && error.message ? error.message : error));
        console.error("Lakehouse catalog attach failed:", steps[i], error);
        return;
      }
    }
    mark("attached", "iceberg");
    console.info("Lakehouse catalog attached as iceberg");
  };
})();
