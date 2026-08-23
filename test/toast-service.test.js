const test = require('node:test');
const assert = require('node:assert/strict');

let ToastService;
try {
  const mod = require('../src/renderer/toast-service.mts');
  ToastService = mod.ToastService || mod.default || mod;
} catch {
  ToastService = require('../src/renderer/toast-service');
}

function createHarness() {
  const classes = new Set(['toast']);
  const attributes = {};
  const timers = [];
  const listeners = { mouseenter: [], mouseleave: [] };
  const container = {
    get className() { return [...classes].join(' '); },
    set className(value) {
      classes.clear();
      String(value).split(/\s+/).filter(Boolean).forEach(name => classes.add(name));
    },
    innerHTML: '',
    classList: {
      add: name => classes.add(name),
      remove: name => classes.delete(name),
      contains: name => classes.has(name)
    },
    setAttribute: (name, value) => { attributes[name] = value; },
    matches: () => false,
    querySelector: selector => {
      if (selector === '.toast-message') {
        return { textContent: '' };
      }
      if (selector === '.toast-progress') {
        return { style: {} };
      }
      if (selector === '.toast-dismiss') {
        return { onclick: null };
      }
      return null;
    },
    addEventListener: (event, handler) => listeners[event].push(handler),
    removeEventListener: (event, handler) => {
      listeners[event] = listeners[event].filter(fn => fn !== handler);
    }
  };
  const scheduler = {
    setTimeout(callback, delay) {
      const timer = { callback, delay, cleared: false };
      timers.push(timer);
      return timer;
    },
    clearTimeout(timer) { if (timer) timer.cleared = true; }
  };
  const service = new ToastService({
    container,
    translate: key => `t:${key}`,
    encode: value => `<${value}>`,
    timers: {
      setTimeout: scheduler.setTimeout,
      clearTimeout: scheduler.clearTimeout
    }
  });
  return { service, container, attributes, timers, listeners };
}

test('show applies kind class, aria-live and message text', () => {
  const { service, container, attributes } = createHarness();
  service.show('Saved', 'success');
  assert.equal(container.className, 'toast toast-success show');
  assert.equal(attributes['aria-live'], 'polite');
  service.show('Boom', 'error');
  assert.equal(container.className, 'toast toast-error show');
  assert.equal(attributes['aria-live'], 'assertive');
});

test('unknown kinds fall back to loading with its duration', () => {
  const { service, container, timers } = createHarness();
  service.show('Working', 'nonsense');
  assert.equal(container.className, 'toast toast-loading show');
  assert.equal(timers.at(-1).delay, 2500);
});

test('dismiss clears the pending timer and hides the toast', () => {
  const { service, container, timers } = createHarness();
  service.show('Saved', 'success');
  service.dismiss();
  assert.equal(timers.at(-1).cleared, true);
  assert.equal(container.classList.contains('show'), false);
});

test('pause freezes remaining time and resume restarts with a floor', () => {
  const harness = createHarness();
  const realDateNow = Date.now;
  Date.now = () => 1000;
  const { service, container, timers } = harness;
  service.show('Saved', 'warning');
  assert.equal(timers.at(-1).delay, 4200);
  Date.now = () => 5000;
  service.pause();
  assert.equal(container.classList.contains('paused'), true);
  Date.now = () => 6000;
  service.resume();
  assert.equal(container.classList.contains('paused'), false);
  assert.equal(timers.at(-1).delay, Math.max(4200 - 4000, 800));
  Date.now = realDateNow;
});

test('mount subscribes hover listeners and destroy removes them', () => {
  const { service, listeners } = createHarness();
  service.mount();
  assert.equal(listeners.mouseenter.length, 1);
  assert.equal(listeners.mouseleave.length, 1);
  service.destroy();
  assert.equal(listeners.mouseenter.length, 0);
  assert.equal(listeners.mouseleave.length, 0);
});
