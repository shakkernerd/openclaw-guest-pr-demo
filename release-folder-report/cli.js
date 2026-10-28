#!/usr/bin/env node
'use strict';

const { review, deliver } = require('./index');

const usage = 'Usage: node release-folder-report/cli.js INPUT.json --out NEW_DIRECTORY\n\n' +
  'Review named folders against saved directory-manifest baselines, then explicitly\n' +
  'create NEW_DIRECTORY/report.md, report.json, and a final COMPLETE.json receipt.\n' +
  'The output parent must exist. Existing output paths are never overwritten.\n' +
  'Relative input paths use INPUT.json\'s directory; --out uses the working directory.\n' +
  'Use -- to end option parsing (e.g. --out ./review-01 -- -input.json).\n\n' +
  'Exit: 0 all match/help; 1 differences only; 2 input/inspection/delivery error;\n' +
  '130 SIGINT; 143 SIGTERM. Delivery failure takes precedence over cancellation.\n' +
  'Cancellation finishes the active check, skips later folders, and delivers results.\n';

function options(argv) {
  if (argv.length === 1 && ['--help', '-h'].includes(argv[0])) return null;
  const positional = [];
  let out;
  let flags = true;
  for (let i = 0; i < argv.length; i++) {
    const arg = argv[i];
    if (flags && arg === '--') flags = false;
    else if (flags && arg === '--out' && out === undefined) {
      out = argv[++i];
      if (!out || out.startsWith('--')) throw new Error('--out needs a directory (use ./ for a leading dash)');
    } else if (flags && arg.startsWith('-')) throw new Error('Unknown or repeated option: ' + arg);
    else positional.push(arg);
  }
  if (positional.length !== 1 || !positional[0] || !out) throw new Error(usage.trim());
  return { input: positional[0], out };
}

async function main(argv) {
  const args = options(argv);
  if (!args) { process.stdout.write(usage); return 0; }
  const controller = new AbortController();
  const interrupt = () => controller.abort('SIGINT');
  const terminate = () => controller.abort('SIGTERM');
  process.on('SIGINT', interrupt);
  process.on('SIGTERM', terminate);
  try {
    const report = await review(args.input, {
      signal: controller.signal,
      onProgress(event) {
        process.stderr.write((event.phase === 'checking' ? 'Checking' : 'Finished') +
          ' [' + event.index + '/' + event.total + '] ' + JSON.stringify(event.name) +
          (event.status ? ': ' + event.status : '') + '\n');
      },
    });
    const s = report.summary;
    process.stderr.write('Review: ' + s.checked + '/' + s.requested + ' checked; ' +
      s.matched + ' match, ' + s.different + ' different, ' + s.errors + ' error, ' + s.skipped + ' skipped.\n');
    const output = await deliver(report, args.out);
    // A signal received during delivery does not undo already-completed checks.
    const signalDuringDelivery = controller.signal.aborted && !report.cancellation ? controller.signal.reason : null;
    const commandExitCode = controller.signal.aborted ? (controller.signal.reason === 'SIGTERM' ? 143 : 130) : report.exitCode;
    if (signalDuringDelivery) process.stderr.write('Cancellation received during delivery; the review snapshot was already finalized.\n');
    // stdout is a single machine-readable delivery acknowledgment, not the report.
    process.stdout.write(JSON.stringify({ delivered: true, directory: output, runId: report.runId,
      reviewExitCode: report.exitCode, commandExitCode, signalDuringDelivery,
      files: ['report.md', 'report.json', 'COMPLETE.json'] }) + '\n');
    return commandExitCode;
  } finally {
    process.off('SIGINT', interrupt);
    process.off('SIGTERM', terminate);
  }
}

if (require.main === module) main(process.argv.slice(2)).then((code) => {
  process.exitCode = code;
}).catch((error) => {
  process.stderr.write('release-folder-report: ' + JSON.stringify(error.message) + '\n');
  process.exitCode = 2;
});

module.exports = { main };
