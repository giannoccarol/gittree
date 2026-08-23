export class StatusBar {
  repoEl: HTMLElement;
  branchEl: HTMLElement;
  infoEl: HTMLElement;

  constructor() {
    this.repoEl = document.getElementById('status-repo')! as HTMLElement;
    this.branchEl = document.getElementById('status-branch')! as HTMLElement;
    this.infoEl = document.getElementById('status-info')! as HTMLElement;
  }

  setRepo(name: string | undefined): void { this.repoEl.textContent = name || ''; }
  setBranch(name: string | undefined): void { this.branchEl.textContent = name || ''; }
  setInfo(text: string | undefined): void { this.infoEl.textContent = text || ''; }
  clear(): void { this.repoEl.textContent = ''; this.branchEl.textContent = ''; this.infoEl.textContent = ''; }
}

if (typeof window !== 'undefined') {
  (window as unknown as { StatusBar: typeof StatusBar }).StatusBar = StatusBar;
}

declare const module: { exports: unknown } | undefined;
if (typeof module !== 'undefined' && (module as { exports?: unknown }).exports) {
  (module as { exports: unknown }).exports = StatusBar;
}
