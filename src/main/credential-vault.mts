import * as fs from 'node:fs';
import * as path from 'node:path';

export interface SafeStorage {
  isEncryptionAvailable?: () => boolean;
  getSelectedStorageBackend?: () => string;
  decryptString?: (encrypted: Buffer) => string;
  encryptString?: (plaintext: string) => Buffer;
}

export interface CredentialVaultOptions {
  storagePath: string;
  safeStorage?: SafeStorage;
  platform?: string;
}

export class CredentialVault {
  storagePath: string;
  safeStorage?: SafeStorage;
  platform: string;
  state: { accounts: Record<string, unknown>; reviewDrafts: Record<string, unknown> };
  loaded: boolean;
  loading: Promise<void> | null;
  writeQueue: Promise<void>;

  constructor(options: CredentialVaultOptions) {
    this.storagePath = options.storagePath;
    this.safeStorage = options.safeStorage;
    this.platform = options.platform || process.platform;
    this.state = { accounts: {}, reviewDrafts: {} };
    this.loaded = false;
    this.loading = null;
    this.writeQueue = Promise.resolve();
  }

  getSecurityState(): { encryptionAvailable: boolean; backend: string; memoryOnly: boolean; warning: string } {
    const encryptionAvailable = Boolean(this.safeStorage?.isEncryptionAvailable?.());
    let backend = '';
    try {
      backend = this.safeStorage?.getSelectedStorageBackend?.() || '';
    } catch { /* backend detection is best effort */ }
    const memoryOnly =
      !encryptionAvailable ||
      (this.platform === 'linux' && backend === 'basic_text');
    return {
      encryptionAvailable,
      backend,
      memoryOnly,
      warning: memoryOnly
        ? 'Secure OS encryption is unavailable; credentials are kept in memory only'
        : ''
    };
  }

  validateProvider(provider: unknown): string {
    if (!['github', 'gitlab', 'azure', 'ai'].includes(provider as string)) {
      throw new Error(`Unsupported provider: ${provider}`);
    }
    return provider as string;
  }

  async ensureLoaded(): Promise<void> {
    if (this.loaded) return;
    if (this.loading) return this.loading;
    this.loading = (async () => {
      if (!this.getSecurityState().memoryOnly) {
        try {
          const encrypted = await fs.promises.readFile(this.storagePath);
          const plaintext = this.safeStorage!.decryptString!(encrypted);
          const parsed = JSON.parse(plaintext);
          this.state = {
            accounts: parsed.accounts && typeof parsed.accounts === 'object'
              ? parsed.accounts
              : {},
            reviewDrafts: parsed.reviewDrafts && typeof parsed.reviewDrafts === 'object'
              ? parsed.reviewDrafts
              : {}
          };
        } catch (error) {
          if ((error as NodeJS.ErrnoException).code !== 'ENOENT') {
            throw new Error('The encrypted hosting vault could not be read', { cause: error });
          }
        }
      }
      this.loaded = true;
    })().finally(() => {
      this.loading = null;
    });
    return this.loading;
  }

  async reset(): Promise<{ success: true }> {
    this.state = { accounts: {}, reviewDrafts: {} };
    this.loaded = true;
    try {
      await fs.promises.rm(this.storagePath, { force: true });
    } catch { /* vault file may already be gone */ }
    this.writeQueue = Promise.resolve();
    return { success: true };
  }

  async persist(): Promise<void> {
    if (this.getSecurityState().memoryOnly) return;
    const plaintext = JSON.stringify(this.state);
    const encrypted = this.safeStorage!.encryptString!(plaintext);
    const directory = path.dirname(this.storagePath);
    const temporaryPath = `${this.storagePath}.tmp`;
    this.writeQueue = this.writeQueue
      .catch(() => {})
      .then(async () => {
        await fs.promises.mkdir(directory, { recursive: true });
        await fs.promises.writeFile(temporaryPath, encrypted, { mode: 0o600 });
        await fs.promises.rename(temporaryPath, this.storagePath);
      });
    return this.writeQueue;
  }

  async getAccount(provider: unknown): Promise<unknown | null> {
    await this.ensureLoaded();
    return this.state.accounts[this.validateProvider(provider)] || null;
  }

  async setAccount(provider: unknown, account: unknown): Promise<void> {
    await this.ensureLoaded();
    this.state.accounts[this.validateProvider(provider)] = account;
    await this.persist();
  }

  async removeAccount(provider: unknown): Promise<void> {
    await this.ensureLoaded();
    delete this.state.accounts[this.validateProvider(provider)];
    await this.persist();
  }

  validateDraftKey(key: unknown): string {
    if (
      typeof key !== 'string' ||
      key.length < 3 ||
      key.length > 1000 ||
      /[\r\n\0]/.test(key)
    ) {
      throw new Error('Invalid review draft key');
    }
    return key;
  }

  async getReviewDraft(key: unknown): Promise<unknown | null> {
    await this.ensureLoaded();
    return this.state.reviewDrafts[this.validateDraftKey(key)] || null;
  }

  async saveReviewDraft(key: unknown, draft: unknown): Promise<void> {
    await this.ensureLoaded();
    this.state.reviewDrafts[this.validateDraftKey(key)] = draft;
    await this.persist();
  }

  async removeReviewDraft(key: unknown): Promise<void> {
    await this.ensureLoaded();
    delete this.state.reviewDrafts[this.validateDraftKey(key)];
    await this.persist();
  }

  async removeProviderDrafts(provider: unknown): Promise<void> {
    await this.ensureLoaded();
    const prefix = `${this.validateProvider(provider)}:`;
    let removed = false;
    for (const key of Object.keys(this.state.reviewDrafts)) {
      if (key.startsWith(prefix)) {
        delete this.state.reviewDrafts[key];
        removed = true;
      }
    }
    if (removed) await this.persist();
  }
}
