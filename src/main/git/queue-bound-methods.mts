/**
 * Explicit queue binding for repository services (ADR-0008, A1).
 *
 * Every own async method of the instance's prototype is wrapped so calls
 * serialize through the per-repository queue while nested calls inside the
 * same queue context stay re-entrant (ADR-0001). Synchronous methods,
 * getters and the constructor are left untouched.
 */
export function bindMethodsToQueue(instance: {
  runExclusive: (operation: () => never) => unknown;
}): void {
  const proto = Object.getPrototypeOf(instance) as Record<string, unknown>;
  for (const name of Object.getOwnPropertyNames(proto)) {
    if (name === 'constructor' || name === 'runExclusive') continue;
    const descriptor = Object.getOwnPropertyDescriptor(proto, name);
    if (!descriptor || descriptor.get || typeof descriptor.value !== 'function') continue;
    if (!isAsyncFunction(descriptor.value)) continue;
    const original = descriptor.value as (...args: unknown[]) => unknown;
    Object.defineProperty(instance, name, {
      enumerable: false,
      writable: true,
      configurable: true,
      value: function queuedMethod(...args: unknown[]): unknown {
        return instance.runExclusive(
          (() => original.apply(instance, args)) as () => never
        );
      }
    });
  }
}

function isAsyncFunction(value: unknown): boolean {
  return value instanceof Function && value.constructor.name === 'AsyncFunction';
}
