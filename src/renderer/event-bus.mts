/**
 * Minimal application event bus (ADR-0008, A3).
 *
 * Replaces direct reach-ins into the app composition root. Known channels:
 * - 'repo:changed'     -> payload: repository entry that became active
 * - 'repo:cleared'     -> no payload
 * - 'commit:selected'  -> payload: commit hash string
 * - 'refresh'          -> no payload
 *
 * Semantics match the previous app.on/app.emit pair: listeners registered
 * during an emit for the same channel are invoked in the same pass.
 */
export type EventPayload = unknown;
export type Unsubscribe = () => void;

export class EventBus {
  private listeners: Map<string, Array<(payload: EventPayload) => void>>;

  constructor() {
    this.listeners = new Map();
  }

  on(event: string, callback: (payload: EventPayload) => void): Unsubscribe {
    if (!this.listeners.has(event)) this.listeners.set(event, []);
    this.listeners.get(event)?.push(callback);
    return () => this.off(event, callback);
  }

  off(event: string, callback: (payload: EventPayload) => void): void {
    const list = this.listeners.get(event);
    if (!list) return;
    const index = list.indexOf(callback);
    if (index !== -1) list.splice(index, 1);
  }

  emit(event: string, data?: EventPayload): void {
    const list = this.listeners.get(event);
    if (list) list.forEach(callback => callback(data));
  }

  listenerCount(event: string): number {
    return this.listeners.get(event)?.length ?? 0;
  }

  clear(): void {
    this.listeners.clear();
  }
}

if (typeof window !== 'undefined') {
  (window as unknown as { EventBus: typeof EventBus }).EventBus = EventBus;
}

declare const module: { exports: unknown } | undefined;
if (typeof module !== 'undefined' && (module as { exports?: unknown }).exports) {
  (module as { exports: unknown }).exports = EventBus;
}
