#!/usr/bin/env node
"use strict";

const fs = require("node:fs");
const { renderBrief, BriefError } = require("../lib/review-handoff.js");

const HELP = [
  "Usage: node bin/review-handoff.js --selection FILE --comparison FILE [--format markdown|json] [--output FILE]",
  "",
  "Build a review-only follow-up brief after validating the exact comparison bytes.",
  "Default format: markdown. Default destination: stdout.",
  "--output creates a NEW file exclusively; existing paths are never overwritten.",
  "Output directories must exist. Never redirect stdout over either source input.",
  "--help shows this help (alone). No dependencies or network access."
].join("\n") + "\n";

function usage(message) { throw new BriefError("USAGE", message); }
function parseArguments(args) {
  if (args.length === 1 && args[0] === "--help") return { help: true };
  const options = Object.create(null);
  const allowed = new Set(["--selection", "--comparison", "--format", "--output"]);
  for (let index = 0; index < args.length; index += 2) {
    const flag = args[index];
    if (!allowed.has(flag)) usage("Unknown option: " + JSON.stringify(flag));
    if (Object.hasOwn(options, flag)) usage("Duplicate option: " + flag);
    const value = args[index + 1];
    if (!value || value.startsWith("--")) usage("Missing value for " + flag);
    options[flag] = value;
  }
  for (const key of ["--selection", "--comparison"]) if (!options[key]) usage("Required option: " + key);
  if (options["--format"] && !["markdown", "json"].includes(options["--format"])) usage("--format must be markdown or json");
  return options;
}

function readInput(path, label) {
  try {
    if (!fs.statSync(path).isFile()) throw new Error("not a regular file");
    return fs.readFileSync(path);
  } catch (error) {
    throw new BriefError("INPUT_READ", "Cannot read " + label + " " + JSON.stringify(path) + ": " + (error.code ?? error.message));
  }
}

function main(args) {
  try {
    const options = parseArguments(args);
    if (options.help) { process.stdout.write(HELP); return; }
    const selection = readInput(options["--selection"], "selection");
    const comparison = readInput(options["--comparison"], "comparison");
    const output = renderBrief(selection, comparison, options["--format"] ?? "markdown");
    if (options["--output"]) {
      try { fs.writeFileSync(options["--output"], output, { encoding: "utf8", flag: "wx" }); }
      catch (error) {
        throw new BriefError("OUTPUT_WRITE", "Cannot create output " + JSON.stringify(options["--output"]) + ": " +
          (error.code === "EEXIST" ? "path already exists; refusing to overwrite" : error.code ?? error.message));
      }
    } else process.stdout.write(output);
  } catch (error) {
    // JSON-quote the message so input-controlled control characters cannot
    // inject terminal escapes or forge extra diagnostic lines.
    process.stderr.write("review-handoff: " + (error.code ?? "ERROR") + ": " + JSON.stringify(error.message) + "\n");
    process.exitCode = error.code === "USAGE" ? 2 : 1;
  }
}

if (require.main === module) {
  process.stdout.on("error", error => {
    process.stderr.write("review-handoff: OUTPUT_WRITE: " + JSON.stringify(error.code ?? error.message) + "\n");
    process.exitCode = 1;
  });
  main(process.argv.slice(2));
}

module.exports = { main };
