"use strict";

const test = require("node:test");
const assert = require("node:assert/strict");
const fs = require("node:fs");
const os = require("node:os");
const path = require("node:path");
const { spawn, spawnSync } = require("node:child_process");

const CLI = path.join(__dirname, "dependency-plan.js");
const MAX_BYTES = 4 * 1024 * 1024;

function fixture(t, files = {}) {
  let root;
  let ready = false;
  const originals = new Map();
  // Register before setup. Only this fresh, exclusive root is owned by this test.
  t.after(() => {
    if (!root) return;
    if (!ready) {
      t.diagnostic(`Retained incomplete fixture: ${root}`);
      return;
    }
    try {
      assert.deepEqual(fs.readdirSync(root).sort(), [...originals.keys()].sort(),
        "CLI must not create, remove or extract files");
      for (const [name, bytes] of originals) {
        assert.equal(fs.lstatSync(path.join(root, name)).isFile(), true);
        assert.deepEqual(fs.readFileSync(path.join(root, name)), bytes,
          `input/fixture bytes changed: ${name}`);
      }
    } catch (error) {
      t.diagnostic(`Retained changed fixture for inspection: ${root}`);
      throw error;
    }
    // Preservation assertions precede normal teardown; never remove other roots.
    fs.rmSync(root, { recursive: true });
  });
  root = fs.mkdtempSync(path.join(os.tmpdir(), "dependency-plan-test-"));
  for (const [name, content] of Object.entries(files)) {
    const bytes = Buffer.from(content);
    originals.set(name, bytes);
    fs.writeFileSync(path.join(root, name), bytes, { flag: "wx" });
  }
  ready = true;
  return root;
}

function run(root, args = ["graph.json"]) {
  const child = spawnSync(process.execPath, [CLI, ...args], {
    cwd: root, encoding: "utf8", timeout: 10_000, maxBuffer: 16 * 1024 * 1024,
  });
  assert.ifError(child.error);
  assert.equal(child.signal, null);
  return child;
}

function output(child, status, targets) {
  assert.equal(child.status, status === "dag" ? 0 : 1, child.stderr);
  assert.equal(child.stderr, "");
  const result = JSON.parse(child.stdout);
  assert.equal(child.stdout, `${JSON.stringify(result)}\n`);
  assert.deepEqual(Object.keys(result),
    [...(targets === undefined ? [] : ["scope", "targets"]),
      "status", "stages", "cycleWitness", "cycleTasks", "blockedTasks"]);
  if (targets !== undefined) {
    assert.equal(result.scope, "targets");
    assert.deepEqual(result.targets, targets);
  }
  assert.equal(result.status, status);
  for (const field of ["cycleWitness", "cycleTasks", "blockedTasks"]) {
    assert.ok(Array.isArray(result[field]));
    assert.ok(result[field].every((id) => typeof id === "string"));
  }
  assert.ok(Array.isArray(result.stages));
  for (const stage of result.stages) {
    assert.ok(Array.isArray(stage) && stage.length > 0);
    assert.ok(stage.every((id) => typeof id === "string"));
  }
  return result;
}

function checkPlan(result, graph, cycleTasks = [], blockedTasks = []) {
  const ids = graph.map(([id]) => id);
  const dependencies = new Map(graph);
  const order = new Map(ids.map((id, index) => [id, index]));
  const assigned = result.stages.flat().concat(result.cycleTasks, result.blockedTasks);
  assert.equal(assigned.length, ids.length);
  assert.deepEqual(new Set(assigned), new Set(ids), "each task appears exactly once");
  assert.deepEqual(result.cycleTasks, cycleTasks);
  assert.deepEqual(result.blockedTasks, blockedTasks);
  const ranks = new Map();
  result.stages.forEach((stage, rank) => {
    stage.forEach((id, index) => {
      ranks.set(id, rank);
      if (index > 0) assert.ok(order.get(stage[index - 1]) < order.get(id));
    });
  });
  for (const [id, rank] of ranks) {
    let earliest = 0;
    for (const dependency of dependencies.get(id)) {
      assert.ok(ranks.has(dependency) && ranks.get(dependency) < rank);
      earliest = Math.max(earliest, ranks.get(dependency) + 1);
    }
    assert.equal(rank, earliest, "stages are earliest possible");
  }
  if (result.status === "dag") {
    assert.deepEqual(result.cycleWitness, []);
  } else {
    const witness = result.cycleWitness;
    assert.ok(witness.length >= 2);
    assert.equal(witness[0], witness.at(-1));
    assert.equal(new Set(witness.slice(0, -1)).size, witness.length - 1);
    const cyclic = new Set(cycleTasks);
    for (let i = 0; i < witness.length - 1; i++) {
      assert.ok(cyclic.has(witness[i]));
      assert.ok(dependencies.get(witness[i]).includes(witness[i + 1]),
        "witness follows actual task-to-dependency edges");
    }
  }
}

test("multi-root fan-in/fan-out and disconnected DAG: exact deterministic stages", (t) => {
  const graph = [
    ["ship", ["bundle", "audit"]], ["bundle", ["left", "right"]],
    ["right", ["source"]], ["isolated", []], ["audit", ["config"]],
    ["left", ["source", "config"]], ["source", []], ["config", []],
    ["other-leaf", ["other-root"]], ["other-root", []],
  ];
  const root = fixture(t, { "graph.json": JSON.stringify(graph, null, 2) + "\n" });
  const first = run(root);
  const result = output(first, "dag");
  assert.deepEqual(result.stages, [
    ["isolated", "source", "config", "other-root"],
    ["right", "audit", "left", "other-leaf"], ["bundle"], ["ship"],
  ]);
  checkPlan(result, graph);
  assert.equal(run(root).stdout, first.stdout);
});

test("empty graph is a valid DAG with no stages", (t) => {
  const root = fixture(t, { "graph.json": "[]" });
  const result = output(run(root), "dag");
  assert.deepEqual(result.stages, []);
  checkPlan(result, []);
});

test("literal IDs are prototype-safe, distinct and never executed or loaded", (t) => {
  const ids = ["__proto__", "constructor", "toString", "hasOwnProperty", "1",
    "01", "A", "a", " a", "a ", "é", "é", "\u0000", "\n", "\ud800",
    "./task.js", "$(touch executed)", "../outside", "x".repeat(256), "😀".repeat(128)];
  const graph = ids.map((id, index) => [id, index ? [ids[index - 1]] : []]);
  const root = fixture(t, {
    "graph.json": JSON.stringify(graph),
    "task.js": "require('node:fs').writeFileSync('executed', 'should never run');\n",
  });
  const result = output(run(root), "dag");
  assert.deepEqual(result.stages, ids.map((id) => [id]));
  checkPlan(result, graph);
});

const cycleCases = [
  {
    name: "self-cycle with downstream dependents and an unblocked dependency",
    graph: [["leaf", ["tail"]], ["self", ["self", "root"]],
      ["tail", ["self"]], ["root", []], ["free", ["root"]]],
    cyclic: ["self"], blocked: ["leaf", "tail"], witness: ["self", "self"],
  },
  {
    name: "multi-node cycle, downstream chain, and noncyclic upstream root",
    graph: [["tail", ["a"]], ["a", ["b", "root"]], ["b", ["c"]],
      ["c", ["a"]], ["root", []], ["leaf", ["tail"]]],
    cyclic: ["a", "b", "c"], blocked: ["tail", "leaf"], witness: ["a", "b", "c", "a"],
  },
  {
    name: "one witness does not classify a whole strongly connected component",
    graph: [["a", ["b", "c"]], ["b", ["a"]], ["c", ["a"]], ["tail", ["c"]]],
    cyclic: ["a", "b", "c"], blocked: ["tail"], witness: ["a", "b", "a"],
  },
  {
    name: "multiple connected/disconnected cycles, a blocked bridge and separate DAG",
    graph: [["a", ["b"]], ["b", ["a"]], ["bridge", ["a"]],
      ["x", ["y", "bridge"]], ["y", ["x"]], ["self", ["self"]],
      ["tail", ["y", "self"]], ["free", []], ["free-leaf", ["free"]]],
    cyclic: ["a", "b", "x", "y", "self"], blocked: ["bridge", "tail"], witness: ["a", "b", "a"],
  },
  {
    name: "witness selection follows dependency order, not ID sorting",
    graph: [["entry", ["second", "first"]], ["first", ["first"]],
      ["second", ["b"]], ["b", ["second"]], ["later", ["later"]]],
    cyclic: ["first", "second", "b", "later"], blocked: ["entry"], witness: ["second", "b", "second"],
  },
  {
    name: "prototype-like IDs also work in cycle classification",
    graph: [["__proto__", ["constructor"]], ["constructor", ["__proto__"]],
      ["toString", ["__proto__"]]],
    cyclic: ["__proto__", "constructor"], blocked: ["toString"],
    witness: ["__proto__", "constructor", "__proto__"],
  },
];
for (const { name, graph, cyclic, blocked, witness } of cycleCases) {
  test(name, (t) => {
    const root = fixture(t, { "graph.json": JSON.stringify(graph) });
    const first = run(root);
    const result = output(first, "cyclic");
    checkPlan(result, graph, cyclic, blocked);
    assert.deepEqual(result.cycleWitness, witness);
    assert.equal(run(root).stdout, first.stdout);
  });
}

// Independent small-graph reachability oracle, deliberately not another SCC algorithm.
test("whole and target plans agree with independent seeded reachability classification", (t) => {
  let seed = 42;
  const random = () => {
    seed = (Math.imul(seed, 1664525) + 1013904223) >>> 0;
    return seed / 2 ** 32;
  };
  const graphs = [];
  const files = {};
  for (let sample = 0; sample < 32; sample++) {
    const ids = Array.from({ length: 7 }, (_, i) => `n${i}`);
    const graph = ids.map((id) => [id, ids.filter(() => random() < sample / 100)]);
    graphs.push(graph);
    files[`${sample}.json`] = JSON.stringify(graph);
    files[`${sample}-targets.json`] = JSON.stringify([ids[sample % 7], ids[(sample + 3) % 7]]);
  }
  const root = fixture(t, files);
  graphs.forEach((graph, sample) => {
    const edges = new Map(graph);
    const reachable = new Map(graph.map(([id, dependencies]) => {
      const seen = new Set(dependencies);
      const queue = [...seen];
      for (let cursor = 0; cursor < queue.length; cursor++) {
        for (const next of edges.get(queue[cursor])) {
          if (!seen.has(next)) { seen.add(next); queue.push(next); }
        }
      }
      return [id, seen];
    }));
    const cyclic = graph.map(([id]) => id).filter((id) => reachable.get(id).has(id));
    const blocked = graph.map(([id]) => id).filter((id) =>
      !cyclic.includes(id) && cyclic.some((cycle) => reachable.get(id).has(cycle)));
    checkPlan(output(run(root, [`${sample}.json`]), cyclic.length ? "cyclic" : "dag"),
      graph, cyclic, blocked);
    const targets = JSON.parse(files[`${sample}-targets.json`]);
    const required = new Set(targets.flatMap((id) => [id, ...reachable.get(id)]));
    const selectedGraph = graph.filter(([id]) => required.has(id));
    const selectedCycles = cyclic.filter((id) => required.has(id));
    const selectedBlocked = blocked.filter((id) => required.has(id));
    const child = run(root, ["--targets", `${sample}-targets.json`, `${sample}.json`]);
    checkPlan(output(child, selectedCycles.length ? "cyclic" : "dag", targets),
      selectedGraph, selectedCycles, selectedBlocked);
  });
});

const invalidCases = [
  ["empty file", "", /JSON/], ["truncated JSON", "[[", /JSON/],
  ["comment", "[] // comment", /JSON/], ["trailing comma", "[[],]", /JSON/],
  ["BOM", "\ufeff[]", /JSON/], ["invalid UTF-8", Buffer.from([0xc3, 0x28]), /UTF-8/],
  ...[null, {}, 1, true, "id"].map((value) => [
    `top-level ${JSON.stringify(value)}`, JSON.stringify(value), /graph must be an array/,
  ]),
  ...[null, {}, [], ["a"], ["a", [], 1], ["a", {}], ["a", null], ["a", "b"]]
    .map((value) => [`bad task ${JSON.stringify(value)}`, JSON.stringify([value]), /expected/]),
  ...[null, 0, false, {}, [], "", "x".repeat(257), "😀".repeat(129)]
    .flatMap((id, i) => [
      [`bad task ID ${i}`, JSON.stringify([[id, []]]), /ID must be/],
      [`bad dependency ID ${i}`, JSON.stringify([["valid", [id]]]), /ID must be/],
    ]),
  ["duplicate task", '[["a",[]],["a",[]]]', /duplicate task/],
  ["duplicate decoded escape", '[["a",[]],["\\u0061",[]]]', /duplicate task/],
  ["duplicate prototype ID", '[["__proto__",[]],["__proto__",[]]]', /duplicate task/],
  ["duplicate edge", '[["a",[]],["b",["a","a"]]]', /duplicate dependency/],
  ["duplicate self-edge", '[["a",["a","a"]]]', /duplicate dependency/],
  ["unknown dependency", '[["a",["missing"]]]', /unknown dependency/],
  ["unknown prototype ID", '[["a",["toString"]]]', /unknown dependency/],
];
for (const [name, source, message] of invalidCases) {
  test(`invalid input: ${name}`, (t) => {
    const root = fixture(t, { "graph.json": source });
    const child = run(root);
    assert.equal(child.status, 2);
    assert.equal(child.stdout, "");
    assert.match(child.stderr, message);
    assert.match(child.stderr, /^dependency-plan: [^\n]+\n$/);
  });
}

for (const kind of ["chain", "ring", "blocked chain"]) {
  test(`20000-task deep ${kind} uses iterative traversal`, (t) => {
    const ids = Array.from({ length: 20_000 }, (_, i) => `n${i}`);
    const graph = ids.map((id, i) => [id, i < ids.length - 1 ? [ids[i + 1]] :
      kind === "chain" ? [] : [kind === "ring" ? ids[0] : id]]);
    const root = fixture(t, { "graph.json": JSON.stringify(graph) });
    const result = output(run(root), kind === "chain" ? "dag" : "cyclic");
    checkPlan(result, graph, kind === "ring" ? ids : kind === "blocked chain" ? [ids.at(-1)] : [],
      kind === "blocked chain" ? ids.slice(0, -1) : []);
    if (kind === "chain") assert.equal(result.stages.length, 20_000);
    if (kind === "ring") assert.equal(result.cycleWitness.length, 20_001);
  });
}

test("byte/node/edge bounds are inclusive and enforced", (t) => {
  const roots = Array.from({ length: 1000 }, (_, i) => `r${i}`);
  const graph = roots.map((id) => [id, []]).concat(
    Array.from({ length: 200 }, (_, i) => [`fan${i}`, [...roots]]));
  const atEdges = JSON.stringify(graph);
  graph[1001][1].push("fan0");
  const root = fixture(t, {
    "at-bytes.json": "[]" + " ".repeat(MAX_BYTES - 2),
    "over-bytes.json": "[]" + " ".repeat(MAX_BYTES - 1),
    "over-nodes.json": JSON.stringify(Array.from({ length: 20_001 }, (_, i) => [`n${i}`, []])),
    "at-edges.json": atEdges, "over-edges.json": JSON.stringify(graph),
    "empty-targets.json": "[]",
    "fan-targets.json": JSON.stringify(graph.slice(1000).map(([id]) => id).concat(roots)),
  });
  checkPlan(output(run(root, ["at-bytes.json"]), "dag"), []);
  const edgeResult = output(run(root, ["at-edges.json"]), "dag");
  checkPlan(edgeResult, JSON.parse(atEdges));
  assert.deepEqual(edgeResult.stages.map((stage) => stage.length), [1000, 200]);
  const targets = graph.slice(1000).map(([id]) => id).concat(roots);
  checkPlan(output(run(root, ["--targets", "fan-targets.json", "at-edges.json"]),
    "dag", targets), JSON.parse(atEdges));
  for (const [file, message] of [["over-bytes.json", /4194304 bytes/],
    ["over-nodes.json", /20000 tasks/], ["over-edges.json", /200000 edges/]]) {
    for (const args of [[file], ["--targets", "empty-targets.json", file]]) {
      const child = run(root, args);
      assert.equal(child.status, 2);
      assert.equal(child.stdout, "");
      assert.match(child.stderr, message);
    }
  }
});

test("command help, usage errors, literal paths and read failures", (t) => {
  const root = fixture(t, { "-graph.json": "[]", "--help": "[]" });
  const help = run(root, ["--help"]);
  assert.equal(help.status, 0);
  assert.equal(help.stderr, "");
  for (const phrase of ["Usage:", "4194304", "20000", "200000", "256",
    "cycleWitness", "cycleTasks", "blockedTasks", "Exit:", "read"]) {
    assert.ok(help.stdout.toLowerCase().includes(phrase.toLowerCase()), phrase);
  }
  assert.equal(run(root, ["-h"]).stdout, help.stdout);
  for (const args of [[], [""], ["--"], ["-"], ["--unknown"], ["-graph.json"],
    ["one", "two"], ["--help", "file"], ["--", "one", "two"]]) {
    const child = run(root, args);
    assert.equal(child.status, 2);
    assert.equal(child.stdout, "");
    assert.match(child.stderr, /usage:/);
  }
  for (const args of [["--", "-graph.json"], ["./-graph.json"], ["--", "--help"]]) {
    checkPlan(output(run(root, args), "dag"), []);
  }
  const missing = run(root, ["missing.json"]);
  assert.equal(missing.status, 3);
  assert.equal(missing.stdout, "");
  assert.equal(missing.stderr, "dependency-plan: I/O failure (ENOENT)\n");
  const directory = run(root, ["."]);
  assert.ok(directory.status === 2 || directory.status === 3);
  assert.equal(directory.stdout, "");
  assert.match(directory.stderr, /regular file|I.O failure/);
});

test("a closed stdout pipe reports an I/O failure, including for help", async (t) => {
  const root = fixture(t, { "graph.json": "[]", "targets.json": "[]" });
  for (const args of [["graph.json"], ["--help"], ["--targets", "targets.json", "graph.json"]]) {
    const child = spawn(process.execPath, [CLI, ...args], {
      cwd: root, stdio: ["ignore", "pipe", "pipe"], timeout: 10_000,
    });
    const completed = new Promise((resolve, reject) => {
      child.once("error", reject);
      child.once("close", (code, signal) => resolve({ code, signal }));
    });
    let stderr = "";
    child.stderr.setEncoding("utf8");
    child.stderr.on("data", (chunk) => { stderr += chunk; });
    child.stdout.destroy();
    const { code, signal } = await completed;
    assert.equal(signal, null);
    assert.equal(code, 3);
    assert.match(stderr, /^dependency-plan: output I.O failure \([A-Z]+\)\n$/);
  }
});

test("requiring the CLI has no command or file side effects", (t) => {
  const root = fixture(t);
  const child = spawnSync(process.execPath, ["-e", `require(${JSON.stringify(CLI)})`], {
    cwd: root, encoding: "utf8", timeout: 10_000,
  });
  assert.ifError(child.error);
  assert.equal(child.signal, null);
  assert.equal(child.status, 0);
  assert.equal(child.stdout, "");
  assert.equal(child.stderr, "");
});

function targetRun(root, targetsFile = "targets.json", graphFile = "graph.json") {
  return run(root, ["--targets", targetsFile, graphFile]);
}

function inputError(child, message) {
  assert.equal(child.status, 2);
  assert.equal(child.stdout, "");
  assert.match(child.stderr, message);
  assert.match(child.stderr, /^dependency-plan: [^\n]+\n$/);
}

test("targets: overlap, shared dependencies and a target that is a dependency", (t) => {
  const graph = [
    ["ship", ["build", "check"]], ["build", ["source", "config"]],
    ["unused", []], ["check", ["source"]], ["source", []], ["config", []],
    ["unrelated-cycle", ["unrelated-cycle"]], ["unused-dependent", ["source"]],
  ];
  const targets = ["check", "ship", "source", "build"];
  const root = fixture(t, {
    "graph.json": JSON.stringify(graph, null, 2) + "\n",
    "targets.json": JSON.stringify(targets),
    "reversed.json": JSON.stringify([...targets].reverse()),
    "duplicates.json": JSON.stringify(["check", "check", "ship", "source", "build", "ship"]),
  });
  const first = targetRun(root);
  const result = output(first, "dag", targets);
  assert.deepEqual(result.stages, [["source", "config"], ["build", "check"], ["ship"]]);
  checkPlan(result, graph.filter(([id]) => !id.startsWith("unused") && id !== "unrelated-cycle"));
  assert.equal(targetRun(root).stdout, first.stdout, "identical inputs give identical bytes");
  assert.equal(targetRun(root, "duplicates.json").stdout, first.stdout);
  const reversed = output(targetRun(root, "reversed.json"), "dag", [...targets].reverse());
  assert.deepEqual(reversed.stages, result.stages, "selection order does not change stage order");
  checkPlan(output(run(root), "cyclic"), graph, ["unrelated-cycle"]);
});

test("targets: explicit empty selection never means the whole graph", (t) => {
  const root = fixture(t, {
    "graph.json": '[["cyclic",["cyclic"]],["free",[]]]',
    "empty-graph.json": "[]", "targets.json": "[]",
  });
  const expected = '{"scope":"targets","targets":[],"status":"dag","stages":[],"cycleWitness":[],"cycleTasks":[],"blockedTasks":[]}\n';
  for (const graphFile of ["graph.json", "empty-graph.json"]) {
    const child = targetRun(root, "targets.json", graphFile);
    checkPlan(output(child, "dag", []), []);
    assert.equal(child.stdout, expected);
  }
});

test("targets: complete cycle classification, real ordered witness and selected blockers only", (t) => {
  const graph = [
    ["outside-cycle", ["outside-cycle"]], ["leaf", ["x", "self"]],
    ["x", ["y", "bridge", "root"]], ["y", ["x"]], ["bridge", ["a"]],
    ["a", ["b", "c"]], ["b", ["a"]], ["c", ["a"]], ["self", ["self"]],
    ["root", []], ["outside-dependent", ["x"]], ["free", []],
  ];
  const root = fixture(t, {
    "graph.json": JSON.stringify(graph), "targets.json": '["leaf","x"]',
    "cycle-only.json": '["a"]',
  });
  const first = targetRun(root);
  const result = output(first, "cyclic", ["leaf", "x"]);
  checkPlan(result, graph.filter(([id]) => !id.startsWith("outside") && id !== "free"),
    ["x", "y", "a", "b", "c", "self"], ["leaf", "bridge"]);
  assert.deepEqual(result.stages, [["root"]]);
  assert.deepEqual(result.cycleWitness, ["x", "y", "x"]);
  assert.equal(targetRun(root).stdout, first.stdout);
  const cycleOnly = output(targetRun(root, "cycle-only.json"), "cyclic", ["a"]);
  checkPlan(cycleOnly, graph.filter(([id]) => ["a", "b", "c"].includes(id)), ["a", "b", "c"]);
  assert.deepEqual(cycleOnly.cycleWitness, ["a", "b", "a"]);
});

test("targets: exact literal, prototype, escaped and code-like IDs are never loaded", (t) => {
  const ids = ["__proto__", "constructor", "toString", "hasOwnProperty", "1",
    "01", "A", "a", " a", "a ", "é", "é", "\u0000", "\n", "\r\t", "\ud800",
    '"\\', "./task.js", "$(touch executed)", "../outside", "--help",
    "x".repeat(256), "😀".repeat(128)];
  const graph = ids.map((id) => [id, []]);
  const targets = [...ids].reverse();
  const root = fixture(t, {
    "graph.json": JSON.stringify(graph), "targets.json": JSON.stringify(targets),
    "decoded.json": '["a","\\u0061","\\u0000","\\n","\\ud800"]',
    "task.js": "require('node:fs').writeFileSync('executed', 'should never run');\n",
  });
  const result = output(targetRun(root), "dag", targets);
  assert.deepEqual(result.stages, [ids]);
  checkPlan(result, graph);
  const decoded = output(targetRun(root, "decoded.json"), "dag", ["a", "\u0000", "\n", "\ud800"]);
  checkPlan(decoded, graph.filter(([id]) => ["a", "\u0000", "\n", "\ud800"].includes(id)));
});

test("targets: unknown exact IDs are diagnosed, not trimmed, coerced or normalized", (t) => {
  const unknown = ["missing", "__proto__", "toString", " a", "a ", "A", "01", "é", "\u0000", "\n", "\ud800"];
  const files = { "graph.json": '[["a",[]],["1",[]],["é",[]]]' };
  unknown.forEach((id, i) => { files[i + ".json"] = JSON.stringify(["a", id]); });
  const root = fixture(t, files);
  unknown.forEach((id, i) => {
    const child = targetRun(root, i + ".json");
    inputError(child, /unknown target ID/);
    assert.equal(child.stderr, "dependency-plan: target 1: unknown target ID " + JSON.stringify(id) + "\n");
  });
});

test("targets: shared bounded JSON reader, ID validation and selection limits", (t) => {
  const bad = [
    ["", /JSON/], ["[", /JSON/], ["[] // comment", /JSON/], ['["a",]', /JSON/],
    ["\ufeff[]", /JSON/], [Buffer.from([0xc3, 0x28]), /UTF-8/],
    ...[null, {}, "a", true, 0].map((value) => [JSON.stringify(value), /targets must be an array/]),
    ...[null, 1, false, {}, [], "", "x".repeat(257), "😀".repeat(129)]
      .map((value) => [JSON.stringify([value]), /target 0: ID must be/]),
    [JSON.stringify(Array(20_001).fill("a")), /20000 selections/],
    ["[]" + " ".repeat(MAX_BYTES - 1), /4194304 bytes/],
  ];
  const files = {
    "graph.json": '[["a",[]]]',
    "at-selections.json": JSON.stringify(Array(20_000).fill("a")),
    "at-bytes.json": '["a"]' + " ".repeat(MAX_BYTES - 5),
  };
  bad.forEach(([source], i) => { files[i + ".json"] = source; });
  const root = fixture(t, files);
  bad.forEach(([, message], i) => inputError(targetRun(root, i + ".json"), message));
  for (const file of ["at-selections.json", "at-bytes.json"]) {
    checkPlan(output(targetRun(root, file), "dag", ["a"]), [["a", []]]);
  }
});

test("targets: global validation rejects invalid nodes outside even an empty closure", (t) => {
  const bad = [
    [[["ok", []], ["outside", ["missing"]]], /unknown dependency/],
    [[["ok", []], ["outside", ["outside", "outside"]]], /duplicate dependency/],
    [[["ok", []], ["outside", []], ["outside", []]], /duplicate task/],
    [[["ok", []], ["", []]], /ID must be/],
    [[["ok", []], ["outside", [1]]], /ID must be/],
    [[["ok", []], ["outside", {}]], /expected/],
  ];
  const files = { "targets.json": '["ok"]', "empty.json": "[]" };
  bad.forEach(([graph], i) => { files[i + ".json"] = JSON.stringify(graph); });
  const root = fixture(t, files);
  bad.forEach(([, message], i) => {
    for (const selection of ["targets.json", "empty.json", "missing-targets.json"]) {
      inputError(targetRun(root, selection, i + ".json"), message);
    }
  });
});

for (const kind of ["chain", "ring", "blocked chain"]) {
  test("targets: 20000-task deep " + kind + " closure is iterative", (t) => {
    const ids = Array.from({ length: 20_000 }, (_, i) => "n" + i);
    const graph = ids.map((id, i) => [id, i < ids.length - 1 ? [ids[i + 1]] :
      kind === "chain" ? [] : [kind === "ring" ? ids[0] : id]]);
    const targets = [ids[0], ids[10_000]];
    const root = fixture(t, {
      "graph.json": JSON.stringify(graph), "targets.json": JSON.stringify(targets),
    });
    const result = output(targetRun(root), kind === "chain" ? "dag" : "cyclic", targets);
    checkPlan(result, graph, kind === "ring" ? ids : kind === "blocked chain" ? [ids.at(-1)] : [],
      kind === "blocked chain" ? ids.slice(0, -1) : []);
    if (kind === "chain") assert.equal(result.stages.length, 20_000);
    if (kind === "ring") assert.equal(result.cycleWitness.length, 20_001);
  });
}

test("targets: CLI grammar, literal paths, help and read failures", (t) => {
  const root = fixture(t, {
    "graph.json": "[]", "-graph.json": "[]", "--targets": "[]",
    "targets.json": "[]", "-targets.json": "[]", "--help": "[]",
  });
  for (const args of [
    ["--targets"], ["--targets", "targets.json"], ["--targets", "", "graph.json"],
    ["--targets", "targets.json", ""], ["--targets", "targets.json", "--"],
    ["--targets", "targets.json", "-graph.json"],
    ["--targets", "targets.json", "graph.json", "extra"],
    ["--targets", "targets.json", "--targets", "targets.json", "graph.json"],
    ["graph.json", "--targets", "targets.json"], ["--help", "--targets", "targets.json"],
  ]) inputError(run(root, args), /usage:/);
  for (const args of [
    ["--targets", "-targets.json", "--", "-graph.json"],
    ["--targets", "--help", "--", "--targets"],
    ["--targets", "targets.json", "./-graph.json"],
  ]) checkPlan(output(run(root, args), "dag", []), []);
  checkPlan(output(run(root, ["--", "--targets"]), "dag"), []);
  const missing = targetRun(root, "missing.json");
  assert.equal(missing.status, 3);
  assert.equal(missing.stdout, "");
  assert.equal(missing.stderr, "dependency-plan: I/O failure (ENOENT)\n");
  const directory = targetRun(root, ".");
  assert.ok(directory.status === 2 || directory.status === 3);
  assert.equal(directory.stdout, "");
  assert.match(directory.stderr, /regular file|I.O failure/);
  const help = run(root, ["--help"]);
  assert.equal(help.status, 0);
  for (const phrase of ["--targets", "scope", "[] selects no tasks", "entire graph is validated",
    "Duplicate selections", "transitive dependencies", "20000 selections"]) {
    assert.ok(help.stdout.includes(phrase), phrase);
  }
});

test("whole-graph JSON byte contract remains unchanged without selection", (t) => {
  const cases = [
    ["[]", '{"status":"dag","stages":[],"cycleWitness":[],"cycleTasks":[],"blockedTasks":[]}\n'],
    ['[["ship",["root"]],["free",[]],["root",[]]]',
      '{"status":"dag","stages":[["free","root"],["ship"]],"cycleWitness":[],"cycleTasks":[],"blockedTasks":[]}\n'],
    ['[["tail",["a"]],["a",["b"]],["b",["a"]],["self",["self"]],["free",[]]]',
      '{"status":"cyclic","stages":[["free"]],"cycleWitness":["a","b","a"],"cycleTasks":["a","b","self"],"blockedTasks":["tail"]}\n'],
  ];
  const root = fixture(t, Object.fromEntries(cases.map(([source], i) => [i + ".json", source])));
  cases.forEach(([, expected], i) => {
    const child = run(root, [i + ".json"]);
    output(child, i === 2 ? "cyclic" : "dag");
    assert.equal(child.stdout, expected);
  });
});

test("targets: 20000 unique overlapping selections share one deep closure", (t) => {
  const ids = Array.from({ length: 20_000 }, (_, i) => "n" + i);
  const graph = ids.map((id, i) => [id, i ? [ids[i - 1]] : []]);
  const targets = [...ids].reverse();
  const root = fixture(t, {
    "graph.json": JSON.stringify(graph), "targets.json": JSON.stringify(targets),
  });
  const result = output(targetRun(root), "dag", targets);
  checkPlan(result, graph);
  assert.deepEqual(result.stages, ids.map((id) => [id]));
});
