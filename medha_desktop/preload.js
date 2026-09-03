const { contextBridge, ipcRenderer } = require("electron");

contextBridge.exposeInMainWorld("MedhaDesktop", {
  startupArchive: () => ipcRenderer.invoke("medha:startup-archive"),
  startupTab: () => ipcRenderer.invoke("medha:startup-tab"),
  selectArchive: () => ipcRenderer.invoke("medha:select-archive"),
  api: (endpoint, payload = null, method = "POST") =>
    ipcRenderer.invoke("medha:api", { endpoint, payload, method }),
  openFault: (rowIndex) => ipcRenderer.invoke("medha:open-fault", rowIndex),
  closeWindow: () => ipcRenderer.invoke("medha:close-window"),
  saveExport: (filename, bytes) => ipcRenderer.invoke("medha:save-export", { filename, bytes }),
  saveFaultFdpReport: () => ipcRenderer.invoke("medha:save-fault-fdp-report"),
  saveChartPdf: (payload) => ipcRenderer.invoke("medha:save-chart-pdf", payload),
  saveTablePdf: (payload) => ipcRenderer.invoke("medha:save-table-pdf", payload)
});
