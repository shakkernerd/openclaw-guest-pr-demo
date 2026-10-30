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

function output(child, status) {
  assert.equal(child.status, status === "dag" ? 0 : 1, child.stderr);
  assert.equal(child.stderr, "");
  const result = JSON.parse(child.stdout);
  assert.equal(child.stdout, `${JSON.stringify(result)}\n`);
  assert.deepEqual(Object.keys(result),
    ["status", "stages", "cycleWitness", "cycleTasks", "blockedTasks"]);
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
test("seeded small graphs agree with independent reachability classification", (t) => {
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
  });
  checkPlan(output(run(root, ["at-bytes.json"]), "dag"), []);
  const edgeResult = output(run(root, ["at-edges.json"]), "dag");
  checkPlan(edgeResult, JSON.parse(atEdges));
  assert.deepEqual(edgeResult.stages.map((stage) => stage.length), [1000, 200]);
  for (const [file, message] of [["over-bytes.json", /4194304 bytes/],
    ["over-nodes.json", /20000 tasks/], ["over-edges.json", /200000 edges/]]) {
    const child = run(root, [file]);
    assert.equal(child.status, 2);
    assert.equal(child.stdout, "");
    assert.match(child.stderr, message);
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
  const root = fixture(t, { "graph.json": "[]" });
  for (const args of [["graph.json"], ["--help"]]) {
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
