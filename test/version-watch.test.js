const test = require('node:test');
const assert = require('node:assert/strict');

const {
  isRunningStale,
  binaryChangedSince,
  snapshotBinaryMtime,
  detectStaleInstall
} = require('../src/main/version-watch.mts');
const { supportsAutoInstall, supportsCachedPackageInstall, readPackageType } = require('../src/main/update-service.mts');

test('update-service: cached install only on Linux native packages', () => {
  assert.equal(supportsCachedPackageInstall('linux', 'pacman'), true);
  assert.equal(supportsCachedPackageInstall('linux', 'deb'), true);
  assert.equal(supportsCachedPackageInstall('linux', 'appimage'), false);
  assert.equal(supportsCachedPackageInstall('win32', 'pacman'), false);
});

test('update-service: auto install only on win/mac and Linux AppImage', () => {
  assert.equal(supportsAutoInstall('win32', ''), true);
  assert.equal(supportsAutoInstall('darwin', 'dmg'), true);
  assert.equal(supportsAutoInstall('linux', 'appimage'), true);
  assert.equal(supportsAutoInstall('linux', 'pacman'), false);
  assert.equal(supportsAutoInstall('linux', 'deb'), false);
  assert.equal(supportsAutoInstall('linux', 'native'), false);
});

test('update-service: readPackageType prefers AppImage markers on Linux', () => {
  const original = process.env.APPIMAGE;
  process.env.APPIMAGE = '/tmp/GitTree.AppImage';
  assert.equal(readPackageType('linux', '/tmp/resources'), 'appimage');
  delete process.env.APPIMAGE;
  if (original) process.env.APPIMAGE = original;
});

test('version-watch: detects stale installs by version or binary mtime', () => {
  assert.equal(isRunningStale('0.23.0', '0.23.1'), true);
  assert.equal(isRunningStale('0.23.1', '0.23.1'), false);
  assert.equal(binaryChangedSince(100, '/bin/gittree', () => ({ mtimeMs: 200 })), true);
  assert.equal(snapshotBinaryMtime('/missing', () => { throw new Error('ENOENT'); }), null);

  const byVersion = detectStaleInstall({
    runningVersion: '0.23.0',
    resourcesPath: '/opt/gittree/resources',
    execPath: '/usr/bin/gittree',
    baselineMtime: 100,
    readFile: () => JSON.stringify({ version: '0.23.1' }),
    statSync: () => ({ mtimeMs: 100 })
  });
  assert.equal(byVersion?.reason, 'version');

  const byMtime = detectStaleInstall({
    runningVersion: '0.23.1',
    resourcesPath: '/opt/gittree/resources',
    execPath: '/usr/bin/gittree',
    baselineMtime: 100,
    readFile: () => { throw new Error('missing'); },
    statSync: () => ({ mtimeMs: 250 })
  });
  assert.equal(byMtime?.reason, 'mtime');
});
