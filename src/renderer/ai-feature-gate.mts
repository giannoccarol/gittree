const STATIC_AI_CONTROL_SELECTORS = [
  '#btn-ai-commit',
  '#btn-ai-explain',
  '#search-ai-ask',
  '#btn-pr-create-ai'
];

let agentsFeatureEnabled = true;
const listeners = new Set<(enabled: boolean) => void>();

export function isAgentsFeatureEnabled(): boolean {
  return agentsFeatureEnabled;
}

function applyStaticVisibility(enabled: boolean): void {
  if (typeof document === 'undefined') return;
  for (const selector of STATIC_AI_CONTROL_SELECTORS) {
    document.querySelector(selector)?.classList.toggle('is-hidden', !enabled);
  }
  if (!enabled) {
    document.getElementById('ai-explanation')?.classList.add('is-hidden');
    document.getElementById('conflict-ai-panel')?.classList.add('is-hidden');
  }
}

function notify(enabled: boolean): void {
  applyStaticVisibility(enabled);
  for (const listener of listeners) listener(enabled);
}

export function setAgentsFeatureEnabled(enabled: boolean): void {
  if (agentsFeatureEnabled === enabled) return;
  agentsFeatureEnabled = enabled;
  notify(enabled);
}

export async function hydrateAgentsFeatureEnabled(): Promise<boolean> {
  try {
    const settings = await window.gitTree.getAgentSettings() as { agentsEnabled?: boolean };
    agentsFeatureEnabled = settings?.agentsEnabled !== false;
  } catch {
    agentsFeatureEnabled = true;
  }
  applyStaticVisibility(agentsFeatureEnabled);
  return agentsFeatureEnabled;
}

export function onAgentsFeatureEnabledChange(listener: (enabled: boolean) => void): () => void {
  listeners.add(listener);
  listener(agentsFeatureEnabled);
  return () => listeners.delete(listener);
}

export function initAiFeatureGate(): void {
  void hydrateAgentsFeatureEnabled();
  window.addEventListener('gittree:agent-settings-changed', event => {
    const detail = (event as CustomEvent<{ agentsEnabled?: boolean }>).detail;
    setAgentsFeatureEnabled(detail?.agentsEnabled !== false);
  });
}

if (typeof module !== 'undefined' && module.exports) {
  Object.assign(module.exports, {
    isAgentsFeatureEnabled,
    setAgentsFeatureEnabled,
    hydrateAgentsFeatureEnabled,
    onAgentsFeatureEnabledChange,
    initAiFeatureGate
  });
}
