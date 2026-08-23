const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const { CredentialVault } = require('../src/main/credential-vault.mts');

function fakeSafeStorage(backend = 'kwallet') {
  return {
    isEncryptionAvailable: () => true,
    getSelectedStorageBackend: () => backend,
    encryptString: value => Buffer.from(
      Buffer.from(value, 'utf8').toString('base64').split('').reverse().join(''),
      'utf8'
    ),
    decryptString: buffer => Buffer.from(
      buffer.toString('utf8').split('').reverse().join(''),
      'base64'
    ).toString('utf8')
  };
}

test('persists encrypted provider accounts and review drafts without plaintext tokens', async t => {
  const directory = fs.mkdtempSync(path.join(os.tmpdir(), 'gittree-vault-'));
  t.after(() => fs.rmSync(directory, { recursive: true, force: true }));
  const storagePath = path.join(directory, 'hosting-vault.bin');
  const vault = new CredentialVault({
    storagePath,
    safeStorage: fakeSafeStorage(),
    platform: 'win32'
  });

  await vault.setAccount('github', {
    accessToken: 'secret-access-token',
    user: { login: 'octocat' }
  });
  await vault.saveReviewDraft('github:owner/repo:42:abc', {
    headSha: 'abc',
    body: 'review body'
  });

  const bytes = fs.readFileSync(storagePath, 'utf8');
  assert.doesNotMatch(bytes, /secret-access-token|review body/);
  const reopened = new CredentialVault({
    storagePath,
    safeStorage: fakeSafeStorage(),
    platform: 'win32'
  });
  assert.equal((await reopened.getAccount('github')).accessToken, 'secret-access-token');
  assert.equal(
    (await reopened.getReviewDraft('github:owner/repo:42:abc')).body,
    'review body'
  );
});

test('Linux basic_text backend keeps credentials in memory only and reports a warning', async t => {
  const directory = fs.mkdtempSync(path.join(os.tmpdir(), 'gittree-vault-'));
  t.after(() => fs.rmSync(directory, { recursive: true, force: true }));
  const storagePath = path.join(directory, 'hosting-vault.bin');
  const vault = new CredentialVault({
    storagePath,
    safeStorage: fakeSafeStorage('basic_text'),
    platform: 'linux'
  });

  await vault.setAccount('gitlab', { accessToken: 'memory-token' });
  assert.equal((await vault.getAccount('gitlab')).accessToken, 'memory-token');
  assert.equal(fs.existsSync(storagePath), false);
  assert.equal(vault.getSecurityState().memoryOnly, true);
});

test('AI provider accounts use the encrypted vault and reject unknown providers', async t => {
  const directory = fs.mkdtempSync(path.join(os.tmpdir(), 'gittree-vault-'));
  t.after(() => fs.rmSync(directory, { recursive: true, force: true }));
  const storagePath = path.join(directory, 'hosting-vault.bin');
  const vault = new CredentialVault({
    storagePath,
    safeStorage: fakeSafeStorage(),
    platform: 'win32'
  });

  await vault.setAccount('ai', { apiKey: 'sk-encrypted-secret' });
  assert.equal((await vault.getAccount('ai')).apiKey, 'sk-encrypted-secret');
  const bytes = fs.readFileSync(storagePath, 'utf8');
  assert.doesNotMatch(bytes, /sk-encrypted-secret/);

  await vault.removeAccount('ai');
  assert.equal(await vault.getAccount('ai'), null);
  await assert.rejects(
    () => vault.setAccount('openrouter', { apiKey: 'x' }),
    /Unsupported provider/
  );
});
