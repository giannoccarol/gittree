export function parseDeepLink(url: unknown): string | null {
  if (typeof url !== 'string') return null;
  let parsed: URL;
  try {
    parsed = new URL(url);
  } catch {
    return null;
  }
  if (parsed.protocol !== 'gittree:') return null;
  if (parsed.hostname !== 'open') return null;
  const repoPath = parsed.searchParams.get('path');
  if (typeof repoPath !== 'string' || !repoPath || !repoPath.startsWith('/') && !/^[A-Za-z]:[\\/]/.test(repoPath)) {
    return null;
  }
  if (repoPath.length > 4096 || /[\0\r\n]/.test(repoPath)) return null;
  return repoPath;
}
