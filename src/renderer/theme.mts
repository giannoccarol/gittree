export interface ToneOption {
  id: string;
  preview: string[];
}

type ToneMap = Record<string, string>;

export const Theme = {
  storageKey: 'gittree.theme',
  toneStorageKey: 'gittree.tones',
  themes: ['light', 'dark'],
  defaultTones: { light: 'frost', dark: 'onyx' } as ToneMap,
  tones: {
    light: [
      { id: 'frost', preview: ['rgb(243,246,251)', 'rgb(255,255,255)', 'rgb(233,238,245)'] },
      { id: 'pure', preview: ['rgb(244,244,245)', 'rgb(255,255,255)', 'rgb(234,234,236)'] },
      { id: 'sand', preview: ['rgb(248,244,236)', 'rgb(255,253,249)', 'rgb(237,230,217)'] },
      { id: 'sage', preview: ['rgb(242,246,240)', 'rgb(252,254,249)', 'rgb(230,236,225)'] },
      { id: 'lilac', preview: ['rgb(244,241,250)', 'rgb(253,252,255)', 'rgb(233,228,241)'] }
    ],
    dark: [
      { id: 'onyx', preview: ['rgb(30,30,33)', 'rgb(24,24,26)', 'rgb(10,10,12)'] },
      { id: 'charcoal', preview: ['rgb(42,42,46)', 'rgb(30,30,33)', 'rgb(21,21,23)'] },
      { id: 'graphite', preview: ['rgb(37,49,62)', 'rgb(22,29,38)', 'rgb(14,18,24)'] },
      { id: 'umber', preview: ['rgb(43,37,33)', 'rgb(27,24,22)', 'rgb(15,12,11)'] },
      { id: 'pine', preview: ['rgb(31,42,36)', 'rgb(19,24,21)', 'rgb(11,15,13)'] }
    ] as ToneOption[]
  } as Record<'light' | 'dark', ToneOption[]>,

  init(): void {
    let saved = localStorage.getItem(this.storageKey) || 'light';
    if (saved === 'black') saved = 'dark';
    this.apply(saved, false);
  },

  toggle(): void {
    const current = document.documentElement.dataset.theme;
    this.apply(current === 'light' ? 'dark' : 'light', true);
  },

  apply(theme: unknown, persist = true): void {
    const safeTheme = this.themes.includes(theme as string) ? theme as string : 'light';
    document.documentElement.dataset.theme = safeTheme;
    document.documentElement.dataset.tone = this.getTone(safeTheme);
    if (persist) localStorage.setItem(this.storageKey, safeTheme);
    this.notifyMain(safeTheme);
    this.syncControls();
  },

  setTone(theme: string, toneId: string): void {
    const safeTheme = this.themes.includes(theme) ? theme : 'light';
    if (!this.tones[safeTheme].some((tone: ToneOption) => tone.id === toneId)) return;
    const tones = this.readTones();
    tones[safeTheme] = toneId;
    localStorage.setItem(this.toneStorageKey, JSON.stringify(tones));
    if (document.documentElement.dataset.theme === safeTheme) {
      document.documentElement.dataset.tone = toneId;
      this.notifyMain(safeTheme);
    }
  },

  getTone(theme: 'light' | 'dark'): string {
    const toneId = this.readTones()[theme] || this.defaultTones[theme];
    const valid = this.tones[theme]?.some((tone: ToneOption) => tone.id === toneId);
    return valid ? toneId : this.defaultTones[theme];
  },

  readTones(): ToneMap {
    try {
      const value: unknown = JSON.parse(localStorage.getItem(this.toneStorageKey) ?? 'null');
      return value && typeof value === 'object' && !Array.isArray(value) ? value as ToneMap : {};
    } catch {
      return {};
    }
  },

  notifyMain(theme: string): void {
    const shell = getComputedStyle(document.documentElement)
      .getPropertyValue('--surface-shell').trim();
    window.gitTree?.setTheme?.(theme, shell);
  },

  syncControls(): void {
    const theme = document.documentElement.dataset.theme;
    const control = theme === 'light'
      ? { icon: 'ph ph-moon', titleKey: 'common.nextDarkTheme' }
      : { icon: 'ph ph-sun', titleKey: 'common.nextLightTheme' };

    document.querySelectorAll<HTMLElement>('.theme-toggle i').forEach(icon => {
      icon.className = control.icon;
    });
    if (window.i18next?.isInitialized) {
      document.querySelectorAll<HTMLElement>('.theme-toggle').forEach(button => {
        const label = t(control.titleKey);
        button.title = label;
        button.setAttribute('aria-label', label);
      });
    }
  }
};

Theme.init();

if (typeof window !== 'undefined') {
  (window as unknown as { Theme: typeof Theme }).Theme = Theme;
}

declare const module: { exports: unknown } | undefined;
if (typeof module !== 'undefined' && (module as { exports?: unknown }).exports) {
  (module as { exports: unknown }).exports = Theme;
}
