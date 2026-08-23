import type { AiService } from '../ai/ai-service.mts';

export function registerAiHandlers({ registerHandler, registerManagedRepoHandler, aiService }: {
  registerHandler: (channel: string, handler: (...args: never[]) => unknown) => void;
  registerManagedRepoHandler: (channel: string, handler: (...args: never[]) => unknown) => void;
  aiService: AiService;
}) {
  registerHandler('ai:settings-get', () => aiService.getSettings());
  registerHandler('ai:settings-set', (input: unknown) => aiService.setSettings(input as Record<string, unknown>));
  registerHandler('ai:key-set', key => aiService.setKey(key));
  registerHandler('ai:key-clear', () => aiService.clearKey());
  registerHandler('ai:test-connection', () => aiService.testConnection());
  registerManagedRepoHandler('ai:commit-message', (repoPath: string, options = {}) => (
    aiService.generateCommitMessage(repoPath, options)
  ));
  registerManagedRepoHandler('ai:explain-changes', (repoPath: string, options = {}) => (
    aiService.explainChanges(repoPath, options)
  ));
  registerManagedRepoHandler('ai:explain-conflict', (repoPath: string, options = {}) => (
    aiService.explainConflict(repoPath, options)
  ));
  registerManagedRepoHandler('ai:explain-commit', (repoPath: string, options = {}) => (
    aiService.explainCommit(repoPath, options)
  ));
  registerManagedRepoHandler('ai:history-search', (repoPath: string, options = {}) => (
    aiService.searchHistory(repoPath, options)
  ));
  registerManagedRepoHandler('ai:explain-lines', (repoPath: string, options = {}) => (
    aiService.explainLines(repoPath, options)
  ));
  registerManagedRepoHandler('ai:pr-description', (repoPath: string, options = {}) => (
    aiService.generatePrDescription(repoPath, options)
  ));
}


