const path = require('node:path');
const { spawnSync } = require('node:child_process');
const fs = require('node:fs');

const ROOT = path.resolve(__dirname, '..');

const ALWAYS_TESTS = [
  'test/ipc-parity.test.js',
  'test/i18n-parity.test.js',
  'test/preload-contract.test.js'
];

const SOURCE_GROUPS = [
  {
    name: 'ai',
    match: /^src\/main\/ai\//,
    tests: ['test/ai-*.test.js']
  },
  {
    name: 'agents',
    match: /^src\/main\/agents\//,
    tests: ['test/agent-*.test.js']
  },
  {
    name: 'git',
    match: /^(src\/main\/git-service\.(?:js|mts)|src\/main\/git\/)/,
    tests: [
      'test/git-*.test.js',
      'test/repository-*.test.js',
      'test/working-tree-*.test.js',
      'test/conflict-*.test.js'
    ]
  },
  {
    name: 'hosting',
    match: /^(src\/main\/hosting-service\.(?:js|mts)|src\/main\/hosting\/)/,
    tests: ['test/hosting-*.test.js', 'test/provider-links.test.js']
  },
  {
    name: 'ipc',
    match: /^src\/main\/ipc\//,
    tests: ['test/*-ipc-handlers.test.js', 'test/ipc-handler-registry.test.js']
  },
  {
    name: 'preload',
    match: /^src\/preload.*\.(?:js|mts)$/,
    tests: ['test/preload-contract.test.js', 'test/hardening.test.js']
  },
  {
    name: 'composition',
    match: /^src\/main\/(main-application|application-runtime)\.(?:js|mts)$/,
    tests: ['test/main-application.test.js', 'test/application-runtime.test.js']
  },
  {
    name: 'vault',
    match: /^src\/main\/credential-vault\.(?:js|mts)$/,
    tests: ['test/credential-vault.test.js']
  },
  {
    name: 'update',
    match: /^src\/main\/update-service\.(?:js|mts)$/,
    tests: ['test/update-service.test.js']
  },
  {
    name: 'diagnostics',
    match: /^src\/main\/(diagnostics-exporter|logger)\.(?:js|mts)$/,
    tests: ['test/diagnostics-exporter.test.js', 'test/settings-diagnostics.test.js']
  },
  {
    name: 'renderer-i18n',
    match: /^src\/renderer\/i18n\.(?:js|mts)$/,
    tests: ['test/i18n-parity.test.js']
  },
  {
    name: 'renderer-components',
    match: /^src\/renderer\/components\/([^/]+)\.(?:js|mts)$/,
    componentTests: true
  },
  {
    name: 'renderer-modules',
    match: /^src\/renderer\/([^/]+)\.(?:js|mts)$/,
    componentTests: true
  }
];

const COMPONENT_TEST_ALIASES = {
  'settings-view': ['settings-scope.test.js', 'settings-update-controls.test.js'],
  'pull-request-view': ['pr-create-prefill.test.js'],
  'changes-view': ['changes-file-list.test.js'],
  'changes-file-list': ['changes-file-list.test.js'],
  'merge-workspace': ['merge-workspace.test.js']
};

const BENCHMARKS = [
  {
    name: 'renderer-perf',
    match: /^src\/renderer\//,
    command: 'npm run perf:renderer'
  },
  {
    name: 'ai-perf',
    match: /^(src\/main\/ai\/|scripts\/ai-perf-benchmark\.js)/,
    command: 'node scripts/ai-perf-benchmark.js'
  },
  {
    name: 'workspace-perf',
    match: /^(src\/main\/(agents|git)|src\/renderer\/(workspace-|components\/graph)|scripts\/workspace-perf-benchmark\.js)/,
    command: 'node scripts/workspace-perf-benchmark.js'
  }
];

function exists(root, fileSystem, file) {
  return fileSystem.existsSync(path.join(root, file));
}

function matchScopedRuns(changedFiles, dependencies = {}) {
  const root = dependencies.root ?? ROOT;
  const fileSystem = dependencies.fs || fs;
  const glob = dependencies.glob || fs.globSync;
  const testFiles = new Set(ALWAYS_TESTS.filter(file => exists(root, fileSystem, file)));
  let needsDesignAudit = false;

  for (const file of changedFiles) {
    const normalized = file.replaceAll('\\', '/');
    if (/^src\/renderer\//.test(normalized) || /^DESIGN\.md$/.test(normalized)) {
      needsDesignAudit = true;
    }
    if (/^test\/.*\.test\.js$/.test(normalized)) {
      if (exists(root, fileSystem, normalized)) testFiles.add(normalized);
      continue;
    }
    if (/^(docs|benchmark)\//.test(normalized) || /\.(md|json)$/.test(normalized)) continue;
    for (const group of SOURCE_GROUPS) {
      const match = normalized.match(group.match);
      if (!match) continue;
      if (group.componentTests) {
        const name = match[1].replace(/\.js$/, '');
        const aliases = COMPONENT_TEST_ALIASES[name] || [`${name}.test.js`];
        for (const alias of aliases) {
          if (exists(root, fileSystem, `test/${alias}`)) testFiles.add(`test/${alias}`);
        }
        continue;
      }
      for (const pattern of group.tests) {
        const matched = glob(pattern, { cwd: root, posix: true });
        for (const candidate of matched) testFiles.add(candidate);
      }
    }
  }

  const lintFiles = changedFiles
    .filter(file => /\.(?:js|mts|ts)$/.test(file) && exists(root, fileSystem, file))
    .map(file => file.replaceAll('\\', '/'));

  const benchmarks = BENCHMARKS
    .filter(benchmark => changedFiles.some(file => (
      benchmark.match.test(file.replaceAll('\\', '/'))
    )))
    .map(benchmark => benchmark.command);

  return {
    testFiles: [...testFiles],
    lintFiles,
    needsDesignAudit,
    benchmarks
  };
}

function changedFiles() {
  const status = spawnSync('git', ['status', '--porcelain', '--untracked-files=normal'], {
    cwd: ROOT,
    encoding: 'utf8'
  });
  if (status.error || status.status !== 0) return [];
  return status.stdout
    .split(/\r?\n/)
    .map(line => line.slice(3).trim())
    .filter(Boolean);
}

function run(command, args, label) {
  process.stdout.write(`\n> ${label}\n`);
  const executable = process.platform === 'win32' && command === 'npm'
    ? 'npm.cmd'
    : command;
  const result = spawnSync(executable, args, { cwd: ROOT, stdio: 'inherit', shell: false });
  if (result.error) throw result.error;
  return result.status === 0;
}

function runFull() {
  const steps = [
    ['lint', 'npm', ['run', 'lint']],
    ['typecheck ratchet', 'node', ['scripts/check-ts-baseline.js']],
    ['test', 'npm', ['test']],
    ['coverage', 'npm', ['run', 'test:coverage']],
    ['design audit', 'npm', ['run', 'audit:design']],
    ['contracts', 'npm', ['run', 'test:contracts']]
  ];
  for (const [label, command, args] of steps) {
    if (!run(command, args, label)) process.exitCode = 1;
  }
}

function runScoped({ benchmarks = false } = {}) {
  const changed = changedFiles();
  if (!changed.length) {
    process.stdout.write('No local changes detected; running the full quality gate.\n');
    runFull();
    return;
  }
  const scoped = matchScopedRuns(changed);
  process.stdout.write(
    `Scoped quality for ${changed.length} changed file(s): `
    + `${scoped.testFiles.length} test file(s), `
    + `${scoped.lintFiles.length} lint file(s), `
    + `design audit ${scoped.needsDesignAudit ? 'on' : 'off'}.\n`
  );

  if (scoped.lintFiles.length) {
    const eslintBin = path.join('node_modules', 'eslint', 'bin', 'eslint.js');
    if (!run('node', [eslintBin, ...scoped.lintFiles], 'lint (changed files)')) {
      process.exitCode = 1;
    }
  }
  if (changed.some(file => /^src\//.test(file.replaceAll('\\', '/')))) {
    if (!run('node', ['scripts/check-ts-baseline.js'], 'typecheck ratchet')) process.exitCode = 1;
  }
  if (!run('node', ['--test', ...scoped.testFiles], 'scoped tests')) process.exitCode = 1;
  if (scoped.needsDesignAudit) {
    if (!run('npm', ['run', 'audit:design'], 'design audit')) process.exitCode = 1;
  }
  if (benchmarks) {
    if (!scoped.benchmarks.length) {
      process.stdout.write('No benchmark covers the changed files.\n');
      return;
    }
    for (const benchmark of scoped.benchmarks) {
      const parts = benchmark.split(' ');
      if (!run(parts[0], parts.slice(1), `benchmark: ${benchmark}`)) process.exitCode = 1;
    }
  }
}

function main() {
  const args = process.argv.slice(2);
  if (args.includes('--full')) runFull();
  else runScoped({ benchmarks: args.includes('--benchmarks') });
}

if (require.main === module) {
  main();
}

module.exports = { matchScopedRuns, changedFiles };
