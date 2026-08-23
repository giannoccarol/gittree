const fs = require('node:fs');
const path = require('node:path');
const test = require('node:test');
const assert = require('node:assert/strict');
const vm = require('node:vm');

function matches(source, pattern) {
  return [...source.matchAll(pattern)].map(match => match[1]);
}

function resolvePreloadPath() {
  const cts = path.resolve(__dirname, '..', 'src', 'preload.cts');
  const mts = path.resolve(__dirname, '..', 'src', 'preload.mts');
  if (fs.existsSync(cts)) return cts;
  if (fs.existsSync(mts)) return mts;
  return path.resolve(__dirname, '..', 'src', 'preload.js');
}

function loadBridge() {
  const invokes = [];
  const listeners = new Map();
  const removed = [];
  let bridge;
  const ipcRenderer = {
    invoke(channel, ...args) {
      invokes.push({ channel, args });
      return Promise.resolve({ channel, args });
    },
    on(channel, listener) {
      listeners.set(channel, listener);
    },
    removeListener(channel, listener) {
      removed.push({ channel, listener });
    }
  };
  const preloadPath = resolvePreloadPath();
  let source = fs.readFileSync(preloadPath, 'utf8');
  const isMts = preloadPath.endsWith('.mts') || preloadPath.endsWith('.cts');
  if (isMts) {
    const ts = require('typescript');
    const transpiled = ts.transpileModule(source, {
      compilerOptions: {
        target: ts.ScriptTarget.ES2022,
        module: ts.ModuleKind.CommonJS,
        esModuleInterop: true,
        allowImportingTsExtensions: true
      }
    }).outputText;
    source = transpiled;
  }
  const sandbox = {
    require(moduleName) {
      assert.equal(moduleName, 'electron');
      return {
        ipcRenderer,
        contextBridge: {
          exposeInMainWorld(name, value) {
            assert.equal(name, 'gitTree');
            bridge = value;
          }
        }
      };
    },
    process: { platform: 'win32' },
    exports: {},
    module: { exports: {} },
    console,
    setTimeout,
    clearTimeout,
    Buffer
  };
  vm.runInNewContext(source, sandbox);
  return { bridge, invokes, listeners, removed };
}

test('preload exposes only the frozen named GitTree Interface', async () => {
  const { bridge, invokes } = loadBridge();

  assert.equal(Object.keys(bridge).length, 162);
  assert.equal(bridge.platform, 'win32');
  assert.equal('invoke' in bridge, false);
  assert.equal(typeof bridge.exportDiagnostics, 'function');
  await bridge.getStatus('C:\\managed-repo');
  assert.deepEqual(invokes.at(-1), {
    channel: 'git:status',
    args: ['C:\\managed-repo']
  });
});

test('preload subscriptions forward one payload and dispose the exact listener', () => {
  const { bridge, listeners, removed } = loadBridge();
  const received = [];
  const dispose = bridge.onWindowState(state => received.push(state));
  const listener = listeners.get('window:state');

  listener({ sender: 'main' }, { isMaximized: true });
  dispose();

  assert.deepEqual(received, [{ isMaximized: true }]);
  assert.equal(removed.length, 1);
  assert.equal(removed[0].channel, 'window:state');
  assert.equal(removed[0].listener, listener);
});

test('preload preserves observable defaults', async () => {
  const { bridge, invokes } = loadBridge();

  await bridge.getGraphPage('repo');
  await bridge.merge('repo', 'feature');
  await bridge.push('repo', 'origin', 'main');
  await bridge.getWorkingDiff('repo', 'file.txt');
  await bridge.createTag('repo', 'v1', 'abc123');
  await bridge.getPullRequestDiff('repo', 'github', 42);
  await bridge.checkoutPullRequestSource('repo', 'github', { id: 42 });

  assert.deepEqual(invokes.map(call => call.args), [
    ['repo', 0, 500],
    ['repo', 'feature', 'ff'],
    ['repo', 'origin', 'main', false],
    ['repo', 'file.txt', false],
    ['repo', 'v1', 'abc123', ''],
    ['repo', 'github', 42, 1],
    ['repo', 'github', { id: 42 }, false]
  ]);
});

test('shared GitTreeBridge interface stays in lockstep with the preload API', () => {
  const bridge = fs.readFileSync(
    path.resolve(__dirname, '..', 'src', 'shared', 'bridge.mts'),
    'utf8'
  );
  const preloadPath = resolvePreloadPath();
  const source = fs.readFileSync(preloadPath, 'utf8');
  const exposed = [...new Set(matches(source, /^ {2}([a-zA-Z_][a-zA-Z0-9_]*):/gm))];
  const declared = [...new Set(matches(bridge, /^ {2}(?:readonly )?([a-zA-Z_][a-zA-Z0-9_]*)[:(]/gm))];

  assert.ok(exposed.length >= 150);
  assert.deepEqual([...declared].sort(), [...exposed].sort());
});
