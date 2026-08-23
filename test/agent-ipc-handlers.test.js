const test = require('node:test');
const assert = require('node:assert/strict');

const { registerAgentHandlers } = require('../src/main/ipc/agent-handlers.mts');

function harness() {
  const handlers = new Map();
  const managed = new Set();
  const calls = [];
  const service = {
    getSettings: () => ({ maxConcurrent: 4 }),
    setWorktreeRoot: root => ({ worktreeRoot: root }),
    setConcurrency: value => ({ maxConcurrent: value }),
    setEnabledAdapters: ids => ({ enabledAdapters: ids }),
    detectAdapters: async () => [],
    listTasks: repo => [{ repositoryPath: repo }],
    createTask: async (repo, options) => ({ repo, options }),
    createTaskForWorktree: async (repo, worktree, options) => ({ repo, worktree, options }),
    stopTask: id => calls.push(['stop', id]),
    resumeTask: id => calls.push(['resume', id]),
    archiveTask: id => calls.push(['archive', id]),
    writeTerminal: (id, data) => calls.push(['write', id, data]),
    resizeTerminal: (id, cols, rows) => calls.push(['resize', id, cols, rows]),
    acknowledgeAttention: id => calls.push(['attention', id])
  };
  const repositoryWorkspace = {
    getGitService: () => ({ getWorktrees: async () => [{ path: 'C:\\repo' }] }),
    resolvePath: value => value,
    pathKey: value => value.toLowerCase(),
    addTrustedRepository: path => ({ path })
  };
  registerAgentHandlers({
    registerHandler: (channel, fn) => handlers.set(channel, fn),
    registerManagedRepoHandler: (channel, fn) => { handlers.set(channel, fn); managed.add(channel); },
    agentSessionService: service,
    repositoryWorkspace,
    showOpenDialog: async () => ({ canceled: false, filePaths: ['C:\\agents'] }),
    getMainWindow: () => ({})
  });
  return { handlers, managed, calls };
}

test('agent IPC keeps repository operations behind the managed registrar', async () => {
  const { handlers, managed } = harness();
  assert.deepEqual([...managed].sort(), [
    'agent:task-create', 'agent:task-create-worktree', 'agent:tasks', 'agent:worktree-open'
  ]);
  assert.deepEqual(await handlers.get('agent:root-select')(), { worktreeRoot: 'C:\\agents' });
  assert.deepEqual(await handlers.get('agent:worktree-open')('C:\\repo', 'C:\\repo'), {
    path: 'C:\\repo'
  });
});

test('terminal and task handlers forward only named capability arguments', async () => {
  const { handlers, calls } = harness();
  handlers.get('agent:terminal-write')('task', 'input');
  handlers.get('agent:terminal-resize')('task', 100, 30);
  handlers.get('agent:task-stop')('task');
  assert.deepEqual(calls, [
    ['write', 'task', 'input'],
    ['resize', 'task', 100, 30],
    ['stop', 'task']
  ]);
});

