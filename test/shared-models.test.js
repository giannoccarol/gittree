const test = require('node:test');
const assert = require('node:assert/strict');

const {
  parseOperationState,
  OPERATION_TYPES
} = require('../src/shared/models.mts');

test('parseOperationState accepts a clean state', () => {
  const result = parseOperationState({ type: null, conflicts: [], canContinue: false });
  assert.equal(result.ok, true);
  if (result.ok) {
    assert.deepEqual(result.value, { type: null, conflicts: [], canContinue: false });
  }
});

test('parseOperationState accepts a pending merge with conflicts', () => {
  const input = { type: 'merge', conflicts: ['a.txt', 'b.txt'], canContinue: false };
  const result = parseOperationState(input);
  assert.equal(result.ok, true);
  if (result.ok) assert.deepEqual(result.value, input);
});

test('parseOperationState accepts every declared operation type', () => {
  for (const type of OPERATION_TYPES) {
    const result = parseOperationState({ type, conflicts: [], canContinue: true });
    assert.equal(result.ok, true);
  }
});

test('parseOperationState rejects non-object input', () => {
  for (const input of [null, undefined, 42, 'merge', [], true]) {
    const result = parseOperationState(input);
    assert.equal(result.ok, false);
    if (!result.ok) assert.deepEqual(result.errors, ['operation state must be an object']);
  }
});

test('parseOperationState rejects unknown operation types', () => {
  const result = parseOperationState({ type: 'revert', conflicts: [], canContinue: true });
  assert.equal(result.ok, false);
});

test('parseOperationState rejects non-string conflict paths', () => {
  const result = parseOperationState({ type: 'merge', conflicts: ['ok.txt', 7], canContinue: true });
  assert.equal(result.ok, false);
  if (!result.ok) assert.match(result.errors.join(' '), /conflicts/);
});

test('parseOperationState rejects missing or non-boolean canContinue', () => {
  const missing = parseOperationState({ type: null, conflicts: [] });
  assert.equal(missing.ok, false);
  const wrong = parseOperationState({ type: null, conflicts: [], canContinue: 'yes' });
  assert.equal(wrong.ok, false);
});
