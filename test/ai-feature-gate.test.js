const test = require('node:test');
const assert = require('node:assert/strict');

const {
  isAgentsFeatureEnabled,
  setAgentsFeatureEnabled,
  onAgentsFeatureEnabledChange
} = require('../src/renderer/ai-feature-gate.mts');

test.after(() => {
  setAgentsFeatureEnabled(true);
});

test('agents feature gate notifies listeners when toggled', () => {
  const seen = [];
  const dispose = onAgentsFeatureEnabledChange(enabled => seen.push(enabled));
  assert.equal(isAgentsFeatureEnabled(), true);
  setAgentsFeatureEnabled(false);
  assert.equal(isAgentsFeatureEnabled(), false);
  setAgentsFeatureEnabled(false);
  setAgentsFeatureEnabled(true);
  assert.deepEqual(seen, [true, false, true]);
  dispose();
});
