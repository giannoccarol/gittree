const test = require('node:test');
const assert = require('node:assert/strict');

const { matchScopedRuns } = require('../scripts/quality.js');

const FILES = new Set([
  'test/ipc-parity.test.js',
  'test/i18n-parity.test.js',
  'test/preload-contract.test.js',
  'test/ai-service.test.js',
  'test/ai-output.test.js',
  'test/agent-session-service.test.js',
  'test/git-service-commit.test.js',
  'test/hosting-service.test.js',
  'test/git-ipc-handlers.test.js',
  'test/ipc-handler-registry.test.js',
  'test/hardening.test.js',
  'test/main-application.test.js',
  'test/application-runtime.test.js',
  'test/credential-vault.test.js',
  'test/update-service.test.js',
  'test/diagnostics-exporter.test.js',
  'test/settings-diagnostics.test.js',
  'test/settings-scope.test.js',
  'test/settings-update-controls.test.js',
  'test/pr-create-prefill.test.js',
  'test/changes-file-list.test.js',
  'test/merge-workspace.test.js',
  'test/repository-workspace-controller.test.js',
  'test/workspace-state-controller.test.js',
  'src/main/logger.mts',
  'src/main/logger.js',
  'src/main/ai/ai-service.mts',
  'src/main/ai/ai-service.js',
  'src/main/ipc/git-handlers.mts',
  'src/main/ipc/git-handlers.js',
  'src/preload.mts',
  'src/preload.js',
  'src/main/main.mts',
  'src/main/main.js',
  'src/renderer/components/settings-view.js',
  'src/renderer/components/merge-workspace.js',
  'src/renderer/components/graph-view.js',
  'src/renderer/workspace-state-controller.js'
]);

function createHarness(files = FILES) {
  const fileSystem = {
    existsSync: file => files.has(file.replaceAll('\\', '/'))
  };
  const glob = (pattern, { cwd }) => {
    void cwd;
    const escaped = pattern
      .replace(/[.+^${}()|[\]\\]/g, '\\$&')
      .replace('*', '.*');
    const regex = new RegExp(`^${escaped}$`);
    return [...files].filter(file => regex.test(file));
  };
  return { fileSystem, glob };
}

test('scoped quality always includes the cheap parity contracts', () => {
  const { fileSystem, glob } = createHarness();
  const scoped = matchScopedRuns(['src/main/logger.js'], { root: '', fs: fileSystem, glob });

  assert.ok(scoped.testFiles.includes('test/ipc-parity.test.js'));
  assert.ok(scoped.testFiles.includes('test/i18n-parity.test.js'));
  assert.ok(scoped.testFiles.includes('test/preload-contract.test.js'));
});

test('AI source changes select the AI test suite', () => {
  const { fileSystem, glob } = createHarness();
  const scoped = matchScopedRuns(['src/main/ai/ai-service.js'], { root: '', fs: fileSystem, glob });

  assert.ok(scoped.testFiles.includes('test/ai-service.test.js'));
  assert.ok(scoped.testFiles.includes('test/ai-output.test.js'));
  assert.ok(!scoped.testFiles.includes('test/hosting-service.test.js'));
});

test('preload changes select preload and hardening contracts', () => {
  const { fileSystem, glob } = createHarness();
  const scopedJs = matchScopedRuns(['src/preload.js'], { root: '', fs: fileSystem, glob });
  const scopedMts = matchScopedRuns(['src/preload.mts'], { root: '', fs: fileSystem, glob });

  assert.ok(scopedJs.testFiles.includes('test/preload-contract.test.js'));
  assert.ok(scopedJs.testFiles.includes('test/hardening.test.js'));
  assert.ok(scopedMts.testFiles.includes('test/preload-contract.test.js'));
  assert.ok(scopedMts.testFiles.includes('test/hardening.test.js'));
});

test('IPC changes select handler and registry tests', () => {
  const { fileSystem, glob } = createHarness();
  const scoped = matchScopedRuns(['src/main/ipc/git-handlers.js'], { root: '', fs: fileSystem, glob });

  assert.ok(scoped.testFiles.includes('test/git-ipc-handlers.test.js'));
  assert.ok(scoped.testFiles.includes('test/ipc-handler-registry.test.js'));
});

test('renderer components map through the alias table or their own test file', () => {
  const { fileSystem, glob } = createHarness();
  const settings = matchScopedRuns(['src/renderer/components/settings-view.js'], {
    root: '', fs: fileSystem, glob
  });
  assert.ok(settings.testFiles.includes('test/settings-scope.test.js'));
  assert.ok(settings.testFiles.includes('test/settings-update-controls.test.js'));
  assert.ok(settings.needsDesignAudit);

  const merge = matchScopedRuns(['src/renderer/components/merge-workspace.js'], {
    root: '', fs: fileSystem, glob
  });
  assert.ok(merge.testFiles.includes('test/merge-workspace.test.js'));

  const controller = matchScopedRuns(
    ['src/renderer/workspace-state-controller.js'],
    { root: '', fs: fileSystem, glob }
  );
  assert.ok(controller.testFiles.includes('test/workspace-state-controller.test.js'));
});

test('changed test files run themselves', () => {
  const { fileSystem, glob } = createHarness();
  const scoped = matchScopedRuns(['test/git-service-commit.test.js'], {
    root: '', fs: fileSystem, glob
  });
  assert.ok(scoped.testFiles.includes('test/git-service-commit.test.js'));
});

test('docs and benchmark artifacts do not trigger tests', () => {
  const { fileSystem, glob } = createHarness();
  const scoped = matchScopedRuns(
    ['docs/adr/0007-local-first-ai-integration.md', 'benchmark/ai-perf-baseline.json'],
    { root: '', fs: fileSystem, glob }
  );
  assert.deepEqual(scoped.testFiles, [
    'test/ipc-parity.test.js',
    'test/i18n-parity.test.js',
    'test/preload-contract.test.js'
  ]);
});

test('benchmark selection follows the changed area', () => {
  const { fileSystem, glob } = createHarness();
  const ai = matchScopedRuns(['src/main/ai/ai-service.js'], { root: '', fs: fileSystem, glob });
  assert.deepEqual(ai.benchmarks, ['node scripts/ai-perf-benchmark.js']);

  const renderer = matchScopedRuns(['src/renderer/components/graph-view.js'], {
    root: '', fs: fileSystem, glob
  });
  assert.ok(renderer.benchmarks.includes('npm run perf:renderer'));

  const docs = matchScopedRuns(['docs/adr/0007-local-first-ai-integration.md'], {
    root: '', fs: fileSystem, glob
  });
  assert.deepEqual(docs.benchmarks, []);
});

test('lint targets only changed JavaScript files', () => {
  const { fileSystem, glob } = createHarness();
  const scoped = matchScopedRuns(
    ['src/main/ai/ai-service.js', 'docs/adr/0007-local-first-ai-integration.md'],
    { root: '', fs: fileSystem, glob }
  );
  assert.deepEqual(scoped.lintFiles, ['src/main/ai/ai-service.js']);
});
