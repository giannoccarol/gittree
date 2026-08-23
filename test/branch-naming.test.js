const path = require('node:path');
const test = require('node:test');
const assert = require('node:assert/strict');

function loadBranchNaming() {
  try {
    const mod = require(path.join(
      __dirname,
      '..',
      'src',
      'renderer',
      'components',
      'branch-naming.mts'
    ));
    return mod.BranchNaming || mod.default || mod;
  } catch {
    return require(path.join(
      __dirname,
      '..',
      'src',
      'renderer',
      'components',
      'branch-naming.js'
    ));
  }
}

test('quick branch naming follows folders already used by local and remote branches', () => {
  const naming = loadBranchNaming();
  const metadata = {
    branches: [
      { kind: 'local', name: 'feat/authentication' },
      { kind: 'local', name: 'feat/settings' },
      { kind: 'remote', remote: 'origin', name: 'origin/fix/1911' }
    ]
  };

  assert.equal(naming.compose('feature', 'Account Profiles', metadata), 'feat/account-profiles');
  assert.equal(naming.compose('bugfix', 'Issue #1911', metadata), 'fix/issue-1911');
});

test('quick branch naming uses stable defaults and creates a safe slug', () => {
  const naming = loadBranchNaming();

  assert.equal(naming.compose('feature', 'Nuova attività API', {}), 'feature/nuova-attivita-api');
  assert.equal(naming.compose('bugfix', '  Fix__Login...  ', {}), 'bugfix/fix-login');
  assert.equal(naming.compose('custom', 'release/Version 2', {}), 'release/version-2');
  assert.equal(naming.compose('feature', '///', {}), '');
});
