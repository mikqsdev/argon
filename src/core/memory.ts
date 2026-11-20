import { existsSync, readFileSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { randomUUID } from "node:crypto";
import { paths, ensureDirs } from "./paths.js";

export interface Memory {
	id: string;
	scope: "global" | "project";
	project?: string;
	content: string;
	createdAt: number;
}

const file = () => join(paths.memory, "memories.json");

function read(): Memory[] {
	ensureDirs();
	if (!existsSync(file())) return [];
	try {
		return JSON.parse(readFileSync(file(), "utf8"));
	} catch {
		return [];
	}
}

function write(list: Memory[]): void {
	writeFileSync(file(), JSON.stringify(list, null, 2));
}

const norm = (p: string) => p.toLowerCase().replace(/[\\/]+$/, "");

export function listMemory(cwd?: string): Memory[] {
	return read().filter((m) => m.scope === "global" || !cwd || norm(m.project ?? "") === norm(cwd));
}

export function allMemory(): Memory[] {
	return read();
}

export function addMemory(scope: "global" | "project", cwd: string, content: string): Memory {
	const list = read();
	const m: Memory = { id: randomUUID().slice(0, 6), scope, project: scope === "project" ? cwd : undefined, content: content.trim(), createdAt: Date.now() };
	list.push(m);
	write(list);
	return m;
}

export function removeMemory(id: string, _cwd?: string): boolean {
	const list = read();
	const next = list.filter((m) => m.id !== id);
	write(next);
	return next.length !== list.length;
}
