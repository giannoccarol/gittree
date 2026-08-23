import { execFile } from 'node:child_process';
import { promisify } from 'node:util';

const execFileAsync = promisify(execFile);

export const MINIMUM_GIT_VERSION: readonly [number, number, number] = [2, 45, 1];

export type GitVersionTriple = readonly [number, number, number];

export interface GitVersionInfo {
  version: string;
  supported: boolean;
  minimum: string;
}

export function parseGitVersion(output: unknown): GitVersionTriple | null {
  const match = String(output || '').match(/git version (\d+)\.(\d+)(?:\.(\d+))?/);
  if (!match) return null;
  return [Number(match[1]), Number(match[2]), Number(match[3] || 0)];
}

export function isVersionAtLeast(version: unknown, minimum: readonly number[]): boolean {
  if (!Array.isArray(version) || version.length < 2) return false;
  for (let index = 0; index < minimum.length; index += 1) {
    const left = version[index] || 0;
    const right = minimum[index] || 0;
    if (left > right) return true;
    if (left < right) return false;
  }
  return true;
}

export async function getGitVersion(): Promise<GitVersionInfo> {
  try {
    const { stdout } = await execFileAsync('git', ['--version'], { encoding: 'utf8' });
    const version = parseGitVersion(stdout);
    return {
      version: version ? version.join('.') : '',
      supported: version ? isVersionAtLeast(version, MINIMUM_GIT_VERSION) : false,
      minimum: MINIMUM_GIT_VERSION.join('.')
    };
  } catch {
    return { version: '', supported: false, minimum: MINIMUM_GIT_VERSION.join('.') };
  }
}
