import { AiSettingsStore, type AiSettings } from './ai-store.mts';
import type { CommitCandidate } from './ai-output.mts';
import {
  parseAiOutput,
  parseSearchOutput,
  buildCommitPrompt,
  buildPrPrompt,
  buildExplainPrompt,
  buildConflictPrompt,
  buildCommitExplainPrompt,
  buildHistorySearchPrompt,
  buildBlamePrompt
} from './ai-output.mts';
import { requestOpenAiCompatible, requestAnthropic } from './ai-providers.mts';
import { generateWithOpencode } from './ai-opencode.mts';
import { environmentForAi } from './ai-env.mts';

const PROVIDERS = ['opencode', 'openai', 'anthropic'];
const LANGUAGES = ['auto', 'en', 'it'];
const DIFF_LIMIT = 24 * 1024;
const DEFAULT_TIMEouts = { http: 60_000, opencode: 120_000 };

const LOOPBACK_HOSTS = new Set(['127.0.0.1', 'localhost', '[::1]', '::1']);

export function validateBaseUrl(value: unknown): URL {
  let parsed;
  try {
    parsed = new URL(String(value));
  } catch {
    throw new Error('Invalid AI base URL');
  }
  const https = parsed.protocol === 'https:';
  const loopback = parsed.protocol === 'http:'
    && LOOPBACK_HOSTS.has(parsed.hostname);
  if (!https && !loopback) {
    throw new Error('The AI base URL must use HTTPS (or HTTP on localhost)');
  }
  return parsed;
}

export function validateKey(value: unknown): string {
  const key = String(value ?? '').trim();
  if (key.length < 4 || key.length > 400 || /[\r\n\0]/.test(key)) {
    throw new Error('Invalid API key');
  }
  return key;
}

export function validateSettingsInput(input: Record<string, unknown> = {}): AiSettings {
  const provider = String(input.provider || '');
  if (!PROVIDERS.includes(provider)) throw new Error('Unsupported AI provider');
  const language = LANGUAGES.includes(input.language as string) ? (input.language as string) : 'auto';
  const baseUrl = String(input.baseUrl || '').trim();
  const model = String(input.model || '').trim().slice(0, 200);
  if (provider === 'openai') {
    if (!baseUrl) throw new Error('A base URL is required for this provider');
    validateBaseUrl(baseUrl);
    if (!model) throw new Error('A model is required for this provider');
  }
  if (provider === 'anthropic' && !model) {
    throw new Error('A model is required for this provider');
  }
  return { provider, baseUrl, model, language };
}

function truncateDiff(diff: unknown): string {
  const text = String(diff || '');
  if (text.length <= DIFF_LIMIT) return text;
  return `${text.slice(0, DIFF_LIMIT)}\n\n... diff truncated ...`;
}

export interface AiVault {
  getAccount: (provider: string) => Promise<{ apiKey?: string } | null>;
  setAccount: (provider: string, account: Record<string, unknown>) => Promise<unknown>;
  removeAccount?: (provider: string) => Promise<unknown>;
}

export class AiService {
  private store: AiSettingsStore;

  private vault: AiVault;

  private fetch: typeof globalThis.fetch;

  private spawn: (
    executable: string,
    args: string[],
    options: Record<string, unknown>
  ) => { onData: (cb: (data: string) => void) => void; onExit: (cb: (e: { exitCode: number }) => void) => void; kill?: () => void };

  private resolveExecutable: (command: string) => string;

  private getStagedDiff: (repoPath: string) => Promise<string>;

  private getUnstagedDiff: (repoPath: string) => Promise<string>;

  private getBranchComparison: (repoPath: string, base: string, compare: string) => Promise<{ commits?: Array<Record<string, unknown>>; diff?: string }>;

  private getConflictBlock: (repoPath: string, file: string, blockIndex: number) => Promise<Record<string, unknown> | null>;

  private getCommitContext: (repoPath: string, hash: string) => Promise<Record<string, unknown> | null>;

  private getHistoryCandidates: (repoPath: string, limit: number) => Promise<Array<Record<string, unknown>>>;

  private getBlameRows: (repoPath: string, file: string, hash: string) => Promise<Array<Record<string, unknown>>>;

  private timeouts: { http: number; opencode: number };

  settings: AiSettings;

  agentEnvironment: Record<string, string>;

  keyConfigured: boolean;

  constructor({
    storagePath,
    vault,
    fetch,
    spawn,
    resolveExecutable,
    getStagedDiff = async () => '',
    getUnstagedDiff = async () => '',
    getBranchComparison = async () => ({ commits: [], diff: '' }),
    getConflictBlock = async () => null,
    getCommitContext = async () => null,
    getHistoryCandidates = async () => [],
    getBlameRows = async () => [],
    timeouts = DEFAULT_TIMEouts
  }: {
    storagePath: string;
    vault: AiVault;
    fetch: typeof globalThis.fetch;
    spawn: AiService['spawn'];
    resolveExecutable?: (command: string) => string;
    getStagedDiff?: (repoPath: string) => Promise<string>;
    getUnstagedDiff?: (repoPath: string) => Promise<string>;
    getBranchComparison?: (repoPath: string, base: string, compare: string) => Promise<{ commits?: Array<Record<string, unknown>>; diff?: string }>;
    getConflictBlock?: (repoPath: string, file: string, blockIndex: number) => Promise<Record<string, unknown> | null>;
    getCommitContext?: (repoPath: string, hash: string) => Promise<Record<string, unknown> | null>;
    getHistoryCandidates?: (repoPath: string, limit: number) => Promise<Array<Record<string, unknown>>>;
    getBlameRows?: (repoPath: string, file: string, hash: string) => Promise<Array<Record<string, unknown>>>;
    timeouts?: { http?: number; opencode?: number };
  }) {
    if (!storagePath) throw new Error('AI settings storage path is required');
    if (!vault) throw new Error('Credential vault is required');
    if (!fetch) throw new Error('Fetch is required');
    if (!spawn) throw new Error('PTY spawn is required');
    this.store = new AiSettingsStore({ storagePath });
    this.vault = vault;
    this.fetch = fetch;
    this.spawn = spawn;
    this.resolveExecutable = resolveExecutable || (command => command);
    this.getStagedDiff = getStagedDiff;
    this.getUnstagedDiff = getUnstagedDiff;
    this.getBranchComparison = getBranchComparison;
    this.getConflictBlock = getConflictBlock;
    this.getCommitContext = getCommitContext;
    this.getHistoryCandidates = getHistoryCandidates;
    this.getBlameRows = getBlameRows;
    this.timeouts = { ...DEFAULT_TIMEouts, ...(timeouts || {}) };
    const restored = this.store.load();
    this.settings = restored.settings;
    this.agentEnvironment = {};
    this.keyConfigured = false;
  }

  async initialize() {
    const account = await this.vault.getAccount('ai');
    this.keyConfigured = Boolean(account?.apiKey);
    this.agentEnvironment = environmentForAi({
      provider: this.settings.provider,
      baseUrl: this.settings.baseUrl,
      apiKey: account?.apiKey || ''
    });
  }

  async getSettings() {
    return {
      ...this.settings,
      keyConfigured: this.keyConfigured
    };
  }

  async setSettings(input: Record<string, unknown>): Promise<Record<string, unknown>> {
    const settings = validateSettingsInput(input);
    this.settings = settings;
    this.store.save({ settings } as Parameters<typeof this.store.save>[0]);
    const account = await this.vault.getAccount('ai');
    this.agentEnvironment = environmentForAi({
      provider: settings.provider,
      baseUrl: settings.baseUrl,
      apiKey: account?.apiKey || ''
    });
    return this.getSettings();
  }

  async setKey(key: unknown): Promise<Record<string, unknown>> {
    const apiKey = validateKey(key);
    await this.vault.setAccount('ai', { apiKey });
    this.keyConfigured = true;
    this.agentEnvironment = environmentForAi({
      provider: this.settings.provider,
      baseUrl: this.settings.baseUrl,
      apiKey
    });
    return { keyConfigured: true };
  }

  async clearKey(): Promise<Record<string, unknown>> {
    await this.vault.removeAccount?.('ai');
    this.keyConfigured = false;
    this.agentEnvironment = environmentForAi({
      provider: this.settings.provider,
      baseUrl: this.settings.baseUrl,
      apiKey: ''
    });
    return { keyConfigured: false };
  }

  getAgentEnvironment() {
    return { ...this.agentEnvironment };
  }

  async apiKey() {
    const account = await this.vault.getAccount('ai');
    return account?.apiKey || '';
  }

  normalizeLanguage(value: unknown): string {
    const language = String(value || '');
    if (language === 'it' || language === 'en') return language;
    if (this.settings.language === 'it' || this.settings.language === 'en') {
      return this.settings.language;
    }
    return 'en';
  }

  async generateCommitMessage(repoPath: string, options: { language?: unknown; hint?: unknown } = {}) {
    const staged = await this.getStagedDiff(repoPath);
    let diff = String(staged || '');
    if (!diff.trim()) {
      diff = String(await this.getUnstagedDiff(repoPath) || '');
    }
    if (!diff.trim()) {
      throw new Error('No changes to generate a commit message from');
    }
    const language = this.normalizeLanguage(options.language);
    const prompt = buildCommitPrompt({
      diff: truncateDiff(diff),
      hint: String(options.hint || '').slice(0, 500),
      language
    });
    const raw = await this.runProvider(prompt);
    return parseAiOutput(raw);
  }

  async explainChanges(repoPath: string, options: { language?: unknown } = {}) {
    const staged = await this.getStagedDiff(repoPath);
    let diff = String(staged || '');
    if (!diff.trim()) {
      diff = String(await this.getUnstagedDiff(repoPath) || '');
    }
    if (!diff.trim()) {
      throw new Error('No changes to explain');
    }
    const language = this.normalizeLanguage(options.language);
    const prompt = buildExplainPrompt({
      diff: truncateDiff(diff),
      language
    });
    const raw = await this.runProvider(prompt);
    return parseAiOutput(raw, { maxTitleLength: 140 });
  }

  async explainConflict(repoPath: string, options: { file?: unknown; blockIndex?: unknown; language?: unknown } = {}) {
    const file = String(options.file || '').trim();
    const blockIndex = Number(options.blockIndex);
    if (
      !file ||
      file.length > 500 ||
      !Number.isInteger(blockIndex) ||
      blockIndex < 0 ||
      blockIndex > 500
    ) {
      throw new Error('Invalid conflict block');
    }
    const block = await this.getConflictBlock(repoPath, file, blockIndex);
    if (!block) throw new Error('Conflict block not found');
    const language: string = this.normalizeLanguage(String(options.language));
    const prompt = buildConflictPrompt({
      file: String(block.file || file),
      base: truncateDiff(block.base || ''),
      current: truncateDiff(block.current || ''),
      incoming: truncateDiff(block.incoming || ''),
      language
    });
    const raw = await this.runProvider(prompt);
    return parseAiOutput(raw, { maxTitleLength: 200 });
  }

  async explainCommit(repoPath: string, options: { hash?: unknown; language?: unknown } = {}) {
    const hash = String(options.hash || '').trim();
    if (!/^[0-9a-f]{7,40}$/i.test(hash)) {
      throw new Error('Invalid commit hash');
    }
    const context = await this.getCommitContext(repoPath, hash);
    if (!context) throw new Error('Commit not found');
    const language = this.normalizeLanguage(options.language);
    const prompt = buildCommitExplainPrompt({
      message: String(context.message || '').slice(0, 2000),
      author: String(context.author || '').slice(0, 200),
      date: String(context.date || '').slice(0, 100),
      diff: truncateDiff(context.diff || ''),
      language
    });
    const raw = await this.runProvider(prompt);
    return parseAiOutput(raw, { maxTitleLength: 200 });
  }

  async searchHistory(repoPath: string, options: { query?: unknown; language?: unknown } = {}) {
    const query = String(options.query || '').trim().slice(0, 300);
    if (query.length < 3) {
      throw new Error('Enter a longer search question');
    }
    const candidates = (await this.getHistoryCandidates(repoPath, 300) || [])
      .map(candidate => ({
        hash: String(candidate.hash || '').toLowerCase(),
        subject: String(candidate.subject || '').slice(0, 500)
      }))
      .filter(candidate => /^[0-9a-f]{7,40}$/i.test(candidate.hash));
    if (!candidates.length) return { matches: [] };
    const language = this.normalizeLanguage(options.language);
    const prompt = buildHistorySearchPrompt({ query, commits: candidates, language });
    const raw = await this.runProvider(prompt);
    const found = parseSearchOutput(raw, candidates);
    const byHash = new Map(candidates.map(candidate => [candidate.hash, candidate]));
    return {
      matches: found.map(match => ({
        hash: match.hash,
        subject: byHash.get(match.hash)?.subject || match.hash,
        reason: match.reason
      }))
    };
  }

  async explainLines(repoPath: string, options: { file?: unknown; hash?: unknown; language?: unknown } = {}) {
    const file = String(options.file || '').trim();
    const hash = String(options.hash || '').trim();
    if (!file || file.length > 500 || !/^[0-9a-f]{7,40}$/i.test(hash)) {
      throw new Error('Invalid file or commit hash');
    }
    const rows = (await this.getBlameRows(repoPath, file, hash) || [])
      .slice(0, 200)
      .map(row => ({
        hash: String(row.hash || '').slice(0, 12),
        author: String(row.author || '').slice(0, 100),
        summary: String(row.summary || '').slice(0, 300)
      }))
      .filter(row => row.hash);
    if (!rows.length) throw new Error('No blame information for this file');
    const language = this.normalizeLanguage(options.language);
    const prompt = buildBlamePrompt({ file, hash, rows, language });
    const raw = await this.runProvider(prompt);
    return parseAiOutput(raw, { maxTitleLength: 200 });
  }

  async generatePrDescription(repoPath: string, options: { source?: unknown; target?: unknown; hint?: unknown; language?: unknown } = {}) {
    const source = String(options.source || '').trim();
    const target = String(options.target || '').trim();
    if (!source || !target || source === target) {
      throw new Error('Invalid source and target branches');
    }
    const comparison = await this.getBranchComparison(repoPath, target, source);
    const commits = (comparison?.commits || [])
      .map(commit => String(commit?.subject || commit?.message || '').split('\n')[0].trim())
      .filter(Boolean);
    const language = this.normalizeLanguage(String(options.language));
    const prompt = buildPrPrompt({
      diff: truncateDiff(String(comparison?.diff || '')),
      commits: commits.map(c => ({ message: String(c) } as unknown as CommitCandidate)),
      hint: String(options.hint || '').slice(0, 500),
      language
    });
    const raw = await this.runProvider(prompt);
    return parseAiOutput(raw, { maxTitleLength: 256 });
  }

  async testConnection() {
    const raw = await this.runProvider('Reply with exactly: OK');
    return { ok: true, reply: String(raw).trim().slice(0, 120) };
  }

  async runProvider(prompt: string): Promise<string> {
    if (this.settings.provider === 'opencode') {
      const executable = this.resolveExecutable('opencode');
      if (!executable) throw new Error('OpenCode CLI not found');
      return generateWithOpencode({
        spawn: this.spawn,
        executable,
        prompt,
        model: this.settings.model || '',
        timeoutMs: this.timeouts.opencode
      });
    }
    const apiKey = await this.apiKey();
    if (!apiKey) throw new Error('Configure the AI API key in Settings first');
    if (this.settings.provider === 'anthropic') {
      return requestAnthropic({
        fetch: this.fetch,
        apiKey,
        model: this.settings.model,
        prompt,
        timeoutMs: this.timeouts.http
      });
    }
    return requestOpenAiCompatible({
      fetch: this.fetch,
      baseUrl: this.settings.baseUrl,
      apiKey,
      model: this.settings.model,
      prompt,
      timeoutMs: this.timeouts.http
    });
  }
}


