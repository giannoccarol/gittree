/**
 * Normalizes the errors of Git commands that talk to a remote (fetch, pull,
 * push). Git output on these paths mixes the real failure with transport
 * noise, and GitTree cannot answer interactive credential prompts, so the
 * message shown to the user must say what actually went wrong.
 */

// OpenSSH 10+ prints this banner on stderr for every connection to a server
// without a post-quantum key exchange (for example Azure DevOps). It is not
// an error, but it used to be the first thing shown in every failure toast.
const SSH_POST_QUANTUM_WARNING = [
  /^\*\* WARNING: connection is not using a post-quantum key exchange algorithm\.?$/i,
  /^\*\* This session may be vulnerable to "store now, decrypt later" attacks\.?$/i,
  /^\*\* The server may need to be upgraded\. See https:\/\/openssh\.com\/pq\.html$/i
];

const AUTHENTICATION_FAILURES = [
  /could not read (?:Username|Password) for/i,
  /terminal prompts disabled/i,
  /Authentication failed for/i,
  // Git translates this one; the Italian catalogue ships with Git on Linux.
  /Autenticazione non riuscita per/i,
  /Invalid username or password/i,
  /HTTP Basic: Access denied/i,
  /Permission denied \(publickey/i,
  /Host key verification failed/i,
  /read_passphrase: can't open \/dev\/tty/i
];

export const AUTHENTICATION_HINT =
  'Git could not authenticate with the remote. GitTree cannot answer terminal prompts: '
  + 'configure a credential helper (for example `gh auth setup-git` or git-credential-libsecret) '
  + 'or an SSH key, check that the system keyring is unlocked, then try again.';

export function stripTransportNoise(message: string): string {
  return String(message ?? '')
    .split(/\r?\n/)
    .filter(line => !SSH_POST_QUANTUM_WARNING.some(pattern => pattern.test(line.trim())))
    .join('\n')
    .replace(/\n{3,}/g, '\n\n')
    .trim();
}

export function isAuthenticationFailure(message: string): boolean {
  return AUTHENTICATION_FAILURES.some(pattern => pattern.test(String(message ?? '')));
}

export function describeNetworkError(prefix: string, error: unknown): string {
  const raw = error instanceof Error ? error.message : String(error ?? '');
  const detail = stripTransportNoise(raw) || raw.trim();
  const message = `${prefix}: ${detail}`;
  return isAuthenticationFailure(detail) ? `${message}\n${AUTHENTICATION_HINT}` : message;
}
