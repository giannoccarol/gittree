const { EventEmitter } = require('node:events');
const test = require('node:test');
const assert = require('node:assert/strict');

const { UpdateService, supportsAutoInstall } = require('../src/main/update-service.mts');

function createHarness({ packaged = true, version = '1.2.3', platform = 'win32', packageType = '' } = {}) {
  const sent = [];
  const scheduled = [];
  const cleared = [];
  const opened = [];
  const updater = new EventEmitter();
  updater.checkForUpdates = async () => {};
  updater.downloadUpdate = async () => {};
  updater.quitAndInstall = (...args) => scheduled.push(['install', ...args]);
  const window = {
    isDestroyed: () => false,
    webContents: { send: (...args) => sent.push(args) }
  };
  const timer = { unref() { scheduled.push(['unref']); } };
  const service = new UpdateService(window, {
    app: { isPackaged: packaged, getVersion: () => version },
    autoUpdater: updater,
    platform,
    openExternal: async url => { opened.push(url); },
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
  service.state.packageType = packageType;
  service.state.autoInstall = service.autoInstall;
  return { service, updater, window, sent, scheduled, cleared, opened };
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
    autoInstall: true
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
  assert.equal(service.install().success, false);

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
  assert.deepEqual(service.install(), { success: true });
  assert.ok(scheduled.some(item => item[0] === 'install' && item[1] === false && item[2] === true));
});

test('Linux pacman installs open the release page instead of quitAndInstall', () => {
  const { service, scheduled, opened } = createHarness({
    platform: 'linux',
    packageType: 'pacman'
  });
  service.initialize();
  assert.equal(service.getState().autoInstall, false);
  assert.equal(service.autoUpdater.autoInstallOnAppQuit, false);
  service.setState({ status: 'downloaded' });
  assert.deepEqual(service.install(), { success: true, manual: true });
  assert.equal(opened.length, 1);
  assert.equal(scheduled.some(item => item[0] === 'install'), false);
});
