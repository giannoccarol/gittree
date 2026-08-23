const test = require('node:test');
const assert = require('node:assert/strict');

const {
  parseAiOutput,
  parseSearchOutput,
  buildCommitPrompt,
  buildPrPrompt,
  buildExplainPrompt,
  buildConflictPrompt,
  buildCommitExplainPrompt,
  buildHistorySearchPrompt,
  buildBlamePrompt
} = require('../src/main/ai/ai-output.mts');

test('parses the strict TITLE/BODY format from provider output', () => {
  const result = parseAiOutput(
    'TITLE: feat(auth): add refresh tokens\nBODY: - issue new tokens on login\n- store them encrypted'
  );
  assert.equal(result.summary, 'feat(auth): add refresh tokens');
  assert.match(result.body, /issue new tokens/);
});

test('parses TITLE without BODY and keeps the remainder out of the body', () => {
  const result = parseAiOutput('TITLE: fix: repair pagination');
  assert.equal(result.summary, 'fix: repair pagination');
  assert.equal(result.body, '');
});

test('falls back to the first line when no TITLE marker exists', () => {
  const result = parseAiOutput('chore: update dependencies\n\nBump versions.');
  assert.equal(result.summary, 'chore: update dependencies');
  assert.equal(result.body, 'Bump versions.');
});

test('rejects empty provider output', () => {
  assert.throws(() => parseAiOutput('   \n  '), /did not return a commit title/);
});

test('truncates long titles and strips surrounding quotes', () => {
  const result = parseAiOutput(`TITLE: "${'x'.repeat(400)}"`, { maxTitleLength: 200 });
  assert.equal(result.summary.length, 200);
  assert.match(result.summary, /x+…$/);
});

test('commit prompt carries the diff, language and optional hint', () => {
  const prompt = buildCommitPrompt({
    diff: '--- a/file\n+++ b/file',
    hint: 'mention the API',
    language: 'it'
  });
  assert.match(prompt, /Write the title and body in Italian/);
  assert.match(prompt, /Additional hint from the user: mention the API/);
  assert.match(prompt, /--- staged diff ---/);
  assert.match(prompt, /\+{3} b\/file/);
});

test('pull request prompt carries commits, diff and language', () => {
  const prompt = buildPrPrompt({
    diff: 'diff body',
    commits: ['feat: first', 'fix: second'],
    language: 'en'
  });
  assert.match(prompt, /Write the pull-request title and description in English/);
  assert.match(prompt, /- feat: first\s*\n- fix: second/);
  assert.match(prompt, /--- diff ---/);
});

test('explain prompt carries the diff, language and the strict format contract', () => {
  const prompt = buildExplainPrompt({
    diff: '--- a/auth.js\n+++ b/auth.js',
    language: 'it'
  });
  assert.match(prompt, /Write the explanation in Italian/);
  assert.match(prompt, /what should be tested/);
  assert.match(prompt, /TITLE: <short heading>\s*\nBODY: <explanation>/);
  assert.match(prompt, /--- changes diff ---/);
  assert.match(prompt, /\+{3} b\/auth\.js/);
});

test('conflict prompt carries the three versions, file and language', () => {
  const prompt = buildConflictPrompt({
    file: 'src/auth.js',
    base: 'base',
    current: 'ours',
    incoming: 'theirs',
    language: 'en'
  });
  assert.match(prompt, /Conflicted file: src\/auth\.js/);
  assert.match(prompt, /Write the explanation in English/);
  assert.match(prompt, /--- base version ---\s*\nbase/);
  assert.match(prompt, /--- current version \(ours\) ---\s*\nours/);
  assert.match(prompt, /--- incoming version \(theirs\) ---\s*\ntheirs/);
  assert.match(prompt, /TITLE: <short summary of the suggested resolution>/);
});

test('conflict prompt marks empty sides explicitly', () => {
  const prompt = buildConflictPrompt({
    file: 'f.txt',
    base: null,
    current: '',
    incoming: 'incoming',
    language: 'it'
  });
  assert.match(prompt, /Write the explanation in Italian/);
  assert.match(prompt, /--- base version ---\s*\n\(empty\)/);
  assert.match(prompt, /--- current version \(ours\) ---\s*\n\(empty\)/);
  assert.match(prompt, /--- incoming version \(theirs\) ---\s*\nincoming/);
});

test('commit explain prompt carries message, author, date and diff', () => {
  const prompt = buildCommitExplainPrompt({
    message: 'fix: repair pagination',
    author: 'Ada',
    date: '2026-08-13',
    diff: '--- a/list.js\n+++ b/list.js',
    language: 'it'
  });
  assert.match(prompt, /Write the explanation in Italian/);
  assert.match(prompt, /Commit: fix: repair pagination/);
  assert.match(prompt, /Author: Ada \(2026-08-13\)/);
  assert.match(prompt, /--- commit diff ---/);
  assert.match(prompt, /\+{3} b\/list\.js/);
  assert.match(prompt, /TITLE: <one-line explanation>/);
});

test('history search prompt carries the question and bounded candidates', () => {
  const prompt = buildHistorySearchPrompt({
    query: 'when did the login bug appear?',
    commits: [
      { hash: 'abc1234', subject: 'feat: login page' },
      { hash: 'def5678', subject: 'fix: session refresh' }
    ],
    language: 'it'
  });
  assert.match(prompt, /Write the reasons in Italian/);
  assert.match(prompt, /Question: when did the login bug appear\?/);
  assert.match(prompt, /abc1234 feat: login page/);
  assert.match(prompt, /def5678 fix: session refresh/);
  assert.match(prompt, /NO MATCHES/);
});

test('search output parser keeps only known candidate hashes', () => {
  const candidates = [
    { hash: 'abc1234', subject: 'feat: login' },
    { hash: 'def5678', subject: 'fix: session' }
  ];
  const matches = parseSearchOutput(
    'HASH: abc1234 — introduced the login form\n'
      + 'HASH: ffffffffffffffffffffffffffffffffffffffff — invented hash\n'
      + 'HASH: def5678 - changed session handling',
    candidates
  );
  assert.deepEqual(matches, [
    { hash: 'abc1234', reason: 'introduced the login form' },
    { hash: 'def5678', reason: 'changed session handling' }
  ]);
});

test('search output parser dedupes hashes and ignores NO MATCHES', () => {
  const candidates = [{ hash: 'abc1234', subject: 'x' }];
  const matches = parseSearchOutput(
    'NO MATCHES\nHASH: abc1234 — first\nHASH: abc1234 — second',
    candidates
  );
  assert.deepEqual(matches, [{ hash: 'abc1234', reason: 'first' }]);
});

test('blame prompt carries the file, commit and bounded blame rows', () => {
  const prompt = buildBlamePrompt({
    file: 'src/auth.js',
    hash: 'abc1234',
    rows: [
      { hash: 'abc1234', author: 'Ada', summary: 'feat: auth' },
      { hash: 'def5678', author: 'Grace', summary: 'fix: tokens' }
    ],
    language: 'en'
  });
  assert.match(prompt, /File: src\/auth\.js/);
  assert.match(prompt, /At commit: abc1234/);
  assert.match(prompt, /Write the explanation in English/);
  assert.match(prompt, /abc1234 Ada feat: auth/);
  assert.match(prompt, /def5678 Grace fix: tokens/);
  assert.match(prompt, /--- blame rows \(hash author summary\) ---/);
  assert.match(prompt, /TITLE: <short narrative title>/);
});
