const test = require('node:test');
const assert = require('node:assert/strict');

const { registerAiHandlers } = require('../src/main/ipc/ai-handlers.mts');

test('AI handlers validate managed repositories and normalize errors', async () => {
  const registered = new Map();
  const managedCalls = [];
  const wrap = implementation => async (...args) => {
    try {
      return await implementation(...args);
    } catch (error) {
      return { error: error?.message || String(error) };
    }
  };
  const registerHandler = (channel, implementation) => {
    registered.set(channel, wrap(implementation));
  };
  const registerManagedRepoHandler = (channel, implementation) => {
    registered.set(channel, wrap(implementation));
    managedCalls.push(channel);
  };
  const aiService = {
    getSettings: async () => ({ provider: 'opencode' }),
    setSettings: async input => input,
    setKey: async key => ({ keyConfigured: Boolean(key) }),
    clearKey: async () => ({ keyConfigured: false }),
    generateCommitMessage: async (repoPath) => {
      if (repoPath === 'C:\\fail') throw new Error('Provider rejected the request');
      return { summary: 'feat: ai', body: '' };
    },
    explainChanges: async () => ({ summary: 'Auth refactor', body: 'Tokens move behind a service.' }),
    explainConflict: async () => ({ summary: 'Merge both validations', body: 'Keep both checks.' }),
    explainCommit: async () => ({ summary: 'Fixes pagination', body: 'Offset corrected.' }),
    searchHistory: async () => ({ matches: [{ hash: 'abc1234', subject: 'feat: login', reason: 'added login' }] }),
    explainLines: async () => ({ summary: 'Auth history', body: 'Ada built it.' }),
    generatePrDescription: async (repoPath, options) => ({
      summary: options.title || 'PR', body: ''
    })
  };

  registerAiHandlers({ registerHandler, registerManagedRepoHandler, aiService });

  assert.deepEqual(
    managedCalls,
    [
      'ai:commit-message',
      'ai:explain-changes',
      'ai:explain-conflict',
      'ai:explain-commit',
      'ai:history-search',
      'ai:explain-lines',
      'ai:pr-description'
    ]
  );
  assert.equal((await registered.get('ai:settings-get')()).provider, 'opencode');
  assert.equal((await registered.get('ai:key-set')('sk-x')).keyConfigured, true);
  assert.equal((await registered.get('ai:key-clear')()).keyConfigured, false);
  assert.equal(
    (await registered.get('ai:commit-message')('C:\\repo', { language: 'en' })).summary,
    'feat: ai'
  );
  assert.equal(
    (await registered.get('ai:explain-changes')('C:\\repo', { language: 'en' })).summary,
    'Auth refactor'
  );
  assert.equal(
    (await registered.get('ai:explain-conflict')('C:\\repo', { file: 'a.js', blockIndex: 0 })).summary,
    'Merge both validations'
  );
  assert.equal(
    (await registered.get('ai:explain-commit')('C:\\repo', { hash: 'abc1234' })).summary,
    'Fixes pagination'
  );
  assert.equal(
    (await registered.get('ai:history-search')('C:\\repo', { query: 'login' })).matches[0].hash,
    'abc1234'
  );
  assert.equal(
    (await registered.get('ai:explain-lines')('C:\\repo', { file: 'a.js', hash: 'abc1234' })).summary,
    'Auth history'
  );
  assert.equal(
    (await registered.get('ai:pr-description')('C:\\repo', { source: 'a', target: 'b', title: 'T' })).summary,
    'T'
  );

  const errorResult = await registered.get('ai:commit-message')('C:\\fail');
  assert.match(errorResult.error, /Provider rejected the request/);
  assert.equal('summary' in errorResult, false);
});
