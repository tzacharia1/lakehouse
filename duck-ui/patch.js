const fs = require("fs");
const path = require("path");

const assets = "/app/dist/assets";
const engines = fs.readdirSync(assets).filter((name) => {
  return name.startsWith("engine-") && name.endsWith(".js");
});
if (engines.length !== 1) {
  console.error("expected one Duck-UI engine bundle, found", engines);
  process.exit(1);
}

const enginePath = path.join(assets, engines[0]);
const needle = "return await Vt(a,t),{db:a,connection:t}";
const hooked =
  "return await Vt(a,t),await globalThis.__lakehouseAttachIceberg?.(t),{db:a,connection:t}";
let source = fs.readFileSync(enginePath, "utf8");
if (source.includes(hooked)) {
  console.log("engine already attaches the lakehouse catalog");
} else if (!source.includes(needle)) {
  console.error("engine hook point is missing from", enginePath);
  process.exit(1);
} else {
  source = source.replace(needle, hooked);
  fs.writeFileSync(enginePath, source);
  console.log("engine attaches the lakehouse catalog:", enginePath);
}

const indexPath = "/app/dist/index.html";
const tag = '<script src="/lakehouse-bootstrap.js"></script>';
let html = fs.readFileSync(indexPath, "utf8");
if (html.includes(tag)) {
  console.log("bootstrap script already in index.html");
} else if (!html.includes("</body>")) {
  console.error("index.html has no </body>");
  process.exit(1);
} else {
  html = html.replace("</body>", "    " + tag + "\n  </body>");
  fs.writeFileSync(indexPath, html);
  console.log("inserted lakehouse bootstrap script");
}
