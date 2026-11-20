// Stage everything the Tauri installer bundles next to the desktop app:
//   rust/desktop/stage/core/node(.exe)          Node runtime for the Argon core
//   rust/desktop/stage/core/app/{dist,gui,…}    the core (TypeScript build) + production node_modules
//   rust/desktop/stage/bin/argon(.exe)          the Rust CLI (release build) + path.ps1
// Usage: node scripts/stage-core.mjs   (after `npm run build`)
import { execFileSync } from "node:child_process";
import { cpSync, existsSync, mkdirSync, rmSync, statSync } from "node:fs";
import { basename, join, relative, resolve } from "node:path";
import { rustEnv } from "./rust-env.mjs";

const ROOT = resolve(import.meta.dirname, "..");
const STAGE = join(ROOT, "rust", "desktop", "stage");
const APP = join(STAGE, "core", "app");
const EXE = process.platform === "win32" ? ".exe" : "";

if (!existsSync(join(ROOT, "dist", "cli", "main.js"))) throw new Error("Run `npm run build` first.");
rmSync(STAGE, { recursive: true, force: true });
mkdirSync(APP, { recursive: true });
mkdirSync(join(STAGE, "bin"), { recursive: true });

// Node runtime: the one running this script.
cpSync(process.execPath, join(STAGE, "core", "node" + EXE));

// Core sources.
for (const p of ["dist", "gui", "package.json", "LICENSE"]) cpSync(join(ROOT, p), join(APP, p), { recursive: true });

// Production dependencies only (each package without its nested node_modules, which are listed too).
const npm = process.platform === "win32" ? "npm.cmd" : "npm";
const list = execFileSync(npm, ["ls", "--omit=dev", "--all", "--parseable"], { cwd: ROOT, encoding: "utf8", shell: process.platform === "win32" })
	.split(/\r?\n/)
	.filter((p) => p && p !== ROOT && p.includes("node_modules"));
let n = 0;
for (const src of new Set(list)) {
	if (!existsSync(src)) continue;
	const dest = join(APP, relative(ROOT, src));
	cpSync(src, dest, { recursive: true, filter: (f) => !(basename(f) === "node_modules" && f !== src && statSync(f).isDirectory()) });
	n++;
}
console.log(`staged core: ${n} packages`);

// Rust CLI.
execFileSync("cargo", ["build", "--release", "-p", "argon-cli"], { cwd: join(ROOT, "rust"), stdio: "inherit", env: rustEnv() });
cpSync(join(ROOT, "rust", "target", "release", "argon" + EXE), join(STAGE, "bin", "argon" + EXE));
cpSync(join(ROOT, "rust", "desktop", "path.ps1"), join(STAGE, "bin", "path.ps1"));
console.log("staged CLI → rust/desktop/stage/bin");
