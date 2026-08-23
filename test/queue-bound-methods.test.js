const test = require('node:test');
const assert = require('node:assert/strict');

const { bindMethodsToQueue } = require('../src/main/git/queue-bound-methods.mts');
const { RepositoryQueue } = require('../src/main/git/repository-queue.mts');

class Service {
  constructor() {
    this.queue = new RepositoryQueue();
    this.log = [];
    bindMethodsToQueue(this);
  }

  runExclusive(operation) {
    return this.queue.runExclusive(operation);
  }

  async slow(name, ms) {
    this.log.push(`${name}:start`);
    await new Promise(resolve => setTimeout(resolve, ms));
    this.log.push(`${name}:end`);
    return name;
  }

  syncMethod() {
    return 'sync';
  }

  get accessor() {
    return 'accessor';
  }
}

test('async methods serialize through the queue', async () => {
  const service = new Service();
  const first = service.slow('first', 30);
  const second = service.slow('second', 0);
  assert.equal(await first, 'first');
  assert.equal(await second, 'second');
  assert.deepEqual(service.log, [
    'first:start',
    'first:end',
    'second:start',
    'second:end'
  ]);
});

test('nested calls inside the queue stay re-entrant', async () => {
  const service = new Service();
  service.nested = async function nested() {
    return this.slow('inner', 0);
  };
  bindMethodsToQueue(service);
  const result = await service.nested();
  assert.equal(result, 'inner');
  assert.deepEqual(service.log, ['inner:start', 'inner:end']);
});

test('synchronous methods and getters are not wrapped', () => {
  const service = new Service();
  assert.equal(service.syncMethod(), 'sync');
  assert.equal(service.accessor, 'accessor');
  assert.equal(Object.getOwnPropertyDescriptor(service, 'syncMethod'), undefined);
  assert.equal(Object.getOwnPropertyDescriptor(service, 'accessor'), undefined);
});

test('wrapped methods are own non-enumerable properties', () => {
  const service = new Service();
  const descriptor = Object.getOwnPropertyDescriptor(service, 'slow');
  assert.ok(descriptor);
  assert.equal(descriptor.enumerable, false);
  assert.equal(typeof descriptor.value, 'function');
});
