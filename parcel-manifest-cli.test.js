"use strict";

const test = require("node:test");
const assert = require("node:assert/strict");
const { spawnSync } = require("node:child_process");
const { mkdtempSync, writeFileSync, rmSync } = require("node:fs");
const { tmpdir } = require("node:os");
const { join } = require("node:path");

const CLI = join(__dirname, "parcel-manifest-cli.js");
const PARCEL = {
  id: "P-1", recipient: "Alex Example", street: "10 Example Street",
  postcode: "SW1A 1AA", destination: "GB", service: "standard", itemCount: 2,
};
const MIXED = [
  { ...PARCEL, id: "US-1", destination: "us", service: " Standard " },
  { ...PARCEL, id: "bad", recipient: "", itemCount: 0 },
  null,
  { ...PARCEL, id: "GB-1", service: "Express" },
  { ...PARCEL, id: "GB-2" },
];
const SUMMARY = {
  byDestination: [{ destination: "GB", parcels: 2 }, { destination: "US", parcels: 1 }],
  byService: [{ service: "express", parcels: 1 }, { service: "standard", parcels: 2 }],
  byDestinationAndService: [
    { destination: "GB", service: "express", parcels: 1 },
    { destination: "GB", service: "standard", parcels: 1 },
    { destination: "US", service: "standard", parcels: 1 },
  ],
};

function run(args, input = "", options = {}) {
  const result = spawnSync(process.execPath, [CLI, ...args], {
    input, encoding: "utf8", timeout: 10000, ...options,
  });
  assert.ifError(result.error);
  assert.equal(result.signal, null);
  return result;
}

function tempDirectory(t) {
  const directory = mkdtempSync(join(tmpdir(), "parcel-manifest-test-"));
  t.after(() => rmSync(directory, { recursive: true, force: true }));
  return directory;
}

test("CLI reads a JSON file and emits a human-readable summary", (t) => {
  const path = join(tempDirectory(t), "manifest with spaces.json");
  writeFileSync(path, JSON.stringify([PARCEL]));
  const result = run([path]);
  assert.equal(result.status, 0);
  assert.equal(result.stderr, "");
  assert.equal(result.stdout, [
    "Parcels: 1 total, 1 valid, 0 invalid.",
    "Summary (valid parcels only):",
    "By destination:", '  "GB": 1',
    "By service:", '  "standard": 1',
    "By destination and service:", '  "GB" / "standard": 1', "",
  ].join("\n"));
});

test("CLI --json emits exactly one report for a valid file", (t) => {
  const path = join(tempDirectory(t), "manifest.json");
  writeFileSync(path, JSON.stringify([PARCEL]));
  const result = run(["--json", path]);
  assert.equal(result.status, 0);
  assert.equal(result.stderr, "");
  assert.deepEqual(JSON.parse(result.stdout), {
    valid: true, totalRows: 1, validRows: 1, invalidRows: 0, errors: [],
    summary: {
      byDestination: [{ destination: "GB", parcels: 1 }],
      byService: [{ service: "standard", parcels: 1 }],
      byDestinationAndService: [{ destination: "GB", service: "standard", parcels: 1 }],
    },
  });
});

test("CLI mixed input keeps a partial summary and one-based diagnostics on stderr", () => {
  const result = run(["-"], JSON.stringify(MIXED));
  assert.equal(result.status, 1);
  assert.match(result.stdout, /^Parcels: 5 total, 3 valid, 2 invalid\./);
  assert.match(result.stdout, /By destination:\n  "GB": 2\n  "US": 1\n/);
  assert.match(result.stdout, /By service:\n  "express": 1\n  "standard": 2\n/);
  assert.deepEqual(result.stderr.trim().split("\n").map((line) => line.split(":")[0]),
    ["Row 2 [recipient]", "Row 2 [itemCount]", "Row 3 [$]"]);
  assert.match(result.stderr, /provide a non-empty string/);
  assert.match(result.stderr, /positive safe integer/);
  assert.doesNotMatch(result.stdout, /Row \d/);
});

test("CLI --json mixed input reports errors and partial totals with exit status 1", () => {
  const input = JSON.stringify(MIXED);
  const result = run(["--json", "-"], input);
  assert.equal(result.status, 1);
  assert.equal(result.stderr, "");
  const report = JSON.parse(result.stdout);
  assert.equal(report.valid, false);
  assert.equal(report.totalRows, 5);
  assert.equal(report.validRows, 3);
  assert.equal(report.invalidRows, 2);
  assert.deepEqual(report.errors.map(({ row, field }) => [row, field]),
    [[2, "recipient"], [2, "itemCount"], [3, "$"]]);
  assert.deepEqual(report.summary, SUMMARY);
  assert.equal(run(["-", "--json"], input).stdout, result.stdout);
  assert.equal(run(["--json", "-"], input).stdout, result.stdout);
});

test("CLI summaries are deterministic across row order in text and JSON modes", () => {
  const forward = JSON.stringify(MIXED);
  const reverse = JSON.stringify([...MIXED].reverse());
  const first = run(["--json", "-"], forward);
  const second = run(["--json", "-"], reverse);
  assert.equal(first.status, 1);
  assert.equal(second.status, 1);
  assert.deepEqual(JSON.parse(first.stdout).summary, SUMMARY);
  assert.deepEqual(JSON.parse(second.stdout).summary, SUMMARY);
  assert.deepEqual(JSON.parse(second.stdout).errors.map(({ row, field }) => [row, field]),
    [[3, "$"], [4, "recipient"], [4, "itemCount"]]);
  assert.equal(run(["-"], forward).stdout, run(["-"], reverse).stdout);
  const valid = MIXED.filter((row, index) => row !== null && index !== 1);
  assert.equal(run(["--json", "-"], JSON.stringify(valid)).stdout,
    run(["--json", "-"], JSON.stringify([...valid].reverse())).stdout);
});

test("CLI malformed JSON and invalid roots produce structured document errors", () => {
  for (const input of ["", "[", '[{"id":}]', "null", "{}", "true"]) {
    const result = run(["--json", "-"], input);
    assert.equal(result.status, 1);
    assert.equal(result.stderr, "");
    const report = JSON.parse(result.stdout);
    assert.equal(report.valid, false);
    assert.equal(report.totalRows, 0);
    assert.equal(report.errors.length, 1);
    assert.equal(report.errors[0].row, null);
    assert.equal(report.errors[0].field, "$");
    assert.deepEqual(report.summary, { byDestination: [], byService: [], byDestinationAndService: [] });
  }
  const text = run(["-"], "[");
  assert.equal(text.status, 1);
  assert.match(text.stderr, /^Manifest \[\$\]: Invalid JSON:/);
  assert.doesNotMatch(text.stderr, /at (main|parseManifest)/);
  assert.match(text.stdout, /No valid parcels/);
});

test("CLI accepts empty arrays and rejects all-invalid arrays", () => {
  const empty = run(["--json", "-"], "[]");
  assert.equal(empty.status, 0);
  assert.equal(JSON.parse(empty.stdout).validRows, 0);
  const invalid = run(["--json", "-"], "[null, {}, 3]");
  assert.equal(invalid.status, 1);
  const report = JSON.parse(invalid.stdout);
  assert.equal(report.validRows, 0);
  assert.equal(report.invalidRows, 3);
  assert.deepEqual([...new Set(report.errors.map(({ row }) => row))], [1, 2, 3]);
  assert.deepEqual(report.summary.byDestinationAndService, []);
});

test("CLI excludes every duplicate ID independent of input order", () => {
  const rows = [{ ...PARCEL }, { ...PARCEL, service: "express" }];
  const result = run(["--json", "-"], JSON.stringify(rows));
  assert.equal(result.status, 1);
  const report = JSON.parse(result.stdout);
  assert.equal(report.validRows, 0);
  assert.deepEqual(report.errors.map(({ row, field }) => [row, field]), [[1, "id"], [2, "id"]]);
  assert.deepEqual(report.summary.byService, []);
});

test("CLI help succeeds without reading input", () => {
  for (const flag of ["--help", "-h"]) {
    const result = run([flag]);
    assert.equal(result.status, 0);
    assert.equal(result.stderr, "");
    assert.match(result.stdout, /^Usage:/);
    assert.match(result.stdout, /--json/);
    assert.match(result.stdout, /--destination/);
    assert.match(result.stdout, /--service/);
  }
});

test("CLI invalid arguments fail with usage status 2", () => {
  for (const args of [[], ["--json"], ["--unknown"], ["one.json", "two.json"], ["--"], [""]]) {
    const result = run(args);
    assert.equal(result.status, 2);
    assert.equal(result.stdout, "");
    assert.match(result.stderr, /^Error:/);
    assert.match(result.stderr, /Usage:/);
  }
});

test("CLI missing files produce read errors, including in JSON mode", (t) => {
  const path = join(tempDirectory(t), "missing.json");
  for (const args of [[path], ["--json", path]]) {
    const result = run(args);
    assert.equal(result.status, 2);
    assert.equal(result.stdout, "");
    assert.match(result.stderr, /cannot read .*ENOENT/);
    assert.doesNotMatch(result.stderr, /at main/);
  }
});

test("CLI -- allows filenames beginning with a dash", (t) => {
  const cwd = tempDirectory(t);
  writeFileSync(join(cwd, "--manifest.json"), JSON.stringify([PARCEL]));
  const result = run(["--json", "--", "--manifest.json"], "", { cwd });
  assert.equal(result.status, 0);
  assert.equal(JSON.parse(result.stdout).validRows, 1);
});

test("CLI escapes control characters in human-readable grouping keys", () => {
  const result = run(["-"], JSON.stringify([{ ...PARCEL, service: "express\nfake\tgroup" }]));
  assert.equal(result.status, 0);
  assert.ok(result.stdout.includes('"express\\nfake\\tgroup": 1'));
  assert.ok(!result.stdout.includes("express\nfake"));
});

test("requiring the CLI does not run it or write output", () => {
  const result = spawnSync(process.execPath, ["-e", "require(" + JSON.stringify(CLI) + ")"], {
    encoding: "utf8", timeout: 10000,
  });
  assert.ifError(result.error);
  assert.equal(result.status, 0);
  assert.equal(result.stdout, "");
  assert.equal(result.stderr, "");
});


test("documented example files produce the promised counts and diagnostics", () => {
  const valid = run(["--json", join(__dirname, "examples", "manifest.json")]);
  assert.equal(valid.status, 0);
  assert.equal(valid.stderr, "");
  assert.equal(JSON.parse(valid.stdout).validRows, 3);
  assert.deepEqual(JSON.parse(valid.stdout).summary, SUMMARY);
  const mixed = run(["--json", join(__dirname, "examples", "manifest-mixed.json")]);
  assert.equal(mixed.status, 1);
  assert.equal(mixed.stderr, "");
  const report = JSON.parse(mixed.stdout);
  assert.equal(report.totalRows, 5);
  assert.equal(report.validRows, 3);
  assert.equal(report.invalidRows, 2);
  assert.deepEqual(report.summary, SUMMARY);
  assert.deepEqual(report.errors.map(({ row, field }) => [row, field]),
    [[2, "recipient"], [2, "itemCount"], [3, "$"]]);
});


const EMPTY_SUMMARY = { byDestination: [], byService: [], byDestinationAndService: [] };
const FILTER_CASES = [
  {
    name: "destination", args: ["--destination", " gb "], filters: { destination: "GB" },
    summary: {
      byDestination: [{ destination: "GB", parcels: 2 }],
      byService: [{ service: "express", parcels: 1 }, { service: "standard", parcels: 1 }],
      byDestinationAndService: SUMMARY.byDestinationAndService.slice(0, 2),
    },
  },
  {
    name: "service", args: ["--service", " STANDARD "], filters: { service: "standard" },
    summary: {
      byDestination: [{ destination: "GB", parcels: 1 }, { destination: "US", parcels: 1 }],
      byService: [{ service: "standard", parcels: 2 }],
      byDestinationAndService: SUMMARY.byDestinationAndService.slice(1),
    },
  },
  {
    name: "combined", args: ["--destination", "gb", "--service", "Standard"],
    filters: { destination: "GB", service: "standard" },
    summary: {
      byDestination: [{ destination: "GB", parcels: 1 }],
      byService: [{ service: "standard", parcels: 1 }],
      byDestinationAndService: [{ destination: "GB", service: "standard", parcels: 1 }],
    },
  },
  {
    name: "unmatched destination", args: ["--destination", "CA"],
    filters: { destination: "CA" }, summary: EMPTY_SUMMARY,
  },
  {
    name: "unmatched service", args: ["--service", "overnight"],
    filters: { service: "overnight" }, summary: EMPTY_SUMMARY,
  },
  {
    name: "unmatched combination", args: ["--destination", "US", "--service", "express"],
    filters: { destination: "US", service: "express" }, summary: EMPTY_SUMMARY,
  },
];

for (const scenario of FILTER_CASES) {
  test("CLI " + scenario.name + " filter affects only summary counts in both modes", () => {
    const input = JSON.stringify(MIXED);
    const baseline = run(["--json", "-"], input);
    const result = run(["--json", ...scenario.args, "-"], input);
    assert.equal(result.status, baseline.status);
    assert.equal(result.status, 1);
    assert.equal(result.stderr, "");
    assert.deepEqual(JSON.parse(result.stdout), {
      ...JSON.parse(baseline.stdout), filters: scenario.filters, summary: scenario.summary,
    });

    const baselineText = run(["-"], input);
    const text = run([...scenario.args, "-"], input);
    assert.equal(text.status, 1);
    assert.equal(text.stderr, baselineText.stderr);
    assert.equal(text.stdout, [
      "Parcels: 5 total, 3 valid, 2 invalid.",
      "Filters: " + Object.entries(scenario.filters)
        .map(([key, value]) => key + "=" + JSON.stringify(value)).join(", "),
      "Summary (matching valid parcels only):",
      "By destination:",
      ...scenario.summary.byDestination.map(({ destination, parcels }) =>
        "  " + JSON.stringify(destination) + ": " + parcels),
      "By service:",
      ...scenario.summary.byService.map(({ service, parcels }) =>
        "  " + JSON.stringify(service) + ": " + parcels),
      "By destination and service:",
      ...scenario.summary.byDestinationAndService.map(({ destination, service, parcels }) =>
        "  " + JSON.stringify(destination) + " / " + JSON.stringify(service) + ": " + parcels),
      ...(scenario.summary.byDestination.length === 0 ? ["  No valid parcels match the filters."] : []),
      "",
    ].join("\n"));
  });
}

test("CLI valid inputs keep exit status 0 for matching and empty filtered summaries", () => {
  for (const input of [JSON.stringify([PARCEL]), "[]"]) {
    for (const destination of ["GB", "US"]) {
      for (const mode of [[], ["--json"]]) {
        const result = run([...mode, "--destination", destination, "-"], input);
        assert.equal(result.status, 0);
        assert.equal(result.stderr, "");
        if (mode.length) {
          const report = JSON.parse(result.stdout);
          assert.equal(report.valid, true);
          assert.equal(report.totalRows, JSON.parse(input).length);
          assert.equal(report.validRows, JSON.parse(input).length);
          assert.equal(report.invalidRows, 0);
          assert.deepEqual(report.errors, []);
          if (destination === "US" || input === "[]") assert.deepEqual(report.summary, EMPTY_SUMMARY);
        }
      }
    }
  }
});

test("CLI filters never hide duplicate-ID errors outside the selected destination", () => {
  const input = JSON.stringify([
    { ...PARCEL, destination: "GB" }, { ...PARCEL, destination: "US" },
    { ...PARCEL, id: "other", destination: "CA" },
  ]);
  const result = run(["--json", "--destination", "GB", "-"], input);
  assert.equal(result.status, 1);
  const report = JSON.parse(result.stdout);
  assert.equal(report.totalRows, 3);
  assert.equal(report.validRows, 1);
  assert.equal(report.invalidRows, 2);
  assert.deepEqual(report.errors.map(({ row, field }) => [row, field]), [[1, "id"], [2, "id"]]);
  assert.deepEqual(report.summary, EMPTY_SUMMARY);
});

test("CLI malformed and all-invalid manifests retain diagnostics with filters", () => {
  for (const input of ["[", "null", "{}", "[null, {}]"]) {
    const baseline = JSON.parse(run(["--json", "-"], input).stdout);
    const filtered = run(["--json", "--service", "express", "-"], input);
    assert.equal(filtered.status, 1);
    assert.equal(filtered.stderr, "");
    assert.deepEqual(JSON.parse(filtered.stdout), { ...baseline, filters: { service: "express" } });
    const text = run(["--service", "express", "-"], input);
    assert.equal(text.status, 1);
    assert.equal(text.stderr, run(["-"], input).stderr);
    assert.match(text.stdout, /No valid parcels match the filters/);
  }
});

test("CLI filter syntax and option order produce the same deterministic JSON report", () => {
  const input = JSON.stringify(MIXED);
  const expected = run(["--json", "--destination", "GB", "--service", "standard", "-"], input);
  const alternate = run(["-", "--service= Standard ", "--json", "--destination= gb "], input);
  assert.equal(alternate.status, 1);
  assert.equal(alternate.stdout, expected.stdout);
  const reversed = run(["--service=standard", "--destination=gb", "--json", "-"],
    JSON.stringify([...MIXED].reverse()));
  assert.deepEqual(JSON.parse(reversed.stdout).summary, JSON.parse(expected.stdout).summary);
  const serviceOnly = run(["--service=standard", "--json", "-"], input);
  const serviceReversed = run(["--service=standard", "--json", "-"], JSON.stringify([...MIXED].reverse()));
  assert.deepEqual(JSON.parse(serviceOnly.stdout).summary, FILTER_CASES[1].summary);
  assert.deepEqual(JSON.parse(serviceReversed.stdout).summary, FILTER_CASES[1].summary);
});

test("CLI filters preserve aggregated parcel counts greater than one", () => {
  const input = JSON.stringify([
    { ...PARCEL, id: "one" }, { ...PARCEL, id: "two" },
    { ...PARCEL, id: "three", service: "express" },
  ]);
  const result = run(["--json", "--destination=GB", "--service=standard", "-"], input);
  assert.equal(result.status, 0);
  assert.deepEqual(JSON.parse(result.stdout).summary, {
    byDestination: [{ destination: "GB", parcels: 2 }],
    byService: [{ service: "standard", parcels: 2 }],
    byDestinationAndService: [{ destination: "GB", service: "standard", parcels: 2 }],
  });
});

test("CLI rejects missing, blank, and malformed filter values, including repeated options", () => {
  for (const args of [
    ["--destination"], ["--service"], ["--destination", "--json", "-"],
    ["--service", "-"], ["--destination=", "-"], ["--service=", "-"],
    ["--service", " \t ", "-"], ["--destination", "GBR", "-"],
    ["--destination=G1", "-"], ["--destination=éé", "-"],
    ["--destination=GB", "--destination", " ", "-"],
    ["--service=express", "--service=", "-"],
    ["--destination=GB", "--destination=GBR", "-"],
  ]) {
    const result = run(["--json", ...args], JSON.stringify([PARCEL]));
    assert.equal(result.status, 2, JSON.stringify(args));
    assert.equal(result.stdout, "");
    assert.match(result.stderr, /^Error:.*--(destination|service)/);
    assert.match(result.stderr, /Usage:/);
  }
});

test("CLI service filtering uses exact names and safely handles special characters", () => {
  for (const service of ["__proto__", "--priority", "next day", "tier=1", "express\npriority"]) {
    const input = JSON.stringify([{ ...PARCEL, service }]);
    const result = run(["--json", "--service=" + service, "-"], input);
    assert.equal(result.status, 0);
    assert.equal(JSON.parse(result.stdout).summary.byService[0].parcels, 1);
    const text = run(["--service=" + service, "-"], input);
    assert.equal(text.status, 0);
    assert.ok(text.stdout.includes("Filters: service=" + JSON.stringify(service)));
  }
  const noSubstring = run(["--json", "--service=stand", "-"], JSON.stringify([PARCEL]));
  assert.equal(noSubstring.status, 0);
  assert.deepEqual(JSON.parse(noSubstring.stdout).summary, EMPTY_SUMMARY);
});

test("CLI accepts filters with files and respects the positional-only delimiter", (t) => {
  const path = join(__dirname, "examples", "manifest-mixed.json");
  const result = run(["--json", path, "--destination=gb", "--service=standard"]);
  assert.equal(result.status, 1);
  assert.deepEqual(JSON.parse(result.stdout).summary, FILTER_CASES[2].summary);
  const cwd = tempDirectory(t);
  writeFileSync(join(cwd, "--destination=GB"), JSON.stringify([PARCEL]));
  const positional = run(["--json", "--service=standard", "--", "--destination=GB"], "", { cwd });
  assert.equal(positional.status, 0);
  assert.deepEqual(JSON.parse(positional.stdout).filters, { service: "standard" });
});


const MULTI_ROUTE_ROWS = [
  ["GB", "standard"], ["GB", "standard"], ["GB", "express"],
  ["US", "standard"], ["US", "overnight"], ["CA", "express"], ["DE", "priority"],
].map(([destination, service], index) => ({ ...PARCEL, id: "route-" + index, destination, service }));
const MULTI_ROUTE_INPUT = JSON.stringify([
  ...MULTI_ROUTE_ROWS, null,
  { ...PARCEL, id: "invalid", destination: "AU", service: "unknown", itemCount: 0 },
]);

const MULTI_FILTER_CASES = [
  {
    name: "repeated destinations use OR",
    args: ["--destination", " us ", "--destination=gb"],
    filters: { destination: ["GB", "US"] },
    summary: {
      byDestination: [{ destination: "GB", parcels: 3 }, { destination: "US", parcels: 2 }],
      byService: [
        { service: "express", parcels: 1 }, { service: "overnight", parcels: 1 },
        { service: "standard", parcels: 3 },
      ],
      byDestinationAndService: [
        { destination: "GB", service: "express", parcels: 1 },
        { destination: "GB", service: "standard", parcels: 2 },
        { destination: "US", service: "overnight", parcels: 1 },
        { destination: "US", service: "standard", parcels: 1 },
      ],
    },
  },
  {
    name: "repeated services use OR",
    args: ["--service= STANDARD ", "--service", " Express "],
    filters: { service: ["express", "standard"] },
    summary: {
      byDestination: [
        { destination: "CA", parcels: 1 }, { destination: "GB", parcels: 3 },
        { destination: "US", parcels: 1 },
      ],
      byService: [{ service: "express", parcels: 2 }, { service: "standard", parcels: 3 }],
      byDestinationAndService: [
        { destination: "CA", service: "express", parcels: 1 },
        { destination: "GB", service: "express", parcels: 1 },
        { destination: "GB", service: "standard", parcels: 2 },
        { destination: "US", service: "standard", parcels: 1 },
      ],
    },
  },
  {
    name: "repeated destination and service groups use AND",
    args: ["--destination=us", "--destination=GB", "--service=standard", "--service=express"],
    filters: { destination: ["GB", "US"], service: ["express", "standard"] },
    summary: {
      byDestination: [{ destination: "GB", parcels: 3 }, { destination: "US", parcels: 1 }],
      byService: [{ service: "express", parcels: 1 }, { service: "standard", parcels: 3 }],
      byDestinationAndService: [
        { destination: "GB", service: "express", parcels: 1 },
        { destination: "GB", service: "standard", parcels: 2 },
        { destination: "US", service: "standard", parcels: 1 },
      ],
    },
  },
  {
    name: "repeated groups with no intersection have empty summaries",
    args: ["--destination=CA", "--destination=DE", "--service=standard", "--service=overnight"],
    filters: { destination: ["CA", "DE"], service: ["overnight", "standard"] },
    summary: EMPTY_SUMMARY,
  },
];

for (const scenario of MULTI_FILTER_CASES) {
  test("CLI " + scenario.name + " in text and JSON", () => {
    const baseline = JSON.parse(run(["--json", "-"], MULTI_ROUTE_INPUT).stdout);
    const result = run(["--json", ...scenario.args, "-"], MULTI_ROUTE_INPUT);
    assert.equal(result.status, 1);
    assert.equal(result.stderr, "");
    const report = JSON.parse(result.stdout);
    assert.deepEqual(report, { ...baseline, filters: scenario.filters, summary: scenario.summary });
    assert.deepEqual(report.errors.map(({ row, field }) => [row, field]), [[8, "$"], [9, "itemCount"]]);
    const text = run([...scenario.args, "-"], MULTI_ROUTE_INPUT);
    assert.equal(text.status, 1);
    assert.equal(text.stderr, run(["-"], MULTI_ROUTE_INPUT).stderr);
    assert.match(text.stdout, /^Parcels: 9 total, 7 valid, 2 invalid\./);
    assert.ok(text.stdout.includes("Filters: " + Object.entries(scenario.filters)
      .map(([key, value]) => key + "=" + JSON.stringify(value)).join(", ")));
    const expectedSummary = [
      "Summary (matching valid parcels only):",
      "By destination:",
      ...scenario.summary.byDestination.map(({ destination, parcels }) => '  "' + destination + '": ' + parcels),
      "By service:",
      ...scenario.summary.byService.map(({ service, parcels }) => '  "' + service + '": ' + parcels),
      "By destination and service:",
      ...scenario.summary.byDestinationAndService.map(({ destination, service, parcels }) =>
        '  "' + destination + '" / "' + service + '": ' + parcels),
      ...(scenario.summary.byDestination.length ? [] : ["  No valid parcels match the filters."]),
      "",
    ].join("\n");
    assert.ok(text.stdout.endsWith(expectedSummary));
    // The same filters must not turn an entirely valid input into a failure.
    const valid = run(["--json", ...scenario.args, "-"], JSON.stringify(MULTI_ROUTE_ROWS));
    assert.equal(valid.status, 0);
    assert.deepEqual(JSON.parse(valid.stdout).summary, scenario.summary);
  });
}

test("CLI duplicate normalized filters do not double-count or change single-value output", () => {
  const single = ["--destination=GB", "--service=standard", "-"];
  const duplicate = [
    "--destination", " gb ", "--service", " STANDARD ",
    "--destination=GB", "--destination=Gb", "--service=standard", "-",
  ];
  for (const mode of [[], ["--json"]]) {
    const expected = run([...mode, ...single], MULTI_ROUTE_INPUT);
    const actual = run([...mode, ...duplicate], MULTI_ROUTE_INPUT);
    assert.equal(actual.status, 1);
    assert.equal(actual.stdout, expected.stdout);
    assert.equal(actual.stderr, expected.stderr);
  }
  const report = JSON.parse(run(["--json", ...duplicate], MULTI_ROUTE_INPUT).stdout);
  assert.deepEqual(report.filters, { destination: "GB", service: "standard" });
  assert.deepEqual(report.summary.byDestinationAndService, [
    { destination: "GB", service: "standard", parcels: 2 },
  ]);
});

test("CLI repeated filters are deduplicated and ordered independently of option order", () => {
  const canonical = MULTI_FILTER_CASES[2].args;
  const reordered = [
    "--service", " Express ", "--destination", " gb ", "--service=standard",
    "--destination=US", "--service=EXPRESS", "--destination=gb", "--service=STANDARD",
  ];
  for (const mode of [[], ["--json"]]) {
    const expected = run([...mode, ...canonical, "-"], MULTI_ROUTE_INPUT);
    const actual = run([...mode, ...reordered, "-"], MULTI_ROUTE_INPUT);
    assert.equal(actual.stdout, expected.stdout);
    assert.equal(actual.stderr, expected.stderr);
    assert.equal(actual.status, expected.status);
  }
  const reversedInput = JSON.stringify([...JSON.parse(MULTI_ROUTE_INPUT)].reverse());
  const reversed = run(["--json", ...reordered, "-"], reversedInput);
  assert.deepEqual(JSON.parse(reversed.stdout).summary, MULTI_FILTER_CASES[2].summary);
  assert.deepEqual(JSON.parse(reversed.stdout).filters, MULTI_FILTER_CASES[2].filters);
});

test("CLI empty repeated filters have actionable usage errors in either report mode", () => {
  for (const [flag, valid] of [["--destination", "GB"], ["--service", "standard"]]) {
    for (const invalid of [[flag + "="], [flag, " \t\n "], [flag]]) {
      for (const mode of [[], ["--json"]]) {
        const result = run([...mode, "-", flag, valid, ...invalid], MULTI_ROUTE_INPUT);
        assert.equal(result.status, 2);
        assert.equal(result.stdout, "");
        assert.ok(result.stderr.startsWith("Error: " + flag + " requires a non-empty value"));
        assert.match(result.stderr, /Usage:/);
      }
    }
  }
});

test("CLI repeated filters work with manifest files", () => {
  const path = join(__dirname, "examples", "manifest.json");
  const result = run(["--json", "--destination=gb", path, "--destination=US", "--service=express", "--service=standard"]);
  assert.equal(result.status, 0);
  assert.equal(result.stderr, "");
  assert.deepEqual(JSON.parse(result.stdout).summary, SUMMARY);
  assert.deepEqual(JSON.parse(result.stdout).filters, MULTI_FILTER_CASES[2].filters);
});


test("CLI duplicate-heavy input emits bounded diagnostics and preserves its valid subset", () => {
  const input = JSON.stringify([
    ...Array.from({ length: 500 }, () => ({ ...PARCEL, id: "duplicate" })),
    { ...PARCEL, id: "unique", destination: "US" },
  ]);
  const result = run(["--json", "-"], input);
  assert.equal(result.status, 1);
  assert.equal(result.stderr, "");
  assert.ok(result.stdout.length < 150000);
  const report = JSON.parse(result.stdout);
  assert.equal(report.totalRows, 501);
  assert.equal(report.validRows, 1);
  assert.equal(report.invalidRows, 500);
  assert.equal(report.errors.length, 500);
  assert.deepEqual(report.errors.map(({ row }) => row), Array.from({ length: 500 }, (_, index) => index + 1));
  assert.deepEqual(report.summary.byDestination, [{ destination: "US", parcels: 1 }]);
});

test("CLI malformed JSON cannot inject terminal escape sequences into diagnostics", () => {
  const input = "\u001b[2J";
  const text = run(["-"], input);
  assert.equal(text.status, 1);
  assert.match(text.stderr, /^Manifest \[\$\]: Invalid JSON:/);
  assert.doesNotMatch(text.stderr, /[\u0000-\u0009\u000b-\u001f\u007f-\u009f]/);
  const json = run(["--json", "-"], input);
  assert.equal(json.status, 1);
  assert.equal(json.stderr, "");
  assert.doesNotMatch(JSON.parse(json.stdout).errors[0].message, /[\u0000-\u001f\u007f-\u009f]/);
});
