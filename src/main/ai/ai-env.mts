export interface AiEnvironmentOptions {
  provider: string;
  baseUrl?: string;
  apiKey?: string;
}

export function environmentForAi({ provider, baseUrl = '', apiKey = '' }: AiEnvironmentOptions): Record<string, string> {
  if (!apiKey) return {};
  const env: Record<string, string> = {};
  const host = String(baseUrl || '').toLowerCase();
  if (provider === 'anthropic') {
    env.ANTHROPIC_API_KEY = apiKey;
  } else if (host.includes('deepseek')) {
    env.DEEPSEEK_API_KEY = apiKey;
  } else {
    env.OPENAI_API_KEY = apiKey;
    if (baseUrl) env.OPENAI_BASE_URL = baseUrl;
  }
  return env;
}
