const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');

const {
  AiService,
  validateSettingsInput,
  validateKey,
  validateBaseUrl
} = require('../src/main/ai/ai-service.mts');

function createVault() {
  const state = { accounts: {} };
  return {
    state,
    getAccount: async provider => state.accounts[provider] || null,
    setAccount: async (provider, account) => { state.accounts[provider] = account; },
    removeAccount: async provider => { delete state.accounts[provider]; }
  };
}

function createFakePty(outputText) {
  const handlers = { data: [], exit: [] };
  const emit = () => {
    for (const listener of handlers.data) listener(outputText);
    for (const listener of handlers.exit) listener({ exitCode: 0 });
  };
  return {
    onData(listener) { handlers.data.push(listener); return { dispose() {} }; },
    onExit(listener) { handlers.exit.push(listener); return { dispose() {} }; },
    kill() {},
    emit
  };
}

function openCodeEvents(lines) {
  return lines.map(text => JSON.stringify({
    type: 'text', part: { type: 'text', text }
  })).join('\n');
}

function spawnOpenCode(received, lines) {
  return (_executable, args) => {
    received.args = args;
    const pty = createFakePty(openCodeEvents(lines));
    setImmediate(() => pty.emit());
    return pty;
  };
}

function createService(t, overrides = {}) {
  const directory = fs.mkdtempSync(path.join(os.tmpdir(), 'gittree-ai-'));
  t.after(() => fs.rmSync(directory, { recursive: true, force: true }));
  const vault = createVault();
  const service = new AiService({
    storagePath: path.join(directory, 'ai-settings.json'),
    vault,
    fetch: overrides.fetch || (async () => {
      throw new Error('fetch should not be called');
    }),
    spawn: overrides.spawn || (() => { throw new Error('spawn should not be called'); }),
    resolveExecutable: overrides.resolveExecutable || (command => `${command}.exe`),
    getStagedDiff: overrides.getStagedDiff || (async () => 'diff --git a/x b/x'),
    getUnstagedDiff: overrides.getUnstagedDiff || (async () => ''),
    getBranchComparison: overrides.getBranchComparison
      || (async () => ({ commits: [{ subject: 'feat: first' }], diff: 'diff body' })),
    getConflictBlock: overrides.getConflictBlock || (async () => null),
    getCommitContext: overrides.getCommitContext || (async () => null),
    getHistoryCandidates: overrides.getHistoryCandidates || (async () => []),
    getBlameRows: overrides.getBlameRows || (async () => [])
  });
  return { directory, vault, service };
}

test('settings validation enforces provider fields and secure base URLs', () => {
  assert.deepEqual(validateSettingsInput({
    provider: 'opencode', language: 'it'
  }), { provider: 'opencode', baseUrl: '', model: '', language: 'it' });
  assert.deepEqual(validateSettingsInput({
    provider: 'openai', baseUrl: 'https://api.deepseek.com/v1', model: 'deepseek-chat'
  }).provider, 'openai');
  assert.throws(
    () => validateSettingsInput({ provider: 'openai', baseUrl: '', model: 'm' }),
    /base URL is required/
  );
  assert.throws(
    () => validateSettingsInput({ provider: 'openai', baseUrl: 'https://x', model: '' }),
    /model is required/
  );
  assert.throws(
    () => validateSettingsInput({ provider: 'openai', baseUrl: 'http://api.example.com', model: 'm' }),
    /HTTPS/
  );
  assert.throws(() => validateSettingsInput({ provider: 'gemini' }), /Unsupported AI provider/);
  assert.doesNotThrow(() => validateBaseUrl('http://127.0.0.1:11434/v1'));
  assert.doesNotThrow(() => validateBaseUrl('http://localhost:1234/v1'));
});

test('key validation rejects short, oversized and multi-line values', () => {
  assert.equal(validateKey('  sk-abc123  '), 'sk-abc123');
  assert.throws(() => validateKey('abc'), /Invalid API key/);
  assert.throws(() => validateKey(`a${'x'.repeat(401)}`), /Invalid API key/);
  assert.throws(() => validateKey('sk-line\nbreak'), /Invalid API key/);
});

test('service stores the key in the vault and never returns it', async t => {
  const { vault, service } = createService(t);
  await service.initialize();
  assert.equal((await service.getSettings()).keyConfigured, false);

  await service.setKey('sk-secret-key');
  assert.equal(vault.state.accounts.ai.apiKey, 'sk-secret-key');
  const settings = await service.getSettings();
  assert.equal(settings.keyConfigured, true);
  assert.equal('apiKey' in settings, false);

  await service.clearKey();
  assert.equal((await service.getSettings()).keyConfigured, false);
});

test('service generates commit messages through the openai-compatible provider', async t => {
  const calls = [];
  const fetch = async (url, options) => {
    calls.push({ url, options });
    return {
      ok: true,
      json: async () => ({
        choices: [{ message: { content: 'TITLE: feat(ai): generate messages\nBODY: powered by the configured provider' } }]
      })
    };
  };
  const { service } = createService(t, { fetch });
  await service.initialize();
  await service.setSettings({
    provider: 'openai', baseUrl: 'https://api.deepseek.com/v1', model: 'deepseek-chat', language: 'en'
  });
  await service.setKey('sk-test');

  const result = await service.generateCommitMessage('C:\\repo', { language: 'it' });
  assert.equal(result.summary, 'feat(ai): generate messages');
  assert.match(result.body, /configured provider/);
  assert.equal(calls.length, 1);
  assert.equal(calls[0].url, 'https://api.deepseek.com/v1/chat/completions');
});

test('service rejects generation without a key for HTTP providers', async t => {
  const { service } = createService(t);
  await service.initialize();
  await service.setSettings({
    provider: 'anthropic', baseUrl: '', model: 'claude-sonnet'
  });
  await assert.rejects(
    () => service.generateCommitMessage('C:\\repo'),
    /API key in Settings/
  );
});

test('service rejects generation without any changes', async t => {
  const { service } = createService(t, {
    getStagedDiff: async () => '',
    getUnstagedDiff: async () => ''
  });
  await service.initialize();
  await service.setKey('sk-test');
  await service.setSettings({
    provider: 'openai', baseUrl: 'https://api.deepseek.com/v1', model: 'm'
  });
  await assert.rejects(
    () => service.generateCommitMessage('C:\\repo'),
    /No changes to generate a commit message from/
  );
});

test('service falls back to the unstaged diff when nothing is staged', async t => {
  const diffs = [];
  const fetch = async (_url, options) => {
    diffs.push(JSON.parse(options.body).messages[0].content);
    return {
      ok: true,
      json: async () => ({
        choices: [{ message: { content: 'TITLE: feat: unstaged\nBODY: from working tree' } }]
      })
    };
  };
  const { service } = createService(t, {
    fetch,
    getStagedDiff: async () => '',
    getUnstagedDiff: async () => 'diff --git a/working b/working'
  });
  await service.initialize();
  await service.setKey('sk-test');
  await service.setSettings({
    provider: 'openai', baseUrl: 'https://api.deepseek.com/v1', model: 'm'
  });

  const result = await service.generateCommitMessage('C:\\repo');
  assert.equal(result.summary, 'feat: unstaged');
  assert.match(diffs[0], /diff --git a\/working/);
});

test('service explains changes through the configured provider', async t => {
  const prompts = [];
  const fetch = async (_url, options) => {
    prompts.push(JSON.parse(options.body).messages[0].content);
    return {
      ok: true,
      json: async () => ({
        choices: [{
          message: {
            content: 'TITLE: Auth refactor\nBODY: Moves token issuance behind a service.\n- Risk: session format change\n- Test: login and refresh flows'
          }
        }]
      })
    };
  };
  const { service } = createService(t, {
    fetch,
    getStagedDiff: async () => 'diff --git a/auth.js b/auth.js'
  });
  await service.initialize();
  await service.setKey('sk-test');
  await service.setSettings({
    provider: 'openai', baseUrl: 'https://api.deepseek.com/v1', model: 'm'
  });

  const result = await service.explainChanges('C:\\repo', { language: 'en' });
  assert.equal(result.summary, 'Auth refactor');
  assert.match(result.body, /token issuance/);
  assert.equal(prompts.length, 1);
  assert.match(prompts[0], /--- changes diff ---/);
  assert.match(prompts[0], /diff --git a\/auth\.js/);
});

test('service explains the unstaged diff when nothing is staged', async t => {
  const prompts = [];
  const fetch = async (_url, options) => {
    prompts.push(JSON.parse(options.body).messages[0].content);
    return {
      ok: true,
      json: async () => ({
        choices: [{ message: { content: 'TITLE: working tree\nBODY: unstaged' } }]
      })
    };
  };
  const { service } = createService(t, {
    fetch,
    getStagedDiff: async () => '',
    getUnstagedDiff: async () => 'diff --git a/working b/working'
  });
  await service.initialize();
  await service.setKey('sk-test');
  await service.setSettings({
    provider: 'openai', baseUrl: 'https://api.deepseek.com/v1', model: 'm'
  });

  const result = await service.explainChanges('C:\\repo');
  assert.equal(result.summary, 'working tree');
  assert.match(prompts[0], /diff --git a\/working/);
});

test('service rejects explaining an empty working tree', async t => {
  const { service } = createService(t, {
    getStagedDiff: async () => '',
    getUnstagedDiff: async () => ''
  });
  await service.initialize();
  await service.setKey('sk-test');
  await service.setSettings({
    provider: 'openai', baseUrl: 'https://api.deepseek.com/v1', model: 'm'
  });
  await assert.rejects(
    () => service.explainChanges('C:\\repo'),
    /No changes to explain/
  );
});

test('service prefers the staged diff over the unstaged one', async t => {
  let prompt = '';
  const fetch = async (_url, options) => {
    prompt = JSON.parse(options.body).messages[0].content;
    return { ok: true, json: async () => ({ choices: [{ message: { content: 'TITLE: t\nBODY: b' } }] }) };
  };
  const { service } = createService(t, {
    fetch,
    getStagedDiff: async () => 'diff --git a/staged b/staged',
    getUnstagedDiff: async () => 'diff --git a/unstaged b/unstaged'
  });
  await service.initialize();
  await service.setKey('sk-test');
  await service.setSettings({
    provider: 'openai', baseUrl: 'https://api.deepseek.com/v1', model: 'm'
  });

  await service.generateCommitMessage('C:\\repo');
  assert.match(prompt, /a\/staged/);
  assert.doesNotMatch(prompt, /a\/unstaged/);
});

test('service generates through the opencode CLI and uses its own config', async t => {
  const received = {};
  const { service } = createService(t, {
    spawn: spawnOpenCode(received, ['TITLE: feat: cli', 'BODY: from opencode'])
  });
  await service.initialize();
  assert.equal((await service.getSettings()).provider, 'opencode');

  const result = await service.generateCommitMessage('C:\\repo');
  assert.equal(result.summary, 'feat: cli');
  assert.equal(received.args.includes('--model'), false);
});

test('service passes an explicit model override to the opencode CLI', async t => {
  const received = {};
  const { service } = createService(t, {
    spawn: spawnOpenCode(received, ['TITLE: feat: model', 'BODY: done'])
  });
  await service.initialize();
  await service.setSettings({
    provider: 'opencode', baseUrl: '', model: 'opencode-go/deepseek-v4-pro', language: 'auto'
  });

  await service.generateCommitMessage('C:\\repo');
  assert.equal(received.args.includes('--model'), true);
  assert.equal(
    received.args[received.args.indexOf('--model') + 1],
    'opencode-go/deepseek-v4-pro'
  );
});

test('service reports missing opencode executable', async t => {
  const { service } = createService(t, { resolveExecutable: () => null });
  await service.initialize();
  await assert.rejects(
    () => service.generateCommitMessage('C:\\repo'),
    /OpenCode CLI not found/
  );
});

test('service builds pull request descriptions from the branch comparison', async t => {
  const fetch = async () => ({
    ok: true,
    json: async () => ({
      choices: [{ message: { content: 'TITLE: Add branch compare\nBODY: compares feature against main' } }]
    })
  });
  const { service } = createService(t, { fetch });
  await service.initialize();
  await service.setKey('sk-test');
  await service.setSettings({
    provider: 'openai', baseUrl: 'https://api.deepseek.com/v1', model: 'm'
  });

  const result = await service.generatePrDescription('C:\\repo', {
    source: 'feature', target: 'main', language: 'en'
  });
  assert.equal(result.summary, 'Add branch compare');
  await assert.rejects(
    () => service.generatePrDescription('C:\\repo', { source: 'main', target: 'main' }),
    /Invalid source and target branches/
  );
});

test('service exports the configured key as agent CLI environment', async t => {
  const { service } = createService(t);
  await service.initialize();
  await service.setSettings({
    provider: 'openai', baseUrl: 'https://api.deepseek.com/v1', model: 'm'
  });
  await service.setKey('sk-deep');
  assert.deepEqual(service.getAgentEnvironment(), { DEEPSEEK_API_KEY: 'sk-deep' });

  await service.setSettings({
    provider: 'anthropic', baseUrl: '', model: 'claude-sonnet'
  });
  assert.deepEqual(service.getAgentEnvironment(), { ANTHROPIC_API_KEY: 'sk-deep' });

  await service.clearKey();
  assert.deepEqual(service.getAgentEnvironment(), {});
});

test('service caps oversized diffs in the prompt', async t => {
  let prompt = '';
  const fetch = async (_url, options) => {
    prompt = JSON.parse(options.body).messages[0].content;
    return { ok: true, json: async () => ({ choices: [{ message: { content: 'TITLE: t\nBODY: b' } }] }) };
  };
  const bigDiff = 'x'.repeat(30 * 1024);
  const { service } = createService(t, { fetch, getStagedDiff: async () => bigDiff });
  await service.initialize();
  await service.setKey('sk-test');
  await service.setSettings({ provider: 'openai', baseUrl: 'https://api.deepseek.com/v1', model: 'm' });

  await service.generateCommitMessage('C:\\repo');
  assert.ok(prompt.length < 24 * 1024 + 2048);
  assert.match(prompt, /diff truncated/);
});

test('service explains a conflict block through the configured provider', async t => {
  const prompts = [];
  const fetch = async (_url, options) => {
    prompts.push(JSON.parse(options.body).messages[0].content);
    return {
      ok: true,
      json: async () => ({
        choices: [{
          message: { content: 'TITLE: Keep both validations\nBODY: The sides guard different inputs.\n- Suggested: retain both checks' }
        }]
      })
    };
  };
  const { service } = createService(t, {
    fetch,
    getConflictBlock: async (repoPath, file, blockIndex) => {
      assert.equal(repoPath, 'C:\\repo');
      assert.equal(file, 'src/auth.js');
      assert.equal(blockIndex, 2);
      return {
        file: 'src/auth.js',
        base: 'base code',
        current: 'ours code',
        incoming: 'theirs code'
      };
    }
  });
  await service.initialize();
  await service.setKey('sk-test');
  await service.setSettings({
    provider: 'openai', baseUrl: 'https://api.deepseek.com/v1', model: 'm'
  });

  const result = await service.explainConflict('C:\\repo', {
    file: 'src/auth.js',
    blockIndex: 2,
    language: 'it'
  });
  assert.equal(result.summary, 'Keep both validations');
  assert.match(result.body, /retain both checks/);
  assert.equal(prompts.length, 1);
  assert.match(prompts[0], /Conflicted file: src\/auth\.js/);
  assert.match(prompts[0], /--- current version \(ours\) ---\s*\nours code/);
  assert.match(prompts[0], /Write the explanation in Italian/);
});

test('service rejects invalid conflict block requests before prompting', async t => {
  const { service } = createService(t);
  await service.initialize();
  await service.setKey('sk-test');
  await service.setSettings({
    provider: 'openai', baseUrl: 'https://api.deepseek.com/v1', model: 'm'
  });
  await assert.rejects(
    () => service.explainConflict('C:\\repo', { file: '', blockIndex: 0 }),
    /Invalid conflict block/
  );
  await assert.rejects(
    () => service.explainConflict('C:\\repo', { file: 'a.js', blockIndex: -1 }),
    /Invalid conflict block/
  );
  await assert.rejects(
    () => service.explainConflict('C:\\repo', { file: 'a.js', blockIndex: 1.5 }),
    /Invalid conflict block/
  );
});

test('service rejects explaining a missing conflict block', async t => {
  const { service } = createService(t);
  await service.initialize();
  await service.setKey('sk-test');
  await service.setSettings({
    provider: 'openai', baseUrl: 'https://api.deepseek.com/v1', model: 'm'
  });
  await assert.rejects(
    () => service.explainConflict('C:\\repo', { file: 'a.js', blockIndex: 0 }),
    /Conflict block not found/
  );
});

test('service explains a commit through the configured provider', async t => {
  const prompts = [];
  const fetch = async (_url, options) => {
    prompts.push(JSON.parse(options.body).messages[0].content);
    return {
      ok: true,
      json: async () => ({
        choices: [{
          message: { content: 'TITLE: Fixes list pagination\nBODY: Corrects the offset calculation.\n- Risk: none\n- Test: paging beyond 100 items' }
        }]
      })
    };
  };
  const { service } = createService(t, {
    fetch,
    getCommitContext: async (repoPath, hash) => {
      assert.equal(repoPath, 'C:\\repo');
      assert.equal(hash, 'abc1234');
      return {
        message: 'fix: repair pagination',
        author: 'Ada',
        date: '2026-08-13',
        diff: '--- a/list.js\n+++ b/list.js'
      };
    }
  });
  await service.initialize();
  await service.setKey('sk-test');
  await service.setSettings({
    provider: 'openai', baseUrl: 'https://api.deepseek.com/v1', model: 'm'
  });

  const result = await service.explainCommit('C:\\repo', { hash: 'abc1234', language: 'it' });
  assert.equal(result.summary, 'Fixes list pagination');
  assert.match(result.body, /offset calculation/);
  assert.equal(prompts.length, 1);
  assert.match(prompts[0], /Commit: fix: repair pagination/);
  assert.match(prompts[0], /--- commit diff ---/);
  assert.match(prompts[0], /Write the explanation in Italian/);
});

test('service rejects invalid hashes and unknown commits before prompting', async t => {
  const { service } = createService(t);
  await service.initialize();
  await service.setKey('sk-test');
  await service.setSettings({
    provider: 'openai', baseUrl: 'https://api.deepseek.com/v1', model: 'm'
  });
  await assert.rejects(
    () => service.explainCommit('C:\\repo', { hash: 'not;safe' }),
    /Invalid commit hash/
  );
  await assert.rejects(
    () => service.explainCommit('C:\\repo', { hash: 'abcdef0' }),
    /Commit not found/
  );
});

test('service searches history through the configured provider', async t => {
  const prompts = [];
  const fetch = async (_url, options) => {
    prompts.push(JSON.parse(options.body).messages[0].content);
    return {
      ok: true,
      json: async () => ({
        choices: [{
          message: {
            content: 'HASH: abc1234 — introduced the login form\nHASH: def5678 — changed session handling'
          }
        }]
      })
    };
  };
  const { service } = createService(t, {
    fetch,
    getHistoryCandidates: async (repoPath, maxCount) => {
      assert.equal(repoPath, 'C:\\repo');
      assert.equal(maxCount, 300);
      return [
        { hash: 'abc1234', subject: 'feat: login page' },
        { hash: 'def5678', subject: 'fix: session refresh' }
      ];
    }
  });
  await service.initialize();
  await service.setKey('sk-test');
  await service.setSettings({
    provider: 'openai', baseUrl: 'https://api.deepseek.com/v1', model: 'm'
  });

  const result = await service.searchHistory('C:\\repo', {
    query: 'when did the login bug appear?',
    language: 'en'
  });
  assert.deepEqual(result.matches, [
    { hash: 'abc1234', subject: 'feat: login page', reason: 'introduced the login form' },
    { hash: 'def5678', subject: 'fix: session refresh', reason: 'changed session handling' }
  ]);
  assert.equal(prompts.length, 1);
  assert.match(prompts[0], /Question: when did the login bug appear\?/);
  assert.match(prompts[0], /--- candidate commits ---/);
});

test('service returns no matches without history candidates or a provider round', async t => {
  const { service } = createService(t);
  await service.initialize();
  await service.setKey('sk-test');
  await service.setSettings({
    provider: 'openai', baseUrl: 'https://api.deepseek.com/v1', model: 'm'
  });
  const result = await service.searchHistory('C:\\repo', { query: 'any question here' });
  assert.deepEqual(result.matches, []);
});

test('service rejects too-short history search questions', async t => {
  const { service } = createService(t);
  await service.initialize();
  await service.setKey('sk-test');
  await service.setSettings({
    provider: 'openai', baseUrl: 'https://api.deepseek.com/v1', model: 'm'
  });
  await assert.rejects(
    () => service.searchHistory('C:\\repo', { query: 'ab' }),
    /longer search question/
  );
});

test('service narrates file history from blame rows', async t => {
  const prompts = [];
  const fetch = async (_url, options) => {
    prompts.push(JSON.parse(options.body).messages[0].content);
    return {
      ok: true,
      json: async () => ({
        choices: [{
          message: { content: 'TITLE: Auth file history\nBODY: Ada built the module, Grace fixed tokens.' }
        }]
      })
    };
  };
  const { service } = createService(t, {
    fetch,
    getBlameRows: async (repoPath, file, hash) => {
      assert.equal(repoPath, 'C:\\repo');
      assert.equal(file, 'src/auth.js');
      assert.equal(hash, 'abc1234');
      return [
        { hash: 'abc1234', author: 'Ada', summary: 'feat: auth' },
        { hash: 'def5678', author: 'Grace', summary: 'fix: tokens' }
      ];
    }
  });
  await service.initialize();
  await service.setKey('sk-test');
  await service.setSettings({
    provider: 'openai', baseUrl: 'https://api.deepseek.com/v1', model: 'm'
  });

  const result = await service.explainLines('C:\\repo', {
    file: 'src/auth.js',
    hash: 'abc1234',
    language: 'it'
  });
  assert.equal(result.summary, 'Auth file history');
  assert.match(result.body, /Grace fixed tokens/);
  assert.equal(prompts.length, 1);
  assert.match(prompts[0], /File: src\/auth\.js/);
  assert.match(prompts[0], /abc1234 Ada feat: auth/);
  assert.match(prompts[0], /Write the explanation in Italian/);
});

test('service rejects invalid blame requests and empty blame rows', async t => {
  const { service } = createService(t);
  await service.initialize();
  await service.setKey('sk-test');
  await service.setSettings({
    provider: 'openai', baseUrl: 'https://api.deepseek.com/v1', model: 'm'
  });
  await assert.rejects(
    () => service.explainLines('C:\\repo', { file: '', hash: 'abc1234' }),
    /Invalid file or commit hash/
  );
  await assert.rejects(
    () => service.explainLines('C:\\repo', { file: 'a.js', hash: 'bad;hash' }),
    /Invalid file or commit hash/
  );
  await assert.rejects(
    () => service.explainLines('C:\\repo', { file: 'a.js', hash: 'abc1234' }),
    /No blame information for this file/
  );
});
