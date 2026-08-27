export function shouldHandoverToSecondInstance(
  currentVersion: string,
  additionalData: unknown
): boolean {
  if (!additionalData || typeof additionalData !== 'object') return false;
  const incoming = (additionalData as { version?: unknown }).version;
  return typeof incoming === 'string' && incoming.length > 0 && incoming !== currentVersion;
}
