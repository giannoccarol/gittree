const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const { EventEmitter } = require('node:events');

const { AgentSessionStore } = require('../src/main/agents/agent-session-store.mts');
const { AgentSessionService } = require('../src/main/agents/agent-session-service.mts');
const { detectSetupRecipe } = require('../src/main/agents/setup-recipes.mts');

class FakePty extends EventEmitter {
  constructor(command, args, options) {
    super();
    this.command = command;
    this.args = args;
    this.options = options;
    this.writes = [];
    this.resizes = [];
    this.killed = false;
  }
  onData(listener) { this.on('data', listener); return { dispose: () => this.off('data', listener) }; }
  onExit(listener) { this.on('exit', listener); return { dispose: () => this.off('exit', listener) }; }
  write(value) { this.writes.push(value); }
  resize(cols, rows) { this.resizes.push([cols, rows]); }
  kill() { this.killed = true; this.emit('exit', { exitCode: 130, signal: 2 }); }
}

function createWorkspace(root) {
  const repositories = [];
  const services = new Map();
  return {
    list: () => [...repositories],
    addTrustedRepository(repoPath) {
      const repo = { path: repoPath, name: path.basename(repoPath) };
      if (!repositories.some(item => item.path === repoPath)) repositories.push(repo);
      return repo;
    },
    getGitService(repoPath) {
      if (!services.has(repoPath)) {
        services.set(repoPath, {
          async createManagedWorktree(options) {
            fs.mkdirSync(options.directory, { recursive: true });
            return { success: true, path: options.directory, branch: options.branch };
          },
          async getWorktrees() {
            return repositories.map(item => ({ path: item.path, branch: 'main' }));
          },
          async getStatus() { return { files: [], ahead: 0, behind: 0 }; }
        });
      }
      return services.get(repoPath);
    },
    root
  };
}

function harness(t, { maxConcurrent = 1, extraEnv = () => ({}) } = {}) {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'gittree-agents-'));
  t.after(() => fs.rmSync(root, { recursive: true, force: true }));
  const repo = path.join(root, 'repo');
  const worktreeRoot = path.join(root, 'worktrees');
  fs.mkdirSync(repo);
  fs.mkdirSync(worktreeRoot);
  const workspace = createWorkspace(root);
  workspace.addTrustedRepository(repo);
  const ptys = [];
  const events = [];
  let id = 0;
  const service = new AgentSessionService({
    storagePath: path.join(root, 'agent-workspace.json'),
    repositoryWorkspace: workspace,
    createPty(command, args, options) {
      const pty = new FakePty(command, args, options);
      ptys.push(pty);
      return pty;
    },
    emit: (channel, payload) => events.push([channel, payload]),
    idFactory: () => `00000000-0000-4000-8000-${String(++id).padStart(12, '0')}`,
    setInterval: () => 1,
    clearInterval: () => {},
    extraEnv,
    resolveExecutable: command => command
  });
  service.setWorktreeRoot(worktreeRoot);
  service.setConcurrency(maxConcurrent);
  return { root, repo, worktreeRoot, workspace, ptys, events, service };
}

test('agent store restores active tasks as interrupted without retaining prompts', t => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'gittree-agent-store-'));
  t.after(() => fs.rmSync(root, { recursive: true, force: true }));
  const storagePath = path.join(root, 'agent-workspace.json');
  const store = new AgentSessionStore({ storagePath });
  store.save({
    settings: { worktreeRoot: root, maxConcurrent: 4, enabledAdapters: ['codex'] },
    tasks: [{ id: 'task', title: 'Task', prompt: 'secret', status: 'running', events: [] }]
  });

  const restored = new AgentSessionStore({ storagePath }).load();
  assert.equal(restored.tasks[0].status, 'interrupted');
  assert.equal('prompt' in restored.tasks[0], false);
});

test('queues tasks globally and starts the next agent when a slot is released', async t => {
  const { service, repo, ptys } = harness(t);
  const first = await service.createTask(repo, {
    title: 'First task', prompt: 'Implement first', baseRef: 'main', adapterId: 'codex'
  });
  const second = await service.createTask(repo, {
    title: 'Second task', prompt: 'Implement second', baseRef: 'main', adapterId: 'claude'
  });

  assert.equal(service.getTask(first.id).status, 'running');
  assert.equal(service.getTask(second.id).status, 'queued');
  assert.equal(ptys[0].command, 'codex');
  assert.deepEqual(ptys[0].args, ['Implement first']);

  ptys[0].emit('exit', { exitCode: 0, signal: 0 });
  await new Promise(resolve => setImmediate(resolve));
  assert.equal(service.getTask(first.id).status, 'completed');
  assert.equal(service.getTask(second.id).status, 'running');
  assert.equal(ptys[1].command, 'claude');
});

test('enforces one active task per worktree and validates terminal capabilities', async t => {
  const { service, repo, ptys } = harness(t, { maxConcurrent: 2 });
  const task = await service.createTaskForWorktree(repo, repo, {
    title: 'Main task', prompt: 'Inspect main', adapterId: 'opencode', allowMain: true
  });
  await assert.rejects(
    service.createTaskForWorktree(repo, repo, {
      title: 'Collision', prompt: 'Collide', adapterId: 'codex', allowMain: true
    }),
    /already has an active agent task/
  );
  assert.equal(ptys[0].command, 'opencode');
  assert.deepEqual(ptys[0].args, ['--prompt', 'Inspect main']);

  service.writeTerminal(task.id, 'hello');
  service.resizeTerminal(task.id, 120, 40);
  assert.deepEqual(ptys[0].writes, ['hello']);
  assert.deepEqual(ptys[0].resizes, [[120, 40]]);
  assert.throws(() => service.resizeTerminal(task.id, 2, 1000), /Invalid terminal size/);
  assert.throws(() => service.writeTerminal(task.id, 'x'.repeat(20_000)), /Terminal input is too large/);
});

test('stops a PTY, releases its worktree and records attention from terminal bell', async t => {
  const { service, repo, ptys } = harness(t);
  const task = await service.createTask(repo, {
    title: 'Stop task', prompt: 'Wait', baseRef: 'main', adapterId: 'codex'
  });
  ptys[0].emit('data', 'working\u0007');
  assert.equal(service.getTask(task.id).needsAttention, true);
  service.acknowledgeAttention(task.id);
  assert.equal(service.getTask(task.id).needsAttention, false);
  await service.stopTask(task.id);
  assert.equal(ptys[0].killed, true);
  assert.equal(service.getTask(task.id).status, 'stopped');
});

test('detects only fixed lockfile setup recipes', t => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'gittree-recipes-'));
  t.after(() => fs.rmSync(root, { recursive: true, force: true }));
  fs.writeFileSync(path.join(root, 'pnpm-lock.yaml'), 'lockfileVersion: 9');
  assert.deepEqual(detectSetupRecipe(root), {
    id: 'pnpm-frozen', command: 'pnpm', args: ['install', '--frozen-lockfile']
  });
});

test('rejects nested roots, unknown adapters and arbitrary executable options', async t => {
  const { service, repo, ptys } = harness(t);
  const nested = path.join(repo, 'agents');
  fs.mkdirSync(nested);
  assert.throws(() => service.setWorktreeRoot(nested), /cannot be inside/);
  await assert.rejects(service.createTask(repo, {
    title: 'Unknown', prompt: 'Do work', adapterId: 'custom', executable: 'powershell.exe'
  }), /Unknown agent adapter/);
  const task = await service.createTask(repo, {
    title: 'Fixed adapter', prompt: 'Do work', adapterId: 'codex',
    executable: 'powershell.exe', argv: ['-Command', 'malicious']
  });
  assert.equal(service.getTask(task.id).status, 'running');
  assert.equal(ptys[0].command, 'codex');
  assert.deepEqual(ptys[0].args, ['Do work']);
});

test('validates adapter settings and oversized renderer input', async t => {
  const { service, repo } = harness(t);
  assert.throws(() => service.setConcurrency(33), /between 1 and 32/);
  assert.throws(() => service.setEnabledAdapters(['custom']), /Unknown agent adapter/);
  assert.deepEqual(service.setEnabledAdapters(['codex']).enabledAdapters, ['codex']);
  await assert.rejects(service.createTask(repo, {
    title: 'Oversized', prompt: 'x'.repeat(32_769), adapterId: 'codex'
  }), /prompt is invalid/);
});

test('feature toggle preserves state, blocks new work and cannot hide active or queued tasks', async t => {
  const { service, repo, ptys } = harness(t);
  const first = await service.createTask(repo, {
    title: 'Active task', prompt: 'Wait', baseRef: 'main', adapterId: 'codex'
  });
  await service.createTask(repo, {
    title: 'Queued task', prompt: 'Wait too', baseRef: 'main', adapterId: 'claude'
  });
  assert.throws(() => service.setAgentsEnabled(false), /active or queued/);
  await service.stopTask(first.id);
  await service.stopTask(service.listTasks(repo).find(task => task.status === 'running').id);
  const settings = service.setAgentsEnabled(false);
  assert.equal(settings.agentsEnabled, false);
  await assert.rejects(service.createTask(repo, {
    title: 'Blocked', prompt: 'Do not run', baseRef: 'main', adapterId: 'codex'
  }), /disabled in Settings/);
  const stopped = service.listTasks(repo).find(task => task.status === 'stopped');
  assert.throws(() => service.resumeTask(stopped.id), /disabled in Settings/);
  assert.equal(ptys.length, 2);
  assert.equal(service.listTasks(repo).length, 2);
});

test('adapter detection reuses a cached result within its TTL', async t => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'gittree-agent-detect-'));
  t.after(() => fs.rmSync(root, { recursive: true, force: true }));
  const workspace = createWorkspace(root);
  let clock = 0;
  let executions = 0;
  const service = new AgentSessionService({
    storagePath: path.join(root, 'agent-workspace.json'),
    repositoryWorkspace: workspace,
    createPty: () => new FakePty('x', [], {}),
    nowMs: () => clock,
    adapterDetectionTtl: 60_000,
    setInterval: () => 1,
    clearInterval: () => {},
    resolveExecutable: command => command,
    execute: (command, args, options, callback) => {
      executions += 1;
      callback(null, command + ' 1.0', '');
    }
  });

  const first = await service.detectAdapters();
  assert.equal(first.length, 3);
  assert.equal(executions, 3);

  clock = 30_000;
  await service.detectAdapters();
  assert.equal(executions, 3);

  clock = 61_000;
  await service.detectAdapters();
  assert.equal(executions, 6);
});

test('agent CLIs inherit the configured AI environment', async t => {
  const { service, repo, ptys } = harness(t, {
    extraEnv: () => ({ OPENAI_API_KEY: 'sk-injected', OPENAI_BASE_URL: 'https://api.deepseek.com/v1' })
  });
  await service.createTask(repo, {
    title: 'AI task', prompt: 'Do the thing', baseRef: 'main', adapterId: 'codex'
  });
  assert.equal(ptys[0].options.env.OPENAI_API_KEY, 'sk-injected');
  assert.equal(ptys[0].options.env.OPENAI_BASE_URL, 'https://api.deepseek.com/v1');
});
