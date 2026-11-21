// publik-gate-preload.cjs — the one bridge of the publik gate window (publik-gate): a button
// press reaches the main process. Nothing else is exposed to the page.
const { contextBridge, ipcRenderer } = require("electron");

contextBridge.exposeInMainWorld("publikGate", {
  press: (action) => ipcRenderer.send("publik-gate:press", String(action)),
});
