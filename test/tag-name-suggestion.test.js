const test = require('node:test');
const assert = require('node:assert/strict');
let TagNameSuggestion;
try {
  const mod = require('../src/renderer/tag-name-suggestion.mts');
  TagNameSuggestion = mod.TagNameSuggestion || mod.default || mod;
} catch {
  TagNameSuggestion = require('../src/renderer/tag-name-suggestion');
}

test('suggests the next tag by incrementing the trailing number of the highest release', () => {
  assert.deepEqual(TagNameSuggestion.suggest(['v1.2.3']), {
    latest: 'v1.2.3',
    next: 'v1.2.4'
  });
  assert.deepEqual(TagNameSuggestion.suggest(['v1.2.9']), {
    latest: 'v1.2.9',
    next: 'v1.2.10'
  });
  assert.deepEqual(TagNameSuggestion.suggest(['v1.09']), {
    latest: 'v1.09',
    next: 'v1.10'
  });
  assert.equal(
    TagNameSuggestion.suggest([`v1.${'9'.repeat(30)}`]).next,
    `v1.1${'0'.repeat(30)}`
  );
});

test('picks the highest numeric tag regardless of list order', () => {
  const names = ['v1.2.10', 'v1.9.0', 'v1.2.3', 'nightly', 'release-9', 'release-10'];
  assert.deepEqual(TagNameSuggestion.suggest(names), {
    latest: 'v1.9.0',
    next: 'v1.9.1'
  });
  assert.deepEqual(TagNameSuggestion.suggest([...names].reverse()).latest, 'v1.9.0');
  assert.deepEqual(TagNameSuggestion.suggest(['v1.2.9', 'v1.2.10']), {
    latest: 'v1.2.10',
    next: 'v1.2.11'
  });
  assert.deepEqual(TagNameSuggestion.suggest(['v2.0.0', 'v10.0.0']), {
    latest: 'v10.0.0',
    next: 'v10.0.1'
  });
  assert.deepEqual(TagNameSuggestion.suggest(['release-9', 'release-10']), {
    latest: 'release-10',
    next: 'release-11'
  });
});

test('leaves the suggestion empty when the latest tag has no trailing digits', () => {
  assert.deepEqual(TagNameSuggestion.suggest(['release']), {
    latest: 'release',
    next: ''
  });
  assert.deepEqual(TagNameSuggestion.suggest(['v1.2.3-beta', 'nightly']), {
    latest: 'v1.2.3-beta',
    next: ''
  });
  assert.deepEqual(TagNameSuggestion.suggest(['v1.2.3', 'v1.2.3-beta']), {
    latest: 'v1.2.3-beta',
    next: ''
  });
  assert.deepEqual(TagNameSuggestion.suggest(['v1.2.3-rc2', 'v1.2.3-rc10']), {
    latest: 'v1.2.3-rc10',
    next: 'v1.2.3-rc11'
  });
});

test('orders tags the way git tag --sort=version:refname does', () => {
  const ascending = [
    'bar',
    'foo1',
    'nightly',
    'release-2',
    'release-9',
    'release-10',
    'v1.02',
    'v1.2',
    'v1.2.0',
    'v1.2.3',
    'v1.2.3-beta',
    'v1.2.3-rc.1',
    'v1.2.3-rc1',
    'v1.2.3-rc10',
    'v1.2.9',
    'v1.2.10',
    'v1.9.0',
    'v2.0.0',
    'v10.0.0'
  ];
  const sorted = [...ascending].reverse().sort((left, right) => {
    const suggestion = TagNameSuggestion.suggest([left, right]);
    if (suggestion.latest === left) return 1;
    if (suggestion.latest === right) return -1;
    return 0;
  });
  assert.deepEqual(sorted, ascending);
  assert.equal(TagNameSuggestion.suggest(ascending).latest, 'v10.0.0');
  assert.equal(TagNameSuggestion.suggest(['v1.02', 'v1.2']).latest, 'v1.2');
});

test('returns an empty suggestion when the repository has no tags', () => {
  assert.deepEqual(TagNameSuggestion.suggest([]), { latest: null, next: '' });
  assert.deepEqual(TagNameSuggestion.suggest(null), { latest: null, next: '' });
  assert.deepEqual(TagNameSuggestion.suggest({ all: [] }), { latest: null, next: '' });
  assert.deepEqual(TagNameSuggestion.suggest({ error: 'Failed to get tags', all: ['v1.2.3'] }), {
    latest: null,
    next: ''
  });
});

test('reads tag names from the getTags result and ignores its latest field', () => {
  assert.deepEqual(TagNameSuggestion.suggest({
    all: ['release-2', 'release-10', '  v0.9.0  '],
    latest: 'release-2'
  }), {
    latest: 'v0.9.0',
    next: 'v0.9.1'
  });
  assert.deepEqual(TagNameSuggestion.suggest({
    all: ['release-2', 'release-10'],
    latest: 'release-2'
  }), {
    latest: 'release-10',
    next: 'release-11'
  });
});
