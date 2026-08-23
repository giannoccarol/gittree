const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const test = require('node:test');
const assert = require('node:assert/strict');

const { convertWorkspaceProfile } = require('../src/main/workspace-profile-conversion.mts');

function createFixture(t) {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'gittree-profile-conversion-'));
  t.after(() => fs.rmSync(root, { recursive: true, force: true }));
  return {
    root,
    current: path.join(root, 'GitTree', 'repos.json'),
    previous: path.join(root, 'gittree-minimal', 'repos.json')
  };
}

test('workspace profile conversion restores previous tabs without rewriting its source', t => {
  const fixture = createFixture(t);
  const previousState = {
    repos: [{ path: 'C:\\work\\project', name: 'project', addedAt: 'before-update' }],
    activeRepoIndex: 0
  };
  fs.mkdirSync(path.dirname(fixture.previous), { recursive: true });
  fs.writeFileSync(fixture.previous, JSON.stringify(previousState));

  const result = convertWorkspaceProfile({
    currentConfigPath: fixture.current,
    previousConfigPath: fixture.previous,
    processId: 7,
    timestamp: 11
  });

  assert.deepEqual(result, { converted: true, source: fixture.previous });
  assert.deepEqual(JSON.parse(fs.readFileSync(fixture.current, 'utf8')), previousState);
  assert.deepEqual(JSON.parse(fs.readFileSync(fixture.previous, 'utf8')), previousState);
  assert.deepEqual(fs.readdirSync(path.dirname(fixture.current)), ['repos.json']);
});

test('workspace profile conversion never overwrites a current workspace', t => {
  const fixture = createFixture(t);
  const currentState = {
    repos: [{ path: 'C:\\work\\current', name: 'current' }],
    activeRepoIndex: 0
  };
  const previousState = {
    repos: [{ path: 'C:\\work\\previous', name: 'previous' }],
    activeRepoIndex: 0
  };
  fs.mkdirSync(path.dirname(fixture.current), { recursive: true });
  fs.mkdirSync(path.dirname(fixture.previous), { recursive: true });
  fs.writeFileSync(fixture.current, JSON.stringify(currentState));
  fs.writeFileSync(fixture.previous, JSON.stringify(previousState));

  assert.deepEqual(convertWorkspaceProfile({
    currentConfigPath: fixture.current,
    previousConfigPath: fixture.previous
  }), { converted: false });
  assert.deepEqual(JSON.parse(fs.readFileSync(fixture.current, 'utf8')), currentState);
});

test('workspace profile conversion ignores an empty previous profile', t => {
  const fixture = createFixture(t);
  fs.mkdirSync(path.dirname(fixture.previous), { recursive: true });
  fs.writeFileSync(fixture.previous, JSON.stringify({ repos: [], activeRepoIndex: -1 }));

  assert.deepEqual(convertWorkspaceProfile({
    currentConfigPath: fixture.current,
    previousConfigPath: fixture.previous
  }), { converted: false });
  assert.equal(fs.existsSync(fixture.current), false);
});
