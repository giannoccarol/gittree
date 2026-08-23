import * as nodeFs from 'node:fs';
import * as nodePath from 'node:path';

export function defaults() {
  return {
    version: 1,
    settings: {
      provider: 'opencode',
      baseUrl: '',
      model: '',
      language: 'auto'
    }
  };
}

const PROVIDERS = ['opencode', 'openai', 'anthropic'];
const LANGUAGES = ['auto', 'en', 'it'];

export function sanitizeSettings(stored: Record<string, unknown> = {}): AiSettings {
  const initial = defaults().settings;
  const rawBaseUrl = typeof stored.baseUrl === 'string' ? stored.baseUrl.trim() : '';
  const baseUrl = rawBaseUrl.length <= 2048 ? rawBaseUrl : '';
  const provider = typeof stored.provider === 'string'
    && PROVIDERS.includes(stored.provider)
    ? stored.provider
    : initial.provider;
  const model = typeof stored.model === 'string'
    ? stored.model.trim().slice(0, 200)
    : initial.model;
  const language = typeof stored.language === 'string'
    && LANGUAGES.includes(stored.language)
    ? stored.language
    : initial.language;
  return { provider, baseUrl, model, language };
}

type FileSystemLike = typeof nodeFs;

export interface AiSettings {
  provider: string;
  baseUrl: string;
  model: string;
  language: string;
}

export class AiSettingsStore {
  private storagePath: string;

  private fs: FileSystemLike;

  constructor({ storagePath, fileSystem = nodeFs }: { storagePath?: string; fileSystem?: FileSystemLike } = {}) {
    if (!storagePath) throw new Error('AI settings storage path is required');
    this.storagePath = storagePath;
    this.fs = fileSystem;
  }

  load() {
    if (!this.fs.existsSync(this.storagePath)) return defaults();
    try {
      const stored = JSON.parse(this.fs.readFileSync(this.storagePath, 'utf8'));
      return {
        version: 1,
        settings: sanitizeSettings(stored.settings)
      };
    } catch {
      return defaults();
    }
  }

  save(state: ReturnType<typeof defaults>): void {
    const payload = {
      version: 1,
      settings: sanitizeSettings(state.settings)
    };
    const directory = nodePath.dirname(this.storagePath);
    this.fs.mkdirSync(directory, { recursive: true });
    const temporaryPath = `${this.storagePath}.${process.pid}.${Date.now()}.tmp`;
    this.fs.writeFileSync(temporaryPath, `${JSON.stringify(payload, null, 2)}\n`, { mode: 0o600 });
    this.fs.renameSync(temporaryPath, this.storagePath);
  }
}


