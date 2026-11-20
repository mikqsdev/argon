// Environment for building the Rust crates. On Windows with the GNU toolchain
// (x86_64-pc-windows-gnu) the MinGW binutils (`as` + `dlltool`) must be on PATH, e.g. from
// `winget install BrechtSanders.WinLibs.POSIX.UCRT` or MSYS2. With the MSVC toolchain nothing changes.
import { existsSync, readdirSync } from "node:fs";
import { join } from "node:path";

export function rustEnv() {
	const env = { ...process.env };
	if (process.platform !== "win32") return env;
	const roots = [join(process.env.LOCALAPPDATA ?? "", "Microsoft", "WinGet", "Packages"), "C:\\msys64"];
	for (const r of roots) {
		if (!existsSync(r)) continue;
		for (const d of readdirSync(r)) {
			for (const bin of [join(r, d, "mingw64", "bin"), join(r, d, "bin")]) {
				if (existsSync(join(bin, "dlltool.exe")) && existsSync(join(bin, "as.exe"))) {
					env.PATH = `${bin};${env.PATH}`;
					return env;
				}
			}
		}
	}
	return env;
}
