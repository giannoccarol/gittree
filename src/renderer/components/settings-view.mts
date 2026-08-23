import type { GitTreeApp } from '../app.mts';
import type { BranchListMetadata } from './branch-list.mts';

interface AgentSettingsPayload {
  agentsEnabled?: boolean;
  worktreeRoot?: string;
  maxConcurrent?: number;
  enabledAdapters?: string[];
}

interface AiSettingsPayload {
  provider?: string;
  baseUrl?: string;
  model?: string;
  keyConfigured?: boolean;
  language?: string;
}

interface SettingsProfile {
  id: string;
  label: string;
  name: string;
  email: string;
  source?: string;
}

interface AgentAdapterInfo {
  id: string;
  label: string;
  version?: string;
  available?: boolean;
}


export class SettingsView {
  app: GitTreeApp;
  overlay: HTMLElement;
  dialog: HTMLElement;
  autoFetchStorageKey: string;
  profilesStorageKey: string;
  assignmentsStorageKey: string;
  inFlight: Set<string>;
  timer: number | null;
  renderGeneration: number;
  updateState: Record<string, unknown> | null;
  unsubscribeUpdates: () => void;
  activeSection: string | null;
  // Present in the original source as an unresolved call site; kept as-is.
  declare confirmVaultReset: (() => Promise<unknown>) | undefined;

  constructor(app: GitTreeApp) {
    this.app = app;
    this.overlay = document.getElementById('modal-overlay')! as HTMLElement;
    this.dialog = document.getElementById('modal-dialog')! as HTMLElement;
    this.autoFetchStorageKey = 'gittree.settings.autoFetch';
    this.profilesStorageKey = 'gittree.settings.gitProfiles';
    this.assignmentsStorageKey = 'gittree.settings.profileAssignments';
    this.inFlight = new Set();
    this.timer = null;
    this.renderGeneration = 0;
    this.updateState = null;
    this.activeSection = null;
    this.unsubscribeUpdates = window.gitTree.onUpdateState(payload => this.handleUpdateState(payload as Record<string, unknown>));
    document.addEventListener('keydown', event => {
      if (event.key === 'Escape' && this.dialog.classList.contains('settings-dialog')) {
        event.preventDefault();
        this.close();
      }
    });
  }

  init(): void {
    if (this.timer) return;
    this.timer = window.setInterval(() => this.tick(), 30000);
  }

  async open(section: string | null = null, { scope = 'full' }: { scope?: string } = {}): Promise<void> {
    const repo = this.app.state.repo;
    const generation = this.renderGeneration += 1;
    const alreadyOpen = !this.overlay.classList.contains('is-hidden')
      && this.dialog.classList.contains('settings-dialog');
    if (!alreadyOpen) {
      this.dialog.className = 'confirm-dialog settings-dialog';
      this.dialog.innerHTML = `
        <div class="settings-loading">
          <i class="ph ph-circle-notch" aria-hidden="true"></i>
          <span>${this.esc(t('common.loading'))}</span>
        </div>`;
      this.overlay.classList.remove('is-hidden');
    }
    try {
      let metadata = this.app.components.branchList?.metadata ?? null;
      if (repo && !metadata) {
        const response = await window.gitTree.getBranchMetadata(repo.path) as { error?: string } | undefined;
        metadata = response?.error ? null : response as Record<string, unknown>;
      }
      const remotes = repo ? await this.readRemotes(String(repo.path)) : [];
      const agentSettings = (scope === 'about'
        ? null
        : await window.gitTree.getAgentSettings?.().then(
            (value): AgentSettingsPayload | null => (value ?? null) as AgentSettingsPayload | null,
            (): null => null
          ));
      const aiSettings = (scope === 'about'
        ? null
        : await window.gitTree.getAiSettings?.().then(
            (value): AiSettingsPayload | null => (value ?? null) as AiSettingsPayload | null,
            (): null => null
          ));
    const schedules: Record<string, unknown> = this.readObject(this.autoFetchStorageKey);
    let profiles: SettingsProfile[] = this.readArray<SettingsProfile>(this.profilesStorageKey);
    const assignments = this.readObject(this.assignmentsStorageKey);
    const identity = repo ? await this.readRepositoryIdentity(repo.path) : null;
    if (repo && identity?.configured) {
      const imported = this.importConfiguredProfile(profiles, assignments, repo.path, identity);
      profiles = imported.profiles;
      if (imported.changed) {
        localStorage.setItem(this.profilesStorageKey, JSON.stringify(profiles));
        localStorage.setItem(this.assignmentsStorageKey, JSON.stringify(assignments));
      }
    }
    const repoSchedule = repo
      ? this.readProjectSchedule(schedules[repo.path] as Record<string, unknown> | undefined, metadata)
      : {};
    const assignedProfile = repo ? assignments[repo.path] : '';
    const toolbarVisibility = this.app.readToolbarVisibility();

    this.dialog.className = 'confirm-dialog settings-dialog';
    this.dialog.innerHTML = `
      <div class="settings-header">
        <div class="settings-header-copy">
          <span class="eyebrow">${this.esc(t('settings.eyebrow'))}</span>
          <h2>${this.esc(t('settings.title'))}</h2>
        </div>
        <button class="btn-icon" type="button" data-settings-close
          title="${this.esc(t('common.close'))}" aria-label="${this.esc(t('common.close'))}">
          <i class="ph ph-x" aria-hidden="true"></i>
        </button>
      </div>
      <div class="settings-layout">
        <nav class="settings-nav" aria-label="${this.esc(t('settings.navigationLabel'))}">
          <div class="settings-nav-group">
            <span class="settings-nav-label">${this.esc(t('settings.personalizationGroup'))}</span>
            ${this.renderNavigationItem('appearance', 'palette', t('settings.appearanceTitle'))}
            ${this.renderNavigationItem('toolbar', 'toolbox', t('settings.toolbarTitle'))}
            ${this.renderNavigationItem('shortcuts', 'keyboard', t('settings.shortcutsTitle'))}
          </div>
          <div class="settings-nav-group">
            <span class="settings-nav-label">${this.esc(t('settings.repositoryGroup'))}</span>
            ${this.renderNavigationItem('auto-fetch', 'arrows-clockwise', t('settings.autoFetchTitle'))}
            ${this.renderNavigationItem('remotes', 'cloud', t('settings.remotesTitle'))}
            ${this.renderNavigationItem('accounts', 'users-three', t('settings.accountsTitle'))}
          </div>
          <div class="settings-nav-group">
            <span class="settings-nav-label">${this.esc(t('settings.automationGroup'))}</span>
            ${this.renderNavigationItem('agents', 'robot', t('agents.settingsTitle'))}
            ${this.renderNavigationItem('ai', 'sparkle', t('ai.settingsTitle'))}
          </div>
          <div class="settings-nav-group settings-nav-group-system">
            <span class="settings-nav-label">${this.esc(t('settings.systemGroup'))}</span>
            ${this.renderNavigationItem('about', 'info', t('settings.aboutTitle'))}
          </div>
        </nav>
        <main class="settings-scroll">
        <section class="settings-section" data-settings-section="appearance">
          <div class="settings-section-heading">
            <i class="ph ph-palette" aria-hidden="true"></i>
            <div>
              <h3>${this.esc(t('settings.appearanceTitle'))}</h3>
              <p>${this.esc(t('settings.appearanceHelp'))}</p>
            </div>
          </div>
          <div class="settings-appearance-body">
            <div class="settings-theme-grid" role="group" aria-label="${this.esc(t('settings.themeLabel'))}">
              ${this.renderThemeCard('light')}
              ${this.renderThemeCard('dark')}
            </div>
            <div class="settings-tone-group">
              <span class="settings-tone-label">${this.esc(t('settings.tonesLight'))}</span>
              <div class="settings-tone-row">
                ${Theme.tones.light.map(tone => this.renderToneSwatch('light', tone)).join('')}
              </div>
            </div>
            <div class="settings-tone-group">
              <span class="settings-tone-label">${this.esc(t('settings.tonesDark'))}</span>
              <div class="settings-tone-row">
                ${Theme.tones.dark.map(tone => this.renderToneSwatch('dark', tone)).join('')}
              </div>
            </div>
          </div>
        </section>

        <section class="settings-section" data-settings-section="auto-fetch">
          <div class="settings-section-heading">
            <i class="ph ph-arrows-clockwise" aria-hidden="true"></i>
            <div>
              <h3>${this.esc(t('settings.autoFetchTitle'))}</h3>
              <p>${this.esc(t('settings.autoFetchHelp'))}</p>
            </div>
          </div>
          <div class="settings-project-fetch">
            ${repo
              ? this.renderProjectSchedule(repoSchedule, metadata)
              : `<div class="settings-empty">${this.esc(t('settings.openRepositoryFirst'))}</div>`}
          </div>
        </section>

        <section class="settings-section" data-settings-section="shortcuts">
          <div class="settings-section-heading">
            <i class="ph ph-keyboard" aria-hidden="true"></i>
            <div>
              <h3>${this.esc(t('settings.shortcutsTitle'))}</h3>
              <p>${this.esc(t('settings.shortcutsHelp'))}</p>
            </div>
          </div>
          <div class="settings-shortcut-content">
            <div class="settings-shortcut-intro">
              <i class="ph ph-info" aria-hidden="true"></i>
              <p>${this.esc(t('settings.shortcutsGuide'))}</p>
            </div>
            <div class="settings-shortcut-groups">
              <div class="settings-shortcut-group">
                <div class="settings-subsection-heading">
                  <i class="ph ph-git-branch" aria-hidden="true"></i>
                  <span>${this.esc(t('settings.repositoryShortcuts'))}</span>
                </div>
                <div class="settings-shortcut-list">
                  ${this.renderShortcut(t('actions.fetch'), 'fetch', t('settings.fetchShortcutHelp'))}
                  ${this.renderShortcut(t('actions.pull'), 'pull', t('settings.pullShortcutHelp'))}
                  ${this.renderShortcut(t('actions.push'), 'push', t('settings.pushShortcutHelp'))}
                  ${this.renderShortcut(t('sidebar.newBranch'), 'newBranch', t('settings.branchShortcutHelp'))}
                </div>
              </div>
              <div class="settings-shortcut-group">
                <div class="settings-subsection-heading">
                  <i class="ph ph-navigation-arrow" aria-hidden="true"></i>
                  <span>${this.esc(t('settings.navigationShortcuts'))}</span>
                </div>
                <div class="settings-shortcut-list">
                  ${this.renderShortcut(t('welcome.open'), 'open', t('settings.openShortcutHelp'))}
                  ${this.renderShortcut(t('search.trigger'), 'search', t('settings.searchShortcutHelp'))}
                </div>
              </div>
            </div>
          </div>
        </section>

        <section class="settings-section" data-settings-section="toolbar">
          <div class="settings-section-heading">
            <i class="ph ph-toolbox" aria-hidden="true"></i>
            <div>
              <h3>${this.esc(t('settings.toolbarTitle'))}</h3>
              <p>${this.esc(t('settings.toolbarHelp'))}</p>
            </div>
          </div>
          <div class="settings-toolbar-rows">
            ${this.renderToolbarRow('gitflow', t('settings.toolbarGitflow'), t('settings.toolbarGitflowDetail'), toolbarVisibility.gitflow)}
            ${this.renderToolbarRow('terminal', t('settings.toolbarTerminal'), t('settings.toolbarTerminalDetail'), toolbarVisibility.terminal)}
            ${this.renderToolbarRow('explorer', t('settings.toolbarExplorer'), t('settings.toolbarExplorerDetail'), toolbarVisibility.explorer)}
          </div>
        </section>

        <section class="settings-section" data-settings-section="remotes">
          <div class="settings-section-heading">
            <i class="ph ph-cloud" aria-hidden="true"></i>
            <div>
              <h3>${this.esc(t('settings.remotesTitle'))}</h3>
              <p>${this.esc(t('settings.remotesHelp'))}</p>
            </div>
          </div>
          <div class="settings-remotes-list" id="settings-remotes-list">
            ${remotes.map(remote => this.renderRemoteRow(remote)).join('') || `<div class="settings-empty">${this.esc(t('settings.noRemotes'))}</div>`}
          </div>
          <div class="settings-section-footer">
            <form id="settings-remote-form" class="settings-remote-form">
              <input name="name" maxlength="200" required
                aria-label="${this.esc(t('settings.remoteName'))}"
                placeholder="${this.esc(t('settings.remoteName'))}">
              <input name="url" maxlength="4096" required
                aria-label="${this.esc(t('settings.remoteUrl'))}"
                placeholder="${this.esc(t('settings.remoteUrl'))}">
              <button class="btn btn-primary" type="submit">
                <i class="ph ph-plus" aria-hidden="true"></i>
                ${this.esc(t('settings.addRemote'))}
              </button>
            </form>
          </div>
        </section>

        <section class="settings-section" data-settings-section="agents">
          <div class="settings-section-heading">
            <i class="ph ph-robot" aria-hidden="true"></i>
            <div>
              <h3>${this.esc(t('agents.settingsTitle'))}</h3>
              <p>${this.esc(t('agents.settingsHelp'))}</p>
            </div>
          </div>
          <div class="settings-toolbar-rows agent-settings-rows">
            <label class="settings-toolbar-row">
              <div class="settings-toolbar-copy">
                <strong>${this.esc(t('agents.featureEnabled'))}</strong>
                <small>${this.esc(t('agents.featureEnabledHelp'))}</small>
              </div>
              <span class="settings-switch"><input id="settings-agents-enabled" type="checkbox"${agentSettings?.agentsEnabled !== false ? ' checked' : ''}><span aria-hidden="true"></span></span>
            </label>
            <div class="settings-toolbar-row">
              <div class="settings-toolbar-copy">
                <strong>${this.esc(t('agents.worktreeRoot'))}</strong>
                <small id="agent-root-value">${this.esc(agentSettings?.worktreeRoot || t('agents.notConfigured'))}</small>
              </div>
              <button id="settings-agent-root" class="btn btn-small" type="button">${this.esc(t('agents.choose'))}</button>
            </div>
            <label class="settings-toolbar-row">
              <div class="settings-toolbar-copy">
                <strong>${this.esc(t('agents.concurrency'))}</strong>
                <small>${this.esc(t('agents.concurrencyHelp'))}</small>
              </div>
              <input id="settings-agent-concurrency" type="number" min="1" max="32" value="${Number(agentSettings?.maxConcurrent) || 4}">
            </label>
            <div class="agent-adapter-settings">
              <div class="agent-adapter-placeholder">
                <i class="ph ph-circle-notch" aria-hidden="true"></i>
                <span>${this.esc(t('common.loading'))}</span>
              </div>
            </div>
          </div>
        </section>

        <section class="settings-section" data-settings-section="ai">
          <div class="settings-section-heading">
            <i class="ph ph-sparkle" aria-hidden="true"></i>
            <div>
              <h3>${this.esc(t('ai.settingsTitle'))}</h3>
              <p>${this.esc(t('ai.settingsHelp'))}</p>
            </div>
          </div>
          <div class="settings-toolbar-rows ai-settings-rows">
            <label class="settings-toolbar-row">
              <div class="settings-toolbar-copy">
                <strong>${this.esc(t('ai.provider'))}</strong>
                <small id="ai-opencode-status">${aiSettings?.provider === 'opencode' ? this.esc(t('ai.opencodeHelp')) : ''}</small>
              </div>
              <select id="settings-ai-provider" class="commit-input ai-settings-select">
                <option value="opencode"${aiSettings?.provider === 'opencode' ? ' selected' : ''}>${this.esc(t('ai.providerOpencode'))}</option>
                <option value="openai"${aiSettings?.provider === 'openai' ? ' selected' : ''}>${this.esc(t('ai.providerOpenai'))}</option>
                <option value="anthropic"${aiSettings?.provider === 'anthropic' ? ' selected' : ''}>${this.esc(t('ai.providerAnthropic'))}</option>
              </select>
            </label>
            <div class="settings-toolbar-row" data-ai-field="baseUrl">
              <div class="settings-toolbar-copy">
                <strong>${this.esc(t('ai.baseUrl'))}</strong>
                <small>${this.esc(t('ai.baseUrlHelp'))}</small>
              </div>
              <input id="settings-ai-base-url" class="commit-input ai-settings-input" maxlength="2048"
                value="${this.esc(aiSettings?.baseUrl || '')}" placeholder="https://api.deepseek.com/v1">
            </div>
            <div class="settings-toolbar-row" data-ai-field="model">
              <div class="settings-toolbar-copy">
                <strong>${this.esc(t('ai.model'))}</strong>
                <small id="ai-model-help">${this.esc(t('ai.modelHelp'))}</small>
              </div>
              <input id="settings-ai-model" class="commit-input ai-settings-input" maxlength="200"
                value="${this.esc(aiSettings?.model || '')}" placeholder="deepseek-chat">
            </div>
            <div class="settings-toolbar-row" data-ai-field="key">
              <div class="settings-toolbar-copy">
                <strong>${this.esc(t('ai.apiKey'))}</strong>
                <small id="ai-key-status">${this.esc(aiSettings?.keyConfigured ? t('ai.apiKeySaved') : t('ai.apiKeyMissing'))}</small>
              </div>
              <div class="settings-ai-key">
                <input id="settings-ai-key" class="commit-input ai-settings-input" type="password"
                  maxlength="400" placeholder="sk-…" autocomplete="off">
                <button id="btn-ai-key-save" class="btn btn-small" type="button">${this.esc(t('ai.apiKeySave'))}</button>
                <button id="btn-ai-key-remove" class="btn btn-small" type="button"${aiSettings?.keyConfigured ? '' : ' disabled'}>${this.esc(t('ai.apiKeyRemove'))}</button>
              </div>
            </div>
            <label class="settings-toolbar-row" data-ai-field="language">
              <div class="settings-toolbar-copy">
                <strong>${this.esc(t('ai.language'))}</strong>
              </div>
              <select id="settings-ai-language" class="commit-input ai-settings-select">
                <option value="auto"${aiSettings?.language !== 'en' && aiSettings?.language !== 'it' ? ' selected' : ''}>${this.esc(t('ai.languageAuto'))}</option>
                <option value="en"${aiSettings?.language === 'en' ? ' selected' : ''}>${this.esc(t('ai.languageEn'))}</option>
                <option value="it"${aiSettings?.language === 'it' ? ' selected' : ''}>${this.esc(t('ai.languageIt'))}</option>
              </select>
            </label>
            <div class="settings-toolbar-row" data-ai-field="test">
              <div class="settings-toolbar-copy">
                <strong>${this.esc(t('ai.testConnection'))}</strong>
              </div>
              <div class="settings-ai-key">
                <button id="btn-ai-test" class="btn btn-small" type="button">${this.esc(t('ai.testConnection'))}</button>
                <span id="ai-test-status" class="settings-update-status" aria-live="polite"></span>
              </div>
            </div>
          </div>
          <div class="settings-section-footer">
            <button id="btn-ai-save" class="btn btn-primary" type="button">
              <i class="ph ph-floppy-disk" aria-hidden="true"></i>
              ${this.esc(t('ai.save'))}
            </button>
          </div>
        </section>

        <section class="settings-section" data-settings-section="accounts">
          <div class="settings-section-heading">
            <i class="ph ph-users-three" aria-hidden="true"></i>
            <div>
              <h3>${this.esc(t('settings.accountsTitle'))}</h3>
              <p>${this.esc(t('settings.accountsHelp'))}</p>
            </div>
          </div>
          <div class="settings-profile-list">
            ${(profiles as SettingsProfile[]).map(profile => this.renderProfile(
                profile,
                assignedProfile as string | undefined,
                Boolean(repo)
              )).join('') || `<div class="settings-empty">${this.esc(t('settings.noProfiles'))}</div>`}
          </div>
          <div class="settings-section-footer settings-profile-footer">
            <form id="settings-account-form" class="settings-account-form">
              <input name="label" maxlength="80" required
                aria-label="${this.esc(t('settings.profileLabel'))}"
                placeholder="${this.esc(t('settings.profileLabel'))}">
              <input name="name" maxlength="200" required
                aria-label="${this.esc(t('settings.gitName'))}"
                placeholder="${this.esc(t('settings.gitName'))}">
              <input name="email" type="email" maxlength="254" required
                aria-label="${this.esc(t('settings.gitEmail'))}"
                placeholder="${this.esc(t('settings.gitEmail'))}">
              <button class="btn btn-primary" type="submit">
                <i class="ph ph-plus" aria-hidden="true"></i>
                ${this.esc(t('settings.addProfile'))}
              </button>
            </form>
            <div class="settings-security-row">
              <div>
                <strong>${this.esc(t('settings.credentialsTitle'))}</strong>
                <small>${this.esc(t('settings.credentialsHelp'))}</small>
              </div>
              <button class="btn btn-secondary btn-sm" id="settings-vault-reset" type="button">
                <i class="ph ph-key" aria-hidden="true"></i>
                ${this.esc(t('settings.resetVault'))}
              </button>
            </div>
          </div>
        </section>

        <section class="settings-section" data-settings-section="about">
          <div class="settings-section-heading">
            <i class="ph ph-info" aria-hidden="true"></i>
            <div>
              <h3>${this.esc(t('settings.aboutTitle'))}</h3>
              <p class="settings-about-version">GitTree <span id="about-version">—</span> — Beta</p>
              <p id="about-git-version" class="settings-git-version-warning is-hidden"></p>
            </div>
          </div>
          <div class="settings-about-body">
            <p>${this.esc(t('settings.aboutDescription'))}</p>
            <p>${this.esc(t('settings.aboutCreatedBy'))} <strong>Lorenzo Giannoccaro</strong> &lt;lorenzo.giannoccaro998@gmail.com&gt;</p>
            <p class="settings-about-repo">
              <a href="#" id="about-repo-link">github.com/giannoccarol/gittree</a>
            </p>
            <div class="settings-update-row">
              <button class="btn btn-small" id="btn-check-update" type="button">
                <i class="ph ph-arrows-clockwise" aria-hidden="true"></i>
                <span data-i18n="settings.checkUpdate">Check for updates</span>
              </button>
              <span id="check-update-status" class="settings-update-status" aria-live="polite"></span>
            </div>
            <div class="settings-update-row" data-settings-full-only>
              <button class="btn btn-small" id="btn-export-diagnostics" type="button">
                <i class="ph ph-file-zip" aria-hidden="true"></i>
                <span>${this.esc(t('settings.exportDiagnostics'))}</span>
              </button>
              <span id="export-diagnostics-status" class="settings-update-status" aria-live="polite"></span>
            </div>
            <p class="text-tertiary" data-settings-full-only>
              ${this.esc(t('settings.exportDiagnosticsHelp'))}
            </p>
          </div>
        </section>
        </main>
      </div>
    `;
    this.overlay.classList.remove('is-hidden');
    this.bindSettingsEvents(repo);
    this.applyScope(scope);
    this.syncAppearanceState();
    this.populateVersion();
    this.selectSection(scope === 'about' ? 'about' : (section || this.activeSection || 'appearance'));
    this.dialog.querySelector<HTMLElement>('[data-settings-close]')?.focus();
    if (scope !== 'about') this.hydrateAgentAdapters(agentSettings, generation);
    } catch (error) {
      if (this.dialog.classList.contains('settings-dialog')) this.close();
      this.app.showToast((error as Error)?.message || t('common.error'), 'error');
    }
  }

  renderNavigationItem(section: string, icon: string, label: string): string {
    return `<button class="settings-nav-item" type="button" data-settings-nav="${this.esc(section)}">
      <i class="ph ph-${this.esc(icon)}" aria-hidden="true"></i>
      <span>${this.esc(label)}</span>
    </button>`;
  }

  applyScope(scope: string): void {
    const aboutOnly = scope === 'about';
    this.dialog.classList.toggle('settings-dialog-about', aboutOnly);
    if (!aboutOnly) return;
    this.dialog.querySelectorAll('[data-settings-section]').forEach(section => {
      if ((section as HTMLElement).dataset.settingsSection !== 'about') section.remove();
    });
    this.dialog.querySelectorAll('[data-settings-full-only]').forEach(element => element.remove());
  }

  close(): void {
    this.overlay.classList.add('is-hidden');
    this.overlay.onclick = null;
    this.dialog.className = 'confirm-dialog';
    this.dialog.innerHTML = '';
  }

  async populateVersion(): Promise<void> {
    const el = document.getElementById('about-version')!;
    if (el && window.gitTree.getAppVersion) {
      const v = await window.gitTree.getAppVersion();
      el.textContent = v as string;
    }
    const gitStatus = document.getElementById('about-git-version')!;
    if (gitStatus && window.gitTree.getGitVersion) {
      const info = await window.gitTree.getGitVersion() as { supported?: boolean; version?: string; minimum?: string } | undefined;
      if (info && !info.supported) {
        gitStatus.textContent = t('settings.gitVersionWarning', {
          version: info.version || '—',
          minimum: info.minimum
        });
        gitStatus.classList.remove('is-hidden');
      }
    }
  }

  renderThemeCard(theme: string): string {
    const label = t(theme === 'light' ? 'settings.themeLight' : 'settings.themeDark');
    return `<button class="settings-theme-card" type="button" data-theme-choice="${theme}" aria-pressed="false">
      <span class="settings-theme-preview settings-theme-preview-${theme}" aria-hidden="true"></span>
      <span class="settings-theme-name">${this.esc(label)}</span>
    </button>`;
  }

  renderToneSwatch(theme: string, tone: { id: string; preview: string[] }): string {
    const name = tone.id.charAt(0).toUpperCase() + tone.id.slice(1);
    return `<button class="settings-tone-swatch" type="button"
        data-tone-theme="${theme}" data-tone-choice="${this.esc(tone.id)}"
        title="${this.esc(name)}" aria-pressed="false">
      <span class="settings-tone-chips" aria-hidden="true">
        ${tone.preview.map(() => '<i></i>').join('')}
      </span>
      <span class="settings-tone-name">${this.esc(name)}</span>
    </button>`;
  }

  syncAppearanceState(): void {
    const current = document.documentElement.dataset.theme;
    this.dialog.querySelectorAll<HTMLElement>('[data-theme-choice]').forEach(button => {
      const active = String((button as HTMLElement).dataset.themeChoice) === current;
      button.classList.toggle('is-active', active);
      button.setAttribute('aria-pressed', String(active));
    });
    this.dialog.querySelectorAll<HTMLElement>('[data-tone-choice]').forEach(button => {
      const toneTheme = (button as HTMLElement).dataset.toneTheme;
      const toneId = String((button as HTMLElement).dataset.toneChoice ?? '');
      const toneList = (Theme.tones as unknown as Record<string, Array<{ id: string; preview: string[] }>>)[String(toneTheme)] ?? [];
      const tone = toneList.find(item => item.id === toneId);
      const chips = button.querySelectorAll('.settings-tone-chips i');
      tone?.preview.forEach((color: string, index: number) => {
        if (chips[index]) (chips[index] as HTMLElement).style.background = color;
      });
      const active = (toneTheme === 'light' || toneTheme === 'dark') && Theme.getTone(toneTheme) === toneId;
      button.classList.toggle('is-active', active);
      button.setAttribute('aria-pressed', String(active));
    });
  }

  renderProjectSchedule(schedule: Record<string, unknown> = {}, metadata: BranchListMetadata | null | undefined = {}): string {
    const enabled = Boolean(schedule.enabled);
    const interval = Number(schedule.intervalMinutes) || 15;
    const remotes = metadata?.remotes || [];
    return `<div class="settings-project-controls">
      <label class="settings-switch">
        <input type="checkbox" data-auto-fetch-project${enabled ? ' checked' : ''}>
        <span aria-hidden="true"></span>
      </label>
      <div class="settings-project-copy">
        <strong>${this.esc(t('settings.projectFetch'))}</strong>
        <small>${this.esc(t('settings.projectFetchDetail'))}</small>
      </div>
      <label class="settings-interval">
        <span>${this.esc(t('settings.every'))}</span>
        <select data-auto-fetch-project-interval>
          ${[1, 5, 10, 15, 30, 60].map(value => `
            <option value="${value}"${value === interval ? ' selected' : ''}>
              ${this.esc(t('settings.minutes', { count: value }))}
            </option>`).join('')}
        </select>
      </label>
      <label class="settings-remote">
        <span>${this.esc(t('settings.remote'))}</span>
        <select data-auto-fetch-project-remote>
          ${remotes.map(remote => `<option value="${this.esc(remote.name)}"${
            remote.name === schedule.remote ? ' selected' : ''
          }>${this.esc(remote.name)}</option>`).join('')}
        </select>
      </label>
    </div>`;
  }

  renderToolbarRow(key: string, label: string, detail: string, checked: boolean): string {
    return `<div class="settings-toolbar-row">
      <div class="settings-toolbar-copy">
        <strong>${this.esc(label)}</strong>
        <small>${this.esc(detail)}</small>
      </div>
      <label class="settings-switch">
        <input type="checkbox" data-toolbar-toggle="${this.esc(key)}"${checked ? ' checked' : ''}>
        <span aria-hidden="true"></span>
      </label>
    </div>`;
  }

  async readRemotes(repoPath: string): Promise<Array<{ name?: string; refs?: { push?: string; fetch?: string } }>> {
    try {
      const result = await window.gitTree.getRemotes(repoPath) as Array<{ name?: string; refs?: { push?: string; fetch?: string } }>;
      return Array.isArray(result) ? result : [];
    } catch {
      return [];
    }
  }

  renderRemoteRow(remote: { name?: string; refs?: { push?: string; fetch?: string } }): string {
    const url = remote.refs?.push || remote.refs?.fetch || '';
    return `<div class="settings-remote-row" data-remote-name="${this.esc(remote.name)}">
      <i class="ph ph-cloud" aria-hidden="true"></i>
      <div class="settings-remote-copy">
        <strong>${this.esc(remote.name)}</strong>
        <span class="settings-remote-url" title="${this.esc(url)}">${this.esc(url)}</span>
      </div>
      <div class="settings-remote-actions">
        <button class="btn btn-small" type="button" data-action="rename" title="${this.esc(t('settings.renameRemote'))}" aria-label="${this.esc(t('settings.renameRemote'))}">
          <i class="ph ph-pencil-simple" aria-hidden="true"></i>
        </button>
        <button class="btn btn-small" type="button" data-action="url" title="${this.esc(t('settings.changeRemoteUrl'))}" aria-label="${this.esc(t('settings.changeRemoteUrl'))}">
          <i class="ph ph-link" aria-hidden="true"></i>
        </button>
        <button class="btn btn-small is-danger" type="button" data-action="remove" title="${this.esc(t('settings.removeRemote'))}" aria-label="${this.esc(t('settings.removeRemote'))}">
          <i class="ph ph-trash" aria-hidden="true"></i>
        </button>
      </div>
    </div>`;
  }

  async refreshRemotesList(repo: { path?: string }): Promise<void> {
    const container = this.dialog.querySelector('#settings-remotes-list');
    if (!container || !repo) return;
    const remotes = await this.readRemotes(String(repo.path));
    container.innerHTML = remotes.map(remote => this.renderRemoteRow(remote)).join('')
      || `<div class="settings-empty">${this.esc(t('settings.noRemotes'))}</div>`;
    this.bindRemotes(repo);
  }

  bindRemotes(repo: { path?: string } | null): void {
    if (!repo) return;
    const list = this.dialog.querySelector('#settings-remotes-list');
    const form = this.dialog.querySelector('#settings-remote-form') as HTMLFormElement | null;
    if (form) {
      form.onsubmit = async event => {
        event.preventDefault();
        const elements = form.elements as unknown as Record<string, HTMLInputElement>;
        const name = elements.name.value.trim();
        const url = elements.url.value.trim();
        if (!name || !url) return;
        const result = await window.gitTree.addRemote(repo.path, name, url) as { error?: string };
        if (result?.error) {
          this.app.showToast(result.error, 'error');
          return;
        }
        elements.name.value = '';
        elements.url.value = '';
        await this.refreshRemotesList(repo);
        this.app.components.branchList?.load(String(repo.path));
        this.app.showToast(t('settings.remoteAdded', { remote: name }), 'success');
      };
    }
    list?.querySelectorAll('[data-remote-name]').forEach(row => {
      const name = (row as HTMLElement).dataset.remoteName;
      row.querySelectorAll<HTMLElement>('[data-action]').forEach(button => {
        button.onclick = async () => {
          const action = (button as HTMLElement).dataset.action;
          if (action === 'remove') {
            const confirmed = await this.app.confirmDialog(
              t('settings.removeRemoteTitle'),
              t('settings.removeRemoteConfirm', { remote: name ?? '' }),
              t('settings.removeRemote'),
              true
            );
            if (!confirmed) return;
            const result = await window.gitTree.removeRemote(repo.path, name) as { error?: string };
            if (result?.error) {
              this.app.showToast(result.error, 'error');
              return;
            }
            await this.refreshRemotesList(repo);
            this.app.components.branchList?.load(String(repo.path));
            this.app.showToast(t('settings.remoteRemoved', { remote: name }), 'success');
          } else if (action === 'rename') {
            const nextName = await this.remotePrompt(
              t('settings.renameRemote'),
              t('settings.remoteName'),
              String(name)            );
            if (!nextName || nextName === name) return;
            const result = await window.gitTree.renameRemote(repo.path, name, nextName) as { error?: string };
            if (result?.error) {
              this.app.showToast(result.error, 'error');
              return;
            }
            await this.refreshRemotesList(repo);
            this.app.components.branchList?.load(String(repo.path));
            this.app.showToast(t('settings.remoteRenamed', { remote: nextName }), 'success');
          } else if (action === 'url') {
            const url = await this.remotePrompt(
              t('settings.changeRemoteUrl'),
              t('settings.remoteUrl'),
              row.querySelector('.settings-remote-url')?.textContent || ''
            );
            if (!url) return;
            const result = await window.gitTree.setRemoteUrl(repo.path, name, url) as { error?: string };
            if (result?.error) {
              this.app.showToast(result.error, 'error');
              return;
            }
            await this.refreshRemotesList(repo);
            this.app.showToast(t('settings.remoteUrlChanged', { remote: name }), 'success');
          }
        };
      });
    });
  }

  remotePrompt(title: string, label: string, value: string): Promise<string | null> {
    return new Promise(resolve => {
      const overlay = document.createElement('div');
      overlay.className = 'repository-picker-overlay';
      overlay.innerHTML = `
        <section class="repository-picker" role="dialog" aria-modal="true">
          <header class="repository-picker-header">
            <div>
              <span class="eyebrow">${this.esc(title)}</span>
              <h2>${this.esc(title)}</h2>
            </div>
          </header>
          <form class="clone-dialog-body remote-prompt-form">
            <label>
              <span>${this.esc(label)}</span>
              <input class="clone-url-input" type="text" value="${this.esc(value)}" spellcheck="false" autocomplete="off" required>
            </label>
            <p class="tag-create-error" data-prompt-error aria-live="polite"></p>
            <footer class="repository-picker-footer">
              <div>
                <button class="btn btn-secondary" type="button" data-action="cancel">${this.esc(t('common.cancel'))}</button>
                <button class="btn btn-primary" type="submit">${this.esc(t('common.continue'))}</button>
              </div>
            </footer>
          </form>
        </section>`;
      const finish = (result: string | null) => {
        overlay.remove();
        document.removeEventListener('keydown', keydown);
        resolve(result);
      };
      const keydown = (event: KeyboardEvent) => {
        if (event.key === 'Escape') finish(null);
      };
      document.body.appendChild(overlay);
      overlay.addEventListener('mousedown', (event: MouseEvent) => {
        if (event.target === overlay) finish(null);
      });
      overlay!.querySelector<HTMLElement>('[data-action="cancel"]')!.onclick = () => finish(null);
      overlay.querySelector('form')!.onsubmit = event => {
        event.preventDefault();
        const input = overlay.querySelector<HTMLInputElement>('input');
        const resultValue = input!.value.trim();
        if (!resultValue) return;
        finish(resultValue);
      };
      document.addEventListener('keydown', keydown);
      overlay!.querySelector<HTMLInputElement>('input')!.focus();
      overlay!.querySelector<HTMLInputElement>('input')!.select();
    });
  }

  focusSection(section: string): void {
    this.selectSection(section);
    const target = this.dialog.querySelector<HTMLElement>(`[data-settings-section="${section}"]`);
    target?.focus({ preventScroll: true });
  }

  selectSection(section: string): void {
    const sections = [...this.dialog.querySelectorAll<HTMLElement>('[data-settings-section]')];
    if (!sections.length) return;
    const selected = sections.some(item => item.dataset.settingsSection === section)
      ? section
      : sections[0].dataset.settingsSection;
    this.activeSection = selected ?? null;
    sections.forEach(item => {
      const active = item.dataset.settingsSection === selected;
      item.classList.toggle('is-active', active);
      item.toggleAttribute('hidden', !active);
      item.setAttribute('tabindex', active ? '-1' : '0');
    });
    this.dialog.querySelectorAll('[data-settings-nav]').forEach(button => {
      const active = (button as HTMLElement).dataset.settingsNav === selected;
      button.classList.toggle('is-active', active);
      button.toggleAttribute('aria-current', active);
    });
    this.dialog.querySelector('.settings-scroll')?.scrollTo({ top: 0 });
  }

  renderProfile(profile: SettingsProfile, assignedProfile: string | undefined, hasRepository: boolean): string {
    const assigned = profile.id === assignedProfile;
    return `<div class="settings-profile${assigned ? ' is-assigned' : ''}">
      <div class="settings-profile-avatar" aria-hidden="true">
        ${this.esc((profile.label || profile.name || '?').slice(0, 1).toUpperCase())}
      </div>
      <div class="settings-profile-copy">
        <strong>${this.esc(profile.label)}</strong>
        <span>${this.esc(profile.name)} · ${this.esc(profile.email)}</span>
      </div>
      ${profile.source === 'git-config'
        ? `<span class="badge badge-remote">${this.esc(t('settings.detected'))}</span>`
        : ''}
      ${assigned
        ? `<span class="badge badge-head">${this.esc(t('settings.assigned'))}</span>`
        : `<button class="btn btn-small" type="button" data-profile-apply="${this.esc(profile.id)}"
            ${hasRepository ? '' : 'disabled'}>${this.esc(t('settings.useForRepository'))}</button>`}
      <button class="btn-icon settings-profile-delete" type="button"
        data-profile-delete="${this.esc(profile.id)}"
        title="${this.esc(t('settings.deleteProfile'))}"
        aria-label="${this.esc(t('settings.deleteProfile'))}">
        <i class="ph ph-trash" aria-hidden="true"></i>
      </button>
    </div>`;
  }

  renderShortcut(label: string, action: string, description: string): string {
    return `<div class="settings-shortcut-row">
      <span class="settings-shortcut-copy">
        <strong>${this.esc(label)}</strong>
        <small>${this.esc(description)}</small>
      </span>
      <kbd>${this.esc(this.app.shortcutLabel(action))}</kbd>
    </div>`;
  }

  async exportDiagnostics(button: HTMLButtonElement, status: HTMLElement): Promise<void> {
    button.disabled = true;
    status.textContent = t('settings.exportingDiagnostics');
    try {
      const result = await window.gitTree.exportDiagnostics() as { canceled?: boolean; error?: string };
      if (result?.canceled) {
        status.textContent = '';
        return;
      }
      if (result?.error) {
        status.textContent = result.error;
        this.app.showToast(result.error, 'error');
        return;
      }
      status.textContent = t('settings.diagnosticsExported');
      this.app.showToast(t('settings.diagnosticsExported'), 'success');
    } catch (error) {
      const message = (error as Error)?.message || t('settings.diagnosticsFailed');
      status.textContent = message;
      this.app.showToast(message, 'error');
    } finally {
      button.disabled = false;
    }
  }

  bindSettingsEvents(repo: { path?: string } | null): void {
    (this.dialog.querySelector('[data-settings-close]') as HTMLElement).onclick = () => this.close();
    this.dialog.querySelectorAll<HTMLElement>('[data-settings-nav]').forEach(button => {
      button.onclick = () => this.selectSection(String(button.dataset.settingsNav));
    });
    this.overlay.onclick = event => {
      if (event.target === this.overlay) this.close();
    };

    const repoLink = this.dialog.querySelector('#about-repo-link');
    if (repoLink) {
      (repoLink as HTMLElement).onclick = event => {
        event.preventDefault();
        window.gitTree.openExternal('https://github.com/giannoccarol/gittree');
      };
    }

    const exportDiagnosticsButton = this.dialog.querySelector('#btn-export-diagnostics') as HTMLButtonElement | null;
    const exportDiagnosticsStatus = this.dialog.querySelector('#export-diagnostics-status');
    if (exportDiagnosticsButton && exportDiagnosticsStatus) {
      exportDiagnosticsButton.onclick = () => this.exportDiagnostics(
        exportDiagnosticsButton,
        exportDiagnosticsStatus as HTMLElement
      );
    }

    const vaultResetButton = this.dialog.querySelector('#settings-vault-reset') as HTMLButtonElement | null;
    if (vaultResetButton) {
      vaultResetButton.onclick = async () => {
        if (!(await this.confirmVaultReset?.())) return;
        const result = await window.gitTree.resetHostingVault() as { error?: string };
        if (result?.error) { this.app.showToast(result.error, 'error'); return; }
        this.app.showToast(t('settings.vaultResetDone'), 'success');
      };
    }

    this.dialog.querySelectorAll<HTMLElement>('[data-theme-choice]').forEach(button => {
      button.onclick = () => {
        Theme.apply(String((button as HTMLElement).dataset.themeChoice), true);
        this.syncAppearanceState();
        this.app.pushInspectorPayload?.();
      };
    });
    this.dialog.querySelectorAll<HTMLElement>('[data-tone-choice]').forEach(button => {
      button.onclick = () => {
        const toneTheme = (button as HTMLElement).dataset.toneTheme;
        Theme.setTone(String(toneTheme), String((button as HTMLElement).dataset.toneChoice ?? ''));
        if (document.documentElement.dataset.theme !== toneTheme) {
          Theme.apply(toneTheme, true);
        }
        this.syncAppearanceState();
        this.app.pushInspectorPayload?.();
      };
    });

    this.dialog.querySelectorAll<HTMLInputElement>('[data-toolbar-toggle]').forEach(input => {
      input.onchange = () => {
        const visibility = this.app.readToolbarVisibility();
        visibility[String(input.dataset.toolbarToggle)] = input.checked;
        localStorage.setItem('gittree.settings.toolbar', JSON.stringify(visibility));
        this.app.applyToolbarVisibility();
      };
    });

    const projectToggle = this.dialog.querySelector('[data-auto-fetch-project]');
    const projectInterval = this.dialog.querySelector('[data-auto-fetch-project-interval]');
    const projectRemote = this.dialog.querySelector('[data-auto-fetch-project-remote]');
    const saveProject = () => this.saveProjectSchedule(
      repo,
      (projectRemote as HTMLSelectElement | null)?.value ?? '',
      Boolean((projectToggle as HTMLInputElement | null)?.checked),
      ((projectInterval as HTMLSelectElement | null)?.value ?? '15')
    );
    if (projectToggle) (projectToggle as HTMLInputElement).onchange = saveProject;
    if (projectInterval) (projectInterval as HTMLSelectElement).onchange = saveProject;
    if (projectRemote) (projectRemote as HTMLSelectElement).onchange = saveProject;

    (this.dialog.querySelector('#settings-account-form') as HTMLFormElement).onsubmit = event => {
      event.preventDefault();
      const form = event.currentTarget as HTMLFormElement;
      const elements = form.elements as unknown as Record<string, HTMLInputElement>;
      const profiles = this.readArray(this.profilesStorageKey);
      profiles.push({
        id: crypto.randomUUID(),
        label: elements.label.value.trim(),
        name: elements.name.value.trim(),
        email: elements.email.value.trim()
      });
      localStorage.setItem(this.profilesStorageKey, JSON.stringify(profiles));
      this.open();
    };

    this.bindRemotes(repo);
    const rootButton = this.dialog.querySelector('#settings-agent-root');
    if (rootButton) {
      (rootButton as HTMLElement).onclick = async () => {
        const result = await window.gitTree.chooseAgentWorktreeRoot() as { error?: string; worktreeRoot?: string };
        if (result?.error) return this.app.showToast(result.error, 'error');
        if (result?.worktreeRoot) (this.dialog.querySelector('#agent-root-value') as HTMLElement).textContent = result.worktreeRoot;
      };
    }
    const agentsEnabled = this.dialog.querySelector('#settings-agents-enabled') as HTMLInputElement | null;
    if (agentsEnabled) {
      agentsEnabled.onchange = async () => {
        const result = await window.gitTree.setAgentSessionsEnabled(agentsEnabled.checked) as { error?: string };
        if (result?.error) {
          (agentsEnabled as HTMLInputElement).checked = !(agentsEnabled as HTMLInputElement).checked;
          this.app.showToast(result.error, 'error');
          return;
        }
        window.dispatchEvent(new CustomEvent('gittree:agent-settings-changed', { detail: result }));
      };
    }
    const concurrency = this.dialog.querySelector('#settings-agent-concurrency') as HTMLInputElement | null;
    if (concurrency) {
      concurrency.onchange = async () => {
        const result = await window.gitTree.setAgentConcurrency(Number(concurrency.value)) as { error?: string; maxConcurrent?: number };
        if (result?.error) this.app.showToast(result.error, 'error');
        else concurrency.value = String(result.maxConcurrent);
      };
    }
    this.bindAgentAdapters();
    this.dialog.querySelectorAll<HTMLElement>('[data-profile-apply]').forEach(button => {
      button.onclick = async () => {
        const profile = (this.readArray(this.profilesStorageKey) as SettingsProfile[])
          .find(item => item.id === button.dataset.profileApply);
        if (!repo || !profile) return;
        const result = await window.gitTree.setIdentity(repo.path, {
          name: profile.name,
          email: profile.email,
          scope: 'local'
        }) as { error?: string };
        if (result?.error) {
          this.app.showToast(result.error, 'error');
          return;
        }
        const assignments = this.readObject(this.assignmentsStorageKey);
        assignments[String(repo.path)] = profile.id;
        localStorage.setItem(this.assignmentsStorageKey, JSON.stringify(assignments));
        this.app.showToast(t('settings.profileApplied'), 'success');
        await this.open();
      };
    });
    this.dialog.querySelectorAll<HTMLElement>('[data-profile-delete]').forEach(button => {
      button.onclick = () => {
        const id = button.dataset.profileDelete;
        const profiles = (this.readArray(this.profilesStorageKey) as SettingsProfile[]).filter(item => item.id !== id);
        const assignments = this.readObject(this.assignmentsStorageKey);
        Object.keys(assignments).forEach(path => {
          if (assignments[path] === id) delete assignments[path];
        });
        localStorage.setItem(this.profilesStorageKey, JSON.stringify(profiles));
        localStorage.setItem(this.assignmentsStorageKey, JSON.stringify(assignments));
        this.open();
      };
    });

    const checkUpdateBtn = this.dialog.querySelector('#btn-check-update') as HTMLButtonElement | null;
    const checkUpdateStatus = this.dialog.querySelector('#check-update-status');

    if (checkUpdateBtn) {
      checkUpdateBtn.onclick = async () => {
        const status = this.updateState?.status;
        if (status === 'downloaded') {
          await window.gitTree.installUpdate();
          return;
        }
        if (status === 'available') {
          const result = await window.gitTree.downloadUpdate() as { state?: Record<string, unknown>; error?: string };
          this.handleUpdateState(result?.state || { status: 'error', error: result?.error });
          return;
        }
        checkUpdateBtn.disabled = true;
        checkUpdateStatus!.textContent = t('settings.checking');
        const result = await window.gitTree.checkForUpdates() as { state?: Record<string, unknown>; error?: string };
        this.handleUpdateState(result?.state || { status: 'error', error: result?.error });
      };
    }
    this.refreshUpdateState();
    this.bindAiSettings();
  }

  bindAiSettings(): void {
    const provider = this.dialog.querySelector('#settings-ai-provider') as HTMLSelectElement | null;
    if (!provider) return;
    const syncFields = () => this.syncAiFields();
    provider.onchange = syncFields;
    syncFields();

    (this.dialog.querySelector('#btn-ai-save') as HTMLElement).onclick = async () => {
      const result = await window.gitTree.setAiSettings({
        provider: provider.value,
        baseUrl: (this.dialog.querySelector('#settings-ai-base-url') as HTMLInputElement).value,
        model: (this.dialog.querySelector('#settings-ai-model') as HTMLInputElement).value,
        language: (this.dialog.querySelector('#settings-ai-language') as HTMLSelectElement).value
      }) as { error?: string };
      if (result?.error) this.app.showToast(result.error, 'error');
      else this.app.showToast(t('ai.saved'), 'success');
    };

    (this.dialog.querySelector('#btn-ai-key-save') as HTMLElement).onclick = async () => {
      const input = this.dialog.querySelector('#settings-ai-key') as HTMLInputElement;
      const result = await window.gitTree.setAiKey(input.value) as { error?: string };
      if (result?.error) {
        this.app.showToast(result.error, 'error');
        return;
      }
      input.value = '';
      this.syncAiKeyStatus(true);
      this.app.showToast(t('ai.keySaved'), 'success');
    };

    (this.dialog.querySelector('#btn-ai-key-remove') as HTMLElement).onclick = async () => {
      await window.gitTree.clearAiKey();
      this.syncAiKeyStatus(false);
      this.app.showToast(t('ai.keyRemoved'), 'success');
    };

    (this.dialog.querySelector('#btn-ai-test') as HTMLElement).onclick = async () => {
      const button = this.dialog.querySelector('#btn-ai-test') as HTMLButtonElement;
      const status = this.dialog.querySelector('#ai-test-status') as HTMLElement;
      button.disabled = true;
      status.textContent = t('ai.testing');
      const result = await window.gitTree.testAiConnection() as { error?: string };
      button.disabled = false;
      if (result?.error) {
        status.textContent = `${t('ai.testFailed')}: ${result.error}`;
        return;
      }
      status.textContent = t('ai.testOk');
    };

    this.hydrateOpencodeStatus();
  }

  syncAiFields(): void {
    const provider = (this.dialog.querySelector('#settings-ai-provider') as HTMLSelectElement | null)?.value;
    const status = this.dialog.querySelector('#ai-opencode-status');
    const modelHelp = this.dialog.querySelector('#ai-model-help');
    if (!provider) return;
    const show = (field: string) => {
      this.dialog.querySelectorAll(`[data-ai-field="${field}"]`)
        .forEach(row => row.classList.toggle('is-hidden', false));
    };
    const hide = (field: string) => {
      this.dialog.querySelectorAll(`[data-ai-field="${field}"]`)
        .forEach(row => row.classList.toggle('is-hidden', true));
    };
    if (modelHelp) {
      modelHelp.textContent = provider === 'opencode'
        ? t('ai.modelOpencodeHelp')
        : t('ai.modelHelp');
    }
    if (provider === 'opencode') {
      ['baseUrl', 'key', 'test'].forEach(hide);
      show('model'); show('language');
      if (status) status.textContent = t('ai.opencodeHelp');
    } else if (provider === 'anthropic') {
      show('model'); show('key'); show('test'); show('language');
      hide('baseUrl');
      if (status) status.textContent = '';
    } else {
      ['baseUrl', 'model', 'key', 'test', 'language'].forEach(show);
      if (status) status.textContent = '';
    }
  }

  syncAiKeyStatus(configured: boolean): void {
    const status = this.dialog.querySelector('#ai-key-status');
    const remove = this.dialog.querySelector('#btn-ai-key-remove') as HTMLButtonElement | null;
    if (status) {
      status.textContent = configured ? t('ai.apiKeySaved') : t('ai.apiKeyMissing');
    }
    if (remove) remove.disabled = !configured;
  }

  async hydrateOpencodeStatus(): Promise<void> {
    const status = this.dialog.querySelector('#ai-opencode-status');
    if (!status) return;
    const adapters = await window.gitTree.detectAgentAdapters?.().catch((): AgentAdapterInfo[] => []);
    const opencode = (Array.isArray(adapters) ? adapters : [])
      .find(adapter => adapter?.id === 'opencode');
    if ((this.dialog.querySelector('#settings-ai-provider') as HTMLSelectElement | null)?.value !== 'opencode') return;
    status.textContent = opencode?.available
      ? t('ai.opencodeDetected', { version: opencode.version || '' })
      : t('ai.opencodeMissing');
  }

  async refreshUpdateState(): Promise<void> {
    const state = await window.gitTree.getUpdateState() as Record<string, unknown>;
    if (state) this.handleUpdateState(state);
  }

  renderAgentAdapterRow(adapter: AgentAdapterInfo, agentSettings: { enabledAdapters?: string[] } | null): string {
    return `<label class="settings-toolbar-row">
      <div class="settings-toolbar-copy"><strong>${this.esc(adapter.label)}</strong><small>${this.esc(adapter.version || t(adapter.available ? 'agents.detected' : 'agents.cliNotFound'))}</small></div>
      <span class="agent-adapter-state ${adapter.available ? 'is-available' : ''}">${this.esc(t(adapter.available ? 'agents.detected' : 'agents.unavailable'))}</span>
      <span class="settings-switch"><input type="checkbox" data-agent-adapter="${this.esc(adapter.id)}"${agentSettings?.enabledAdapters?.includes(adapter.id) ? ' checked' : ''}><span aria-hidden="true"></span></span>
    </label>`;
  }

  async hydrateAgentAdapters(agentSettings: AgentSettingsPayload | null, generation: number): Promise<void> {
    const adapters = await window.gitTree.detectAgentAdapters?.().catch((): AgentAdapterInfo[] => []);
    if (generation !== this.renderGeneration) return;
    const container = this.dialog.querySelector('.agent-adapter-settings');
    if (!container) return;
    container.innerHTML = (Array.isArray(adapters) ? adapters : [])
      .map(adapter => this.renderAgentAdapterRow(adapter, agentSettings))
      .join('');
    this.bindAgentAdapters();
  }

  bindAgentAdapters(): void {
    this.dialog.querySelectorAll<HTMLInputElement>('[data-agent-adapter]').forEach(input => {
      input.onchange = async () => {
        const enabled = [...this.dialog.querySelectorAll<HTMLInputElement>('[data-agent-adapter]')]
          .filter(item => item.checked)
          .map(item => (item as HTMLElement).dataset.agentAdapter);
        const result = await window.gitTree.setEnabledAgentAdapters(enabled) as { error?: string };
        if (result?.error) {
          (input as HTMLInputElement).checked = !(input as HTMLInputElement).checked;
          this.app.showToast(result.error, 'error');
        }
      };
    });
  }

  handleUpdateState(state: Record<string, unknown>): void {
    if (!state) return;
    this.updateState = state;
    const button = this.dialog.querySelector('#btn-check-update') as HTMLButtonElement | null;
    const status = this.dialog.querySelector('#check-update-status') as HTMLElement | null;
    this.applyUpdateState(status, button, state);
  }

  applyUpdateState(statusEl: HTMLElement | null, button: HTMLButtonElement | null, state: Record<string, unknown>): void {
    if (!statusEl || !button) return;
    const status = state?.status;
    const label = button.querySelector('span');
    button.disabled = ['checking', 'downloading', 'disabled'].includes(status as string);
    switch (status) {
      case 'checking':
        statusEl.textContent = t('settings.checking');
        break;
      case 'available':
        statusEl.textContent = `${t('settings.updateAvailable')} (${state.availableVersion})`;
        if (label) label.textContent = t('settings.downloadUpdate');
        break;
      case 'downloading':
        statusEl.textContent = `${t('settings.downloading')} ${state.progress}%`;
        break;
      case 'downloaded':
        statusEl.textContent = t('settings.updateReady');
        if (label) label.textContent = t('settings.installUpdate');
        break;
      case 'error':
        statusEl.textContent = String(state.error || t('common.error'));
        if (label) label.textContent = t('settings.checkUpdate');
        break;
      case 'disabled':
        statusEl.textContent = t('settings.updateUnavailable');
        break;
      default:
        statusEl.textContent = t('settings.upToDate');
        if (label) label.textContent = t('settings.checkUpdate');
    }
  }

  saveProjectSchedule(repo: { path?: string } | null, remote: string, enabled: boolean, intervalMinutes: string | number): void {
    if (!repo || !remote) return;
    const schedules: Record<string, unknown> = this.readObject(this.autoFetchStorageKey);
    const minutes = Math.min(60, Math.max(1, Number(intervalMinutes) || 15));
    schedules[String(repo.path)] = {
      enabled: Boolean(enabled),
      intervalMinutes: minutes,
      remote,
      nextRunAt: Date.now() + (minutes * 60000)
    };
    localStorage.setItem(this.autoFetchStorageKey, JSON.stringify(schedules));
  }

  async readRepositoryIdentity(repoPath: string): Promise<{ configured?: boolean; name?: string; email?: string; nameSource?: string; error?: string } | null> {
    try {
      const identity = await window.gitTree.getIdentity(repoPath) as { error?: string } | undefined;
      return identity?.error ? null : (identity as { configured?: boolean; name?: string; email?: string; nameSource?: string });
    } catch {
      return null;
    }
  }

  importConfiguredProfile(
    profiles: SettingsProfile[],
    assignments: Record<string, unknown>,
    repoPath: string,
    identity: { name?: string; email?: string; nameSource?: string }
  ): { profiles: SettingsProfile[]; changed: boolean } {
    const name = String(identity.name || '').trim();
    const email = String(identity.email || '').trim();
    if (!name || !email) return { profiles, changed: false };
    const normalizedEmail = email.toLowerCase();
    let changed = false;
    let profile = profiles.find(item => (
      item.source === 'git-config' &&
      String(item.email || '').toLowerCase() === normalizedEmail
    ));
    if (profile) {
      if (profile.name !== name) { profile.name = name; changed = true; }
      const expectedLabel = identity.nameSource === 'local'
        ? 'Repository Git config'
        : 'Global Git config';
      if (profile.label !== expectedLabel) { profile.label = expectedLabel; changed = true; }
    } else {
      profile = {
        id: `git-config:${encodeURIComponent(normalizedEmail)}`,
        label: identity.nameSource === 'local' ? 'Repository Git config' : 'Global Git config',
        name,
        email,
        source: 'git-config'
      };
      profiles.push(profile);
      changed = true;
    }
    const assignment = assignments[repoPath];
    const assignedProfile = profiles.find(item => item.id === assignment);
    if (!assignedProfile) {
      assignments[repoPath] = profile.id;
      changed = true;
    }
    return { profiles, changed };
  }

  async tick(now = Date.now()): Promise<void> {
    const schedules: Record<string, unknown> = this.readObject(this.autoFetchStorageKey);
    let changed = false;
    const refreshedRepositories = new Set<string>();
    for (const [repoPath, rawSchedule] of Object.entries(schedules)) {
      const schedule = rawSchedule as { enabled?: boolean; nextRunAt?: number; intervalMinutes?: number; remote?: string } | undefined;
      if (!schedule || !schedule.enabled || (schedule.nextRunAt ?? Infinity) > now) continue;
      const key = repoPath;
      if (this.inFlight.has(key)) continue;
      this.inFlight.add(key);
      try {
        const result = await window.gitTree.fetch(repoPath, schedule.remote) as { error?: string };
        if (result?.error && this.app.state.repo?.path === repoPath) {
          this.app.showToast(result.error, 'error');
        }
        if (!result?.error) refreshedRepositories.add(repoPath);
      } catch (error) {
        if (this.app.state.repo?.path === repoPath) {
          this.app.showToast((error as Error).message, 'error');
        }
      } finally {
        schedule.nextRunAt = Date.now() + ((schedule.intervalMinutes ?? 15) * 60000);
        this.inFlight.delete(key);
        changed = true;
      }
    }
    if (changed) localStorage.setItem(this.autoFetchStorageKey, JSON.stringify(schedules));
    if (this.app.state.repo && refreshedRepositories.has(this.app.state.repo.path)) {
      await this.app.refresh({ silent: true });
    }
  }

  readProjectSchedule(value: unknown, metadata: BranchListMetadata | null | undefined = {}): Record<string, unknown> {
    if (value && typeof (value as Record<string, unknown>).enabled === 'boolean') return value as Record<string, unknown>;
    const legacy = Object.values(value || {}).find(item => (item as Record<string, unknown>)?.enabled) as Record<string, unknown> | undefined;
    if (legacy) return {
      enabled: true,
      intervalMinutes: legacy.intervalMinutes || 15,
      remote: legacy.remote || metadata?.remotes?.[0]?.name || '',
      nextRunAt: legacy.nextRunAt || Date.now()
    };
    return {
      enabled: false,
      intervalMinutes: 15,
      remote: (((metadata?.remotes as Array<{ name?: string }> | undefined) || [])[0]?.name || '')
    };
  }

  readArray<T = Record<string, unknown>>(key: string): T[] {
    try {
      const value: unknown = JSON.parse(localStorage.getItem(key) ?? 'null');
      return Array.isArray(value) ? value as T[] : [];
    } catch {
      return [];
    }
  }

  readObject(key: string): Record<string, unknown> {
    try {
      const value: unknown = JSON.parse(localStorage.getItem(key) ?? 'null');
      return value && typeof value === 'object' && !Array.isArray(value) ? value as Record<string, unknown> : {};
    } catch {
      return {};
    }
  }

  esc(value: unknown): string {
    return HtmlEncoder.encode(value);
  }
}

if (typeof window !== 'undefined') {
  (window as unknown as { SettingsView: typeof SettingsView }).SettingsView = SettingsView;
}

declare const module: { exports: unknown } | undefined;
if (typeof module !== 'undefined' && (module as { exports?: unknown }).exports) {
  (module as { exports: unknown }).exports = SettingsView;
}
