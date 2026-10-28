"use strict";

const test = require('node:test');
const assert = require('node:assert/strict');
const { spawn, spawnSync } = require('node:child_process');
const { mkdtempSync, writeFileSync, rmSync } = require('node:fs');
const { tmpdir } = require('node:os');
const path = require('node:path');
const { Readable, Writable, PassThrough } = require('node:stream');
const { setImmediate: tick } = require('node:timers/promises');
const { runBatch } = require('./packaging-batch-cli.js');
const { parseOrder } = require('./order-json.js');

const cli = path.join(__dirname, 'packaging-batch-cli.js');
const order = '{"items":[{"sku":"A","quantity":1},{"sku":"B","quantity":1}],"maxItemsPerBox":4}';
const expected = {
  mixed: { mode: 'mixed', maxItemsPerBox: 4, totalItems: 2, boxCount: 1, fullBoxes: 0, partialBoxes: 1, unusedItemSlots: '2' },
  'single-sku': { mode: 'single-sku', maxItemsPerBox: 4, totalItems: 2, boxCount: 2, fullBoxes: 0, partialBoxes: 2, unusedItemSlots: '6' },
};
const resultLine = line => JSON.stringify({ line, ...expected }) + '\n';
function run(args = [], input = order, options = {}) {
  const result = spawnSync(process.execPath, [cli, ...args], {
    input, encoding: 'utf8', timeout: 5000, maxBuffer: 2 * 1024 * 1024, ...options,
  });
  assert.ifError(result.error);
  assert.equal(result.signal, null);
  return result;
}
function sink(options = {}) {
  const chunks = [];
  const stream = new Writable({ write(chunk, encoding, callback) { chunks.push(Buffer.from(chunk)); callback(); }, ...options });
  return { stream, text: () => Buffer.concat(chunks).toString('utf8') };
}
function ioError(code) { return Object.assign(new Error('PRIVATE IO DETAILS'), { code }); }
async function bounded(promise) {
  let timer;
  try { return await Promise.race([promise, new Promise((_, reject) => {
    timer = setTimeout(() => reject(new Error('stream did not settle within 2 seconds')), 2000);
  })]); } finally { clearTimeout(timer); }
}
async function streams(input) {
  const out = sink();
  const err = sink();
  const status = await bounded(runBatch(input, out.stream, err.stream));
  return { status, stdout: out.text(), stderr: err.text() };
}
function childRun(t, args = []) {
  const child = spawn(process.execPath, [cli, ...args], { stdio: ['pipe', 'pipe', 'pipe'], timeout: 4000 });
  t.after(() => { if (child.exitCode === null) child.kill(); });
  let stdout = '';
  let stderr = '';
  child.stdout.on('data', chunk => { stdout += chunk; });
  child.stderr.on('data', chunk => { stderr += chunk; });
  child.stdin.on('error', () => {});
  const done = new Promise((resolve, reject) => {
    child.on('error', reject);
    child.on('close', (status, signal) => resolve({ status, signal, stdout, stderr }));
  });
  return { child, done };
}

test('batch file and both stdin forms continue after syntax, shape, and domain errors with physical lines', t => {
  const dir = mkdtempSync(path.join(tmpdir(), 'packaging-batch-'));
  t.after(() => rmSync(dir, { recursive: true, force: true }));
  // Keep the POSIX quote case while using a Windows-safe name; both lead with --.
  const name = process.platform === 'win32' ? '--orders private.jsonl' : '--orders " private.jsonl';
  const input = ['null', '', order, '{PRIVATE_MARKER', ' \t\r', '{"items":[],"maxItemsPerBox":0}', order, '[]', order].join('\n');
  writeFileSync(path.join(dir, name), input);
  for (const args of [[], ['-'], ['--', name]]) {
    const source = args.length === 2 ? JSON.stringify(name) : 'standard input';
    const r = run(args, input, { cwd: dir });
    assert.equal(r.status, 1);
    assert.equal(r.stdout, resultLine(3) + resultLine(7) + resultLine(9));
    const diagnostics = r.stderr.trimEnd().split('\n');
    assert.equal(diagnostics.length, 4);
    for (const [i, line] of [1, 4, 6, 8].entries()) assert.ok(diagnostics[i].startsWith('packaging-batch: ' + source + ': line ' + line + ': '));
    assert.doesNotMatch(r.stderr, /PRIVATE_MARKER|\n\s+at /);
    assert.match(diagnostics[0], /order must be an object/);
    assert.match(diagnostics[1], /input must contain one valid JSON order/);
    assert.match(diagnostics[2], /maxItemsPerBox must be a positive safe integer/);
  }
});

test('clean EOF, empty input, blank-only input and terminal LF never add phantom records', () => {
  for (const input of ['', '\n', ' \t\r', '\n \t\r\n\r']) {
    const r = run([], input);
    assert.equal(r.status, 0);
    assert.equal(r.stdout, '');
    assert.equal(r.stderr, '');
  }
  for (const input of [order, order + '\n', order + '\r\n', order + '\n\n']) {
    const r = run([], input);
    assert.equal(r.status, 0);
    assert.equal(r.stdout, resultLine(1));
    assert.equal(r.stderr, '');
  }
});

test('LF alone splits records; bare CR stays inside JSON and only SPACE TAB CR blanks are skipped', () => {
  const insideCR = order.replace('{"items"', '{\r"items"');
  const input = [insideCR, order + '\r' + order, '\v', '\f', '\u00a0', '\ufeff', order].join('\n');
  const r = run([], input);
  assert.equal(r.status, 1);
  assert.equal(r.stdout, resultLine(1) + resultLine(7));
  assert.deepEqual([...r.stderr.matchAll(/: line (\d+):/g)].map(m => Number(m[1])), [2, 3, 4, 5, 6]);
});

test('raw fractional, underflow, unsafe and aggregate-overflow records fail without blocking valid successors', () => {
  const inputs = ['1.0000000000000001', '1e-400', '9007199254740992', '-1', '"1"', '05'].map(q =>
    '{"items":[{"sku":"A","quantity":' + q + '}],"maxItemsPerBox":4}');
  inputs.push('{"items":[],"maxItemsPerBox":2.9999999999999999}',
    '{"items":[{"sku":"A","quantity":9007199254740991},{"sku":"B","quantity":1}],"maxItemsPerBox":4}');
  const valid = order.replaceAll(':1}', ':100e-2}').replace(':4}', ':4.0}');
  const r = run([], inputs.flatMap(bad => [bad, valid]).join('\n'));
  assert.equal(r.status, 1);
  assert.equal(r.stdout, inputs.map((_, i) => resultLine(i * 2 + 2)).join(''));
  assert.equal(r.stderr.trimEnd().split('\n').length, inputs.length);
});

test('shared parser preserves last-key-wins, escaped keys and deeply ignored data', () => {
  const deep = '['.repeat(3000) + '1e-400' + ']'.repeat(3000);
  const text = '{"items":[{"sku":"A","quantity":1e-400,"quanti\\u0074y":1.0},{"sku":"B","quantity":1}],"maxItemsPerBox":4,"extra":' + deep + '}';
  assert.equal(parseOrder(text).items[0].quantity, 1);
  assert.throws(() => parseOrder('null'), /order must be an object/);
  assert.throws(() => parseOrder('{PRIVATE'), /input must contain one valid JSON order/);
  const r = run([], text);
  assert.equal(r.status, 0);
  assert.equal(r.stdout, resultLine(1));
  assert.equal(r.stderr, '');
});

test('batch summaries remain compact at maximum-safe box counts and preserve exact unused-slot strings', () => {
  const max = Number.MAX_SAFE_INTEGER;
  const inputs = [
    { items: [{ sku: 'A', quantity: max }], maxItemsPerBox: 1 },
    { items: [{ sku: 'A', quantity: 1 }, { sku: 'B', quantity: 2 }], maxItemsPerBox: max },
    { items: [], maxItemsPerBox: 4 },
  ];
  const r = run([], inputs.map(v => JSON.stringify(v)).join('\n'));
  assert.equal(r.status, 0);
  assert.equal(r.stderr, '');
  assert.ok(r.stdout.length < 1500);
  const rows = r.stdout.trimEnd().split('\n').map(JSON.parse);
  for (const mode of ['mixed', 'single-sku']) {
    assert.equal(rows[0][mode].boxCount, max);
    assert.equal(rows[0][mode].fullBoxes, max);
    assert.equal(rows[0][mode].unusedItemSlots, '0');
    assert.equal(rows[2][mode].boxCount, 0);
    for (const row of rows) assert.equal(Object.hasOwn(row[mode], 'boxes'), false);
  }
  assert.equal(rows[1].mixed.unusedItemSlots, '9007199254740988');
  assert.equal(rows[1]['single-sku'].unusedItemSlots, '18014398509481979');
});

test('UTF-8 replacement is retained, BOMs are not stripped, and valid records after BOM errors survive', () => {
  const raw = Buffer.concat([Buffer.from('{"items":[{"sku":"'), Buffer.from([0xff]),
    Buffer.from('","quantity":2},{"sku":"\ufffd","quantity":2}],"maxItemsPerBox":4}')]);
  const r = run([], Buffer.concat([raw, Buffer.from('\n\ufeff' + order + '\n' + order)]));
  assert.equal(r.status, 1);
  const rows = r.stdout.trimEnd().split('\n').map(JSON.parse);
  assert.deepEqual(rows.map(r => r.line), [1, 3]);
  assert.equal(rows[0]['single-sku'].boxCount, 1);
  assert.equal(rows[0]['single-sku'].fullBoxes, 1);
  assert.match(r.stderr, /line 2: input must contain one valid JSON order/);
  const single = spawnSync(process.execPath, [path.join(__dirname, 'packaging-cli.js'), '--compare', '--json'], { input: raw, encoding: 'utf8', timeout: 5000 });
  assert.ifError(single.error);
  assert.equal(single.status, 0);
  const { line, ...comparison } = rows[0];
  assert.deepEqual(comparison, JSON.parse(single.stdout));
});

test('help and argument errors do not read an open stdin', async t => {
  for (const args of [['--help'], ['-h'], ['--json'], ['--compare'], ['--mode', 'mixed'], ['a', 'b'], ['--help', '-'], ['--wat']]) {
    const { done } = childRun(t, args);
    const r = await bounded(done);
    assert.equal(r.signal, null);
    const help = args.length === 1 && ['--help', '-h'].includes(args[0]);
    assert.equal(r.status, help ? 0 : 2);
    assert.match(help ? r.stdout : r.stderr, /Usage: node packaging-batch-cli.js/);
    assert.equal(help ? r.stderr : r.stdout, '');
  }
});

test('unreadable files produce controlled fatal source diagnostics', t => {
  const dir = mkdtempSync(path.join(tmpdir(), 'packaging-batch-'));
  t.after(() => rmSync(dir, { recursive: true, force: true }));
  for (const file of [path.join(dir, 'missing.jsonl'), dir]) {
    const r = run([file]);
    assert.equal(r.status, 1);
    assert.equal(r.stdout, '');
    assert.ok(r.stderr.startsWith('packaging-batch: ' + JSON.stringify(file) + ': cannot read input ('));
    assert.doesNotMatch(r.stderr, /\n\s+at /);
  }
});

test('real CLI flushes output larger than a pipe buffer', () => {
  const count = 1000;
  const r = run([], (order + '\n').repeat(count));
  assert.equal(r.status, 0);
  assert.equal(r.stderr, '');
  assert.equal(r.stdout, Array.from({ length: count }, (_, i) => resultLine(i + 1)).join(''));
});

test('real CLI exits on a broken output pipe while stdin remains open', async t => {
  const { child, done } = childRun(t);
  const first = new Promise(resolve => {
    let buffered = Buffer.alloc(0);
    const onData = chunk => {
      buffered = Buffer.concat([buffered, chunk]);
      const lf = buffered.indexOf(0x0a);
      if (lf !== -1) {
        child.stdout.off('data', onData);
        resolve(buffered.subarray(0, lf + 1));
      }
    };
    child.stdout.on('data', onData);
    t.after(() => child.stdout.off('data', onData));
  });
  child.stdin.write(order + '\n');
  assert.equal((await bounded(first)).toString(), resultLine(1));
  child.stdout.destroy();
  // A pipe detects a peer closure on a write; deliberately do NOT end stdin.
  child.stdin.write(order + '\n');
  const r = await bounded(done);
  assert.equal(r.status, 1);
  assert.equal(r.signal, null);
  assert.match(r.stderr, /cannot write output/);
  assert.doesNotMatch(r.stderr, /line 2:|\n\s+at /);
});

test('requiring the shared parser and batch transport has no CLI side effects', () => {
  const r = spawnSync(process.execPath, ['-e', 'require("./order-json.js"); require("./packaging-batch-cli.js")'], { cwd: __dirname, encoding: 'utf8', timeout: 5000 });
  assert.ifError(r.error);
  assert.equal(r.status, 0);
  assert.equal(r.stdout + r.stderr, '');
});

test('real byte Readable splits every UTF-8 byte and CRLF without changing exact SKU aggregation', async () => {
  // Distinct equal-byte-length SKUs with 2-, 3-, and 4-byte characters. Decoding
  // each byte separately would collapse both names to the same replacement text.
  const record = JSON.stringify({ items: [{ sku: 'é-茶-😀', quantity: 2 }, { sku: 'è-杯-😃', quantity: 2 }], maxItemsPerBox: 4 });
  const bytes = Buffer.from(record + '\r\n \t\r\n' + order);
  const input = Readable.from((async function* () {
    for (const byte of bytes) { yield Buffer.from([byte]); await tick(); }
  })(), { objectMode: false, highWaterMark: 1 });
  const r = await streams(input);
  assert.equal(r.status, 0);
  assert.equal(r.stderr, '');
  const rows = r.stdout.trimEnd().split('\n').map(JSON.parse);
  assert.deepEqual(rows.map(r => r.line), [1, 3]);
  assert.deepEqual(rows[0], {
    line: 1,
    mixed: { mode: 'mixed', maxItemsPerBox: 4, totalItems: 4, boxCount: 1, fullBoxes: 1, partialBoxes: 0, unusedItemSlots: '0' },
    'single-sku': { mode: 'single-sku', maxItemsPerBox: 4, totalItems: 4, boxCount: 2, fullBoxes: 0, partialBoxes: 2, unusedItemSlots: '4' },
  });
  assert.deepEqual(rows[1], { line: 3, ...expected });
});

test('incomplete UTF-8 at clean EOF retains replacement decoding', async () => {
  const bytes = Buffer.concat([Buffer.from(order + '\n'), Buffer.from([0xe2, 0x82])]);
  const input = Readable.from((async function* () {
    for (const byte of bytes) { yield Buffer.from([byte]); await tick(); }
  })(), { objectMode: false });
  const r = await streams(input);
  assert.equal(r.status, 1);
  assert.equal(r.stdout, resultLine(1));
  assert.equal(r.stderr, 'packaging-batch: standard input: line 2: input must contain one valid JSON order\n');
});

test('read error never promotes an unterminated valid tail to an EOF record; emitted records remain', async t => {
  for (const tail of [order, '{PRIVATE', '\ufeff']) {
    const input = new PassThrough();
    t.after(() => input.destroy());
    let emitted;
    const first = new Promise(resolve => { emitted = resolve; });
    const chunks = [];
    const output = new Writable({ write(chunk, encoding, callback) { chunks.push(chunk.toString()); callback(); emitted(); } });
    const err = sink();
    const done = runBatch(input, output, err.stream, '"supplier.jsonl"');
    input.write(order + '\n');
    await bounded(first);
    input.write(tail);
    await tick();
    input.destroy(ioError('EIO'));
    assert.equal(await bounded(done), 1);
    assert.equal(chunks.join(''), resultLine(1));
    assert.equal(err.text(), 'packaging-batch: "supplier.jsonl": cannot read input (EIO)\n');
  }
});

test('premature input close is fatal rather than clean EOF', async t => {
  const input = new PassThrough();
  t.after(() => input.destroy());
  const done = streams(input);
  input.write(order);
  await tick();
  input.destroy();
  const r = await bounded(done);
  assert.equal(r.status, 1);
  assert.equal(r.stdout, '');
  assert.match(r.stderr, /cannot read input \(ERR_STREAM_PREMATURE_CLOSE\)/);
});

test('small-highWaterMark Writable applies backpressure, bounds read-ahead and flushes every record', async () => {
  let produced = 0;
  const total = 200;
  const input = Readable.from((function* () {
    for (let i = 0; i < total; i++) { produced++; yield Buffer.from(order + '\n'); }
  })(), { objectMode: false, highWaterMark: 1 });
  let release;
  let started;
  const first = new Promise(resolve => { started = resolve; });
  const chunks = [];
  const output = new Writable({ highWaterMark: 1, write(chunk, encoding, callback) {
    chunks.push(chunk.toString());
    if (chunks.length === 1) { release = callback; started(); } else callback();
  } });
  const err = sink();
  const done = runBatch(input, output, err.stream);
  await bounded(first);
  await tick();
  await tick();
  assert.equal(chunks.length, 1);
  assert.ok(produced <= 3, 'pipeline must not consume the entire input while the sink is blocked: ' + produced);
  release();
  assert.equal(await bounded(done), 0);
  assert.equal(err.text(), '');
  assert.equal(chunks.join(''), Array.from({ length: total }, (_, i) => resultLine(i + 1)).join(''));
  assert.equal(output.writableFinished, true);
});

test('diagnostic backpressure delays later records instead of buffering all failures', async () => {
  let release;
  let started;
  const first = new Promise(resolve => { started = resolve; });
  const diagnostics = new Writable({ highWaterMark: 1, write(chunk, encoding, callback) { release = callback; started(); } });
  const out = sink();
  const done = runBatch(Readable.from([Buffer.from('null\n' + order)]), out.stream, diagnostics);
  await bounded(first);
  await tick();
  assert.equal(out.text(), '');
  release();
  assert.equal(await bounded(done), 1);
  assert.equal(out.text(), resultLine(2));
});

test('output failure and premature output close cancel an input that remains open', async t => {
  for (const close of [out => out.destroy(ioError('EPIPE')), out => out.destroy(), out => out.end()]) {
    const input = new PassThrough();
    const out = sink({ autoDestroy: false });
    const err = sink();
    t.after(() => input.destroy());
    const done = runBatch(input, out.stream, err.stream);
    await tick();
    close(out.stream);
    assert.equal(await bounded(done), 1);
    assert.equal(input.destroyed, true);
    assert.equal(out.text(), '');
    assert.match(err.text(), /cannot write output \((EPIPE|ERR_STREAM_PREMATURE_CLOSE)\)/);
  }
});

test('Writable callback and finalization errors remain fatal transport errors, not bad records', async () => {
  for (const options of [
    { write(chunk, encoding, callback) { callback(ioError('ENOSPC')); } },
    { final(callback) { callback(ioError('EIO')); } },
  ]) {
    const out = sink(options);
    const err = sink();
    const status = await bounded(runBatch(Readable.from([Buffer.from(order + '\n')]), out.stream, err.stream));
    assert.equal(status, 1);
    assert.match(err.text(), /cannot write output \((ENOSPC|EIO)\)/);
    assert.doesNotMatch(err.text(), /: line |PRIVATE/);
  }
});

test('diagnostic sink failure is fatal and cancels an open input', async t => {
  const input = new PassThrough();
  t.after(() => input.destroy());
  const diagnostics = new Writable({ write(chunk, encoding, callback) { callback(ioError('EPIPE')); } });
  const out = sink();
  const done = runBatch(input, out.stream, diagnostics);
  input.write('null\n');
  assert.equal(await bounded(done), 1);
  assert.equal(input.destroyed, true);
  assert.equal(out.text(), '');
});

const jsonlOptions = { diagnostics: 'jsonl' };
const completion = exitCode => ({ version: 1, type: 'complete', exitCode });
function diagnosticEvents(text) {
  assert.ok(text.endsWith('\n'), 'diagnostics must contain complete LF-framed events');
  return text.slice(0, -1).split('\n').map(line => {
    const event = JSON.parse(line);
    const keys = {
      'record-error': ['version', 'type', 'line', 'message'],
      'fatal-error': ['version', 'type', 'operation', 'code'],
      complete: ['version', 'type', 'exitCode'],
    };
    assert.ok(Object.hasOwn(keys, event.type));
    assert.deepEqual(Object.keys(event).sort(), keys[event.type].sort());
    assert.equal(event.version, 1);
    if (event.type === 'record-error') {
      assert.ok(Number.isSafeInteger(event.line) && event.line > 0);
      assert.equal(typeof event.message, 'string');
    } else if (event.type === 'fatal-error') {
      assert.ok(['read-input', 'write-output', 'write-diagnostics'].includes(event.operation));
      assert.match(event.code, /^[A-Z0-9_]+$/);
    } else assert.ok([0, 1].includes(event.exitCode));
    return event;
  });
}

test('JSONL diagnostics real CLI preserves stdout and reports physical rejected lines without source data', t => {
  const dir = mkdtempSync(path.join(tmpdir(), 'packaging-diagnostics-'));
  t.after(() => rmSync(dir, { recursive: true, force: true }));
  const file = path.join(dir, 'PRIVATE_SOURCE.jsonl');
  const input = ['null', '', order, '{PRIVATE_ORDER', ' \t\r', '{"items":[],"maxItemsPerBox":0}', order, '[]', order].join('\n');
  writeFileSync(file, input);
  for (const args of [[], ['-'], [file]]) {
    const legacy = run(args, input);
    const r = run(['--diagnostics=jsonl', ...args], input);
    assert.equal(r.status, 1);
    assert.equal(r.stdout, legacy.stdout);
    assert.equal(r.stdout, resultLine(3) + resultLine(7) + resultLine(9));
    assert.deepEqual(diagnosticEvents(r.stderr), [
      { version: 1, type: 'record-error', line: 1, message: 'order must be an object with items and maxItemsPerBox' },
      { version: 1, type: 'record-error', line: 4, message: 'input must contain one valid JSON order' },
      { version: 1, type: 'record-error', line: 6, message: 'maxItemsPerBox must be a positive safe integer' },
      { version: 1, type: 'record-error', line: 8, message: 'order must be an object with items and maxItemsPerBox' },
      completion(1),
    ]);
    assert.doesNotMatch(r.stderr, /PRIVATE|packaging-batch:|standard input|\n\s+at /);
  }
  const afterFile = run([file, '--diagnostics=jsonl'], 'ignored');
  assert.equal(afterFile.status, 1);
  assert.equal(afterFile.stdout, resultLine(3) + resultLine(7) + resultLine(9));
  assert.deepEqual(diagnosticEvents(afterFile.stderr).at(-1), completion(1));
});

test('JSONL clean and blank inputs have exactly one completion; default success stays silent', () => {
  for (const input of ['', '\n', ' \t\r', '\n \t\r\n\r', order, order + '\n', order + '\r\n\n']) {
    const legacy = run([], input);
    const r = run(['--diagnostics=jsonl'], input);
    assert.equal(r.status, 0);
    assert.equal(r.stdout, legacy.stdout);
    assert.equal(legacy.stderr, '');
    assert.deepEqual(diagnosticEvents(r.stderr), [completion(0)]);
  }
});

test('JSONL option misuse stays human-readable before open stdin is consumed; help stays standalone', async t => {
  for (const args of [
    ['--diagnostics=jsonl', '--diagnostics=jsonl'], ['--diagnostics=json'],
    ['--diagnostics='], ['--diagnostics', 'jsonl'], ['--diagnostics=jsonl', '--wat'],
    ['--diagnostics=jsonl', '--help'], ['--help', '--diagnostics=jsonl'],
    ['--diagnostics=jsonl', 'a', 'b'],
  ]) {
    const { done } = childRun(t, args);
    const r = await bounded(done);
    assert.equal(r.status, 2);
    assert.equal(r.signal, null);
    assert.equal(r.stdout, '');
    assert.match(r.stderr, /^packaging-batch: /);
    assert.match(r.stderr, /Usage:.*--diagnostics=jsonl/);
    assert.doesNotMatch(r.stderr, /"version":/);
  }
  for (const help of ['--help', '-h']) {
    const { done } = childRun(t, [help]);
    const r = await bounded(done);
    assert.equal(r.status, 0);
    assert.match(r.stdout, /--diagnostics=jsonl/);
    assert.equal(r.stderr, '');
  }
});

test('JSONL selector after -- is a filename, not an option', t => {
  const dir = mkdtempSync(path.join(tmpdir(), 'packaging-diagnostics-'));
  t.after(() => rmSync(dir, { recursive: true, force: true }));
  writeFileSync(path.join(dir, '--diagnostics=jsonl'), order);
  const legacy = run(['--', '--diagnostics=jsonl'], 'ignored', { cwd: dir });
  assert.equal(legacy.status, 0);
  assert.equal(legacy.stdout, resultLine(1));
  assert.equal(legacy.stderr, '');
  const opted = run(['--diagnostics=jsonl', '--', '--diagnostics=jsonl'], 'ignored', { cwd: dir });
  assert.equal(opted.status, 0);
  assert.equal(opted.stdout, legacy.stdout);
  assert.deepEqual(diagnosticEvents(opted.stderr), [completion(0)]);
});

test('JSONL reuses exact-token validation and LF/blank semantics without echoing values', () => {
  const bad = '{"items":[{"sku":"PRIVATE_SKU","quantity":1.0000000000000001}],"maxItemsPerBox":4}';
  const r = run(['--diagnostics=jsonl'], ' \t\r\n' + bad + '\n\v\n' + order);
  assert.equal(r.status, 1);
  assert.equal(r.stdout, resultLine(4));
  assert.deepEqual(diagnosticEvents(r.stderr), [
    { version: 1, type: 'record-error', line: 2, message: 'items[0].quantity must be a non-negative safe integer' },
    { version: 1, type: 'record-error', line: 3, message: 'input must contain one valid JSON order' },
    completion(1),
  ]);
  assert.doesNotMatch(r.stderr, /PRIVATE|1\.0000000000000001/);
});

test('JSONL real CLI unreadable input emits only a fatal event', t => {
  const dir = mkdtempSync(path.join(tmpdir(), 'packaging-diagnostics-'));
  t.after(() => rmSync(dir, { recursive: true, force: true }));
  const r = run(['--diagnostics=jsonl', path.join(dir, 'PRIVATE_MISSING')]);
  assert.equal(r.status, 1);
  assert.equal(r.stdout, '');
  assert.deepEqual(diagnosticEvents(r.stderr), [{ version: 1, type: 'fatal-error', operation: 'read-input', code: 'ENOENT' }]);
});


test('JSONL read failure never rejects an unterminated tail or completes', async t => {
  for (const tail of [order, '{PRIVATE_TAIL']) {
    const input = new PassThrough();
    t.after(() => input.destroy());
    let emitted;
    const first = new Promise(resolve => { emitted = resolve; });
    const chunks = [];
    const out = new Writable({ write(chunk, encoding, callback) { chunks.push(chunk.toString()); callback(); emitted(); } });
    const err = sink();
    const done = runBatch(input, out, err.stream, 'PRIVATE_SOURCE', jsonlOptions);
    input.write(order + '\n');
    await bounded(first);
    input.write(tail);
    await tick();
    input.destroy(ioError('EIO'));
    assert.equal(await bounded(done), 1);
    assert.equal(chunks.join(''), resultLine(1));
    assert.deepEqual(diagnosticEvents(err.text()), [{ version: 1, type: 'fatal-error', operation: 'read-input', code: 'EIO' }]);
  }
  const input = new PassThrough();
  const out = sink();
  const err = sink();
  const done = runBatch(input, out.stream, err.stream, undefined, jsonlOptions);
  input.write(order);
  await tick();
  input.destroy();
  assert.equal(await bounded(done), 1);
  assert.equal(out.text(), '');
  assert.deepEqual(diagnosticEvents(err.text()), [{ version: 1, type: 'fatal-error', operation: 'read-input', code: 'ERR_STREAM_PREMATURE_CLOSE' }]);
});

test('JSONL output callback/finalization failures are fatal, sanitized and never complete', async () => {
  for (const [options, code] of [
    [{ write(chunk, encoding, callback) { callback(ioError('ENOSPC')); } }, 'ENOSPC'],
    [{ final(callback) { callback(ioError('EIO')); } }, 'EIO'],
    [{ final(callback) { callback(ioError('PRIVATE / invalid code')); } }, 'IO_ERROR'],
  ]) {
    const out = sink(options);
    const err = sink();
    const status = await bounded(runBatch(Readable.from([Buffer.from(order + '\n')]), out.stream, err.stream, 'PRIVATE_SOURCE', jsonlOptions));
    assert.equal(status, 1);
    assert.deepEqual(diagnosticEvents(err.text()), [{ version: 1, type: 'fatal-error', operation: 'write-output', code }]);
  }
});

test('JSONL output failure/close cancels open input without completion', async t => {
  for (const close of [out => out.destroy(ioError('EPIPE')), out => out.destroy(), out => out.end()]) {
    const input = new PassThrough();
    const out = sink({ autoDestroy: false });
    const err = sink();
    t.after(() => input.destroy());
    const done = runBatch(input, out.stream, err.stream, undefined, jsonlOptions);
    await tick();
    close(out.stream);
    assert.equal(await bounded(done), 1);
    assert.equal(input.destroyed, true);
    const events = diagnosticEvents(err.text());
    assert.equal(events.length, 1);
    assert.equal(events[0].type, 'fatal-error');
    assert.equal(events[0].operation, 'write-output');
    assert.ok(['EPIPE', 'ERR_STREAM_PREMATURE_CLOSE'].includes(events[0].code));
  }
});

test('JSONL completion waits for output finalization and its own diagnostic write callback', async () => {
  let finishOutput;
  let finalStarted;
  const final = new Promise(resolve => { finalStarted = resolve; });
  const out = sink({ final(callback) { finishOutput = callback; finalStarted(); } });
  let finishDiagnostic;
  let diagnosticStarted;
  const diagnostic = new Promise(resolve => { diagnosticStarted = resolve; });
  const chunks = [];
  const err = new Writable({ write(chunk, encoding, callback) {
    chunks.push(chunk.toString()); finishDiagnostic = callback; diagnosticStarted();
  } });
  let settled = false;
  const done = runBatch(Readable.from([Buffer.from(order)]), out.stream, err, undefined, jsonlOptions).then(status => { settled = true; return status; });
  await bounded(final);
  assert.equal(chunks.length, 0);
  assert.equal(settled, false);
  finishOutput();
  await bounded(diagnostic);
  assert.equal(out.stream.writableFinished, true);
  assert.equal(settled, false);
  assert.deepEqual(diagnosticEvents(chunks.join('')), [completion(0)]);
  finishDiagnostic();
  assert.equal(await bounded(done), 0);
  assert.equal(chunks.length, 1);
  assert.equal(err.writableEnded, false);
});

test('JSONL diagnostic backpressure bounds read-ahead and preserves later results', async () => {
  let produced = 0;
  const total = 100;
  const input = Readable.from((function* () {
    for (let i = 0; i < total; i++) { produced++; yield Buffer.from('null\n'); }
    yield Buffer.from(order);
  })(), { objectMode: false, highWaterMark: 1 });
  let release;
  let started;
  const first = new Promise(resolve => { started = resolve; });
  const chunks = [];
  const err = new Writable({ highWaterMark: 1, write(chunk, encoding, callback) {
    chunks.push(chunk.toString());
    if (chunks.length === 1) { release = callback; started(); } else callback();
  } });
  const out = sink();
  const done = runBatch(input, out.stream, err, undefined, jsonlOptions);
  await bounded(first);
  await tick();
  assert.equal(chunks.length, 1);
  assert.ok(produced <= 3, 'do not buffer the whole rejected-order list');
  assert.equal(out.text(), '');
  release();
  assert.equal(await bounded(done), 1);
  const events = diagnosticEvents(chunks.join(''));
  assert.deepEqual(events.slice(0, -1).map(event => event.line), Array.from({ length: total }, (_, i) => i + 1));
  assert.deepEqual(events.at(-1), completion(1));
  assert.equal(out.text(), resultLine(total + 1));
  assert.equal(err.listenerCount('error'), 0);
  assert.equal(err.listenerCount('close'), 0);
});

test('JSONL diagnostic failures may deliver partial/full bytes but remain unsuccessful with no completion retry', async t => {
  for (const recordFailure of [true, false]) {
    for (const partial of [true, false]) {
      const input = new PassThrough();
      t.after(() => input.destroy());
      const out = sink();
      const chunks = [];
      let attempts = 0;
      const err = new Writable({ write(chunk, encoding, callback) {
        attempts++;
        chunks.push(chunk.subarray(0, partial ? 10 : chunk.length).toString());
        callback(ioError('EPIPE'));
      } });
      const done = runBatch(input, out.stream, err, undefined, jsonlOptions);
      if (recordFailure) input.write('null\n'); // Leave input open to prove cancellation.
      else input.end(); // The only diagnostic write is completion.
      assert.equal(await bounded(done), 1);
      assert.equal(input.destroyed, true);
      assert.equal(attempts, 1);
      const bytes = chunks.join('');
      if (partial) assert.throws(() => JSON.parse(bytes));
      else assert.equal(diagnosticEvents(bytes)[0].type, recordFailure ? 'record-error' : 'complete');
    }
  }
});

test('JSONL unusable diagnostic sink is fatal even for empty input', async () => {
  for (const close of [err => err.destroy(), err => err.end()]) {
    const input = new PassThrough();
    const out = sink();
    const err = sink();
    close(err.stream);
    const done = runBatch(input, out.stream, err.stream, undefined, jsonlOptions);
    assert.equal(await bounded(done), 1);
    assert.equal(input.destroyed, true);
    assert.equal(err.text(), '');
  }
});


test('JSONL later I/O failure invalidates a delivered completion without retrying it', async () => {
  for (const operation of ['read-input', 'write-output']) {
    const input = Readable.from([], { autoDestroy: false });
    const out = sink({ autoDestroy: false });
    const chunks = [];
    let release;
    let started;
    const first = new Promise(resolve => { started = resolve; });
    const err = new Writable({ write(chunk, encoding, callback) {
      chunks.push(chunk.toString());
      if (chunks.length === 1) { release = callback; started(); } else callback();
    } });
    const done = runBatch(input, out.stream, err, undefined, jsonlOptions);
    await bounded(first);
    assert.equal(out.stream.writableFinished, true);
    assert.deepEqual(diagnosticEvents(chunks.join('')), [completion(0)]);
    (operation === 'read-input' ? input : out.stream).destroy(ioError('EIO'));
    await tick();
    release();
    assert.equal(await bounded(done), 1);
    assert.deepEqual(diagnosticEvents(chunks.join('')), [
      completion(0),
      { version: 1, type: 'fatal-error', operation, code: 'EIO' },
    ]);
  }
});
