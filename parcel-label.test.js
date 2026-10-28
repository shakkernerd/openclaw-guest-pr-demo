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

test("parcelLabel formats the string zero as plural", () => {
  assert.equal(parcelLabel("0"), "0 items");
});

test("parcelLabel formats the string one as singular", () => {
  assert.equal(parcelLabel("1"), "1 item");
});

test("parcelLabel formats the string three as plural", () => {
  assert.equal(parcelLabel("3"), "3 items");
});

test("parcelLabel does not coerce other values to one", () => {
  for (const count of ["01", "1.0", " 1 ", true]) {
    assert.equal(parcelLabel(count), `${count} items`);
  }
});
