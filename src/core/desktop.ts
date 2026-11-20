import { spawn } from "node:child_process";
import { existsSync } from "node:fs";
import { dirname, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";

const ROOT = resolve(dirname(fileURLToPath(import.meta.url)), "..", "..");
const EXE = process.platform === "win32" ? ".exe" : "";

/**
 * Path of the desktop app (Tauri) if available, else null.
 * Installed: <app>/core/app/dist/core → <app>/Argon(.exe). Development: rust/target/{release,debug}.
 */
export function desktopBinary(): string | null {
	const candidates = [
		join(ROOT, "..", "..", `Argon${EXE}`),
		join(ROOT, "..", "..", "argon-desktop" + EXE),
		join(ROOT, "rust", "target", "release", `argon-desktop${EXE}`),
		join(ROOT, "rust", "target", "debug", `argon-desktop${EXE}`),
	];
	return candidates.find((p) => existsSync(p)) ?? null;
}

/** Launch the Argon desktop app (detached). Returns false if it is not installed or built. */
export function launchDesktop(): boolean {
	const bin = desktopBinary();
	if (!bin) return false;
	spawn(bin, [], { detached: true, stdio: "ignore", windowsHide: false }).unref();
	return true;
}
