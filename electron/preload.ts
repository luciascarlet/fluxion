import { contextBridge, ipcRenderer } from "electron";

contextBridge.exposeInMainWorld("fluxion", {
  getAppInfo: () => ipcRenderer.invoke("app-info")
});
