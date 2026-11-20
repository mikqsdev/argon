// `argon-core serve` as the Rust CLI and the desktop app start it: stdin and stdout are pipes,
// the core must print ARGON_READY without waiting for stdin, and exit when stdin closes.
import { test } from "node:test";
import assert from "node:assert/strict";
import { spawn } from "node:child_process";
import { mkdtempSync, existsSync, readFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

const main = join(import.meta.dirname, "..", "dist", "cli", "main.js");

test("serve: ready with piped stdin, advertises itself, exits when stdin closes", async () => {
	const home = mkdtempSync(join(tmpdir(), "argon-serve-"));
	const c = spawn(process.execPath, [main, "serve", "--advertise"], { env: { ...process.env, ARGON_HOME: home }, stdio: ["pipe", "pipe", "ignore"], windowsHide: true });
	const info = await new Promise((resolve, reject) => {
		const to = setTimeout(() => reject(new Error("no ARGON_READY within 15s")), 15000);
		let buf = "";
		c.stdout.on("data", (d) => {
			buf += d;
			const m = buf.match(/ARGON_READY (\{.*\})/);
			if (m) {
				clearTimeout(to);
				resolve(JSON.parse(m[1]));
			}
		});
		c.on("exit", (code) => reject(new Error("exited early: " + code)));
	});
	assert.ok(info.port > 0 && info.token);
	const ping = await (await fetch(`http://127.0.0.1:${info.port}/api/ping`)).text();
	assert.match(ping, /^argon /);
	assert.equal(JSON.parse(readFileSync(join(home, "core.json"), "utf8")).port, info.port);
	// Closing stdin (the parent going away) stops the core and removes core.json.
	const exited = new Promise((r) => c.on("exit", r));
	c.stdin.end();
	await Promise.race([exited, new Promise((_, rej) => setTimeout(() => rej(new Error("did not exit")), 5000))]);
	assert.equal(existsSync(join(home, "core.json")), false);
});
