const test = require('node:test');
const assert = require('node:assert/strict');
const path = require('node:path');

function loadSettingsView(exportDiagnostics) {
  const translations = {
    'settings.exportingDiagnostics': 'Exporting…',
    'settings.diagnosticsExported': 'Diagnostics bundle saved.',
    'settings.diagnosticsFailed': 'Could not export diagnostics.'
  };
  global.window = { gitTree: { exportDiagnostics } };
  global.t = key => translations[key] || key;
  const mod = require(path.join(
    __dirname,
    '..',
    'src',
    'renderer',
    'components',
    'settings-view.mts'
  ));
  return mod.SettingsView || mod.default || mod;
}

test('diagnostics export exposes loading and success states', async () => {
  const SettingsView = loadSettingsView(async () => ({ saved: true }));
  const view = Object.create(SettingsView.prototype);
  const toasts = [];
  view.app = { showToast: (...args) => toasts.push(args) };
  const button = { disabled: false };
  const status = { textContent: '' };

  const operation = view.exportDiagnostics(button, status);
  assert.equal(button.disabled, true);
  assert.equal(status.textContent, 'Exporting…');
  await operation;

  assert.equal(button.disabled, false);
  assert.equal(status.textContent, 'Diagnostics bundle saved.');
  assert.deepEqual(toasts, [['Diagnostics bundle saved.', 'success']]);
});

test('diagnostics export reports an error and treats cancel as a neutral result', async () => {
  let result = { error: 'disk full' };
  const SettingsView = loadSettingsView(async () => result);
  const view = Object.create(SettingsView.prototype);
  const toasts = [];
  view.app = { showToast: (...args) => toasts.push(args) };
  const button = { disabled: false };
  const status = { textContent: '' };

  await view.exportDiagnostics(button, status);
  assert.equal(status.textContent, 'disk full');
  assert.deepEqual(toasts, [['disk full', 'error']]);

  result = { canceled: true };
  status.textContent = 'old';
  await view.exportDiagnostics(button, status);
  assert.equal(status.textContent, '');
  assert.equal(button.disabled, false);
});
