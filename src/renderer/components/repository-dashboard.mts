export type DashboardPeriod = 30 | 90 | 365;

export interface DashboardRepository {
  path: string;
  name?: string;
}

export interface DashboardCommit {
  hash: string;
  subject: string;
  authorName: string;
  authorEmail?: string;
  date: string;
}

export interface DashboardRef {
  type: string;
  fullName?: string;
}

export interface RepositoryAnalyticsInput {
  repo: DashboardRepository;
  commits: DashboardCommit[];
  refs: DashboardRef[];
  truncated: boolean;
}

export interface RepositoryDashboardStats {
  repositoryCount: number;
  activeRepositoryCount: number;
  commitCount: number;
  totalCommitCount: number;
  previousCommitCount: number;
  contributorCount: number;
  previousContributorCount: number;
  activeDayCount: number;
  branchCount: number;
  tagCount: number;
  truncatedRepositoryCount: number;
  timeline: Array<{ start: Date; commits: number }>;
  previousTimeline: number[];
  weekdays: number[];
  repositories: Array<{
    path: string;
    name: string;
    commits: number;
    contributors: number;
    branches: number;
    lastCommitDate: Date | null;
  }>;
  contributors: Array<{ name: string; email: string; commits: number }>;
  recentCommits: Array<DashboardCommit & { repositoryName: string; repositoryPath: string }>;
}

const DAY_MS = 86_400_000;
const TIMELINE_BUCKETS = 12;
const MAX_REPOSITORY_PAGES = 8;

function validTimestamp(value: string): number | null {
  const timestamp = Date.parse(value);
  return Number.isFinite(timestamp) ? timestamp : null;
}

function contributorKey(commit: DashboardCommit): string {
  const name = (commit.authorName || '').trim().replace(/\s+/g, ' ').toLocaleLowerCase('en-US');
  if (name) return `name:${name}`;
  const email = (commit.authorEmail || '').trim().toLocaleLowerCase('en-US');
  return email ? `email:${email}` : 'unknown';
}

export function percentageChange(current: number, previous: number): number | null {
  if (previous === 0) return current === 0 ? 0 : null;
  return Math.round(((current - previous) / previous) * 100);
}

export function buildRepositoryDashboardStats(
  inputs: RepositoryAnalyticsInput[],
  periodDays: DashboardPeriod,
  now = new Date(),
  selectedContributor = ''
): RepositoryDashboardStats {
  const currentEnd = now.getTime();
  const currentStart = currentEnd - (periodDays * DAY_MS);
  const previousStart = currentStart - (periodDays * DAY_MS);
  const currentCommits: Array<DashboardCommit & { repositoryName: string; repositoryPath: string }> = [];
  const previousCommits: DashboardCommit[] = [];
  const contributorMap = new Map<string, { name: string; email: string; commits: number }>();
  const previousContributors = new Set<string>();
  const activeDays = new Set<string>();
  let totalCommitCount = 0;
  const timeline = Array.from({ length: TIMELINE_BUCKETS }, (_, index) => ({
    start: new Date(currentStart + ((periodDays * DAY_MS * index) / TIMELINE_BUCKETS)),
    commits: 0
  }));
  const previousTimeline = Array.from({ length: TIMELINE_BUCKETS }, () => 0);
  const weekdays = Array.from({ length: 7 }, () => 0);

  const repositories = inputs.map(input => {
    const dated = input.commits
      .map(commit => ({ commit, timestamp: validTimestamp(commit.date) }))
      .filter((item): item is { commit: DashboardCommit; timestamp: number } => item.timestamp !== null);
    const currentAll = dated.filter(item => item.timestamp >= currentStart && item.timestamp <= currentEnd);
    totalCommitCount += currentAll.length;
    const matchesContributor = (item: { commit: DashboardCommit }): boolean => (
      !selectedContributor || contributorKey(item.commit) === selectedContributor
    );
    const current = currentAll.filter(matchesContributor);
    const previous = dated
      .filter(item => item.timestamp >= previousStart && item.timestamp < currentStart)
      .filter(matchesContributor);
    const repositoryName = input.repo.name || input.repo.path.split(/[\\/]/).filter(Boolean).pop() || input.repo.path;
    const repositoryContributors = new Set<string>();

    for (const { commit, timestamp } of current) {
      const key = contributorKey(commit);
      repositoryContributors.add(key);
      const contributor = contributorMap.get(key) || {
        name: commit.authorName || commit.authorEmail || 'Unknown',
        email: commit.authorEmail || '',
        commits: 0
      };
      contributor.commits += 1;
      contributorMap.set(key, contributor);
      currentCommits.push({ ...commit, repositoryName, repositoryPath: input.repo.path });
      const bucket = Math.min(
        TIMELINE_BUCKETS - 1,
        Math.max(0, Math.floor(((timestamp - currentStart) / (periodDays * DAY_MS)) * TIMELINE_BUCKETS))
      );
      timeline[bucket].commits += 1;
      weekdays[new Date(timestamp).getUTCDay()] += 1;
      activeDays.add(new Date(timestamp).toISOString().slice(0, 10));
    }
    for (const { commit, timestamp } of previous) {
      previousCommits.push(commit);
      previousContributors.add(contributorKey(commit));
      const bucket = Math.min(
        TIMELINE_BUCKETS - 1,
        Math.max(0, Math.floor(((timestamp - previousStart) / (periodDays * DAY_MS)) * TIMELINE_BUCKETS))
      );
      previousTimeline[bucket] += 1;
    }

    const newestTimestamp = (selectedContributor ? current : dated).reduce<number | null>((latest, item) => (
      latest === null || item.timestamp > latest ? item.timestamp : latest
    ), null);
    return {
      path: input.repo.path,
      name: repositoryName,
      commits: current.length,
      contributors: repositoryContributors.size,
      branches: input.refs.filter(ref => ref.type === 'branch').length,
      lastCommitDate: newestTimestamp === null ? null : new Date(newestTimestamp)
    };
  }).sort((left, right) => (
    right.commits - left.commits
      || (right.lastCommitDate?.getTime() || 0) - (left.lastCommitDate?.getTime() || 0)
      || left.name.localeCompare(right.name)
  ));

  return {
    repositoryCount: inputs.length,
    activeRepositoryCount: repositories.filter(repo => repo.commits > 0).length,
    commitCount: currentCommits.length,
    totalCommitCount,
    previousCommitCount: previousCommits.length,
    contributorCount: contributorMap.size,
    previousContributorCount: previousContributors.size,
    activeDayCount: activeDays.size,
    branchCount: inputs.reduce((total, input) => (
      total + input.refs.filter(ref => ref.type === 'branch').length
    ), 0),
    tagCount: inputs.reduce((total, input) => (
      total + input.refs.filter(ref => ref.type === 'tag').length
    ), 0),
    truncatedRepositoryCount: inputs.filter(input => input.truncated).length,
    timeline,
    previousTimeline,
    weekdays,
    repositories,
    contributors: [...contributorMap.values()].sort((left, right) => (
      right.commits - left.commits || left.name.localeCompare(right.name)
    )),
    recentCommits: currentCommits
      .sort((left, right) => (validTimestamp(right.date) || 0) - (validTimestamp(left.date) || 0))
      .slice(0, 8)
  };
}

interface DashboardBridge {
  getGraphPage(repoPath: string, options: { offset: number; limit: number }): Promise<unknown>;
}

interface RepositoryDashboardDependencies {
  container: HTMLElement;
  button: HTMLElement;
  workspace: HTMLElement;
  bridge: DashboardBridge;
  translate: (key: string, options?: Record<string, unknown>) => string;
  encode: (value: unknown) => string;
  getRepositories: () => DashboardRepository[];
  storage?: Storage | null;
  getLocale?: () => string;
  now?: () => Date;
}

interface GraphPageResult {
  error?: string;
  commits?: DashboardCommit[];
  refs?: DashboardRef[];
  nextOffset?: number;
  hasMore?: boolean;
}

export class RepositoryDashboard {
  container: HTMLElement;
  button: HTMLElement;
  workspace: HTMLElement;
  bridge: DashboardBridge;
  translate: RepositoryDashboardDependencies['translate'];
  encode: RepositoryDashboardDependencies['encode'];
  getRepositories: RepositoryDashboardDependencies['getRepositories'];
  storage: Storage | null;
  getLocale: () => string;
  now: () => Date;
  period: DashboardPeriod;
  selectedContributor: string;
  favoriteContributor: string;
  contributorQuery: string;
  authorMenuOpen: boolean;
  active: boolean;
  generation: number;
  inputs: RepositoryAnalyticsInput[];
  analyticsCache: Map<string, RepositoryAnalyticsInput>;
  failedRepositories: number;
  mounted: boolean;
  private readonly handleToggle: () => void;
  private readonly handleDocumentPointerDown: (event: PointerEvent) => void;
  private readonly handleDocumentKeydown: (event: KeyboardEvent) => void;

  constructor({
    container,
    button,
    workspace,
    bridge,
    translate,
    encode,
    getRepositories,
    storage = typeof localStorage !== 'undefined' ? localStorage : null,
    getLocale = () => 'en',
    now = () => new Date()
  }: RepositoryDashboardDependencies) {
    this.container = container;
    this.button = button;
    this.workspace = workspace;
    this.bridge = bridge;
    this.translate = translate;
    this.encode = encode;
    this.getRepositories = getRepositories;
    this.storage = storage;
    this.getLocale = getLocale;
    this.now = now;
    this.period = 30;
    this.selectedContributor = this.readPreference('gittree.dashboard.selectedContributor');
    this.favoriteContributor = this.readPreference('gittree.dashboard.favoriteContributor');
    this.contributorQuery = '';
    this.authorMenuOpen = false;
    this.active = false;
    this.generation = 0;
    this.inputs = [];
    this.analyticsCache = new Map();
    this.failedRepositories = 0;
    this.mounted = false;
    this.handleToggle = () => { void this.toggle(); };
    this.handleDocumentPointerDown = event => {
      if (!this.authorMenuOpen || this.container.contains(event.target as Node)) return;
      this.authorMenuOpen = false;
      if (this.active && this.inputs.length) this.render();
    };
    this.handleDocumentKeydown = event => {
      if (event.key !== 'Escape' || !this.authorMenuOpen) return;
      event.preventDefault();
      this.authorMenuOpen = false;
      if (this.active && this.inputs.length) this.render();
    };
  }

  mount(): void {
    if (this.mounted) return;
    this.mounted = true;
    this.button.addEventListener('click', this.handleToggle);
    document.addEventListener('pointerdown', this.handleDocumentPointerDown);
    document.addEventListener('keydown', this.handleDocumentKeydown);
    this.refreshTranslations();
  }

  async toggle(): Promise<void> {
    if (this.active) this.close();
    else await this.open();
  }

  async open(): Promise<void> {
    this.active = true;
    this.container.classList.remove('is-hidden');
    this.workspace.classList.add('is-hidden');
    this.button.classList.add('active');
    this.button.setAttribute('aria-pressed', 'true');
    await this.refresh();
  }

  close(): void {
    this.active = false;
    this.authorMenuOpen = false;
    this.generation += 1;
    this.container.classList.add('is-hidden');
    this.workspace.classList.remove('is-hidden');
    this.button.classList.remove('active');
    this.button.setAttribute('aria-pressed', 'false');
  }

  async refresh({ force = false }: { force?: boolean } = {}): Promise<void> {
    const generation = ++this.generation;
    const repositories = [...this.getRepositories()];
    if (!repositories.length) {
      this.inputs = [];
      this.failedRepositories = 0;
      this.renderEmpty();
      return;
    }
    this.renderLoading(repositories.length);
    const results = await Promise.all(repositories.map(async repo => {
      try {
        return await this.loadRepositoryCached(repo, force);
      } catch {
        return null;
      }
    }));
    if (generation !== this.generation || !this.active) return;
    this.inputs = results.filter((result): result is RepositoryAnalyticsInput => result !== null);
    this.failedRepositories = results.length - this.inputs.length;
    if (!this.inputs.length) this.renderError();
    else this.render();
  }

  async loadRepositoryCached(repo: DashboardRepository, force: boolean): Promise<RepositoryAnalyticsInput> {
    const cacheKey = `${this.period}:${repo.path}`;
    if (!force) {
      const cached = this.analyticsCache.get(cacheKey);
      if (cached) return cached;
    }
    const result = await this.loadRepository(repo);
    this.analyticsCache.set(cacheKey, result);
    return result;
  }

  async loadRepository(repo: DashboardRepository): Promise<RepositoryAnalyticsInput> {
    const cutoff = this.now().getTime() - (this.period * 2 * DAY_MS);
    const commits: DashboardCommit[] = [];
    const seen = new Set<string>();
    let refs: DashboardRef[] = [];
    let offset = 0;
    let hasMore = true;
    let pages = 0;
    let reachedPeriodBoundary = false;

    while (hasMore && pages < MAX_REPOSITORY_PAGES && !reachedPeriodBoundary) {
      const page = await this.bridge.getGraphPage(repo.path, { offset, limit: 1000 }) as GraphPageResult;
      if (page?.error) throw new Error(page.error);
      if (pages === 0) refs = Array.isArray(page?.refs) ? page.refs : [];
      const pageCommits = Array.isArray(page?.commits) ? page.commits : [];
      for (const commit of pageCommits) {
        if (!commit?.hash || seen.has(commit.hash)) continue;
        seen.add(commit.hash);
        commits.push(commit);
      }
      pages += 1;
      hasMore = Boolean(page?.hasMore);
      offset = typeof page?.nextOffset === 'number' ? page.nextOffset : offset + pageCommits.length;
      const timestamps = pageCommits
        .map(commit => validTimestamp(commit.date))
        .filter((timestamp): timestamp is number => timestamp !== null);
      reachedPeriodBoundary = timestamps.length > 0 && Math.min(...timestamps) < cutoff;
      if (!pageCommits.length) break;
    }

    return {
      repo,
      commits,
      refs,
      truncated: hasMore && !reachedPeriodBoundary
    };
  }

  refreshTranslations(): void {
    const label = this.translate('dashboard.open');
    this.button.title = label;
    this.button.setAttribute('aria-label', label);
    if (!this.active) return;
    if (this.inputs.length) this.render();
    else this.renderEmpty();
  }

  readPreference(key: string): string {
    try {
      return this.storage?.getItem(key) || '';
    } catch {
      return '';
    }
  }

  writePreference(key: string, value: string): void {
    try {
      if (value) this.storage?.setItem(key, value);
      else this.storage?.removeItem(key);
    } catch {
      // Storage can be unavailable in private or restricted renderer contexts.
    }
  }

  renderLoading(repositoryCount: number): void {
    this.container.innerHTML = `
      <div class="dashboard-state" role="status" aria-live="polite">
        <i class="ph ph-circle-notch" aria-hidden="true"></i>
        <strong>${this.encode(this.translate('dashboard.loading'))}</strong>
        <span>${this.encode(this.translate('dashboard.loadingRepositories', { count: repositoryCount }))}</span>
      </div>`;
  }

  renderEmpty(): void {
    this.container.innerHTML = `
      <div class="dashboard-state">
        <i class="ph ph-chart-line-up" aria-hidden="true"></i>
        <strong>${this.encode(this.translate('dashboard.emptyTitle'))}</strong>
        <span>${this.encode(this.translate('dashboard.emptyHelp'))}</span>
      </div>`;
  }

  renderError(): void {
    this.container.innerHTML = `
      <div class="dashboard-state dashboard-state-error" role="alert">
        <i class="ph ph-warning-circle" aria-hidden="true"></i>
        <strong>${this.encode(this.translate('dashboard.errorTitle'))}</strong>
        <span>${this.encode(this.translate('dashboard.errorHelp'))}</span>
        <button class="btn" type="button" data-dashboard-refresh>
          <i class="ph ph-arrow-clockwise" aria-hidden="true"></i>${this.encode(this.translate('dashboard.refresh'))}
        </button>
      </div>`;
    this.bindRenderedControls();
  }

  render(): void {
    const authorOptions = this.contributorOptions();
    const selectedAuthor = authorOptions.find(author => author.key === this.selectedContributor) || null;
    const favoriteAuthor = authorOptions.find(author => author.key === this.favoriteContributor) || null;
    const stats = buildRepositoryDashboardStats(
      this.inputs,
      this.period,
      this.now(),
      selectedAuthor?.key || ''
    );
    const maxRepoCommits = Math.max(1, ...stats.repositories.map(repo => repo.commits));
    const maxContributorCommits = Math.max(1, ...stats.contributors.map(author => author.commits));
    const maxWeekday = Math.max(1, ...stats.weekdays);
    const trend = percentageChange(stats.commitCount, stats.previousCommitCount);
    const contributorTrend = percentageChange(stats.contributorCount, stats.previousContributorCount);
    const visibleRepositories = (selectedAuthor
      ? stats.repositories.filter(repo => repo.commits > 0)
      : stats.repositories).slice(0, 7);
    const repositories = visibleRepositories.map(repo => `
      <div class="dashboard-repository-row">
        <div class="dashboard-repository-main">
          <span class="dashboard-repository-name" title="${this.encode(repo.path)}">${this.encode(repo.name)}</span>
          <span>${this.encode(this.translate('dashboard.repoMeta', {
            contributors: repo.contributors,
            branches: repo.branches
          }))}</span>
        </div>
        <div class="dashboard-bar-track" aria-hidden="true"><span class="${this.levelClass(repo.commits, maxRepoCommits)}"></span></div>
        <strong>${this.formatNumber(repo.commits)}</strong>
      </div>`).join('');
    const contributors = stats.contributors.slice(0, 6).map(author => `
      <div class="dashboard-contributor-row">
        <span class="dashboard-avatar" aria-hidden="true">${this.encode(this.initials(author.name))}</span>
        <div class="dashboard-contributor-main">
          <span title="${this.encode(author.email || author.name)}">${this.encode(author.name)}</span>
          <div class="dashboard-bar-track" aria-hidden="true"><span class="${this.levelClass(author.commits, maxContributorCommits)}"></span></div>
        </div>
        <strong>${this.formatNumber(author.commits)}</strong>
      </div>`).join('');
    const authorProfile = selectedAuthor ? `
      <div class="dashboard-person-profile">
        <span class="dashboard-person-avatar" aria-hidden="true">${this.encode(this.initials(selectedAuthor.name))}</span>
        <div class="dashboard-person-identity">
          <h3>${this.encode(selectedAuthor.name)}</h3>
          <p>${this.encode(selectedAuthor.email || this.translate('dashboard.noEmail'))}</p>
        </div>
        <div class="dashboard-person-facts">
          <div><strong>${this.formatNumber(stats.commitCount)}</strong><span>${this.encode(this.translate('dashboard.commits'))}</span></div>
          <div><strong>${this.formatNumber(stats.activeRepositoryCount)}</strong><span>${this.encode(this.translate('dashboard.repositoriesTouched'))}</span></div>
          <div><strong>${this.formatNumber(stats.activeDayCount)}</strong><span>${this.encode(this.translate('dashboard.activeDays'))}</span></div>
        </div>
        <div class="dashboard-person-share">
          <div><span>${this.encode(this.translate('dashboard.contributionShare'))}</span><strong>${this.formatPercent(stats.commitCount, stats.totalCommitCount)}</strong></div>
          <div class="dashboard-bar-track" aria-hidden="true"><span class="${this.levelClass(stats.commitCount, stats.totalCommitCount)}"></span></div>
        </div>
      </div>` : '';
    const recent = stats.recentCommits.map(commit => `
      <div class="dashboard-commit-row">
        <i class="ph ph-git-commit" aria-hidden="true"></i>
        <div class="dashboard-commit-main">
          <span title="${this.encode(commit.subject)}">${this.encode(commit.subject || this.translate('dashboard.untitledCommit'))}</span>
          <small>${this.encode(commit.repositoryName)} · ${this.encode(commit.authorName)}</small>
        </div>
        <code>${this.encode(commit.hash.slice(0, 7))}</code>
        <time datetime="${this.encode(commit.date)}">${this.encode(this.formatDate(commit.date))}</time>
      </div>`).join('');
    const weekdayBars = stats.weekdays.map((count, index) => `
      <div class="dashboard-weekday-column">
        <div class="dashboard-weekday-track"><span class="${this.levelClass(count, maxWeekday)}"></span></div>
        <strong>${this.formatNumber(count)}</strong>
        <small>${this.encode(this.weekdayLabel(index))}</small>
      </div>`).join('');
    const warning = this.failedRepositories > 0
      ? `<div class="dashboard-notice" role="status"><i class="ph ph-warning-circle" aria-hidden="true"></i>${this.encode(this.translate('dashboard.partial', { count: this.failedRepositories }))}</div>`
      : stats.truncatedRepositoryCount > 0
        ? `<div class="dashboard-notice" role="status"><i class="ph ph-info" aria-hidden="true"></i>${this.encode(this.translate('dashboard.sampled', { count: stats.truncatedRepositoryCount }))}</div>`
        : '';

    this.container.innerHTML = `
      <div class="dashboard-shell">
        <header class="dashboard-header">
          <div>
            <span class="eyebrow">${this.encode(this.translate('dashboard.eyebrow'))}</span>
            <h1>${this.encode(this.translate('dashboard.title'))}</h1>
            <p>${this.encode(this.translate('dashboard.subtitle'))}</p>
          </div>
          <div class="dashboard-header-actions">
            ${this.authorControl(authorOptions, selectedAuthor, favoriteAuthor)}
            <div class="segmented-control dashboard-periods" role="group" aria-label="${this.encode(this.translate('dashboard.periodLabel'))}">
              ${([30, 90, 365] as const).map(period => `
                <button class="btn${this.period === period ? ' active' : ''}" type="button"
                  data-dashboard-period="${period}" aria-pressed="${this.period === period}">${this.encode(this.translate(`dashboard.period${period}`))}</button>`).join('')}
            </div>
            <button class="btn btn-icon" type="button" data-dashboard-refresh title="${this.encode(this.translate('dashboard.refresh'))}" aria-label="${this.encode(this.translate('dashboard.refresh'))}">
              <i class="ph ph-arrow-clockwise" aria-hidden="true"></i>
            </button>
          </div>
        </header>
        ${warning}
        <section class="dashboard-kpis" aria-label="${this.encode(this.translate('dashboard.summary'))}">
          ${this.kpi('ph-git-commit', 'dashboard.commits', stats.commitCount, trend, '', stats.timeline.map(bucket => bucket.commits))}
          ${selectedAuthor
            ? this.kpi('ph-folders', 'dashboard.repositoriesTouched', stats.activeRepositoryCount, null, '', stats.repositories.map(repo => repo.commits))
            : this.kpi('ph-users-three', 'dashboard.contributors', stats.contributorCount, contributorTrend, '', stats.repositories.map(repo => repo.contributors))}
          ${selectedAuthor
            ? this.kpi('ph-calendar-check', 'dashboard.activeDays', stats.activeDayCount, null, '', stats.weekdays)
            : this.kpi('ph-git-branch', 'dashboard.branches', stats.branchCount, null, this.translate('dashboard.tagsMeta', { count: stats.tagCount }), stats.repositories.map(repo => repo.branches))}
          ${selectedAuthor
            ? this.kpi('ph-chart-donut', 'dashboard.contributionShare', this.formatPercent(stats.commitCount, stats.totalCommitCount), null, this.translate('dashboard.shareMeta', { total: stats.totalCommitCount }), stats.repositories.map(repo => repo.commits))
            : this.kpi('ph-folders', 'dashboard.repositories', stats.repositoryCount, null, this.translate('dashboard.repositoriesMeta', { count: stats.activeRepositoryCount }), stats.repositories.map(repo => repo.commits))}
        </section>
        <section class="dashboard-grid">
          <article class="dashboard-card dashboard-activity-card">
            ${this.cardHeading('ph-chart-line-up', 'dashboard.activityTitle', 'dashboard.activityHelp')}
            <div class="dashboard-chart-summary">
              <div><strong>${this.formatNumber(stats.commitCount)}</strong><span>${this.encode(this.translate('dashboard.commitsInPeriod', { count: stats.commitCount, days: this.period }))}</span></div>
              <div class="dashboard-chart-legend" aria-hidden="true">
                <span class="is-current">${this.encode(this.translate('dashboard.currentPeriod'))}</span>
                <span class="is-previous">${this.encode(this.translate('dashboard.previousPeriod'))}</span>
              </div>
            </div>
            ${this.activityChart(stats.timeline, stats.previousTimeline)}
          </article>
          <article class="dashboard-card dashboard-repositories-card">
            ${this.cardHeading('ph-ranking', 'dashboard.activeReposTitle', 'dashboard.activeReposHelp')}
            <div class="dashboard-list">${repositories || this.inlineEmpty('dashboard.noActivity')}</div>
          </article>
          <article class="dashboard-card dashboard-contributors-card">
            ${selectedAuthor
              ? this.cardHeading('ph-user-focus', 'dashboard.personTitle', 'dashboard.personHelp')
              : this.cardHeading('ph-users', 'dashboard.topContributorsTitle', 'dashboard.topContributorsHelp')}
            <div class="dashboard-list">${selectedAuthor ? authorProfile : contributors || this.inlineEmpty('dashboard.noContributors')}</div>
          </article>
          <article class="dashboard-card dashboard-rhythm-card">
            ${this.cardHeading('ph-calendar-dots', 'dashboard.rhythmTitle', 'dashboard.rhythmHelp')}
            <div class="dashboard-weekdays">${weekdayBars}</div>
          </article>
          <article class="dashboard-card dashboard-recent-card">
            ${this.cardHeading('ph-clock-counter-clockwise', 'dashboard.recentTitle', 'dashboard.recentHelp')}
            <div class="dashboard-commit-list">${recent || this.inlineEmpty('dashboard.noRecentCommits')}</div>
          </article>
        </section>
      </div>`;
    this.bindRenderedControls();
  }

  kpi(
    icon: string,
    labelKey: string,
    value: number | string,
    trend: number | null,
    meta = '',
    bars: number[] = []
  ): string {
    const trendMarkup = trend === null
      ? ''
      : `<span class="dashboard-trend ${trend > 0 ? 'is-positive' : trend < 0 ? 'is-negative' : ''}">
          <i class="ph ${trend >= 0 ? 'ph-trend-up' : 'ph-trend-down'}" aria-hidden="true"></i>
          ${this.encode(this.translate('dashboard.trend', { value: Math.abs(trend) }))}
        </span>`;
    return `<article class="dashboard-kpi">
      <div class="dashboard-kpi-label"><i class="ph ${icon}" aria-hidden="true"></i><span>${this.encode(this.translate(labelKey))}</span></div>
      <div class="dashboard-kpi-body">
        <div class="dashboard-kpi-value"><strong>${typeof value === 'number' ? this.formatNumber(value) : this.encode(value)}</strong>${trendMarkup}</div>
        ${this.sparkBars(bars)}
      </div>
      ${meta ? `<small>${this.encode(meta)}</small>` : ''}
    </article>`;
  }

  sparkBars(values: number[]): string {
    const compact = values.length > 8
      ? values.filter((_value, index) => index % Math.ceil(values.length / 8) === 0).slice(0, 8)
      : values;
    const normalized = compact.length ? compact : [0, 0, 0, 0, 0, 0];
    const max = Math.max(1, ...normalized);
    return `<div class="dashboard-spark-bars" aria-hidden="true">${normalized.map(value => (
      `<span class="${this.levelClass(value, max)}"></span>`
    )).join('')}</div>`;
  }

  cardHeading(icon: string, titleKey: string, helpKey: string): string {
    return `<header class="dashboard-card-heading">
      <i class="ph ${icon}" aria-hidden="true"></i>
      <div><h2>${this.encode(this.translate(titleKey))}</h2><p>${this.encode(this.translate(helpKey))}</p></div>
    </header>`;
  }

  activityChart(timeline: RepositoryDashboardStats['timeline'], previousTimeline: number[]): string {
    const max = Math.max(1, ...timeline.map(bucket => bucket.commits), ...previousTimeline);
    const points = timeline.map((bucket, index) => ({
      x: timeline.length === 1 ? 500 : (index / (timeline.length - 1)) * 1000,
      y: 190 - ((bucket.commits / max) * 155),
      bucket
    }));
    const previousPoints = previousTimeline.map((commits, index) => ({
      x: previousTimeline.length === 1 ? 500 : (index / (previousTimeline.length - 1)) * 1000,
      y: 190 - ((commits / max) * 155)
    }));
    const path = points.map((point, index) => `${index === 0 ? 'M' : 'L'} ${point.x.toFixed(2)} ${point.y.toFixed(2)}`).join(' ');
    const previousPath = previousPoints.map((point, index) => `${index === 0 ? 'M' : 'L'} ${point.x.toFixed(2)} ${point.y.toFixed(2)}`).join(' ');
    const areaPath = `M 0 190 L ${points.map(point => `${point.x.toFixed(2)} ${point.y.toFixed(2)}`).join(' L ')} L 1000 190 Z`;
    const dots = points.map(point => `<circle cx="${point.x.toFixed(2)}" cy="${point.y.toFixed(2)}" r="4"><title>${this.encode(this.translate('dashboard.chartPoint', { date: this.formatDate(point.bucket.start), count: point.bucket.commits }))}</title></circle>`).join('');
    const labels = points.filter((_point, index) => index === 0 || index === points.length - 1 || index === Math.floor(points.length / 2)).map(point => (
      `<span class="${point.x === 0 ? 'dashboard-label-start' : point.x === 1000 ? 'dashboard-label-end' : 'dashboard-label-middle'}">${this.encode(this.formatShortDate(point.bucket.start))}</span>`
    )).join('');
    return `<div class="dashboard-chart" role="img" aria-label="${this.encode(this.translate('dashboard.chartLabel'))}">
      <div class="dashboard-chart-body">
        <div class="dashboard-chart-axis" aria-hidden="true"><span>${this.formatNumber(max)}</span><span>${this.formatNumber(Math.round(max / 2))}</span><span>0</span></div>
        <svg viewBox="0 0 1000 220" preserveAspectRatio="none" aria-hidden="true">
          <line x1="0" y1="35" x2="1000" y2="35"></line><line x1="0" y1="112" x2="1000" y2="112"></line><line x1="0" y1="190" x2="1000" y2="190"></line>
          <path class="dashboard-chart-area" d="${areaPath}"></path>
          <path class="dashboard-chart-previous" d="${previousPath}"></path>
          <path class="dashboard-chart-current" d="${path}"></path>${dots}
        </svg>
      </div>
      <div class="dashboard-chart-labels">${labels}</div>
    </div>`;
  }

  levelClass(value: number, max: number): string {
    return `dashboard-level-${Math.max(0, Math.min(10, Math.round((value / Math.max(1, max)) * 10)))}`;
  }

  inlineEmpty(key: string): string {
    return `<div class="dashboard-inline-empty"><i class="ph ph-chart-bar" aria-hidden="true"></i>${this.encode(this.translate(key))}</div>`;
  }

  contributorOptions(): Array<{ key: string; name: string; email: string }> {
    const contributors = new Map<string, { key: string; name: string; email: string }>();
    for (const input of this.inputs) {
      for (const commit of input.commits) {
        const key = contributorKey(commit);
        if (!key || contributors.has(key)) continue;
        contributors.set(key, {
          key,
          name: this.displayContributorName(commit),
          email: commit.authorEmail || ''
        });
      }
    }
    return [...contributors.values()].sort((left, right) => left.name.localeCompare(right.name));
  }

  displayContributorName(commit: DashboardCommit): string {
    return (commit.authorName || '').trim().replace(/\s+/g, ' ')
      || commit.authorEmail?.trim()
      || this.translate('dashboard.unknownAuthor');
  }

  authorControl(
    options: Array<{ key: string; name: string; email: string }>,
    selectedAuthor: { key: string; name: string; email: string } | null,
    favoriteAuthor: { key: string; name: string; email: string } | null
  ): string {
    const selectedLabel = selectedAuthor?.name || this.translate('dashboard.allContributors');
    const shortcut = favoriteAuthor ? `
      <button class="dashboard-author-favorite-shortcut btn-icon" type="button"
        data-dashboard-favorite-select title="${this.encode(this.translate('dashboard.selectFavorite'))}"
        aria-label="${this.encode(this.translate('dashboard.selectFavorite'))}" aria-pressed="true">
        <i class="ph ph-star" aria-hidden="true"></i>
      </button>` : '';
    return `<div class="dashboard-author-control">
      <div class="dashboard-author-control-row">
        <button class="dashboard-author-trigger" type="button" data-dashboard-author-trigger
          aria-haspopup="listbox" aria-expanded="${this.authorMenuOpen}"
          aria-label="${this.encode(this.translate('dashboard.authorFilter'))}">
          <i class="ph ph-user-focus" aria-hidden="true"></i>
          <span class="dashboard-author-trigger-copy">
            <small>${this.encode(this.translate('dashboard.authorFilter'))}</small>
            <strong>${this.encode(selectedLabel)}</strong>
          </span>
          <i class="ph ph-caret-down dashboard-author-caret" aria-hidden="true"></i>
        </button>${shortcut}
      </div>
      <div class="dashboard-author-menu${this.authorMenuOpen ? '' : ' is-hidden'}" data-dashboard-author-menu>
        <div class="dashboard-author-search">
          <i class="ph ph-magnifying-glass" aria-hidden="true"></i>
          <input type="search" data-dashboard-author-search autocomplete="off"
            value="${this.encode(this.contributorQuery)}"
            placeholder="${this.encode(this.translate('dashboard.searchContributors'))}"
            aria-label="${this.encode(this.translate('dashboard.searchContributors'))}">
        </div>
        <div class="dashboard-author-options" data-dashboard-author-options role="listbox"
          aria-label="${this.encode(this.translate('dashboard.authorFilter'))}">
          ${this.authorOptionsMarkup(options, selectedAuthor?.key || '', favoriteAuthor?.key || '')}
        </div>
      </div>
    </div>`;
  }

  authorOptionsMarkup(
    options: Array<{ key: string; name: string; email: string }>,
    selectedKey: string,
    favoriteKey: string
  ): string {
    const query = this.contributorQuery.trim().toLocaleLowerCase(this.getLocale());
    const visible = options.filter(option => !query
      || option.name.toLocaleLowerCase(this.getLocale()).includes(query)
      || option.email.toLocaleLowerCase(this.getLocale()).includes(query));
    const allSelected = !selectedKey;
    const all = `<div class="dashboard-author-option-row" role="presentation">
      <button class="dashboard-author-option${allSelected ? ' is-selected' : ''}" type="button"
        data-dashboard-author-option="" role="option" aria-selected="${allSelected}">
        <i class="ph ph-users-three" aria-hidden="true"></i>
        <span>${this.encode(this.translate('dashboard.allContributors'))}</span>
        ${allSelected ? '<i class="ph ph-check dashboard-author-option-check" aria-hidden="true"></i>' : ''}
      </button>
    </div>`;
    const rows = visible.map(option => {
      const selected = option.key === selectedKey;
      const favorite = option.key === favoriteKey;
      return `<div class="dashboard-author-option-row" role="presentation">
        <button class="dashboard-author-option${selected ? ' is-selected' : ''}" type="button"
          data-dashboard-author-option="${this.encode(option.key)}" role="option" aria-selected="${selected}"
          title="${this.encode(option.email || option.name)}">
          <span class="dashboard-avatar" aria-hidden="true">${this.encode(this.initials(option.name))}</span>
          <span class="dashboard-author-option-copy"><strong>${this.encode(option.name)}</strong>${option.email ? `<small>${this.encode(option.email)}</small>` : ''}</span>
          ${selected ? '<i class="ph ph-check dashboard-author-option-check" aria-hidden="true"></i>' : ''}
        </button>
        <button class="dashboard-author-favorite${favorite ? ' is-favorite' : ''}" type="button"
          data-dashboard-favorite="${this.encode(option.key)}"
          title="${this.encode(this.translate(favorite ? 'dashboard.removeFavorite' : 'dashboard.setFavorite'))}"
          aria-label="${this.encode(this.translate(favorite ? 'dashboard.removeFavorite' : 'dashboard.setFavorite'))}"
          aria-pressed="${favorite}">
          <i class="ph ph-star" aria-hidden="true"></i>
        </button>
      </div>`;
    }).join('');
    return all + (rows || `<div class="dashboard-author-empty">${this.encode(this.translate('dashboard.noMatchingContributors'))}</div>`);
  }

  bindRenderedControls(): void {
    this.container.querySelectorAll<HTMLElement>('[data-dashboard-period]').forEach(button => {
      button.onclick = () => {
        const period = Number(button.dataset.dashboardPeriod);
        if (period !== 30 && period !== 90 && period !== 365) return;
        this.period = period;
        void this.refresh();
      };
    });
    this.container.querySelectorAll<HTMLElement>('[data-dashboard-refresh]').forEach(button => {
      button.onclick = () => { void this.refresh(); };
    });
    const authorTrigger = this.container.querySelector<HTMLButtonElement>('[data-dashboard-author-trigger]');
    authorTrigger?.addEventListener('click', () => {
      this.authorMenuOpen = !this.authorMenuOpen;
      this.render();
      if (this.authorMenuOpen) this.container.querySelector<HTMLInputElement>('[data-dashboard-author-search]')?.focus();
    });
    const favoriteShortcut = this.container.querySelector<HTMLButtonElement>('[data-dashboard-favorite-select]');
    favoriteShortcut?.addEventListener('click', () => {
      if (!this.favoriteContributor) return;
      this.selectContributor(this.favoriteContributor);
    });
    this.container.querySelectorAll<HTMLButtonElement>('[data-dashboard-author-option]').forEach(option => {
      option.addEventListener('click', () => this.selectContributor(option.dataset.dashboardAuthorOption || ''));
    });
    this.container.querySelectorAll<HTMLButtonElement>('[data-dashboard-favorite]').forEach(button => {
      button.addEventListener('click', event => {
        event.stopPropagation();
        this.toggleFavorite(button.dataset.dashboardFavorite || '');
      });
    });
    const authorSearch = this.container.querySelector<HTMLInputElement>('[data-dashboard-author-search]');
    authorSearch?.addEventListener('input', () => {
      this.contributorQuery = authorSearch.value;
      const list = this.container.querySelector<HTMLElement>('[data-dashboard-author-options]');
      if (!list) return;
      const options = this.contributorOptions();
      const selected = options.find(option => option.key === this.selectedContributor);
      const favorite = options.find(option => option.key === this.favoriteContributor);
      list.innerHTML = this.authorOptionsMarkup(options, selected?.key || '', favorite?.key || '');
      this.bindAuthorOptionControls();
    });
  }

  bindAuthorOptionControls(): void {
    this.container.querySelectorAll<HTMLButtonElement>('[data-dashboard-author-option]').forEach(option => {
      option.onclick = () => this.selectContributor(option.dataset.dashboardAuthorOption || '');
    });
    this.container.querySelectorAll<HTMLButtonElement>('[data-dashboard-favorite]').forEach(button => {
      button.onclick = event => {
        event.stopPropagation();
        this.toggleFavorite(button.dataset.dashboardFavorite || '');
      };
    });
  }

  selectContributor(key: string): void {
    this.selectedContributor = key;
    this.writePreference('gittree.dashboard.selectedContributor', key);
    this.authorMenuOpen = false;
    this.contributorQuery = '';
    this.render();
  }

  toggleFavorite(key: string): void {
    if (!key) return;
    this.favoriteContributor = this.favoriteContributor === key ? '' : key;
    this.writePreference('gittree.dashboard.favoriteContributor', this.favoriteContributor);
    this.render();
  }

  initials(name: string): string {
    const parts = name.trim().split(/\s+/).filter(Boolean);
    return (parts.length > 1 ? `${parts[0][0]}${parts[parts.length - 1][0]}` : parts[0]?.slice(0, 2) || '?').toUpperCase();
  }

  formatNumber(value: number): string {
    return new Intl.NumberFormat(this.getLocale()).format(value);
  }

  formatPercent(value: number, total: number): string {
    const percentage = total > 0 ? value / total : 0;
    return new Intl.NumberFormat(this.getLocale(), {
      style: 'percent',
      maximumFractionDigits: 0
    }).format(percentage);
  }

  formatDate(value: string | Date): string {
    const date = value instanceof Date ? value : new Date(value);
    return new Intl.DateTimeFormat(this.getLocale(), { day: 'numeric', month: 'short', year: 'numeric' }).format(date);
  }

  formatShortDate(value: Date): string {
    return new Intl.DateTimeFormat(this.getLocale(), { day: 'numeric', month: 'short' }).format(value);
  }

  weekdayLabel(index: number): string {
    const sunday = new Date(Date.UTC(2024, 0, 7 + index));
    return new Intl.DateTimeFormat(this.getLocale(), { weekday: 'narrow', timeZone: 'UTC' }).format(sunday);
  }

  destroy(): void {
    this.generation += 1;
    this.button.removeEventListener('click', this.handleToggle);
    document.removeEventListener('pointerdown', this.handleDocumentPointerDown);
    document.removeEventListener('keydown', this.handleDocumentKeydown);
    this.close();
    this.container.replaceChildren();
    this.mounted = false;
  }
}

if (typeof window !== 'undefined') {
  (window as unknown as { RepositoryDashboard: typeof RepositoryDashboard }).RepositoryDashboard = RepositoryDashboard;
}

declare const module: { exports: unknown } | undefined;
if (typeof module !== 'undefined' && (module as { exports?: unknown }).exports) {
  (module as { exports: unknown }).exports = {
    RepositoryDashboard,
    buildRepositoryDashboardStats,
    percentageChange
  };
}
