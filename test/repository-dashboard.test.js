const test = require('node:test');
const assert = require('node:assert/strict');

const {
  RepositoryDashboard,
  buildRepositoryDashboardStats,
  percentageChange
} = require('../src/renderer/components/repository-dashboard.mts');

const NOW = new Date('2026-08-27T12:00:00.000Z');

function commit(hash, daysAgo, authorName, authorEmail = '') {
  return {
    hash,
    subject: `Commit ${hash}`,
    authorName,
    authorEmail,
    date: new Date(NOW.getTime() - (daysAgo * 86400000)).toISOString()
  };
}

test('repository dashboard aggregates current and previous activity across repositories', () => {
  const stats = buildRepositoryDashboardStats([
    {
      repo: { path: '/work/alpha', name: 'Alpha' },
      commits: [
        commit('a1', 1, 'Ada', 'ada@example.com'),
        commit('a2', 3, 'Ada', 'ADA@example.com'),
        commit('a3', 35, 'Linus', 'linus@example.com')
      ],
      refs: [
        { type: 'branch', fullName: 'refs/heads/main' },
        { type: 'branch', fullName: 'refs/heads/feature' },
        { type: 'tag', fullName: 'refs/tags/v1' }
      ],
      truncated: false
    },
    {
      repo: { path: '/work/beta', name: 'Beta' },
      commits: [
        commit('b1', 2, 'Grace', 'grace@example.com'),
        commit('b2', 50, 'Grace', 'grace@example.com')
      ],
      refs: [{ type: 'branch', fullName: 'refs/heads/main' }],
      truncated: true
    }
  ], 30, NOW);

  assert.equal(stats.repositoryCount, 2);
  assert.equal(stats.commitCount, 3);
  assert.equal(stats.previousCommitCount, 2);
  assert.equal(stats.contributorCount, 2);
  assert.equal(stats.branchCount, 3);
  assert.equal(stats.tagCount, 1);
  assert.equal(stats.truncatedRepositoryCount, 1);
  assert.deepEqual(stats.repositories.map(repo => [repo.name, repo.commits]), [
    ['Alpha', 2],
    ['Beta', 1]
  ]);
  assert.deepEqual(stats.contributors.map(author => [author.name, author.commits]), [
    ['Ada', 2],
    ['Grace', 1]
  ]);
  assert.equal(stats.timeline.reduce((sum, bucket) => sum + bucket.commits, 0), 3);
  assert.equal(stats.previousTimeline.reduce((sum, count) => sum + count, 0), 2);
  assert.equal(stats.weekdays.reduce((sum, count) => sum + count, 0), 3);
  assert.deepEqual(stats.recentCommits.map(item => item.hash), ['a1', 'b1', 'a2']);
});

test('repository dashboard keeps empty repositories visible and ignores invalid dates', () => {
  const stats = buildRepositoryDashboardStats([
    {
      repo: { path: '/work/empty', name: 'Empty' },
      commits: [{ ...commit('bad', 1, 'Nobody'), date: 'not-a-date' }],
      refs: [],
      truncated: false
    }
  ], 90, NOW);

  assert.equal(stats.commitCount, 0);
  assert.equal(stats.contributorCount, 0);
  assert.equal(stats.repositories.length, 1);
  assert.equal(stats.repositories[0].commits, 0);
  assert.equal(stats.repositories[0].lastCommitDate, null);
});

test('percentage change reports comparable trends without dividing by zero', () => {
  assert.equal(percentageChange(12, 8), 50);
  assert.equal(percentageChange(4, 8), -50);
  assert.equal(percentageChange(0, 0), 0);
  assert.equal(percentageChange(4, 0), null);
});

test('repository dashboard can center every statistic on one contributor', () => {
  const input = [{
      repo: { path: '/work/alpha', name: 'Alpha' },
    commits: [
      commit('a1', 1, 'Lorenzo Giannoccaro', 'lorenzo@example.com'),
      commit('a4', 2, ' Lorenzo   Giannoccaro ', 'another-account@example.com'),
      commit('a2', 2, 'Ada', 'ada@example.com'),
      commit('a3', 35, 'Lorenzo Giannoccaro', 'lorenzo@example.com')
    ],
    refs: [{ type: 'branch', fullName: 'refs/heads/main' }],
    truncated: false
  }];

  const stats = buildRepositoryDashboardStats(input, 30, NOW, 'name:lorenzo giannoccaro');

  assert.equal(stats.commitCount, 2);
  assert.equal(stats.totalCommitCount, 3);
  assert.equal(stats.previousCommitCount, 1);
  assert.equal(stats.contributorCount, 1);
  assert.equal(stats.activeRepositoryCount, 1);
  assert.equal(stats.activeDayCount, 2);
  assert.deepEqual(stats.recentCommits.map(item => item.hash), ['a1', 'a4']);
});

test('author selector exposes one option for accounts sharing the same name', () => {
  const dashboard = Object.create(RepositoryDashboard.prototype);
  dashboard.inputs = [{
    repo: { path: '/work/alpha', name: 'Alpha' },
    refs: [],
    truncated: false,
    commits: [
      commit('a1', 1, 'Lorenzo Giannoccaro', 'lorenzo@personal.example'),
      commit('a2', 2, ' lorenzo   giannoccaro ', 'lorenzo@work.example'),
      commit('a3', 3, 'Ada', 'ada@example.com')
    ]
  }];
  dashboard.translate = key => key;

  const options = dashboard.contributorOptions();

  assert.deepEqual(options.map(option => option.name), ['Ada', 'Lorenzo Giannoccaro']);
  assert.equal(options.filter(option => option.name.toLowerCase().includes('lorenzo')).length, 1);
});

test('dashboard caches repository reads until an explicit refresh', async () => {
  const dashboard = Object.create(RepositoryDashboard.prototype);
  dashboard.period = 30;
  dashboard.analyticsCache = new Map();
  let reads = 0;
  const repo = { path: '/work/cache', name: 'Cache' };
  const input = { repo, commits: [], refs: [], truncated: false };
  dashboard.loadRepository = async () => {
    reads += 1;
    return input;
  };

  await dashboard.loadRepositoryCached(repo, false);
  await dashboard.loadRepositoryCached(repo, false);
  await dashboard.loadRepositoryCached(repo, true);

  assert.equal(reads, 2);
});

test('dashboard remembers the last contributor and favorite in injected storage', () => {
  const values = new Map([
    ['gittree.dashboard.selectedContributor', 'name:lorenzo giannoccaro'],
    ['gittree.dashboard.favoriteContributor', 'name:lorenzo giannoccaro']
  ]);
  const storage = {
    getItem: key => values.get(key) || null,
    setItem: (key, value) => values.set(key, value),
    removeItem: key => values.delete(key)
  };
  const dashboard = Object.create(RepositoryDashboard.prototype);
  dashboard.storage = storage;
  dashboard.selectedContributor = dashboard.readPreference('gittree.dashboard.selectedContributor');
  dashboard.favoriteContributor = dashboard.readPreference('gittree.dashboard.favoriteContributor');
  dashboard.render = () => {};
  dashboard.authorMenuOpen = true;
  dashboard.contributorQuery = '';

  assert.equal(dashboard.selectedContributor, 'name:lorenzo giannoccaro');
  assert.equal(dashboard.favoriteContributor, 'name:lorenzo giannoccaro');
  dashboard.selectContributor('name:ada');
  dashboard.toggleFavorite('name:ada');
  assert.equal(values.get('gittree.dashboard.selectedContributor'), 'name:ada');
  assert.equal(values.get('gittree.dashboard.favoriteContributor'), 'name:ada');
});

test('dashboard renders a custom contributor menu instead of a native select', () => {
  const dashboard = Object.create(RepositoryDashboard.prototype);
  dashboard.authorMenuOpen = true;
  dashboard.contributorQuery = '';
  dashboard.translate = key => ({
    'dashboard.authorFilter': 'Filter',
    'dashboard.allContributors': 'All contributors',
    'dashboard.searchContributors': 'Search',
    'dashboard.selectFavorite': 'Select favorite',
    'dashboard.setFavorite': 'Set favorite',
    'dashboard.removeFavorite': 'Remove favorite',
    'dashboard.unknownAuthor': 'Unknown',
    'dashboard.noMatchingContributors': 'No matches'
  }[key] || key);
  dashboard.encode = value => String(value);
  dashboard.getLocale = () => 'en';
  dashboard.initials = RepositoryDashboard.prototype.initials;

  const markup = dashboard.authorControl([
    { key: 'name:ada', name: 'Ada', email: 'ada@example.com' }
  ], null, null);

  assert.match(markup, /data-dashboard-author-trigger/);
  assert.match(markup, /data-dashboard-author-search/);
  assert.doesNotMatch(markup, /<select\b/);
});
