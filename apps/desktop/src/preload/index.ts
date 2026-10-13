import { contextBridge, ipcRenderer } from 'electron';

contextBridge.exposeInMainWorld('dl', {
  invoke: (channel: string, ...args: unknown[]) => ipcRenderer.invoke(channel, ...args),
  on: (channel: string, fn: (payload: unknown) => void) => {
    const listener = (_e: unknown, payload: unknown) => fn(payload);
    ipcRenderer.on(channel, listener);
    return () => ipcRenderer.removeListener(channel, listener);
  },
});
