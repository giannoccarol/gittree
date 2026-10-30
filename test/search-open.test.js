const test = require('node:test');
const assert = require('node:assert/strict');

function element() {
  return {
    innerHTML: '',
    value: '',
    classList: { add() {}, remove() {} },
    focus() { this.focused = (this.focused || 0) + 1; }
  };
}

test('opening the search with a focus and a click loads its data once without duplicates', async () => {
  global.t = key => key;
  global.window = global.window || {};
  const reads = [];
  let release;
  const gate = new Promise(resolve => { release = resolve; });
  global.window.gitTree = {
    getBranches: async () => { reads.push('branches'); await gate; return { branches: { main: {} }, current: 'main' }; },
    getLog: async () => { reads.push('log'); await gate; return { all: [{ message: 'Fix', hash: 'abcdef1234', author_name: 'Ada', date: '2026-01-01' }] }; },
    getStatus: async () => { reads.push('status'); await gate; return { files: [] }; }
  };
  const { GlobalSearch } = require('../src/renderer/components/search.mts');
  const search = Object.create(GlobalSearch.prototype);
  Object.assign(search, {
    app: { state: { repo: { path: '/repo' } }, components: { repoTabs: { repos: [] } } },
    overlay: element(),
    input: element(),
    results: element(),
    filters: element(),
    aiButton: null,
    allData: [],
    selectedIdx: -1,
    visible: false,
    loadGeneration: 0,
    fmtDate: value => value
  });

  const first = search.show();
  const second = search.show();
  release();
  await Promise.all([first, second]);

  assert.deepEqual(reads, ['branches', 'log', 'status']);
  assert.equal(search.allData.filter(item => item.type === 'commit').length, 1);
  assert.equal(search.allData.filter(item => item.type === 'branch').length, 1);
});
