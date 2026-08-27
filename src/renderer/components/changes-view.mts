import type { ChangesFileList } from './changes-file-list.mts';
import type { GitTreeApp } from '../app.mts';
import type { NumberableHunk } from './diff-parser.mts';
import { onAgentsFeatureEnabledChange } from '../ai-feature-gate.mts';

interface ChangeFile {
  path: string;
  staged?: boolean;
  unstaged?: boolean;
  submodule?: boolean;
  conflicted?: boolean;
  untracked?: boolean;
  indexStatus?: string;
  worktreeStatus?: string;
}

interface WorkingTreeSnapshot {
  error?: string;
  snapshotId: string;
  files: ChangeFile[];
  submodules?: unknown[];
}

interface IdentityInfo {
  error?: string;
  configured?: boolean;
  name?: string;
  email?: string;
  signing?: { available?: boolean; enabledByDefault?: boolean; format?: string };
}


export class ChangesView {
  root: HTMLElement;
  app: GitTreeApp;
  repoPath: string | null;
  snapshot: WorkingTreeSnapshot | null;
  identity: IdentityInfo | null;
  active: boolean;
  inflight: Promise<WorkingTreeSnapshot | null> | null;
  pollTimer: ReturnType<typeof setInterval> | null;
  selected: { path: string; staged: boolean } | null;
  diffRequest: number;
  generatingCommit: boolean;
  generatingExplain: boolean;
  rowHeight: number;
  overscan: number;
  fileLists: { unstaged: ChangesFileList; staged: ChangesFileList };
  elements: Record<string, HTMLElement>;

  constructor(root: HTMLElement, app: GitTreeApp) {
    this.root = root;
    this.app = app;
    this.repoPath = null;
    this.snapshot = null;
    this.identity = null;
    this.active = false;
    this.inflight = null;
    this.pollTimer = null;
    this.selected = null;
    this.diffRequest = 0;
    this.generatingCommit = false;
    this.generatingExplain = false;
    this.rowHeight = 38;
    this.overscan = 8;
    const ChangesFileListCtor = (window as unknown as { ChangesFileList: typeof ChangesFileList }).ChangesFileList;
    this.fileLists = {
      unstaged: new ChangesFileListCtor(
        document.getElementById('unstaged-files')!,
        { rowHeight: this.rowHeight, overscan: this.overscan }
      ),
      staged: new ChangesFileListCtor(
        document.getElementById('staged-files')!,
        { rowHeight: this.rowHeight, overscan: this.overscan }
      )
    };
    this.fileLists.unstaged.mount();
    this.fileLists.staged.mount();
    this.elements = {
      unstaged: document.getElementById('unstaged-files')!,
      staged: document.getElementById('staged-files')!,
      unstagedCount: document.getElementById('unstaged-count')!,
      stagedCount: document.getElementById('staged-count')!,
      modeCount: document.getElementById('workspace-changes-count')!,
      stageAll: document.getElementById('btn-stage-all')!,
      unstageAll: document.getElementById('btn-unstage-all')!,
      discardAll: document.getElementById('btn-discard-all')!,
      submoduleBar: document.getElementById('submodule-bar')!,
      submodulesInit: document.getElementById('btn-submodules-init')!,
      submodulesUpdate: document.getElementById('btn-submodules-update')!,
      composer: document.getElementById('commit-composer')!,
      summary: document.getElementById('commit-summary')!,
      body: document.getElementById('commit-body')!,
      amend: document.getElementById('commit-amend')!,
      signoff: document.getElementById('commit-signoff')!,
      signing: document.getElementById('commit-signing')!,
      signingLabel: document.getElementById('commit-signing-label')!,
      authorToggle: document.getElementById('commit-author-toggle')!,
      authorFields: document.getElementById('commit-author-fields')!,
      authorName: document.getElementById('commit-author-name')!,
      authorEmail: document.getElementById('commit-author-email')!,
      identityStatus: document.getElementById('commit-identity-status')!,
      identityButton: document.getElementById('btn-commit-identity')!,
      aiCommit: document.getElementById('btn-ai-commit')!,
      aiExplain: document.getElementById('btn-ai-explain')!,
      explanation: document.getElementById('ai-explanation')!,
      explanationTitle: document.getElementById('ai-explanation-title')!,
      explanationBody: document.getElementById('ai-explanation-body')!,
      explanationClose: document.getElementById('btn-ai-explanation-close')!,
      commitButton: document.getElementById('btn-commit')!
    };
    this.bind();
  }

  bind(): void {
    (this.elements.stageAll as HTMLButtonElement).onclick = () => this.mutatePaths(false, this.unstagedFiles());
    (this.elements.unstageAll as HTMLButtonElement).onclick = () => this.mutatePaths(true, this.stagedFiles());
    (this.elements.discardAll as HTMLButtonElement).onclick = () => this.discardPaths(this.unstagedFiles());
    (this.elements.submodulesInit as HTMLButtonElement).onclick = () => this.runSubmoduleAction('init');
    (this.elements.submodulesUpdate as HTMLButtonElement).onclick = () => this.runSubmoduleAction('update');
    (this.elements.composer as HTMLFormElement).onsubmit = event => {
      event.preventDefault();
      this.commit();
    };
    (this.elements.identityButton as HTMLButtonElement).onclick = () => this.editIdentity();
    (this.elements.aiCommit as HTMLButtonElement).onclick = () => this.generateCommitMessage();
    (this.elements.aiExplain as HTMLButtonElement).onclick = () => this.generateExplain();
    (this.elements.explanationClose as HTMLButtonElement).onclick = () => this.hideExplanation();
    (this.elements.authorToggle as HTMLInputElement).onchange = () => {
      this.elements.authorFields.classList.toggle(
        'is-hidden',
        !(this.elements.authorToggle as HTMLInputElement).checked
      );
      this.persistComposer();
    };
    [
      this.elements.summary,
      this.elements.body,
      this.elements.amend,
      this.elements.signoff,
      this.elements.signing,
      this.elements.authorName,
      this.elements.authorEmail
    ].forEach(element => {
      element.addEventListener('input', () => this.persistComposer());
      element.addEventListener('change', () => this.persistComposer());
    });
    window.addEventListener('focus', () => this.syncPolling());
    window.addEventListener('blur', () => this.syncPolling());
    onAgentsFeatureEnabledChange(enabled => {
      if (!enabled) this.hideExplanation();
    });
  }

  async load(repoPath: string): Promise<void> {
    if (this.repoPath !== repoPath) {
      this.repoPath = repoPath;
      this.snapshot = null;
      this.identity = null;
      this.selected = null;
      this.hideExplanation();
      this.restoreComposer();
    }
    const tasks: Array<Promise<unknown>> = [this.refresh(true)];
    if (this.active) tasks.push(this.refreshIdentity());
    await Promise.all(tasks);
    this.syncPolling();
  }

  setActive(active: boolean): void {
    this.active = active;
    this.root.classList.toggle('is-hidden', !active);
    this.syncPolling();
    if (active && this.repoPath && this.app.isCurrentRepo(this.repoPath)) {
      this.refresh();
      this.refreshIdentity();
    }
  }

  syncPolling(): void {
    if (this.pollTimer) clearInterval(this.pollTimer);
    this.pollTimer = null;
    if (this.active && this.repoPath && document.hasFocus()) {
      this.pollTimer = setInterval(() => this.refresh(), 2000);
    }
  }

  async refresh(force = false): Promise<WorkingTreeSnapshot | null> {
    if (!this.repoPath) return null;
    const pathAtStart = this.repoPath;
    if (this.inflight) return this.inflight;
    this.inflight = window.gitTree.getWorkingTree(pathAtStart)
      .then((rawSnapshot: unknown) => {
        const snapshot = rawSnapshot as WorkingTreeSnapshot;
        if (pathAtStart !== this.repoPath) return null;
        if (snapshot?.error) {
          this.app.showToast(snapshot.error, 'error');
          return null;
        }
        if (force || snapshot.snapshotId !== this.snapshot?.snapshotId) {
          this.snapshot = snapshot;
          this.render();
        }
        return snapshot;
      })
      .catch((error: Error): null => {
        this.app.showToast(error.message, 'error');
        return null;
      })
      .finally(() => {
        this.inflight = null;
      });
    return this.inflight;
  }

  unstagedFiles(): ChangeFile[] {
    return (this.snapshot?.files || []).filter(file => file.unstaged);
  }

  stagedFiles(): ChangeFile[] {
    return (this.snapshot?.files || []).filter(file => file.staged);
  }

  render(): void {
    const unstaged = this.unstagedFiles();
    const staged = this.stagedFiles();
    const hasSubmodules = Boolean(this.snapshot?.submodules?.length);
    this.elements.submoduleBar.classList.toggle('is-hidden', !hasSubmodules);
    this.elements.unstagedCount.textContent = String(unstaged.length);
    this.elements.stagedCount.textContent = String(staged.length);
    (this.elements.stageAll as HTMLButtonElement).disabled = unstaged.length === 0;
    (this.elements.unstageAll as HTMLButtonElement).disabled = staged.length === 0;
    (this.elements.discardAll as HTMLButtonElement).disabled = unstaged.length === 0;
    (this.elements.commitButton as HTMLButtonElement).disabled =
      staged.length === 0 && !(this.elements.amend as HTMLInputElement).checked;
    (this.elements.aiCommit as HTMLButtonElement).disabled = this.generatingCommit
      || (staged.length === 0 && unstaged.length === 0);
    (this.elements.aiExplain as HTMLButtonElement).disabled = this.generatingExplain
      || (staged.length === 0 && unstaged.length === 0);
    if (staged.length === 0 && unstaged.length === 0) {
      this.hideExplanation();
    }
    const fileCount = this.snapshot?.files?.length || 0;
    this.elements.modeCount.textContent = String(fileCount);
    this.elements.modeCount.classList.toggle('is-hidden', fileCount === 0);
    this.fileLists.unstaged.update(
      unstaged,
      file => this.createFileRow(file as ChangeFile, false),
      t('changes.noUnstaged')
    );
    this.fileLists.staged.update(
      staged,
      file => this.createFileRow(file as ChangeFile, true),
      t('changes.noStaged')
    );
  }

  createFileRow(file: ChangeFile, staged: boolean): HTMLElement {
    const row = document.createElement('div');
    row.className = 'changes-file-row';
    row.setAttribute('role', 'listitem');
    row.classList.toggle(
      'selected',
      this.selected?.path === file.path && this.selected?.staged === staged
    );

    const status = document.createElement('span');
    status.className = 'changes-file-status';
    status.textContent = this.fileStatus(file, staged);

    const main = document.createElement('button');
    main.className = 'changes-file-main';
    main.type = 'button';
    main.title = file.path;
    const pathLabel = document.createElement('span');
    pathLabel.className = 'changes-file-path';
    pathLabel.textContent = file.path;
    main.appendChild(pathLabel);
    if (file.submodule) {
      const badge = document.createElement('span');
      badge.className = 'badge badge-remote changes-submodule-badge';
      badge.textContent = t('changes.submodule');
      main.appendChild(badge);
    }
    main.onclick = () => this.selectFile(file, staged);

    const action = document.createElement('button');
    action.className = 'changes-file-action';
    action.type = 'button';
    action.title = t(staged ? 'changes.unstageFile' : 'changes.stageFile');
    action.setAttribute('aria-label', action.title);
    const icon = document.createElement('i');
    icon.className = staged ? 'ph ph-minus' : 'ph ph-plus';
    action.appendChild(icon);
    action.onclick = event => {
      event.stopPropagation();
      this.mutatePaths(staged, [file]);
    };
    if (!staged) {
      const discard = document.createElement('button');
      discard.className = 'changes-file-action changes-file-discard';
      discard.type = 'button';
      discard.title = t('changes.discardFile');
      discard.setAttribute('aria-label', discard.title);
      const discardIcon = document.createElement('i');
      discardIcon.className = 'ph ph-trash';
      discard.appendChild(discardIcon);
      discard.onclick = event => {
        event.stopPropagation();
        this.discardPaths([file]);
      };
      row.append(status, main, discard, action);
      return row;
    }
    row.append(status, main, action);
    return row;
  }

  async generateCommitMessage(): Promise<void> {
    if (this.generatingCommit) return;
    if (!this.repoPath) return;
    const hasText = Boolean(
      (this.elements.summary as HTMLInputElement).value.trim() || (this.elements.body as HTMLTextAreaElement).value.trim()
    );
    if (hasText && !await this.confirmAiReplace()) return;
    this.generatingCommit = true;
    this.setAiGenerating(true);
    try {
      const result = await window.gitTree.generateCommitMessage(this.repoPath, {
        language: await this.aiLanguage()
      }) as { error?: string; summary?: string; body?: string };
      if (result?.error) {
        this.app.showToast(result.error, 'error');
        return;
      }
      (this.elements.summary as HTMLInputElement).value = result.summary || '';
      (this.elements.body as HTMLTextAreaElement).value = result.body || '';
      this.persistComposer();
      this.app.showToast(t('changes.aiGenerated'), 'success');
    } finally {
      this.generatingCommit = false;
      this.setAiGenerating(false);
    }
  }

  confirmAiReplace(): Promise<unknown> {
    return this.app.dialogs.confirm({
      title: t('changes.aiReplaceTitle'),
      message: t('changes.aiReplaceConfirm'),
      cancelLabel: t('common.cancel'),
      actionLabel: t('common.continue')
    });
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

  setAiGenerating(generating: boolean): void {
    const button = this.elements.aiCommit as HTMLButtonElement;
    const icon = button.querySelector('i') as HTMLElement;
    const label = button.querySelector('span') as HTMLElement;
    button.disabled = generating;
    if (generating) {
      icon.className = 'ph ph-circle-notch';
      label.textContent = t('changes.aiGenerating');
      return;
    }
    icon.className = 'ph ph-sparkle';
    label.textContent = t('changes.aiGenerate');
    button.disabled =
      this.stagedFiles().length === 0 && this.unstagedFiles().length === 0;
  }

  async generateExplain(): Promise<void> {
    if (this.generatingExplain) return;
    if (!this.repoPath) return;
    this.generatingExplain = true;
    this.setExplainGenerating(true);
    try {
      const result = await window.gitTree.explainChanges(this.repoPath, {
        language: await this.aiLanguage()
      }) as { error?: string; summary?: string; body?: string };
      if (result?.error) {
        this.app.showToast(result.error, 'error');
        return;
      }
      this.elements.explanationTitle.textContent = result.summary || '';
      this.elements.explanationBody.textContent = result.body || '';
      this.elements.explanation.classList.remove('is-hidden');
      this.app.showToast(t('changes.aiExplained'), 'success');
    } finally {
      this.generatingExplain = false;
      this.setExplainGenerating(false);
    }
  }

  setExplainGenerating(generating: boolean): void {
    const button = this.elements.aiExplain as HTMLButtonElement;
    const icon = button.querySelector('i') as HTMLElement;
    const label = button.querySelector('span') as HTMLElement;
    button.disabled = generating;
    if (generating) {
      icon.className = 'ph ph-circle-notch';
      label.textContent = t('changes.aiExplaining');
      return;
    }
    icon.className = 'ph ph-sparkle';
    label.textContent = t('changes.aiExplain');
    button.disabled =
      this.stagedFiles().length === 0 && this.unstagedFiles().length === 0;
  }

  hideExplanation(): void {
    this.elements.explanation.classList.add('is-hidden');
    this.elements.explanationTitle.textContent = '';
    this.elements.explanationBody.textContent = '';
  }

  async runSubmoduleAction(action: string): Promise<void> {
    if (!this.repoPath) return;
    const api = action === 'init'
      ? window.gitTree.initSubmodules
      : window.gitTree.updateSubmodules;
    const result = await api(this.repoPath) as { error?: string };
    if (result?.error) {
      this.app.showToast(result.error, 'error');
      return;
    }
    this.app.showToast(
      t(action === 'init' ? 'changes.submodulesInitialized' : 'changes.submodulesUpdated'),
      'success'
    );
    await this.refresh(true);
    this.app.components.branchList?.load(this.repoPath);
  }

  async discardPaths(files: ChangeFile[]): Promise<void> {
    if (!this.snapshot || files.length === 0) return;
    const paths = files.map(file => file.path);
    const confirmed = await this.confirmDiscard(paths.length);
    if (!confirmed) return;
    const result = await window.gitTree.discardPaths(
      this.repoPath,
      this.snapshot!.snapshotId,
      paths
    ) as { error?: string; snapshot?: WorkingTreeSnapshot };
    if (result?.error) {
      this.app.showToast(result.error, 'error');
      await this.refresh(true);
      return;
    }
    this.snapshot = result.snapshot ?? null;
    this.render();
    if (this.selected) {
      const file = this.snapshot!.files.find(item => item.path === this.selected?.path);
      if (file) await this.selectFile({ path: file.path }, Boolean(file.staged));
      else this.app.components.diffViewer.clear();
    }
    this.app.showToast(t('changes.discarded'), 'success');
  }

  confirmDiscard(count: number): Promise<unknown> {
    return this.app.dialogs.confirm({
      title: t('changes.discardTitle'),
      message: t('changes.discardConfirm', { count }),
      cancelLabel: t('common.cancel'),
      actionLabel: t('changes.discardAction'),
      danger: true
    });
  }

  fileStatus(file: ChangeFile, staged: boolean): string {
    if (file.conflicted) return '!';
    if (file.untracked) return '?';
    const code = staged ? file.indexStatus : file.worktreeStatus;
    return code && code !== ' ' ? code : 'M';
  }

  async mutatePaths(unstage: boolean, files: ChangeFile[]): Promise<void> {
    if (!this.snapshot || files.length === 0) return;
    const api = unstage ? window.gitTree.unstagePaths : window.gitTree.stagePaths;
    const result = await api(
      this.repoPath,
      this.snapshot!.snapshotId,
      files.map(file => file.path)
    ) as { error?: string; snapshot?: WorkingTreeSnapshot };
    if (result?.error) {
      this.app.showToast(result.error, 'error');
      await this.refresh(true);
      return;
    }
    this.snapshot = result.snapshot ?? null;
    this.render();
    if (this.selected) {
      const file = this.snapshot!.files.find(item => item.path === this.selected?.path);
      if (file) await this.selectFile({ path: file.path }, Boolean(file.staged));
      else this.app.components.diffViewer.clear();
    }
  }

  async selectFile(file: { path: string }, staged: boolean): Promise<void> {
    this.selected = { path: file.path, staged };
    this.render();
    const request = ++this.diffRequest;
    const title = document.getElementById('detail-title')!;
    title.textContent = file.path.split('/').pop() || '';
    title.title = file.path;
    const body = document.getElementById('detail-body')!;
    body.innerHTML = '';
    const loading = document.createElement('div');
    loading.className = 'diff-placeholder';
    loading.textContent = t('details.loading');
    body.appendChild(loading);
    const diff = await window.gitTree.getWorkingDiff(this.repoPath, file.path, staged) as {
      error?: string;
      noDiff?: boolean;
      binary?: boolean;
      hunks?: Array<NumberableHunk & { header: string; id?: string }>;
      path?: string;
    } | undefined;
    if (request !== this.diffRequest) return;
    if (diff?.error) {
      loading.textContent = diff.error;
      return;
    }
    if (!diff) return;
    this.renderWorkingDiff(diff, staged);
    this.app.pushInspectorPayload?.();
  }

  renderWorkingDiff(
    diff: { noDiff?: boolean; binary?: boolean; hunks?: Array<NumberableHunk & { header: string; id?: string }>; path?: string },
    staged: boolean
  ): void {
    const body = document.getElementById('detail-body')!;
    body.innerHTML = '';
    if (diff.noDiff) {
      const empty = document.createElement('div');
      empty.className = 'diff-placeholder';
      const icon = document.createElement('i');
      icon.className = 'ph ph-check-circle';
      const text = document.createElement('span');
      text.textContent = t('changes.noUnstagedDiff');
      empty.append(icon, text);
      body.appendChild(empty);
      this.refresh(true);
      return;
    }
    if (diff.binary || !diff.hunks?.length) {
      const empty = document.createElement('div');
      empty.className = 'diff-placeholder';
      const icon = document.createElement('i');
      icon.className = diff.binary ? 'ph ph-file-lock' : 'ph ph-file-dashed';
      const text = document.createElement('span');
      text.textContent = t(
        diff.binary ? 'changes.binaryWholeFile' : 'changes.noTextDiff'
      );
      empty.append(icon, text);
      body.appendChild(empty);
      return;
    }
    const wrapper = document.createElement('div');
    wrapper.className = 'working-diff';
    const numberedHunks = diff.hunks.map(hunk => ({
      hunk,
      lines: DiffParser.numberHunk(hunk)
    }));
    const allLines = numberedHunks.flatMap(item => item.lines);
    wrapper.style.setProperty('--diff-gutter-digits', String(DiffParser.maxDigits(allLines)));
    numberedHunks.forEach(({ hunk, lines }) => {
      const section = document.createElement('section');
      section.className = 'working-diff-hunk';
      const header = document.createElement('div');
      header.className = 'working-diff-hunk-header';
      const code = document.createElement('code');
      code.textContent = hunk.header;
      const action = document.createElement('button');
      action.type = 'button';
      action.className = 'btn btn-small';
      action.textContent = t(staged ? 'changes.unstageHunk' : 'changes.stageHunk');
      action.onclick = () => this.mutateHunk(String(diff.path), staged, String(hunk.id));
      header.append(code, action);
      section.appendChild(header);
      lines.forEach(line => {
        const row = document.createElement('div');
        row.className = `diff-line ${line.kind}`;
        const oldNumber = document.createElement('span');
        oldNumber.className = 'diff-line-num is-old';
        oldNumber.textContent = Number.isInteger(line.oldLine) ? String(line.oldLine) : '';
        const newNumber = document.createElement('span');
        newNumber.className = 'diff-line-num is-new';
        newNumber.textContent = Number.isInteger(line.newLine) ? String(line.newLine) : '';
        const content = document.createElement('span');
        content.className = 'diff-line-content';
        content.textContent = line.content;
        row.append(oldNumber, newNumber, content);
        section.appendChild(row);
      });
      wrapper.appendChild(section);
    });
    body.appendChild(wrapper);
  }

  async mutateHunk(filePath: string, staged: boolean, hunkId: string): Promise<void> {
    const api = staged ? window.gitTree.unstageHunks : window.gitTree.stageHunks;
    const result = await api(
      this.repoPath,
      this.snapshot!.snapshotId,
      filePath,
      [hunkId]
    ) as { error?: string; snapshot?: WorkingTreeSnapshot };
    if (result?.error) {
      this.app.showToast(result.error, 'error');
      await this.refresh(true);
      return;
    }
    this.snapshot = result.snapshot ?? null;
    this.render();
    const targetStaged = !staged;
    const file = this.snapshot!.files.find(item => item.path === filePath);
    if (file && (targetStaged ? file.staged : file.unstaged)) {
      await this.selectFile(file, targetStaged);
    } else {
      this.app.components.diffViewer.clear();
    }
  }

  composerKey(): string {
    return `gittree.commitDraft:${this.repoPath || ''}`;
  }

  persistComposer(): void {
    if (!this.repoPath) return;
    localStorage.setItem(this.composerKey(), JSON.stringify({
      summary: (this.elements.summary as HTMLInputElement).value,
      body: (this.elements.body as HTMLTextAreaElement).value,
      amend: (this.elements.amend as HTMLInputElement).checked,
      signoff: (this.elements.signoff as HTMLInputElement).checked,
      signing: (this.elements.signing as HTMLInputElement).checked,
      authorOverride: (this.elements.authorToggle as HTMLInputElement).checked,
      authorName: (this.elements.authorName as HTMLInputElement).value,
      authorEmail: (this.elements.authorEmail as HTMLInputElement).value
    }));
    if (this.snapshot) {
      (this.elements.commitButton as HTMLButtonElement).disabled =
        this.stagedFiles().length === 0 && !(this.elements.amend as HTMLInputElement).checked;
    }
  }

  restoreComposer(): void {
    let draft: Record<string, unknown> = {};
    try {
      draft = JSON.parse(localStorage.getItem(this.composerKey()) ?? 'null') || {};
    } catch { /* invalid draft falls back to empty */ }
    (this.elements.summary as HTMLInputElement).value = (draft.summary as string) || '';
    (this.elements.body as HTMLTextAreaElement).value = (draft.body as string) || '';
    (this.elements.amend as HTMLInputElement).checked = Boolean(draft.amend);
    (this.elements.signoff as HTMLInputElement).checked = Boolean(draft.signoff);
    (this.elements.signing as HTMLInputElement).checked = Boolean(draft.signing);
    (this.elements.authorToggle as HTMLInputElement).checked = Boolean(draft.authorOverride);
    (this.elements.authorName as HTMLInputElement).value = (draft.authorName as string) || '';
    (this.elements.authorEmail as HTMLInputElement).value = (draft.authorEmail as string) || '';
    this.elements.authorFields.classList.toggle(
      'is-hidden',
      !(this.elements.authorToggle as HTMLInputElement).checked
    );
  }

  async refreshIdentity(): Promise<void> {
    if (!this.repoPath) return;
    const identity = await window.gitTree.getIdentity(this.repoPath) as IdentityInfo;
    if (identity?.error) {
      this.elements.identityStatus.textContent = identity.error;
      return;
    }
    this.identity = identity;
    this.elements.identityStatus.textContent = identity.configured
      ? `${identity.name} <${identity.email}>`
      : t('changes.identityMissing');
    (this.elements.signing as HTMLInputElement).disabled = !identity.signing?.available;
    this.elements.signingLabel.title = identity.signing?.available
      ? t('changes.signingReady', { format: identity.signing.format })
      : t('changes.signingUnavailable');
    if (
      identity.signing?.enabledByDefault &&
      localStorage.getItem(this.composerKey()) == null
    ) {
      (this.elements.signing as HTMLInputElement).checked = true;
    }
  }

  async editIdentity(): Promise<boolean> {
    const value = await this.identityDialog();
    if (!value) return false;
    const result = await window.gitTree.setIdentity(this.repoPath, value) as { error?: string; identity?: IdentityInfo };
    if (result?.error) {
      this.app.showToast(result.error, 'error');
      return false;
    }
    this.identity = result.identity ?? null;
    await this.refreshIdentity();
    return true;
  }

  identityDialog(): Promise<unknown> {
    return this.app.dialogs.form({
      title: t('changes.identityTitle'),
      fields: `
        <p>${this.esc(t('changes.identityHelp'))}</p>
        <label><span>${this.esc(t('changes.authorName'))}</span>
          <input name="name" maxlength="200" required autofocus value="${this.esc(this.identity?.name || '')}">
        </label>
        <label><span>${this.esc(t('changes.authorEmail'))}</span>
          <input name="email" maxlength="254" type="email" required value="${this.esc(this.identity?.email || '')}">
        </label>
        <label><span>${this.esc(t('changes.identityScope'))}</span>
          <select name="scope">
            <option value="local">${this.esc(t('changes.scopeLocal'))}</option>
            <option value="global">${this.esc(t('changes.scopeGlobal'))}</option>
          </select>
        </label>`,
      extract: (form): { name: string; email: string; scope: string } => {
        const elements = form.elements as unknown as Record<string, HTMLInputElement | HTMLSelectElement>;
        return {
          name: elements.name.value.trim(),
          email: elements.email.value.trim(),
          scope: elements.scope.value
        };
      },
      cancelLabel: t('common.cancel'),
      actionLabel: t('common.continue')
    });
  }

  async commit(): Promise<void> {
    if (!this.identity?.configured && !(await this.editIdentity())) return;
    const options: Record<string, unknown> = {
      summary: (this.elements.summary as HTMLInputElement).value,
      body: (this.elements.body as HTMLTextAreaElement).value,
      amend: (this.elements.amend as HTMLInputElement).checked,
      signoff: (this.elements.signoff as HTMLInputElement).checked,
      signing: (this.elements.signing as HTMLInputElement).checked
    };
    if ((this.elements.authorToggle as HTMLInputElement).checked) {
      options.authorOverride = {
        name: (this.elements.authorName as HTMLInputElement).value,
        email: (this.elements.authorEmail as HTMLInputElement).value
      };
    }
    (this.elements.commitButton as HTMLButtonElement).disabled = true;
    const result = await window.gitTree.commitChanges(this.repoPath, options) as { error?: string; hash?: string };
    if (result?.error) {
      this.app.showToast(result.error, 'error');
      (this.elements.commitButton as HTMLButtonElement).disabled = false;
      return;
    }
    (this.elements.summary as HTMLInputElement).value = '';
    (this.elements.body as HTMLTextAreaElement).value = '';
    (this.elements.amend as HTMLInputElement).checked = false;
    this.persistComposer();
    this.app.showToast(t('changes.commitCreated'), 'success');
    this.app.components.welcome?.markStep?.('commit');
    await this.app.refresh({ selectHash: result.hash, silent: true });
  }

  esc(value: unknown): string {
    return HtmlEncoder.encode(value);
  }
}

if (typeof window !== 'undefined') {
  (window as unknown as { ChangesView: typeof ChangesView }).ChangesView = ChangesView;
}

declare const module: { exports: unknown } | undefined;
if (typeof module !== 'undefined' && (module as { exports?: unknown }).exports) {
  (module as { exports: unknown }).exports = ChangesView;
}
