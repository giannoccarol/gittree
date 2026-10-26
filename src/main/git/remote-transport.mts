import { parseEnv, type VulnerabilityCategory } from '@simple-git/argv-parser';
import { GitPluginError, simpleGit, type SimpleGit, type SimpleGitOptions } from 'simple-git';

/** Seconds a network command may stay silent before GitTree stops it. */
export const DEFAULT_NETWORK_TIMEOUT_SECONDS = 300;

/** Git config key (any scope) that overrides the timeout; `0` disables it. */
export const NETWORK_TIMEOUT_CONFIG_KEY = 'gittree.networkTimeout';

const MAX_NETWORK_TIMEOUT_SECONDS = 24 * 60 * 60;

const ROUTED_METHODS = ['fetch', 'pull', 'push'] as const;

const NETWORK_SUBCOMMANDS = new Set(['fetch', 'pull', 'push', 'ls-remote']);

type GitCall = (...args: unknown[]) => unknown;

/**
 * Reads the configured timeout in whole seconds. Empty or malformed values
 * fall back to the default so a typo never disables the safety net.
 */
export function parseNetworkTimeout(value: unknown): number {
  const text = String(value ?? '').trim();
  if (!/^\d+$/.test(text)) return DEFAULT_NETWORK_TIMEOUT_SECONDS;
  return Math.min(Number(text), MAX_NETWORK_TIMEOUT_SECONDS);
}

/** Reads `gittree.networkTimeout` with the repository's normal config lookup. */
export async function readNetworkTimeout(git: SimpleGit): Promise<number> {
  try {
    return parseNetworkTimeout(await git.raw(['config', '--get', NETWORK_TIMEOUT_CONFIG_KEY]));
  } catch {
    return DEFAULT_NETWORK_TIMEOUT_SECONDS;
  }
}

/**
 * Thrown when a network command produced no output for the configured time.
 * The English text is stable: the renderer recognizes it to show a localized
 * message, so change both sides together.
 */
export class NetworkTimeoutError extends Error {
  readonly command: string;

  readonly seconds: number;

  constructor(command: string, seconds: number, options?: { cause?: unknown }) {
    super(
      `${command} stopped: the remote did not respond within ${seconds} s. `
      + 'Check the connection and try again.',
      options
    );
    this.name = 'NetworkTimeoutError';
    this.command = command;
    this.seconds = seconds;
  }
}

export interface RemoteTransportOptions {
  repoPath: string;
  readTimeoutSeconds: () => Promise<number> | number;
  env?: NodeJS.ProcessEnv;
  createGit?: (options: Partial<SimpleGitOptions>) => SimpleGit;
}

/**
 * Runs network Git commands for one Repository session. Each command gets
 * `GIT_TERMINAL_PROMPT=0`, so Git fails instead of waiting on a terminal
 * nobody can answer, and an inactivity timeout, so a stalled remote cannot
 * hold the per-repository queue forever.
 *
 * The timeout stops only the Git process it started. `git pull` runs an inner
 * `git fetch` that Git does not stop along with it; that fetch exits when its
 * connection finally fails (see ADR-0009).
 */
export class RemoteTransport {
  private repoPath: string;

  private readTimeoutSeconds: () => Promise<number> | number;

  private env: NodeJS.ProcessEnv;

  private createGit: (options: Partial<SimpleGitOptions>) => SimpleGit;

  constructor({
    repoPath,
    readTimeoutSeconds,
    env = process.env,
    createGit = simpleGit
  }: RemoteTransportOptions) {
    this.repoPath = repoPath;
    this.readTimeoutSeconds = readTimeoutSeconds;
    this.env = env;
    this.createGit = createGit;
  }

  /**
   * @param command Label for the timeout message, such as `git fetch`.
   * @param operation Runs the command on a dedicated simple-git instance.
   */
  async run<T>(command: string, operation: (git: SimpleGit) => Promise<T>): Promise<T> {
    const seconds = await this.readTimeoutSeconds();
    const env = { ...this.env, GIT_TERMINAL_PROMPT: '0' };
    const git = this.createGit({
      baseDir: this.repoPath,
      unsafe: inheritedAllowances(env),
      ...(seconds > 0 ? { timeout: { block: seconds * 1000 } } : {})
    }).env(env);
    try {
      return await operation(git);
    } catch (error) {
      if (error instanceof GitPluginError && error.plugin === 'timeout') {
        throw new NetworkTimeoutError(command, seconds, { cause: error });
      }
      throw error;
    }
  }
}

/**
 * Sends the adapter's network commands through the transport, so every
 * caller of `git.fetch`, `git.pull`, `git.push` or `git.raw(['fetch', …])`
 * gets prompt suppression and the timeout without wiring of its own. Routed
 * calls return plain promises: they do not chain or take callbacks. Every
 * other command keeps the original simple-git behavior.
 */
export function routeNetworkCommands(git: SimpleGit, transport: RemoteTransport): SimpleGit {
  for (const name of ROUTED_METHODS) {
    if (typeof git[name] !== 'function') continue;
    replaceMethod(git, name, (...args) => (
      transport.run(`git ${name}`, network => bindCall(network, name)(...args) as Promise<unknown>)
    ));
  }
  if (typeof git.raw === 'function') {
    const raw = bindCall(git, 'raw');
    replaceMethod(git, 'raw', (...args) => {
      const subcommand = networkSubcommand(args);
      if (!subcommand) return raw(...args);
      return transport.run(
        `git ${subcommand}`,
        network => bindCall(network, 'raw')(...args) as Promise<unknown>
      );
    });
  }
  return git;
}

function bindCall(git: SimpleGit, name: (typeof ROUTED_METHODS)[number] | 'raw'): GitCall {
  const method = git[name] as unknown as GitCall;
  return (...args) => method.apply(git, args);
}

function replaceMethod(git: SimpleGit, name: string, value: GitCall): void {
  Object.defineProperty(git, name, { configurable: true, enumerable: false, writable: true, value });
}

function networkSubcommand(args: unknown[]): string | null {
  const first = Array.isArray(args[0]) ? args[0][0] : args[0];
  return typeof first === 'string' && NETWORK_SUBCOMMANDS.has(first) ? first : null;
}

/**
 * simple-git refuses an explicit environment that carries editor, pager,
 * askpass, SSH or config overrides. They come from the user's own
 * environment, which Git inherits for every other command, so allow exactly
 * the categories that environment triggers and nothing else.
 */
function inheritedAllowances(env: NodeJS.ProcessEnv): SimpleGitOptions['unsafe'] {
  const allowances: Partial<Record<VulnerabilityCategory, boolean>> = {};
  for (const { category } of parseEnv(env).vulnerabilities) allowances[category] = true;
  return allowances;
}
