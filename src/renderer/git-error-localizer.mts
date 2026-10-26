export type Translate = (key: string, options?: Record<string, unknown>) => string;

// Mirrors NetworkTimeoutError in src/main/git/remote-transport.mts.
const NETWORK_TIMEOUT = /\b(git [a-z-]+) stopped: the remote did not respond within (\d+) s\b/;

/**
 * Main-process Git errors reach the renderer as English text inside the
 * `{ error }` envelope. Known messages are replaced by their localized copy;
 * any other message is returned unchanged.
 */
export function localizeGitError(message: string, translate: Translate): string {
  const timeout = NETWORK_TIMEOUT.exec(message);
  if (timeout) {
    return translate('errors.networkTimeout', {
      command: timeout[1],
      seconds: Number(timeout[2])
    });
  }
  return message;
}
