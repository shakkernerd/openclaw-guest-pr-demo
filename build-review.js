"use strict";

// Produce self-contained pages for opaque-origin previews and offline use.
const fs = require("node:fs");
const path = require("node:path");

function build(page = "desk") {
  const analysis = page === "analysis";
  const source = name => fs.readFileSync(path.join(__dirname, name), "utf8");
  return source(analysis ? "review-analysis-template.html" : "review-template.html").replace("<!-- REVIEW_SCRIPTS -->", () =>
    (analysis ? ["review-state.js", "review-analysis.js", "review-analysis-app.js"]
      : ["review-state.js", "review-app.js"]).map(name =>
      "<script>\n" + source(name).replace(/<\/script/gi, "<\\/script") + "\n</script>").join("\n"));
}

if (require.main === module) {
  for (const [page, filename] of [["desk", "index.html"], ["analysis", "review-analysis.html"]]) {
    const output = path.join(__dirname, filename);
    const html = build(page);
    if (process.argv.includes("--check")) {
      if (!fs.existsSync(output) || fs.readFileSync(output, "utf8") !== html) {
        console.error(filename + " is stale. Run: node build-review.js");
        process.exitCode = 1;
      } else console.log(filename + " matches its sources.");
    } else {
      fs.writeFileSync(output, html);
      console.log("Built " + filename + " (self-contained offline preview).");
    }
  }
}

module.exports = { build };
