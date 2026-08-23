const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');

const {
  detectAgentAdapters,
  resolveAgentExecutable
} = require('../src/main/agents/agent-adapters.mts');

function createExecutable(filename) {
  fs.mkdirSync(path.dirname(filename), { recursive: true });
  fs.writeFileSync(filename, 'fixture');
}

test('Windows discovery finds OpenCode npm and Codex Desktop binaries outside PATH', t => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'gittree-agent-adapters-'));
  t.after(() => fs.rmSync(root, { recursive: true, force: true }));
  const appData = path.join(root, 'Roaming');
  const localAppData = path.join(root, 'Local');
  const opencode = path.join(
    appData, 'npm', 'node_modules', 'opencode-ai', 'bin', 'opencode.exe'
  );
  const oldCodex = path.join(localAppData, 'OpenAI', 'Codex', 'bin', 'old', 'codex.exe');
  const currentCodex = path.join(localAppData, 'OpenAI', 'Codex', 'bin', 'current', 'codex.exe');
  createExecutable(opencode);
  createExecutable(oldCodex);
  createExecutable(currentCodex);
  fs.utimesSync(oldCodex, new Date(1_000), new Date(1_000));
  fs.utimesSync(currentCodex, new Date(2_000), new Date(2_000));

  const options = {
    platform: 'win32',
    environment: { PATH: '', APPDATA: appData, LOCALAPPDATA: localAppData }
  };

  assert.equal(resolveAgentExecutable('opencode', options), opencode);
  assert.equal(resolveAgentExecutable('codex', options), currentCodex);
});

test('adapter detection isolates spawn failures and accepts a started CLI with a non-zero version probe', async () => {
  const execute = (executable, _args, _options, callback) => {
    if (executable.endsWith('claude.exe')) {
      const error = new Error('access denied');
      error.code = 'EPERM';
      throw error;
    }
    if (executable.endsWith('codex.exe')) {
      const error = new Error('version command returned one');
      error.code = 1;
      callback(error, 'codex-cli 1.2.3', '');
      return;
    }
    callback(null, 'opencode 2.3.4', '');
  };

  const result = await detectAgentAdapters({
    execute,
    resolveExecutable: command => `C:\\tools\\${command}.exe`
  });

  assert.deepEqual(result, [
    { id: 'codex', label: 'Codex', available: true, version: '' },
    { id: 'claude', label: 'Claude Code', available: false, version: '' },
    { id: 'opencode', label: 'OpenCode', available: true, version: 'opencode 2.3.4' }
  ]);
});
