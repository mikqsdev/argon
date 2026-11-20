import { spawn } from "node:child_process";
import { existsSync } from "node:fs";
import { join } from "node:path";

/** Open a URL in the default browser. */
export function openUrl(url: string): void {
	try {
		if (process.platform === "win32") spawn("cmd", ["/c", "start", "", url.replace(/&/g, "^&")], { detached: true, stdio: "ignore", windowsHide: true }).unref();
		else if (process.platform === "darwin") spawn("open", [url], { detached: true, stdio: "ignore" }).unref();
		else spawn("xdg-open", [url], { detached: true, stdio: "ignore" }).unref();
	} catch {
		/* user can copy the URL */
	}
}

/** Open a URL as a chromeless app window (Edge/Chrome --app), falling back to the browser. */
export function openAppWindow(url: string): void {
	const candidates =
		process.platform === "win32"
			? [
					join(process.env["ProgramFiles(x86)"] || "C:\\Program Files (x86)", "Microsoft\\Edge\\Application\\msedge.exe"),
					join(process.env.ProgramFiles || "C:\\Program Files", "Microsoft\\Edge\\Application\\msedge.exe"),
					join(process.env.ProgramFiles || "C:\\Program Files", "Google\\Chrome\\Application\\chrome.exe"),
					join(process.env.LOCALAPPDATA || "", "Google\\Chrome\\Application\\chrome.exe"),
				]
			: process.platform === "darwin"
				? ["/Applications/Google Chrome.app/Contents/MacOS/Google Chrome", "/Applications/Microsoft Edge.app/Contents/MacOS/Microsoft Edge", "/Applications/Chromium.app/Contents/MacOS/Chromium"]
				: ["/usr/bin/google-chrome", "/usr/bin/chromium", "/usr/bin/chromium-browser", "/usr/bin/microsoft-edge"];
	const exe = candidates.find((c) => existsSync(c));
	if (!exe) return openUrl(url);
	spawn(exe, [`--app=${url}`, "--window-size=1440,900"], { detached: true, stdio: "ignore" }).unref();
}
