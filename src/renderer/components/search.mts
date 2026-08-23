

interface SearchItem {
  type: string;
  label: string;
  subtitle: string;
  detail: string;
  data: Record<string, unknown>;
}

import type { GitTreeApp } from '../app.mts';

export class GlobalSearch {
  app: GitTreeApp;
  overlay: HTMLElement;
  input: HTMLInputElement;
  results: HTMLElement;
  filters: HTMLElement;
  aiButton: HTMLElement | null;
  allData: SearchItem[];
  selectedIdx: number;
  visible: boolean;
  aiSearching: boolean;

  constructor(app: GitTreeApp) {
    this.app = app;
    this.overlay = document.getElementById('search-overlay')! as HTMLElement;
    this.input = document.getElementById('search-input')! as HTMLInputElement;
    this.results = document.getElementById('search-results')! as HTMLElement;
    this.filters = document.getElementById('search-filters')! as HTMLElement;
    this.aiButton = document.getElementById('search-ai-ask')!;
    this.allData = [];
    this.selectedIdx = -1;
    this.visible = false;
    this.aiSearching = false;
  }

  init(): void {
    document.addEventListener('keydown', e => {
      if (e.key === 'Escape' && this.visible) { this.hide(); return; }
      if (
        this.app.isPrimaryModifier(e) &&
        !e.shiftKey &&
        !e.altKey &&
        e.key.toLowerCase() === 'p'
      ) {
        e.preventDefault();
        this.toggle();
        return;
      }
    });

    document.getElementById('global-search')!.addEventListener('click', () => this.show());
    document.getElementById('global-search')!.addEventListener('focus', () => this.show());

    this.input.addEventListener('input', () => this.search());
    this.input.addEventListener('keydown', e => this.handleKey(e));
    if (this.aiButton) {
      this.aiButton.onclick = () => this.askAi();
    }

    this.overlay.addEventListener('click', (e) => {
      if (e.target === this.overlay) this.hide();
    });
  }

  async show(): Promise<void> {
    this.visible = true;
    this.overlay.classList.remove('is-hidden');
    this.input.value = '';
    this.selectedIdx = -1;
    this.allData = [];
    this.results.innerHTML = '';
    this.filters.innerHTML = '';
    if (this.aiButton) {
      (this.aiButton as HTMLButtonElement).disabled = !this.app.state.repo;
    }

    if (this.app.state.repo) {
      try {
        const [branches, log, status] = await Promise.all([
          window.gitTree.getBranches(this.app.state.repo.path),
          window.gitTree.getLog(this.app.state.repo.path, 50),
          window.gitTree.getStatus(this.app.state.repo.path)
        ]) as [
          { branches?: Record<string, unknown>; current?: string } | undefined,
          { all?: Array<{ message: string; hash: string; author_name: string; date: string }> } | undefined,
          { files?: Array<{ path: string; working_dir?: string; index?: string }> } | undefined
        ];
        if (branches?.branches) {
          for (const name of Object.keys(branches.branches)) {
            this.allData.push({
              type: 'branch', label: name, subtitle: name.startsWith('remotes/') ? 'remote' : 'local',
              detail: name.startsWith('remotes/') ? 'Remote branch' : (name === branches.current ? 'Current branch' : 'Local branch'),
              data: { name, remote: name.startsWith('remotes/') }
            });
          }
        }
        if (log?.all) {
          log.all.forEach(c => {
            this.allData.push({
              type: 'commit', label: c.message.split('\n')[0], subtitle: c.hash.substring(0, 7),
              detail: `${c.author_name} — ${this.fmtDate(c.date)}`, data: { hash: c.hash }
            });
          });
        }
        if (status?.files) {
          status.files.forEach(f => {
            this.allData.push({
              type: 'file', label: f.path, subtitle: f.working_dir || f.index || '', detail: 'Modified',
              data: { path: f.path }
            });
          });
        }
      } catch { /* search data is best effort */ }
    }

    if (this.app.components.repoTabs?.repos) {
      this.app.components.repoTabs.repos.forEach(r => {
        this.allData.push({ type: 'repo', label: r.name || '', subtitle: r.path, detail: 'Repository', data: { path: r.path } });
      });
    }

    this.allData.push(
      { type: 'action', label: t('actions.fetch'), subtitle: '', detail: t('actions.fetch'), data: { action: 'fetch' } },
      { type: 'action', label: t('actions.pull'), subtitle: '', detail: t('actions.pull'), data: { action: 'pull' } },
      { type: 'action', label: t('actions.push'), subtitle: '', detail: t('actions.push'), data: { action: 'push' } },
      { type: 'action', label: t('actions.createBranch'), subtitle: '', detail: t('actions.createBranch'), data: { action: 'create-branch' } }
    );

    setTimeout(() => this.input.focus(), 50);
  }

  hide(): void {
    this.visible = false;
    this.overlay.classList.add('is-hidden');
  }

  toggle(): void {
    if (this.visible) this.hide(); else this.show();
  }

  search(): void {
    const q = this.input.value.trim().toLowerCase();
    this.selectedIdx = -1;
    if (!q) { this.renderResults([]); return; }

    let filtered = this.allData.filter(item =>
      item.label.toLowerCase().includes(q) ||
      item.subtitle.toLowerCase().includes(q) ||
      item.detail.toLowerCase().includes(q)
    );

    // Filter syntax: branch:, author:, file:, message:
    const m = q.match(/^(branch|author|file|message|type):(.+)/);
    if (m) {
      const [, key, val] = m;
      const v = val.toLowerCase().trim();
      if (key === 'branch') filtered = this.allData.filter(i => i.type === 'branch' && i.label.toLowerCase().includes(v));
      else if (key === 'author') filtered = this.allData.filter(i => i.type === 'commit' && i.detail.toLowerCase().includes(v));
      else if (key === 'file') filtered = this.allData.filter(i => i.type === 'file' && i.label.toLowerCase().includes(v));
      else if (key === 'message') filtered = this.allData.filter(i => i.type === 'commit' && i.label.toLowerCase().includes(v));
      else if (key === 'type') filtered = this.allData.filter(i => i.type === v);
    }

    this.renderResults(filtered);
  }

  async askAi(): Promise<void> {
    const repo = this.app.state.repo;
    if (!repo || this.aiSearching) return;
    const query = this.input.value.trim();
    if (query.length < 3) {
      this.app.showToast(t('search.aiQueryShort'), 'warning');
      return;
    }
    this.aiSearching = true;
    this.setAiSearching(true);
    try {
      const result = await window.gitTree.searchHistory(repo.path, {
        query,
        language: await this.aiLanguage()
      }) as { error?: string; matches?: Array<{ subject?: string; hash?: string; reason?: string }> } | undefined;
      if (result?.error) {
        this.app.showToast(result.error, 'error');
        return;
      }
      const matches = result?.matches || [];
      if (!matches.length) {
        this.renderResults([]);
        this.app.showToast(t('search.aiNoMatches'), 'warning');
        return;
      }
      this.renderResults(matches.map(match => ({
        type: 'commit',
        label: String(match.subject || match.hash || ''),
        subtitle: String(match.hash || '').slice(0, 7),
        detail: match.reason || '',
        data: { hash: String(match.hash ?? '') }
      })));
    } finally {
      this.aiSearching = false;
      this.setAiSearching(false);
    }
  }

  setAiSearching(searching: boolean): void {
    const button = this.aiButton as HTMLButtonElement | null;
    if (!button) return;
    const icon = button.querySelector('i') as HTMLElement;
    const label = button.querySelector('span') as HTMLElement;
    button.disabled = searching;
    if (searching) {
      icon.className = 'ph ph-circle-notch';
      label.textContent = t('search.aiSearching');
      return;
    }
    icon.className = 'ph ph-sparkle';
    label.textContent = t('search.aiSearch');
    button.disabled = !this.app.state.repo;
  }

  async aiLanguage(): Promise<string> {
    const settings = await window.gitTree.getAiSettings().then(
      (value): { language?: string } | null => (value ?? null) as { language?: string } | null,
      (): null => null
    );
    if (settings?.language === 'en' || settings?.language === 'it') {
      return settings.language;
    }
    const current = localStorage.getItem('gittree.language') || 'en';
    return current.startsWith('it') ? 'it' : 'en';
  }

  renderResults(items: SearchItem[]): void {
    this.results.innerHTML = '';
    if (!items.length && this.input.value.trim()) {
      this.results.innerHTML = `<div class="search-empty">${t('search.empty')}</div>`;
      return;
    }

    const grouped: Record<string, SearchItem[]> = {};
    items.forEach(i => { if (!grouped[i.type]) grouped[i.type] = []; grouped[i.type].push(i); });

    for (const [type, group] of Object.entries(grouped)) {
      const header = document.createElement('div');
      header.className = 'search-section-header';
      header.textContent = this.groupLabel(type);
      this.results.appendChild(header);

      group.forEach(item => {
        const el = document.createElement('div');
        el.className = 'search-result-item';
        el.innerHTML = `
          <span class="search-result-icon"><i class="${this.iconForType(type)}"></i></span>
          <span class="search-result-content">
            <div class="search-result-title">${this.highlight(item.label, this.input.value)}</div>
            <div class="search-result-subtitle">${this.esc(item.subtitle)}</div>
          </span>
          <span class="search-result-meta">${this.esc(item.detail)}</span>
        `;
        el.onclick = () => this.select(item);
        this.results.appendChild(el);
      });
    }
  }

  iconForType(type: string): string {
    const icons: Record<string, string> = {
      branch: 'ph ph-git-branch',
      commit: 'ph ph-git-commit',
      file: 'ph ph-file-code',
      repo: 'ph ph-folder-simple',
      tag: 'ph ph-tag',
      action: 'ph ph-command'
    };
    return icons[type] || 'ph ph-circle';
  }

  groupLabel(type: string): string {
    const labels: Record<string, string> = {
      branch: t('search.branches'),
      commit: t('search.commits'),
      file: t('search.files'),
      repo: t('search.repositories'),
      tag: t('sidebar.tags'),
      action: t('search.actions')
    };
    return labels[type] || type;
  }

  highlight(text: string, query: string): string {
    if (!query) return this.esc(text);
    const safeQuery = this.esc(query).replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
    const re = new RegExp(`(${safeQuery})`, 'gi');
    return this.esc(text).replace(re, '<span class="highlight">$1</span>');
  }

  esc(value: unknown): string { return HtmlEncoder.encode(value); }

  handleKey(e: KeyboardEvent): void {
    const items = this.results.querySelectorAll<HTMLElement>('.search-result-item');
    if (e.key === 'ArrowDown') { e.preventDefault(); this.selectedIdx = Math.min(this.selectedIdx + 1, items.length - 1); this.updateSelection(items); }
    else if (e.key === 'ArrowUp') { e.preventDefault(); this.selectedIdx = Math.max(this.selectedIdx - 1, 0); this.updateSelection(items); }
    else if (e.key === 'Enter' && this.selectedIdx >= 0) { e.preventDefault(); items[this.selectedIdx]?.click(); this.hide(); }
  }

  updateSelection(items: NodeListOf<HTMLElement>): void {
    items.forEach((el, i) => el.classList.toggle('selected', i === this.selectedIdx));
    const sel = items[this.selectedIdx];
    if (sel) sel.scrollIntoView({ block: 'nearest' });
  }

  select(item: SearchItem): void {
    this.hide();
    if (item.type === 'branch') {
      if ((item.data.name as string).startsWith('remotes/')) {
        const local = (item.data.name as string).replace('remotes/', '').split('/').pop() ?? '';
        this.app.components.branchList.checkoutRemote(local, (item.data.name as string).replace('remotes/', ''));
      } else {
        this.app.components.branchList.checkout(item.data.name as string);
      }
    } else if (item.type === 'commit') {
      this.app.emit('commit:selected', item.data.hash);
    } else if (item.type === 'action') {
      if (item.data.action === 'fetch') this.app.doFetch();
      else if (item.data.action === 'pull') this.app.doPull();
      else if (item.data.action === 'push') this.app.doPush();
      else if (item.data.action === 'create-branch') this.app.components.branchList.promptCreateBranch();
    } else if (item.type === 'repo') {
      const index = this.app.components.repoTabs.repos.findIndex(repo => repo.path === item.data.path);
      if (index >= 0) this.app.components.repoTabs.selectRepo(index);
    }
  }

  fmtDate(d: unknown): string {
    if (!d) return '';
    return new Date(d as string).toLocaleDateString([], { month: 'short', day: 'numeric', year: 'numeric' });
  }
}

if (typeof window !== 'undefined') {
  (window as unknown as { GlobalSearch: typeof GlobalSearch }).GlobalSearch = GlobalSearch;
}

declare const module: { exports: unknown } | undefined;
if (typeof module !== 'undefined' && (module as { exports?: unknown }).exports) {
  (module as { exports: unknown }).exports = GlobalSearch;
}
