const { spawnSync } = require('node:child_process');
const path = require('node:path');

const root = path.resolve(__dirname, '..');
const c8Bin = require.resolve('c8/bin/c8.js');

const EXTENSION_ARGUMENTS = [
  '--extension=js',
  '--extension=cjs',
  '--extension=mjs',
  '--extension=mts'
];

const SCOPES = {
  git: {
    include: ['src/main/git-service.mts', 'src/main/git/**/*.mts'],
    gate: { lines: 82, branches: 70, functions: 90 },
    target: { lines: 82, branches: 70, functions: 90 }
  },
  runtime: {
    include: [
      'src/main/application-runtime.mts',
      'src/main/deep-link.mts',
      'src/main/diagnostics-exporter.mts',
      'src/main/git-version.mts',
      'src/main/inspector-window-controller.mts',
      'src/main/ipc/**/*.mts',
      'src/main/logger.mts',
      'src/main/main-application.mts',
      'src/main/oauth-config.mts',
      'src/main/provider-links.mts',
      'src/main/repo-manager.mts',
      'src/main/repository-scanner.mts',
      'src/main/repository-workspace.mts',
      'src/main/update-service.mts',
      'src/main/workspace-profile-conversion.mts'
    ],
    gate: { lines: 75, branches: 60, functions: 75 },
    target: { lines: 75, branches: 60, functions: 75 }
  },
  hosting: {
    include: ['src/main/hosting-service.mts', 'src/main/hosting/providers/**/*.mts'],
    gate: { lines: 90, branches: 70, functions: 90 },
    target: { lines: 90, branches: 70, functions: 90 }
  },
  renderer: {
    include: [
      'src/renderer/dialog-service.mts',
      'src/renderer/html-encoder.mts',
      'src/renderer/repository-load-session.js',
      'src/renderer/repository-workspace-controller.js',
      'src/renderer/shortcut-controller.js',
      'src/renderer/workspace-state-controller.js',
      'src/renderer/components/branch-naming.mts',
      'src/renderer/components/conflict-highlight.js',
      'src/renderer/components/diff-parser.mts',
      'src/renderer/components/graph-layout.mts'
    ],
    gate: { lines: 70, branches: 60, functions: 70 },
    target: { lines: 70, branches: 60, functions: 70 }
  }
};

function buildC8Arguments(name, scope) {
  return [
    c8Bin,
    'report',
    '--all',
    '--exclude-after-remap',
    '--temp-directory=coverage/tmp',
    `--reports-dir=coverage/scopes/${name}`,
    '--reporter=text-summary',
    '--check-coverage',
    `--lines=${scope.gate.lines}`,
    `--branches=${scope.gate.branches}`,
    `--functions=${scope.gate.functions}`,
    ...EXTENSION_ARGUMENTS,
    ...scope.include.map(pattern => `--include=${pattern}`)
  ];
}

function run(names = Object.keys(SCOPES)) {
  for (const name of names) {
    const scope = SCOPES[name];
    if (!scope) throw new Error(`Unknown coverage scope: ${name}`);
    process.stdout.write(
      `\n[coverage:${name}] gate ${JSON.stringify(scope.gate)}; target ${JSON.stringify(scope.target)}\n`
    );
    const result = spawnSync(process.execPath, buildC8Arguments(name, scope), {
      cwd: root,
      stdio: 'inherit'
    });
    if (result.error) throw result.error;
    if (result.status !== 0) {
      throw new Error(`Coverage scope ${name} failed with exit code ${result.status}`);
    }
  }
}

if (require.main === module) {
  try {
    run(process.argv.slice(2).length ? process.argv.slice(2) : undefined);
  } catch (error) {
    console.error(error.message);
    process.exitCode = 1;
  }
}

module.exports = { SCOPES, buildC8Arguments, run };
