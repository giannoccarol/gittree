const path = require('node:path');
const test = require('node:test');
const assert = require('node:assert/strict');

let SettingsView;
try {
  const mod = require(path.join(
    __dirname,
    '..',
    'src',
    'renderer',
    'components',
    'settings-view.mts'
  ));
  SettingsView = mod.SettingsView || mod.default || mod;
} catch {
  SettingsView = require(path.join(
    __dirname,
    '..',
    'src',
    'renderer',
    'components',
    'settings-view.js'
  ));
}

const previousTranslate = global.t;
global.t = key => key;
test.after(() => {
  global.t = previousTranslate;
});

function createElements() {
  const label = { textContent: 'Check for updates' };
  const button = {
    disabled: false,
    querySelector: () => label
  };
  const status = { textContent: '' };
  return { button, label, status };
}

test('update controls render the checking state and stay disabled', () => {
  const { button, status } = createElements();
  const view = Object.create(SettingsView.prototype);

  view.applyUpdateState(status, button, { status: 'checking' });

  assert.equal(status.textContent, 'settings.checking');
  assert.equal(button.disabled, true);
});

test('update controls offer the download action when an update is available', () => {
  const { button, label, status } = createElements();
  const view = Object.create(SettingsView.prototype);

  view.applyUpdateState(status, button, {
    status: 'available',
    availableVersion: '0.13.3'
  });

  assert.equal(status.textContent, 'settings.updateAvailable (0.13.3)');
  assert.equal(label.textContent, 'settings.downloadUpdate');
  assert.equal(button.disabled, false);
});

test('update controls show progress and offer install once downloaded', () => {
  const { button, label, status } = createElements();
  const view = Object.create(SettingsView.prototype);

  view.applyUpdateState(status, button, { status: 'downloading', progress: 42 });
  assert.equal(status.textContent, 'settings.downloading 42%');
  assert.equal(button.disabled, true);

  view.applyUpdateState(status, button, { status: 'downloaded', progress: 100 });
  assert.equal(status.textContent, 'settings.updateReady');
  assert.equal(label.textContent, 'settings.installUpdate');
  assert.equal(button.disabled, false);

  view.applyUpdateState(status, button, { status: 'downloaded', cachedInstall: true, progress: 100 });
  assert.equal(status.textContent, 'updates.cachedReady');
  assert.equal(label.textContent, 'updates.installPackage');
});

test('update controls restore the check label after a successful idle check', () => {
  const { button, label, status } = createElements();
  const view = Object.create(SettingsView.prototype);

  view.applyUpdateState(status, button, { status: 'available', availableVersion: '0.13.3' });
  view.applyUpdateState(status, button, { status: 'idle' });

  assert.equal(status.textContent, 'settings.upToDate');
  assert.equal(label.textContent, 'settings.checkUpdate');
  assert.equal(button.disabled, false);
});

test('update controls show the error instead of pretending to be up to date', () => {
  const { button, status } = createElements();
  const view = Object.create(SettingsView.prototype);

  view.applyUpdateState(status, button, { status: 'error', error: 'Connection refused' });

  assert.equal(status.textContent, 'Connection refused');
  assert.equal(button.disabled, false);
});

test('update controls explain that updates need the installed app', () => {
  const { button, status } = createElements();
  const view = Object.create(SettingsView.prototype);

  view.applyUpdateState(status, button, { status: 'disabled' });

  assert.equal(status.textContent, 'settings.updateUnavailable');
  assert.equal(button.disabled, true);
});

test('update controls ignore missing elements', () => {
  const view = Object.create(SettingsView.prototype);
  view.applyUpdateState(null, null, { status: 'idle' });
});
