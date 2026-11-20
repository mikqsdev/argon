// Full-screen terminal layout for Argon CLI.
//
//   ┌──────────────────────────────┐
//   │ transcript (scroll region)   │  ← committed lines scroll here and into the scrollback
//   │ …                            │
//   │ live block (streaming text)  │  ← redrawn in place until its line is complete
//   ├──────────────────────────────┤
//   │ bottom panel (fixed)         │  ← status, input box, menus, info, hints
//   └──────────────────────────────┘
//
// The transcript uses a DECSTBM scroll region, so the terminal keeps its native scrollback.
// Lines are wrapped by Argon itself (ANSI and wide-character aware), so the row we write
// on is always known: no cursor-position queries are needed.

const ESC = "\x1b[";
const SGR = /\x1b\[[0-9;]*m/g;
const ANY_ESC = /\x1b\[[0-9;?]*[A-Za-z]|\x1b\][^\x07]*\x07/g;

/** Display width of one code point (East Asian wide / emoji = 2, combining = 0). */
export function charWidth(cp: number): number {
	if (cp === 0) return 0;
	if (cp < 32 || (cp >= 0x7f && cp < 0xa0)) return 0;
	if ((cp >= 0x300 && cp <= 0x36f) || (cp >= 0x200b && cp <= 0x200f) || cp === 0xfe0f || (cp >= 0xfe00 && cp <= 0xfe0e)) return 0;
	if (
		(cp >= 0x1100 && cp <= 0x115f) ||
		(cp >= 0x2e80 && cp <= 0xa4cf) ||
		(cp >= 0xac00 && cp <= 0xd7a3) ||
		(cp >= 0xf900 && cp <= 0xfaff) ||
		(cp >= 0xfe30 && cp <= 0xfe4f) ||
		(cp >= 0xff00 && cp <= 0xff60) ||
		(cp >= 0xffe0 && cp <= 0xffe6) ||
		(cp >= 0x1f300 && cp <= 0x1f64f) ||
		(cp >= 0x1f900 && cp <= 0x1f9ff) ||
		(cp >= 0x1f680 && cp <= 0x1f6ff) ||
		(cp >= 0x2600 && cp <= 0x26ff && [0x2614, 0x2615, 0x2648, 0x267f, 0x2693, 0x26a1, 0x26aa, 0x26ab, 0x26bd, 0x26be, 0x26c4, 0x26c5, 0x26ce, 0x26d4, 0x26ea, 0x26f2, 0x26f3, 0x26f5, 0x26fa, 0x26fd].includes(cp)) ||
		cp === 0x2705 ||
		cp === 0x274c ||
		(cp >= 0x2753 && cp <= 0x2755) ||
		cp === 0x2b50 ||
		(cp >= 0x20000 && cp <= 0x3fffd)
	)
		return 2;
	return 1;
}

export function stripAnsi(s: string): string {
	return s.replace(ANY_ESC, "");
}

export function visibleWidth(s: string): number {
	let w = 0;
	for (const ch of stripAnsi(s)) w += charWidth(ch.codePointAt(0)!);
	return w;
}

/** Truncate to a visible width (ANSI-safe), adding an ellipsis when cut. */
export function truncateAnsi(s: string, width: number, ellipsis = "…"): string {
	if (visibleWidth(s) <= width) return s;
	let out = "";
	let w = 0;
	const limit = Math.max(0, width - visibleWidth(ellipsis));
	let i = 0;
	while (i < s.length) {
		if (s[i] === "\x1b") {
			const m = s.slice(i).match(/^\x1b\[[0-9;?]*[A-Za-z]/);
			if (m) {
				out += m[0];
				i += m[0].length;
				continue;
			}
		}
		const cp = s.codePointAt(i)!;
		const ch = String.fromCodePoint(cp);
		const cw = charWidth(cp);
		if (w + cw > limit) break;
		out += ch;
		w += cw;
		i += ch.length;
	}
	return out + ellipsis + "\x1b[0m";
}

/** Pad with spaces to an exact visible width (truncating if longer). */
export function padAnsi(s: string, width: number): string {
	const t = truncateAnsi(s, width);
	return t + " ".repeat(Math.max(0, width - visibleWidth(t)));
}

/**
 * Wrap an ANSI-styled line to `width` columns (word wrap, hard wrap for long words).
 * Each segment starts with the styles active at that point and ends with a reset.
 */
export function wrapAnsi(line: string, width: number, indent = ""): string[] {
	if (width < 4) width = 4;
	const out: string[] = [];
	let active = "";
	let cur = "";
	let curW = 0;
	let lastSpace = -1; // index in `cur` after the last space
	let lastSpaceW = 0;
	let lastSpaceActive = "";
	const indentW = visibleWidth(indent);
	const push = (seg: string) => out.push(seg + "\x1b[0m");
	let i = 0;
	while (i < line.length) {
		if (line[i] === "\x1b") {
			const m = line.slice(i).match(/^\x1b\[[0-9;?]*[A-Za-z]/);
			if (m) {
				cur += m[0];
				if (m[0].endsWith("m")) active = m[0] === "\x1b[0m" || m[0] === "\x1b[m" ? "" : active + m[0];
				i += m[0].length;
				continue;
			}
		}
		const cp = line.codePointAt(i)!;
		const ch = String.fromCodePoint(cp);
		const cw = charWidth(cp);
		if (curW + cw > width) {
			if (ch === " ") {
				push(cur);
				cur = indent + active;
				curW = indentW;
				lastSpace = -1;
				i += 1;
				continue;
			}
			if (lastSpace > 0 && lastSpaceW > indentW + 4) {
				push(cur.slice(0, lastSpace));
				const rest = cur.slice(lastSpace);
				cur = indent + lastSpaceActive + rest;
				curW = indentW + visibleWidth(rest);
			} else {
				push(cur);
				cur = indent + active;
				curW = indentW;
			}
			lastSpace = -1;
		}
		cur += ch;
		curW += cw;
		if (ch === " ") {
			lastSpace = cur.length;
			lastSpaceW = curW;
			lastSpaceActive = active;
		}
		i += ch.length;
	}
	push(cur);
	return out;
}

export interface Cursor {
	row: number; // 0-based row inside the bottom panel
	col: number; // 0-based column
}

export class Screen {
	private out = process.stdout;
	rows = 24;
	cols = 80;
	/** Row (1-based) where the next transcript line is written. */
	private outRow = 1;
	/** Rows currently occupied by the live block, starting at outRow. */
	private liveRows = 0;
	private liveLines: string[] = [];
	private bottom: string[] = [];
	private cursor: Cursor | null = null;
	private started = false;
	private buf = "";
	onResize?: () => void;

	get regionBottom(): number {
		return Math.max(1, this.rows - this.bottom.length);
	}

	private w(s: string) {
		this.buf += s;
	}

	private flush() {
		if (this.buf) this.out.write(this.buf);
		this.buf = "";
	}

	start(): void {
		this.rows = this.out.rows || 24;
		this.cols = this.out.columns || 80;
		// Push the previous terminal content into the scrollback and start from a clean screen.
		this.out.write("\n".repeat(this.rows) + `${ESC}H${ESC}2J${ESC}?2004h`);
		this.outRow = 1;
		this.started = true;
		this.out.on("resize", this.handleResize);
	}

	stop(): void {
		if (!this.started) return;
		this.started = false;
		this.out.off("resize", this.handleResize);
		this.w(`${ESC}r${ESC}?2004l`);
		// Clear the bottom panel, leave the cursor after the transcript.
		for (let r = this.regionBottom + 1; r <= this.rows; r++) this.w(`${ESC}${r};1H${ESC}2K`);
		this.w(`${ESC}${Math.min(this.outRow + this.liveRows, this.rows)};1H${ESC}?25h\n`);
		this.flush();
	}

	private handleResize = () => {
		this.rows = this.out.rows || this.rows;
		this.cols = this.out.columns || this.cols;
		this.w(`${ESC}2J`);
		this.outRow = Math.min(this.outRow, this.regionBottom);
		this.liveRows = 0;
		this.onResize?.();
	};

	/** Scroll the transcript region up by n lines (content moves into the scrollback). */
	private scrollUp(n: number) {
		if (n <= 0) return;
		this.w(`${ESC}${this.regionBottom};1H` + "\n".repeat(n));
		this.outRow = Math.max(1, this.outRow - n);
	}

	private setRegion() {
		this.w(`${ESC}1;${this.regionBottom}r`);
	}

	/** Make sure `count` rows starting at outRow fit inside the region. */
	private ensureRoom(count: number) {
		const over = this.outRow + count - 1 - this.regionBottom;
		if (over > 0) this.scrollUp(Math.min(over, this.regionBottom - 1));
	}

	private drawLive() {
		const segs = this.liveLines.flatMap((l) => wrapAnsi(l, this.cols));
		const maxRows = Math.max(1, this.regionBottom - 1);
		const shown = segs.slice(-maxRows);
		this.ensureRoom(shown.length);
		for (let k = 0; k < Math.max(shown.length, this.liveRows); k++) {
			const r = this.outRow + k;
			if (r > this.regionBottom) break;
			this.w(`${ESC}${r};1H${ESC}2K${shown[k] ?? ""}`);
		}
		this.liveRows = shown.length;
	}

	private placeCursor() {
		if (this.cursor) {
			const r = this.regionBottom + 1 + this.cursor.row;
			this.w(`${ESC}${r};${this.cursor.col + 1}H${ESC}?25h`);
		} else this.w(`${ESC}?25l`);
	}

	/** Append finished lines to the transcript. */
	commit(lines: string[]): void {
		if (!this.started) {
			for (const l of lines) this.out.write(l + "\n");
			return;
		}
		this.w(`${ESC}?25l`);
		// The live block sits at outRow: committed lines take its place, then it is redrawn below.
		const hadLive = this.liveLines.length > 0;
		for (let k = 0; k < this.liveRows; k++) if (this.outRow + k <= this.regionBottom) this.w(`${ESC}${this.outRow + k};1H${ESC}2K`);
		this.liveRows = 0;
		for (const line of lines) {
			for (const seg of wrapAnsi(line, this.cols)) {
				this.ensureRoom(1);
				this.w(`${ESC}${this.outRow};1H${ESC}2K${seg}`);
				this.outRow++;
			}
		}
		if (hadLive) this.drawLive();
		this.placeCursor();
		this.flush();
	}

	/** Replace the live (still streaming) block. */
	setLive(lines: string[]): void {
		if (!this.started) return;
		this.liveLines = lines;
		this.w(`${ESC}?25l`);
		this.drawLive();
		this.placeCursor();
		this.flush();
	}

	clearLive(): void {
		this.setLive([]);
		this.liveLines = [];
	}

	/** Draw the fixed bottom panel. */
	setBottom(lines: string[], cursor: Cursor | null): void {
		if (!this.started) return;
		const trimmed = lines.slice(-Math.max(3, this.rows - 3));
		const grow = trimmed.length - this.bottom.length;
		this.w(`${ESC}?25l`);
		if (grow > 0) {
			// Panel grows: push transcript content up so nothing is hidden behind it.
			const contentEnd = this.outRow + this.liveRows - 1;
			const newBottom = this.rows - trimmed.length;
			if (contentEnd > newBottom) this.scrollUp(Math.min(contentEnd - newBottom, this.regionBottom - 1));
		}
		if (trimmed.length !== this.bottom.length) {
			// clear rows that changed role
			const first = Math.min(this.rows - trimmed.length, this.regionBottom) + 1;
			for (let r = first; r <= this.rows; r++) this.w(`${ESC}${r};1H${ESC}2K`);
			this.bottom = trimmed;
			this.setRegion();
			if (this.outRow > this.regionBottom) this.outRow = this.regionBottom;
		} else this.bottom = trimmed;
		const top = this.regionBottom + 1;
		trimmed.forEach((l, k) => this.w(`${ESC}${top + k};1H${ESC}2K${truncateAnsi(l, this.cols)}\x1b[0m`));
		this.cursor = cursor;
		this.placeCursor();
		this.flush();
	}

	bell(): void {
		this.out.write("\x07");
	}

	/** Terminal window title. */
	title(t: string): void {
		this.out.write(`\x1b]0;${t.replace(/[\x00-\x1f]/g, "")}\x07`);
	}
}
