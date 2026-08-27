const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const { EventEmitter } = require('node:events');
const test = require('node:test');
const assert = require('node:assert/strict');

const {
  UpdateService,
  supportsAutoInstall,
  supportsCachedPackageInstall,
  findPendingPackage,
  buildCachedInstallCommand,
  resolvePackageTypeForInstall,
  parseVersionFromPackageName,
  pendingPackageNeedsInstall
} = require('../src/main/update-service.mts');

function createHarness({
  packaged = true,
  version = '1.2.3',
  platform = 'win32',
  packageType = '',
  cacheHome = '',
  pendingPackage = null
} = {}) {
  const sent = [];
  const scheduled = [];
  const cleared = [];
  const opened = [];
  const spawned = [];
  let quitCalled = false;
  const updater = new EventEmitter();
  updater.checkForUpdates = async () => {};
  updater.downloadUpdate = async () => {};
  updater.quitAndInstall = (...args) => scheduled.push(['install', ...args]);
  const window = {
    isDestroyed: () => false,
    webContents: { send: (...args) => sent.push(args) }
  };
  const timer = { unref() { scheduled.push(['unref']); } };
  const pendingDir = cacheHome
    ? path.join(cacheHome, 'gittree-updater', 'pending')
    : '';
  if (pendingPackage && pendingDir) {
    fs.mkdirSync(pendingDir, { recursive: true });
    fs.writeFileSync(path.join(pendingDir, pendingPackage), 'package');
  }
  const service = new UpdateService(window, {
    app: {
      isPackaged: packaged,
      getVersion: () => version,
      quit: () => { quitCalled = true; }
    },
    autoUpdater: updater,
    platform,
    cacheHome,
    openExternal: async url => { opened.push(url); },
    spawnProcess: (command, args) => {
      spawned.push([command, ...args]);
      const child = new EventEmitter();
      queueMicrotask(() => child.emit('close', 0));
      return child;
    },
    setTimeout(callback, delay) {
      scheduled.push(['timeout', delay, callback]);
      return timer;
    },
    setInterval(callback, delay) {
      scheduled.push(['interval', delay, callback]);
      return timer;
    },
    setImmediate(callback) {
      scheduled.push(['immediate']);
      callback();
    },
    clearTimeout(value) { cleared.push(['timeout', value]); },
    clearInterval(value) { cleared.push(['interval', value]); }
  });
  service.packageType = packageType;
  service.autoInstall = supportsAutoInstall(platform, packageType);
  service.cachedInstall = supportsCachedPackageInstall(platform, packageType);
  service.state.packageType = packageType;
  service.state.autoInstall = service.autoInstall;
  service.state.cachedInstall = service.cachedInstall;
  return {
    service,
    updater,
    window,
    sent,
    scheduled,
    cleared,
    opened,
    spawned,
    pendingDir,
    get quitCalled() { return quitCalled; }
  };
}

test('unpackaged update service stays disabled and broadcasts safely', async () => {
  const { service, updater, sent, scheduled } = createHarness({ packaged: false });
  service.initialize();
  service.initialize();

  assert.equal(service.getState().status, 'disabled');
  assert.deepEqual(await service.check(), {
    success: false,
    skipped: true,
    state: service.getState()
  });
  assert.equal(updater.eventNames().length, 0);
  assert.equal(scheduled.length, 0);
  assert.equal(sent.length, 2);

  service.setWindow({ isDestroyed: () => true, webContents: { send() {} } });
  service.setWindow(null);
});

test('packaged update service configures updater and follows updater events', () => {
  const { service, updater, sent, scheduled, cleared } = createHarness({
    version: '1.2.3-beta.1'
  });
  service.initialize();

  assert.equal(updater.autoDownload, false);
  assert.equal(updater.autoInstallOnAppQuit, true);
  assert.equal(updater.allowDowngrade, false);
  assert.equal(updater.allowPrerelease, true);
  assert.equal(scheduled.find(item => item[0] === 'timeout')[1], 15000);
  assert.equal(scheduled.find(item => item[0] === 'interval')[1], 6 * 60 * 60 * 1000);

  updater.emit('checking-for-update');
  assert.equal(service.getState().status, 'checking');
  updater.emit('update-available', { version: '1.3.0' });
  assert.equal(service.getState().availableVersion, '1.3.0');
  updater.emit('download-progress', { percent: 150.4 });
  assert.equal(service.getState().progress, 100);
  updater.emit('download-progress', { percent: -5 });
  assert.equal(service.getState().progress, 0);
  updater.emit('update-downloaded', { version: '1.3.0' });
  assert.equal(service.getState().status, 'downloaded');
  updater.emit('update-not-available');
  assert.equal(service.getState().status, 'idle');
  updater.emit('error', new Error('feed unavailable'));
  assert.deepEqual(service.getState(), {
    status: 'error',
    currentVersion: '1.2.3-beta.1',
    availableVersion: null,
    progress: 0,
    error: 'feed unavailable',
    packageType: '',
    autoInstall: true,
    cachedInstall: false,
    pendingPackagePath: null
  });
  updater.emit('error', 'offline');
  assert.equal(service.getState().error, 'offline');
  assert.ok(sent.length >= 9);

  service.destroy();
  assert.equal(updater.eventNames().length, 0);
  assert.deepEqual(cleared.map(item => item[0]).sort(), ['interval', 'timeout']);
});

test('update commands expose skip, error, download and install outcomes', async () => {
  const { service, updater, scheduled } = createHarness();
  assert.equal((await service.download()).success, false);
  assert.equal((await service.install()).success, false);

  let checks = 0;
  updater.checkForUpdates = async () => { checks += 1; };
  assert.equal((await service.check()).success, true);
  assert.equal(checks, 1);

  service.setState({ status: 'downloading' });
  assert.equal((await service.check()).skipped, true);
  service.setState({ status: 'idle' });
  updater.checkForUpdates = async () => { throw new Error('network'); };
  assert.equal((await service.check(false)).state.status, 'idle');
  assert.equal((await service.check(true)).state.status, 'error');

  service.setState({ status: 'available' });
  assert.equal((await service.download()).success, true);
  updater.downloadUpdate = async () => { throw new Error('download failed'); };
  service.setState({ status: 'available' });
  assert.equal((await service.download()).error, 'download failed');

  service.setState({ status: 'downloaded' });
  assert.deepEqual(await service.install(), { success: true, state: service.getState() });
  assert.ok(scheduled.some(item => item[0] === 'install' && item[1] === false && item[2] === true));
});

test('cached package helpers resolve pending files and install commands', () => {
  assert.equal(supportsCachedPackageInstall('linux', 'pacman'), true);
  assert.equal(supportsCachedPackageInstall('linux', 'appimage'), false);
  assert.equal(
    buildCachedInstallCommand('pacman', '/tmp/GitTree-1.0.0-linux-x64.pacman').join(' '),
    'pkexec pacman -U --noconfirm /tmp/GitTree-1.0.0-linux-x64.pacman'
  );
  assert.equal(resolvePackageTypeForInstall('native', '/tmp/GitTree-1.0.0-linux-x64.deb'), 'deb');
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'gittree-updater-'));
  const pending = path.join(dir, 'pending');
  fs.mkdirSync(pending, { recursive: true });
  fs.writeFileSync(path.join(pending, 'GitTree-1.0.0-linux-x64.pacman'), 'x');
  assert.equal(findPendingPackage(pending), path.join(pending, 'GitTree-1.0.0-linux-x64.pacman'));
  fs.rmSync(dir, { recursive: true, force: true });
});

test('Linux pacman downloads through electron-updater and installs from cache', async () => {
  const cacheHome = fs.mkdtempSync(path.join(os.tmpdir(), 'gittree-cache-'));
  const harness = createHarness({
    platform: 'linux',
    packageType: 'pacman',
    cacheHome,
    pendingPackage: 'GitTree-1.3.0-linux-x64.pacman'
  });
  const { service, updater, opened, spawned } = harness;
  service.initialize();
  assert.equal(service.getState().autoInstall, false);
  assert.equal(service.getState().cachedInstall, true);
  assert.equal(service.autoUpdater.autoInstallOnAppQuit, false);
  assert.equal(service.getState().status, 'downloaded');
  assert.match(service.getState().pendingPackagePath || '', /\.pacman$/);

  let downloaded = false;
  updater.downloadUpdate = async () => { downloaded = true; };
  service.setState({ status: 'available' });
  assert.equal((await service.download()).success, true);
  assert.equal(downloaded, true);
  assert.equal(opened.length, 0);

  const pendingPath = service.getState().pendingPackagePath;
  assert.deepEqual(await service.install(), {
    success: true,
    restartRequired: true,
    state: service.getState()
  });
  assert.equal(spawned.length, 1);
  assert.deepEqual(
    spawned[0],
    ['pkexec', 'pacman', '-U', '--noconfirm', pendingPath]
  );
  assert.equal(harness.quitCalled, true);
  assert.equal(opened.length, 0);
  assert.equal(fs.existsSync(path.join(cacheHome, 'gittree-updater', 'pending', 'GitTree-1.3.0-linux-x64.pacman')), false);

  fs.rmSync(cacheHome, { recursive: true, force: true });
});

test('Linux cached install ignores pending package already at current version', () => {
  const cacheHome = fs.mkdtempSync(path.join(os.tmpdir(), 'gittree-cache-'));
  const pendingDir = path.join(cacheHome, 'gittree-updater', 'pending');
  fs.mkdirSync(pendingDir, { recursive: true });
  const packagePath = path.join(pendingDir, 'GitTree-1.4.0-linux-x64.pacman');
  fs.writeFileSync(packagePath, 'package');
  assert.equal(parseVersionFromPackageName(path.basename(packagePath)), '1.4.0');
  assert.equal(pendingPackageNeedsInstall(packagePath, '1.4.0'), false);
  assert.equal(pendingPackageNeedsInstall(packagePath, '1.3.0'), true);

  const { service } = createHarness({
    platform: 'linux',
    packageType: 'pacman',
    version: '1.4.0',
    cacheHome
  });
  service.initialize();
  assert.equal(service.getState().status, 'idle');
  assert.equal(service.getState().pendingPackagePath, null);
  assert.equal(fs.existsSync(packagePath), false);

  fs.rmSync(cacheHome, { recursive: true, force: true });
});

test('Linux cached install falls back to GitHub when no pending package exists', async () => {
  const cacheHome = fs.mkdtempSync(path.join(os.tmpdir(), 'gittree-cache-'));
  const { service, opened } = createHarness({
    platform: 'linux',
    packageType: 'pacman',
    cacheHome
  });
  service.setState({ status: 'downloaded' });
  assert.deepEqual(await service.install(), { success: true, manual: true, state: service.getState() });
  assert.equal(opened.length, 1);
  fs.rmSync(cacheHome, { recursive: true, force: true });
});
