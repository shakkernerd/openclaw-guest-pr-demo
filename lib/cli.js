"use strict";

const { parseArgs } = require("node:util");
const { readJsonFile } = require("./input.js");
const { createManifest } = require("./manifest.js");
const { formatReport } = require("./format.js");
const { ManifestError } = require("./errors.js");

const HELP = `Donation stockroom dispatch manifest (Node.js 22+)

Usage:
  node bin/dispatch-manifest.js --catalogue <file.json> --orders <file.json> [--stock <file.json>] [--format text|json]

Options:
  --catalogue FILE  JSON SKU catalogue
  --orders FILE     JSON orders to dispatch
  --stock FILE      Optional on-hand JSON snapshot; omitted SKUs count as zero
  --format FORMAT   text (default) or json (schemaVersion 1, including carton labels)
  --help, -h        Show this help

Writes only the requested result to stdout. Errors go to stderr.
One carton per order; no carton-capacity calculation or stock reservation/allocation.
With --stock, shortages still produce a complete report on stdout (including JSON).
Exit codes: 0 success/help, 2 usage, 3 input/read/validation, 1 output/internal failure.
            4 stock shortage: do not pack; resolve shortages and rerun.
`;

function parseArguments(args) {
  let parsed;
  try {
    parsed = parseArgs({
      args,
      strict: true,
      allowPositionals: false,
      tokens: true,
      options: {
        catalogue: { type: "string" },
        orders: { type: "string" },
        stock: { type: "string" },
        format: { type: "string", default: "text" },
        help: { type: "boolean", short: "h" },
      },
    });
  } catch (error) {
    throw new ManifestError("USAGE", `${error.message} Run with --help for usage.`, 2);
  }
  const seen = new Set();
  for (const token of parsed.tokens) {
    if (token.kind !== "option") continue;
    if (seen.has(token.name)) throw new ManifestError("USAGE", `Option --${token.name} must only be supplied once.`, 2);
    seen.add(token.name);
  }
  const values = parsed.values;
  if (values.help) return values;
  if (!values.catalogue?.trim() || !values.orders?.trim()) {
    throw new ManifestError("USAGE", "Both --catalogue and --orders are required. Run with --help for usage.", 2);
  }
  if (!["text", "json"].includes(values.format)) {
    throw new ManifestError("USAGE", "--format must be text or json.", 2);
  }
  if (values.stock !== undefined && !values.stock.trim()) {
    throw new ManifestError("USAGE", "--stock requires a non-empty file path.", 2);
  }
  return values;
}

function main(args) {
  process.stdout.on("error", (error) => {
    process.stderr.write(`dispatch-manifest: OUTPUT_WRITE_FAILED: Cannot write output (${error.code || "write error"}).\n`);
    process.exitCode = 1;
  });
  try {
    const options = parseArguments(args);
    if (options.help) {
      process.stdout.write(HELP);
      return;
    }
    // Build the entire validated result before emitting any output.
    const manifest = createManifest(
      readJsonFile(options.catalogue),
      readJsonFile(options.orders),
      options.stock === undefined ? undefined : readJsonFile(options.stock),
    );
    const output = options.format === "json"
      ? `${JSON.stringify(manifest, null, 2)}\n`
      : formatReport(manifest);
    // Set this before writing so an output failure can override shortage status.
    process.exitCode = manifest.stockCheck?.hasShortages ? 4 : 0;
    process.stdout.write(output);
  } catch (error) {
    const known = error instanceof ManifestError;
    const code = known ? error.code : "INTERNAL_ERROR";
    const message = known ? error.message : "Unexpected failure while generating the manifest.";
    process.stderr.write(`dispatch-manifest: ${code}: ${message}\n`);
    process.exitCode = known ? error.exitCode : 1;
  }
}

module.exports = { main };
