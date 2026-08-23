const ESCAPE = String.fromCharCode(27);
const BELL = String.fromCharCode(7);
const OSC_PATTERN = new RegExp(`${ESCAPE}\\][^${BELL}${ESCAPE}]*(?:${BELL}|${ESCAPE}\\\\)`, 'g');
const CSI_PATTERN = new RegExp(`${ESCAPE}\\[[0-9;?]*[A-Za-z]`, 'g');

function stripAnsi(value: unknown): string {
  return String(value || '')
    .replace(OSC_PATTERN, '')
    .replace(CSI_PATTERN, '');
}

export function collectOpencodeText(stdout: unknown): string {
  const lines = stripAnsi(stdout)
    .split(/\r?\n/)
    .map(line => line.trim())
    .filter(Boolean);
  const parts = [];
  let errorMessage = '';
  for (const line of lines) {
    let event;
    try {
      event = JSON.parse(line);
    } catch {
      continue;
    }
    if (event.type === 'error') {
      const message = event?.error?.data?.message
        || event?.error?.message
        || event?.error?.name
        || 'OpenCode error';
      if (!errorMessage) errorMessage = String(message);
    }
    const isTextEvent = event.type === 'text' || event.type === 'message';
    const text = typeof event?.part?.text === 'string' ? event.part.text : '';
    if (isTextEvent && text.trim()) parts.push(text.trim());
  }
  if (errorMessage && !parts.length) throw new Error(errorMessage);
  const output = parts.join('\n').trim();
  if (!output) throw new Error('OpenCode did not return any text');
  return output;
}

interface OpencodePty {
  onData: (callback: (data: string) => void) => void;
  onExit: (callback: (event: { exitCode: number }) => void) => void;
  kill?: () => void;
}

interface OpencodeOptions {
  spawn: (
    executable: string,
    args: string[],
    options: Record<string, unknown>
  ) => OpencodePty;
  executable: string;
  prompt: string;
  model?: string;
  timeoutMs?: number;
  maxOutput?: number;
}

export function generateWithOpencode({
  spawn,
  executable,
  prompt,
  model = '',
  timeoutMs = 120000,
  maxOutput = 262144
}: OpencodeOptions): Promise<string> {
  const args = ['run'];
  if (model) args.push('--model', model);
  args.push(prompt, '--format', 'json');
  return new Promise((resolve, reject) => {
    let output = '';
    let settled = false;
    let pty: OpencodePty | null = null;
    const timer = setTimeout(() => {
      if (settled) return;
      settled = true;
      try {
        pty?.kill?.();
      } catch { /* process already gone */ }
      reject(new Error('OpenCode timed out'));
    }, timeoutMs);
    try {
      pty = spawn(executable, args, {
        cols: 120,
        rows: 30,
        name: 'xterm-256color'
      });
    } catch (error) {
      clearTimeout(timer);
      settled = true;
      reject(new Error((error as Error).message || 'OpenCode failed'));
      return;
    }
    pty.onData(data => {
      output += data;
      if (output.length > maxOutput) output = output.slice(-maxOutput);
    });
    pty.onExit(({ exitCode }) => {
      clearTimeout(timer);
      if (settled) return;
      settled = true;
      try {
        resolve(collectOpencodeText(output));
      } catch (parseError) {
        const message = exitCode !== 0 && /did not return any text/.test(parseError.message)
          ? `OpenCode exited with code ${exitCode}`
          : parseError.message;
        reject(new Error(message));
      }
    });
  });
}


