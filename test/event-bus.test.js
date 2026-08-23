const test = require('node:test');
const assert = require('node:assert/strict');

let EventBus;
try {
  const mod = require('../src/renderer/event-bus.mts');
  EventBus = mod.EventBus || mod.default || mod;
} catch {
  EventBus = require('../src/renderer/event-bus');
}

test('on subscribes and emit delivers the payload to every listener in order', () => {
  const bus = new EventBus();
  const calls = [];
  bus.on('repo:changed', repo => calls.push(['first', repo]));
  bus.on('repo:changed', repo => calls.push(['second', repo]));
  bus.emit('repo:changed', { path: '/tmp/repo' });
  assert.deepEqual(calls, [
    ['first', { path: '/tmp/repo' }],
    ['second', { path: '/tmp/repo' }]
  ]);
});

test('emit on a channel without listeners is a no-op', () => {
  const bus = new EventBus();
  assert.doesNotThrow(() => bus.emit('refresh'));
});

test('off removes exactly one listener and stops its deliveries', () => {
  const bus = new EventBus();
  const calls = [];
  const listener = value => calls.push(value);
  const unsubscribe = bus.on('commit:selected', listener);
  unsubscribe();
  bus.emit('commit:selected', 'abc123');
  assert.deepEqual(calls, []);
  assert.equal(bus.listenerCount('commit:selected'), 0);
});

test('listeners added during an emit are registered but skipped in the same pass', () => {
  const bus = new EventBus();
  const calls = [];
  bus.on('refresh', () => {
    calls.push('outer');
    bus.on('refresh', () => calls.push('inner-during-emit'));
  });
  bus.emit('refresh');
  assert.deepEqual(calls, ['outer']);
  bus.emit('refresh');
  assert.deepEqual(calls, ['outer', 'outer', 'inner-during-emit']);
});

test('clear removes every subscription', () => {
  const bus = new EventBus();
  bus.on('refresh', () => {});
  bus.on('repo:cleared', () => {});
  bus.clear();
  assert.equal(bus.listenerCount('refresh'), 0);
  assert.equal(bus.listenerCount('repo:cleared'), 0);
});
