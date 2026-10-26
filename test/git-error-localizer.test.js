const test = require('node:test');
const assert = require('node:assert/strict');
const { localizeGitError } = require('../src/renderer/git-error-localizer.mts');
const { NetworkTimeoutError } = require('../src/main/git/remote-transport.mts');

function recordingTranslate() {
  const calls = [];
  const translate = (key, options) => {
    calls.push([key, options]);
    return `translated:${key}`;
  };
  return { calls, translate };
}

test('localizes the network timeout produced by the main process', () => {
  for (const command of ['git fetch', 'git pull', 'git push', 'git ls-remote']) {
    const { calls, translate } = recordingTranslate();
    const envelope = { error: `Failed to sync: ${new NetworkTimeoutError(command, 300).message}` };

    assert.equal(localizeGitError(envelope.error, translate), 'translated:errors.networkTimeout');
    assert.deepEqual(calls, [['errors.networkTimeout', { command, seconds: 300 }]]);
  }
});

test('returns every other error unchanged', () => {
  const { calls, translate } = recordingTranslate();
  const message = 'Failed to push: ! [rejected] main -> main (fetch first)';

  assert.equal(localizeGitError(message, translate), message);
  assert.deepEqual(calls, []);
});
