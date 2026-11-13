// TiVBook Staff — Windows desktop app (Electron).
// Shows the staff software from the installed files; all data lives online (Supabase),
// so every installed PC and the player app stay in sync.
const { app, BrowserWindow, ipcMain, shell, Menu } = require("electron");
const path = require("node:path");

// Only these servers may be reached by the desktop bridge (first-time setup).
const ALLOWED_HOSTS = [/^api\.supabase\.com$/, /^[a-z0-9-]+\.supabase\.co$/];
const OPENABLE = [/^https:\/\/([a-z0-9-]+\.)?supabase\.com\//, /^https:\/\/business\.facebook\.com\//, /^https:\/\/developers\.facebook\.com\//];

if (!app.requestSingleInstanceLock()) app.quit();

let win = null;
function createWindow() {
  win = new BrowserWindow({
    width: 1280, height: 800, minWidth: 900, minHeight: 600, show: false, backgroundColor: "#0f1115",
    title: "TiVBook Staff — Ti Vegas", icon: path.join(__dirname, "icon.png"),
    webPreferences: { preload: path.join(__dirname, "preload.cjs"), contextIsolation: true, nodeIntegration: false, sandbox: true, spellcheck: false },
  });
  win.once("ready-to-show", () => { win.maximize(); win.show(); });
  win.loadFile(path.join(__dirname, "..", "dist", "index.html"));
  // Links never open inside the app; only approved sites open in the normal browser.
  win.webContents.setWindowOpenHandler(({ url }) => {
    if (OPENABLE.some((r) => r.test(url))) shell.openExternal(url);
    return { action: "deny" };
  });
  win.webContents.on("will-navigate", (e, url) => { if (!url.startsWith("file://")) e.preventDefault(); });
}

app.on("second-instance", () => { if (win) { if (win.isMinimized()) win.restore(); win.focus(); } });
app.whenReady().then(() => {
  Menu.setApplicationMenu(null);
  createWindow();
});
app.on("window-all-closed", () => app.quit());

/** Network bridge for the setup wizard (Supabase Management API does not accept browser requests). */
ipcMain.handle("tv:request", async (_e, req) => {
  const u = new URL(req.url);
  if (u.protocol !== "https:" || !ALLOWED_HOSTS.some((r) => r.test(u.hostname))) throw new Error("Blocked address");
  let body;
  if (req.multipart) {
    body = new FormData();
    for (const part of req.multipart) {
      body.append(part.name, new Blob([part.value], { type: part.type || "text/plain" }), part.filename);
    }
  } else if (req.body !== undefined) body = req.body;
  const res = await fetch(req.url, { method: req.method || "GET", headers: req.headers || {}, body });
  return { status: res.status, ok: res.ok, text: await res.text() };
});

ipcMain.handle("tv:open", async (_e, url) => {
  if (OPENABLE.some((r) => r.test(url))) await shell.openExternal(url);
});
