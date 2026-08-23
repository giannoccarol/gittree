const test = require('node:test');
const assert = require('node:assert/strict');
let DialogService;
try {
  const mod = require('../src/renderer/dialog-service.mts');
  DialogService = mod.DialogService || mod.default || mod;
} catch {
  DialogService = require('../src/renderer/dialog-service');
}

function createHarness() {
  const listeners = new Map();
  const cancel = { focus() {}, onclick: null };
  const confirm = { focus() {}, onclick: null };
  const form = { onsubmit: null, elements: { value: { value: 'new-name' } } };
  const previous = { isConnected: true, focusCalls: 0, focus() { this.focusCalls += 1; } };
  const dialog = {
    className: 'confirm-dialog',
    innerHTML: '',
    attributes: {},
    setAttribute(name, value) { this.attributes[name] = value; },
    removeAttribute(name) { delete this.attributes[name]; },
    querySelector(selector) {
      if (selector === '[data-cancel]') return cancel;
      if (selector === '[data-confirm]') return confirm;
      if (selector === 'form') return form;
      return confirm;
    },
    querySelectorAll() { return [cancel, confirm]; }
  };
  const overlay = {
    onclick: null,
    classList: {
      hidden: true,
      add() { this.hidden = true; },
      remove() { this.hidden = false; }
    }
  };
  const document = {
    activeElement: previous,
    addEventListener(type, listener) { listeners.set(type, listener); },
    removeEventListener(type, listener) {
      if (listeners.get(type) === listener) listeners.delete(type);
    }
  };
  return { document, overlay, dialog, cancel, confirm, form, previous, listeners };
}

test('confirm dialog is modal, resolves actions and restores focus', async () => {
  const harness = createHarness();
  const service = new DialogService({
    document: harness.document,
    overlay: harness.overlay,
    dialog: harness.dialog,
    encode: value => String(value)
  });

  const result = service.confirm({
    title: 'Delete branch?',
    message: 'This cannot be undone.',
    cancelLabel: 'Cancel',
    actionLabel: 'Delete',
    danger: true
  });

  assert.equal(harness.dialog.attributes.role, 'dialog');
  assert.equal(harness.dialog.attributes['aria-modal'], 'true');
  assert.match(harness.dialog.innerHTML, /btn-danger/);
  assert.equal(harness.overlay.classList.hidden, false);
  harness.confirm.onclick();

  assert.equal(await result, true);
  assert.equal(harness.overlay.classList.hidden, true);
  assert.equal(harness.previous.focusCalls, 1);
});

test('Escape cancels the active dialog and removes its keyboard listener', async () => {
  const harness = createHarness();
  const service = new DialogService({
    document: harness.document,
    overlay: harness.overlay,
    dialog: harness.dialog,
    encode: value => String(value)
  });
  const result = service.confirm({
    title: 'Confirm',
    message: 'Message',
    cancelLabel: 'Cancel',
    actionLabel: 'Continue'
  });
  const event = { key: 'Escape', preventDefault() {} };
  harness.listeners.get('keydown')(event);

  assert.equal(await result, false);
  assert.equal(harness.listeners.has('keydown'), false);
});

test('prompt uses the shared form lifecycle and returns the submitted value', async () => {
  const harness = createHarness();
  const service = new DialogService({
    document: harness.document,
    overlay: harness.overlay,
    dialog: harness.dialog,
    encode: value => String(value).replace(/</g, '&lt;')
  });
  const result = service.prompt({
    title: 'Rename',
    label: 'Name',
    value: '<old>',
    cancelLabel: 'Cancel',
    actionLabel: 'Save'
  });

  assert.match(harness.dialog.innerHTML, /value="&lt;old>"/);
  harness.form.onsubmit({ preventDefault() {}, currentTarget: harness.form });
  assert.equal(await result, 'new-name');
  assert.equal(harness.previous.focusCalls, 1);
});
