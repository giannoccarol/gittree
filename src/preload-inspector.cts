import { contextBridge, ipcRenderer } from 'electron';
import type { GitTreeInspectorBridge } from './shared/bridge.mts';

const inspectorBridge = {
  onInspectorRender: (callback: (payload: unknown) => void): (() => void) => {
    const listener = (_event: unknown, payload: unknown): void => callback(payload);
    ipcRenderer.on('inspector:render', listener);
    return () => ipcRenderer.removeListener('inspector:render', listener);
  },

  onInspectorClosed: (callback: () => void): (() => void) => {
    const listener = (): void => callback();
    ipcRenderer.on('inspector:closed', listener);
    return () => ipcRenderer.removeListener('inspector:closed', listener);
  }
} satisfies GitTreeInspectorBridge;

contextBridge.exposeInMainWorld('gitTree', inspectorBridge);
