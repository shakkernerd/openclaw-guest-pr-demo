"use strict";

const fs = require("node:fs");
const { TextDecoder } = require("node:util");

const MAX_BYTES = 4 * 1024 * 1024;
const MAX_TASKS = 20_000;
const MAX_EDGES = 200_000;
const MAX_ID_LENGTH = 256;

const HELP = `Usage: node dependency-plan.js [--] <graph.json>
       node dependency-plan.js --targets <targets.json> [--] <graph.json>
       node dependency-plan.js --help

Read-only task planning; never runs tasks or loads task modules.
Input: a UTF-8 JSON array of [id, [dependencyId, ...]] pairs.
Example: [["build", ["source"]], ["source", []]]
IDs are nonempty literal strings, at most 256 UTF-16 code units; no normalization.
Rejects malformed data, duplicate IDs/edges, and unknown dependencies.
Limits: 4194304 input bytes, 20000 tasks, 200000 dependency edges.
Input must be a regular file, not stdin; use -- for a graph path starting with -.
--targets reads a second bounded UTF-8 JSON file: an array of exact literal IDs.
Its next operand is a literal file path, even when starting with -.
At most 20000 selections, including duplicates; each file is at most 4194304 bytes.
Duplicate selections collapse in first-selection order; [] selects no tasks.
Unknown targets are errors. The entire graph is validated in either mode.

Writes one JSON object with status, stages, cycleWitness, cycleTasks, blockedTasks.
Without --targets, plans the whole graph with unchanged output fields.
With --targets, prefixes scope: "targets" and targets (unique requested IDs);
all plan fields describe only those targets and their transitive dependencies.
Cycles outside this required closure do not affect the selected plan's status.
Stages are earliest possible, with input task order inside each stage.
For cycles, stages contain only unblocked tasks. cycleTasks lists all actual
cycle participants; blockedTasks lists only noncyclic dependents. Both use input
task order. cycleWitness is one closed task-to-dependency path, selected by
iterative depth-first traversal in task/dependency input order.

Exit: 0 DAG/help; 1 cyclic plan; 2 usage/invalid input/limit; 3 I/O failure.
Diagnostics go to stderr; -h also shows this help. See README.md for details.
`;

class InputError extends Error {}

function readJson(path) {
  // Nonblocking open lets us reject FIFOs without waiting for a writer.
  const fd = fs.openSync(path, fs.constants.O_RDONLY | fs.constants.O_NONBLOCK);
  let bytes;
  try {
    const stat = fs.fstatSync(fd);
    if (!stat.isFile()) throw new InputError("input must be a regular file");
    if (stat.size > MAX_BYTES) throw new InputError("input exceeds 4194304 bytes");
    // Read one extra byte to detect growth after stat, without unbounded reads.
    bytes = Buffer.alloc(MAX_BYTES + 1);
    let length = 0;
    while (length < bytes.length) {
      const count = fs.readSync(fd, bytes, length, bytes.length - length, null);
      if (count === 0) break;
      length += count;
    }
    if (length > MAX_BYTES) throw new InputError("input exceeds 4194304 bytes");
    bytes = bytes.subarray(0, length);
  } finally {
    fs.closeSync(fd);
  }

  let source;
  try {
    // Preserve a BOM so JSON.parse rejects it rather than silently stripping it.
    source = new TextDecoder("utf-8", { fatal: true, ignoreBOM: true }).decode(bytes);
  } catch {
    throw new InputError("input must be valid UTF-8");
  }
  try {
    return JSON.parse(source);
  } catch {
    throw new InputError("input must be JSON (no BOM, comments or trailing commas)");
  }
}

function validateId(id, location) {
  if (typeof id !== "string" || id.length === 0 || id.length > MAX_ID_LENGTH) {
    throw new InputError(`${location}: ID must be a string of 1–256 UTF-16 code units`);
  }
}

function buildGraph(input) {
  if (!Array.isArray(input)) throw new InputError("graph must be an array");
  if (input.length > MAX_TASKS) throw new InputError("graph exceeds 20000 tasks");
  const indices = new Map();
  const ids = [];
  let edgeCount = 0;
  for (let i = 0; i < input.length; i++) {
    const task = input[i];
    if (!Array.isArray(task) || task.length !== 2 || !Array.isArray(task[1])) {
      throw new InputError(`task ${i}: expected [id, [dependencyId, ...]]`);
    }
    validateId(task[0], `task ${i}`);
    if (indices.has(task[0])) throw new InputError(`task ${i}: duplicate task ID`);
    indices.set(task[0], i);
    ids.push(task[0]);
    edgeCount += task[1].length;
    if (edgeCount > MAX_EDGES) throw new InputError("graph exceeds 200000 edges");
  }

  const dependencies = Array.from({ length: ids.length }, () => []);
  const dependents = Array.from({ length: ids.length }, () => []);
  for (let i = 0; i < input.length; i++) {
    const seen = new Set();
    for (const id of input[i][1]) {
      validateId(id, `task ${i} dependency`);
      const dependency = indices.get(id);
      if (dependency === undefined) throw new InputError(`task ${i}: unknown dependency ID`);
      if (seen.has(dependency)) throw new InputError(`task ${i}: duplicate dependency edge`);
      seen.add(dependency);
      dependencies[i].push(dependency);
      dependents[dependency].push(i);
    }
  }
  return { ids, indices, dependencies, dependents };
}

function selectTargets(input, { ids, indices, dependencies }) {
  if (!Array.isArray(input)) throw new InputError("targets must be an array");
  if (input.length > MAX_TASKS) throw new InputError("targets exceeds 20000 selections");
  const selected = new Set();
  for (let i = 0; i < input.length; i++) {
    validateId(input[i], `target ${i}`);
    const node = indices.get(input[i]);
    if (node === undefined) {
      throw new InputError(`target ${i}: unknown target ID ${JSON.stringify(input[i])}`);
    }
    selected.add(node);
  }

  const required = new Uint8Array(ids.length);
  const stack = [...selected];
  for (const node of stack) required[node] = 1;
  // Mark on insertion: shared dependencies enter the stack only once.
  while (stack.length > 0) {
    const node = stack.pop();
    for (const dependency of dependencies[node]) {
      if (!required[dependency]) {
        required[dependency] = 1;
        stack.push(dependency);
      }
    }
  }
  return { required, targets: Array.from(selected, (node) => ids[node]) };
}

function classifyCycles(dependencies, dependents, remaining) {
  // Iterative Kosaraju on Kahn's residual graph: all cycles and their dependents.
  // A residual node alone is NOT proof of membership in a cycle.
  const colors = new Uint8Array(remaining.length);
  const positions = new Uint32Array(remaining.length);
  const finished = [];
  const path = [];
  const nextEdge = [];
  let witness = [];
  for (let start = 0; start < remaining.length; start++) {
    if (remaining[start] === 0 || colors[start] !== 0) continue;
    colors[start] = 1;
    positions[start] = 0;
    path.push(start);
    nextEdge.push(0);
    while (path.length > 0) {
      const top = path.length - 1;
      const node = path[top];
      if (nextEdge[top] === dependencies[node].length) {
        colors[node] = 2;
        finished.push(node);
        path.pop();
        nextEdge.pop();
        continue;
      }
      const dependency = dependencies[node][nextEdge[top]++];
      if (remaining[dependency] === 0) continue;
      if (colors[dependency] === 0) {
        colors[dependency] = 1;
        positions[dependency] = path.length;
        path.push(dependency);
        nextEdge.push(0);
      } else if (colors[dependency] === 1 && witness.length === 0) {
        // Gray back-edge: every step, including closure, is an actual dependency.
        witness = path.slice(positions[dependency]).concat(dependency);
      }
    }
  }

  const assigned = new Uint8Array(remaining.length);
  const cyclic = new Uint8Array(remaining.length);
  const stack = [];
  for (let i = finished.length - 1; i >= 0; i--) {
    const start = finished[i];
    if (assigned[start]) continue;
    const component = [];
    assigned[start] = 1;
    stack.push(start);
    while (stack.length > 0) {
      const node = stack.pop();
      component.push(node);
      for (const dependent of dependents[node]) {
        if (remaining[dependent] !== 0 && !assigned[dependent]) {
          assigned[dependent] = 1;
          stack.push(dependent);
        }
      }
    }
    if (component.length > 1 || dependencies[start].includes(start)) {
      for (const node of component) cyclic[node] = 1;
    }
  }
  return { cyclic, witness };
}

function plan({ ids, dependencies, dependents }, required = null) {
  // Outside nodes stay at zero so the existing residual SCC walk excludes them.
  const remaining = new Uint32Array(ids.length);
  const ranks = new Uint32Array(ids.length);
  const queue = [];
  let taskCount = 0;
  for (let i = 0; i < ids.length; i++) {
    if (required && !required[i]) continue;
    taskCount++;
    remaining[i] = dependencies[i].length;
    if (remaining[i] === 0) queue.push(i);
  }
  // Cursor, not shift(): each node/edge is visited only a constant number of times.
  for (let cursor = 0; cursor < queue.length; cursor++) {
    const node = queue[cursor];
    for (const dependent of dependents[node]) {
      if (required && !required[dependent]) continue;
      ranks[dependent] = Math.max(ranks[dependent], ranks[node] + 1);
      if (--remaining[dependent] === 0) queue.push(dependent);
    }
  }

  const stages = [];
  // One input-order pass gives stable stage ordering without per-stage scans/sorts.
  for (let i = 0; i < ids.length; i++) {
    if ((!required || required[i]) && remaining[i] === 0) {
      (stages[ranks[i]] ??= []).push(ids[i]);
    }
  }
  const result = {
    status: "dag", stages, cycleWitness: [], cycleTasks: [], blockedTasks: [],
  };
  if (queue.length === taskCount) return result;

  const { cyclic, witness } = classifyCycles(dependencies, dependents, remaining);
  result.status = "cyclic";
  result.cycleWitness = witness.map((node) => ids[node]);
  for (let i = 0; i < ids.length; i++) {
    if (cyclic[i]) result.cycleTasks.push(ids[i]);
    else if (remaining[i] !== 0) result.blockedTasks.push(ids[i]);
  }
  return result;
}

function main(args) {
  if (args.length === 1 && (args[0] === "--help" || args[0] === "-h")) {
    process.stdout.write(HELP);
    return 0;
  }
  const targeted = args[0] === "--targets";
  const operands = targeted ? args.slice(2) : args;
  const paths = operands[0] === "--" ? operands.slice(1) : operands;
  if ((targeted && !args[1]) || paths.length !== 1 || paths[0].length === 0 ||
      (operands[0] !== "--" && paths[0].startsWith("-"))) {
    throw new InputError("usage: node dependency-plan.js [--] <graph.json>; use --help");
  }
  // Validate globally before reading/selecting targets, even for an empty selection.
  const graph = buildGraph(readJson(paths[0]));
  let result;
  if (targeted) {
    const { required, targets } = selectTargets(readJson(args[1]), graph);
    result = { scope: "targets", targets, ...plan(graph, required) };
  } else {
    result = plan(graph);
  }
  process.stdout.write(`${JSON.stringify(result)}\n`);
  return result.status === "dag" ? 0 : 1;
}

if (require.main === module) {
  // Broken/closed output streams must not emit an uncaught stack or report success.
  process.stderr.on("error", () => { process.exitCode = 3; });
  process.stdout.on("error", (error) => {
    process.exitCode = 3;
    process.stderr.write(`dependency-plan: output I/O failure (${error.code || "unknown"})\n`);
  });
  try {
    process.exitCode = main(process.argv.slice(2));
  } catch (error) {
    process.exitCode = error instanceof InputError ? 2 : 3;
    const message = error instanceof InputError ? error.message :
      `I/O failure (${error.code || "unknown"})`;
    process.stderr.write(`dependency-plan: ${message}\n`);
  }
}
