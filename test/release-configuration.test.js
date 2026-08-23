const fs = require('node:fs');
const path = require('node:path');
const test = require('node:test');
const assert = require('node:assert/strict');

const root = path.resolve(__dirname, '..');

test('release dependencies are assigned to the correct package scopes', () => {
  const packageJson = JSON.parse(fs.readFileSync(path.join(root, 'package.json'), 'utf8'));
  assert.equal(packageJson.name, 'gittree');
  assert.equal(
    packageJson.repository.url,
    'git+https://github.com/giannoccarol/gittree.git'
  );
  assert.equal(packageJson.homepage, 'https://github.com/giannoccarol/gittree#readme');
  assert.equal(packageJson.bugs.url, 'https://github.com/giannoccarol/gittree/issues');
  assert.equal(packageJson.dependencies.electron, undefined);
  assert.match(packageJson.dependencies['electron-updater'], /^\^6\./);
  assert.match(packageJson.devDependencies.electron, /^\^43\./);
  assert.equal(packageJson.dependencies['node-pty'], '1.1.0');
  assert.equal(packageJson.dependencies['@xterm/xterm'], '6.0.0');
  assert.equal(packageJson.dependencies['@xterm/addon-fit'], '0.11.0');
  assert.equal(packageJson.scripts.postinstall, 'electron-builder install-app-deps');
  assert.ok(packageJson.scripts['prepare:assets']);
  assert.ok(packageJson.scripts['release:check']);
  assert.equal(packageJson.scripts.quality, 'node scripts/quality.js');
  assert.equal(
    packageJson.scripts['quality:full'],
    'npm run lint && npm run typecheck:baseline && npm run test && npm run test:coverage && npm run audit:design && npm run test:contracts'
  );
  assert.ok(packageJson.scripts['quality:bench']);
});

test('continuous integration validates the actual default branch', () => {
  const workflow = fs.readFileSync(
    path.join(root, '.github', 'workflows', 'ci.yml'),
    'utf8'
  );
  assert.match(workflow, /branches:\s*\[master\]/);
  assert.doesNotMatch(workflow, /branches:\s*\[main,\s*develop\]/);
  assert.match(workflow, /npm run quality/);
});

test('continuous integration exercises Electron on required operating systems', () => {
  const workflow = fs.readFileSync(
    path.join(root, '.github', 'workflows', 'ci.yml'),
    'utf8'
  );
  assert.match(workflow, /runs-on:\s*ubuntu-latest/);
  assert.match(workflow, /xvfb-run\s+-a\s+npm run test:e2e/);
  assert.match(workflow, /runs-on:\s*windows-latest/);
  assert.match(workflow, /runs-on:\s*macos-latest/);
  assert.match(workflow, /github\.event_name == 'schedule'/);
  assert.match(workflow, /startsWith\(github\.ref, 'refs\/tags\/v'\)/);
  assert.match(workflow, /if:\s*failure\(\)/);
});

test('electron-builder emits installable and update-compatible artifacts', () => {
  const config = fs.readFileSync(path.join(root, 'electron-builder.yml'), 'utf8');
  assert.match(config, /provider:\s*github/);
  assert.match(config, /owner:\s*giannoccarol/);
  assert.match(config, /repo:\s*gittree(?:\r?\n|$)/);
  assert.match(config, /target:\s*nsis/);
  assert.match(config, /-\s*zip/);
  assert.match(config, /-\s*AppImage/);
  assert.match(config, /-\s*pacman/);
  assert.match(config, /generateUpdatesFilesForAllChannels:\s*true/);
  assert.match(config, /asarUnpack:[\s\S]*node_modules\/node-pty\/\*\*\/\*/);
  assert.match(config, /from:\s*build\/oauth-config\.json/);
  assert.match(config, /include:\s*installer\.nsh/);
  assert.match(config, /deb:\s*[\s\S]*depends:/);
  assert.match(config, /pacman:\s*[\s\S]*depends:/);
  assert.match(config, /pacman:\s*[\s\S]*packageName:\s*gittree-bin/);
  assert.match(config, /pacman:\s*[\s\S]*util-linux-libs/);
  for (const dependency of [
    'libgtk-3-0',
    'libnotify4',
    'libnss3',
    'libxss1',
    'libxtst6',
    'xdg-utils',
    'libatspi2.0-0',
    'libuuid1',
    'libsecret-1-0',
    'libasound2'
  ]) {
    assert.ok(config.includes(`- ${dependency}`), `${dependency} dependency missing`);
  }
  const nsh = fs.readFileSync(path.join(root, 'build', 'installer.nsh'), 'utf8');
  assert.match(nsh, /!macro customInstallMode/);
  assert.match(nsh, /!macro customFinishPage/);
  assert.match(nsh, /\$\{isUpdated\}/);
});

test('semantic-release maps feat and breaking to minor, fixes to patch', () => {
  const releaserc = JSON.parse(fs.readFileSync(path.join(root, '.releaserc'), 'utf8'));
  const analyzer = releaserc.plugins.find(plugin => (
    Array.isArray(plugin) && plugin[0] === '@semantic-release/commit-analyzer'
  ));
  assert.ok(analyzer, 'commit-analyzer plugin missing');
  const rules = analyzer[1].releaseRules || [];
  assert.equal(rules.find(item => item.type === 'feat')?.release, 'minor');
  assert.equal(rules.find(item => item.breaking === true)?.release, 'minor');
  for (const type of ['fix', 'perf', 'refactor', 'style']) {
    const rule = rules.find(item => item.type === type);
    assert.equal(rule?.release, 'patch', `${type} must bump patch only`);
  }
  assert.match(releaserc.tagFormat, /^v\$\{version\}$/);
  const gitPlugin = releaserc.plugins.find(plugin => (
    Array.isArray(plugin) && plugin[0] === '@semantic-release/git'
  ));
  assert.ok(gitPlugin, 'semantic-release git plugin missing');
  assert.ok(gitPlugin[1].assets.includes('CHANGELOG.md'));

  const releaseGuide = fs.readFileSync(path.join(root, 'docs', 'RELEASING.md'), 'utf8');
  assert.doesNotMatch(releaseGuide, /0\.4\.N|v0\.3\.\*/);
  assert.match(releaseGuide, /0\.9\.8` → `0\.10\.0/);
  assert.match(releaseGuide, /1\.0\.0.*stabilità/);
});

test('the master application icon is release ready', () => {
  const icon = fs.readFileSync(path.join(root, 'icon.png'));
  assert.equal(icon.subarray(0, 8).toString('hex'), '89504e470d0a1a0a');
  assert.equal(icon.readUInt32BE(16), 1024);
  assert.equal(icon.readUInt32BE(20), 1024);
  assert.equal(icon[25], 6);
});

test('release workflow publishes one atomic draft after every native build succeeds', () => {
  const workflow = fs.readFileSync(
    path.join(root, '.github', 'workflows', 'release.yml'),
    'utf8'
  );
  assert.match(workflow, /runs-on:\s*windows-latest/);
  assert.match(workflow, /runs-on:\s*macos-latest/);
  assert.match(workflow, /runs-on:\s*ubuntu-latest/);
  assert.doesNotMatch(workflow, /--publish always/);
  assert.equal((workflow.match(/--publish never/g) || []).length, 3);
  assert.match(workflow, /gh release create[\s\S]+--draft/);
  assert.match(workflow, /gh release delete-asset[\s\S]+--yes/);
  assert.equal((workflow.match(/scripts\/release-assets\.js/g) || []).length, 3);
  assert.match(workflow, /name:\s*Publish complete release/);
  assert.match(workflow, /needs:\s*\[windows,\s*macos,\s*linux\]/);
  assert.match(workflow, /gh release edit[\s\S]+--draft=false/);
  assert.match(workflow, /GH_REPO:\s*\${{\s*github\.repository\s*}}/);
  assert.match(workflow, /MACOS_OTA_ENABLED:/);
  assert.match(workflow, /platform="mac-manual"/);
  assert.match(workflow, /GITTREE_GITHUB_CLIENT_ID/);
  assert.match(workflow, /GITTREE_GITLAB_CLIENT_ID/);
  assert.match(workflow, /dpkg-deb\s+--field/);
  assert.match(workflow, /libasound2/);
  assert.match(workflow, /Linux Pacman artifact was not generated/);
});

test('automatic versioning explicitly dispatches the atomic release workflow', () => {
  const versioning = fs.readFileSync(
    path.join(root, '.github', 'workflows', 'versioning.yml'),
    'utf8'
  );
  const release = fs.readFileSync(
    path.join(root, '.github', 'workflows', 'release.yml'),
    'utf8'
  );

  assert.match(release, /workflow_dispatch:/);
  assert.match(versioning, /actions:\s*write/);
  assert.match(versioning, /GIT_AUTHOR_NAME:\s*Lorenzo Giannoccaro/);
  assert.match(versioning, /GIT_AUTHOR_EMAIL:\s*lorenzo\.giannoccaro998@gmail\.com/);
  assert.match(versioning, /GIT_COMMITTER_NAME:\s*Lorenzo Giannoccaro/);
  assert.match(versioning, /GIT_COMMITTER_EMAIL:\s*lorenzo\.giannoccaro998@gmail\.com/);
  assert.match(versioning, /git fetch origin master --tags/);
  assert.match(versioning, /git tag --points-at "\$release_commit"/);
  assert.match(versioning, /gh workflow run release\.yml --ref "\$tag"/);
});

test('manual SignPath workflow validates secrets at runtime and uses the configured policy', () => {
  const workflow = fs.readFileSync(
    path.join(root, '.github', 'workflows', 'signpath.yml'),
    'utf8'
  );

  assert.doesNotMatch(workflow, /if:\s*\$\{\{\s*secrets\./);
  assert.match(workflow, /SIGNPATH_PROJECT_SLUG:\s*\$\{\{\s*vars\.SIGNPATH_PROJECT_SLUG\s*\}\}/);
  assert.doesNotMatch(workflow, /SIGNPATH_PROJECT_SLUG\s*\|\|/);
  assert.match(workflow, /name:\s*Validate SignPath configuration/);
  assert.match(
    workflow,
    /SIGNPATH_API_TOKEN SIGNPATH_ORG_ID SIGNPATH_PROJECT_SLUG SIGNPATH_SIGNING_POLICY_ID/
  );
  assert.match(workflow, /SigningPolicyId=\$SIGNPATH_SIGNING_POLICY_ID/);
});
