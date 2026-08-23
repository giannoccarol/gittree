const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const AdmZip = require('adm-zip');

const { DiagnosticsExporter, buildDiagnosticsData } = require('../src/main/diagnostics-exporter.mts');

test('diagnostics redact credentials, remote URLs and absolute repository paths', () => {
  const repositoryPath = 'C:\\Users\\person\\secret-repository';
  const diagnostics = buildDiagnosticsData({
    versions: {
      app: '0.8.0',
      electron: '43.2.0',
      node: '22.23.0',
      git: '2.51.0'
    },
    system: { platform: 'win32', release: 'test', arch: 'x64' },
    updateState: { status: 'idle' },
    repositories: [{ path: repositoryPath }],
    logs: [
      `opened ${repositoryPath}`,
      'remote https://github.com/private/secret.git',
      'authorization=Bearer ghp_abcdefghijklmnopqrstuvwxyz'
    ].join('\n'),
    checks: { quality: 'passed' }
  });
  const serialized = JSON.stringify(diagnostics);

  assert.doesNotMatch(serialized, /secret-repository/i);
  assert.doesNotMatch(serialized, /github\.com/i);
  assert.doesNotMatch(serialized, /ghp_/i);
  assert.doesNotMatch(serialized, /Users\\person/i);
  assert.match(diagnostics.logs, /\[REDACTED_PATH\]/);
  assert.match(diagnostics.logs, /\[REDACTED_URL\]/);
  assert.equal(diagnostics.summary.repositories.length, 1);
  assert.match(diagnostics.summary.repositories[0].id, /^[a-f0-9]{16}$/);
});

test('diagnostics exporter writes a local redacted ZIP and supports cancel', async t => {
  const directory = fs.mkdtempSync(path.join(os.tmpdir(), 'gittree-diagnostics-'));
  t.after(() => fs.rmSync(directory, { recursive: true, force: true }));
  const logPath = path.join(directory, 'gittree.log');
  const outputPath = path.join(directory, 'exports', 'diagnostics.zip');
  fs.writeFileSync(logPath, [
    'authorization=Bearer ghp_abcdefghijklmnopqrstuvwxyz',
    'remote https://github.com/private/repository.git'
  ].join('\n'));
  fs.writeFileSync(`${logPath}.1`, 'token=glpat-abcdefghijk');
  let canceled = true;
  const exporter = new DiagnosticsExporter({
    app: { getVersion: () => '0.8.0' },
    showSaveDialog: async options => {
      assert.match(options.defaultPath, /^GitTree-diagnostics-\d{4}-\d{2}-\d{2}\.zip$/);
      return canceled ? { canceled: true } : { canceled: false, filePath: outputPath };
    },
    logger: { file: logPath },
    getGitVersion: async () => '2.51.0',
    getUpdateState: () => ({ status: 'idle' }),
    getRepositories: () => [{ path: path.join(directory, 'private-repository') }],
    getChecks: () => ({ quality: 'passed', path: directory })
  });

  assert.deepEqual(await exporter.export(), { canceled: true });
  canceled = false;
  assert.deepEqual(await exporter.export(), { success: true });
  const zip = new AdmZip(outputPath);
  assert.deepEqual(zip.getEntries().map(entry => entry.entryName).sort(), [
    'checks.json', 'logs.txt', 'summary.json'
  ]);
  const contents = zip.getEntries().map(entry => entry.getData().toString('utf8')).join('\n');
  assert.doesNotMatch(contents, /ghp_|glpat|github\.com|private-repository/i);
  assert.match(contents, /REDACTED/);
});
