export interface ShortcutDefinition {
  key: string;
  shift?: boolean;
  primary?: boolean;
}

export type ShortcutAction = 'open' | 'search' | 'fetch' | 'pull' | 'push' | 'newBranch';

export interface ShortcutCallbacks {
  openRepository: () => void;
  search?: () => void;
  fetch: () => void;
  pull: () => void;
  push: () => void;
  newBranch: () => void;
  getInspectorState: () => string;
  restoreInspector: () => void;
}

export interface ShortcutDependencies {
  document: Document;
  platform: string;
  translate: (key: string) => string;
  callbacks: ShortcutCallbacks;
}

export class ShortcutController {
  document: Document;
  platform: string;
  translate: (key: string) => string;
  callbacks: ShortcutCallbacks;
  keydownListener: ((event: KeyboardEvent) => void) | null;

  constructor({ document, platform, translate, callbacks }: ShortcutDependencies) {
    this.document = document;
    this.platform = platform;
    this.translate = translate;
    this.callbacks = callbacks;
    this.keydownListener = null;
  }

  definitions(): Record<ShortcutAction, ShortcutDefinition> {
    return {
      open: { key: 'o' },
      search: { key: 'p' },
      fetch: { key: 'f', shift: true },
      pull: { key: 'l', shift: true },
      push: { key: 'p', shift: true },
      newBranch: { key: 'b', shift: true }
    };
  }

  label(action: string): string {
    const shortcut = this.definitions()[action as ShortcutAction];
    if (!shortcut) return '';
    if (shortcut.primary === false) return shortcut.key;
    if (this.platform === 'darwin') {
      return `⌘${shortcut.shift ? '⇧' : ''}${shortcut.key.toUpperCase()}`;
    }
    return `Ctrl+${shortcut.shift ? 'Shift+' : ''}${shortcut.key.toUpperCase()}`;
  }

  isPrimaryModifier(event: KeyboardEvent): boolean {
    return this.platform === 'darwin' ? event.metaKey : event.ctrlKey;
  }

  setPlatform(platform: string): void {
    this.platform = platform || 'win32';
  }

  refreshHints(): void {
    this.document.querySelectorAll<HTMLElement>('[data-platform-shortcut]').forEach(element => {
      element.textContent = this.label(element.dataset.platformShortcut ?? '');
    });
    const titleKeys: Record<string, string> = {
      fetch: 'actions.fetch',
      pull: 'actions.pull',
      push: 'actions.push',
      newBranch: 'sidebar.newBranch'
    };
    this.document.querySelectorAll<HTMLElement>('[data-shortcut-title]').forEach(element => {
      const action = element.dataset.shortcutTitle ?? '';
      element.title = `${this.translate(titleKeys[action])} (${this.label(String(action))})`;
      element.setAttribute('aria-label', element.title);
    });
  }

  mount(): void {
    if (this.keydownListener) return;
    this.keydownListener = event => this.handleKeydown(event);
    this.document.addEventListener('keydown', this.keydownListener);
  }

  handleKeydown(event: KeyboardEvent): void {
    const editable = (event.target as HTMLElement).closest?.('input, textarea, select, [contenteditable="true"]');
    const modalOpen = !this.document
      .getElementById('modal-overlay')!
      .classList.contains('is-hidden');
    const primary = this.isPrimaryModifier(event);
    const key = event.key.toLowerCase();

    if (!event.repeat && !editable && !modalOpen && primary && !event.shiftKey && key === 'o') {
      event.preventDefault();
      this.callbacks.openRepository();
    }
    if (!event.repeat && !editable && !modalOpen && primary && event.shiftKey) {
      const action = ({
        f: 'fetch',
        l: 'pull',
        p: 'push',
        b: 'newBranch'
      } as Record<string, keyof ShortcutCallbacks>)[key];
      if (action) {
        event.preventDefault();
        (this.callbacks[action] as () => void)();
      }
    }
    if (
      event.key === 'Escape' &&
      !modalOpen &&
      this.callbacks.getInspectorState() === 'maximized'
    ) {
      this.callbacks.restoreInspector();
    }
  }

  destroy(): void {
    if (!this.keydownListener) return;
    this.document.removeEventListener('keydown', this.keydownListener);
    this.keydownListener = null;
  }
}

if (typeof window !== 'undefined') {
  (window as unknown as { ShortcutController: typeof ShortcutController }).ShortcutController = ShortcutController;
}

declare const module: { exports: unknown } | undefined;
if (typeof module !== 'undefined' && (module as { exports?: unknown }).exports) {
  (module as { exports: unknown }).exports = ShortcutController;
}
