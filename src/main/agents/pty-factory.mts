import { createRequire } from 'node:module';

export function createPty(
  command: string,
  args: string[],
  options: Record<string, unknown>
): unknown {
  // Loaded lazily so non-agent GitTree paths and unit tests do not require the native module.
  const require = createRequire(import.meta.url);
  const pty = require('node-pty');
  return pty.spawn(command, args, { ...options, shell: false });
}
