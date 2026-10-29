"use strict";

const { readFileSync } = require("node:fs");
const { addressDraftCodec } = require("./delivery-address-draft.js");
const { formatDeliveryAddress } = require("./delivery-address.js");

const files = process.argv.slice(2);

if (files.length === 0) {
  process.stderr.write("Usage: node format-address-drafts.js FILE...\n");
  process.exitCode = 2;
} else {
  const results = files.map((file, index) => {
    let stage = "read";
    try {
      const bytes = readFileSync(file);
      stage = "decode";
      const draft = addressDraftCodec.decode(bytes);
      stage = "format";
      const formatted = formatDeliveryAddress(draft);
      return { position: index + 1, file, ok: true, formatted };
    } catch (error) {
      return {
        position: index + 1,
        file,
        ok: false,
        error: { stage, name: error.name, message: error.message },
      };
    }
  });
  const succeeded = results.filter((result) => result.ok).length;
  const failed = files.length - succeeded;
  process.stdout.write(JSON.stringify({ total: files.length, succeeded, failed, results }) + "\n");
  process.exitCode = failed === 0 ? 0 : 1;
}
