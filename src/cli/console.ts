// The installed CLI runs on Argon.exe (ELECTRON_RUN_AS_NODE). Argon.exe is a GUI-subsystem program, so
// on Windows Node wraps console input in a plain fs.ReadStream: isTTY is false and raw mode is missing.
// When stdin is the console (a character device), reopen it as a real TTY stream. Pipes and redirected
// files are left alone, so `cat file | argon -p` keeps working.
import { fstatSync, openSync } from "node:fs";
import { ReadStream } from "node:tty";

if (process.platform === "win32" && !process.stdin.isTTY) {
	try {
		if (fstatSync(0).isCharacterDevice()) {
			const stdin = new ReadStream(openSync("\\\\.\\CONIN$", "r+"));
			Object.defineProperty(process, "stdin", { value: stdin, configurable: true, enumerable: true, writable: true });
		}
	} catch {
		// Not a console after all: keep the original stdin.
	}
}
