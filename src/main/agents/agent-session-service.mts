import type { SetupRecipe } from './setup-recipes.mts';
import type { AgentStoreState } from './agent-session-store.mts';
import * as fs from 'node:fs';
import * as nodePath from 'node:path';
import * as nodeCrypto from 'node:crypto';
import { AgentSessionStore } from './agent-session-store.mts';
import { getAdapter, detectAgentAdapters, resolveAgentExecutable } from './agent-adapters.mts';
import { detectSetupRecipe } from './setup-recipes.mts';

export const ACTIVE_STATUSES = new Set(['queued', 'preparing', 'running', 'stopping']);
const TERMINAL_INPUT_LIMIT = 16_384;

function canonical(value: string, pathModule: typeof nodePath = nodePath) {
  return pathModule.resolve(value).replace(/[\\/]+$/, '').toLowerCase();
}

function inside(
  parent: string,
  child: string,
  pathModule: typeof nodePath = nodePath
) {
  const relative = pathModule.relative(pathModule.resolve(parent), pathModule.resolve(child));
  return relative === '' || (!relative.startsWith('..') && !pathModule.isAbsolute(relative));
}

export function slugify(value: unknown): string {
  return String(value || '')
    .normalize('NFKD')
    .replace(/[\u0300-\u036f]/g, '')
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, '-')
    .replace(/^-+|-+$/g, '')
    .slice(0, 48) || 'task';
}

function publicTask(task: AgentTask): Record<string, unknown> {
  const clean = { ...task };
  delete clean._prompt;
  delete clean._resume;
  return JSON.parse(JSON.stringify(clean));
}

interface PtyProcess {
  onData: (callback: (data: string) => void) => { dispose?: () => void };
  onExit: (callback: (event: { exitCode: number }) => void) => void;
  kill?: () => void;
  write?: (data: string) => void;
  resize?: (cols: number, rows: number) => void;
}

interface AgentTask extends Record<string, unknown> {
  id?: string;
  status?: string;
  worktreePath?: string;
  repositoryPath?: string;
  branch?: string;
}

interface PtyDataSubscription {
  dispose?(): void;
}

interface IPtyLike {
  onData(listener: (data: string) => void): PtyDataSubscription;
  onExit(listener: (event: { exitCode?: number; signal?: number | undefined }) => void): unknown;
}

interface ActiveProcess {
  [key: string]: unknown;
}

export class AgentSessionService {
  private repositoryWorkspace: {
    list: () => Array<{ path: string }>;
    getGitService: (repositoryPath: string) => {
      getWorktrees: () => Promise<Array<{ path: string; branch?: string }>>;
      createManagedWorktree: (options: Record<string, unknown>) => Promise<unknown>;
      getStatus: () => Promise<{ files?: Array<unknown>; ahead?: number; behind?: number }>;
    };
    addTrustedRepository: (path: string) => unknown;
    [key: string]: unknown;
  };

  private createPty: (
    command: string,
    args: string[],
    options: Record<string, unknown>
  ) => PtyProcess;

  private emit: (event: string, payload: unknown) => void;

  private idFactory: () => string;

  private now: () => string;

  private nowMs: () => number;

  private adapterDetectionTtl: number;

  private adapterDetection: { timestamp: number; result: unknown } | null;

  private fs: typeof fs;

  private path: typeof nodePath;

  private execute: typeof import("node:child_process").execFile | undefined;

  private extraEnv: () => Record<string, string>;

  private resolveExecutable: (command: string) => string | null;

  private store: AgentSessionStore;

  settings: {
    agentsEnabled: boolean;
    worktreeRoot: string;
    maxConcurrent: number;
    enabledAdapters: string[];
    [key: string]: unknown;
  };

  tasks: Map<string, AgentTask>;

  queue: string[];

  active: Map<string, ActiveProcess>;

  shuttingDown: boolean;

  private clearInterval: (timer: unknown) => void;

  private pollTimer: unknown;

  constructor({
    storagePath,
    repositoryWorkspace,
    createPty,
    emit = () => {},
    idFactory = () => nodeCrypto.randomUUID(),
    now = () => new Date().toISOString(),
    nowMs = () => Date.now(),
    adapterDetectionTtl = 60_000,
    setInterval: setIntervalFn = ((fn: () => void, ms?: number) => setInterval(fn, ms)) as typeof setInterval,
    clearInterval: clearIntervalFn = (timer => clearInterval(timer as ReturnType<typeof setInterval>)) as (timer: unknown) => void,
    fileSystem = fs,
    pathModule = nodePath,
    execute,
    extraEnv = () => ({}),
    resolveExecutable = resolveAgentExecutable
  }: {
    storagePath?: string;
    repositoryWorkspace?: {
      list: () => Array<{ path: string }>;
      getGitService: (repositoryPath: string) => {
        getWorktrees: () => Promise<Array<{ path: string; branch?: string }>>;
        createManagedWorktree: (options: Record<string, unknown>) => Promise<unknown>;
        getStatus: () => Promise<{ files?: Array<unknown>; ahead?: number; behind?: number }>;
      };
      addTrustedRepository: (path: string) => unknown;
      [key: string]: unknown;
    };
    createPty?: (command: string, args: string[], options: Record<string, unknown>) => PtyProcess;
    emit?: (event: string, payload: unknown) => void;
    idFactory?: () => string;
    now?: () => string;
    nowMs?: () => number;
    adapterDetectionTtl?: number;
    setInterval?: (handler: () => void, timeout: number) => unknown;
    clearInterval?: (timer: unknown) => void;
    fileSystem?: typeof fs;
    pathModule?: typeof nodePath;
    execute?: typeof import("node:child_process").execFile;
    extraEnv?: () => Record<string, string>;
    resolveExecutable?: (command: string) => string | null;
  } = {}) {
    if (!repositoryWorkspace) throw new Error('Repository workspace is required');
    if (typeof createPty !== 'function') throw new Error('PTY factory is required');
    this.repositoryWorkspace = repositoryWorkspace;
    this.createPty = createPty;
    this.emit = emit;
    this.idFactory = idFactory;
    this.now = now;
    this.nowMs = nowMs;
    this.adapterDetectionTtl = adapterDetectionTtl;
    this.adapterDetection = null;
    this.fs = fileSystem;
    this.path = pathModule;
    this.execute = execute;
    this.extraEnv = extraEnv;
    this.resolveExecutable = resolveExecutable;
    this.store = new AgentSessionStore({ storagePath, fileSystem });
    const restored = this.store.load();
    this.settings = restored.settings;
    this.tasks = new Map(
      restored.tasks.map((task: Record<string, unknown>): [string, AgentTask] => [
        String(task.id), task as AgentTask
      ])
    );
    this.queue = [];
    this.active = new Map();
    this.shuttingDown = false;
    this.clearInterval = clearIntervalFn;
    this.pollTimer = setIntervalFn(() => this._pollGit().catch(() => {}), 3000);
  }

  getSettings() {
    return { ...this.settings, enabledAdapters: [...this.settings.enabledAdapters] };
  }

  setWorktreeRoot(root: unknown): Record<string, unknown> {
    if (typeof root !== 'string' || !this.path.isAbsolute(root) || !this.fs.existsSync(root)) {
      throw new Error('Worktree root must be an existing absolute directory');
    }
    for (const repository of this.repositoryWorkspace.list()) {
      if (inside(repository.path, root, this.path)) {
        throw new Error('Worktree root cannot be inside a registered repository');
      }
    }
    this.settings.worktreeRoot = this.path.resolve(root);
    this._persist();
    return this.getSettings();
  }

  setConcurrency(value: unknown): Record<string, unknown> {
    const concurrency = Number(value);
    if (!Number.isInteger(concurrency) || concurrency < 1 || concurrency > 32) {
      throw new Error('Agent concurrency must be an integer between 1 and 32');
    }
    this.settings.maxConcurrent = concurrency;
    this._persist();
    this._drain();
    return this.getSettings();
  }

  setAgentsEnabled(enabled: unknown): Record<string, unknown> {
    if (typeof enabled !== 'boolean') throw new Error('Agent sessions enabled state must be boolean');
    if (!enabled && this.getActiveCount() > 0) {
      throw new Error('Stop active or queued agents before disabling agent sessions');
    }
    this.settings.agentsEnabled = enabled;
    this._persist();
    return this.getSettings();
  }

  setEnabledAdapters(adapterIds: unknown): Record<string, unknown> {
    if (!Array.isArray(adapterIds) || adapterIds.length > 3) throw new Error('Invalid agent adapter list');
    const unique = [...new Set(adapterIds.map(id => String(id)))];
    unique.forEach(id => getAdapter(id));
    this.settings.enabledAdapters = unique;
    this._persist();
    return this.getSettings();
  }

  async detectAdapters() {
    const timestamp = this.nowMs();
    if (this.adapterDetection
      && timestamp - this.adapterDetection.timestamp < this.adapterDetectionTtl) {
      return this.adapterDetection.result;
    }
    const result = detectAgentAdapters({
      execute: this.execute,
      resolveExecutable: this.resolveExecutable
    }).catch(error => {
      this.adapterDetection = null;
      throw error;
    });
    this.adapterDetection = { timestamp, result };
    return result;
  }

  listTasks(repositoryPath?: string): Array<Record<string, unknown>> {
    let repositoryKey = repositoryPath ? canonical(repositoryPath, this.path) : '';
    if (repositoryKey) {
      const linkedTask = [...this.tasks.values()].find(task => (
        canonical(String(task.worktreePath), this.path) === repositoryKey
      ));
      if (linkedTask) repositoryKey = canonical(String(linkedTask.repositoryPath), this.path);
    }
    const tasks = [...this.tasks.values()]
      .filter(task => !repositoryKey || canonical(String(task.repositoryPath), this.path) === repositoryKey)
      .sort((a, b) => String(b.updatedAt).localeCompare(String(a.updatedAt)));
    return tasks.map(publicTask);
  }

  getTask(taskId: string): Record<string, unknown> {
    const task = this.tasks.get(taskId);
    if (!task) throw new Error('Unknown agent task');
    return publicTask(task);
  }

  getActiveCount() {
    return [...this.tasks.values()].filter(task => ACTIVE_STATUSES.has(String(task.status))).length;
  }

  assertWorktreeRemovable(worktreePath: string): boolean {
    const target = canonical(worktreePath, this.path);
    const active = [...this.tasks.values()].find(task => (
      ACTIVE_STATUSES.has(String(task.status)) && canonical(String(String(task.worktreePath)), this.path) === target
    ));
    if (active) throw new Error('Stop the active agent before removing this worktree');
    return true;
  }

  async createTask(repositoryPath: string, options: Record<string, unknown> = {}) {
    this._assertAgentsEnabled();
    this._validateRepository(repositoryPath);
    const input = this._validateTaskOptions(options);
    if (!this.settings.worktreeRoot) throw new Error('Choose an agent worktree root first');
    const id = this.idFactory();
    const shortId = id.replace(/-/g, '').slice(-6);
    const slug = slugify(input.title);
    const branch = input.branch || `agent/${slug}-${shortId}`;
    this._validateBranch(String(branch));
    const repositoryDirectory = slugify(this.path.basename(repositoryPath));
    const authorizedDestination = typeof options.authorizedDestination === 'string'
      ? options.authorizedDestination
      : null;
    const worktreePath = authorizedDestination
      ? this.path.resolve(authorizedDestination)
      : this.path.join(this.settings.worktreeRoot, repositoryDirectory, `${slug}-${shortId}`);
    if (!this.path.isAbsolute(worktreePath) || /[\0\r\n]/.test(worktreePath)) {
      throw new Error('Invalid worktree destination');
    }
    if (this.repositoryWorkspace.list().some(repository => inside(repository.path, worktreePath, this.path))) {
      throw new Error('Worktree destination cannot be inside a registered repository');
    }
    this.fs.mkdirSync(this.path.dirname(worktreePath), { recursive: true });
    const git = this.repositoryWorkspace.getGitService(repositoryPath);
    await git.createManagedWorktree({
      directory: worktreePath,
      branch,
      baseRef: input.baseRef || 'HEAD',
      createBranch: input.createBranch !== false
    });
    this.repositoryWorkspace.addTrustedRepository(worktreePath);
    return this._createTaskRecord({
      id, repositoryPath, worktreePath, branch,
      baseRef: input.baseRef || 'HEAD', ...input
    });
  }

  async createTaskForWorktree(repositoryPath: string, worktreePath: string, options: Record<string, unknown> = {}) {
    this._assertAgentsEnabled();
    this._validateRepository(repositoryPath);
    const input = this._validateTaskOptions(options);
    const resolvedWorktree = this.path.resolve(worktreePath);
    const worktrees = await this.repositoryWorkspace.getGitService(repositoryPath).getWorktrees();
    const found = worktrees.find(item => canonical(item.path, this.path) === canonical(resolvedWorktree, this.path));
    if (!found) throw new Error('Worktree does not belong to the registered repository');
    const isMain = canonical(resolvedWorktree, this.path) === canonical(repositoryPath, this.path);
    if (isMain && input.allowMain !== true) throw new Error('Starting an agent in the main worktree requires confirmation');
    this.repositoryWorkspace.addTrustedRepository(resolvedWorktree);
    return this._createTaskRecord({
      id: this.idFactory(), repositoryPath, worktreePath: resolvedWorktree,
      branch: found.branch || '', baseRef: found.branch || 'HEAD', ...input
    });
  }

  _createTaskRecord(input: Record<string, unknown>) {
    this._assertWorktreeAvailable(String(input.worktreePath) as string);
    const timestamp = this.now();
    const task = {
      id: String(input.id),
      repositoryPath: this.path.resolve(String(String(input.repositoryPath))),
      worktreePath: this.path.resolve(String(String(input.worktreePath))),
      title: String(input.title ?? ''),
      branch: String(input.branch || ''),
      baseRef: String(input.baseRef || 'HEAD'),
      adapterId: String(input.adapterId ?? ''),
      setupRecipeId: String(input.setupRecipeId || ''),
      status: 'queued',
      needsAttention: false,
      wip: 0,
      ahead: 0,
      behind: 0,
      createdAt: timestamp,
      updatedAt: timestamp,
      events: [] as Array<Record<string, unknown>>,
      _prompt: input.prompt
    };
    this.tasks.set(task.id, task);
    this.queue.push(task.id);
    this._record(task, 'queued');
    this._persist();
    this._emitTask(task);
    this._emitQueue();
    this._drain();
    return publicTask(task);
  }

  _validateTaskOptions(options: Record<string, unknown>): Record<string, unknown> {
    if (!options || typeof options !== 'object' || Array.isArray(options)) throw new Error('Invalid task options');
    const title = String(options.title || '').trim();
    const prompt = String(options.prompt || '');
    if (!title || title.length > 120) throw new Error('Task title must contain 1 to 120 characters');
    if (!prompt || prompt.length > 32_768 || prompt.includes('\0')) throw new Error('Task prompt is invalid');
    const adapterId = String(options.adapterId || '');
    getAdapter(adapterId);
    if (!this.settings.enabledAdapters.includes(adapterId)) throw new Error('Agent adapter is disabled');
    const baseRef = String(options.baseRef || 'HEAD');
    if (!baseRef || baseRef.length > 512 || baseRef.includes('\0')) throw new Error('Invalid base ref');
    return {
      title, prompt, adapterId, baseRef,
      branch: options.branch ? String(options.branch) : '',
      createBranch: options.createBranch !== false,
      setupRecipeId: options.setupRecipeId ? String(options.setupRecipeId) : '',
      allowMain: options.allowMain === true
    };
  }

  _validateRepository(repositoryPath: string): void {
    if (typeof repositoryPath !== 'string') throw new Error('Invalid repository');
    const known = this.repositoryWorkspace.list().some(item => canonical(item.path, this.path) === canonical(repositoryPath, this.path));
    if (!known) throw new Error('Repository is not registered');
  }

  _validateBranch(branch: string): void {
    if (!branch || branch.length > 255 || /[\s~^:?*\\[\]]|\.\.|@\{|\/$|^\//.test(branch)) {
      throw new Error('Invalid branch name');
    }
  }

  _assertWorktreeAvailable(worktreePath: string, ignoreTaskId?: string) {
    const target = canonical(worktreePath, this.path);
    for (const task of this.tasks.values()) {
      if (task.id !== ignoreTaskId && ACTIVE_STATUSES.has(String(task.status)) && canonical(String(task.worktreePath), this.path) === target) {
        throw new Error('This worktree already has an active agent task');
      }
    }
  }

  _drain() {
    if (this.shuttingDown) return;
    while (this.active.size < this.settings.maxConcurrent && this.queue.length > 0) {
      const id = this.queue.shift();
      const task = this.tasks.get(String(id));
      if (!task || task.status !== 'queued') continue;
      this.active.set(String(id), { pty: null, stopRequested: false });
      this._start(task).catch(error => this._failStart(task, error));
    }
    this._emitQueue();
  }

  async _start(task: AgentTask): Promise<void> {
    if (task.setupRecipeId) {
      const recipe = detectSetupRecipe(String(task.worktreePath), { fileSystem: this.fs });
      if (!recipe || recipe.id !== task.setupRecipeId) throw new Error('Requested setup recipe is not available');
      task.status = 'preparing';
      this._record(task, 'preparing');
      this._emitTask(task);
      await this._runSetup(task, recipe);
    }
    const adapter = getAdapter(String(task.adapterId));
    const args = task._resume ? adapter.resumeArgs() : adapter.createArgs(String(task._prompt));
    const executable = this.resolveExecutable(adapter.command);
    if (!executable) throw new Error(`${adapter.label} CLI was not found on PATH`);
    const pty = this.createPty(executable, args, this._ptyOptions(String(String(task.worktreePath))));
    const active = this.active.get(String(task.id!));
    if (!active) return;
    active.pty = pty;
    task.status = 'running';
    task._resume = false;
    this._record(task, 'running');
    this._bindPty(task, pty);
    this._persist();
    this._emitTask(task);
  }

  _runSetup(task: AgentTask, recipe: SetupRecipe): Promise<void> {
    return new Promise<void>((resolve, reject) => {
      const pty = this.createPty(recipe.command as string, recipe.args as string[], this._ptyOptions(String(String(task.worktreePath))));
      const active = this.active.get(String(task.id!));
      if (!active) return reject(new Error('Task was stopped'));
      active.pty = pty;
      const dataSubscription = pty.onData(data => this._handleTerminalData(task, data));
      pty.onExit(({ exitCode }) => {
        dataSubscription?.dispose?.();
        if (active.stopRequested) return reject(new Error('Task was stopped'));
        if (exitCode === 0) resolve();
        else reject(new Error(`Setup recipe exited with code ${exitCode}`));
      });
    });
  }

  _ptyOptions(cwd: string): Record<string, unknown> {
    return {
      cwd,
      cols: 100,
      rows: 30,
      env: { ...process.env, ...this.extraEnv() },
      name: process.platform === 'win32' ? 'xterm-256color' : 'xterm-256color'
    };
  }

  _bindPty(task: AgentTask, pty: IPtyLike): void {
    const dataSubscription = pty.onData(data => this._handleTerminalData(task, data));
    pty.onExit(({ exitCode, signal }) => {
      dataSubscription?.dispose?.();
      const active = this.active.get(String(task.id!));
      if (!active || active.pty !== pty) return;
      this.active.delete(String(task.id));
      task.status = active.forceInterrupted || (this.shuttingDown && active.stopRequested)
        ? 'interrupted'
        : (active.stopRequested ? 'stopped' : (exitCode === 0 ? 'completed' : 'failed'));
      task.exitCode = Number.isInteger(exitCode) ? exitCode : null;
      task.signal = signal || 0;
      this._record(task, task.status, { exitCode: task.exitCode });
      this._persist();
      this._emitTask(task);
      this._drain();
    });
  }

  _handleTerminalData(task: AgentTask, data: string): void {
    const value = String(data);
    this.emit('agent:terminal-data', { taskId: task.id, data: value });
    if (value.includes('\u0007') && !task.needsAttention) {
      task.needsAttention = true;
      this._record(task, 'attention');
      this._persist();
      this._emitTask(task);
      this.emit('agent:attention', { taskId: task.id });
    }
  }

  _failStart(task: AgentTask, error: Error): void {
    const active = this.active.get(String(task.id!));
    if (!active) return;
    this.active.delete(String(task.id));
    task.status = active.stopRequested
      ? (this.shuttingDown ? 'interrupted' : 'stopped')
      : 'failed';
    if (task.status === 'failed') task.error = String(error?.message || error).slice(0, 500);
    this._record(task, task.status, task.error ? { message: task.error } : {});
    this._persist();
    this._emitTask(task);
    this._drain();
  }

  writeTerminal(taskId: string, value: unknown): void {
    if (typeof value !== 'string' || value.length > TERMINAL_INPUT_LIMIT) throw new Error('Terminal input is too large');
    const active = this.active.get(taskId);
    if (!active?.pty) throw new Error('Agent terminal is not active');
    (active.pty as PtyProcess).write?.(value);
  }

  resizeTerminal(taskId: string, cols: number, rows: number): void {
    if (!Number.isInteger(cols) || !Number.isInteger(rows) || cols < 20 || cols > 400 || rows < 5 || rows > 200) {
      throw new Error('Invalid terminal size');
    }
    const active = this.active.get(taskId);
    if (!active?.pty) throw new Error('Agent terminal is not active');
    (active.pty as PtyProcess).resize?.(cols, rows);
  }

  acknowledgeAttention(taskId: string): Record<string, unknown> {
    const task = this.tasks.get(taskId);
    if (!task) throw new Error('Unknown agent task');
    task.needsAttention = false;
    task.updatedAt = this.now();
    this._persist();
    this._emitTask(task);
    return publicTask(task);
  }

  async stopTask(taskId: string): Promise<Record<string, unknown>> {
    const task = this.tasks.get(taskId);
    if (!task) throw new Error('Unknown agent task');
    if (task.status === 'queued') {
      this.queue = this.queue.filter(id => id !== taskId);
      task.status = 'stopped';
      this._record(task, 'stopped');
      this._persist();
      this._emitTask(task);
      this._emitQueue();
      return publicTask(task);
    }
    const active = this.active.get(taskId);
    if (!active) return publicTask(task);
    active.stopRequested = true;
    task.status = 'stopping';
    this._record(task, 'stopping');
    this._emitTask(task);
    (active.pty as PtyProcess | undefined)?.kill?.();
    return publicTask(task);
  }

  resumeTask(taskId: string): Record<string, unknown> {
    this._assertAgentsEnabled();
    const task = this.tasks.get(taskId);
    if (!task) throw new Error('Unknown agent task');
    if (ACTIVE_STATUSES.has(String(task.status))) throw new Error('Agent task is already active');
    this._assertWorktreeAvailable(String(task.worktreePath), task.id);
    task.status = 'queued';
    task._resume = true;
    task.needsAttention = false;
    this.queue.push(String(task.id));
    this._record(task, 'queued');
    this._persist();
    this._emitTask(task);
    this._drain();
    return publicTask(task);
  }

  archiveTask(taskId: string): Record<string, unknown> {
    const task = this.tasks.get(taskId);
    if (!task) throw new Error('Unknown agent task');
    if (ACTIVE_STATUSES.has(String(task.status))) throw new Error('Stop the agent task before archiving it');
    task.status = 'archived';
    this._record(task, 'archived');
    this._persist();
    this._emitTask(task);
    return publicTask(task);
  }

  async _pollGit() {
    for (const task of this.tasks.values()) {
      if (!ACTIVE_STATUSES.has(String(task.status))) continue;
      try {
        const status = await this.repositoryWorkspace.getGitService(String(task.worktreePath)).getStatus();
        const next = {
          wip: Array.isArray(status.files) ? status.files.length : 0,
          ahead: Number(status.ahead) || 0,
          behind: Number(status.behind) || 0
        };
        if (task.wip !== next.wip || task.ahead !== next.ahead || task.behind !== next.behind) {
          Object.assign(task, next, { updatedAt: this.now() });
          this._record(task, 'gitChanged', next);
          this._persist();
          this._emitTask(task);
        }
      } catch {
        // Repository polling is advisory and must not terminate the agent process.
      }
    }
  }

  _record(task: AgentTask & { events?: Array<Record<string, unknown>> }, type: string, detail: Record<string, unknown> = {}): void {
    task.updatedAt = this.now();
    task.events = [...(task.events || []), { type, timestamp: task.updatedAt, ...detail }].slice(-200);
  }

  _assertAgentsEnabled() {
    if (this.settings.agentsEnabled === false) throw new Error('Agent sessions are disabled in Settings');
  }

  _persist() {
    this.store.save({
      version: 1,
      settings: this.settings as AgentStoreState['settings'],
      tasks: [...this.tasks.values()] as AgentStoreState['tasks']
    });
  }

  _emitTask(task: AgentTask): void {
    this.emit('agent:task-changed', publicTask(task));
  }

  _emitQueue() {
    this.emit('agent:queue-changed', {
      active: this.active.size,
      queued: this.queue.length,
      limit: this.settings.maxConcurrent
    });
  }

  destroy() {
    this.shuttingDown = true;
    if (this.pollTimer) this.clearInterval(this.pollTimer);
    for (const [taskId, active] of this.active) {
      const task = this.tasks.get(taskId);
      if (task) {
        task.status = 'interrupted';
        this._record(task, 'interrupted');
      }
      active.forceInterrupted = true;
      try { (active.pty as PtyProcess | undefined)?.kill?.(); } catch { /* best effort */ }
    }
    this.active.clear();
    this.queue = [];
    this._persist();
  }

  async shutdown({ timeoutMs = 5000 } = {}) {
    this.shuttingDown = true;
    this.queue.forEach(taskId => {
      const task = this.tasks.get(taskId);
      if (task) {
        task.status = 'interrupted';
        this._record(task, 'interrupted');
        this._emitTask(task);
      }
    });
    this.queue = [];
    for (const [taskId, active] of this.active) {
      const task = this.tasks.get(taskId);
      if (task) {
        task.status = 'stopping';
        this._record(task, 'stopping');
        this._emitTask(task);
      }
      active.stopRequested = true;
      try { (active.pty as PtyProcess | undefined)?.write?.('\u0003'); } catch { /* best effort */ }
    }
    this._persist();
    const deadline = Date.now() + Math.max(0, timeoutMs);
    while (this.active.size && Date.now() < deadline) {
      await new Promise(resolve => setTimeout(resolve, 50));
    }
    for (const [taskId, active] of this.active) {
      const task = this.tasks.get(taskId);
      if (task) {
        task.status = 'interrupted';
        this._record(task, 'interrupted');
        this._emitTask(task);
      }
      active.forceInterrupted = true;
      try { (active.pty as PtyProcess | undefined)?.kill?.(); } catch { /* best effort */ }
    }
    this.active.clear();
    this._persist();
  }
}


