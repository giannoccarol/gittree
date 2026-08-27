const test = require('node:test');
const assert = require('node:assert/strict');

const { shouldHandoverToSecondInstance } = require('../src/main/single-instance.mts');

test('single-instance hands over when the second instance reports a different version', () => {
  assert.equal(shouldHandoverToSecondInstance('0.23.0', { version: '0.23.1' }), true);
  assert.equal(shouldHandoverToSecondInstance('0.23.1', { version: '0.23.0' }), true);
});

test('single-instance keeps focus when versions match or additional data is missing', () => {
  assert.equal(shouldHandoverToSecondInstance('0.23.0', { version: '0.23.0' }), false);
  assert.equal(shouldHandoverToSecondInstance('0.23.0', undefined), false);
  assert.equal(shouldHandoverToSecondInstance('0.23.0', {}), false);
});
