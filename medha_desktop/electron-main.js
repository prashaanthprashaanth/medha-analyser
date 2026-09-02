const { app, BrowserWindow, dialog, ipcMain, Notification } = require("electron");
const { execFileSync, spawn } = require("child_process");
const fs = require("fs");
const fsp = require("fs/promises");
const http = require("http");
const path = require("path");
const readline = require("readline");

let mainWindow = null;
let backendProcess = null;
let backendPort = null;
const hasInstanceLock = app.requestSingleInstanceLock();

if (!hasInstanceLock) app.quit();

function backendCommand() {
  if (app.isPackaged) {
    return {
      command: path.join(process.resourcesPath, "backend", "medha_backend.exe"),
      args: []
    };
  }
  let python = process.env.MEDHA_PYTHON || "python";
  if (!process.env.MEDHA_PYTHON) {
    try {
      python = execFileSync("python", ["-c", "import sys; print(sys.executable)"], {
        encoding: "utf8", windowsHide: true
      }).trim() || python;
    } catch (_error) {
      // Fall back to the Python command available on PATH.
    }
  }
  return {
    command: python,
    args: ["-u", path.join(__dirname, "..", "medha_backend.py")]
  };
}

function startBackend() {
  return new Promise((resolve, reject) => {
    const launch = backendCommand();
    backendProcess = spawn(launch.command, launch.args, {
      cwd: path.join(__dirname, ".."),
      windowsHide: true,
      stdio: ["ignore", "pipe", "pipe"]
    });
    let settled = false;
    const lines = readline.createInterface({ input: backendProcess.stdout });
    lines.on("line", (line) => {
      if (settled) return;
      try {
        const message = JSON.parse(line);
        if (message.ready && message.port) {
          settled = true;
          backendPort = message.port;
          resolve();
        }
      } catch (_error) {
        // Ignore non-protocol output before readiness.
      }
    });
    backendProcess.stderr.on("data", (chunk) => console.error(`[Medha backend] ${chunk}`));
    backendProcess.once("error", (error) => {
      if (!settled) reject(error);
    });
    backendProcess.once("exit", (code) => {
      backendPort = null;
      if (!settled) reject(new Error(`Decoder service exited with code ${code}`));
    });
    setTimeout(() => {
      if (!settled) reject(new Error("Decoder service startup timed out"));
    }, 15000);
  });
}

function apiRequest(endpoint, payload, method = "POST") {
  return new Promise((resolve, reject) => {
    if (!backendPort) {
      reject(new Error("Decoder service is not running"));
      return;
    }
    const body = payload == null ? null : Buffer.from(JSON.stringify(payload), "utf8");
    const request = http.request({
      hostname: "127.0.0.1",
      port: backendPort,
      path: endpoint,
      method,
      headers: body ? {
        "Content-Type": "application/json",
        "Content-Length": body.length
      } : {}
    }, (response) => {
      const chunks = [];
      response.on("data", (chunk) => chunks.push(chunk));
      response.on("end", () => {
        try {
          const result = JSON.parse(Buffer.concat(chunks).toString("utf8"));
          if (response.statusCode >= 400) reject(new Error(result.error || "Decoder request failed"));
          else resolve(result);
        } catch (error) {
          reject(error);
        }
      });
    });
    request.on("error", reject);
    request.setTimeout(120000, () => request.destroy(new Error("Decoder request timed out")));
    if (body) request.write(body);
    request.end();
  });
}

function windowOptions(overrides = {}) {
  return {
    width: 1480,
    height: 920,
    minWidth: 980,
    minHeight: 680,
    show: false,
    autoHideMenuBar: true,
    backgroundColor: "#f7fbff",
    icon: path.join(__dirname, "build", "icon.png"),
    webPreferences: {
      preload: path.join(__dirname, "preload.js"),
      contextIsolation: true,
      nodeIntegration: false,
      sandbox: true,
      webSecurity: true
    },
    ...overrides
  };
}

function secureWindow(win) {
  win.webContents.setWindowOpenHandler(() => ({ action: "deny" }));
  win.webContents.on("will-navigate", (event) => event.preventDefault());
}

function createMainWindow() {
  mainWindow = new BrowserWindow(windowOptions({ title: "Medha Data Analyser" }));
  secureWindow(mainWindow);
  mainWindow.loadFile(path.join(__dirname, "viewer", "index.html"));
  mainWindow.once("ready-to-show", () => {
    mainWindow.maximize();
    mainWindow.show();
  });
  if (process.env.MEDHA_CAPTURE_PATH) {
    const delay = Math.max(1000, Number(process.env.MEDHA_CAPTURE_DELAY || 5000));
    mainWindow.webContents.once("did-finish-load", () => {
      setTimeout(async () => {
        try {
          const capture = await mainWindow.webContents.capturePage();
          await fsp.writeFile(process.env.MEDHA_CAPTURE_PATH, capture.toPNG());
        } catch (error) {
          console.error(`[Medha capture] ${error.message}`);
        }
      }, delay);
    });
  }
  mainWindow.on("closed", () => { mainWindow = null; });
  const automaticFault = Number(process.env.MEDHA_AUTO_FAULT);
  if (Number.isInteger(automaticFault) && automaticFault >= 0) {
    mainWindow.webContents.once("did-finish-load", () => {
      setTimeout(() => createFaultWindow(automaticFault), 2600);
    });
  }
}

function createFaultWindow(rowIndex) {
  const detailWindow = new BrowserWindow(windowOptions({
    title: "Medha Fault Data Pack",
    parent: mainWindow,
    width: 1540,
    height: 940
  }));
  secureWindow(detailWindow);
  detailWindow.loadFile(path.join(__dirname, "viewer", "detail.html"), {
    query: { row: String(rowIndex) }
  });
  detailWindow.once("ready-to-show", () => {
    detailWindow.maximize();
    detailWindow.show();
  });
}

function safeFilename(filename) {
  return path.basename(String(filename || "medha_export"))
    .replace(/[<>:"/\\|?*\x00-\x1F]/g, "_")
    .trim() || "medha_export";
}

function escapeHtml(value) {
  return String(value ?? "").replace(/[&<>"']/g, (character) => ({
    "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;", "'": "&#39;"
  })[character]);
}

function uniqueDownloadPath(filename) {
  const safe = safeFilename(filename);
  const extension = path.extname(safe);
  const base = path.basename(safe, extension);
  let destination = path.join(app.getPath("downloads"), safe);
  let number = 2;
  while (fs.existsSync(destination)) {
    destination = path.join(app.getPath("downloads"), `${base} (${number})${extension}`);
    number += 1;
  }
  return destination;
}

ipcMain.handle("medha:select-archive", async () => {
  const result = await dialog.showOpenDialog(mainWindow, {
    title: "Open Medha locomotive ALL-data ZIP",
    properties: ["openFile"],
    filters: [{ name: "Locomotive ALL data", extensions: ["zip"] }]
  });
  return result.canceled ? null : result.filePaths[0];
});

ipcMain.handle("medha:startup-archive", () => process.env.MEDHA_AUTO_ARCHIVE || null);
ipcMain.handle("medha:startup-tab", () => process.env.MEDHA_AUTO_TAB || null);

ipcMain.handle("medha:api", (_event, request) =>
  apiRequest(request.endpoint, request.payload, request.method || "POST"));

ipcMain.handle("medha:open-fault", (_event, rowIndex) => {
  createFaultWindow(Number(rowIndex));
  return true;
});

ipcMain.handle("medha:close-window", (event) => {
  BrowserWindow.fromWebContents(event.sender)?.close();
});

ipcMain.handle("medha:save-export", async (_event, payload) => {
  const destination = uniqueDownloadPath(payload.filename);
  await fsp.writeFile(destination, Buffer.from(payload.bytes));
  if (Notification.isSupported()) {
    new Notification({ title: "Medha export saved", body: path.basename(destination) }).show();
  }
  return { destination };
});

ipcMain.handle("medha:save-chart-pdf", async (_event, payload) => {
  if (!String(payload.imageDataUrl || "").startsWith("data:image/png;base64,")) {
    throw new Error("Invalid chart image");
  }
  const destination = uniqueDownloadPath(payload.filename || "medha_chart.pdf");
  const reportWindow = new BrowserWindow({
    show: false,
    webPreferences: { contextIsolation: true, nodeIntegration: false, sandbox: true }
  });
  const document = `<!doctype html><html><head><meta charset="utf-8"><title>${escapeHtml(payload.title)}</title><style>@page{size:A4 landscape;margin:10mm}*{box-sizing:border-box}body{font-family:"Segoe UI",Arial;color:#183247;margin:0}header{text-align:center;margin-bottom:12px}h1{font-size:23px;letter-spacing:.06em;color:#0b3b61;margin:0}h2{font-size:17px;color:#0c4f78;margin:12px 0 4px}p{font-size:10px;color:#637b8c;margin:4px 0;overflow-wrap:anywhere}img{display:block;width:100%;max-height:165mm;object-fit:contain;border:1px solid #d7e5ee;border-radius:7px}</style></head><body><header><h1>MEDHA DATA ANALYSER</h1><p>Developed by ELS/ED</p><h2>${escapeHtml(payload.title)}</h2><p>${escapeHtml(payload.details)}</p></header><img src="${payload.imageDataUrl}" alt="Medha locomotive data chart"></body></html>`;
  try {
    await reportWindow.loadURL(`data:text/html;charset=utf-8,${encodeURIComponent(document)}`);
    const pdf = await reportWindow.webContents.printToPDF({
      printBackground: true,
      landscape: true,
      pageSize: "A4",
      margins: { top: 0.25, bottom: 0.25, left: 0.25, right: 0.25 }
    });
    await fsp.writeFile(destination, pdf);
  } finally {
    if (!reportWindow.isDestroyed()) reportWindow.destroy();
  }
  if (Notification.isSupported()) {
    new Notification({ title: "Medha chart PDF saved", body: path.basename(destination) }).show();
  }
  return { destination };
});

app.whenReady().then(async () => {
  try {
    await startBackend();
    createMainWindow();
  } catch (error) {
    dialog.showErrorBox("Medha Data Analyser", `Could not start the decoder service.\n\n${error.message}`);
    app.quit();
  }
});

app.on("window-all-closed", () => app.quit());
app.on("second-instance", () => {
  if (!mainWindow) return;
  if (mainWindow.isMinimized()) mainWindow.restore();
  mainWindow.show();
  mainWindow.focus();
});
app.on("before-quit", () => {
  if (backendProcess && !backendProcess.killed) backendProcess.kill();
});
