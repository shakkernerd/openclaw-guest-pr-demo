"use strict";

const test = require("node:test");
const assert = require("node:assert/strict");
const { formatDeliveryAddress } = require("./delivery-address.js");

test("formatDeliveryAddress preserves line order with LF and no trailing newline", () => {
  assert.equal(
    formatDeliveryAddress(["Zoë Martin", "12 rue des Écoles", "75005 Paris", "France"]),
    "Zoë Martin\n12 rue des Écoles\n75005 Paris\nFrance",
  );
});

test("formatDeliveryAddress accepts a single incomplete line without verification", () => {
  assert.equal(formatDeliveryAddress(["Not a verified address"]), "Not a verified address");
});

test("formatDeliveryAddress preserves Unicode, whitespace, and duplicates exactly", () => {
  const lines = ["  Zoe\u0308 李 📦  ", "\tشارع النيل\u00a0", "Straße 5", "Straße 5"];
  const expected = "  Zoe\u0308 李 📦  \n\tشارع النيل\u00a0\nStraße 5\nStraße 5";
  const actual = formatDeliveryAddress(lines);
  assert.equal(actual, expected);
  assert.deepEqual(Buffer.from(actual, "utf8"), Buffer.from(expected, "utf8"));
});

test("formatDeliveryAddress leaves HTML-like caller text unescaped", () => {
  assert.equal(formatDeliveryAddress(["<recipient> & Co."]), "<recipient> & Co.");
});

test("formatDeliveryAddress does not mutate input and accepts frozen arrays", () => {
  const lines = ["Recipient", "Street", "Country"];
  const before = lines.slice();
  assert.equal(formatDeliveryAddress(lines), "Recipient\nStreet\nCountry");
  assert.deepEqual(lines, before);
  assert.equal(formatDeliveryAddress(Object.freeze(lines)), "Recipient\nStreet\nCountry");
  assert.deepEqual(lines, before);
});

test("formatDeliveryAddress rejects nonarrays with TypeError", () => {
  for (const value of [undefined, null, "Recipient", 1, true, {}, { 0: "Recipient", length: 1 }]) {
    assert.throws(() => formatDeliveryAddress(value), TypeError);
  }
});

test("formatDeliveryAddress rejects nonstring entries with TypeError", () => {
  for (const value of [undefined, null, 1, true, {}, ["Street"], new String("Street")]) {
    assert.throws(() => formatDeliveryAddress(["Recipient", value]), TypeError);
  }
});

test("formatDeliveryAddress rejects sparse or inherited entries with TypeError", () => {
  assert.throws(() => formatDeliveryAddress(new Array(1)), TypeError);
  assert.throws(() => formatDeliveryAddress(["Recipient", , "Country"]), TypeError);
  const inherited = new Array(1);
  const prototype = Object.create(Array.prototype);
  prototype[0] = "Not an own entry";
  Object.setPrototypeOf(inherited, prototype);
  assert.throws(() => formatDeliveryAddress(inherited), TypeError);
});

test("formatDeliveryAddress rejects an empty array with RangeError", () => {
  assert.throws(() => formatDeliveryAddress([]), RangeError);
});

test("formatDeliveryAddress rejects empty and whitespace-only lines with RangeError", () => {
  for (const line of ["", " ", "\t", "\u00a0", "\u2003", " \t\u3000 "]) {
    assert.throws(() => formatDeliveryAddress(["Recipient", line]), RangeError);
  }
});

test("formatDeliveryAddress rejects all listed embedded line breaks with RangeError", () => {
  for (const separator of ["\n", "\r", "\v", "\f", "\u0085", "\u2028", "\u2029", "\r\n"]) {
    assert.throws(
      () => formatDeliveryAddress(["Recipient", "Street" + separator + "Country"]),
      RangeError,
    );
  }
});
