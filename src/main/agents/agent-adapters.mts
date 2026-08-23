import { execFile } from 'node:child_process';
import * as fs from 'node:fs';
import * as nodePath from 'node:path';

export interface AgentAdapter {
  id: string;
  label: string;
  command: string;
  createArgs: (prompt: string) => string[];
  resumeArgs: () => string[];
}

export const ADAPTERS: Readonly<Record<string, Readonly<AgentAdapter>>> = Object.freeze({
  codex: Object.freeze({
    id: 'codex', label: 'Codex', command: 'codex',
    createArgs: (prompt: string): string[] => [prompt], resumeArgs: (): string[] => ['resume', '--last']
  }),
  claude: Object.freeze({
    id: 'claude', label: 'Claude Code', command: 'claude',
    createArgs: (prompt: string): string[] => [prompt], resumeArgs: (): string[] => ['--continue']
  }),
  opencode: Object.freeze({
    id: 'opencode', label: 'OpenCode', command: 'opencode',
    createArgs: (prompt: string): string[] => ['--prompt', prompt], resumeArgs: (): string[] => ['--continue']
  })
});

export function getAdapter(id: string): AgentAdapter {
  const adapter = ADAPTERS[id];
  if (!adapter) throw new Error('Unknown agent adapter');
  return adapter;
}

type FileSystemLike = typeof fs;

function accessibleFile(
  candidate: string | undefined,
  fileSystem: FileSystemLike,
  mode: number
): boolean {
  if (!candidate) return false;
  try {
    fileSystem.accessSync(candidate, mode);
    return fileSystem.statSync(candidate).isFile();
  } catch {
    return false;
  }
}

function windowsAdapterFallbacks(
  command: string,
  environment: NodeJS.ProcessEnv,
  fileSystem: FileSystemLike,
  pathModule: typeof nodePath
): string[] {
  const candidates = [];
  if (command === 'opencode' && environment.APPDATA) {
    candidates.push(pathModule.join(
      environment.APPDATA,
      'npm',
      'node_modules',
      'opencode-ai',
      'bin',
      'opencode.exe'
    ));
  }
  if (command === 'codex' && environment.LOCALAPPDATA) {
    const runtimeRoot = pathModule.join(environment.LOCALAPPDATA, 'OpenAI', 'Codex', 'bin');
    try {
      const runtimeCandidates = fileSystem.readdirSync(runtimeRoot, { withFileTypes: true })
        .filter(entry => entry.isDirectory())
        .map(entry => pathModule.join(runtimeRoot, entry.name, 'codex.exe'))
        .filter(candidate => accessibleFile(candidate, fileSystem, fileSystem.constants.F_OK))
        .sort((left, right) => (
          fileSystem.statSync(right).mtimeMs - fileSystem.statSync(left).mtimeMs
        ));
      candidates.push(...runtimeCandidates);
    } catch { /* Codex Desktop is not installed */ }
  }
  return candidates;
}

export function resolveAgentExecutable(command: string, {
  environment = process.env,
  platform = process.platform,
  fileSystem = fs,
  pathModule = nodePath
}: {
  environment?: NodeJS.ProcessEnv;
  platform?: NodeJS.Platform;
  fileSystem?: FileSystemLike;
  pathModule?: typeof nodePath;
} = {}): string | null {
  const searchPath = environment.PATH || environment.Path || '';
  const extensions = platform === 'win32' ? ['.exe', '.com'] : [''];
  const directCandidates = [];
  for (const directory of searchPath.split(pathModule.delimiter).filter(Boolean)) {
    for (const extension of extensions) {
      directCandidates.push(pathModule.join(
        directory.replace(/^"|"$/g, ''),
        `${command}${extension}`
      ));
    }
  }
  const mode = platform === 'win32' ? fileSystem.constants.F_OK : fileSystem.constants.X_OK;
  const availableDirect = directCandidates.filter(candidate => accessibleFile(
    candidate, fileSystem, mode
  ));
  if (platform !== 'win32') return availableDirect[0] || null;

  const unrestricted = availableDirect.filter(candidate => {
    const normalized = candidate.toLowerCase();
    return !normalized.includes('\\program files\\windowsapps\\')
      && !normalized.includes('\\resources\\');
  });
  const fallbacks = windowsAdapterFallbacks(command, environment, fileSystem, pathModule);
  return unrestricted[0] || fallbacks[0] || availableDirect[0] || null;
}

export function detectAgentAdapters({
  execute = execFile,
  resolveExecutable = resolveAgentExecutable
}: {
  execute?: typeof execFile;
  resolveExecutable?: (command: string) => string | null;
} = {}) {
  return Promise.all(Object.values(ADAPTERS).map(adapter => new Promise(resolve => {
    const executable = resolveExecutable(adapter.command);
    if (!executable) {
      resolve({ id: adapter.id, label: adapter.label, available: false, version: '' });
      return;
    }
    try {
      execute(executable, ['--version'], { windowsHide: true, timeout: 3000 }, (
        error, stdout, stderr
      ) => {
        const started = !error || typeof error.code === 'number';
        const version = error
          ? ''
          : String(stdout || stderr || '').trim().split(/\r?\n/, 1)[0].slice(0, 120);
        resolve({
          id: adapter.id,
          label: adapter.label,
          available: started,
          version
        });
      });
    } catch {
      resolve({ id: adapter.id, label: adapter.label, available: false, version: '' });
    }
  })));
}

