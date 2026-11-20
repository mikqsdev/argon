// Run the Tauri CLI for the desktop crate with the Rust build environment.
// Usage: node scripts/tauri.mjs build | dev | …
import { spawnSync } from "node:child_process";
import { join, resolve } from "node:path";
import { rustEnv } from "./rust-env.mjs";

const ROOT = resolve(import.meta.dirname, "..");
const bin = join(ROOT, "node_modules", ".bin", process.platform === "win32" ? "tauri.cmd" : "tauri");
const r = spawnSync(bin, process.argv.slice(2), { cwd: join(ROOT, "rust", "desktop"), stdio: "inherit", env: rustEnv(), shell: process.platform === "win32" });
process.exit(r.status ?? 1);
