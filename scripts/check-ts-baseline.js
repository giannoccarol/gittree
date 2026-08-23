const path = require('node:path');
const { spawnSync } = require('node:child_process');
const fs = require('node:fs');

const ROOT = path.resolve(__dirname, '..');
const BASELINE_FILE = path.join(ROOT, 'tserror-baseline.json');
const TSCONFIG = 'tsconfig.typecheck.json';

function runTypecheck() {
  const tscBin = path.join(ROOT, 'node_modules', 'typescript', 'bin', 'tsc');
  const result = spawnSync(process.execPath, [tscBin, '-p', TSCONFIG, '--pretty', 'false'], {
    cwd: ROOT,
    encoding: 'utf8',
    maxBuffer: 64 * 1024 * 1024
  });
  if (result.error) throw result.error;
  return result.stdout || '';
}

function parseErrors(output) {
  return output
    .split(/\r?\n/)
    .filter(line => /error TS\d+:/.test(line))
    .map(line => line.trim());
}

function countByDirectory(errors) {
  const counts = {};
  for (const line of errors) {
    const file = line.split('(')[0].replaceAll('\\', '/');
    const dir = path.posix.dirname(file);
    counts[dir] = (counts[dir] || 0) + 1;
  }
  return counts;
}

function readBaseline() {
  if (!fs.existsSync(BASELINE_FILE)) return null;
  return JSON.parse(fs.readFileSync(BASELINE_FILE, 'utf8'));
}

function writeBaseline(errors) {
  const baseline = {
    count: errors.length,
    generatedAt: new Date().toISOString(),
    perDirectory: countByDirectory(errors)
  };
  fs.writeFileSync(BASELINE_FILE, `${JSON.stringify(baseline, null, 2)}\n`);
  return baseline;
}

function summarizeByDirectory(errors) {
  const counts = countByDirectory(errors);
  return Object.entries(counts)
    .sort((a, b) => b[1] - a[1])
    .map(([dir, count]) => `  ${dir}: ${count}`)
    .join('\n');
}

function main() {
  const args = process.argv.slice(2);
  const update = args.includes('--update');
  const output = runTypecheck();
  const errors = parseErrors(output);

  if (update) {
    const previous = readBaseline();
    writeBaseline(errors);
    process.stdout.write(
      `Baseline updated: ${previous ? `${previous.count} -> ` : ''}${errors.length} error(s).\n`
      + `${summarizeByDirectory(errors)}\n`
    );
    return;
  }

  const baseline = readBaseline();
  if (!baseline) {
    writeBaseline(errors);
    process.stdout.write(
      `No baseline found; created one at ${path.basename(BASELINE_FILE)} `
      + `with ${errors.length} error(s).\n`
      + `${summarizeByDirectory(errors)}\n`
    );
    return;
  }

  if (errors.length > baseline.count) {
    process.stderr.write(
      `TypeScript ratchet violated: ${errors.length} error(s) > baseline ${baseline.count}.\n`
      + 'New or regressed errors must be fixed, never added. Run '
      + '`npm run typecheck` for the full list.\n'
      + `${summarizeByDirectory(errors)}\n`
    );
    process.exitCode = 1;
    return;
  }

  if (errors.length < baseline.count) {
    writeBaseline(errors);
    process.stdout.write(
      `TypeScript ratchet tightened: ${baseline.count} -> ${errors.length} error(s). `
      + 'Commit the updated tserror-baseline.json.\n'
    );
    return;
  }

  process.stdout.write(`TypeScript ratchet holds at ${errors.length} error(s).\n`);
}

if (require.main === module) {
  main();
}

module.exports = { parseErrors, countByDirectory };
