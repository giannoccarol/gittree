/**
 * The commit part of the inspector header: message body, branches and tags,
 * parents and the actions available on the inspected commit.
 */
export interface CommitSummaryRef {
  shortName: string;
  type: string;
}

export interface CommitSummaryState {
  hash: string;
  body: string;
  parents: string[];
  refs: CommitSummaryRef[];
  /** Whether a newer and an older commit exist next to it in the history. */
  canGoNewer: boolean;
  canGoOlder: boolean;
}

export interface CommitSummaryDependencies {
  container: HTMLElement;
  translate: (key: string, options?: Record<string, unknown>) => string;
  onCopyHash: (hash: string) => void;
  onCreateBranch: (hash: string) => void;
  onMoreActions: (hash: string, anchor: HTMLElement) => void;
  onSelectCommit: (hash: string) => void;
  onNavigate: (direction: 'newer' | 'older') => void;
}

/**
 * Joins the hard-wrapped lines of each paragraph so the text reflows to the
 * panel width. Blank lines, list items and indented lines keep their breaks.
 */
export function reflowMessage(body: string): string {
  return body
    .replace(/\r\n?/g, '\n')
    .split(/\n{2,}/)
    .map(paragraph => paragraph.split('\n').reduce((text, line, index) => {
      if (index === 0) return line;
      const keepsBreak = /^\s/.test(line) || /^(?:[-*+]|\d+[.)])\s/.test(line);
      return `${text}${keepsBreak ? '\n' : ' '}${line}`;
    }, ''))
    .join('\n\n');
}

/** Bodies longer than this start clamped with a "Show more" control. */
const LONG_BODY_LINES = 2;
const LONG_BODY_CHARACTERS = 140;

export class CommitSummary {
  container: HTMLElement;
  translate: CommitSummaryDependencies['translate'];
  callbacks: Omit<CommitSummaryDependencies, 'container' | 'translate'>;
  state: CommitSummaryState | null;
  bodyExpanded: boolean;
  mounted: boolean;
  handleClick: (event: MouseEvent) => void;

  constructor({ container, translate, ...callbacks }: CommitSummaryDependencies) {
    this.container = container;
    this.translate = translate;
    this.callbacks = callbacks;
    this.state = null;
    this.bodyExpanded = false;
    this.mounted = false;
    this.handleClick = event => {
      const control = (event.target as HTMLElement | null)?.closest?.('[data-summary-action]') as HTMLElement | null;
      if (!control || !this.state || !this.container.contains(control)) return;
      const hash = this.state.hash;
      switch (control.dataset.summaryAction) {
        case 'copy': this.callbacks.onCopyHash(hash); break;
        case 'branch': this.callbacks.onCreateBranch(hash); break;
        case 'more': this.callbacks.onMoreActions(hash, control); break;
        case 'parent': if (control.dataset.hash) this.callbacks.onSelectCommit(control.dataset.hash); break;
        case 'newer': this.callbacks.onNavigate('newer'); break;
        case 'older': this.callbacks.onNavigate('older'); break;
        case 'body':
          this.bodyExpanded = !this.bodyExpanded;
          this.render();
          break;
        default: break;
      }
    };
  }

  mount(): void {
    if (this.mounted) return;
    this.mounted = true;
    this.container.addEventListener('click', this.handleClick);
    this.render();
  }

  update(state: CommitSummaryState | null): void {
    if (state?.hash !== this.state?.hash) this.bodyExpanded = false;
    this.state = state;
    this.render();
  }

  /** Updates only the newer/older availability, for example after paging. */
  setNavigation(canGoNewer: boolean, canGoOlder: boolean): void {
    if (!this.state) return;
    if (this.state.canGoNewer === canGoNewer && this.state.canGoOlder === canGoOlder) return;
    this.state = { ...this.state, canGoNewer, canGoOlder };
    this.render();
  }

  refreshTranslations(): void {
    this.render();
  }

  render(): void {
    const state = this.state;
    this.container.classList.toggle('is-hidden', !state);
    if (!state) {
      this.container.replaceChildren();
      return;
    }
    const nodes: HTMLElement[] = [];
    const references = this.renderReferences(state);
    if (references) nodes.push(references);
    if (state.body) nodes.push(...this.renderBody(state.body));
    nodes.push(this.renderActions(state));
    this.container.replaceChildren(...nodes);
  }

  renderReferences(state: CommitSummaryState): HTMLElement | null {
    if (!state.refs.length && !state.parents.length) return null;
    const row = document.createElement('div');
    row.className = 'detail-commit-refs';
    for (const ref of state.refs) {
      const badge = document.createElement('span');
      badge.className = `badge badge-${ref.type}`;
      badge.textContent = ref.shortName;
      badge.title = ref.shortName;
      row.appendChild(badge);
    }
    if (state.parents.length) {
      const label = document.createElement('span');
      label.className = 'detail-commit-parents-label';
      label.textContent = this.translate(state.parents.length > 1 ? 'details.parents' : 'details.parent');
      row.appendChild(label);
      for (const parent of state.parents) {
        const button = document.createElement('button');
        button.type = 'button';
        button.className = 'detail-commit-parent';
        button.dataset.summaryAction = 'parent';
        button.dataset.hash = parent;
        button.textContent = parent.slice(0, 7);
        button.title = this.translate('details.openParent', { hash: parent.slice(0, 7) });
        row.appendChild(button);
      }
    }
    return row;
  }

  renderBody(body: string): HTMLElement[] {
    const text = document.createElement('p');
    text.className = 'detail-commit-body';
    const message = reflowMessage(body);
    text.textContent = message;
    const long = message.split('\n').length > LONG_BODY_LINES || message.length > LONG_BODY_CHARACTERS;
    text.classList.toggle('is-clamped', long && !this.bodyExpanded);
    if (!long) return [text];
    const toggle = document.createElement('button');
    toggle.type = 'button';
    toggle.className = 'detail-commit-body-toggle';
    toggle.dataset.summaryAction = 'body';
    toggle.setAttribute('aria-expanded', String(this.bodyExpanded));
    toggle.textContent = this.translate(this.bodyExpanded ? 'details.showLess' : 'details.showMore');
    return [text, toggle];
  }

  renderActions(state: CommitSummaryState): HTMLElement {
    const row = document.createElement('div');
    row.className = 'detail-commit-actions';
    row.append(
      this.actionButton('copy', 'ph-copy', 'details.copyHash', true),
      this.actionButton('branch', 'ph-git-branch', 'details.createBranch', true),
      this.actionButton('more', 'ph-dots-three', 'details.moreActions', false)
    );
    const navigation = document.createElement('div');
    navigation.className = 'detail-commit-navigation';
    const newer = this.iconButton('newer', 'ph-arrow-up', 'details.newerCommit');
    newer.disabled = !state.canGoNewer;
    const older = this.iconButton('older', 'ph-arrow-down', 'details.olderCommit');
    older.disabled = !state.canGoOlder;
    navigation.append(newer, older);
    row.appendChild(navigation);
    return row;
  }

  actionButton(action: string, icon: string, labelKey: string, showLabel: boolean): HTMLButtonElement {
    const button = document.createElement('button');
    button.type = 'button';
    button.className = 'btn btn-small detail-commit-action';
    button.dataset.summaryAction = action;
    button.title = this.translate(labelKey);
    // The label is hidden in the narrow inspector, so the name stays on the button.
    button.setAttribute('aria-label', this.translate(labelKey));
    const iconElement = document.createElement('i');
    iconElement.className = `ph ${icon}`;
    iconElement.setAttribute('aria-hidden', 'true');
    button.appendChild(iconElement);
    if (showLabel) {
      const label = document.createElement('span');
      label.className = 'detail-commit-action-label';
      label.textContent = this.translate(labelKey);
      button.appendChild(label);
    } else {
      button.setAttribute('aria-haspopup', 'menu');
    }
    return button;
  }

  iconButton(action: string, icon: string, labelKey: string): HTMLButtonElement {
    const button = document.createElement('button');
    button.type = 'button';
    button.className = 'btn-icon detail-commit-step';
    button.dataset.summaryAction = action;
    button.title = this.translate(labelKey);
    button.setAttribute('aria-label', this.translate(labelKey));
    const iconElement = document.createElement('i');
    iconElement.className = `ph ${icon}`;
    iconElement.setAttribute('aria-hidden', 'true');
    button.appendChild(iconElement);
    return button;
  }

  destroy(): void {
    if (!this.mounted) return;
    this.mounted = false;
    this.container.removeEventListener('click', this.handleClick);
    this.container.replaceChildren();
  }
}
