// Renders the Argon tile to build/icon.png (512×512). Run with: npx electron desktop/make-icon.mjs
import { app, BrowserWindow } from "electron";
import { mkdirSync, writeFileSync } from "node:fs";
import { dirname, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";

const out = join(resolve(dirname(fileURLToPath(import.meta.url)), ".."), "build", "icon.png");
const svg = `<svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 512 512">
<defs><linearGradient id="g" x1="0" y1="0" x2="1" y2="1"><stop offset="0" stop-color="#a78bfa"/><stop offset="1" stop-color="#22d3ee"/></linearGradient>
<radialGradient id="glow" cx="0.5" cy="0.45" r="0.6"><stop offset="0" stop-color="#7c3aed" stop-opacity="0.35"/><stop offset="1" stop-color="#7c3aed" stop-opacity="0"/></radialGradient></defs>
<rect x="24" y="24" width="464" height="464" rx="96" fill="#17151d"/>
<rect x="24" y="24" width="464" height="464" rx="96" fill="url(#glow)"/>
<rect x="40" y="40" width="432" height="432" rx="82" fill="none" stroke="url(#g)" stroke-width="22"/>
<text x="92" y="132" font-family="Segoe UI, Arial" font-size="62" font-weight="600" fill="#8a8a94">18</text>
<text x="256" y="350" text-anchor="middle" font-family="Segoe UI, Arial" font-weight="700" font-size="210" fill="url(#g)">Ar</text>
<text x="256" y="420" text-anchor="middle" font-family="Segoe UI, Arial" font-size="44" fill="#b4b4bd">Argon</text>
</svg>`;

app.whenReady().then(async () => {
	const w = new BrowserWindow({ width: 512, height: 512, show: false, frame: false, transparent: true, webPreferences: { offscreen: true } });
	await w.loadURL(`data:text/html,<html><body style="margin:0;background:transparent">${encodeURIComponent(svg)}</body></html>`);
	await new Promise((r) => setTimeout(r, 400));
	const img = await w.webContents.capturePage({ x: 0, y: 0, width: 512, height: 512 });
	mkdirSync(dirname(out), { recursive: true });
	writeFileSync(out, img.resize({ width: 512, height: 512 }).toPNG());
	console.log("icon written:", out);
	app.quit();
});
