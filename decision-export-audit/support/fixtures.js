"use strict";
const { readFileSync } = require("node:fs");
const { resolve } = require("node:path");
const fixture = resolve(__dirname, "../test/fixtures/review-decisions-review.json");
const digest = "1d3119bcc05c601dcae42c79cd1e22d0765300d2ce90138b8e4d47483ee7151d";
const bytes = () => readFileSync(fixture);
const baseline = () => JSON.parse(bytes().toString("utf8"));
function freeze(value) {
  if (value && typeof value === "object") {
    Object.values(value).forEach(freeze);
    Object.freeze(value);
  }
  return value;
}
module.exports = { fixture, digest, bytes, baseline, freeze };
