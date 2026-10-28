"use strict";

const test = require("node:test");
const assert = require("node:assert/strict");
const { parcelLabel } = require("./parcel-label.js");

test("parcelLabel formats zero parcels as plural", () => {
  assert.equal(parcelLabel(0), "0 items");
});

test("parcelLabel formats one parcel as singular", () => {
  assert.equal(parcelLabel(1), "1 item");
});

test("parcelLabel formats three parcels as plural", () => {
  assert.equal(parcelLabel(3), "3 items");
});

test("parcelLabel keeps string one plural without numeric coercion", () => {
  assert.equal(parcelLabel("1"), "1 items");
});
