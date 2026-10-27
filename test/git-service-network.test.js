const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const { GitService } = require('../src/main/git-service.mts');
const { RepositorySession } = require('../src/main/git/repository-session.mts');
const {
  DEFAULT_NETWORK_TIMEOUT_SECONDS,
  NetworkTimeoutError,
  RemoteTransport,
  parseNetworkTimeout
} = require('../src/main/git/remote-transport.mts');
const { createRepository, git } = require('./helpers/git-repository');

// The fake remote outlives the 1 s timeout under test by a wide margin, then
// exits on its own so every Git process still attached to it ends too.
const STALLED_SSH_LIFETIME_MS = 5000;

// A stand-in for `ssh` that accepts the connection and never answers, like a
// remote behind a dead VPN. It records the environment Git gave it and its
// pid, and exits once Git closes the pipe.
const STALLED_SSH = `
const fs = require('node:fs');
fs.writeFileSync(process.argv[2], JSON.stringify({
  terminalPrompt: process.env.GIT_TERMINAL_PROMPT ?? null
}));
fs.appendFileSync(process.argv[2] + '.pids', process.pid + '\\n');
process.stdin.resume();
process.stdin.on('end', () => process.exit(0));
setTimeout(() => process.exit(0), ${STALLED_SSH_LIFETIME_MS});
`;

// `git pull` runs an inner `git fetch` that survives when the timeout stops
// the outer process, so that fetch keeps its pipe to the fake ssh open.
// Close the fakes explicitly; the orphaned fetch then exits on EOF.
function stopStalledSsh(record) {
  let pids = [];
  try {
    pids = fs.readFileSync(`${record}.pids`, 'utf8').split(/\s+/).filter(Boolean).map(Number);
  } catch { /* no fake ssh was started */ }
  for (const pid of pids) {
    try { process.kill(pid); } catch { /* already exited */ }
  }
}

// On Windows the Git process stopped by the timeout can leave children that
// keep the repository as their working directory until the fake remote is
// gone, and Windows refuses to delete a directory in use. Wait for them with
// a budget that covers the fake remote's lifetime, and list what is still
// running if the directory stays busy.
function removeWhenReleased(t, directory) {
  try {
    // Linear backoff: 100 ms, 200 ms, … 2 s, about 21 s in total.
    fs.rmSync(directory, { recursive: true, force: true, maxRetries: 20, retryDelay: 100 });
  } catch (error) {
    if (process.platform === 'win32') {
      try {
        const listing = require('node:child_process').execFileSync('powershell.exe', [
          '-NoProfile',
          '-Command',
          "Get-CimInstance Win32_Process | Where-Object { $_.Name -match '^(git|sh|bash|ssh|node)' } "
            + '| Select-Object ProcessId,ParentProcessId,Name,CommandLine | Format-Table -AutoSize | Out-String -Width 400'
        ], { encoding: 'utf8' });
        t.diagnostic(`Processes still running:\n${listing}`);
      } catch { /* diagnostics are best effort */ }
    }
    throw error;
  }
}

// Git prefers these variables over core.sshCommand; keep the fixture isolated
// from the developer's own SSH setup.
const SSH_OVERRIDES = ['GIT_SSH', 'GIT_SSH_COMMAND', 'GIT_SSH_VARIANT'];

function withoutSshOverrides(t) {
  const saved = SSH_OVERRIDES.map(name => [name, process.env[name]]);
  for (const name of SSH_OVERRIDES) delete process.env[name];
  t.after(() => {
    for (const [name, value] of saved) {
      if (value === undefined) delete process.env[name];
      else process.env[name] = value;
    }
  });
}

function createStalledRemoteRepository(t, timeoutSeconds) {
  withoutSshOverrides(t);
  const repo = createRepository();
  const script = path.join(repo.root, 'stalled-ssh.js');
  const record = path.join(repo.root, 'ssh-environment.json');
  t.after(() => {
    stopStalledSsh(record);
    removeWhenReleased(t, repo.root);
  });
  repo.write('readme.txt', 'base\n');
  repo.git('add', '.');
  repo.git('commit', '-m', 'base');
  fs.writeFileSync(script, STALLED_SSH);
  const quote = value => `"${value.replaceAll('\\', '/')}"`;
  repo.git('config', 'core.sshCommand', `${quote(process.execPath)} ${quote(script)} ${quote(record)}`);
  repo.git('config', 'ssh.variant', 'ssh');
  repo.git('remote', 'add', 'stalled', 'ssh://stalled.invalid/remote.git');
  repo.git('config', 'gittree.networkTimeout', String(timeoutSeconds));
  return { repo, record };
}

test('parses the configured network timeout in whole seconds', () => {
  assert.equal(DEFAULT_NETWORK_TIMEOUT_SECONDS, 300);
  assert.equal(parseNetworkTimeout(''), DEFAULT_NETWORK_TIMEOUT_SECONDS);
  assert.equal(parseNetworkTimeout(undefined), DEFAULT_NETWORK_TIMEOUT_SECONDS);
  assert.equal(parseNetworkTimeout(' 45 '), 45);
  assert.equal(parseNetworkTimeout('0'), 0);
  assert.equal(parseNetworkTimeout('-5'), DEFAULT_NETWORK_TIMEOUT_SECONDS);
  assert.equal(parseNetworkTimeout('1.5'), DEFAULT_NETWORK_TIMEOUT_SECONDS);
  assert.equal(parseNetworkTimeout('2m'), DEFAULT_NETWORK_TIMEOUT_SECONDS);
  assert.equal(parseNetworkTimeout('999999'), 24 * 60 * 60);
});

test('stops fetch, pull and push on a stalled remote with a clear error', { timeout: 60000 }, async t => {
  const { repo, record } = createStalledRemoteRepository(t, 1);
  const service = new GitService(repo.repository);

  const cases = [
    ['git fetch', 'Failed to fetch', () => service.fetch('stalled')],
    ['git pull', 'Failed to pull', () => service.pull('stalled', 'main')],
    ['git push', 'Failed to push', () => service.push('stalled', 'main')]
  ];
  for (const [command, prefix, run] of cases) {
    await assert.rejects(run(), error => {
      assert.equal(
        error.message,
        `${prefix}: ${command} stopped: the remote did not respond within 1 s. `
          + 'Check the connection and try again.'
      );
      assert.ok(error.cause instanceof NetworkTimeoutError);
      return true;
    });
  }

  // Git must never wait on a terminal prompt nobody can answer.
  assert.deepEqual(JSON.parse(fs.readFileSync(record, 'utf8')), { terminalPrompt: '0' });
  // The per-repository queue is free again for reads.
  const snapshot = await service.getWorkingTree();
  assert.equal(snapshot.files.length, 0);
});

test('routes raw network commands of the session adapter through the timeout', { timeout: 60000 }, async t => {
  const { repo } = createStalledRemoteRepository(t, 1);
  const { git: adapter } = new RepositorySession(repo.repository);

  for (const [command, args] of [
    ['git fetch', ['fetch', 'stalled', 'refs/heads/main']],
    ['git ls-remote', ['ls-remote', 'stalled']]
  ]) {
    await assert.rejects(adapter.raw(args), error => {
      assert.ok(error instanceof NetworkTimeoutError);
      assert.equal(error.command, command);
      return true;
    });
  }
  // Local commands keep the original simple-git adapter behavior.
  assert.equal((await adapter.raw(['rev-parse', '--abbrev-ref', 'HEAD'])).trim(), 'main');
});

test('a zero timeout disables the limit and other remotes keep working', async t => {
  const repo = createRepository();
  t.after(() => repo.cleanup());
  repo.write('readme.txt', 'base\n');
  repo.git('add', '.');
  repo.git('commit', '-m', 'base');
  const remote = path.join(repo.root, 'origin.git');
  git(repo.root, 'init', '--bare', '-b', 'main', remote);
  repo.git('remote', 'add', 'origin', remote);
  repo.git('config', 'gittree.networkTimeout', '0');
  const service = new GitService(repo.repository);

  await service.push('origin', 'main', true);
  const fetched = await service.fetch('origin');
  assert.equal(fetched.success, true);
  assert.equal(git(remote, 'rev-parse', 'main'), repo.git('rev-parse', 'HEAD'));
});

test('keeps the inherited environment that simple-git would otherwise refuse', async t => {
  const repo = createRepository();
  t.after(() => repo.cleanup());
  const captured = [];
  const transport = new RemoteTransport({
    repoPath: repo.repository,
    readTimeoutSeconds: () => 30,
    env: {
      ...process.env,
      GIT_EDITOR: 'vi',
      EDITOR: 'vi',
      PAGER: 'less',
      SSH_ASKPASS: '/usr/bin/ksshaskpass',
      GIT_ASKPASS: '/usr/bin/git-askpass',
      GIT_SSH_COMMAND: 'ssh -o BatchMode=yes',
      GIT_CONFIG_COUNT: '1',
      GIT_CONFIG_KEY_0: 'credential.helper',
      GIT_CONFIG_VALUE_0: ''
    },
    createGit: options => {
      captured.push(options);
      return require('simple-git').simpleGit(options);
    }
  });

  const output = await transport.run('git ls-remote', instance => instance.raw(['var', 'GIT_EDITOR']));
  assert.equal(output.trim(), 'vi');
  assert.deepEqual(captured[0].timeout, { block: 30000 });
  assert.equal(captured[0].unsafe.allowUnsafeEditor, true);
  assert.equal(captured[0].unsafe.allowUnsafePack, undefined);

  const disabled = new RemoteTransport({
    repoPath: repo.repository,
    readTimeoutSeconds: async () => 0,
    createGit: options => {
      captured.push(options);
      return require('simple-git').simpleGit(options);
    }
  });
  await disabled.run('git ls-remote', instance => instance.raw(['rev-parse', '--git-dir']));
  assert.equal(captured[1].timeout, undefined);
});
