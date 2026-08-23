import * as nodeFs from 'node:fs';
import * as nodePath from 'node:path';

const ACTIVE_STATUSES = new Set(['queued', 'preparing', 'running', 'stopping']);
const MAX_EVENTS = 200;

export interface AgentStoreState {
  version: number;
  settings: {
    agentsEnabled: boolean;
    worktreeRoot: string;
    maxConcurrent: number;
    enabledAdapters: string[];
  };
  tasks: Array<Record<string, unknown>>;
}

export function defaults(): AgentStoreState {
  return {
    version: 1,
    settings: {
      agentsEnabled: true,
      worktreeRoot: '',
      maxConcurrent: 4,
      enabledAdapters: ['codex', 'claude', 'opencode']
    },
    tasks: []
  };
}

export function sanitizeTask(
  task: Record<string, unknown>,
  { restore = false }: { restore?: boolean } = {}
): Record<string, unknown> {
  const clean = { ...task };
  delete clean.prompt;
  delete clean._prompt;
  delete clean._resume;
  clean.events = Array.isArray(clean.events) ? clean.events.slice(-MAX_EVENTS) : [];
  if (restore && typeof clean.status === 'string' && ACTIVE_STATUSES.has(clean.status)) {
    clean.status = 'interrupted';
  }
  return clean;
}

type FileSystemLike = typeof nodeFs;

export class AgentSessionStore {
  private storagePath: string;

  private fs: FileSystemLike;

  constructor({ storagePath, fileSystem = nodeFs }: { storagePath?: string; fileSystem?: FileSystemLike } = {}) {
    if (!storagePath) throw new Error('Agent session storage path is required');
    this.storagePath = storagePath;
    this.fs = fileSystem;
  }

  load() {
    if (!this.fs.existsSync(this.storagePath)) return defaults();
    try {
      const stored = JSON.parse(this.fs.readFileSync(this.storagePath, 'utf8'));
      const initial = defaults();
      return {
        version: 1,
        settings: {
          ...initial.settings,
          ...(stored.settings || {}),
          maxConcurrent: Number.isInteger(stored.settings?.maxConcurrent)
            ? Math.min(32, Math.max(1, stored.settings.maxConcurrent))
            : initial.settings.maxConcurrent,
          enabledAdapters: Array.isArray(stored.settings?.enabledAdapters)
            ? (stored.settings.enabledAdapters as unknown[]).filter((id): id is string => ['codex', 'claude', 'opencode'].includes(String(id)))
            : initial.settings.enabledAdapters
        },
        tasks: Array.isArray(stored.tasks)
          ? stored.tasks.map((task: Record<string, unknown>) => sanitizeTask(task, { restore: true }))
          : []
      };
    } catch {
      return defaults();
    }
  }

  save(state: AgentStoreState) {
    const payload = {
      version: 1,
      settings: { ...defaults().settings, ...(state.settings || {}) },
      tasks: Array.isArray(state.tasks) ? state.tasks.map(task => sanitizeTask(task)) : []
    };
    const directory = nodePath.dirname(this.storagePath);
    this.fs.mkdirSync(directory, { recursive: true });
    const temporaryPath = `${this.storagePath}.${process.pid}.${Date.now()}.tmp`;
    this.fs.writeFileSync(temporaryPath, `${JSON.stringify(payload, null, 2)}\n`, { mode: 0o600 });
    this.fs.renameSync(temporaryPath, this.storagePath);
  }
}


