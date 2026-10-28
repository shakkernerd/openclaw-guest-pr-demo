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

test("parcelLabel accepts numeric strings without coercing one to singular", () => {
  assert.equal(parcelLabel("1"), "1 items");
});

test("parcelLabel preserves leading zeros in numeric strings", () => {
  assert.equal(parcelLabel("01"), "01 items");
});

test("parcelLabel preserves decimal notation in numeric strings", () => {
  assert.equal(parcelLabel("1.0"), "1.0 items");
});

test("parcelLabel preserves whitespace in numeric strings", () => {
  assert.equal(parcelLabel(" 1 "), " 1  items");
});
