// Argon desktop app (Electron main process).
// Runs the Argon engine + local API in-process and shows the UI in a native window.
import { app, BrowserWindow, Menu, dialog, ipcMain, shell, nativeTheme } from "electron";
import { existsSync, readFileSync, writeFileSync } from "node:fs";
import { dirname, join, resolve } from "node:path";
import { fileURLToPath, pathToFileURL } from "node:url";

const here = dirname(fileURLToPath(import.meta.url));
const ROOT = resolve(here, "..");
const ICON = join(ROOT, "build", "icon.png");
// Matches --bg (surface-container-low) of the Material 3 theme.
const DARK = { color: "#18141f", symbolColor: "#cac4d0" };
const LIGHT = { color: "#f3edf9", symbolColor: "#49454f" };

app.setAppUserModelId("dev.argon.desktop");
if (!app.requestSingleInstanceLock()) app.quit();

let win = null;
let server = null;
let origin = "";

const stateFile = () => join(app.getPath("userData"), "window.json");
function loadState() {
	try {
		return JSON.parse(readFileSync(stateFile(), "utf8"));
	} catch {
		return { width: 1360, height: 860 };
	}
}
function saveState() {
	if (!win) return;
	const maximized = win.isMaximized();
	const b = maximized ? loadState() : win.getBounds();
	writeFileSync(stateFile(), JSON.stringify({ ...b, maximized }));
}

async function createWindow() {
	const { startServer } = await import(pathToFileURL(join(ROOT, "dist", "server", "server.js")).href);
	server = await startServer({ port: 0, open: false });
	origin = new URL(server.url).origin;

	const st = loadState();
	const dark = nativeTheme.shouldUseDarkColors;
	win = new BrowserWindow({
		x: st.x,
		y: st.y,
		width: st.width ?? 1360,
		height: st.height ?? 860,
		minWidth: 820,
		minHeight: 560,
		title: "Argon",
		icon: existsSync(ICON) ? ICON : undefined,
		backgroundColor: dark ? DARK.color : LIGHT.color,
		titleBarStyle: "hidden",
		titleBarOverlay: process.platform === "darwin" ? true : { ...(dark ? DARK : LIGHT), height: 52 },
		show: false,
		webPreferences: {
			preload: join(here, "preload.cjs"),
			contextIsolation: true,
			sandbox: true,
			spellcheck: false,
		},
	});
	if (st.maximized) win.maximize();
	win.once("ready-to-show", () => win.show());
	win.on("close", saveState);
	win.on("closed", () => (win = null));

	// Links to the outside world open in the system browser, never inside the app.
	win.webContents.setWindowOpenHandler(({ url }) => {
		if (/^https?:/i.test(url) && !url.startsWith(origin)) shell.openExternal(url);
		return { action: "deny" };
	});
	win.webContents.on("will-navigate", (e, url) => {
		if (!url.startsWith(origin)) {
			e.preventDefault();
			if (/^https?:/i.test(url)) shell.openExternal(url);
		}
	});

	await win.loadURL(server.url);
}

// Keyboard shortcuts without a visible menu bar.
Menu.setApplicationMenu(
	Menu.buildFromTemplate([
		{
			label: "Argon",
			submenu: [
				{ role: "reload" },
				{ role: "toggleDevTools" },
				{ type: "separator" },
				{ role: "zoomIn", accelerator: "CmdOrCtrl+=" },
				{ role: "zoomOut" },
				{ role: "resetZoom" },
				{ type: "separator" },
				{ role: "togglefullscreen" },
				{ role: "quit" },
			],
		},
		{ label: "Edit", submenu: [{ role: "undo" }, { role: "redo" }, { type: "separator" }, { role: "cut" }, { role: "copy" }, { role: "paste" }, { role: "selectAll" }] },
	]),
);

ipcMain.handle("argon:pick-folder", async () => {
	const r = await dialog.showOpenDialog(win, { properties: ["openDirectory", "createDirectory"] });
	return r.canceled ? null : r.filePaths[0];
});
ipcMain.on("argon:theme", (_e, dark, colors) => {
	const hex = (v) => (typeof v === "string" && /^#[0-9a-f]{6}$/i.test(v) ? v : null);
	const base = dark ? DARK : LIGHT;
	const c = { color: hex(colors?.bg) ?? base.color, symbolColor: hex(colors?.fg) ?? base.symbolColor };
	if (win && process.platform !== "darwin") win.setTitleBarOverlay({ ...c, height: 52 });
	win?.setBackgroundColor(c.color);
});
ipcMain.on("argon:open-external", (_e, url) => {
	if (/^https?:/i.test(url)) shell.openExternal(url);
});

app.on("second-instance", () => {
	if (!win) return;
	if (win.isMinimized()) win.restore();
	win.focus();
});
app.whenReady().then(() =>
	createWindow().catch((e) => {
		dialog.showErrorBox("Argon", `Impossibile avviare Argon:\n${e?.stack ?? e}`);
		app.quit();
	}),
);
app.on("activate", () => {
	if (!win && server) createWindow();
});
app.on("window-all-closed", () => {
	server?.close();
	app.quit();
});
