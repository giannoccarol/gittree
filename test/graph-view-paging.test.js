const test = require('node:test');
const assert = require('node:assert/strict');
const { GraphView } = require('../src/renderer/components/graph-view.mts');
const { createGraphViewHarness } = require('./helpers/graph-view-harness');

const AUTHORS = [
  ['Ada', 'ada@example.test'],
  ['ada', 'ada.lower@example.test'],
  ['Émile', 'emile@example.test'],
  ['emile', ''],
  ['Zoë', 'zoe@example.test'],
  ['Bob', 'bob@example.test'],
  ['Ångström', 'angstrom@example.test'],
  ['carol', 'carol@example.test']
];
const SUBJECTS = ['fix graph paging', 'feat: add FIX button', 'Merge branch topic', 'docs', 'refactor émoji'];

function hashFor(index) {
  return `c0ffee${index.toString(16).padStart(34, '0')}`;
}

// Deterministic topological history: newest first, with merges, duplicate dates
// and dates that are not monotonic so date sorting differs from topology.
function createHistory(count) {
  return Array.from({ length: count }, (_, index) => {
    const [authorName, authorEmail] = AUTHORS[(index * 7) % AUTHORS.length];
    const parents = index < count - 1 ? [hashFor(index + 1)] : [];
    if (index % 11 === 0 && index + 5 < count) parents.push(hashFor(index + 5));
    const day = 1 + ((index * 13) % 28);
    const hour = (index * 5) % 24;
    return {
      hash: hashFor(index),
      parents,
      subject: `${SUBJECTS[index % SUBJECTS.length]} ${index}`,
      authorName,
      authorEmail,
      date: `2026-02-${String(day).padStart(2, '0')}T${String(hour).padStart(2, '0')}:00:00+01:00`
    };
  });
}

function createRefs(commits) {
  return [
    { fullName: 'HEAD', shortName: 'HEAD', type: 'head', commit: commits[0].hash, upstream: '' },
    { fullName: 'refs/heads/main', shortName: 'main', type: 'branch', commit: commits[0].hash, upstream: '' },
    { fullName: 'refs/remotes/origin/main', shortName: 'origin/main', type: 'remote', commit: commits[3].hash, upstream: '' },
    { fullName: 'refs/heads/topic', shortName: 'topic', type: 'branch', commit: commits[620].hash, upstream: '' },
    { fullName: 'refs/tags/v1.0.0', shortName: 'v1.0.0', type: 'tag', commit: commits[40].hash, upstream: '' },
    { fullName: 'refs/tags/v0.9.0', shortName: 'v0.9.0', type: 'tag', commit: commits[1180].hash, upstream: '' }
  ];
}

function createLegacyBridge(commits, refs) {
  const calls = [];
  return {
    calls,
    async getGraphPage(repoPath, options = {}) {
      calls.push({ repoPath, ...options });
      const offset = options.offset || 0;
      const limit = options.limit || 500;
      const slice = commits.slice(offset, offset + limit + 1);
      const page = slice.slice(0, limit);
      return {
        commits: page.map(commit => ({ ...commit, parents: [...commit.parents] })),
        refs: refs.map(ref => ({ ...ref })),
        nextOffset: offset + page.length,
        hasMore: slice.length > limit
      };
    }
  };
}

// Independent oracle of the visible history: filter then stable sort.
function expectedVisible(commits, refs, { searchTerm = '', filters, sortMode }) {
  const refsByHash = new Map();
  refs.forEach(ref => {
    if (!refsByHash.has(ref.commit)) refsByHash.set(ref.commit, []);
    refsByHash.get(ref.commit).push(ref);
  });
  const globalNeedle = searchTerm.trim().toLowerCase();
  const filterNeedle = filters.query.trim().toLowerCase();
  const visible = commits.filter(commit => {
    const searchable = `${commit.subject} ${commit.hash} ${commit.authorName} ${commit.authorEmail || ''}`.toLowerCase();
    if (globalNeedle && !searchable.includes(globalNeedle)) return false;
    if (filterNeedle && !searchable.includes(filterNeedle)) return false;
    if (filters.author && (commit.authorEmail || commit.authorName) !== filters.author) return false;
    const commitRefs = refsByHash.get(commit.hash) || [];
    if (filters.ref === 'branches' && !commitRefs.some(ref => ['branch', 'remote'].includes(ref.type))) return false;
    if (filters.ref === 'tags' && !commitRefs.some(ref => ref.type === 'tag')) return false;
    if (filters.ref === 'head' && !commitRefs.some(ref => ref.type === 'head')) return false;
    if (filters.ref === 'none' && commitRefs.length) return false;
    return true;
  });
  if (sortMode === 'topology') return visible.map(commit => commit.hash);
  const text = (left, right) => left.localeCompare(right, 'en', { sensitivity: 'base' });
  return [...visible].sort((a, b) => {
    if (sortMode === 'date-desc') return Date.parse(b.date) - Date.parse(a.date);
    if (sortMode === 'date-asc') return Date.parse(a.date) - Date.parse(b.date);
    if (sortMode === 'author') return text(a.authorName, b.authorName);
    if (sortMode === 'subject') return text(a.subject, b.subject);
    return text(a.hash, b.hash);
  }).map(commit => commit.hash);
}

async function loadAllPages(view) {
  let guard = 0;
  while (view.hasMore && guard < 100) {
    guard += 1;
    const loaded = await view.loadNextPage();
    if (!loaded) break;
  }
}

const SCENARIOS = [
  { name: 'no filter', filters: { query: '', author: '', ref: 'all' } },
  { name: 'case-insensitive query', filters: { query: '  FIX ', author: '', ref: 'all' } },
  { name: 'author by email', filters: { query: '', author: 'zoe@example.test', ref: 'all' } },
  { name: 'author by name fallback', filters: { query: '', author: 'emile', ref: 'all' } },
  { name: 'branch refs', filters: { query: '', author: '', ref: 'branches' } },
  { name: 'tag refs', filters: { query: '', author: '', ref: 'tags' } },
  { name: 'head ref', filters: { query: '', author: '', ref: 'head' } },
  { name: 'without refs', filters: { query: '', author: '', ref: 'none' } },
  { name: 'global search and query', searchTerm: 'merge', filters: { query: 'branch', author: '', ref: 'all' } }
];
const SORT_MODES = ['topology', 'date-desc', 'date-asc', 'author', 'subject', 'hash'];

test('paged history matches a full filter and stable sort for every mode', async () => {
  const commits = createHistory(1300);
  const refs = createRefs(commits);
  for (const sortMode of SORT_MODES) {
    for (const scenario of SCENARIOS) {
      const bridge = createLegacyBridge(commits, refs);
      const harness = createGraphViewHarness(GraphView, { bridge });
      try {
        const { view } = harness;
        await view.load('/repo');
        view.filters = { ...scenario.filters };
        view.sortMode = sortMode;
        view.searchTerm = scenario.searchTerm || '';
        view.render();
        await loadAllPages(view);
        harness.flushFrames();

        assert.equal(view.rows.length, commits.length);
        assert.deepEqual(
          view.visibleRows.map(row => row.commit.hash),
          expectedVisible(commits, refs, { ...scenario, sortMode }),
          `${sortMode} / ${scenario.name}`
        );
      } finally {
        harness.restore();
      }
    }
  }
});

test('author filter options list every loaded author sorted by name', async () => {
  const commits = createHistory(1300);
  const refs = createRefs(commits);
  const harness = createGraphViewHarness(GraphView, {
    bridge: createLegacyBridge(commits, refs),
    storage: {
      'gittree.history.view': JSON.stringify({ '/repo': { author: 'carol@example.test' } })
    }
  });
  try {
    const { view, controls } = harness;
    await view.load('/repo');
    await loadAllPages(view);

    const select = controls['history-filter-author'];
    const options = select.children.map(option => [option.value, option.textContent]);
    const authors = new Map();
    commits.forEach(commit => {
      const key = commit.authorEmail || commit.authorName;
      if (!authors.has(key)) authors.set(key, commit.authorName || key);
    });
    const expected = [['', 'history.allAuthors'], ...[...authors]
      .sort((left, right) => left[1].localeCompare(right[1], 'en'))];

    assert.deepEqual(options, expected);
    assert.equal(select.value, 'carol@example.test');
    assert.equal(view.filters.author, 'carol@example.test');
  } finally {
    harness.restore();
  }
});

test('a persisted author that never appears is cleared once history is complete', async () => {
  const commits = createHistory(1300);
  const refs = createRefs(commits);
  const harness = createGraphViewHarness(GraphView, {
    bridge: createLegacyBridge(commits, refs),
    storage: {
      'gittree.history.view': JSON.stringify({ '/repo': { author: 'ghost@example.test' } })
    }
  });
  try {
    const { view, controls, storage } = harness;
    await view.load('/repo');
    assert.equal(view.filters.author, 'ghost@example.test');
    await loadAllPages(view);

    assert.equal(view.filters.author, '');
    assert.equal(controls['history-filter-author'].value, '');
    assert.deepEqual(JSON.parse(storage.get('gittree.history.view'))['/repo'].author, '');
  } finally {
    harness.restore();
  }
});

test('ref badges and lanes reach the rendered rows', async () => {
  const commits = createHistory(1300);
  const refs = createRefs(commits);
  const harness = createGraphViewHarness(GraphView, { bridge: createLegacyBridge(commits, refs) });
  try {
    const { view } = harness;
    await view.load('/repo');
    const first = view.layer.children[0];
    const [graph, message, author, date, hash] = first.children;
    const badges = message.children[0].children.map(badge => [badge.className, badge.textContent]);

    assert.equal(first.dataset.hash, commits[0].hash);
    assert.deepEqual(badges, [['badge badge-head', 'HEAD'], ['badge badge-branch', 'main']]);
    assert.equal(message.children[1].textContent, commits[0].subject);
    assert.equal(author.textContent, commits[0].authorName);
    assert.equal(date.textContent, `date:${commits[0].date}`);
    assert.equal(hash.textContent, commits[0].hash.slice(0, 7));
    assert.equal(graph.children[0].tagName, 'SVG');
  } finally {
    harness.restore();
  }
});

test('scrolling keeps visible rows attached and only swaps rows that leave the viewport', async () => {
  const commits = createHistory(1300);
  const refs = createRefs(commits);
  const harness = createGraphViewHarness(GraphView, { bridge: createLegacyBridge(commits, refs) });
  try {
    const { view, container } = harness;
    await view.load('/repo');
    container.scrollTop = view.rowHeight * 40;
    view.renderViewport();
    const [startBefore] = view.renderedRange;
    const before = new Map(view.layer.children.map(row => [row.dataset.hash, row]));
    const removed = [];
    const originalRemove = view.layer.removeChild;
    view.layer.removeChild = node => { removed.push(node); return originalRemove(node); };
    let replaced = 0;
    const originalReplace = view.layer.replaceChildren;
    view.layer.replaceChildren = (...nodes) => { replaced += 1; return originalReplace(...nodes); };

    container.scrollTop += view.rowHeight * 3;
    view.renderViewport();

    assert.equal(replaced, 0);
    assert.equal(removed.length, 0, 'rows leaving the viewport are reused for rows entering it');
    const after = view.layer.children;
    assert.equal(after.length, before.size);
    const kept = after.filter(row => before.get(row.dataset.hash) === row);
    assert.equal(view.renderedRange[0] - startBefore, 3);
    assert.equal(kept.length, before.size - 3);
    const renderedHashes = after.map(row => row.dataset.hash).sort();
    const expectedHashes = view.visibleRows
      .slice(view.renderedRange[0], view.renderedRange[1])
      .map(row => row.commit.hash)
      .sort();
    assert.deepEqual(renderedHashes, expectedHashes);
    for (const row of after) {
      const index = view.visibleRows.findIndex(item => item.commit.hash === row.dataset.hash);
      assert.equal(row.style.transform, `translateY(${index * view.rowHeight}px)`);
    }
  } finally {
    harness.restore();
  }
});

test('a forced render reuses row elements and replaces a placeholder', async () => {
  const commits = createHistory(1300);
  const refs = createRefs(commits);
  const harness = createGraphViewHarness(GraphView, { bridge: createLegacyBridge(commits, refs) });
  try {
    const { view } = harness;
    await view.load('/repo');
    const rowsBefore = new Set(view.layer.children);
    view.layer.appendChild(view.emptyState('ph-git-commit', 'stale placeholder'));

    view.renderViewport(true);

    assert.ok(view.layer.children.every(row => row.classList.contains('graph-row')));
    assert.ok(view.layer.children.every(row => rowsBefore.has(row)));
    assert.ok(view.layer.children.some(row => row.dataset.hash === commits[0].hash));
  } finally {
    harness.restore();
  }
});
