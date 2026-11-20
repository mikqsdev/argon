import { Marked } from "/vendor/marked.js";

// ───────────────────────── auth token & API ─────────────────────────
const url = new URL(location.href);
if (url.searchParams.get("t")) {
	try { localStorage.setItem("argon-token", url.searchParams.get("t")); } catch {}
	history.replaceState(null, "", "/");
}
let TOKEN = "";
try { TOKEN = localStorage.getItem("argon-token") || ""; } catch {}
export const token = () => TOKEN;

export async function api(path, opts = {}) {
	const res = await fetch("/api" + path, {
		method: opts.method || (opts.body !== undefined ? "POST" : "GET"),
		headers: { "Content-Type": "application/json", "X-Argon-Token": TOKEN },
		body: opts.body !== undefined ? JSON.stringify(opts.body) : undefined,
	});
	const type = res.headers.get("content-type") || "";
	const data = type.includes("json") ? await res.json() : await res.text();
	if (!res.ok) throw new Error(data?.error || res.statusText);
	return data;
}

export function connectWs(onMessage, onState) {
	let ws;
	let retry = 500;
	const open = () => {
		ws = new WebSocket(`ws://${location.host}/ws?t=${encodeURIComponent(TOKEN)}`);
		ws.onopen = () => { retry = 500; onState?.(true); };
		ws.onmessage = (m) => { try { onMessage(JSON.parse(m.data)); } catch (e) { console.error(e); } };
		ws.onclose = () => { onState?.(false); setTimeout(open, retry); retry = Math.min(retry * 2, 8000); };
	};
	open();
}

// ───────────────────────── helpers ─────────────────────────
export const esc = (s) => String(s ?? "").replace(/[&<>"']/g, (c) => ({ "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;", "'": "&#39;" })[c]);
export const $ = (sel, root = document) => root.querySelector(sel);
export const $$ = (sel, root = document) => [...root.querySelectorAll(sel)];
export function el(html) {
	const t = document.createElement("template");
	t.innerHTML = html.trim();
	return t.content.firstElementChild;
}
export const fmtTokens = (n) => (n >= 1e9 ? (n / 1e9).toFixed(1) + "B" : n >= 1e6 ? (n / 1e6).toFixed(1) + "M" : n >= 1e3 ? (n / 1e3).toFixed(1) + "k" : String(Math.round(n || 0)));
export const fmtAmount = (v, unit) => (unit === "cost" ? "$" + (v < 10 ? v.toFixed(2) : v.toFixed(1)) : fmtTokens(v));
export function debounce(fn, ms) {
	let t;
	return (...a) => { clearTimeout(t); t = setTimeout(() => fn(...a), ms); };
}
export function relTime(ts, lang) {
	const d = (Date.now() - ts) / 1000;
	const rtf = new Intl.RelativeTimeFormat(lang, { numeric: "auto" });
	if (d < 60) return rtf.format(-Math.round(d), "second");
	if (d < 3600) return rtf.format(-Math.round(d / 60), "minute");
	if (d < 86400) return rtf.format(-Math.round(d / 3600), "hour");
	return rtf.format(-Math.round(d / 86400), "day");
}

// ───────────────────────── icons (lucide-style) ─────────────────────────
// Material Symbols Rounded (bundled font). Internal names → symbol ligatures.
const SYM = {
	plus: "add", search: "search", box: "dashboard_customize", settings: "settings", menu: "menu",
	panel: "left_panel_close", panelR: "right_panel_open", left: "arrow_back", right: "arrow_forward",
	down: "keyboard_arrow_down", chev: "chevron_right", more: "more_horiz", send: "arrow_upward", stop: "stop",
	folder: "folder", branch: "account_tree", monitor: "computer", check: "check", x: "close", terminal: "terminal",
	file: "description", edit: "edit", globe: "language", plug: "cable", brain: "psychology", spark: "auto_awesome",
	list: "checklist", user: "person", trash: "delete", pin: "keep", download: "download", undo: "undo",
	compress: "compress", shield: "shield", chart: "monitoring", mic: "mic", paperclip: "attach_file",
	question: "help", key: "key", refresh: "refresh", sun: "light_mode", moon: "dark_mode", external: "open_in_new",
	gauge: "speed", sliders: "tune", layers: "stacks", cpu: "memory", hook: "webhook", book: "menu_book",
	newchat: "edit_square", warn: "warning", bolt: "bolt", image: "image", eco: "eco", star: "star",
};
export const icon = (name, cls = "") => `<span class="i ms ${cls}" aria-hidden="true">${SYM[name] || name}</span>`;

// M3 Expressive loading indicator: a shape morphing through polygons while it spins.
const SHAPES = (() => {
	const N = 72;
	const polar = (fn) => {
		let d = "";
		for (let i = 0; i < N; i++) {
			const a = (i / N) * Math.PI * 2;
			const r = fn(a);
			d += `${i ? "L" : "M"}${(24 + r * Math.cos(a)).toFixed(2)} ${(24 + r * Math.sin(a)).toFixed(2)}`;
		}
		return d + "Z";
	};
	const wave = (k, amp, R = 17) => (a) => R * (1 + amp * Math.cos(k * a));
	const oval = (a) => 19 / Math.sqrt((Math.cos(a) / 1) ** 2 + (Math.sin(a) / 0.72) ** 2);
	return [polar(wave(9, 0.09)), polar(wave(10, 0.16, 16)), polar(wave(5, 0.13)), polar(oval), polar(wave(4, 0.12)), polar(wave(8, 0.07)), polar(wave(9, 0.09))];
})();
export function loader(size = 40, cls = "") {
	if (document.documentElement.dataset.motion === "off") return `<svg class="m3-loader ${cls}" width="${size}" height="${size}" viewBox="0 0 48 48"><path d="${SHAPES[0]}"/></svg>`;
	return `<svg class="m3-loader ${cls}" width="${size}" height="${size}" viewBox="0 0 48 48" aria-label="loading"><g><path d="${SHAPES[0]}"><animate attributeName="d" dur="4.2s" repeatCount="indefinite" calcMode="spline" keyTimes="0;0.1667;0.3333;0.5;0.6667;0.8333;1" keySplines="${Array(6).fill("0.4 0 0.2 1").join(";")}" values="${SHAPES.join(";")}"/></path><animateTransform attributeName="transform" type="rotate" from="0 24 24" to="360 24 24" dur="2.4s" repeatCount="indefinite"/></g></svg>`;
}

// ───────────────────────── i18n ─────────────────────────
const D = {
	it: {
		newSession: "Nuova sessione", search: "Cerca", customize: "Personalizza", settings: "Impostazioni", stats: "Statistiche",
		allEnvs: "Tutti gli ambienti", noEnv: "Nessun ambiente", chooseEnv: "Scegli ambiente…", addEnv: "Aggiungi cartella…",
		placeholder: "Descrivi un'attività o fai una domanda", placeholderBusy: "Scrivi per guidarlo mentre lavora…", typeSlash: "Scrivi / per comandi e skill",
		sessions: "Sessioni", pinned: "Fissate", today: "Oggi", earlier: "Precedenti", noSessions: "Nessuna sessione ancora",
		rename: "Rinomina", pin: "Fissa", unpin: "Rimuovi dai fissati", export: "Esporta Markdown", archive: "Archivia", delete: "Elimina", confirmDelete: "Eliminare questa sessione?",
		environment: "Ambiente", context: "Contesto", connectors: "Connettori", changes: "Modifiche", tasks: "Attività", usage: "Utilizzo sessione", instructions: "Istruzioni caricate",
		noGit: "Non è un repository git", connected: "collegati", none: "nessuno",
		usageLimits: "Limiti di utilizzo", seeAll: "Vedi tutto", fiveHour: "Limite 5 ore", weekly: "Settimanale", startsFirst: "Parte col primo messaggio", resets: "Reset", limitsOff: "Limiti disattivati — attivali nelle impostazioni.",
		working: "Ionizzando", thinking: "Ragionamento", ran: (n) => `Eseguit${n === 1 ? "o 1 comando" : `i ${n} comandi`}`, used: (n) => `Usat${n === 1 ? "o 1 strumento" : `i ${n} strumenti`}`, edited: (n) => `Modificat${n === 1 ? "o 1 file" : `i ${n} file`}`,
		approve: "Consenti", always: "Consenti sempre", deny: "Nega", permission: "Permesso richiesto", question: "Domanda", answer: "Rispondi",
		stopped: "Interrotto", compact: "Compatta", undo: "Annulla ultimo turno", clear: "Svuota", copy: "Copia", copied: "Copiato",
		home: "Cosa facciamo adesso", overview: "Panoramica", models: "Modelli", all: "Tutto",
		k_sessions: "Sessioni", k_messages: "Messaggi", k_tokens: "Token totali", k_days: "Giorni attivi", k_streak: "Serie attuale", k_longest: "Serie record", k_peak: "Ora di punta", k_fav: "Modello preferito",
		saved: "Salvato", modeAsk: "Chiedi", searchModels: "Cerca modelli…", effort: "Ragionamento", noModels: "Nessun modello: collega un provider in Impostazioni → Provider",
		connect: "Collega", disconnect: "Scollega", loginOAuth: "Accedi con account", apiKey: "API key", save: "Salva", cancel: "Annulla", add: "Aggiungi", remove: "Rimuovi", open: "Apri", close: "Chiudi",
		attach: "Allega", dictate: "Detta", summaryNote: "Conversazione precedente compattata in un riassunto.",
		searchPh: "Cerca nelle sessioni…", noResults: "Nessun risultato",
		folder: "Cartella", name: "Nome", select: "Seleziona", up: "Su",
	},
	en: {
		newSession: "New session", search: "Search", customize: "Customize", settings: "Settings", stats: "Statistics",
		allEnvs: "All environments", noEnv: "No environment", chooseEnv: "Choose environment…", addEnv: "Add folder…",
		placeholder: "Describe a task or ask a question", placeholderBusy: "Type to steer it while it works…", typeSlash: "Type / for commands and skills",
		sessions: "Sessions", pinned: "Pinned", today: "Today", earlier: "Earlier", noSessions: "No sessions yet",
		rename: "Rename", pin: "Pin", unpin: "Unpin", export: "Export Markdown", archive: "Archive", delete: "Delete", confirmDelete: "Delete this session?",
		environment: "Environment", context: "Context", connectors: "Connectors", changes: "Changes", tasks: "Tasks", usage: "Session usage", instructions: "Loaded instructions",
		noGit: "Not a git repository", connected: "connected", none: "none",
		usageLimits: "Usage limits", seeAll: "See all", fiveHour: "5-hour limit", weekly: "Weekly", startsFirst: "Starts with your first message", resets: "Resets", limitsOff: "Limits are off — enable them in Settings.",
		working: "Ionizing", thinking: "Thinking", ran: (n) => `Ran ${n} command${n === 1 ? "" : "s"}`, used: (n) => `Used ${n} tool${n === 1 ? "" : "s"}`, edited: (n) => `Edited ${n} file${n === 1 ? "" : "s"}`,
		approve: "Allow", always: "Always allow", deny: "Deny", permission: "Permission needed", question: "Question", answer: "Answer",
		stopped: "Stopped", compact: "Compact", undo: "Undo last turn", clear: "Clear", copy: "Copy", copied: "Copied",
		home: "What's up next", overview: "Overview", models: "Models", all: "All",
		k_sessions: "Sessions", k_messages: "Messages", k_tokens: "Total tokens", k_days: "Active days", k_streak: "Current streak", k_longest: "Longest streak", k_peak: "Peak hour", k_fav: "Favorite model",
		saved: "Saved", modeAsk: "Ask", searchModels: "Search models…", effort: "Effort", noModels: "No models: connect a provider in Settings → Providers",
		connect: "Connect", disconnect: "Disconnect", loginOAuth: "Sign in with account", apiKey: "API key", save: "Save", cancel: "Cancel", add: "Add", remove: "Remove", open: "Open", close: "Close",
		attach: "Attach", dictate: "Dictate", summaryNote: "Earlier conversation was compacted into a summary.",
		searchPh: "Search sessions…", noResults: "No results",
		folder: "Folder", name: "Name", select: "Select", up: "Up",
	},
};
let LANG = "it";
export const setLang = (l) => (LANG = D[l] ? l : "it");
export const lang = () => LANG;
export function t(key, ...a) {
	const v = D[LANG][key] ?? D.en[key] ?? key;
	return typeof v === "function" ? v(...a) : v;
}
/** Inline bilingual string. */
export const tt = (it, en) => (LANG === "it" ? it : en);

// ───────────────────────── markdown (sanitized) ─────────────────────────
const safeUrl = (u) => (/^(https?:|mailto:|#|\/)/i.test(u || "") ? u : "#");
const marked = new Marked({
	gfm: true,
	breaks: false,
	renderer: {
		html(token) { return esc(token.text ?? token.raw ?? ""); },
		link(token) { return `<a href="${esc(safeUrl(token.href))}" target="_blank" rel="noopener noreferrer">${this.parser.parseInline(token.tokens)}</a>`; },
		image(token) { return /^(https:|data:image\/)/i.test(token.href) ? `<img src="${esc(token.href)}" alt="${esc(token.text)}">` : esc(`![${token.text}](${token.href})`); },
		code(token) { return `<pre><button class="copy">${t("copy")}</button><code>${esc(token.text)}</code></pre>`; },
	},
});
export const md = (s) => marked.parse(s ?? "");

// ───────────────────────── popovers / modal / toast ─────────────────────────
let menuStack = [];
export function closePop(level = 0) {
	while (menuStack.length > level) menuStack.pop().remove();
}
function placeMenu(p, anchor, opts) {
	const r = anchor.getBoundingClientRect();
	const pw = p.offsetWidth, ph = p.offsetHeight;
	let left, top;
	if (opts.side) {
		// cascading submenu next to its parent menu
		const parent = anchor.closest(".pop")?.getBoundingClientRect() ?? r;
		left = parent.right + 6;
		if (left + pw > innerWidth - 8) left = parent.left - pw - 6;
		top = r.top - 8;
	} else {
		left = opts.alignRight ? r.right - pw : r.left;
		top = opts.below || r.top - ph - 8 < 8 ? r.bottom + 6 : r.top - ph - 6;
	}
	p.style.left = Math.max(8, Math.min(left, innerWidth - pw - 8)) + "px";
	p.style.top = Math.max(8, Math.min(top, innerHeight - ph - 8)) + "px";
}
/** Open a menu. level 0 = root (closes all others), level 1+ = cascading submenu. */
export function popover(anchor, html, opts = {}) {
	const level = opts.level ?? 0;
	closePop(level);
	const p = el(`<div class="pop ${opts.cls || ""}" data-level="${level}">${html}</div>`);
	document.body.appendChild(p);
	placeMenu(p, anchor, opts);
	p.reposition = () => placeMenu(p, anchor, opts);
	menuStack.push(p);
	if (level === 0)
		setTimeout(() => document.addEventListener("mousedown", function h(e) {
			if (!menuStack.length) return document.removeEventListener("mousedown", h);
			if (!menuStack.some((m) => m.contains(e.target))) { closePop(); document.removeEventListener("mousedown", h); }
		}), 0);
	if (opts.focus !== false) p.querySelector("input")?.focus();
	return p;
}
document.addEventListener("keydown", (e) => { if (e.key === "Escape" && menuStack.length) closePop(menuStack.length - 1); });

export function modal(html, onMount) {
	const bg = el(`<div class="modal-bg"><div class="modal">${html}</div></div>`);
	document.body.appendChild(bg);
	const close = () => bg.remove();
	bg.addEventListener("mousedown", (e) => { if (e.target === bg) close(); });
	document.addEventListener("keydown", function h(e) { if (e.key === "Escape") { close(); document.removeEventListener("keydown", h); } });
	onMount?.(bg.querySelector(".modal"), close);
	bg.querySelector("input,textarea")?.focus();
	return close;
}

export function prompt(title, value = "", placeholder = "") {
	return new Promise((resolve) => {
		const close = modal(`<h3>${esc(title)}</h3><input class="inp full" value="${esc(value)}" placeholder="${esc(placeholder)}"><div class="acts"><button class="btn" data-c>${t("cancel")}</button><button class="btn pri" data-o>OK</button></div>`, (m, c) => {
			const inp = m.querySelector("input");
			inp.select();
			const done = (v) => { c(); resolve(v); };
			m.querySelector("[data-c]").onclick = () => done(null);
			m.querySelector("[data-o]").onclick = () => done(inp.value);
			inp.onkeydown = (e) => { if (e.key === "Enter") done(inp.value); };
		});
		void close;
	});
}

export function toast(text, ms = 1800) {
	const n = el(`<div class="save-hint">${esc(text)}</div>`);
	document.body.appendChild(n);
	setTimeout(() => n.remove(), ms);
}

/** SVG usage ring. */
export function ringSvg(pct, size = 18) {
	const r = 7, c = 2 * Math.PI * r;
	const p = Math.max(0, Math.min(100, pct || 0));
	const cls = pct >= 100 ? "over" : pct >= 80 ? "warn" : "";
	return `<svg class="ring ${cls}" width="${size}" height="${size}" viewBox="0 0 18 18"><circle class="bg" cx="9" cy="9" r="${r}"/><circle class="fg" cx="9" cy="9" r="${r}" stroke-dasharray="${c}" stroke-dashoffset="${c * (1 - p / 100)}"/></svg>`;
}

// ───────────────────────── motion helpers ─────────────────────────
export const motion = () => document.documentElement.dataset.motion || "full";

/** Material ripple from the pointer position on interactive elements. */
export function initRipples() {
	const SEL = ".btn, .icon-btn, .nav-item, .opt, .mrow, .chip, .fab, .send, .s-item, .tabs button, .preset, .agent-card.add, .tool-line, .tools-head, .user-chip, .result, .title-btn";
	document.addEventListener("pointerdown", (e) => {
		if (motion() === "off" || e.button !== 0) return;
		const host = e.target.closest(SEL);
		if (!host || host.disabled) return;
		const r = host.getBoundingClientRect();
		const size = Math.max(r.width, r.height) * 2.2;
		const rip = document.createElement("span");
		rip.className = "ripple";
		rip.style.cssText = `width:${size}px;height:${size}px;left:${e.clientX - r.left - size / 2}px;top:${e.clientY - r.top - size / 2}px`;
		host.appendChild(rip);
		const end = () => {
			rip.classList.add("out");
			setTimeout(() => rip.remove(), 450);
		};
		host.addEventListener("pointerup", end, { once: true });
		host.addEventListener("pointerleave", end, { once: true });
		setTimeout(end, 1200);
	});
}

/** Play the staggered entrance of a container's children once (not on every re-render). */
export function staggerOnce(el, ms = 900) {
	if (!el || motion() === "off") return;
	el.classList.remove("stagger");
	void el.offsetWidth;
	el.classList.add("stagger");
	clearTimeout(el._stg);
	el._stg = setTimeout(() => el.classList.remove("stagger"), ms);
}

/** Celebration burst of Material shapes. */
export function burst(x, y, n = 18) {
	if (motion() !== "full") return;
	const shapes = ["50%", "30%", "50% 0 50% 0", "8px", "50% 50% 0 50%"];
	const colors = ["var(--primary)", "var(--tertiary)", "var(--secondary)", "var(--primary-container)", "var(--tertiary-container)"];
	for (let i = 0; i < n; i++) {
		const p = document.createElement("i");
		p.className = "particle";
		const a = (Math.PI * 2 * i) / n + Math.random() * 0.5;
		const d = 60 + Math.random() * 90;
		const s = 6 + Math.random() * 9;
		p.style.cssText = `left:${x}px;top:${y}px;width:${s}px;height:${s}px;background:${colors[i % colors.length]};border-radius:${shapes[i % shapes.length]};--dx:${Math.cos(a) * d}px;--dy:${Math.sin(a) * d - 40}px;--rot:${Math.random() * 540 - 270}deg`;
		document.body.appendChild(p);
		setTimeout(() => p.remove(), 1100);
	}
}

/** Swap page content with a View Transition (slide + fade) when motion is on. */
export function viewTransition(fn) {
	if (!document.startViewTransition || motion() === "off") return fn();
	document.startViewTransition(fn);
}

// ───────────────────────── Material 3 select (replaces native <select>) ─────────────────────────
/** Turn a native <select> into an M3 Expressive menu button. The select stays as the source of truth. */
function enhanceSelect(sel) {
	if (sel._m3 || sel.multiple) return;
	sel._m3 = true;
	const extra = sel.className.replace(/\binp\b/g, "").trim();
	const btn = el(`<button type="button" class="m3-select ${extra}"><span class="v"></span>${icon("arrow_drop_down", "caret")}</button>`);
	if (sel.getAttribute("style")) btn.setAttribute("style", sel.getAttribute("style"));
	sel.classList.add("m3-native");
	sel.after(btn);
	const sync = () => {
		const o = sel.options[sel.selectedIndex];
		btn.querySelector(".v").textContent = o ? o.text : "";
		btn.disabled = sel.disabled;
	};
	sync();
	sel.addEventListener("change", sync);
	sel._sync = sync;
	btn.addEventListener("click", () => {
		const opts = [...sel.options];
		const many = opts.length > 8;
		const p = popover(
			btn,
			`${many ? `<label class="msearch sm">${icon("search")}<input placeholder="${esc(LANG === "it" ? "Cerca…" : "Search…")}"></label>` : ""}
			<div class="sel-list">${opts.map((o, i) => `<button type="button" class="opt ${i === sel.selectedIndex ? "on" : ""}" data-i="${i}" ${o.disabled ? "disabled" : ""}><span class="grow"><span class="t1">${esc(o.text)}</span></span>${i === sel.selectedIndex ? `<span class="check">${icon("check")}</span>` : ""}</button>`).join("")}</div>`,
			{ below: true, cls: "select-menu", focus: many },
		);
		p.style.minWidth = Math.max(btn.offsetWidth, 200) + "px";
		p.reposition();
		p.querySelector(".opt.on")?.scrollIntoView({ block: "center" });
		const input = p.querySelector("input");
		if (input)
			input.oninput = () => {
				const q = input.value.toLowerCase();
				p.querySelectorAll(".sel-list .opt").forEach((b) => (b.style.display = b.textContent.toLowerCase().includes(q) ? "" : "none"));
			};
		p.addEventListener("click", (e) => {
			const b = e.target.closest("[data-i]");
			if (!b || b.disabled) return;
			sel.selectedIndex = Number(b.dataset.i);
			closePop();
			sel.dispatchEvent(new Event("change", { bubbles: true }));
			sync();
			btn.focus();
		});
	});
}

export function enhanceSelects(root = document) {
	root.querySelectorAll("select").forEach(enhanceSelect);
}

new MutationObserver((muts) => {
	for (const m of muts)
		for (const n of m.addedNodes) {
			if (n.nodeType !== 1) continue;
			if (n.tagName === "SELECT") enhanceSelect(n);
			else n.querySelectorAll?.("select").forEach(enhanceSelect);
		}
}).observe(document.documentElement, { childList: true, subtree: true });
