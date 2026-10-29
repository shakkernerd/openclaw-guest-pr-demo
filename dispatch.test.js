"use strict";

const test = require("node:test");
const assert = require("node:assert/strict");
const { spawnSync } = require("node:child_process");
const { mkdtempSync, readFileSync, writeFileSync, rmSync } = require("node:fs");
const { tmpdir } = require("node:os");
const { join } = require("node:path");
const { planDispatch, formatReport } = require("./dispatch-planner.js");

const command = join(__dirname, "dispatch.js");
const examplePath = join(__dirname, "examples", "morning-dispatch.json");
const example = JSON.parse(readFileSync(examplePath, "utf8"));
const delivery = (id, priority = "normal") => ({ id, priority, address: id + " Example Road" });
const batch = () => ({ deliveries: [delivery("D1")], couriers: [{ id: "C1", capacity: 1 }] });
const ids = (deliveries) => deliveries.map((item) => item.id);

function cli(args, input, cwd = __dirname) {
  const result = spawnSync(process.execPath, [command, ...args], {
    input, cwd, encoding: "utf8", timeout: 5000,
  });
  assert.ifError(result.error);
  assert.equal(result.signal, null);
  return result;
}

function success(result) {
  assert.equal(result.status, 0, result.stderr);
  assert.equal(result.stderr, "");
}

function failure(result, message) {
  assert.equal(result.status, 1);
  assert.equal(result.stdout, "", "invalid batches must never produce a partial plan");
  assert.match(result.stderr, /^Error: /);
  assert.match(result.stderr, message);
  assert.doesNotMatch(result.stderr, /at main|at planDispatch/);
}

test("actual command produces the full synthetic plan as JSON", () => {
  const result = cli([examplePath, "--json"]);
  success(result);
  const plan = JSON.parse(result.stdout);
  const byId = (id) => example.deliveries.find((item) => item.id === id);
  assert.deepEqual(plan, {
    summary: { totalDeliveries: 6, assignedDeliveries: 5, unassignedDeliveries: 1 },
    couriers: [
      { id: "bike-01", name: "Alex", capacity: 2, assignedCount: 2, remainingCapacity: 0,
        deliveries: [byId("E11-101"), byId("E11-104")] },
      { id: "bike-02", name: "Morgan", capacity: 2, assignedCount: 2, remainingCapacity: 0,
        deliveries: [byId("E11-102"), byId("E11-105")] },
      { id: "van-01", name: "Sam", capacity: 1, assignedCount: 1, remainingCapacity: 0,
        deliveries: [byId("E11-103")] },
    ],
    unassigned: [{ ...byId("E11-106"), reason: "capacity_exhausted" }],
  });
});

test("actual command gives an operator a readable report with explicit overflow", () => {
  const result = cli([examplePath]);
  success(result);
  assert.match(result.stdout, /^E11 Dispatch Desk\n6 deliveries \| 5 assigned \| 1 unassigned/);
  assert.match(result.stdout, /bike-01 \(Alex\): 2[/]2 stops used, 0 remaining/);
  assert.match(result.stdout, /\[URGENT\] E11-101:/);
  assert.match(result.stdout, /Unassigned \(1\)\n  - \[NORMAL\] E11-106:.*no courier capacity available/);
  for (const item of example.deliveries) {
    assert.equal(result.stdout.split(item.id + ":").length - 1, 1);
    assert.ok(result.stdout.includes(item.address));
    assert.ok(result.stdout.includes(item.notes));
  }
});

test("stdin, repeat runs, and reordered input produce the same plan", () => {
  const file = cli(["--json", examplePath]);
  const stdin = cli(["--json", "-"], JSON.stringify(example));
  const shuffled = cli(["-", "--json"], JSON.stringify({
    deliveries: [...example.deliveries].reverse(),
    couriers: [...example.couriers].reverse(),
  }));
  const repeated = cli(["--json", examplePath]);
  for (const result of [file, stdin, shuffled, repeated]) success(result);
  assert.equal(stdin.stdout, file.stdout);
  assert.equal(shuffled.stdout, file.stdout);
  assert.equal(repeated.stdout, file.stdout);
});

test("urgent deliveries beat normal IDs and urgency ties use delivery ID", () => {
  const plan = planDispatch({
    deliveries: [delivery("A"), delivery("Z", "urgent"), delivery("Y", "urgent"), delivery("B")],
    couriers: [{ id: "C", capacity: 1 }],
  });
  assert.deepEqual(ids(plan.couriers[0].deliveries), ["Y"]);
  assert.deepEqual(ids(plan.unassigned), ["Z", "A", "B"]);
});

test("least-loaded eligible courier wins; ID ties, zero and unequal capacities are respected", () => {
  const plan = planDispatch({
    deliveries: ["F", "E", "D", "C", "B", "A"].map((id) => delivery(id)),
    couriers: [{ id: "C", capacity: 3 }, { id: "B", capacity: 1 }, { id: "A", capacity: 0 }],
  });
  assert.deepEqual(plan.couriers.map((courier) => [courier.id, ids(courier.deliveries)]), [
    ["A", []], ["B", ["A"]], ["C", ["B", "C", "D"]],
  ]);
  assert.deepEqual(ids(plan.unassigned), ["E", "F"]);
});

test("ID comparison is case-sensitive and locale independent", () => {
  const plan = planDispatch({
    deliveries: ["é", "a", "Z", "A"].map((id) => delivery(id)),
    couriers: [{ id: "a", capacity: 2 }, { id: "Z", capacity: 2 }],
  });
  assert.deepEqual(plan.couriers.map((courier) => [courier.id, ids(courier.deliveries)]), [
    ["Z", ["A", "a"]], ["a", ["Z", "é"]],
  ]);
});

test("empty batches, no couriers, and zero capacity retain all work explicitly", () => {
  const empty = planDispatch({ deliveries: [], couriers: [] });
  assert.deepEqual(empty, {
    summary: { totalDeliveries: 0, assignedDeliveries: 0, unassignedDeliveries: 0 },
    couriers: [], unassigned: [],
  });
  assert.match(formatReport(empty), /Unassigned \(0\)\n  \(none\)/);
  assert.match(formatReport(empty), /none available/);
  for (const couriers of [[], [{ id: "C", capacity: 0 }]]) {
    const plan = planDispatch({ deliveries: [delivery("D")], couriers });
    assert.deepEqual(plan.unassigned, [{ ...delivery("D"), reason: "capacity_exhausted" }]);
  }
  const idle = planDispatch({ deliveries: [], couriers: [{ id: "C", capacity: 3 }] });
  assert.equal(idle.couriers[0].remainingCapacity, 3);
  assert.match(formatReport(idle), /no deliveries assigned/);
});

test("planning does not mutate input or share delivery objects with output", () => {
  const input = structuredClone(example);
  input.deliveries.forEach(Object.freeze);
  input.couriers.forEach(Object.freeze);
  Object.freeze(input.deliveries);
  Object.freeze(input.couriers);
  Object.freeze(input);
  const plan = planDispatch(input);
  plan.couriers[0].deliveries[0].address = "Changed";
  plan.unassigned[0].address = "Changed";
  assert.deepEqual(input, example);
});

test("capacity and conservation invariants across 192 synthetic batches", () => {
  for (let count = 0; count < 12; count += 1) {
    for (let left = 0; left < 4; left += 1) {
      for (let right = 0; right < 4; right += 1) {
        const input = {
          deliveries: Array.from({ length: count }, (_, i) => delivery("D" + i, i % 3 === 0 ? "urgent" : "normal")),
          couriers: [{ id: "C2", capacity: right }, { id: "C1", capacity: left }],
        };
        const plan = planDispatch(input);
        const assigned = plan.couriers.flatMap((courier) => courier.deliveries);
        assert.equal(assigned.length, Math.min(count, left + right));
        assert.equal(plan.summary.assignedDeliveries, assigned.length);
        assert.equal(plan.summary.unassignedDeliveries, count - assigned.length);
        assert.deepEqual(ids([...assigned, ...plan.unassigned]).sort(), ids(input.deliveries).sort());
        for (const courier of plan.couriers) {
          assert.equal(courier.assignedCount, courier.deliveries.length);
          assert.ok(courier.assignedCount <= courier.capacity);
          assert.equal(courier.remainingCapacity, courier.capacity - courier.assignedCount);
        }
        if (plan.unassigned.some((item) => item.priority === "urgent")) {
          assert.ok(assigned.every((item) => item.priority === "urgent"));
        }
      }
    }
  }
});

test("actual command handles empty input arrays and maximum safe capacity", () => {
  const empty = cli(["--json", "-"], '{"deliveries":[],"couriers":[]}');
  success(empty);
  assert.equal(JSON.parse(empty.stdout).summary.totalDeliveries, 0);
  const input = batch();
  input.couriers[0].capacity = Number.MAX_SAFE_INTEGER;
  const maximum = cli(["--json", "-"], JSON.stringify(input));
  success(maximum);
  assert.equal(JSON.parse(maximum.stdout).couriers[0].remainingCapacity, Number.MAX_SAFE_INTEGER - 1);
});

test("actual command rejects invalid schemas without dropping records", async (t) => {
  const cases = [
    ["null root", null, /batch: must be an object/],
    ["array root", [], /batch: must be an object/],
    ["missing deliveries", { couriers: [] }, /deliveries: must be an array/],
    ["missing couriers", { deliveries: [] }, /couriers: must be an array/],
    ["non-array deliveries", { ...batch(), deliveries: {} }, /deliveries: must be an array/],
    ["non-array couriers", { ...batch(), couriers: null }, /couriers: must be an array/],
    ["unknown batch field", { ...batch(), courier: [] }, /batch.courier: unknown field/],
    ["null delivery", { ...batch(), deliveries: [null] }, /deliveries\[0\]: must be an object/],
    ["null courier", { ...batch(), couriers: [null] }, /couriers\[0\]: must be an object/],
    ["duplicate delivery", { ...batch(), deliveries: [delivery("D"), delivery("D")] }, /deliveries\[1\].id: duplicate ID/],
    ["duplicate courier", { ...batch(), couriers: [{ id: "C", capacity: 1 }, { id: "C", capacity: 2 }] }, /couriers\[1\].id: duplicate ID/],
  ];
  for (const value of [undefined, "", "  ", 123, " D1", "D1\n", "D\u001b[31m"]) {
    const input = batch();
    input.deliveries[0].id = value;
    cases.push(["invalid delivery ID " + JSON.stringify(value), input, /deliveries\[0\].id:/]);
  }
  for (const [field, value] of [["address", ""], ["address", null], ["priority", "high"],
    ["priority", undefined], ["priority", true], ["notes", "line\nbreak"], ["urgent", true]]) {
    const input = batch();
    input.deliveries.push({ ...delivery("D2"), [field]: value });
    cases.push(["invalid late delivery " + field + " " + JSON.stringify(value), input, /deliveries\[1\]/]);
  }
  for (const value of [undefined, -1, 1.5, "2", null, true, Number.MAX_SAFE_INTEGER + 1]) {
    const input = batch();
    input.couriers[0].capacity = value;
    cases.push(["invalid capacity " + JSON.stringify(value), input, /couriers\[0\].capacity: must be a non-negative safe integer/]);
  }
  for (const [field, value] of [["id", ""], ["name", false], ["available", true]]) {
    const input = batch();
    input.couriers[0][field] = value;
    cases.push(["invalid courier " + field, input, /couriers\[0\]/]);
  }
  for (const [name, input, expected] of cases) {
    await t.test(name, () => failure(cli(["--json", "-"], JSON.stringify(input)), expected));
  }
});

test("actual command rejects duplicate JSON keys instead of overwriting work", () => {
  const sources = [
    '{"deliveries":[{"id":"D1","address":"1 Example Road","priority":"urgent"}],"deliveries":[],"couriers":[]}',
    '{"deliveries":[],"couriers":[{"id":"C1","capacity":1}],"couriers":[]}',
    '{"deliveries":[{"id":"D1","address":"1 Example Road","priority":"urgent","priority":"normal"}],"couriers":[]}',
    '{"deliveries":[],"couriers":[{"id":"C1","capacity":2,"capacity":0}]}',
    '{"deliveries":[],"deliv\\u0065ries":[],"couriers":[]}',
  ];
  for (const source of sources) {
    failure(cli(["--json", "-"], source), /invalid JSON.*duplicate object key/);
  }
});

test("JSON token checking preserves punctuation, quotes, backslashes and Unicode in values", () => {
  const input = batch();
  input.deliveries[0].notes = 'Leave at {gate} [A]: ask for "Jo"; code \\ 42; café';
  const result = cli(["--json", "-"], JSON.stringify(input));
  success(result);
  assert.deepEqual(JSON.parse(result.stdout).couriers[0].deliveries[0], input.deliveries[0]);
});

test("actual command rejects malformed JSON and bad arguments", () => {
  for (const input of ["", "{", '{"deliveries":[],}', '{"deliveries":[]} trailing']) {
    failure(cli(["--json", "-"], input), /invalid JSON/);
  }
  failure(cli([]), /input file is required/);
  failure(cli(["--json"]), /input file is required/);
  failure(cli(["--jsno", examplePath]), /unknown option/);
  failure(cli(["--json", "--json", examplePath]), /only be specified once/);
  failure(cli([examplePath, examplePath]), /exactly one input file/);
  failure(cli(["--help", examplePath]), /unknown option/);
});

test("actual command supports help and file paths independent of working directory", (t) => {
  for (const option of ["--help", "-h"]) {
    const result = cli([option]);
    success(result);
    assert.match(result.stdout, /Usage: node dispatch.js/);
  }
  const directory = mkdtempSync(join(tmpdir(), "e11-dispatch-test-"));
  t.after(() => rmSync(directory, { recursive: true, force: true }));
  writeFileSync(join(directory, "-batch file.json"), JSON.stringify(batch()));
  const result = cli(["--json", "--", "-batch file.json"], undefined, directory);
  success(result);
  assert.equal(JSON.parse(result.stdout).summary.assignedDeliveries, 1);
  failure(cli(["missing.json"], undefined, directory), /cannot read "missing.json"/);
  writeFileSync(join(directory, "bad.json"), "{");
  failure(cli(["bad.json"], undefined, directory), /invalid JSON in "bad.json"/);
});
