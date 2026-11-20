import chalk, { type ChalkInstance } from "chalk";
import { formatAmount, type LimitStatus, type WindowStatus } from "../core/usage.js";

const ACCENTS: Record<string, [string, string]> = {
	violet: ["#a78bfa", "#7c3aed"],
	cyan: ["#67e8f9", "#0891b2"],
	green: ["#86efac", "#16a34a"],
	amber: ["#fcd34d", "#d97706"],
	rose: ["#fda4af", "#e11d48"],
};

export let accent: ChalkInstance = chalk.hex(ACCENTS.violet[0]);
export let accentDeep: ChalkInstance = chalk.hex(ACCENTS.violet[1]);
export function setAccent(name: string): void {
	const [a, b] = ACCENTS[name] ?? ACCENTS.violet;
	accent = chalk.hex(a);
	accentDeep = chalk.hex(b);
}

export const dim = chalk.dim;
export const ok = chalk.hex("#4ade80");
export const warn = chalk.hex("#fbbf24");
export const err = chalk.hex("#f87171");
export const muted = chalk.hex("#8b8b94");

export function width(): number {
	return Math.max(40, Math.min(process.stdout.columns || 100, 140));
}

/** Gradient across a string (two hex colors). */
export function gradient(text: string, from = "#a78bfa", to = "#22d3ee"): string {
	const a = [1, 3, 5].map((i) => parseInt(from.slice(i, i + 2), 16));
	const b = [1, 3, 5].map((i) => parseInt(to.slice(i, i + 2), 16));
	const chars = [...text];
	return chars
		.map((c, i) => {
			const t = chars.length > 1 ? i / (chars.length - 1) : 0;
			const [r, g, bl] = a.map((v, k) => Math.round(v + (b[k] - v) * t));
			return chalk.rgb(r, g, bl)(c);
		})
		.join("");
}

/** The periodic-table tile used as Argon's logo. */
export function banner(lines: string[]): string {
	const tile = [
		"╭──────────╮",
		"│ 18       │",
		"│    Ar    │",
		"│  Argon   │",
		"│  39.948  │",
		"╰──────────╯",
	];
	const colored = tile.map((l, i) => {
		if (i === 2) return accentDeep("│") + "    " + chalk.bold(gradient("Ar")) + "    " + accentDeep("│");
		if (i === 1) return accentDeep("│ ") + muted("18") + "       " + accentDeep("│");
		if (i === 3) return accentDeep("│  ") + chalk.white("Argon") + "   " + accentDeep("│");
		if (i === 4) return accentDeep("│  ") + muted("39.948") + "  " + accentDeep("│");
		return accentDeep(l);
	});
	return colored.map((l, i) => `  ${l}   ${lines[i] ?? ""}`).join("\n");
}

export function bar(percent: number, size = 14): string {
	const p = Math.max(0, Math.min(100, percent));
	const full = Math.round((p / 100) * size);
	const color = p >= 100 ? err : p >= 80 ? warn : accent;
	return color("━".repeat(full)) + dim("━".repeat(size - full));
}

/** Small circular gauge like ◔ ◑ ◕ ●. */
export function ring(percent: number): string {
	const glyphs = ["○", "◔", "◑", "◕", "●"];
	const g = glyphs[Math.min(4, Math.floor(Math.max(0, percent) / 25))];
	return (percent >= 100 ? err : percent >= 80 ? warn : accent)(g);
}

function resetText(w: WindowStatus, it: boolean): string {
	if (!w.resetsAt) return it ? "parte col primo messaggio" : "starts with first message";
	const d = new Date(w.resetsAt);
	const sameDay = d.toDateString() === new Date().toDateString();
	const time = d.toLocaleTimeString([], { hour: "2-digit", minute: "2-digit" });
	return (it ? "reset " : "resets ") + (sameDay ? time : `${d.toLocaleDateString([], { weekday: "short" })} ${time}`);
}

export function limitLine(l: LimitStatus, it: boolean, compact = false): string {
	const parts: string[] = [];
	for (const [label, w] of [["5h", l.fiveHour], [it ? "sett." : "week", l.weekly]] as const) {
		const enabled = w.enabled;
		const pct = Math.round(w.percent);
		const amount = `${formatAmount(w.used, l.unit)}${enabled ? "/" + formatAmount(w.limit, l.unit) : ""}`;
		if (compact) parts.push(`${ring(enabled ? w.percent : 0)} ${label} ${enabled ? pct + "%" : dim(amount)}`);
		else
			parts.push(
				`${ring(enabled ? w.percent : 0)} ${chalk.bold(label)} ${enabled ? bar(w.percent) + " " + pct + "%" : dim("—")} ${dim(amount)} ${dim("· " + resetText(w, it))}`,
			);
	}
	return parts.join(compact ? dim("  ") : "\n");
}

// ───────────────────────── markdown (line based, streaming friendly) ─────────────────────────

const TABLE_ROW = /^\s*\|.*\|\s*$/;

export class MarkdownStream {
	private buf = "";
	private inCode = false;
	private codeLang = "";
	constructor(private out: (s: string) => void, private indent = "") {}

	push(delta: string): void {
		this.buf += delta;
		let nl: number;
		while ((nl = this.buf.indexOf("\n")) >= 0) {
			const line = this.buf.slice(0, nl);
			this.buf = this.buf.slice(nl + 1);
			if (!this.inCode && TABLE_ROW.test(line)) {
				this.table.push(line);
				continue;
			}
			this.flushTable();
			this.out(this.renderLine(line) + "\n");
		}
	}

	/** Rendered preview of the line still being written (not committed). */
	partial(): string[] {
		if (!this.buf || this.table.length) return [];
		if (/^\s*```/.test(this.buf)) return [this.indent + dim(this.buf)];
		const saved = this.inCode;
		const out = this.renderLine(this.buf);
		this.inCode = saved;
		return [out];
	}

	private table: string[] = [];

	/** Tables are buffered until complete, then printed with aligned columns. */
	private flushTable(): void {
		if (!this.table.length) return;
		const strip = (x: string) => x.replace(/\x1b\[[0-9;]*m/g, "");
		const rows = this.table
			.filter((l) => !/^\s*\|[\s:|-]+\|\s*$/.test(l))
			.map((l) => l.trim().slice(1, -1).split("|").map((c) => inline(c.trim())));
		const w: number[] = [];
		for (const r of rows) r.forEach((c, i) => (w[i] = Math.max(w[i] ?? 0, strip(c).length)));
		const rule = (l: string, m: string, r: string) => this.indent + dim(l + w.map((n) => "─".repeat(n + 2)).join(m) + r);
		const fmt = (r: string[], head: boolean) =>
			this.indent + dim("│") + w.map((n, i) => " " + (head ? chalk.bold(r[i] ?? "") : (r[i] ?? "")) + " ".repeat(n - strip(r[i] ?? "").length) + " ").join(dim("│")) + dim("│");
		const out = [rule("┌", "┬", "┐"), ...rows.flatMap((r, i) => (i === 0 && rows.length > 1 ? [fmt(r, true), rule("├", "┼", "┤")] : [fmt(r, false)])), rule("└", "┴", "┘")];
		this.out(out.join("\n") + "\n");
		this.table = [];
	}

	flush(): void {
		if (this.buf && !this.inCode && TABLE_ROW.test(this.buf)) {
			this.table.push(this.buf);
			this.buf = "";
		}
		this.flushTable();
		if (this.buf) this.out(this.renderLine(this.buf) + "\n");
		this.buf = "";
		this.inCode = false;
	}

	private renderLine(line: string): string {
		const ind = this.indent;
		if (/^\s*```/.test(line)) {
			if (!this.inCode) {
				this.inCode = true;
				this.codeLang = line.trim().slice(3);
				return ind + dim("┌─ " + (this.codeLang || "code"));
			}
			this.inCode = false;
			return ind + dim("└─");
		}
		if (this.inCode) return ind + dim("│ ") + chalk.hex("#c4b5fd")(line);
		let m: RegExpMatchArray | null;
		if ((m = line.match(/^(#{1,6})\s+(.*)$/))) return ind + (m[1].length <= 2 ? chalk.bold.underline(accent(m[2])) : chalk.bold(accent(m[2])));
		if (/^\s*(?:(?:-\s*){3,}|(?:\*\s*){3,}|(?:_\s*){3,})$/.test(line)) return ind + dim("─".repeat(Math.min(40, width() - 4)));
		if ((m = line.match(/^(\s*)[-*+]\s+\[( |x)\]\s+(.*)$/i))) return ind + m[1] + (m[2] === " " ? "☐ " : ok("☑ ")) + inline(m[3]);
		if ((m = line.match(/^(\s*)[-*+]\s+(.*)$/))) return ind + m[1] + accent("• ") + inline(m[2]);
		if ((m = line.match(/^(\s*)(\d+)[.)]\s+(.*)$/))) return ind + m[1] + accent(m[2] + ". ") + inline(m[3]);
		if ((m = line.match(/^>\s?(.*)$/))) return ind + dim("▎ ") + chalk.italic(inline(m[1]));
		if (/^\|.*\|\s*$/.test(line)) {
			if (/^\|[\s:|-]+\|\s*$/.test(line)) return ind + dim(line.replace(/[^|]/g, "─").replace(/\|/g, "┼"));
			return ind + line.split("|").map((c, i, a) => (i === 0 || i === a.length - 1 ? "" : " " + inline(c.trim()) + " ")).join(dim("│"));
		}
		return ind + inline(line);
	}
}

export function inline(s: string): string {
	return s
		.replace(/`([^`]+)`/g, (_m, c) => chalk.hex("#f0abfc")(c))
		.replace(/\*\*([^*]+)\*\*/g, (_m, c) => chalk.bold(c))
		.replace(/(^|[^*])\*([^*\s][^*]*)\*/g, (_m, p, c) => p + chalk.italic(c))
		.replace(/\[([^\]]+)\]\(([^)]+)\)/g, (_m, t, u) => chalk.underline(t) + dim(` (${u})`));
}

// ───────────────────────── spinner ─────────────────────────

const FRAMES = ["⠋", "⠙", "⠹", "⠸", "⠼", "⠴", "⠦", "⠧", "⠇", "⠏"];
const WORDS_IT = ["Ionizzando", "Eccitando elettroni", "Raffinando", "Distillando", "Cristallizzando", "Ragionando", "Sintetizzando", "Calibrando"];
const WORDS_EN = ["Ionizing", "Exciting electrons", "Refining", "Distilling", "Crystallizing", "Reasoning", "Synthesizing", "Calibrating"];

export class Spinner {
	private timer?: NodeJS.Timeout;
	private i = 0;
	private start = 0;
	private label = "";
	active = false;
	constructor(private it: boolean) {}

	show(label?: string): void {
		if (!process.stdout.isTTY) return;
		const words = this.it ? WORDS_IT : WORDS_EN;
		this.label = label ?? words[Math.floor(Math.random() * words.length)];
		if (this.active) return;
		this.active = true;
		this.start = Date.now();
		this.timer = setInterval(() => this.draw(), 90);
		this.draw();
	}

	private draw(): void {
		const secs = Math.floor((Date.now() - this.start) / 1000);
		const hint = this.it ? "esc per fermare" : "esc to stop";
		process.stdout.write(`\r\x1b[2K  ${accent(FRAMES[this.i++ % FRAMES.length])} ${gradient(this.label + "…")} ${dim(`(${secs}s · ${hint})`)}`);
	}

	hide(): void {
		if (!this.active) return;
		clearInterval(this.timer);
		this.active = false;
		process.stdout.write("\r\x1b[2K");
	}
}

export function box(title: string, body: string, color: ChalkInstance = accent): string {
	const w = Math.min(width() - 4, 100);
	const lines = body.split("\n");
	const strip = (s: string) => s.replace(/[[0-9;]*m/g, "");
	const top = color("╭─ ") + chalk.bold(title) + " " + color("─".repeat(Math.max(0, w - title.length - 4)) + "╮");
	const mid = lines.map((l) => color("│ ") + l + " ".repeat(Math.max(0, w - 3 - strip(l).length)) + color("│"));
	return [top, ...mid, color("╰" + "─".repeat(w - 1) + "╯")].map((l) => "  " + l).join("\n");
}

export function table(rows: string[][], pad = 2): string {
	const strip = (s: string) => s.replace(/\x1b\[[0-9;]*m/g, "");
	const widths: number[] = [];
	for (const r of rows) r.forEach((c, i) => (widths[i] = Math.max(widths[i] ?? 0, strip(c).length)));
	return rows.map((r) => "  " + r.map((c, i) => c + " ".repeat(widths[i] - strip(c).length + pad)).join("").trimEnd()).join("\n");
}

/** Heatmap of the last N weeks (GitHub style). */
export function heatmap(days: Record<string, number>, weeks = 20): string {
	const levels = [dim("·"), chalk.hex("#4c1d95")("■"), chalk.hex("#6d28d9")("■"), chalk.hex("#8b5cf6")("■"), chalk.hex("#c4b5fd")("■")];
	const max = Math.max(1, ...Object.values(days));
	const today = new Date();
	const start = new Date(today);
	start.setDate(start.getDate() - (weeks * 7 - 1) - today.getDay());
	const rows: string[] = [];
	for (let dow = 0; dow < 7; dow++) {
		let row = "";
		for (let w = 0; w < weeks + 1; w++) {
			const d = new Date(start);
			d.setDate(start.getDate() + w * 7 + dow);
			if (d > today) {
				row += "  ";
				continue;
			}
			const k = `${d.getFullYear()}-${String(d.getMonth() + 1).padStart(2, "0")}-${String(d.getDate()).padStart(2, "0")}`;
			const v = days[k] ?? 0;
			row += (v === 0 ? levels[0] : levels[Math.min(4, 1 + Math.floor((v / max) * 3.99))]) + " ";
		}
		rows.push("  " + row);
	}
	return rows.join("\n");
}
