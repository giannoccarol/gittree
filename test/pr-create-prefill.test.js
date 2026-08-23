const test = require('node:test');
const assert = require('node:assert/strict');
let PrCreatePrefill;
try {
  const mod = require('../src/renderer/pr-create-prefill.mts');
  PrCreatePrefill = mod.PrCreatePrefill || mod.default || mod;
} catch {
  PrCreatePrefill = require('../src/renderer/pr-create-prefill');
}

test('builds a title from the first commit subject', () => {
  const draft = PrCreatePrefill.build({
    source: 'feature/logo',
    commits: [
      { hash: 'a'.repeat(40), message: 'Add logo variants\n\nLonger body text' },
      { hash: 'b'.repeat(40), message: 'Prepare release' }
    ]
  });
  assert.equal(draft.title, 'Add logo variants');
});

test('falls back to the source branch when no commits exist', () => {
  const draft = PrCreatePrefill.build({ source: 'feature/login', commits: [] });
  assert.equal(draft.title, 'feature/login');
  assert.equal(draft.body, '');
  assert.deepEqual(draft.workItems, []);
});

test('truncates the generated title to the dialog limit', () => {
  const subject = 'x'.repeat(300);
  const draft = PrCreatePrefill.build({
    source: 'feature/x',
    commits: [{ hash: 'a'.repeat(40), message: subject }]
  });
  assert.equal(draft.title.length, 256);
});

test('renders the commit list with subjects and short hashes', () => {
  const draft = PrCreatePrefill.build({
    source: 'feature/logo',
    commits: [
      { hash: 'abc123def456', message: 'Add logo' },
      { hash: 'fed654cba321', message: 'Fix spacing\n\nDetails' }
    ]
  });
  assert.equal(
    draft.body,
    '- Add logo (abc123de)\n- Fix spacing (fed654cb)'
  );
});

test('collects work item ids from branch name and commit subjects', () => {
  const draft = PrCreatePrefill.build({
    source: 'feature/12345-logo',
    commits: [
      { hash: 'a'.repeat(40), message: 'Add logo (#12345)' },
      { hash: 'b'.repeat(40), message: 'Fix contrast AB#99' },
      { hash: 'c'.repeat(40), message: 'Cleanup #7' },
      { hash: 'd'.repeat(40), message: 'Chore without ids' }
    ]
  });
  assert.deepEqual(draft.workItems, [12345, 99, 7]);
});

test('detects bare five digit branch segments and keeps ids unique', () => {
  const draft = PrCreatePrefill.build({
    source: 'users/alice/12345',
    commits: [{ hash: 'a'.repeat(40), message: 'Done #12345' }]
  });
  assert.deepEqual(draft.workItems, [12345]);
});

test('ignores non-numeric references and short bare segments', () => {
  const draft = PrCreatePrefill.build({
    source: 'release/2024',
    commits: [
      { hash: 'a'.repeat(40), message: 'Use #abc color' },
      { hash: 'b'.repeat(40), message: 'Bump version 1.2.3' }
    ]
  });
  assert.deepEqual(draft.workItems, []);
});

test('caps collected work item ids at the service limit', () => {
  const commits = [];
  for (let id = 1; id <= 25; id += 1) {
    commits.push({ hash: String(id).padStart(40, 'a'), message: `Task #${id}` });
  }
  const draft = PrCreatePrefill.build({ source: 'feature/x', commits });
  assert.equal(draft.workItems.length, 20);
});
