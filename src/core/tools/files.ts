import { readFile, writeFile, mkdir, readdir, stat } from "node:fs/promises";
import { existsSync } from "node:fs";
import { dirname, extname, join } from "node:path";
import { spawn } from "node:child_process";
import { Type } from "@mariozechner/pi-ai";
import type { AgentTool } from "@mariozechner/pi-agent-core";
import { globToRegExp, isDir, rel, resolvePath, ripgrep, text, truncate, walk, type ToolContext } from "./util.js";

const IMAGE_MIME: Record<string, string> = { ".png": "image/png", ".jpg": "image/jpeg", ".jpeg": "image/jpeg", ".gif": "image/gif", ".webp": "image/webp" };

export function readTool(ctx: ToolContext): AgentTool<any> {
	return {
		name: "read",
		label: "Read",
		description:
			"Read a file from disk. Returns numbered lines (cat -n style). Use offset/limit for large files. Images (png, jpg, gif, webp) are returned as images.",
		parameters: Type.Object({
			path: Type.String({ description: "File path (absolute or relative to the working directory)" }),
			offset: Type.Optional(Type.Number({ description: "1-based line to start from" })),
			limit: Type.Optional(Type.Number({ description: "Number of lines to read (default 2000)" })),
		}),
		async execute(_id: string, p: any) {
			const file = resolvePath(ctx.cwd, p.path);
			const mime = IMAGE_MIME[extname(file).toLowerCase()];
			if (mime) {
				const data = await readFile(file);
				return { content: [{ type: "image", data: data.toString("base64"), mimeType: mime }], details: { path: file } };
			}
			if (await isDir(file)) throw new Error(`${p.path} is a directory. Use ls instead.`);
			const raw = await readFile(file, "utf8");
			const lines = raw.split(/\r?\n/);
			const start = Math.max(1, p.offset ?? 1);
			const count = p.limit ?? 2000;
			const slice = lines.slice(start - 1, start - 1 + count);
			const body = slice.map((l, i) => `${String(start + i).padStart(6)}\t${l.length > 2000 ? l.slice(0, 2000) + "…" : l}`).join("\n");
			const more = start - 1 + count < lines.length ? `\n\n[${lines.length - (start - 1 + count)} more lines — use offset to continue]` : "";
			return text(body + more || "(empty file)", { path: file, lines: lines.length });
		},
	};
}

export function writeTool(ctx: ToolContext): AgentTool<any> {
	return {
		name: "write",
		label: "Write",
		description: "Create or overwrite a file with the given content. Parent folders are created automatically. Prefer `edit` for changes to existing files.",
		parameters: Type.Object({
			path: Type.String(),
			content: Type.String(),
		}),
		executionMode: "sequential",
		async execute(_id: string, p: any) {
			const file = resolvePath(ctx.cwd, p.path);
			ctx.checkpoint(file);
			const existed = existsSync(file);
			await mkdir(dirname(file), { recursive: true });
			await writeFile(file, p.content, "utf8");
			const n = p.content.split("\n").length;
			return text(`${existed ? "Overwrote" : "Created"} ${rel(ctx.cwd, file)} (${n} lines)`, { path: file, created: !existed, added: n, removed: 0 });
		},
	};
}

export function editTool(ctx: ToolContext): AgentTool<any> {
	return {
		name: "edit",
		label: "Edit",
		description:
			"Replace an exact string in a file. old_string must match exactly (including indentation) and be unique unless replace_all is true. Read the file first.",
		parameters: Type.Object({
			path: Type.String(),
			old_string: Type.String({ description: "Exact text to replace" }),
			new_string: Type.String({ description: "Replacement text" }),
			replace_all: Type.Optional(Type.Boolean()),
		}),
		executionMode: "sequential",
		async execute(_id: string, p: any) {
			const file = resolvePath(ctx.cwd, p.path);
			const raw = await readFile(file, "utf8");
			const crlf = raw.includes("\r\n");
			const content = crlf ? raw.replace(/\r\n/g, "\n") : raw;
			const oldS = p.old_string.replace(/\r\n/g, "\n");
			const newS = p.new_string.replace(/\r\n/g, "\n");
			if (oldS === newS) throw new Error("old_string and new_string are identical");
			const count = content.split(oldS).length - 1;
			if (count === 0) throw new Error(`old_string not found in ${p.path}. Read the file again and copy the text exactly.`);
			if (count > 1 && !p.replace_all) throw new Error(`old_string appears ${count} times in ${p.path}. Add more context or set replace_all.`);
			ctx.checkpoint(file);
			let next = p.replace_all ? content.split(oldS).join(newS) : content.replace(oldS, () => newS);
			if (crlf) next = next.replace(/\n/g, "\r\n");
			await writeFile(file, next, "utf8");
			const removed = oldS.split("\n").length * (p.replace_all ? count : 1);
			const added = newS.split("\n").length * (p.replace_all ? count : 1);
			return text(`Edited ${rel(ctx.cwd, file)} (${p.replace_all ? count : 1} replacement${count > 1 && p.replace_all ? "s" : ""})`, {
				path: file,
				added,
				removed,
				diff: { old: oldS.slice(0, 4000), new: newS.slice(0, 4000) },
			});
		},
	};
}

export function lsTool(ctx: ToolContext): AgentTool<any> {
	return {
		name: "ls",
		label: "List",
		description: "List the entries of a directory (folders end with /).",
		parameters: Type.Object({ path: Type.Optional(Type.String()) }),
		async execute(_id: string, p: any) {
			const dir = resolvePath(ctx.cwd, p.path ?? ".");
			const entries = await readdir(dir, { withFileTypes: true });
			const lines = entries
				.sort((a, b) => Number(b.isDirectory()) - Number(a.isDirectory()) || a.name.localeCompare(b.name))
				.slice(0, 1000)
				.map((e) => (e.isDirectory() ? `${e.name}/` : e.name));
			return text(lines.join("\n") || "(empty)", { path: dir, count: entries.length });
		},
	};
}

export function globTool(ctx: ToolContext): AgentTool<any> {
	return {
		name: "glob",
		label: "Glob",
		description: 'Find files by glob pattern, e.g. "**/*.ts" or "src/**/test_*.py". Returns paths sorted by modification time (newest first).',
		parameters: Type.Object({ pattern: Type.String(), path: Type.Optional(Type.String()) }),
		async execute(_id: string, p: any) {
			const root = resolvePath(ctx.cwd, p.path ?? ".");
			const pattern = p.pattern.includes("/") || p.pattern.startsWith("**") ? p.pattern : `**/${p.pattern}`;
			const re = globToRegExp(pattern);
			const hits: { f: string; t: number }[] = [];
			for await (const f of walk(root)) {
				const r = rel(root, f);
				if (re.test(r)) {
					const t = (await stat(f).catch(() => null))?.mtimeMs ?? 0;
					hits.push({ f, t });
					if (hits.length >= 2000) break;
				}
			}
			hits.sort((a, b) => b.t - a.t);
			const out = hits.slice(0, 300).map((h) => rel(ctx.cwd, h.f));
			return text(out.length ? out.join("\n") + (hits.length > 300 ? `\n… ${hits.length - 300} more` : "") : "No files found", { count: hits.length });
		},
	};
}

export function grepTool(ctx: ToolContext): AgentTool<any> {
	return {
		name: "grep",
		label: "Search",
		description:
			"Search file contents with a regular expression. output_mode: 'files' (default, matching file paths), 'content' (matching lines with line numbers) or 'count'. Filter with glob (e.g. '*.ts').",
		parameters: Type.Object({
			pattern: Type.String(),
			path: Type.Optional(Type.String()),
			glob: Type.Optional(Type.String()),
			ignore_case: Type.Optional(Type.Boolean()),
			output_mode: Type.Optional(Type.Union([Type.Literal("files"), Type.Literal("content"), Type.Literal("count")])),
			max_results: Type.Optional(Type.Number()),
		}),
		async execute(_id: string, p: any, signal) {
			const root = resolvePath(ctx.cwd, p.path ?? ".");
			const mode = p.output_mode ?? "files";
			const max = p.max_results ?? 200;
			const rg = ripgrep();
			if (rg) {
				const args = ["--no-heading", "--color=never", "-n"];
				if (p.ignore_case) args.push("-i");
				if (p.glob) args.push("-g", p.glob);
				if (mode === "files") args.push("-l");
				if (mode === "count") args.push("-c");
				args.push("-e", p.pattern, root);
				const out = await new Promise<string>((res) => {
					const child = spawn(rg, args, { signal });
					let buf = "";
					child.stdout.on("data", (d) => (buf += d));
					child.on("close", () => res(buf));
					child.on("error", () => res(buf));
				});
				const lines = out.split(/\r?\n/).filter(Boolean).map((l) => l.replace(root + (root.endsWith("\\") || root.endsWith("/") ? "" : (process.platform === "win32" ? "\\" : "/")), ""));
				return text(lines.slice(0, max).join("\n") || "No matches", { count: lines.length });
			}
			const re = new RegExp(p.pattern, p.ignore_case ? "i" : "");
			const globRe = p.glob ? globToRegExp(p.glob.includes("/") ? p.glob : `**/${p.glob}`) : null;
			const results: string[] = [];
			let total = 0;
			const single = !(await isDir(root));
			const files = single ? [root] : walk(root);
			for await (const f of files as any) {
				if (signal?.aborted) break;
				if (globRe && !globRe.test(rel(root, f))) continue;
				let content: string;
				try {
					const st = await stat(f);
					if (st.size > 2_000_000) continue;
					content = await readFile(f, "utf8");
				} catch {
					continue;
				}
				if (content.includes("\u0000")) continue;
				const lines = content.split(/\r?\n/);
				let n = 0;
				for (let i = 0; i < lines.length; i++) {
					if (!re.test(lines[i])) continue;
					n++;
					if (mode === "content" && results.length < max) results.push(`${rel(ctx.cwd, f)}:${i + 1}:${lines[i].slice(0, 300)}`);
					if (mode === "files") break;
				}
				if (n) {
					total++;
					if (mode === "files" && results.length < max) results.push(rel(ctx.cwd, f));
					if (mode === "count" && results.length < max) results.push(`${rel(ctx.cwd, f)}:${n}`);
				}
			}
			return text(results.join("\n") || "No matches", { count: total });
		},
	};
}

