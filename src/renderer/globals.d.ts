/**
 * Ambient declarations for renderer globals that are not ES modules.
 *
 * i18n.js remains a classic script by decision: it carries the translation
 * resources plus the loader and is guarded at runtime by test/i18n-parity.
 * i18next is the vendor UMD bundle. Every converted renderer module is
 * imported directly; only these names resolve through the global scope.
 */

declare const t: (key: string, options?: Record<string, unknown>) => string;

declare const i18next: {
  isInitialized: boolean;
  language: string;
  init(options: Record<string, unknown>): Promise<unknown>;
  changeLanguage(language: string): Promise<unknown>;
  on(event: string, handler: () => void): void;
  t(key: string, options?: Record<string, unknown>): string;
};

declare const HtmlEncoder: typeof import('./html-encoder.mts').HtmlEncoder;
declare const DiffParser: typeof import('./components/diff-parser.mts').DiffParser;
declare const DiffLayout: typeof import('./components/diff-layout.mts').DiffLayout;
declare const BranchNaming: typeof import('./components/branch-naming.mts').BranchNaming;
declare const Theme: typeof import('./theme.mts').Theme;
declare const LocalizedDateFormatter: typeof import('./localized-date-formatter.mts').LocalizedDateFormatter;
declare const PrCreatePrefill: typeof import('./pr-create-prefill.mts').PrCreatePrefill;

interface Window {
  gitTree: import('../shared/bridge.mts').GitTreeBridge;
  app: import('./app.mts').GitTreeApp;
  i18next?: typeof i18next;
  I18n?: {
    supportedLanguages: string[];
    init(): Promise<void>;
    t(key: string, options?: Record<string, unknown>): string;
    toggleLanguage(): Promise<void>;
    translateDOM(root?: ParentNode): void;
    syncControls(): void;
  };
  t: typeof t;
}
