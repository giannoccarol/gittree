import type { GitTreeApp } from '../app.mts';

interface WorktreeEntry {
  path: string;
  branch?: string;
  head?: string;
  dirty?: boolean;
  locked?: boolean;
}

interface AgentTask {
  id: string;
  title?: string;
  status: string;
  adapterId?: string;
  branch?: string;
  worktreePath: string;
  repositoryPath?: string;
  needsAttention?: boolean;
  wip?: number;
  ahead?: number;
  behind?: number;
  updatedAt?: string;
  events?: Array<{ type: string; timestamp: unknown }>;
}


type TerminalLike = {
  cols: number;
  rows: number;
  write: (data: string) => void;
  open: (container: HTMLElement) => void;
  loadAddon: (addon: unknown) => void;
  onData: (callback: (data: string) => void) => void;
  dispose: () => void;
};

declare const Terminal: new (options?: Record<string, unknown>) => TerminalLike;
declare const FitAddon: { FitAddon: new () => { fit: () => void } };

export class WorktreeAgentPanel {
  app: GitTreeApp;
  repo: { path?: string } | null;
  worktrees: WorktreeEntry[];
  tasks: AgentTask[];
  mode: string;
  enabled: boolean;
  selectedTaskId: string | null;
  terminal: TerminalLike | null;
  fitAddon: { fit: () => void } | null;
  disposers: Array<(() => void) | undefined>;
  resizeFrame: number;
  pendingHeight: number;
  pendingTerminalData: Map<string, { parts: string[]; size: number }>;
  settingsChanged: ((event: CustomEvent) => void) | null;

  constructor(app: GitTreeApp) {
    this.app = app;
    this.repo = null;
    this.worktrees = [];
    this.tasks = [];
    this.mode = 'repository';
    this.enabled = true;
    this.selectedTaskId = null;
    this.terminal = null;
    this.fitAddon = null;
    this.disposers = [];
    this.resizeFrame = 0;
    this.pendingHeight = 0;
    this.pendingTerminalData = new Map();
    this.settingsChanged = null;
  }

  mount(): void {
    document.querySelectorAll<HTMLElement>('[data-sidebar-mode]').forEach(button => {
      button.onclick = () => this.setMode(button.dataset.sidebarMode ?? '');
    });
    document.getElementById('btn-new-agent-session')!.onclick = () => this.openNewSession();
    document.getElementById('agent-status-filter')!.onchange = () => this.renderAgents();
    document.getElementById('agent-provider-filter')!.onchange = () => this.renderAgents();
    document.querySelectorAll<HTMLElement>('[data-agent-drawer-tab]').forEach(button => {
      button.onclick = () => this.setDrawerTab(button.dataset.agentDrawerTab ?? '');
    });
    document.getElementById('btn-close-agent-drawer')!.onclick = () => this.closeDrawer();
    document.getElementById('btn-stop-agent')!.onclick = () => this.stopSelectedTask();
    this.bindDrawerResize();
    if (window.gitTree.onAgentTaskChanged) {
      this.disposers.push(window.gitTree.onAgentTaskChanged(payload => this.onTaskChanged(payload as AgentTask)));
      this.disposers.push(window.gitTree.onAgentTerminalData((payload: unknown) => this.onTerminalData(payload as { taskId?: string; data?: unknown })));
      this.disposers.push(window.gitTree.onAgentQueueChanged(() => this.renderAgents()));
    }
    this.settingsChanged = event => this.applyEnabledState(event.detail?.agentsEnabled !== false);
    window.addEventListener('gittree:agent-settings-changed', this.settingsChanged as EventListener);
    this.disposers.push(() => window.removeEventListener('gittree:agent-settings-changed', this.settingsChanged as EventListener));
    this.syncEnabledState();
    const savedHeight = Number(localStorage.getItem('gittree.agentDrawer.height'));
    if (savedHeight >= 180) document.getElementById('agent-drawer')!.style.height = `${savedHeight}px`;
  }

  async load(repo: { path?: string }): Promise<void> {
    this.repo = repo;
    if (!repo) return;
    const [worktrees, tasks] = await Promise.all([
      window.gitTree.getWorktrees(repo.path),
      window.gitTree.listAgentTasks(repo.path)
    ]) as [WorktreeEntry[] | undefined, AgentTask[] | undefined];
    if (!this.repo || this.app.pathKey(String(this.repo!.path)) !== this.app.pathKey(String(repo.path))) return;
    this.worktrees = Array.isArray(worktrees) ? worktrees : [];
    this.tasks = Array.isArray(tasks) ? tasks : [];
    this.renderWorktrees();
    this.renderAgents();
    if (this.selectedTaskId) {
      const selected = this.tasks.find(task => task.id === this.selectedTaskId);
      if (selected) this.renderDrawer(selected);
    }
  }

  setMode(mode: string): void {
    this.mode = mode === 'agents' && this.enabled ? 'agents' : 'repository';
    const agents = this.mode === 'agents';
    document.querySelectorAll<HTMLElement>('[data-sidebar-mode]').forEach(button => {
      const active = button.dataset.sidebarMode === this.mode;
      button.classList.toggle('active', active);
      button.setAttribute('aria-selected', String(active));
    });
    document.getElementById('sidebar-branches-area')!.classList.toggle('is-hidden', agents);
    document.querySelector('.sidebar-pinned-bottom')!.classList.toggle('is-hidden', agents);
    document.getElementById('agent-sidebar')!.classList.toggle('is-hidden', !agents);
    document.querySelector('#sidebar .panel-heading h2')!.textContent = t(agents ? 'agents.agents' : 'sidebar.branches');
    document.getElementById('btn-new-branch')!.classList.toggle('is-hidden', agents);
    if (agents) this.renderAgents();
  }

  async syncEnabledState(): Promise<void> {
    const settings = await window.gitTree.getAgentSettings() as { error?: string; agentsEnabled?: boolean };
    if (!settings?.error) this.applyEnabledState(settings?.agentsEnabled !== false);
  }

  applyEnabledState(enabled: boolean): void {
    this.enabled = Boolean(enabled);
    const modeSwitch = document.getElementById('sidebar-mode-switch')!;
    modeSwitch?.classList.toggle('is-hidden', !this.enabled);
    modeSwitch?.setAttribute('aria-hidden', String(!this.enabled));
    const agentsButton = document.querySelector('[data-sidebar-mode="agents"]');
    agentsButton?.classList.toggle('is-hidden', !this.enabled);
    agentsButton?.setAttribute('aria-disabled', String(!this.enabled));
    document.getElementById('btn-new-agent-session')!?.toggleAttribute('disabled', !this.enabled);
    if (!this.enabled) {
      this.setMode('repository');
      this.closeDrawer();
    }
    this.renderWorktrees();
    this.renderAgents();
  }

  associatedTask(worktreePath: string): AgentTask | undefined {
    return this.tasks.find(task => (
      this.app.pathKey(task.worktreePath) === this.app.pathKey(worktreePath) &&
      ['queued', 'preparing', 'running', 'stopping'].includes(task.status)
    )) || this.tasks.find(task => this.app.pathKey(task.worktreePath) === this.app.pathKey(worktreePath));
  }

  renderWorktrees(): void {
    const container = document.getElementById('worktree-list')!;
    document.getElementById('worktree-count')!.textContent = String(this.worktrees.length);
    if (!this.worktrees.length) {
      container.innerHTML = `<div class="agent-empty">${this.esc(t('agents.noWorktrees'))}</div>`;
      return;
    }
    container.innerHTML = this.worktrees.map(worktree => {
      const task = this.associatedTask(worktree.path);
      const main = this.repo && this.app.pathKey(worktree.path) === this.app.pathKey(String(this.repo!.path));
      const dirty = Boolean(worktree.dirty) || Number(task?.wip) > 0;
      return `<div class="worktree-row" data-worktree-path="${this.esc(worktree.path)}">
        <span class="worktree-state-dot ${dirty ? 'is-dirty' : ''}" aria-hidden="true"></span>
        <div class="worktree-copy">
          <strong title="${this.esc(worktree.branch || worktree.head)}">${this.esc(worktree.branch || worktree.head || t('agents.detached'))}</strong>
          <small>${main ? this.esc(t('agents.main')) : this.esc(this.basename(worktree.path))}</small>
        </div>
        ${worktree.locked ? '<i class="ph ph-lock-key" aria-label="Locked"></i>' : ''}
        ${task ? `<span class="agent-provider-mini" title="${this.esc(task.adapterId)}"><i class="ph ph-robot"></i></span>` : ''}
        <button class="btn-icon worktree-more" type="button" data-worktree-menu aria-label="${this.esc(t('agents.actions'))}"><i class="ph ph-dots-three"></i></button>
        <div class="worktree-actions is-hidden">
          <button type="button" data-action="open"><i class="ph ph-arrow-square-out"></i>${this.esc(t('agents.open'))}</button>
          ${this.enabled ? `<button type="button" data-action="agent"><i class="ph ph-robot"></i>${this.esc(t('agents.startAgent'))}</button>` : ''}
          <button type="button" data-action="terminal"><i class="ph ph-terminal"></i>${this.esc(t('agents.externalTerminal'))}</button>
          <button type="button" data-action="${worktree.locked ? 'unlock' : 'lock'}"><i class="ph ph-${worktree.locked ? 'lock-key-open' : 'lock-key'}"></i>${this.esc(t(worktree.locked ? 'agents.unlock' : 'agents.lock'))}</button>
          ${main ? '' : `<button type="button" class="is-danger" data-action="remove"><i class="ph ph-trash"></i>${this.esc(t('agents.remove'))}</button>`}
        </div>
      </div>`;
    }).join('');
    container.querySelectorAll<HTMLElement>('.worktree-row').forEach(row => this.bindWorktreeRow(row));
  }

  bindWorktreeRow(row: HTMLElement): void {
    const worktree = this.worktrees.find(item => item.path === row.dataset.worktreePath);
    row.querySelector<HTMLElement>('[data-worktree-menu]')!.onclick = event => {
      event.stopPropagation();
      row.querySelector('.worktree-actions')!.classList.toggle('is-hidden');
    };
    row.querySelectorAll<HTMLElement>('[data-action]').forEach(button => {
      button.onclick = async event => {
        event.stopPropagation();
        row.querySelector('.worktree-actions')!.classList.add('is-hidden');
        await this.runWorktreeAction(button.dataset.action ?? '', worktree);
      };
    });
  }

  async runWorktreeAction(action: string, worktree: WorktreeEntry | undefined): Promise<void> {
    if (!this.repo || !worktree) return;
    if (action === 'agent') return this.openNewSession(worktree);
    if (action === 'terminal') return window.gitTree.openTerminal(worktree.path) as Promise<void>;
    if (action === 'open') {
      const result = await window.gitTree.openWorktree(this.repo!.path, worktree.path) as { error?: string };
      if (result?.error) return this.app.showToast(result.error, 'error');
      await this.app.components.repoTabs.addRepo(worktree.path);
      return;
    }
    if (action === 'lock' || action === 'unlock') {
      const result = (action === 'lock'
        ? await window.gitTree.lockWorktree(this.repo!.path, worktree.path, 'Locked in GitTree')
        : await window.gitTree.unlockWorktree(this.repo!.path, worktree.path)) as { error?: string };
      if (result?.error) this.app.showToast(result.error, 'error');
      else await this.load(this.repo);
      return;
    }
    if (action === 'remove') {
      const confirmed = await this.app.confirmDialog(
        t('agents.removeTitle'), t('agents.removeConfirm', { path: worktree.path }),
        t('agents.remove'), true
      );
      if (!confirmed) return;
      const result = await window.gitTree.removeWorktree(this.repo!.path, worktree.path) as { error?: string };
      if (result?.error) this.app.showToast(result.error, 'error');
      else await this.load(this.repo);
    }
  }

  renderAgents(): void {
    const container = document.getElementById('agent-card-list')!;
    if (!container) return;
    const statusFilter = (document.getElementById('agent-status-filter')! as HTMLSelectElement | null)?.value || '';
    const providerFilter = (document.getElementById('agent-provider-filter')! as HTMLSelectElement | null)?.value || '';
    const cards = this.worktrees.map(worktree => ({ worktree, task: this.associatedTask(worktree.path) }))
      .filter(({ task }) => !providerFilter || task?.adapterId === providerFilter)
      .filter(({ task }) => {
        if (!statusFilter) return true;
        if (statusFilter === 'attention') return task?.needsAttention;
        if (statusFilter === 'active') return ['queued', 'preparing', 'running', 'stopping'].includes(String(task?.status));
        return ['completed', 'failed', 'stopped', 'interrupted'].includes(String(task?.status));
      })
      .sort((a, b) => String(b.task?.updatedAt || '').localeCompare(String(a.task?.updatedAt || '')));
    if (!cards.length) {
      container.innerHTML = `<div class="agent-empty"><i class="ph ph-robot"></i><span>${this.esc(t('agents.noSessions'))}</span></div>`;
      return;
    }
    container.innerHTML = cards.map(({ worktree, task }) => {
      const status = task?.needsAttention ? 'attention' : (task?.status || 'available');
      const main = this.repo && this.app.pathKey(worktree.path) === this.app.pathKey(String(this.repo!.path));
      return `<article class="agent-card ${task?.needsAttention ? 'needs-attention' : ''}" role="listitem"
          tabindex="0" data-worktree-path="${this.esc(worktree.path)}" ${task ? `data-task-id="${this.esc(task.id)}"` : ''}>
        <div class="agent-card-head">
          <span class="agent-provider-mark"><i class="ph ph-${task ? 'robot' : 'git-branch'}"></i></span>
          <div><strong>${this.esc(task?.title || worktree.branch || t('agents.availableWorktree'))}</strong>
          <small>${this.esc(task?.adapterId || (main ? t('agents.main') : this.basename(worktree.path)))}</small></div>
          <span class="agent-status is-${this.esc(status)}">${this.esc(t(`agents.status.${status}`))}</span>
        </div>
        <div class="agent-card-branch"><i class="ph ph-git-branch"></i><span>${this.esc(worktree.branch || t('agents.detached'))}</span></div>
        <div class="agent-card-metrics">
          <span>WIP ${Number(task?.wip) || 0}</span><span>↑${Number(task?.ahead) || 0}</span><span>↓${Number(task?.behind) || 0}</span>
        </div>
        ${task ? `<div class="agent-card-buttons">
          ${this.enabled && ['completed', 'failed', 'stopped', 'interrupted'].includes(task.status) ? `<button class="btn btn-small" type="button" data-task-action="resume">${this.esc(t('agents.resume'))}</button>` : ''}
          ${['queued', 'preparing', 'running', 'stopping'].includes(task.status) ? `<button class="btn btn-small" type="button" data-task-action="stop">${this.esc(t('agents.stop'))}</button>` : ''}
        </div>` : this.enabled ? `<button class="btn btn-small" type="button" data-task-action="start">${this.esc(t('agents.startAgent'))}</button>` : ''}
      </article>`;
    }).join('');
    container.querySelectorAll<HTMLElement>('.agent-card').forEach(card => this.bindAgentCard(card));
  }

  bindAgentCard(card: HTMLElement): void {
    const open = async () => {
      const task = this.tasks.find(item => item.id === card.dataset.taskId);
      const worktree = this.worktrees.find(item => item.path === card.dataset.worktreePath);
      if (!task) return this.openNewSession(worktree);
      await this.activateTask(task);
    };
    card.onclick = event => { if (!(event.target as HTMLElement).closest('button')) open(); };
    card.onkeydown = event => {
      if ((event.key === 'Enter' || event.key === ' ') && !(event.target as HTMLElement).closest('button')) {
        event.preventDefault(); open();
      }
    };
    card.querySelectorAll<HTMLElement>('[data-task-action]').forEach(button => {
      button.onclick = async event => {
        event.stopPropagation();
        const action = button.dataset.taskAction;
        if (action === 'start') {
          const worktree = this.worktrees.find(item => item.path === card.dataset.worktreePath);
          await this.openNewSession(worktree);
        } else if (action === 'stop') {
          await window.gitTree.stopAgentTask(card.dataset.taskId ?? '');
        } else if (action === 'resume') {
          const result = await window.gitTree.resumeAgentTask(card.dataset.taskId ?? '') as { error?: string };
          if (result?.error) this.app.showToast(result.error, 'error');
        }
      };
    });
  }

  async openNewSession(worktree: WorktreeEntry | null = null, prefill: Record<string, unknown> = {}): Promise<void> {
    if (!this.repo) return;
    if (!this.enabled) return this.app.showToast(t('agents.featureDisabled'), 'error');
    if (!worktree) {
      const settings = await window.gitTree.getAgentSettings() as { error?: string; worktreeRoot?: string };
      if (settings?.error) return this.app.showToast(settings.error, 'error');
      if (!settings.worktreeRoot) {
        const selected = await window.gitTree.chooseAgentWorktreeRoot() as { error?: string };
        if (!selected || selected.error) {
          if (selected?.error) this.app.showToast(selected.error, 'error');
          return;
        }
      }
    }
    const isMain = worktree && this.app.pathKey(worktree.path) === this.app.pathKey(String(this.repo!.path));
    if (isMain) {
      const accepted = await this.app.confirmDialog(
        t('agents.mainWarningTitle'), t('agents.mainWarning'), t('common.continue')
      );
      if (!accepted) return;
    }
    interface NewSessionDraft {
      title: string;
      prompt: string;
      baseRef: string;
      branch: string;
      adapterId: string;
      setupRecipeId: string;
      allowMain: boolean;
      customPath?: boolean;
      destinationPath?: string | null;
    }
    const form = await this.app.dialogs.form({
      title: t('agents.newSession'),
      fields: `<label>${this.esc(t('agents.title'))}<input name="title" maxlength="120" required autofocus></label>
        <label>${this.esc(t('agents.prompt'))}<textarea name="prompt" maxlength="32768" required>${this.esc(String(prefill.prompt || ''))}</textarea></label>
        ${worktree ? '' : `<label>${this.esc(t('agents.baseRef'))}<input name="baseRef" maxlength="512" value="${this.esc(this.app.state.currentBranch || 'HEAD')}" required></label>
        <label>${this.esc(t('agents.branch'))}<input name="branch" maxlength="255" placeholder="agent/task-shortId"></label>`}
        <label>${this.esc(t('agents.adapter'))}<select name="adapterId"><option value="codex">Codex</option><option value="claude">Claude Code</option><option value="opencode">OpenCode / DeepSeek</option></select></label>
        <label>${this.esc(t('agents.setup'))}<select name="setupRecipeId"><option value="">${this.esc(t('agents.noSetup'))}</option><option value="npm-ci">npm ci</option><option value="pnpm-frozen">pnpm install --frozen-lockfile</option><option value="yarn-immutable">yarn install --immutable</option><option value="bun-frozen">bun install --frozen-lockfile</option></select></label>
        ${worktree ? '' : `<label class="agent-advanced-path"><input name="customPath" type="checkbox"> ${this.esc(t('agents.customPath'))}</label>`}`,
      cancelLabel: t('common.cancel'),
      actionLabel: t('agents.start'),
      extract: (formElement): NewSessionDraft => {
        const elements = formElement.elements as unknown as Record<string, HTMLInputElement | HTMLTextAreaElement | HTMLSelectElement>;
        return {
          title: elements.title.value.trim(),
          prompt: (elements.prompt as HTMLTextAreaElement).value,
          baseRef: elements.baseRef?.value.trim() || 'HEAD',
          branch: elements.branch?.value.trim() || '',
          adapterId: elements.adapterId.value,
          setupRecipeId: elements.setupRecipeId.value,
          allowMain: Boolean(isMain),
          customPath: Boolean(elements.customPath && (elements.customPath as HTMLInputElement).checked)
        };
      }
    });
    if (!form) return;
    if (form.customPath) {
      form.destinationPath = await window.gitTree.selectDirectory() as string | null;
      if (!form.destinationPath) return;
    }
    delete form.customPath;
    const result = worktree
      ? await window.gitTree.createAgentTaskForWorktree(this.repo!.path, worktree.path, form) as AgentTask & { error?: string }
      : await window.gitTree.createAgentTask(this.repo!.path, form) as AgentTask & { error?: string };
    if (result?.error) return this.app.showToast(result.error, 'error');
    this.tasks = this.tasks.filter(task => task.id !== result.id).concat(result);
    await this.load(this.repo);
    await this.activateTask(this.tasks.find(task => task.id === result.id) || result);
  }

  async activateTask(task: AgentTask): Promise<void> {
    if (!this.enabled) return this.app.showToast(t('agents.featureDisabled'), 'error');
    const result = await window.gitTree.openWorktree(task.repositoryPath, task.worktreePath) as { error?: string };
    if (result?.error) return this.app.showToast(result.error, 'error');
    await this.app.components.repoTabs.addRepo(task.worktreePath);
    this.selectedTaskId = task.id;
    this.flushTerminalData();
    this.renderDrawer(task);
    document.getElementById('agent-drawer')!.classList.remove('is-hidden');
    if (task.needsAttention) window.gitTree.acknowledgeAgentAttention(task.id);
  }

  renderDrawer(task: AgentTask): void {
    document.getElementById('agent-drawer-name')!.textContent = task.title || '';
    document.getElementById('agent-drawer-meta')!.textContent = `${task.adapterId} · ${task.branch || this.basename(task.worktreePath)}`;
    (document.getElementById('btn-stop-agent')! as HTMLButtonElement).disabled = !['queued', 'preparing', 'running', 'stopping'].includes(task.status);
    const activity = document.getElementById('agent-activity')!;
    activity.innerHTML = (task.events || []).slice().reverse().map(event => `<div class="agent-event">
      <span class="agent-event-icon"><i class="ph ph-${this.eventIcon(event.type)}"></i></span>
      <div><strong>${this.esc(t(`agents.event.${event.type}`))}</strong><small>${this.esc(this.formatTime(event.timestamp))}</small></div>
    </div>`).join('') || `<div class="agent-empty">${this.esc(t('agents.noActivity'))}</div>`;
  }

  setDrawerTab(tab: string): void {
    const terminal = tab === 'terminal';
    document.querySelectorAll<HTMLElement>('[data-agent-drawer-tab]').forEach(button => {
      const active = button.dataset.agentDrawerTab === tab;
      button.classList.toggle('active', active);
      button.setAttribute('aria-selected', String(active));
    });
    document.getElementById('agent-activity')!.classList.toggle('is-hidden', terminal);
    document.getElementById('agent-terminal')!.classList.toggle('is-hidden', !terminal);
    if (terminal) this.ensureTerminal();
  }

  ensureTerminal(): void {
    if (this.terminal || typeof Terminal === 'undefined') return;
    this.terminal = new Terminal({
      scrollback: 1000,
      convertEol: true,
      fontFamily: getComputedStyle(document.documentElement).getPropertyValue('--font-mono'),
      fontSize: 12,
      theme: {
        background: getComputedStyle(document.documentElement).getPropertyValue('--surface-primary').trim(),
        foreground: getComputedStyle(document.documentElement).getPropertyValue('--text-primary').trim()
      }
    });
    if (typeof FitAddon !== 'undefined') {
      this.fitAddon = new FitAddon.FitAddon();
      this.terminal.loadAddon(this.fitAddon);
    }
    this.terminal.open(document.getElementById('agent-terminal')!);
    this.terminal.onData(data => {
      if (this.selectedTaskId) window.gitTree.writeAgentTerminal(this.selectedTaskId, data);
    });
    this.flushTerminalData();
    requestAnimationFrame(() => this.fitTerminal());
  }

  fitTerminal(): void {
    if (!this.terminal) return;
    try {
      this.fitAddon?.fit();
      if (this.selectedTaskId) {
        window.gitTree.resizeAgentTerminal(this.selectedTaskId, this.terminal.cols, this.terminal.rows);
      }
    } catch { /* terminal may be attached to an inactive task */ }
  }

  onTerminalData(payload: { taskId?: string; data?: unknown }): void {
    if (!payload?.taskId) return;
    const data = String(payload.data || '');
    if (payload.taskId === this.selectedTaskId && this.terminal) {
      this.terminal.write(data);
      return;
    }
    const pending = this.pendingTerminalData.get(payload.taskId) || { parts: [], size: 0 };
    pending.parts.push(data);
    pending.size += data.length;
    while (pending.size > 65536 && pending.parts.length > 1) {
      pending.size -= pending.parts.shift()!.length;
    }
    this.pendingTerminalData.set(payload.taskId, pending);
  }

  flushTerminalData(): void {
    if (!this.terminal || !this.selectedTaskId) return;
    const pending = this.pendingTerminalData.get(this.selectedTaskId);
    if (!pending?.parts.length) return;
    this.pendingTerminalData.delete(this.selectedTaskId);
    this.terminal.write(pending.parts.join(''));
  }

  onTaskChanged(task: AgentTask): void {
    const index = this.tasks.findIndex(item => item.id === task.id);
    if (index >= 0) this.tasks.splice(index, 1, task);
    else if (this.repo && this.app.pathKey(String(task.repositoryPath)) === this.app.pathKey(String(this.repo!.path))) this.tasks.push(task);
    this.renderWorktrees();
    this.renderAgents();
    if (task.id === this.selectedTaskId) this.renderDrawer(task);
  }

  async stopSelectedTask(): Promise<void> {
    if (!this.selectedTaskId) return;
    const result = await window.gitTree.stopAgentTask(this.selectedTaskId) as { error?: string };
    if (result?.error) this.app.showToast(result.error, 'error');
  }

  closeDrawer(): void {
    document.getElementById('agent-drawer')!.classList.add('is-hidden');
  }

  bindDrawerResize(): void {
    const handle = document.getElementById('agent-drawer-resize')!;
    const drawer = document.getElementById('agent-drawer')!;
    let startY = 0;
    let startHeight = 0;
    const move = (event: PointerEvent) => {
      const mainHeight = drawer.parentElement!.clientHeight;
      this.pendingHeight = Math.max(180, Math.min(mainHeight - 220, startHeight + startY - event.clientY));
      if (this.resizeFrame) return;
      this.resizeFrame = requestAnimationFrame(() => {
        drawer.style.height = `${this.pendingHeight}px`;
        this.resizeFrame = 0;
        this.fitTerminal();
      });
    };
    const finish = () => {
      document.removeEventListener('pointermove', move);
      document.removeEventListener('pointerup', finish);
      if (this.pendingHeight) localStorage.setItem('gittree.agentDrawer.height', String(Math.round(this.pendingHeight)));
    };
    handle.onpointerdown = event => {
      startY = event.clientY;
      startHeight = drawer.getBoundingClientRect().height;
      this.pendingHeight = startHeight;
      handle.setPointerCapture?.(event.pointerId);
      document.addEventListener('pointermove', move);
      document.addEventListener('pointerup', finish, { once: true });
    };
    handle.onkeydown = event => {
      if (!['ArrowUp', 'ArrowDown'].includes(event.key)) return;
      event.preventDefault();
      const delta = event.key === 'ArrowUp' ? 16 : -16;
      const next = Math.max(180, Math.min(drawer.parentElement!.clientHeight - 220, drawer.getBoundingClientRect().height + delta));
      drawer.style.height = `${next}px`;
      localStorage.setItem('gittree.agentDrawer.height', String(next));
      this.fitTerminal();
    };
  }

  eventIcon(type: string): string {
    return ({ queued: 'queue', preparing: 'package', running: 'play', attention: 'bell', gitChanged: 'git-diff', completed: 'check-circle', failed: 'warning-circle', stopping: 'stop', stopped: 'stop-circle', interrupted: 'plugs', archived: 'archive' } as Record<string, string>)[type] || 'circle';
  }

  formatTime(value: unknown): string {
    try { return new Intl.DateTimeFormat(undefined, { dateStyle: 'short', timeStyle: 'short' }).format(new Date(value as string)); } catch { return ''; }
  }

  basename(value: unknown): string {
    return String(value || '').replace(/[\\/]+$/, '').split(/[\\/]/).pop() || (value as string);
  }

  esc(value: unknown): string { return HtmlEncoder.encode(String(value ?? '')); }

  destroy(): void {
    this.disposers.forEach(dispose => dispose?.());
    this.disposers = [];
    this.pendingTerminalData.clear();
    this.terminal?.dispose();
    this.terminal = null;
  }
}

if (typeof window !== 'undefined') {
  (window as unknown as { WorktreeAgentPanel: typeof WorktreeAgentPanel }).WorktreeAgentPanel = WorktreeAgentPanel;
}

declare const module: { exports: unknown } | undefined;
if (typeof module !== 'undefined' && (module as { exports?: unknown }).exports) {
  (module as { exports: unknown }).exports = WorktreeAgentPanel;
}
