import * as crypto from 'node:crypto';
import * as fs from 'node:fs';
import * as os from 'node:os';
import * as path from 'node:path';
import AdmZip from 'adm-zip';
import type { UpdateState } from './update-service.mts';
import type { Logger } from './logger.mts';
import type { GitVersionInfo } from './git-version.mts';

export function escapeRegularExpression(value: string): string {
  return value.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
}

export function redactText(value: unknown, repositoryPaths: string[] = []): string {
  let redacted = String(value || '');
  for (const repositoryPath of repositoryPaths.filter(Boolean)) {
    redacted = redacted.replace(
      new RegExp(escapeRegularExpression(repositoryPath), 'gi'),
      '[REDACTED_PATH]'
    );
  }
  return redacted
    .replace(/https?:\/\/[^\s"']+/gi, '[REDACTED_URL]')
    .replace(/\b(?:ghp|gho|glpat|pat)[-_A-Za-z0-9]{8,}\b/g, '[REDACTED_TOKEN]')
    .replace(/\bsk-(?:ant-)?[A-Za-z0-9_-]{8,}\b/g, '[REDACTED_TOKEN]')
    .replace(/(authorization[=:]\s*)[^\s,;]+/gi, '$1[REDACTED_TOKEN]')
    .replace(/(x-api-key[=:]\s*)[^\s,;]+/gi, '$1[REDACTED_TOKEN]')
    .replace(/(token[=:]\s*)[^\s,;]+/gi, '$1[REDACTED_TOKEN]')
    .replace(/\b[A-Za-z]:\\[^\r\n\t"']+/g, '[REDACTED_PATH]')
    .replace(/(^|[\s"'=])\/(?:Users|home|tmp|var|private|opt)\/[^\s,"']+/g, '$1[REDACTED_PATH]');
}

export function repositoryIdentifier(repositoryPath: unknown): string {
  return crypto.createHash('sha256').update(String(repositoryPath)).digest('hex').slice(0, 16);
}

export function safeJson(value: unknown, repositoryPaths: string[]): Record<string, unknown> {
  return JSON.parse(redactText(JSON.stringify(value || {}), repositoryPaths));
}

interface VersionsInfo {
  app?: string;
  electron?: string | null;
  git?: string;
  [key: string]: unknown;
}

interface SystemInfo {
  platform?: string;
  arch?: string;
  release?: string;
  [key: string]: unknown;
}

export function buildDiagnosticsData({
  versions,
  system,
  updateState,
  repositories = [],
  logs = '',
  checks = {}
}: {
  versions: VersionsInfo;
  system: SystemInfo;
  updateState: UpdateState | null;
  repositories?: Array<{ path?: string }>;
  logs?: string;
  checks?: Record<string, unknown>;
}) {
  const repositoryPaths = repositories.map(repository => repository.path).filter(Boolean) as string[];
  return {
    summary: {
      versions: { ...versions },
      system: { ...system },
      updateState: safeJson({
        status: updateState?.status || 'unknown',
        currentVersion: updateState?.currentVersion || versions.app,
        availableVersion: updateState?.availableVersion || null,
        progress: Number(updateState?.progress) || 0
      }, repositoryPaths),
      repositoryCount: repositories.length,
      repositories: repositories.map(repository => ({
        id: repositoryIdentifier(repository.path)
      }))
    },
    logs: redactText(logs, repositoryPaths),
    checks: safeJson(checks, repositoryPaths)
  };
}

function readLogs(logger?: { file?: string }): string {
  if (!logger?.file) return '';
  return [logger.file, `${logger.file}.1`]
    .filter(filename => fs.existsSync(filename))
    .map(filename => fs.readFileSync(filename, 'utf8').slice(-1_000_000))
    .join('\n');
}

interface DiagnosticsAppLike {
  isPackaged: boolean;
  getPath(name: 'userData' | 'temp' | 'logs'): string;
  getVersion(): string;
}

interface SaveDialogResult {
  canceled: boolean;
  filePath?: string;
}

export interface DiagnosticsExporterOptions {
  app: DiagnosticsAppLike;
  showSaveDialog: (options: Record<string, unknown>) => Promise<SaveDialogResult>;
  logger: Logger & { file?: string };
  getGitVersion: () => Promise<GitVersionInfo>;
  getUpdateState: () => UpdateState;
  getRepositories: () => Array<{ path?: string }>;
  getChecks?: () => Record<string, unknown>;
}

export class DiagnosticsExporter {
  app: DiagnosticsAppLike;
  showSaveDialog: (options: Record<string, unknown>) => Promise<SaveDialogResult>;
  logger: Logger & { file?: string };
  getGitVersion: () => Promise<GitVersionInfo>;
  getUpdateState: () => UpdateState;
  getRepositories: () => Array<{ path?: string }>;
  getChecks: () => Record<string, unknown>;

  constructor({
    app,
    showSaveDialog,
    logger,
    getGitVersion,
    getUpdateState,
    getRepositories,
    getChecks = () => ({ quality: 'not-run-in-app' })
  }: DiagnosticsExporterOptions) {
    this.app = app;
    this.showSaveDialog = showSaveDialog;
    this.logger = logger;
    this.getGitVersion = getGitVersion;
    this.getUpdateState = getUpdateState;
    this.getRepositories = getRepositories;
    this.getChecks = getChecks;
  }

  async export(): Promise<{ success?: true; canceled?: true }> {
    const date = new Date().toISOString().slice(0, 10);
    const result = await this.showSaveDialog({
      title: 'Export GitTree diagnostics',
      defaultPath: `GitTree-diagnostics-${date}.zip`,
      filters: [{ name: 'ZIP archive', extensions: ['zip'] }]
    });
    if (result.canceled || !result.filePath) return { canceled: true };
    const diagnostics = buildDiagnosticsData({
      versions: {
        app: this.app.getVersion(),
        electron: process.versions.electron || null,
        node: process.versions.node,
        git: (await this.getGitVersion()).version
      },
      system: { platform: os.platform(), release: os.release(), arch: os.arch() },
      updateState: this.getUpdateState(),
      repositories: this.getRepositories(),
      logs: readLogs(this.logger),
      checks: this.getChecks()
    });
    const zip = new AdmZip();
    zip.addFile('summary.json', Buffer.from(JSON.stringify(diagnostics.summary, null, 2)));
    zip.addFile('logs.txt', Buffer.from(diagnostics.logs));
    zip.addFile('checks.json', Buffer.from(JSON.stringify(diagnostics.checks, null, 2)));
    await fs.promises.mkdir(path.dirname(result.filePath), { recursive: true });
    await new Promise<void>((resolve, reject) => {
      zip.writeZip(result.filePath, error => (error ? reject(error) : resolve()));
    });
    return { success: true };
  }
}
