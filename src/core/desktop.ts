import { spawn } from "node:child_process";
import { createRequire } from "node:module";
import { existsSync } from "node:fs";
import { dirname, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";

const ROOT = resolve(dirname(fileURLToPath(import.meta.url)), "..", "..");

/** Path of the Electron binary if the desktop app is available, else null. */
export function desktopBinary(): string | null {
	try {
		const p = createRequire(import.meta.url)("electron");
		return typeof p === "string" && existsSync(p) ? p : null;
	} catch {
		return null;
	}
}

/** Launch the Argon desktop app (detached). Returns false if Electron is not installed. */
export function launchDesktop(): boolean {
	const env = { ...process.env };
	delete env.ELECTRON_RUN_AS_NODE;
	// Installed app: the CLI itself runs on Argon.exe (ELECTRON_RUN_AS_NODE), so start that same
	// executable as a normal app — it opens the packaged GUI.
	if (process.versions.electron) {
		spawn(process.execPath, [], { detached: true, stdio: "ignore", env, windowsHide: false }).unref();
		return true;
	}
	const bin = desktopBinary();
	if (!bin) return false;
	spawn(bin, [join(ROOT, "desktop", "main.js")], { detached: true, stdio: "ignore", env, windowsHide: false }).unref();
	return true;
}
