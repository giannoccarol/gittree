const test = require('node:test');
const assert = require('node:assert/strict');
const {
  AUTHENTICATION_HINT,
  describeNetworkError,
  isAuthenticationFailure,
  stripTransportNoise
} = require('../src/main/git/network-error.mts');

const POST_QUANTUM_BANNER = [
  '** WARNING: connection is not using a post-quantum key exchange algorithm.',
  '** This session may be vulnerable to "store now, decrypt later" attacks.',
  '** The server may need to be upgraded. See https://openssh.com/pq.html'
].join('\n');

test('OpenSSH post-quantum banner is removed from git errors', () => {
  const message = `${POST_QUANTUM_BANNER}\nfatal: couldn't find remote ref feature/missing`;

  assert.equal(stripTransportNoise(message), "fatal: couldn't find remote ref feature/missing");
  assert.equal(
    describeNetworkError('Failed to fetch', new Error(message)),
    "Failed to fetch: fatal: couldn't find remote ref feature/missing"
  );
});

test('credential failures get an actionable hint', () => {
  const https = "fatal: could not read Username for 'https://github.com': No such device or address";
  const ssh = `${POST_QUANTUM_BANNER}\ngit@ssh.dev.azure.com: Permission denied (publickey).\nfatal: Could not read from remote repository.`;

  assert.equal(isAuthenticationFailure(https), true);
  assert.equal(isAuthenticationFailure('fatal: terminal prompts disabled'), true);
  assert.equal(isAuthenticationFailure("fatal: Autenticazione non riuscita per 'https://dev.azure.com/org/'"), true);
  assert.equal(
    describeNetworkError('Failed to pull', new Error(https)),
    `Failed to pull: ${https}\n${AUTHENTICATION_HINT}`
  );
  const described = describeNetworkError('Failed to fetch', new Error(ssh));
  assert.doesNotMatch(described, /post-quantum/);
  assert.match(described, /Permission denied \(publickey\)/);
  assert.ok(described.endsWith(AUTHENTICATION_HINT));
});

test('ordinary failures keep their original text without a credential hint', () => {
  const message = 'fatal: Need to specify how to reconcile divergent branches.';

  assert.equal(isAuthenticationFailure(message), false);
  assert.equal(describeNetworkError('Failed to pull', message), `Failed to pull: ${message}`);
});
