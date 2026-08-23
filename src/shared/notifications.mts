/**
 * Typed renderer push-channel contract (ADR-0008, A3).
 * Every main-to-renderer notification goes through the
 * RendererNotificationsPort; channel names and payload shapes live here so
 * main and renderer cannot drift apart. Request/response IPC channels stay in
 * `ipc.mts`.
 */

export const NOTIFICATION_CHANNELS = {
  windowState: 'window:state',
  deepLinkOpenRepo: 'deep-link:open-repo',
  authProviderState: 'auth:provider-state',
  repoScanProgress: 'repo:scan-progress',
  repoScanComplete: 'repo:scan-complete',
  operationLog: 'operation:log',
  updateState: 'update:state',
  agentTerminalData: 'agent:terminal-data',
  agentAttention: 'agent:attention',
  agentTaskChanged: 'agent:task-changed',
  agentQueueChanged: 'agent:queue-changed'
} as const;

export type NotificationChannel = (typeof NOTIFICATION_CHANNELS)[keyof typeof NOTIFICATION_CHANNELS];

export interface NotificationPayloads {
  [NOTIFICATION_CHANNELS.windowState]: { isMaximized: boolean; isFullScreen: boolean };
  [NOTIFICATION_CHANNELS.deepLinkOpenRepo]: unknown;
  [NOTIFICATION_CHANNELS.authProviderState]: unknown;
  [NOTIFICATION_CHANNELS.repoScanProgress]: Record<string, unknown>;
  [NOTIFICATION_CHANNELS.repoScanComplete]: Record<string, unknown>;
  [NOTIFICATION_CHANNELS.operationLog]: string;
  [NOTIFICATION_CHANNELS.updateState]: unknown;
  [NOTIFICATION_CHANNELS.agentTerminalData]: { taskId: unknown; data: string };
  [NOTIFICATION_CHANNELS.agentAttention]: { taskId: unknown };
  [NOTIFICATION_CHANNELS.agentTaskChanged]: unknown;
  [NOTIFICATION_CHANNELS.agentQueueChanged]: unknown;
}

/**
 * The single seam the main process uses to push state to the renderer.
 * Implementations decide the target window(s); callers only declare intent.
 */
export type RendererNotificationsPort = <C extends keyof NotificationPayloads>(
  channel: C,
  payload: NotificationPayloads[C]
) => void;

export function isNotificationChannel(value: unknown): value is NotificationChannel {
  return typeof value === 'string'
    && Object.values(NOTIFICATION_CHANNELS).includes(value as NotificationChannel);
}
