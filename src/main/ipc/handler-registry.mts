export function errorEnvelope(error: unknown): { error: string } {
  const message = error instanceof Error
    ? error.message
    : typeof error === 'object' && error !== null && 'message' in error
      ? String((error as { message: unknown }).message)
      : String(error);
  return { error: message };
}

export interface HandlerRegistryOptions {
  handle: (channel: string, handler: (...args: unknown[]) => Promise<unknown>) => void;
  removeHandler?: (channel: string) => void;
  assertManagedRepo: (repoPath: unknown) => void;
}

export function createHandlerRegistry({ handle, removeHandler = () => {}, assertManagedRepo }: HandlerRegistryOptions) {
  if (typeof handle !== 'function') throw new TypeError('handle must be a function');
  if (typeof assertManagedRepo !== 'function') {
    throw new TypeError('assertManagedRepo must be a function');
  }

  const registeredChannels = new Set<string>();

  // Handlers are stored contravariantly (`never[]`) so that IPC wrappers with
  // narrower typed signatures can be registered without losing their types.
  const registerHandler = (channel: string, implementation: (...args: never[]) => unknown) => {
    handle(channel, async (_event: unknown, ...args: unknown[]) => {
      try {
        return await (implementation as (...args: unknown[]) => unknown)(...args);
      } catch (error) {
        return errorEnvelope(error);
      }
    });
    registeredChannels.add(channel);
  };

  type ManagedRepoImplementation = (repoPath: string, ...args: never[]) => unknown;

  const registerManagedRepoHandler = (channel: string, implementation: ManagedRepoImplementation) => {
    registerHandler(channel, async (repoPath: unknown, ...args: unknown[]) => {
      assertManagedRepo(repoPath);
      // The assertion above guarantees a managed repository path.
      return (implementation as (...args: unknown[]) => unknown)(repoPath, ...args);
    });
  };

  const dispose = () => {
    for (const channel of registeredChannels) removeHandler(channel);
    registeredChannels.clear();
  };

  return { registerHandler, registerManagedRepoHandler, dispose };
}
