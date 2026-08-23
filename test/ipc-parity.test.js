const fs = require('node:fs');
const path = require('node:path');
const test = require('node:test');
const assert = require('node:assert/strict');

const root = path.resolve(__dirname, '..');

function matches(source, pattern) {
  return [...source.matchAll(pattern)].map(match => match[1]);
}

function readIpcFile(name) {
  const mtsPath = path.join(root, 'src', 'main', 'ipc', `${name}.mts`);
  const jsPath = path.join(root, 'src', 'main', 'ipc', `${name}.js`);
  try {
    return fs.readFileSync(mtsPath, 'utf8');
  } catch {
    return fs.readFileSync(jsPath, 'utf8');
  }
}

test('every preload invoke has exactly one registered main-process handler', () => {
  const preloadPath = fs.existsSync(path.join(root, 'src', 'preload.cts'))
    ? path.join(root, 'src', 'preload.cts')
    : fs.existsSync(path.join(root, 'src', 'preload.mts'))
      ? path.join(root, 'src', 'preload.mts')
      : path.join(root, 'src', 'preload.js');
  const preload = fs.readFileSync(preloadPath, 'utf8');
  const mainPath = fs.existsSync(path.join(root, 'src', 'main', 'main.mts'))
    ? path.join(root, 'src', 'main', 'main.mts')
    : path.join(root, 'src', 'main', 'main.js');
  const main = fs.readFileSync(mainPath, 'utf8');
  const gitHandlers = readIpcFile('git-handlers');
  const hostingHandlers = readIpcFile('hosting-handlers');
  const repositoryHandlers = readIpcFile('repository-handlers');
  const windowHandlers = readIpcFile('window-application-handlers');
  const agentHandlers = readIpcFile('agent-handlers');
  const aiHandlers = readIpcFile('ai-handlers');
  const handlerModules = [
    gitHandlers,
    hostingHandlers,
    repositoryHandlers,
    windowHandlers,
    agentHandlers,
    aiHandlers
  ].join('\n');
  const invoked = matches(preload, /ipcRenderer\.invoke\(\s*'([^']+)'/g);
  const registered = [
    ...matches(main, /ipcMain\.handle\(\s*'([^']+)'/g),
    ...matches(handlerModules, /\[\s*'([^']+:[^']+)'\s*,\s*'[^']+'\s*\]/g),
    ...matches(
      handlerModules,
      /register(?:Handler|ManagedRepoHandler|Logged|ConflictOperation)\(\s*'([^']+)'/g
    )
  ];

  assert.equal(invoked.length, 148);
  assert.equal(new Set(invoked).size, 148);
  assert.equal(registered.length, 148);
  assert.equal(new Set(registered).size, 148);
  assert.deepEqual([...registered].sort(), [...invoked].sort());
});

test('shared IPC channel contract matches the preload invoke surface', () => {
  const shared = fs.readFileSync(
    path.join(root, 'src', 'shared', 'ipc.mts'),
    'utf8'
  );
  const declared = [...new Set(
    matches(shared, /['"]([a-z]+:[^'"]+)['"]/g)
  )];
  const preloadPath = fs.existsSync(path.join(root, 'src', 'preload.cts'))
    ? path.join(root, 'src', 'preload.cts')
    : fs.existsSync(path.join(root, 'src', 'preload.mts'))
      ? path.join(root, 'src', 'preload.mts')
      : path.join(root, 'src', 'preload.js');
  const preload = fs.readFileSync(preloadPath, 'utf8');
  const invoked = matches(preload, /ipcRenderer\.invoke\(\s*'([^']+)'/g);

  assert.equal(declared.length, 148);
  assert.equal(new Set(declared).size, 148);
  assert.deepEqual([...declared].sort(), [...invoked].sort());
});

test('all managed Git channels use the validating registrar', () => {
  const preloadPath = fs.existsSync(path.join(root, 'src', 'preload.cts'))
    ? path.join(root, 'src', 'preload.cts')
    : fs.existsSync(path.join(root, 'src', 'preload.mts'))
      ? path.join(root, 'src', 'preload.mts')
      : path.join(root, 'src', 'preload.js');
  const preload = fs.readFileSync(preloadPath, 'utf8');
  const gitHandlers = readIpcFile('git-handlers');
  const managedGitChannels = matches(preload, /ipcRenderer\.invoke\(\s*'(git:[^']+)'/g)
    .filter(channel => !['git:is-repo', 'git:clone'].includes(channel));
  const registered = new Set([
    ...matches(gitHandlers, /\[\s*'([^']+:[^']+)'\s*,\s*'[^']+'\s*\]/g),
    ...matches(gitHandlers, /register(?:ManagedRepoHandler|Logged|ConflictOperation)\(\s*'([^']+)'/g)
  ]);

  assert.equal(managedGitChannels.length, 76);
  for (const channel of managedGitChannels) {
    assert.equal(registered.has(channel), true, `${channel} is not managed`);
  }
  assert.doesNotMatch(gitHandlers, /\bregisterHandler\s*\(/);
});

test('every renderer push channel is declared in the shared notification contract', () => {
  const shared = fs.readFileSync(
    path.join(root, 'src', 'shared', 'notifications.mts'),
    'utf8'
  );
  const declared = [...new Set(matches(shared, /'([a-z]+:[a-z0-9-]+)'/g))];

  const sources = [
    (() => {
      try { return fs.readFileSync(path.join(root, 'src', 'main', 'main-application.mts'), 'utf8'); }
      catch { return fs.readFileSync(path.join(root, 'src', 'main', 'main-application.js'), 'utf8'); }
    })(),
    fs.readFileSync(path.join(root, 'src', 'main', 'update-service.mts'), 'utf8'),
    readIpcFile('git-handlers'),
    readIpcFile('repository-handlers'),
    fs.readFileSync(path.join(root, 'src', 'main', 'agents', 'agent-session-service.mts'), 'utf8')
  ].join('\n');

  const pushLiterals = new Set([
    ...matches(sources, /sendToRenderer\(\s*'([a-z]+:[a-z0-9-]+)'/g),
    ...matches(sources, /emit\(\s*'([a-z]+:[a-z0-9-]+)'/g),
    ...matches(sources, /notify\(\s*'([a-z]+:[a-z0-9-]+)'/g)
  ]);

  assert.ok(pushLiterals.size >= 6, 'expected the known push channels to be found');
  for (const channel of pushLiterals) {
    assert.equal(
      declared.includes(channel),
      true,
      `${channel} is pushed to the renderer but missing from src/shared/notifications.mts`
    );
  }
});
