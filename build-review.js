"use strict";

// Produce one file for opaque-origin previews and offline use: no asset requests.
const fs = require("node:fs");
const path = require("node:path");

function build() {
  const source = name => fs.readFileSync(path.join(__dirname, name), "utf8");
  return source("review-template.html").replace("<!-- REVIEW_SCRIPTS -->", () =>
    ["review-state.js", "review-app.js"].map(name =>
      "<script>\n" + source(name).replace(/<\/script/gi, "<\\/script") + "\n</script>").join("\n"));
}

if (require.main === module) {
  const output = path.join(__dirname, "index.html");
  const html = build();
  if (process.argv.includes("--check")) {
    if (!fs.existsSync(output) || fs.readFileSync(output, "utf8") !== html) {
      console.error("index.html is stale. Run: node build-review.js");
      process.exitCode = 1;
    } else console.log("Offline preview matches its sources.");
  } else {
    fs.writeFileSync(output, html);
    console.log("Built index.html (self-contained offline preview).");
  }
}

module.exports = { build };
