function timeoutSignal(
  timeoutMs: unknown,
  existingSignal: AbortSignal | null = null
): { signal: AbortSignal; dispose: () => void } {
  const controller = new AbortController();
  const timer = setTimeout(
    () => controller.abort(new Error('AI request timed out')),
    timeoutMs as number
  );
  const signal = existingSignal
    ? AbortSignal.any([existingSignal, controller.signal])
    : controller.signal;
  return { signal, dispose: () => clearTimeout(timer) };
}

async function readErrorBody(response: Response): Promise<string> {
  try {
    const data = await response.json();
    const message = data?.error?.message
      || data?.message
      || data?.error?.error?.message
      || '';
    return String(message).slice(0, 400);
  } catch {
    return '';
  }
}

interface AiRequestOptions {
  fetch: typeof globalThis.fetch;
  baseUrl?: string;
  apiKey: string;
  model: string;
  prompt: string;
  timeoutMs: number;
}

export async function requestOpenAiCompatible({
  fetch,
  baseUrl,
  apiKey,
  model,
  prompt,
  timeoutMs
}: AiRequestOptions): Promise<string> {
  const { signal, dispose } = timeoutSignal(timeoutMs);
  try {
    const response = await fetch(`${baseUrl!.replace(/\/+$/, '')}/chat/completions`, {
      method: 'POST',
      signal,
      headers: {
        'Content-Type': 'application/json',
        Authorization: `Bearer ${apiKey}`
      },
      body: JSON.stringify({
        model,
        messages: [{ role: 'user', content: prompt }],
        temperature: 0.3,
        max_tokens: 1024
      })
    });
    if (!response.ok) {
      const detail = await readErrorBody(response);
      throw new Error(detail || `AI provider responded with ${response.status}`);
    }
    const data = await response.json();
    const content = data?.choices?.[0]?.message?.content;
    if (typeof content !== 'string' || !content.trim()) {
      throw new Error('The AI provider returned an empty response');
    }
    return content;
  } finally {
    dispose();
  }
}

export async function requestAnthropic({
  fetch,
  apiKey,
  model,
  prompt,
  timeoutMs
}: AiRequestOptions): Promise<string> {
  const { signal, dispose } = timeoutSignal(timeoutMs);
  try {
    const response = await fetch('https://api.anthropic.com/v1/messages', {
      method: 'POST',
      signal,
      headers: {
        'Content-Type': 'application/json',
        'x-api-key': apiKey,
        'anthropic-version': '2023-06-01'
      },
      body: JSON.stringify({
        model,
        max_tokens: 1024,
        messages: [{ role: 'user', content: prompt }]
      })
    });
    if (!response.ok) {
      const detail = await readErrorBody(response);
      throw new Error(detail || `AI provider responded with ${response.status}`);
    }
    const data = await response.json();
    const text = (data?.content || [])
      .map((block: { text?: unknown }) => String(block?.text || ''))
      .join('')
      .trim();
    if (!text) throw new Error('The AI provider returned an empty response');
    return text;
  } finally {
    dispose();
  }
}


