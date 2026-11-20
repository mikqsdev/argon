// Minimal, safe bridge between the UI and the desktop shell.
const { contextBridge, ipcRenderer, webFrame } = require("electron");

contextBridge.exposeInMainWorld("argonDesktop", {
	isDesktop: true,
	platform: process.platform,
	pickFolder: () => ipcRenderer.invoke("argon:pick-folder"),
	setTheme: (dark, colors) => ipcRenderer.send("argon:theme", !!dark, colors ?? null),
	setZoom: (factor) => webFrame.setZoomFactor(Math.min(1.5, Math.max(0.7, Number(factor) || 1))),
	openExternal: (url) => ipcRenderer.send("argon:open-external", String(url)),
});
