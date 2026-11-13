// Exposes two narrow, safe functions to the staff software. No other access to the PC.
const { contextBridge, ipcRenderer } = require("electron");

contextBridge.exposeInMainWorld("tivbookDesktop", {
  version: "0.3.0",
  request: (req) => ipcRenderer.invoke("tv:request", req),
  openExternal: (url) => ipcRenderer.invoke("tv:open", url),
});
