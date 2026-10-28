"use strict";

const test = require("node:test");
const assert = require("node:assert/strict");
const { spawn, spawnSync } = require("node:child_process");
const { once } = require("node:events");
const { mkdtempSync, writeFileSync, readFileSync, rmSync } = require("node:fs");
const { tmpdir } = require("node:os");
const { join } = require("node:path");

const CLI = join(__dirname, "parcel-manifest-compare-cli.js");
const EMPTY_COMPARISON = { added: [], removed: [], changed: [], unchanged: 0 };

function parcel(id, overrides = {}) {
  return {
    id, recipient: "Alex Example", street: "10 Example Street", postcode: "SW1A 1AA",
    destination: "GB", service: "standard", itemCount: 2, ...overrides,
  };
}

function run(args, options = {}) {
  const result = spawnSync(process.execPath, [CLI, ...args], {
    encoding: "utf8", timeout: 10000, ...options,
  });
  assert.ifError(result.error);
  assert.equal(result.signal, null);
  return result;
}

function fixture(t, before, after) {
  const directory = mkdtempSync(join(tmpdir(), "parcel-compare-test-"));
  t.after(() => rmSync(directory, { recursive: true, force: true }));
  const files = [join(directory, "before manifest.json"), join(directory, "after manifest.json")];
  const save = (values) => values.forEach((value, index) =>
    writeFileSync(files[index], typeof value === "string" ? value : JSON.stringify(value)));
  save([before, after]);
  return { directory, files, save };
}

function inputInfo(file, totalRows) {
  return { file, valid: true, totalRows, validRows: totalRows, invalidRows: 0 };
}

test("comparison CLI reports added, removed, and changed parcels by trimmed IDs", (t) => {
  const before = [parcel("keep"), parcel(" removed "), parcel(" changed ")];
  const after = [
    parcel(" added ", { destination: " us ", itemCount: 1 }),
    parcel("changed", { service: "EXPRESS", itemCount: 3 }), parcel("keep"),
  ];
  const { files } = fixture(t, before, after);
  const result = run(["--json", ...files]);
  assert.equal(result.status, 0);
  assert.equal(result.stderr, "");
  assert.deepEqual(JSON.parse(result.stdout), {
    valid: true,
    inputs: { before: inputInfo(files[0], 3), after: inputInfo(files[1], 3) },
    errors: [],
    comparison: {
      added: [parcel("added", { destination: "US", itemCount: 1 })],
      removed: [parcel("removed")],
      changed: [{ id: "changed", changes: [
        { field: "service", before: "standard", after: "express" },
        { field: "itemCount", before: 2, after: 3 },
      ] }],
      unchanged: 1,
    },
  });
  assert.equal(run([...files, "--json"]).stdout, result.stdout);
  const text = run(files);
  assert.equal(text.status, 0);
  assert.equal(text.stderr, "");
  assert.equal(text.stdout, [
    "Comparing " + JSON.stringify(files[0]) + " -> " + JSON.stringify(files[1]),
    "Parcels: 3 before, 3 after.",
    "Added: 1", '  "added": "US" / "standard" (1 item)',
    "Removed: 1", '  "removed": "GB" / "standard" (2 items)',
    "Changed: 1", '  "changed":',
    '    service: "standard" -> "express"', "    itemCount: 2 -> 3", "Unchanged: 1", "",
  ].join("\n"));
});

test("comparison CLI sorts every category by ID regardless of manifest order", (t) => {
  const before = [parcel("z-removed"), parcel("z-changed"), parcel("a-removed"), parcel("a-changed")];
  const after = [
    parcel("z-added"), parcel("z-changed", { itemCount: 3 }),
    parcel("a-added"), parcel("a-changed", { service: "express" }),
  ];
  const { files, save } = fixture(t, before, after);
  const first = run(["--json", ...files]);
  const text = run(files);
  const report = JSON.parse(first.stdout);
  assert.deepEqual(report.comparison.added.map(({ id }) => id), ["a-added", "z-added"]);
  assert.deepEqual(report.comparison.removed.map(({ id }) => id), ["a-removed", "z-removed"]);
  assert.deepEqual(report.comparison.changed.map(({ id }) => id), ["a-changed", "z-changed"]);
  save([[...before].reverse(), [...after].reverse()]);
  assert.equal(run(["--json", ...files]).stdout, first.stdout);
  assert.equal(run(files).stdout, text.stdout);
});

test("comparison CLI records all six compared fields in a fixed order", (t) => {
  const original = parcel("same");
  const updated = parcel("same", {
    recipient: "Robin Example", street: "22 Sample Road", postcode: "10001",
    destination: "US", service: "express", itemCount: 5,
  });
  const { files } = fixture(t, [original], [updated]);
  const result = run(["--json", ...files]);
  assert.equal(result.status, 0);
  assert.deepEqual(JSON.parse(result.stdout).comparison.changed, [{
    id: "same",
    changes: ["recipient", "street", "postcode", "destination", "service", "itemCount"]
      .map((field) => ({ field, before: original[field], after: updated[field] })),
  }]);
});

test("comparison CLI ignores surrounding whitespace, normalized casing, and extra fields", (t) => {
  const before = parcel(" P-1 ", { note: "old" });
  const after = parcel("P-1", {
    recipient: " Alex Example ", street: "10 Example Street\t", postcode: " SW1A 1AA ",
    destination: " gb ", service: " STANDARD ", note: { changed: true },
  });
  const { files } = fixture(t, [before], [after]);
  const result = run(["--json", ...files]);
  assert.equal(result.status, 0);
  assert.deepEqual(JSON.parse(result.stdout).comparison, { ...EMPTY_COMPARISON, unchanged: 1 });
  const sameFile = run(["--json", files[0], files[0]]);
  assert.equal(sameFile.status, 0);
  assert.equal(JSON.parse(sameFile.stdout).comparison.unchanged, 1);
});

test("comparison IDs are case-sensitive and special object keys are safe", (t) => {
  const { files } = fixture(t,
    [parcel("A"), parcel("__proto__"), parcel("constructor")],
    [parcel("a"), parcel("__proto__", { itemCount: 3 }), parcel("constructor")]);
  const result = run(["--json", ...files]);
  assert.equal(result.status, 0);
  const diff = JSON.parse(result.stdout).comparison;
  assert.deepEqual(diff.added.map(({ id }) => id), ["a"]);
  assert.deepEqual(diff.removed.map(({ id }) => id), ["A"]);
  assert.equal(diff.changed[0].id, "__proto__");
  assert.equal(diff.unchanged, 1);
});

test("comparison CLI handles empty manifests and one-sided additions or removals", (t) => {
  const { files, save } = fixture(t, [], []);
  for (const [before, after, expected] of [
    [[], [], EMPTY_COMPARISON],
    [[], [parcel("one")], { ...EMPTY_COMPARISON, added: [parcel("one")] }],
    [[parcel("one")], [], { ...EMPTY_COMPARISON, removed: [parcel("one")] }],
  ]) {
    save([before, after]);
    const result = run(["--json", ...files]);
    assert.equal(result.status, 0);
    assert.deepEqual(JSON.parse(result.stdout).comparison, expected);
  }
});

test("comparison CLI validates both files and reports original one-based rows", (t) => {
  const { files } = fixture(t,
    [parcel("before-only"), null, parcel("broken", { itemCount: 0 })],
    [parcel("after-only", { recipient: "" }), parcel("other"), parcel("bad", { destination: "USA" })]);
  const result = run(["--json", ...files]);
  assert.equal(result.status, 1);
  assert.equal(result.stderr, "");
  const report = JSON.parse(result.stdout);
  assert.equal(report.valid, false);
  assert.equal(report.comparison, null);
  assert.deepEqual(report.errors.map(({ input, file, row, field }) => [input, file, row, field]), [
    ["before", files[0], 2, "$"], ["before", files[0], 3, "itemCount"],
    ["after", files[1], 1, "recipient"], ["after", files[1], 3, "destination"],
  ]);
  for (const input of ["before", "after"]) {
    assert.equal(report.inputs[input].totalRows, 3);
    assert.equal(report.inputs[input].validRows, 1);
    assert.equal(report.inputs[input].invalidRows, 2);
  }
  const text = run(files);
  assert.equal(text.status, 1);
  assert.match(text.stdout, /Comparison not performed/);
  assert.doesNotMatch(text.stdout, /Added:|Removed:|Changed:/);
  assert.ok(text.stderr.includes('before ' + JSON.stringify(files[0]) + ' Row 2 [$]'));
  assert.ok(text.stderr.includes('after ' + JSON.stringify(files[1]) + ' Row 3 [destination]'));
});

test("an invalid row on either side blocks all additions and removals", (t) => {
  const { files, save } = fixture(t, [], []);
  for (const invalidSide of [0, 1]) {
    const values = [[parcel("old")], [parcel("new")]];
    values[invalidSide].push(parcel("invalid", { postcode: "" }));
    save(values);
    const result = run(["--json", ...files]);
    assert.equal(result.status, 1);
    const report = JSON.parse(result.stdout);
    assert.equal(report.comparison, null);
    assert.equal(report.errors[0].file, files[invalidSide]);
    assert.equal(report.errors[0].row, 2);
  }
});

test("duplicate trimmed IDs in either input block comparison rather than overwrite rows", (t) => {
  const { files, save } = fixture(t, [], []);
  for (const side of [0, 1]) {
    const values = [[parcel("same")], [parcel("same")]];
    values[side].push(parcel(" same ", { itemCount: 10 }));
    save(values);
    const result = run(["--json", ...files]);
    assert.equal(result.status, 1);
    const report = JSON.parse(result.stdout);
    assert.equal(report.comparison, null);
    assert.deepEqual(report.errors.map(({ file, row, field }) => [file, row, field]),
      [[files[side], 1, "id"], [files[side], 2, "id"]]);
    assert.match(report.errors[0].message, /Duplicate ID/);
  }
});

test("malformed JSON and non-array roots include file-level diagnostics for both inputs", (t) => {
  const { files, save } = fixture(t, "[", "null");
  for (const values of [["[", "null"], ["", "{}"], ["true", "not JSON"]]) {
    save(values);
    const result = run(["--json", ...files]);
    assert.equal(result.status, 1);
    const report = JSON.parse(result.stdout);
    assert.equal(report.comparison, null);
    assert.deepEqual(report.errors.map(({ file, row, field }) => [file, row, field]),
      [[files[0], null, "$"], [files[1], null, "$"]]);
    assert.equal(report.inputs.before.totalRows, 0);
    assert.equal(report.inputs.after.totalRows, 0);
  }
  const text = run(files);
  assert.equal(text.status, 1);
  assert.ok(text.stderr.includes(JSON.stringify(files[0]) + " Manifest [$]"));
  assert.ok(text.stderr.includes(JSON.stringify(files[1]) + " Manifest [$]"));
});

test("read errors do not prevent validation of the other file, in either mode", (t) => {
  const { files, directory } = fixture(t, [], [null]);
  const missing = join(directory, "missing.json");
  const result = run(["--json", missing, files[1]]);
  assert.equal(result.status, 2);
  assert.equal(result.stderr, "");
  const report = JSON.parse(result.stdout);
  assert.equal(report.comparison, null);
  assert.equal(report.inputs.before.totalRows, null);
  assert.match(report.errors[0].message, /Cannot read file \(ENOENT\)/);
  assert.deepEqual(report.errors.map(({ file, row }) => [file, row]), [[missing, null], [files[1], 1]]);
  const text = run([missing, files[1]]);
  assert.equal(text.status, 2);
  assert.ok(text.stderr.includes(JSON.stringify(missing) + " Manifest [$]"));
  assert.ok(text.stderr.includes(JSON.stringify(files[1]) + " Row 1 [$]"));
  const both = run(["--json", missing, join(directory, "also-missing.json")]);
  assert.equal(both.status, 2);
  assert.equal(JSON.parse(both.stdout).errors.length, 2);
  const afterMissing = run(["--json", files[0], missing]);
  assert.equal(afterMissing.status, 2);
  assert.equal(JSON.parse(afterMissing.stdout).errors[0].input, "after");
});

test("comparison CLI help and argument errors have documented statuses", () => {
  for (const flag of ["--help", "-h"]) {
    const result = run([flag]);
    assert.equal(result.status, 0);
    assert.equal(result.stderr, "");
    assert.match(result.stdout, /--json/);
    assert.match(result.stdout, /before.json.*after.json/);
    assert.match(result.stdout, /only one input may be -/);
  }
  for (const args of [[], ["one"], ["one", "two", "three"], ["--json"], ["--unknown"], ["-", "-"], ["-"], ["", "two"]]) {
    const result = run(args);
    assert.equal(result.status, 2);
    assert.equal(result.stdout, "");
    assert.match(result.stderr, /^Error:/);
    assert.match(result.stderr, /Usage:/);
  }
});

test("comparison CLI supports dash-prefixed filenames after --", (t) => {
  const { directory } = fixture(t, [], []);
  writeFileSync(join(directory, "--before"), "[]");
  writeFileSync(join(directory, "--after"), "[]");
  const result = run(["--json", "--", "--before", "--after"], { cwd: directory });
  assert.equal(result.status, 0);
  assert.deepEqual(JSON.parse(result.stdout).comparison, EMPTY_COMPARISON);
});

test("comparison text safely quotes IDs and changed values", (t) => {
  const id = "ID\nInjected";
  const { files } = fixture(t, [parcel(id)], [parcel(id, { recipient: "New\nRecipient" })]);
  const result = run(files);
  assert.equal(result.status, 0);
  assert.ok(result.stdout.includes(JSON.stringify(id)));
  assert.ok(result.stdout.includes(JSON.stringify("New\nRecipient")));
  assert.ok(!result.stdout.includes(id));
});

test("importing comparison CLI has no side effects", () => {
  const result = spawnSync(process.execPath, ["-e", "require(" + JSON.stringify(CLI) + ")"], {
    encoding: "utf8", timeout: 10000,
  });
  assert.ifError(result.error);
  assert.equal(result.status, 0);
  assert.equal(result.stdout, "");
  assert.equal(result.stderr, "");
});


test("documented before/today examples produce the described comparison", () => {
  const files = [join(__dirname, "examples", "manifest.json"), join(__dirname, "examples", "manifest-today.json")];
  const result = run(["--json", ...files]);
  assert.equal(result.status, 0);
  const diff = JSON.parse(result.stdout).comparison;
  assert.deepEqual(diff.added.map(({ id }) => id), ["CA-1"]);
  assert.deepEqual(diff.removed.map(({ id }) => id), ["GB-2"]);
  assert.deepEqual(diff.changed, [{ id: "US-1", changes: [
    { field: "service", before: "standard", after: "express" },
    { field: "itemCount", before: 2, after: 3 },
  ] }]);
  assert.equal(diff.unchanged, 1);
  const invalid = run(["--json", join(__dirname, "examples", "manifest-mixed.json"), files[1]]);
  assert.equal(invalid.status, 1);
  const report = JSON.parse(invalid.stdout);
  assert.equal(report.comparison, null);
  assert.deepEqual(report.errors.map(({ input, row }) => [input, row]),
    [["before", 2], ["before", 2], ["before", 3]]);
});


for (const field of ["id", "recipient", "street", "postcode", "destination", "service"]) {
  test("comparison treats surrounding whitespace in " + field + " as unchanged", (t) => {
    const original = parcel("same");
    const padded = { ...original, [field]: " \t" + original[field] + "\n " };
    const { files } = fixture(t, [original], [padded]);
    const result = run(["--json", ...files]);
    assert.equal(result.status, 0);
    assert.equal(result.stderr, "");
    assert.deepEqual(JSON.parse(result.stdout).comparison, { ...EMPTY_COMPARISON, unchanged: 1 });
    const text = run(files);
    assert.equal(text.status, 0);
    assert.match(text.stdout, /Changed: 0\nUnchanged: 1\n$/);
  });
}

for (const [field, differentCase] of [
  ["recipient", "alex example"], ["street", "10 example street"], ["postcode", "sw1a 1aa"],
]) {
  test("comparison detects case-only " + field + " changes with old and new values", (t) => {
    const original = parcel("same");
    const { files } = fixture(t, [original], [parcel("same", { [field]: differentCase })]);
    const result = run(["--json", ...files]);
    assert.equal(result.status, 0);
    assert.equal(result.stderr, "");
    assert.deepEqual(JSON.parse(result.stdout).comparison, {
      ...EMPTY_COMPARISON,
      changed: [{ id: "same", changes: [{ field, before: original[field], after: differentCase }] }],
    });
    const text = run(files);
    assert.equal(text.status, 0);
    assert.ok(text.stdout.includes("    " + field + ": " + JSON.stringify(original[field]) +
      " -> " + JSON.stringify(differentCase)));
    assert.match(text.stdout, /Unchanged: 0\n$/);
  });
}

test("country and service case-only differences are unchanged in both formats", (t) => {
  const { files } = fixture(t,
    [parcel("country"), parcel("service")],
    [parcel("country", { destination: "gB" }), parcel("service", { service: "StAnDaRd" })]);
  const result = run(["--json", ...files]);
  assert.equal(result.status, 0);
  assert.deepEqual(JSON.parse(result.stdout).comparison, { ...EMPTY_COMPARISON, unchanged: 2 });
  const text = run(files);
  assert.equal(text.status, 0);
  assert.match(text.stdout, /Changed: 0\nUnchanged: 2\n$/);
});

test("comparison preserves internal whitespace in recipient, street, and postcode", (t) => {
  const before = [parcel("recipient"), parcel("street"), parcel("postcode")];
  const after = before.map((row) => ({ ...row, [row.id]: row[row.id].replace(" ", "  ") }));
  const { files } = fixture(t, before, after);
  const result = run(["--json", ...files]);
  assert.equal(result.status, 0);
  const diff = JSON.parse(result.stdout).comparison;
  assert.equal(diff.unchanged, 0);
  assert.deepEqual(diff.changed, ["postcode", "recipient", "street"].map((field) => ({
    id: field,
    changes: [{ field, before: parcel("same")[field], after: parcel("same")[field].replace(" ", "  ") }],
  })));
});

test("changed fields report normalized old/new values but preserve case-sensitive content", (t) => {
  const { files } = fixture(t,
    [parcel(" same ", { recipient: " Alex Example ", destination: " gb ", service: " STANDARD " })],
    [parcel("same", { recipient: " alex example ", destination: " us ", service: " EXPRESS ", itemCount: 3 })]);
  const result = run(["--json", ...files]);
  assert.equal(result.status, 0);
  const changes = [
    { field: "recipient", before: "Alex Example", after: "alex example" },
    { field: "destination", before: "GB", after: "US" },
    { field: "service", before: "standard", after: "express" },
    { field: "itemCount", before: 2, after: 3 },
  ];
  assert.deepEqual(JSON.parse(result.stdout).comparison, {
    ...EMPTY_COMPARISON, changed: [{ id: "same", changes }],
  });
  const text = run(files);
  assert.equal(text.status, 0);
  for (const { field, before, after } of changes) {
    assert.ok(text.stdout.includes("    " + field + ": " + JSON.stringify(before) + " -> " + JSON.stringify(after)));
  }
  assert.match(text.stdout, /Unchanged: 0\n$/);
});

test("unchanged counts include metadata additions, removals, and edits alongside real changes", (t) => {
  const before = [
    parcel("meta-added"), parcel("meta-removed", { note: "remove me" }),
    parcel("meta-edited", { metadata: { batch: 1 }, tags: ["old"] }),
    parcel("changed", { note: "old" }), parcel("removed"),
  ];
  const after = [
    parcel("meta-added", { note: null, arbitrary: { nested: [1, 2] } }),
    parcel("meta-removed"),
    parcel("meta-edited", { metadata: { batch: 2 }, tags: "new" }),
    parcel("changed", { itemCount: 4, note: "new" }), parcel("added"),
  ];
  const { files } = fixture(t, before, after);
  const result = run(["--json", ...files]);
  assert.equal(result.status, 0);
  assert.equal(result.stderr, "");
  assert.deepEqual(JSON.parse(result.stdout).comparison, {
    added: [parcel("added")], removed: [parcel("removed")],
    changed: [{ id: "changed", changes: [{ field: "itemCount", before: 2, after: 4 }] }],
    unchanged: 3,
  });
  const text = run(files);
  assert.equal(text.status, 0);
  assert.match(text.stdout, /Added: 1\n/);
  assert.match(text.stdout, /Removed: 1\n/);
  assert.match(text.stdout, /Changed: 1\n/);
  assert.match(text.stdout, /Unchanged: 3\n$/);
  assert.doesNotMatch(text.stdout, /meta-added|meta-removed|meta-edited|note|tags/);
});


for (const [side, index] of [["before", 0], ["after", 1]]) {
  test("comparison reads " + side + " from a real stdin pipe in text and JSON modes", (t) => {
    const rows = [
      [parcel(" removed "), parcel(" changed "), parcel("keep")],
      [parcel("added"), parcel("changed", { itemCount: 4 }), parcel("keep")],
    ];
    const { files } = fixture(t, ...rows);
    const args = [...files];
    args[index] = "-";
    const expected = JSON.parse(run(["--json", ...files]).stdout);
    expected.inputs[side].file = "-";
    const input = JSON.stringify(rows[index]);
    const json = run(["--json", ...args], { input });
    assert.equal(json.status, 0);
    assert.equal(json.stderr, "");
    assert.deepEqual(JSON.parse(json.stdout), expected);
    assert.equal(run([...args, "--json"], { input }).stdout, json.stdout);
    const text = run(args, { input });
    assert.equal(text.status, 0);
    assert.equal(text.stderr, "");
    assert.ok(text.stdout.startsWith(index === 0 ? "Comparing stdin (-) -> " :
      "Comparing " + JSON.stringify(files[0]) + " -> stdin (-)"));
    assert.equal(text.stdout.split("\n").slice(1).join("\n"),
      run(files).stdout.split("\n").slice(1).join("\n"));
  });

  test("invalid " + side + " stdin retains original rows and also validates the file input", (t) => {
    const { files } = fixture(t,
      [parcel("file", { postcode: "" })], [parcel("file", { postcode: "" })]);
    const args = [...files];
    args[index] = "-";
    const input = JSON.stringify([parcel("valid"), null, parcel("bad", { itemCount: 0 })]);
    const result = run(["--json", ...args], { input });
    assert.equal(result.status, 1);
    assert.equal(result.stderr, "");
    const report = JSON.parse(result.stdout);
    assert.equal(report.valid, false);
    assert.equal(report.comparison, null);
    assert.deepEqual(report.inputs[side], {
      file: "-", valid: false, totalRows: 3, validRows: 1, invalidRows: 2,
    });
    assert.deepEqual(report.errors.filter(({ input }) => input === side)
      .map(({ input, file, row, field }) => [input, file, row, field]),
    [[side, "-", 2, "$"], [side, "-", 3, "itemCount"]]);
    assert.deepEqual(report.errors.filter(({ input }) => input !== side)
      .map(({ file, row, field }) => [file, row, field]), [[files[1 - index], 1, "postcode"]]);
    const text = run(args, { input });
    assert.equal(text.status, 1);
    assert.ok(text.stderr.includes(side + " stdin (-) Row 2 [$]"));
    assert.ok(text.stderr.includes(side + " stdin (-) Row 3 [itemCount]"));
    assert.ok(text.stderr.includes(JSON.stringify(files[1 - index]) + " Row 1 [postcode]"));
    assert.match(text.stdout, /Comparison not performed/);
    assert.doesNotMatch(text.stdout, /Added:|Removed:|Changed:/);
  });

  test("malformed or empty " + side + " stdin produces side-specific document errors", (t) => {
    const { files } = fixture(t, [], []);
    const args = [...files];
    args[index] = "-";
    for (const input of ["", "[", "null", "{}"] ) {
      const result = run(["--json", ...args], { input });
      assert.equal(result.status, 1);
      assert.equal(result.stderr, "");
      const report = JSON.parse(result.stdout);
      assert.equal(report.comparison, null);
      assert.deepEqual(report.errors.map(({ input, file, row, field }) => [input, file, row, field]),
        [[side, "-", null, "$"]]);
      assert.equal(report.inputs[side].totalRows, 0);
      const text = run(args, { input });
      assert.equal(text.status, 1);
      assert.ok(text.stderr.startsWith(side + " stdin (-) Manifest [$]:"));
    }
  });

  test("duplicate IDs in " + side + " stdin block comparison and retain duplicate row numbers", (t) => {
    const { files } = fixture(t, [parcel("same")], [parcel("same")]);
    const args = [...files];
    args[index] = "-";
    const result = run(["--json", ...args], {
      input: JSON.stringify([parcel("same"), parcel("other"), parcel(" same ")]),
    });
    assert.equal(result.status, 1);
    const report = JSON.parse(result.stdout);
    assert.equal(report.comparison, null);
    assert.deepEqual(report.errors.map(({ input, file, row, field }) => [input, file, row, field]),
      [[side, "-", 1, "id"], [side, "-", 3, "id"]]);
  });

  test("empty-array " + side + " stdin is valid and preserves comparison direction", (t) => {
    const { files } = fixture(t, [parcel("one")], [parcel("one")]);
    const args = [...files];
    args[index] = "-";
    const result = run(["--json", ...args], { input: "[]" });
    assert.equal(result.status, 0);
    assert.equal(result.stderr, "");
    const report = JSON.parse(result.stdout);
    assert.equal(report.inputs[side].totalRows, 0);
    assert.deepEqual(report.comparison, {
      ...EMPTY_COMPARISON, [index === 0 ? "added" : "removed"]: [parcel("one")],
    });
  });

  test("unreadable file does not hide invalid " + side + " stdin diagnostics", (t) => {
    const { directory } = fixture(t, [], []);
    const missing = join(directory, "missing.json");
    const args = index === 0 ? ["-", missing] : [missing, "-"];
    const result = run(["--json", ...args], { input: "[null]" });
    assert.equal(result.status, 2);
    const report = JSON.parse(result.stdout);
    assert.equal(report.comparison, null);
    assert.equal(report.errors.length, 2);
    assert.deepEqual(report.errors.filter(({ input }) => input === side)
      .map(({ file, row, field }) => [file, row, field]), [["-", 1, "$"]]);
    assert.match(report.errors.find(({ input }) => input !== side).message, /ENOENT/);
  });
}

for (const args of [["-", "-"], ["--json", "-", "-"], ["--json", "--", "-", "-"]]) {
  test("two stdin operands fail before reading for " + args.join(" "), async (t) => {
    // Leave the pipe open with no data: waiting for stdin would hit the timeout.
    const child = spawn(process.execPath, [CLI, ...args], {
      stdio: ["pipe", "pipe", "pipe"], timeout: 5000,
    });
    t.after(() => {
      if (child.exitCode === null && child.signalCode === null) child.kill();
    });
    let stdout = "";
    let stderr = "";
    child.stdout.setEncoding("utf8").on("data", (chunk) => { stdout += chunk; });
    child.stderr.setEncoding("utf8").on("data", (chunk) => { stderr += chunk; });
    const [status, signal] = await once(child, "close");
    assert.equal(signal, null, "must reject without waiting for the open stdin pipe");
    assert.equal(status, 2);
    assert.equal(stdout, "");
    assert.match(stderr, /^Error: Only one input may be - \(stdin\); provide a filename for the other input\./);
    assert.match(stderr, /Usage:/);
  });
}

test("comparison supports stdin with -- and allows ./- as a literal filename", (t) => {
  const { directory } = fixture(t, [], []);
  writeFileSync(join(directory, "--before"), "[]");
  writeFileSync(join(directory, "-"), "[]");
  for (const name of ["--before", "./-"]) {
    const result = run(["--json", "--", name, "-"], { cwd: directory, input: "[]" });
    assert.equal(result.status, 0);
    assert.equal(result.stderr, "");
    assert.deepEqual(JSON.parse(result.stdout).comparison, EMPTY_COMPARISON);
    assert.equal(JSON.parse(result.stdout).inputs.before.file, name);
    assert.equal(JSON.parse(result.stdout).inputs.after.file, "-");
  }
});

test("file-only comparisons ignore stdin and retain their existing report format", (t) => {
  const { files } = fixture(t, [parcel("same")], [parcel("same")]);
  for (const mode of [[], ["--json"]]) {
    const expected = run([...mode, ...files]);
    const actual = run([...mode, ...files], { input: "not JSON" });
    assert.equal(actual.status, 0);
    assert.equal(actual.stdout, expected.stdout);
    assert.equal(actual.stderr, expected.stderr);
  }
});


test("comparison escapes malformed-input controls without losing side attribution", (t) => {
  const { files } = fixture(t, [], []);
  for (const [side, args] of [["before", ["-", files[1]]], ["after", [files[0], "-"]]]) {
    const input = "\u001b[2J";
    const text = run(args, { input });
    assert.equal(text.status, 1);
    assert.ok(text.stderr.startsWith(side + " stdin (-) Manifest [$]: Invalid JSON:"));
    assert.doesNotMatch(text.stderr, /[\u0000-\u0009\u000b-\u001f\u007f-\u009f]/);
    const json = run(["--json", ...args], { input });
    assert.equal(json.status, 1);
    assert.equal(json.stderr, "");
    const report = JSON.parse(json.stdout);
    assert.equal(report.comparison, null);
    assert.equal(report.errors[0].input, side);
    assert.equal(report.errors[0].row, null);
    assert.doesNotMatch(report.errors[0].message, /[\u0000-\u001f\u007f-\u009f]/);
  }
});

const MALFORMED_UTF8 = [
  ["isolated continuation 80", [0x80]], ["isolated continuation 81", [0x81]],
  ["invalid lead ff", [0xff]], ["invalid lead fe", [0xfe]],
  ["overlong two-byte", [0xc0, 0xaf]], ["overlong three-byte", [0xe0, 0x80, 0xaf]],
  ["truncated two-byte", [0xc2]], ["truncated three-byte", [0xe2, 0x82]],
  ["truncated four-byte", [0xf0, 0x9f, 0x92]],
  ["bad continuation", [0xe2, 0x28, 0xa1]],
  ["encoded surrogate", [0xed, 0xa0, 0x80]],
  ["above Unicode maximum", [0xf4, 0x90, 0x80, 0x80]],
];

function malformedManifest(bytes) {
  const source = Buffer.from(JSON.stringify([parcel("QBAD")]));
  const position = source.indexOf("QBAD") + 1;
  return Buffer.concat([source.subarray(0, position), Buffer.from(bytes), source.subarray(position + 1)]);
}

for (const [name, bytes] of MALFORMED_UTF8) {
  test("comparison rejects " + name + " on either side, from files and stdin", (t) => {
    const { files, save } = fixture(t, [], []);
    const input = malformedManifest(bytes);
    for (const index of [0, 1]) {
      const side = index === 0 ? "before" : "after";
      const otherSide = index === 0 ? "after" : "before";
      for (const stdin of [false, true]) {
        // Invalid rows on the other side must still be inspected; read errors win.
        save([[null], [null]]);
        writeFileSync(files[index], input);
        const args = [...files];
        if (stdin) args[index] = "-";
        const result = run(["--json", ...args], { input });
        assert.equal(result.status, 2);
        assert.equal(result.stderr, "");
        const report = JSON.parse(result.stdout);
        assert.equal(report.valid, false);
        assert.equal(report.comparison, null);
        assert.deepEqual(report.inputs[side], {
          file: args[index], valid: false, totalRows: null, validRows: null, invalidRows: null,
        });
        assert.deepEqual(report.errors.filter(({ input }) => input === side), [{
          input: side, file: args[index], row: null, field: "$",
          message: "Cannot read " + (stdin ? "stdin" : "file") +
            " (invalid UTF-8; supply a UTF-8 encoded manifest).",
        }]);
        assert.deepEqual(report.errors.filter(({ input }) => input === otherSide)
          .map(({ row, field }) => [row, field]), [[1, "$"]]);
        const text = run(args, { input });
        assert.equal(text.status, 2);
        assert.ok(text.stderr.includes(side + " " + (stdin ? "stdin (-)" : JSON.stringify(files[index])) +
          " Manifest [$]: Cannot read"));
        assert.match(text.stderr, /invalid UTF-8; supply a UTF-8 encoded manifest/);
        assert.ok(text.stderr.includes(otherSide + " " + JSON.stringify(files[1 - index]) + " Row 1 [$]:"));
        assert.match(text.stdout, /Comparison not performed/);
        assert.doesNotMatch(text.stdout, /Added:|Removed:|Changed:|Unchanged:/);
      }
    }
  });
}

test("different malformed bytes cannot collapse into an unchanged ID", (t) => {
  const { files } = fixture(t, [], []);
  writeFileSync(files[0], malformedManifest([0x80]));
  for (const byte of [0x81, 0xff]) {
    writeFileSync(files[1], malformedManifest([byte]));
    const result = run(["--json", ...files]);
    assert.equal(result.status, 2);
    const report = JSON.parse(result.stdout);
    assert.equal(report.comparison, null);
    assert.deepEqual(report.errors.map(({ input }) => input), ["before", "after"]);
    assert.ok(report.errors.every(({ message }) => message.includes("invalid UTF-8")));
  }
});

test("comparison retains valid replacement characters and international text on either stdin side", (t) => {
  const row = parcel("Q�AD", { recipient: "Zoë 東京 🚚 �", service: "réexpédition-東京-🚚-�" });
  const { files } = fixture(t, [row], [row]);
  for (const index of [-1, 0, 1]) {
    const args = [...files];
    if (index !== -1) args[index] = "-";
    const input = Buffer.from(JSON.stringify([row]));
    const result = run(["--json", ...args], { input });
    assert.equal(result.status, 0);
    assert.equal(result.stderr, "");
    assert.deepEqual(JSON.parse(result.stdout).comparison, { ...EMPTY_COMPARISON, unchanged: 1 });
    const text = run(args, { input });
    assert.equal(text.status, 0);
    assert.equal(text.stderr, "");
    assert.match(text.stdout, /Unchanged: 1\n$/);
  }
  // Also check preserved Unicode in emitted parcels, rather than only equality.
  writeFileSync(files[0], "[]");
  const result = run(["--json", ...files]);
  assert.equal(result.status, 0);
  assert.deepEqual(JSON.parse(result.stdout).comparison.added, [row]);
});

test("comparison keeps UTF-8 BOM as a side-specific JSON error", (t) => {
  const { files } = fixture(t, [], []);
  for (const index of [0, 1]) {
    const args = [...files];
    args[index] = "-";
    const result = run(["--json", ...args], { input: Buffer.from("\ufeff[]") });
    assert.equal(result.status, 1);
    const report = JSON.parse(result.stdout);
    assert.equal(report.comparison, null);
    assert.equal(report.errors[0].input, index === 0 ? "before" : "after");
    assert.match(report.errors[0].message, /^Invalid JSON:/);
  }
});

// Read precisely one 64 KiB prefix, then close the pipe while a larger write is
// pending. No shell pipeline: close/status belong to the actual CLI producer.
async function closeAfterPrefix(t, args, expected) {
  const child = spawn(process.execPath, [CLI, ...args], {
    stdio: ["ignore", "pipe", "pipe"], timeout: 10000,
  });
  t.after(() => { if (child.exitCode === null && child.signalCode === null) child.kill(); });
  const closed = once(child, "close");
  let prefix = null;
  let stderr = "";
  child.stderr.setEncoding("utf8").on("data", (chunk) => { stderr += chunk; });
  child.stdout.on("readable", () => {
    if (prefix !== null) return;
    const chunk = child.stdout.read(65536);
    if (chunk !== null) {
      prefix = chunk;
      child.stdout.destroy();
    }
  });
  const [status, signal] = await closed;
  assert.equal(signal, null, "producer must exit without a timeout or signal");
  assert.equal(status, 3, "truncated output must never report producer success");
  assert.equal(stderr, "Error: cannot write stdout (EPIPE).\n");
  assert.ok(prefix);
  assert.equal(prefix.length, 65536);
  assert.ok(Buffer.byteLength(expected) > prefix.length);
  assert.deepEqual(prefix, Buffer.from(expected).subarray(0, 65536));
}

test("help handles an already-closed stdout pipe without an unhandled error", async (t) => {
  // Gate startup over IPC: the read end is closed before the actual CLI starts,
  // so a short help write cannot win a timing race against the test reader.
  const bootstrap = 'process.once("message", () => {' +
    'process.disconnect(); process.argv = [process.execPath, ...process.argv.slice(1)];' +
    'require("node:module").runMain(); });';
  const child = spawn(process.execPath, ["-e", bootstrap, CLI, "--help"], {
    stdio: ["ignore", "pipe", "pipe", "ipc"], timeout: 10000,
  });
  t.after(() => { if (child.exitCode === null && child.signalCode === null) child.kill(); });
  const closed = once(child, "close");
  let stderr = "";
  child.stderr.setEncoding("utf8").on("data", (chunk) => { stderr += chunk; });
  child.stdout.destroy();
  await once(child.stdout, "close");
  child.send("start");
  const [status, signal] = await closed;
  assert.equal(signal, null);
  assert.equal(status, 3);
  assert.equal(stderr, "Error: cannot write stdout (EPIPE).\n");
});


// Give both producer streams the same real reader pipe, equivalent to 2>&1.
// The consumer exits after exactly 64 KiB; inspect BOTH subprocess statuses.
async function closeMergedAfterPrefix(t, args, expected, synchronousDiagnosticFailure) {
  const directory = mkdtempSync(join(tmpdir(), "parcel-merged-test-"));
  t.after(() => rmSync(directory, { recursive: true, force: true }));
  const observed = join(directory, "uncaught.jsonl");
  const monitor = join(directory, "monitor.cjs");
  writeFileSync(monitor, [
    'const fs = require("node:fs");',
    'const observed = ' + JSON.stringify(observed) + ';',
    'fs.writeFileSync(observed, "ready\\n");',
    'process.on("uncaughtExceptionMonitor", (error) => {',
    '  fs.appendFileSync(observed, JSON.stringify({ code: error.code, exitCode: process.exitCode }) + "\\n");',
    '});',
    ...(synchronousDiagnosticFailure ? [
      // Inject only diagnostic transport failure; stdout still fails for real.
      'process.stderr.write = () => { throw Object.assign(new Error("diagnostic write failed"), { code: "EPIPE" }); };',
    ] : []),
  ].join("\n"));
  const reader = [
    'process.stdin.on("readable", () => {',
    '  const prefix = process.stdin.read(65536);',
    '  if (prefix !== null) {',
    '    process.stdin.removeAllListeners("readable");',
    '    process.stdout.write(prefix);',
    '    process.stdin.destroy();',
    '  }',
    '});',
  ].join("\n");
  const consumer = spawn(process.execPath, ["-e", reader], {
    stdio: ["pipe", "pipe", "pipe"], timeout: 10000,
  });
  const producer = spawn(process.execPath, ["--require", monitor, CLI, ...args], {
    stdio: ["ignore", consumer.stdin, consumer.stdin], timeout: 10000,
  });
  for (const child of [producer, consumer]) {
    t.after(() => { if (child.exitCode === null && child.signalCode === null) child.kill(); });
  }
  const closedProducer = once(producer, "close");
  const closedConsumer = once(consumer, "close");
  // The producer owns its duplicated descriptors; close the parent's copy.
  consumer.stdin.destroy();
  const chunks = [];
  let stderr = "";
  consumer.stdout.on("data", (chunk) => { chunks.push(chunk); });
  consumer.stderr.setEncoding("utf8").on("data", (chunk) => { stderr += chunk; });
  const [[producerStatus, producerSignal], [consumerStatus, consumerSignal]] =
    await Promise.all([closedProducer, closedConsumer]);
  assert.equal(producerSignal, null);
  assert.equal(consumerSignal, null);
  assert.equal(consumerStatus, 0, "reader status alone does not prove producer success");
  assert.equal(producerStatus, 3, "failed diagnostic must not replace output-failure status");
  assert.equal(stderr, "");
  const prefix = Buffer.concat(chunks);
  assert.equal(prefix.length, 65536);
  assert.ok(Buffer.byteLength(expected) > prefix.length);
  assert.deepEqual(prefix, Buffer.from(expected).subarray(0, 65536));
  assert.equal(readFileSync(observed, "utf8"), "ready\n", "monitor must load and observe no uncaught exception");
}

for (const json of [false, true]) {
  test("comparison " + (json ? "JSON" : "text") + " reports early-close failure and fully drains large output", async (t) => {
    const row = parcel("large", { service: "x".repeat(1024 * 1024) });
    const { files } = fixture(t, [], [row]);
    const expected = json ? JSON.stringify({
      valid: true,
      inputs: { before: inputInfo(files[0], 0), after: inputInfo(files[1], 1) },
      errors: [], comparison: { added: [row], removed: [], changed: [], unchanged: 0 },
    }, null, 2) + "\n" : [
      "Comparing " + JSON.stringify(files[0]) + " -> " + JSON.stringify(files[1]),
      "Parcels: 0 before, 1 after.", "Added: 1",
      '  "large": "GB" / ' + JSON.stringify(row.service) + " (2 items)",
      "Removed: 0", "Changed: 0", "Unchanged: 0", "",
    ].join("\n");
    const args = [...(json ? ["--json"] : []), ...files];
    await closeAfterPrefix(t, args, expected);
    await t.test("merged stdout/stderr retains exit 3 without a secondary exception", async (t) => {
      await closeMergedAfterPrefix(t, args, expected, false);
    });
    await t.test("synchronous diagnostic failure retains exit 3 without a secondary exception", async (t) => {
      await closeMergedAfterPrefix(t, args, expected, true);
    });
    const drained = run(args, { maxBuffer: 8 * 1024 * 1024 });
    assert.equal(drained.status, 0);
    assert.equal(drained.stderr, "");
    assert.equal(Buffer.byteLength(drained.stdout), Buffer.byteLength(expected));
    assert.equal(drained.stdout, expected, "draining reader must receive the entire exact report");
  });
}
