"use strict";

const fs = require("node:fs");
const path = require("node:path");

const outputPath = path.join(__dirname, "parcel-preview.html");
const marker = "<!-- PARCEL_PREVIEW_SCRIPT -->";

// Bundle the actual CommonJS sources, not a second implementation of the helper.
// Each module gets its own local exports; nothing is installed on window.
function inlineModule(source) {
  // Refuse HTML parser control sequences rather than silently changing JS.
  if (/<\/script|<script|<!--/i.test(source)) {
    throw new Error("Inline sources must not contain HTML script delimiters.");
  }
  return `(function () {
const module = { exports: {} };
const exports = module.exports;
${source.trimEnd()}
return module.exports;
})()`;
}

function buildPreview({ template, formatterSource, appSource }) {
  if (template.split(marker).length !== 2) {
    throw new Error("The preview template must contain exactly one script marker.");
  }
  const script = `<script>
(function () {
"use strict";
const { parcelLabel } = ${inlineModule(formatterSource)};
const { mountPreview } = ${inlineModule(appSource)};
mountPreview(document, parcelLabel);
})();
</script>`;
  // A callback keeps dollar signs in source code literal during replacement.
  return template.replace(marker, () => script);
}

function readSources() {
  const read = (file) => fs.readFileSync(path.join(__dirname, file), "utf8");
  return {
    template: read("preview/parcel-preview.template.html"),
    formatterSource: read("parcel-label.js"),
    appSource: read("preview/parcel-preview.js"),
  };
}

if (require.main === module) {
  const args = process.argv.slice(2);
  if (args.length > 1 || (args.length === 1 && args[0] !== "--check")) {
    console.error("Usage: node build-parcel-preview.js [--check]");
    process.exitCode = 1;
  } else {
    const html = buildPreview(readSources());
    if (args[0] === "--check") {
      if (!fs.existsSync(outputPath) || fs.readFileSync(outputPath, "utf8") !== html) {
        console.error("parcel-preview.html is missing or stale. Run node build-parcel-preview.js.");
        process.exitCode = 1;
      } else {
        console.log("parcel-preview.html is up to date.");
      }
    } else {
      fs.writeFileSync(outputPath, html);
      console.log("Built parcel-preview.html.");
    }
  }
}

module.exports = { buildPreview, readSources };
