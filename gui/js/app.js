import { api, connectWs, esc, $, $$, el, icon, t, tt, setLang, lang, md, popover, closePop, modal, prompt, toast, ringSvg, fmtTokens, fmtAmount, debounce, relTime, loader, initRipples, staggerOnce, burst, viewTransition, motion, token, setSel } from "./lib.js";
import { applyAppearance } from "./theme.js";
import { renderSettings, renderCustomize, renderStatsPage, renderSearch, openFolderModal, onOAuthEvent, renderUsagePage } from "./pages.js";

export const S = {
	boot: null,
	settings: null,
	sessions: [],
	environments: [],
	models: [],
	providers: [],
	limits: null,
	mcp: [],
	running: new Set(),
	waiting: new Set(),
	/** Current environment (null = no environment). Sidebar, composer and new sessions all use it. */
	envId: null,
	sidebar: true,
	rightPanel: true,
	cur: null,
	openGroups: new Set(),
	openTools: new Set(),
	newOpts: { model: null, effort: null, mode: null },
	draft: { text: "", images: [] },
	statsRange: "all",
	provModels: {},
	statsTab: "overview",
	stats: null,
};

// ───────────────────────── boot ─────────────────────────
async function boot() {
	try {
		await loadBoot();
	} catch (e) {
		document.body.innerHTML = `<div style="padding:40px;font-family:sans-serif;color:#ccc"><h2>Argon</h2><p>${esc(e.message)}</p><p>Apri la GUI con <code>argon gui</code>.</p></div>`;
		return;
	}
	try {
		const ui = JSON.parse(localStorage.getItem("argon-ui") || "{}");
		if (ui.sidebar === false) S.sidebar = false;
		if (ui.rightPanel === false) S.rightPanel = false;
		if (ui.newOpts) Object.assign(S.newOpts, ui.newOpts);
		const saved = ui.envId !== undefined ? ui.envId : (ui.newOpts?.envId ?? ui.sideEnv ?? null);
		S.envId = S.environments.some((e) => e.id === saved) ? saved : null;
		delete S.newOpts.envId;
	} catch {}
	renderShell();
	initRipples();
	// Moving between sections of Settings / Customize updates the page in place (the menu stays,
	// only the section content comes in); any other navigation uses the page transition.
	let lastTop = location.hash.replace(/^#\/?/, "").split("/")[0];
	window.addEventListener("hashchange", () => {
		const top = location.hash.replace(/^#\/?/, "").split("/")[0];
		const inPage = top === lastTop && (top === "settings" || top === "customize");
		lastTop = top;
		if (inPage) route();
		else viewTransition(route);
	});
	route();
	connectWs(onWs);
	document.addEventListener("keydown", globalKeys);
}

async function loadBoot() {
	const b = await api("/bootstrap");
	S.boot = b;
	S.settings = b.settings;
	S.sessions = b.sessions;
	S.environments = b.environments;
	S.models = b.models;
	S.providers = b.providers;
	S.limits = b.limits;
	S.mcp = b.mcp;
	S.running = new Set(b.running);
	setLang(b.settings.general.language);
	applyTheme();
}

export async function reloadBoot() {
	await loadBoot();
	renderSidebar();
	refreshChips();
}

function saveUi() {
	try {
		localStorage.setItem("argon-ui", JSON.stringify({ sidebar: S.sidebar, rightPanel: S.rightPanel, envId: S.envId, newOpts: S.newOpts }));
	} catch {}
}

export function applyTheme() {
	const th = S.settings.general.theme;
	const dark = th === "dark" || (th === "system" && matchMedia("(prefers-color-scheme: dark)").matches);
	const ap = S.settings.appearance ?? {};
	const pal = applyAppearance(ap);
	const root = document.documentElement;
	root.dataset.theme = dark ? "dark" : "light";
	root.lang = lang();
	const scale = (ap.scale || 100) / 100;
	if (window.argonDesktop) {
		root.style.setProperty("--ui-scale", "1");
		window.argonDesktop.setZoom?.(scale);
		const p = dark ? pal.dark : pal.light;
		window.argonDesktop.setTheme(dark, { bg: p["--bg"], fg: p["--on-surface-variant"] });
	} else document.body.style.zoom = String(scale);
}

/** Run a visual change with an expressive circular reveal from (x, y). */
export function revealTransition(fn, x = innerWidth - 40, y = 40) {
	if (!document.startViewTransition || document.documentElement.dataset.motion === "off") return fn();
	const r = Math.hypot(Math.max(x, innerWidth - x), Math.max(y, innerHeight - y));
	const vt = document.startViewTransition(fn);
	vt.ready.then(() =>
		document.documentElement.animate({ clipPath: [`circle(0px at ${x}px ${y}px)`, `circle(${r}px at ${x}px ${y}px)`] }, { duration: 650, easing: "cubic-bezier(0.2, 0, 0, 1)", pseudoElement: "::view-transition-new(root)" }),
	);
}

matchMedia("(prefers-color-scheme: dark)").addEventListener("change", () => S.settings?.general.theme === "system" && applyTheme());

if (window.argonDesktop) document.documentElement.classList.add("desktop");

export async function saveSettings(next, quiet) {
	S.settings = await api("/settings", { method: "PUT", body: next });
	setLang(S.settings.general.language);
	applyTheme();
	if (!quiet) toast(t("saved"));
	const b = await api("/bootstrap");
	S.providers = b.providers;
	S.models = b.models;
	S.environments = b.environments;
	S.limits = b.limits;
	renderSidebar();
	refreshChips();
	return S.settings;
}

// ───────────────────────── shell & routing ─────────────────────────
function renderShell() {
	document.body.innerHTML = `
	<div class="layout ${S.sidebar ? "" : "side-collapsed"}" id="layout">
		<aside class="sidebar" id="sidebar"></aside>
		<main>
			<header class="topbar" id="topbar"></header>
			<div class="pane">
				<section class="view" id="view"></section>
				<div id="dock"></div>
			</div>
		</main>
		<aside class="rightpanel" id="rightpanel"></aside>
	</div>`;
	renderSidebar();
}

function route() {
	closePop();
	const h = location.hash.replace(/^#\/?/, "");
	const [a, b] = h.split("/");
	S.route = a || "home";
	if (a === "s" && b) return openSession(b);
	S.cur = null;
	renderSidebar();
	renderTopbar();
	$("#rightpanel").classList.remove("show");
	$("#dock").innerHTML = "";
	const view = $("#view");
	if (a === "settings") return renderSettings(view, b || "general");
	if (a === "customize") return renderCustomize(view, b || "connectors");
	if (a === "stats") return renderStatsPage(view);
	if (a === "usage") return renderUsagePage(view);
	if (a === "search") return renderSearch(view);
	renderHome();
}

export function go(hash) {
	if (location.hash === "#" + hash) route();
	else location.hash = hash;
}

// Provider favicons: show when loaded, keep initials otherwise.
document.addEventListener("load", (e) => { if (e.target?.dataset?.provIcon) e.target.parentElement.classList.add("has-icon"); }, true);
document.addEventListener("error", (e) => {
	const id = e.target?.dataset?.provIcon;
	if (!id) return;
	(S.noIcon ??= new Set()).add(id);
	e.target.remove();
}, true);

function globalKeys(e) {
	if ((e.ctrlKey || e.metaKey) && e.key.toLowerCase() === "n") {
		e.preventDefault();
		go("/");
	}
	if ((e.ctrlKey || e.metaKey) && e.key.toLowerCase() === "k") {
		e.preventDefault();
		go("/search");
	}
	if ((e.ctrlKey || e.metaKey) && e.key === "b") {
		e.preventDefault();
		toggleSidebar();
	}
	if (e.key === "Escape" && S.cur?.status === "running" && !document.querySelector(".modal-bg")) {
		api(`/sessions/${S.cur.meta.id}/abort`, { body: {} });
	}
}

function toggleSidebar() {
	S.sidebar = !S.sidebar;
	$("#layout").classList.toggle("side-collapsed", !S.sidebar);
	saveUi();
	renderTopbar();
}

// ───────────────────────── sidebar ─────────────────────────
export function renderSidebar() {
	const side = $("#sidebar");
	if (!side) return;
	const list = S.sessions.filter((s) => envOf(s) === S.envId);
	const startToday = new Date().setHours(0, 0, 0, 0);
	const groups = [
		[t("pinned"), list.filter((s) => s.pinned)],
		[t("today"), list.filter((s) => !s.pinned && s.updatedAt >= startToday)],
		[t("earlier"), list.filter((s) => !s.pinned && s.updatedAt < startToday)],
	].filter(([, l]) => l.length);
	const name = S.settings.general.userName || "Argon";
	// The markup does not depend on the current page: selection is applied in place afterwards, so
	// navigating never rebuilds the sidebar (no flashing highlights, no replayed animations).
	const html = `
		<div class="side-top">
			<button class="icon-btn" data-act="toggle" title="Ctrl+B">${icon("panel")}</button>
			<button class="icon-btn" data-act="back">${icon("left")}</button>
			<button class="icon-btn" data-act="fwd">${icon("right")}</button>
		</div>
		<nav class="nav">
			<button class="fab" data-go="/">${icon("newchat")} <span>${t("newSession")}</span></button>
			<button class="nav-item" data-go="/search">${icon("search")} ${t("search")} <kbd>Ctrl K</kbd></button>
			<button class="nav-item" data-go="/customize">${icon("box")} ${t("customize")}</button>
			<button class="nav-item" data-go="/stats">${icon("chart")} ${t("stats")}</button>
		</nav>
		<div class="side-section">${envCardHtml()}</div>
		<div class="sessions">
			${groups.length ? groups.map(([g, l]) => `<div class="s-group">${g}</div>${l.map(sessionItem).join("")}`).join("") : `<div class="empty">${icon("chat_bubble")}<br>${currentEnv() ? tt(`Nessuna sessione in ${esc(currentEnv().name)}`, `No sessions in ${esc(currentEnv().name)}`) : t("noSessions")}</div>`}
		</div>
		<div class="side-bottom">
			<button class="user-chip" data-act="user"><span class="avatar">${esc(name[0].toUpperCase())}</span><span class="who"><span class="n">${esc(name)}</span><span class="p">Argon ${esc(S.boot.version)}</span></span></button>
			<button class="icon-btn" data-go="/settings" title="${t("settings")}">${icon("settings")}</button>
		</div>`;
	const fresh = html !== S._sideHtml;
	if (fresh) {
		const scroll = $(".sessions", side)?.scrollTop ?? 0;
		side.innerHTML = html;
		S._sideHtml = html;
		const list_ = $(".sessions", side);
		if (list_) list_.scrollTop = scroll;
	}
	syncSidebarSel(side, fresh);
	const sig = S.envId + "|" + list.map((x) => x.id).join(",");
	if (sig !== S._sideSig) {
		S._sideSig = sig;
		staggerOnce($(".sessions", side));
	}
	side.onclick = (e) => {
		const g = e.target.closest("[data-go]");
		if (g) return go(g.dataset.go);
		const s = e.target.closest("[data-sid]");
		if (s && e.target.closest(".more")) return sessionMenu(e.target.closest(".more"), s.dataset.sid);
		if (s) return go("/s/" + s.dataset.sid);
		const a = e.target.closest("[data-act]")?.dataset.act;
		if (a === "toggle") toggleSidebar();
		if (a === "back") history.back();
		if (a === "fwd") history.forward();
		if (a === "env") envMenu(e.target.closest("[data-act]"), { below: true });
		if (a === "user") userMenu(e.target.closest("[data-act]"));
	};
}

/** Mark the current page / session in the sidebar without rebuilding it. */
function syncSidebarSel(side, fresh) {
	// Right after a rebuild the selection is simply restored (no animation); otherwise only the
	// item that becomes selected animates.
	const apply = (el, on) => (fresh ? el.classList.toggle("sel", on) : setSel(el, on));
	for (const b of side.querySelectorAll(".nav > .nav-item")) apply(b, b.dataset.go === "/" + S.route);
	const cur = S.cur?.meta.id;
	for (const it of side.querySelectorAll(".s-item")) apply(it, it.dataset.sid === cur);
}

const sTitle = (x) => (x === "New session" ? t("newSession") : x);

function sessionItem(s) {
	const status = S.waiting.has(s.id) ? `<span class="dot-wait"></span>` : S.running.has(s.id) ? loader(16, "sm") : "";
	return `<div class="s-item" data-sid="${s.id}" title="${esc(s.title)}">${status}<span class="t">${esc(sTitle(s.title))}</span>${s.pinned ? `<span class="pin">${icon("pin")}</span>` : ""}<button class="icon-btn more" style="width:22px;height:22px">${icon("more")}</button></div>`;
}

// ───────────────────────── environments (single source of truth) ─────────────────────────
/** Environment id a session belongs to (null when none or when its environment was deleted). */
export function envOf(meta) {
	return meta?.envId && S.environments.some((e) => e.id === meta.envId) ? meta.envId : null;
}

export function currentEnv() {
	return S.environments.find((e) => e.id === S.envId) ?? null;
}

/** Switch the current environment: sidebar, composer and new sessions all follow it. */
export function setEnv(id) {
	S.envId = id && S.environments.some((e) => e.id === id) ? id : null;
	saveUi();
	renderSidebar();
	refreshChips();
	loadSlashExtra();
}

function envCounts() {
	const c = {};
	for (const s of S.sessions) {
		const k = envOf(s) ?? "";
		c[k] = (c[k] ?? 0) + 1;
	}
	return c;
}

function envCardHtml() {
	const env = currentEnv();
	return `<button class="env-card" data-act="env" title="${esc(env?.cwd ?? S.boot.cwd)}">
		<span class="env-ico">${icon(env ? "folder_open" : "folder_off")}</span>
		<span class="grow"><span class="env-lbl">${tt("Ambiente", "Environment")}</span><span class="env-name">${esc(env?.name ?? t("noEnv"))}</span></span>
		${icon("unfold_more")}
	</button>`;
}

/** Shared environment picker (sidebar card and composer chip). */
function envMenu(anchor, opts = {}) {
	const counts = envCounts();
	const row = (e) => `<div class="env-row ${S.envId === e.id ? "on" : ""}" data-env="${e.id}">
		<button class="opt" data-pick="${e.id}">${icon(S.envId === e.id ? "folder_open" : "folder")}<span class="grow"><span class="t1">${esc(e.name)}</span><span class="t2">${esc(e.cwd)}</span></span><span class="count">${counts[e.id] ?? 0}</span>${S.envId === e.id ? `<span class="check">${icon("check")}</span>` : ""}</button>
		<button class="icon-btn env-more" data-more="${e.id}" title="${tt("Altre azioni", "More actions")}">${icon("more_vert")}</button>
	</div>`;
	const p = popover(
		anchor,
		`<div class="hdr">${tt("Ambienti", "Environments")}</div>
		<div class="env-list">${S.environments.map(row).join("") || `<div class="empty">${tt("Nessun ambiente: aggiungi una cartella di lavoro.", "No environments: add a working folder.")}</div>`}</div>
		<button class="opt ${S.envId === null ? "on" : ""}" data-pick="">${icon("folder_off")}<span class="grow"><span class="t1">${t("noEnv")}</span><span class="t2">${tt("Sessioni non legate a una cartella", "Sessions not tied to a folder")}</span></span><span class="count">${counts[""] ?? 0}</span>${S.envId === null ? `<span class="check">${icon("check")}</span>` : ""}</button>
		<hr>
		<button class="opt" data-add>${icon("create_new_folder")}<span class="grow">${t("addEnv")}</span></button>
		<button class="opt" data-manage>${icon("settings")}<span class="grow">${tt("Gestisci ambienti", "Manage environments")}</span></button>`,
		{ cls: "env-menu", focus: false, ...opts },
	);
	p.onclick = (e) => {
		const more = e.target.closest("[data-more]");
		if (more) return envActions(more, more.dataset.more);
		const pick = e.target.closest("[data-pick]");
		if (pick) {
			closePop();
			return setEnv(pick.dataset.pick || null);
		}
		if (e.target.closest("[data-add]")) {
			closePop();
			return openFolderModal(async (env) => {
				S.environments = await api("/environments");
				setEnv(env.id);
			});
		}
		if (e.target.closest("[data-manage]")) {
			closePop();
			go("/settings/environments");
		}
	};
}

function envActions(anchor, id) {
	const env = S.environments.find((x) => x.id === id);
	if (!env) return;
	const p = popover(
		anchor,
		`<button class="opt" data-a="rename">${icon("edit")}<span class="grow">${t("rename")}</span></button>
		<button class="opt" data-a="settings">${icon("tune")}<span class="grow">${tt("Impostazioni ambiente", "Environment settings")}</span></button>
		<hr>
		<button class="opt danger" data-a="delete">${icon("delete")}<span class="grow">${tt("Elimina ambiente", "Delete environment")}</span></button>`,
		{ level: 1, side: true, focus: false },
	);
	p.onclick = async (e) => {
		const a = e.target.closest("[data-a]")?.dataset.a;
		if (!a) return;
		closePop();
		if (a === "rename") await renameEnv(env);
		if (a === "settings") go("/settings/environments");
		if (a === "delete") confirmDeleteEnv(env);
	};
}

export async function renameEnv(env) {
	const v = await prompt(t("rename"), env.name);
	if (!v?.trim()) return;
	await api(`/environments/${env.id}`, { method: "PATCH", body: { name: v.trim() } });
	S.environments = await api("/environments");
	renderSidebar();
	refreshChips();
}

/** Delete an environment, asking what to do with its sessions. */
export function confirmDeleteEnv(env, after) {
	const n = S.sessions.filter((s) => s.envId === env.id).length;
	modal(
		`<div class="del-head">${icon("folder_delete")}</div>
		<h3>${tt(`Eliminare «${esc(env.name)}»?`, `Delete “${esc(env.name)}”?`)}</h3>
		<p class="del-sub">${tt("L'ambiente viene rimosso da Argon. La cartella sul disco e i suoi file non vengono toccati.", "The environment is removed from Argon. The folder and its files on disk are not touched.")}<br><code>${esc(env.cwd)}</code></p>
		${
			n
				? `<div class="del-choice">
			<label class="radio-card"><input type="radio" name="sess" value="keep" checked><span class="rc">${icon("move_item")}<span><b>${tt("Mantieni le sessioni", "Keep the sessions")}</b><small>${n === 1 ? tt("La sessione passa a «Nessun ambiente»", "The session moves to “No environment”") : tt(`Le ${n} sessioni passano a «Nessun ambiente»`, `The ${n} sessions move to “No environment”`)}</small></span></span></label>
			<label class="radio-card danger"><input type="radio" name="sess" value="delete"><span class="rc">${icon("delete_forever")}<span><b>${tt("Elimina anche le sessioni", "Delete the sessions too")}</b><small>${n === 1 ? tt("La sessione viene eliminata definitivamente", "The session is permanently deleted") : tt(`${n} sessioni eliminate definitivamente`, `${n} sessions permanently deleted`)}</small></span></span></label>
		</div>`
				: `<p class="del-sub">${tt("Non ha sessioni.", "It has no sessions.")}</p>`
		}
		<div class="acts"><button class="btn" data-x>${t("cancel")}</button><button class="btn pri danger-fill" data-ok>${icon("delete")} ${tt("Elimina ambiente", "Delete environment")}</button></div>`,
		(m, close) => {
			m.classList.add("del-modal");
			m.querySelector("[data-x]").onclick = close;
			m.querySelector("[data-ok]").onclick = async () => {
				const mode = m.querySelector("input[name=sess]:checked")?.value ?? "keep";
				const r = await api(`/environments/${encodeURIComponent(env.id)}?sessions=${mode}`, { method: "DELETE" });
				close();
				S.environments = r.environments;
				const curGone = S.cur && S.cur.meta.envId === env.id && mode === "delete";
				if (S.envId === env.id) S.envId = null;
				await refreshSessions();
				setEnv(S.envId);
				toast(mode === "delete" && r.sessions ? (r.sessions === 1 ? tt("Ambiente e sessione eliminati", "Environment and session deleted") : tt(`Ambiente e ${r.sessions} sessioni eliminati`, `Environment and ${r.sessions} sessions deleted`)) : tt("Ambiente eliminato", "Environment deleted"));
				if (curGone) go("/");
				after?.();
			};
		},
	);
}

function userMenu(anchor) {
	const th = S.settings.general.theme;
	const p = popover(
		anchor,
		`<button class="opt" data-go="/settings">${icon("settings")} ${t("settings")}</button>
		 <button class="opt" data-go="/settings/providers">${icon("key")} ${tt("Provider e account", "Providers & accounts")}</button>
		 <button class="opt" data-go="/settings/limits">${icon("gauge")} ${t("usageLimits")}</button>
		 <button class="opt" data-go="/stats">${icon("chart")} ${t("stats")}</button>
		 <button class="opt" data-go="/usage">${icon("payments")} ${tt("Utilizzo dettagliato", "Detailed usage")}</button>
		 <hr>
		 <button class="opt" data-theme>${icon(th === "dark" ? "sun" : "moon")} ${tt("Tema", "Theme")}: ${th}</button>
		 <button class="opt" data-lang>${icon("globe")} ${lang() === "it" ? "English" : "Italiano"}</button>`,
	);
	p.onclick = async (e) => {
		const g = e.target.closest("[data-go]");
		if (g) {
			closePop();
			return go(g.dataset.go);
		}
		if (e.target.closest("[data-theme]")) {
			const order = ["dark", "light", "system"];
			const r = e.target.closest("[data-theme]").getBoundingClientRect();
			S.settings.general.theme = order[(order.indexOf(th) + 1) % 3];
			closePop();
			revealTransition(() => applyTheme(), r.left + 20, r.top + r.height / 2);
			await saveSettings(S.settings, true);
		}
		if (e.target.closest("[data-lang]")) {
			S.settings.general.language = lang() === "it" ? "en" : "it";
			closePop();
			await saveSettings(S.settings, true);
			route();
		}
	};
}

async function sessionMenu(anchor, id) {
	const s = S.sessions.find((x) => x.id === id) ?? S.cur?.meta;
	if (!s) return;
	const p = popover(
		anchor,
		`<button class="opt" data-a="rename">${icon("edit")} ${t("rename")}</button>
		 <button class="opt" data-a="pin">${icon("pin")} ${s.pinned ? t("unpin") : t("pin")}</button>
		 <button class="opt" data-a="export">${icon("download")} ${t("export")}</button>
		 <button class="opt" data-a="archive">${icon("box")} ${t("archive")}</button>
		 <hr><button class="opt danger" data-a="delete">${icon("trash")} ${t("delete")}</button>`,
		{ below: true },
	);
	p.onclick = async (e) => {
		const a = e.target.closest("[data-a]")?.dataset.a;
		if (!a) return;
		closePop();
		if (a === "rename") {
			const v = await prompt(t("rename"), s.title);
			if (v) await api(`/sessions/${id}`, { method: "PATCH", body: { title: v } });
		}
		if (a === "pin") await api(`/sessions/${id}`, { method: "PATCH", body: { pinned: !s.pinned } });
		if (a === "archive") await api(`/sessions/${id}`, { method: "PATCH", body: { archived: true } });
		if (a === "export") {
			const text = await fetch(`/api/sessions/${id}/export`, { headers: { "X-Argon-Token": (await import("./lib.js")).token() } }).then((r) => r.text());
			const blob = new Blob([text], { type: "text/markdown" });
			const link = Object.assign(document.createElement("a"), { href: URL.createObjectURL(blob), download: `argon-${id}.md` });
			link.click();
		}
		if (a === "delete") {
			if (!confirm(t("confirmDelete"))) return;
			await api(`/sessions/${id}`, { method: "DELETE" });
			if (S.cur?.meta.id === id) go("/");
		}
		await refreshSessions();
	};
}

export async function refreshSessions() {
	S.sessions = await api("/sessions");
	renderSidebar();
}
const refreshSessionsSoon = debounce(refreshSessions, 300);

// ───────────────────────── top bar ─────────────────────────
function renderTopbar() {
	const bar = $("#topbar");
	const left = S.sidebar ? "" : `<button class="icon-btn" data-act="toggle">${icon("panel")}</button><button class="icon-btn" data-go="/">${icon("plus")}</button>`;
	if (S.cur) {
		bar.className = "topbar bordered";
		bar.innerHTML = `${left}<button class="title-btn" data-act="title"><span>${esc(sTitle(S.cur.meta.title))}</span>${icon("down")}</button><div class="spacer"></div>
			<button class="icon-btn" data-act="undo" title="${t("undo")}">${icon("undo")}</button>
			<button class="icon-btn" data-act="compact" title="${t("compact")}">${icon("compress")}</button>
			<button class="icon-btn ${S.rightPanel ? "active" : ""}" data-act="panel" title="Panel">${icon("panelR")}</button>`;
	} else {
		bar.className = "topbar";
		bar.innerHTML = `${left}<div class="spacer"></div>`;
	}
	bar.onclick = async (e) => {
		const g = e.target.closest("[data-go]");
		if (g) return go(g.dataset.go);
		const a = e.target.closest("[data-act]")?.dataset.act;
		if (a === "toggle") toggleSidebar();
		if (a === "title") sessionMenu(e.target.closest("[data-act]"), S.cur.meta.id);
		if (a === "panel") {
			S.rightPanel = !S.rightPanel;
			saveUi();
			renderTopbar();
			renderRightPanel();
		}
		if (a === "undo") {
			const r = await api(`/sessions/${S.cur.meta.id}/undo`, { body: {} });
			toast(`${t("undo")} · ${r.files.length} file`);
			setCur(r.session);
		}
		if (a === "compact") {
			toast(tt("Compattazione in corso…", "Compacting…"));
			setCur(await api(`/sessions/${S.cur.meta.id}/compact`, { body: {} }));
		}
	};
}

// ───────────────────────── home ─────────────────────────
function renderHome() {
	const view = $("#view");
	const name = S.settings.general.userName;
	const greet = name ? `${t("home")}, ${esc(name)}?` : esc(S.settings.general.greeting || "Here we go!");
	view.innerHTML = `
		<div class="home">
			<div class="hello"><div class="tile">Ar</div><span class="words">${greet.split(" ").map((w, i) => `<b style="--i:${i}">${w}</b>`).join(" ")}</span></div>
			${S.settings.general.showStatsOnHome ? `<div class="stats-card" id="stats-card"></div>` : ""}
			<div class="composer-wrap" id="home-composer"></div>
		</div>`;
	mountComposer($("#home-composer"), "home");
	if (S.boot.cliPending?.length) $("#home-composer").insertAdjacentHTML("afterbegin", `<div style="display:flex;justify-content:center;margin-bottom:14px"><button class="import-btn" data-import>${icon("terminal")} ${tt("Importa sessioni da Argon CLI", "Import sessions from Argon CLI")} <span class="n">${S.boot.cliPending.length}</span></button></div>`);
	$("[data-import]")?.addEventListener("click", openImportDialog);
	if (S.settings.general.showStatsOnHome) loadStatsCard($("#stats-card"));
	if (!S.models.length) {
		$("#home-composer").insertAdjacentHTML("beforeend", `<div class="notice warn" style="margin-top:10px">${icon("key")} <span>${t("noModels")} — <a href="#/settings/providers">${tt("collega ora", "connect now")}</a></span></div>`);
	}
}

export async function loadStatsCard(box, range = S.statsRange) {
	if (!box) return;
	S.statsRange = range;
	// Show the last known numbers for this range at once (or a loader the first time), then refresh.
	S.statsCache ??= {};
	const cached = S.statsCache[range];
	if (cached) renderStatsCard(box, cached, range);
	else if (!box.children.length) box.innerHTML = `<div class="stats-loading">${loader(36, "center")}</div>`;
	const fresh = await api(`/stats?range=${range}`);
	S.statsCache[range] = fresh;
	if (S.statsRange !== range || !box.isConnected) return;
	if (!cached || JSON.stringify(cached) !== JSON.stringify(fresh)) renderStatsCard(box, fresh, range);
}

function renderStatsCard(box, st, range) {
	S.stats = st;
	const stats = [
		[t("k_sessions"), st.sessions, st.sessions],
		[t("k_messages"), st.messages.toLocaleString(), st.messages],
		[t("k_tokens"), fmtTokens(st.totalTokens), st.totalTokens, true],
		[t("k_days"), st.activeDays, st.activeDays],
		[t("k_streak"), st.currentStreak + "d"],
		[t("k_longest"), st.longestStreak + "d"],
		[t("k_peak"), st.peakHour ?? "—"],
		[t("k_fav"), st.favoriteModel ?? "—"],
	];
	const maxTok = Math.max(1, ...st.models.map((m) => m.tokens));
	// The header (tabs) is built once; later clicks only move the selection and swap the body, so
	// the buttons keep their animation state and the numbers don't count up from zero again.
	// The tabs go inside the card (home) or in a host the page provides (Statistiche: title row).
	const host = box._headHost ?? box;
	const first = !$(".stats-body", box);
	if (first) {
		const head = `<div class="stats-head">
			<div class="tabs" data-k="tab"><button data-v="overview">${t("overview")}</button><button data-v="models">${t("models")}</button></div>
			<div class="tabs" data-k="range">${["all", "30d", "7d"].map((r) => `<button data-v="${r}">${r === "all" ? t("all") : r}</button>`).join("")}</div>
		</div>`;
		if (host === box) box.innerHTML = head + `<div class="stats-body"></div>`;
		else {
			host.innerHTML = head;
			box.innerHTML = `<div class="stats-body"></div>`;
		}
		host.onclick = (e) => {
			const b = e.target.closest(".stats-head [data-v]");
			if (!b) return;
			const k = b.parentElement.dataset.k;
			if (k === "tab") S.statsTab = b.dataset.v;
			loadStatsCard(box, k === "range" ? b.dataset.v : S.statsRange);
		};
	}
	for (const b of host.querySelectorAll('.stats-head [data-k="tab"] button')) b.classList.toggle("on", b.dataset.v === S.statsTab);
	for (const b of host.querySelectorAll('.stats-head [data-k="range"] button')) b.classList.toggle("on", b.dataset.v === range);
	const body = $(".stats-body", box);
	body.classList.toggle("calm", !first);
	body.innerHTML = `
		${S.statsTab === "overview"
			? `<div class="stat-grid">${stats.map(([k, v, raw, fmtT]) => `<div class="stat"><div class="k">${k}</div><div class="v" title="${esc(v)}" ${typeof raw === "number" ? `data-count="${raw}" ${fmtT ? 'data-fmt="tokens"' : ""}` : ""}>${esc(v)}</div></div>`).join("")}</div>
			   <div class="heat">${heatCells(st.days)}</div>`
			: `<div class="model-rows">${st.models.slice(0, 8).map((m) => `<div class="model-row"><span>${esc(m.model)} <span style="color:var(--muted);font-size:12px">${esc(m.provider)}</span></span><span>${fmtTokens(m.tokens)}</span><span style="color:var(--muted)">$${m.cost.toFixed(2)}</span><div class="barwrap"><i style="width:${(m.tokens / maxTok) * 100}%"></i></div></div>`).join("") || `<div class="empty">—</div>`}</div>`}
		<div class="fun">${esc(st.funFact)} · ${tt("Spesa equivalente", "Equivalent spend")} $${st.totalCost.toFixed(2)}</div>`;
	if (first) {
		animateCounters(body);
		staggerOnce($(".stat-grid", body));
	}
}

export function heatCells(days, weeks = 26) {
	const max = Math.max(1, ...Object.values(days));
	const today = new Date();
	const start = new Date(today);
	start.setDate(start.getDate() - (weeks * 7 - 1) - today.getDay());
	let out = "";
	for (let w = 0; w <= weeks; w++)
		for (let d = 0; d < 7; d++) {
			const dt = new Date(start);
			dt.setDate(start.getDate() + w * 7 + d);
			if (dt > today) {
				out += `<i style="visibility:hidden"></i>`;
				continue;
			}
			const k = `${dt.getFullYear()}-${String(dt.getMonth() + 1).padStart(2, "0")}-${String(dt.getDate()).padStart(2, "0")}`;
			const v = days[k] || 0;
			const l = v === 0 ? 0 : Math.min(4, 1 + Math.floor((v / max) * 3.99));
			out += `<i class="l${l}" style="--d:${w}" title="${k}: ${fmtTokens(v)}"></i>`;
		}
	return out;
}

// ───────────────────────── composer ─────────────────────────
const SLASH = [
	["/compact", () => tt("Riassume la conversazione per liberare contesto", "Summarize the conversation to free context")],
	["/undo", () => tt("Annulla l'ultimo turno (file inclusi)", "Undo the last turn (files included)")],
	["/clear", () => tt("Svuota la conversazione", "Clear the conversation")],
	["/init", () => tt(`Crea ${initFile()} analizzando il progetto`, `Create ${initFile()} by analyzing the project`)],
	["/pr", () => tt("Crea una pull request con le modifiche", "Create a pull request with the changes")],
	["/usage", () => tt("Utilizzo dettagliato per modello e provider", "Detailed usage per model and provider")],
	["/github", () => tt("Collegamento con GitHub", "GitHub connection")],
	["/model", () => tt("Cambia modello", "Switch model")],
	["/mode", () => tt("Cambia modalità permessi", "Change permission mode")],
];

function currentOpts() {
	if (S.cur) return { model: S.cur.meta.model, effort: S.cur.meta.effort, mode: S.cur.meta.mode, envId: S.cur.meta.envId };
	const env = currentEnv();
	return {
		envId: env ? env.id : null,
		model: env?.model || S.settings.model.default,
		effort: S.settings.model.effort,
		mode: env?.permissionMode || S.settings.permissions.mode,
	};
}

function modelLabel(key) {
	const m = modelInfo(key);
	return m ? m.name : (key || "").split("/").pop();
}

const EFFORTS = ["off", "minimal", "low", "medium", "high", "xhigh", "max"];
/** Same clamping rule as the server: the effort that will really be used with this model. */
export function resolveEffortFor(m, e) {
	if (!m) return e;
	const levels = m.levels?.length ? m.levels : EFFORTS;
	if (levels.includes(e)) return e;
	const def = m.defaultEffort ?? (levels.includes("medium") ? "medium" : levels[levels.length - 1]);
	if (e === "off" || !EFFORTS.includes(e)) return def;
	let best = def, dist = 99;
	for (const l of levels) if (l !== "off" && Math.abs(EFFORTS.indexOf(l) - EFFORTS.indexOf(e)) < dist) { dist = Math.abs(EFFORTS.indexOf(l) - EFFORTS.indexOf(e)); best = l; }
	return best;
}
export function effortLabel(e) {
	return {
		off: tt("Nessuno", "None"), minimal: tt("Minimo", "Minimal"), low: tt("Basso", "Low"),
		medium: tt("Medio", "Medium"), high: tt("Alto", "High"), xhigh: tt("Extra", "Extra"), max: tt("Massimo", "Max"),
	}[e] ?? e;
}
function modelInfo(key) {
	const [prov, ...rest] = (key || "").split("/");
	const id = rest.join("/");
	return (S.provModels[prov]?.models ?? []).find((m) => m.id === id) ?? S.models.find((m) => m.key === key);
}
function modelReasoning(key) {
	const m = modelInfo(key);
	return m ? m.reasoning : true;
}
const PROV_COLORS = ["#d0bcff", "#a8c7fa", "#7fd8be", "#ffb4ab", "#f9c97f", "#efb8c8", "#b8c4ff", "#c3e88d"];
export function providerBadge(id, size = "") {
	const p = S.providers.find((x) => x.id === id);
	const name = (p?.name ?? id ?? "?").replace(/\(.*\)/, "").trim();
	const letters = name.split(/\s+/).map((w) => w[0]).join("").slice(0, 2).toUpperCase();
	let h = 0;
	for (const c of id || "") h = (h * 31 + c.charCodeAt(0)) >>> 0;
	return `<span class="pbadge ${size}" style="--pc:${PROV_COLORS[h % PROV_COLORS.length]}"><span class="pl">${esc(letters)}</span>${id && !S.noIcon?.has(id) ? `<img src="/api/favicon/${encodeURIComponent(id)}?t=${encodeURIComponent(token())}" alt="" loading="lazy" data-prov-icon="${esc(id)}">` : ""}</span>`;
}
const fmtPrice = (c) => (!c || (!c.input && !c.output) ? tt("gratis", "free") : "$" + +c.input.toFixed(2) + " / $" + +c.output.toFixed(2));

function modeInfo(id) {
	const m = S.boot.modes.find((x) => x.id === id) || S.boot.modes[0];
	return { label: lang() === "it" ? m.labelIt : m.label, desc: lang() === "it" ? m.descIt : m.desc, cls: id === "auto" ? "warn" : id === "plan" ? "plan" : id === "acceptEdits" ? "ok" : "" };
}

function chipsHtml(kind) {
	const o = currentOpts();
	const env = S.environments.find((e) => e.id === o.envId);
	const l = S.limits;
	const maxPct = l ? Math.max(l.fiveHour.enabled ? l.fiveHour.percent : 0, l.weekly.enabled ? l.weekly.percent : 0) : 0;
	const showRing = S.settings.limits.enabled || S.settings.limits.showWhenDisabled;
	const mi = modeInfo(o.mode);
	return `
		${kind === "home" ? `<button class="chip" data-chip="env">${icon("monitor")}<span>${esc(env?.name ?? t("noEnv"))}</span>${icon("down")}</button>` : `<span class="chip" title="${esc(S.cur?.meta.cwd)}">${icon("folder")}<span>${esc(env?.name ?? S.cur?.meta.cwd.split(/[\\/]/).pop())}</span></span>`}
		<div class="spacer"></div>
		<button class="chip" data-chip="model">${providerBadge(o.model.split("/")[0], "xs")}<span>${esc(modelLabel(o.model))}</span>${modelReasoning(o.model) ? `<span class="dim">${esc(effortLabel(resolveEffortFor(modelInfo(o.model), o.effort)))}</span>` : ""}${icon("down")}</button>
		<button class="chip ${mi.cls}" data-chip="mode" title="Shift+Tab"><span>${esc(mi.label)}</span></button>
		${showRing ? `<button class="chip" data-chip="limits" title="${t("usageLimits")}">${ringSvg(S.settings.limits.enabled ? maxPct : 0)}</button>` : ""}`;
}

export function refreshChips() {
	for (const below of $$(".below[data-kind]")) below.innerHTML = chipsHtml(below.dataset.kind);
}

function mountComposer(host, kind) {
	const running = kind === "session" && S.cur?.status !== "idle";
	host.innerHTML = `
		<div class="composer">
			<div class="attachments"></div>
			<textarea rows="1" placeholder="${esc(running ? t("placeholderBusy") : t("placeholder"))}"></textarea>
			<div class="row">
				<button class="icon-btn" data-c="attach" title="${t("attach")}">${icon("plus")}</button>
				<input type="file" multiple accept="image/*,.txt,.md,.json,.csv,.log,.js,.ts,.py,.html,.css,.xml,.yaml,.yml" hidden>
				<div class="spacer"></div>
				<button class="icon-btn" data-c="mic" title="${t("dictate")}">${icon("mic")}</button>
				<button class="send ${running ? "stop" : ""}" data-c="send" ${!running && !S.draft.text ? "disabled" : ""}>${icon(running ? "stop" : "send")}</button>
			</div>
		</div>
		<div class="below" data-kind="${kind}">${chipsHtml(kind)}</div>`;
	const ta = $("textarea", host);
	const send = $("[data-c=send]", host);
	const file = $("input[type=file]", host);
	ta.value = S.draft.text;
	const autosize = () => {
		// Empty: natural height (measuring before layout makes the placeholder wrap and inflate it).
		if (!ta.value || !ta.clientWidth) {
			ta.style.height = "";
			if (ta.value) requestAnimationFrame(autosize);
			return;
		}
		ta.style.height = "auto";
		ta.style.height = Math.min(ta.scrollHeight, 280) + "px";
	};
	const isRunning = () => kind === "session" && S.cur && S.cur.status !== "idle";
	const updateSend = () => {
		const r = isRunning();
		const hasText = !!ta.value.trim() || S.draft.images.length;
		send.disabled = !r && !hasText;
		send.classList.toggle("stop", r && !hasText);
		send.innerHTML = icon(r && !hasText ? "stop" : "send");
		ta.placeholder = r ? t("placeholderBusy") : t("placeholder");
	};
	host._updateSend = updateSend;
	autosize();
	renderAttachments(host);
	setTimeout(() => ta.focus(), 0);

	ta.addEventListener("input", () => {
		S.draft.text = ta.value;
		autosize();
		updateSend();
		slashMenu(host, ta);
	});
	ta.addEventListener("keydown", (e) => {
		const menu = $(".slash-menu", host);
		if (menu && ["ArrowDown", "ArrowUp", "Tab", "Enter"].includes(e.key) && !e.shiftKey) {
			const opts = $$(".opt", menu);
			let i = opts.findIndex((o) => o.classList.contains("on"));
			if (e.key === "ArrowDown") i = (i + 1) % opts.length;
			else if (e.key === "ArrowUp") i = (i - 1 + opts.length) % opts.length;
			else {
				e.preventDefault();
				opts[Math.max(0, i)]?.click();
				return;
			}
			e.preventDefault();
			opts.forEach((o, j) => o.classList.toggle("on", j === i));
			return;
		}
		if (e.key === "Tab" && e.shiftKey) {
			e.preventDefault();
			cycleMode(kind);
			return;
		}
		if (e.key === "Enter" && !e.shiftKey && !e.isComposing) {
			e.preventDefault();
			submit();
		}
	});
	ta.addEventListener("paste", (e) => {
		const items = [...(e.clipboardData?.items || [])].filter((i) => i.type.startsWith("image/"));
		if (!items.length) return;
		e.preventDefault();
		for (const it of items) addImage(it.getAsFile(), host, updateSend);
	});
	host.addEventListener("dragover", (e) => e.preventDefault());
	host.addEventListener("drop", (e) => {
		e.preventDefault();
		for (const f of e.dataTransfer.files) addFile(f, host, ta, updateSend);
	});
	file.onchange = () => {
		for (const f of file.files) addFile(f, host, ta, updateSend);
		file.value = "";
	};

	host.onclick = (e) => {
		const c = e.target.closest("[data-c]")?.dataset.c;
		if (c === "attach") file.click();
		if (c === "send") {
			if (isRunning() && !ta.value.trim() && !S.draft.images.length) api(`/sessions/${S.cur.meta.id}/abort`, { body: {} });
			else submit();
		}
		if (c === "mic") dictate(ta, e.target.closest("[data-c]"), updateSend);
		const chip = e.target.closest("[data-chip]");
		if (chip) chipMenu(chip, kind);
	};

	async function submit() {
		const text = ta.value.trim();
		const images = S.draft.images.map(({ data, mimeType }) => ({ type: "image", data, mimeType }));
		if (!text && !images.length) return;
		send.classList.remove("launch");
		void send.offsetWidth;
		send.classList.add("launch");
		S.draft = { text: "", images: [] };
		ta.value = "";
		autosize();
		renderAttachments(host);
		updateSend();
		$(".slash-menu", host)?.remove();
		if (kind === "session" && S.cur) {
			if (text === "/pr") return openPrDialog();
			if (text === "/usage") return go("/usage");
			if (text === "/github") return go("/settings/github");
			if (text === "/compact") return setCur(await api(`/sessions/${S.cur.meta.id}/compact`, { body: {} }));
			if (text === "/undo") return setCur((await api(`/sessions/${S.cur.meta.id}/undo`, { body: {} })).session);
			if (text === "/clear") return setCur(await api(`/sessions/${S.cur.meta.id}/clear`, { body: {} }));
			if (text === "/model") return chipMenu($('[data-chip="model"]', host), kind);
			if (text === "/mode") return chipMenu($('[data-chip="mode"]', host), kind);
			S.cur.notices = [];
			await api(`/sessions/${S.cur.meta.id}/prompt`, { body: { text: expandBuiltin(text), images } });
			return;
		}
		const o = currentOpts();
		try {
			const payload = await api("/sessions", { body: { envId: o.envId, cwd: S.boot.cwd, model: o.model, effort: o.effort, mode: o.mode } });
			setCur(payload);
			history.pushState(null, "", "#/s/" + payload.meta.id);
			renderSidebar();
			await api(`/sessions/${payload.meta.id}/prompt`, { body: { text: expandBuiltin(text), images } });
			refreshSessionsSoon();
		} catch (err) {
			toast(err.message, 4000);
		}
	}
}

function expandBuiltin(text) {
	if (text === "/init")
		return `Analyze this project (structure, languages, build/test commands, conventions) and create or update a ${initFile()} file in the working directory with concise instructions for an AI agent working here: overview, commands, code style, architecture notes, gotchas.`;
	return text;
}

function slashMenu(host, ta) {
	$(".slash-menu", host)?.remove();
	const v = ta.value;
	if (!v.startsWith("/") || v.includes(" ") || v.includes("\n")) return;
	const custom = (S.slashExtra || []).map((c) => [c.name, () => c.description]);
	const opts = [...SLASH, ...custom].filter(([n]) => n.startsWith(v)).slice(0, 12);
	if (!opts.length) return;
	const menu = el(`<div class="slash-menu">${opts.map(([n, d], i) => `<div class="opt ${i === 0 ? "on" : ""}" data-n="${esc(n)}"><b>${esc(n)}</b><span>${esc(d())}</span></div>`).join("")}</div>`);
	menu.onclick = (e) => {
		const o = e.target.closest("[data-n]");
		if (!o) return;
		ta.value = o.dataset.n + " ";
		S.draft.text = ta.value;
		menu.remove();
		ta.focus();
		ta.dispatchEvent(new Event("input"));
		$(".slash-menu", host)?.remove();
	};
	host.querySelector(".composer").parentElement.style.position = "relative";
	host.appendChild(menu);
}

async function loadSlashExtra() {
	const cwd = S.cur?.meta.cwd ?? currentEnv()?.cwd ?? S.boot.cwd;
	try {
		const [cmds, skills] = await Promise.all([api(`/commands?cwd=${encodeURIComponent(cwd)}`), api(`/skills?cwd=${encodeURIComponent(cwd)}`)]);
		S.slashExtra = [...cmds.map((c) => ({ name: "/" + c.name, description: c.description })), ...skills.filter((k) => k.enabled).map((k) => ({ name: "/" + k.name, description: "skill · " + k.description }))];
	} catch {
		S.slashExtra = [];
	}
}

function renderAttachments(host) {
	const box = $(".attachments", host);
	box.innerHTML = S.draft.images.map((im, i) => `<div class="att"><img src="data:${im.mimeType};base64,${im.data}"><button data-rm="${i}">×</button></div>`).join("");
	box.style.display = S.draft.images.length ? "flex" : "none";
	box.onclick = (e) => {
		const b = e.target.closest("[data-rm]");
		if (!b) return;
		S.draft.images.splice(Number(b.dataset.rm), 1);
		renderAttachments(host);
		host._updateSend?.();
	};
}

function addImage(f, host, cb) {
	const r = new FileReader();
	r.onload = () => {
		const [head, data] = String(r.result).split(",");
		S.draft.images.push({ data, mimeType: head.match(/data:(.*);/)[1] });
		renderAttachments(host);
		cb?.();
	};
	r.readAsDataURL(f);
}

function addFile(f, host, ta, cb) {
	if (f.type.startsWith("image/")) return addImage(f, host, cb);
	const r = new FileReader();
	r.onload = () => {
		ta.value += `${ta.value ? "\n\n" : ""}\`${f.name}\`:\n\`\`\`\n${String(r.result).slice(0, 100_000)}\n\`\`\`\n`;
		S.draft.text = ta.value;
		ta.dispatchEvent(new Event("input"));
	};
	r.readAsText(f);
}

let recognition = null;
function dictate(ta, btn, cb) {
	const SR = window.SpeechRecognition || window.webkitSpeechRecognition;
	if (!SR) return toast(tt("Dettatura non supportata da questo browser", "Dictation not supported by this browser"));
	if (recognition) {
		recognition.stop();
		return;
	}
	recognition = new SR();
	recognition.lang = lang() === "it" ? "it-IT" : "en-US";
	recognition.interimResults = true;
	recognition.continuous = true;
	const base = ta.value;
	btn.classList.add("active");
	recognition.onresult = (e) => {
		ta.value = base + (base ? " " : "") + [...e.results].map((r) => r[0].transcript).join("");
		S.draft.text = ta.value;
		cb();
	};
	recognition.onend = () => {
		btn.classList.remove("active");
		recognition = null;
	};
	recognition.start();
}

async function cycleMode(kind) {
	const order = ["ask", "acceptEdits", "auto", "plan"];
	const cur = currentOpts().mode;
	const next = order[(order.indexOf(cur) + 1) % order.length];
	await setOpt(kind, { mode: next });
}

async function setOpt(kind, patch) {
	if (kind === "session" && S.cur) {
		const id = S.cur.meta.id;
		if (patch.model) S.cur = mergeCur(await api(`/sessions/${id}/model`, { body: { model: patch.model } }));
		if (patch.effort) S.cur = mergeCur(await api(`/sessions/${id}/effort`, { body: { effort: patch.effort } }));
		if (patch.mode) S.cur = mergeCur(await api(`/sessions/${id}/mode`, { body: { mode: patch.mode } }));
		renderRightPanel();
	} else {
		if ("envId" in patch) setEnv(patch.envId);
		// Shared with Argon CLI: the last choice becomes the default everywhere.
		if (patch.model) S.settings.model.default = patch.model;
		if (patch.effort) S.settings.model.effort = patch.effort;
		if (patch.mode) S.settings.permissions.mode = patch.mode;
		if (patch.model || patch.effort || patch.mode) saveSettings(S.settings, true);
	}
	refreshChips();
}

function chipMenu(chip, kind) {
	const which = chip.dataset.chip;
	const o = currentOpts();
	if (which === "env") envMenu(chip);
	if (which === "model") openModelMenu(chip, kind);
	if (which === "mode") {
		const p = popover(
			chip,
			S.boot.modes.map((m) => { const mi = modeInfo(m.id); return `<button class="opt" data-mode="${m.id}"><span>${esc(mi.label)}<span class="desc">${esc(mi.desc)}</span></span>${o.mode === m.id ? `<span class="check">${icon("check")}</span>` : ""}</button>`; }).join("") +
				`<hr><div class="hdr">Shift+Tab ${tt("per cambiare", "to cycle")}</div>`,
			{ alignRight: true },
		);
		p.onclick = (e) => {
			const m = e.target.closest("[data-mode]");
			if (m) {
				closePop();
				setOpt(kind, { mode: m.dataset.mode });
			}
		};
	}
	if (which === "limits") limitsPopover(chip);
}

// ───────────── model & effort menu (cascading) ─────────────
function openModelMenu(chip, kind) {
	const o = currentOpts();
	const curProv = (o.model || "").split("/")[0];
	const provs = S.providers.filter((p) => p.connected && (!S.settings.providers.enabled.length || S.settings.providers.enabled.includes(p.id)));
	const cur = modelInfo(o.model);
	const root = popover(
		chip,
		`<div class="mlist">${
			provs.length
				? provs
						.map(
							(p) => `<button class="opt sub" data-prov="${p.id}">${providerBadge(p.id)}<span class="grow"><span class="t1">${esc(p.name)}</span>${p.id === curProv ? `<span class="t2">${esc(modelLabel(o.model))}</span>` : ""}</span>${p.id === curProv ? `<span class="check">${icon("check")}</span>` : ""}<span class="chev">${icon("chev")}</span></button>`,
						)
						.join("")
				: `<button class="opt" data-go-prov>${icon("key")}<span class="grow">${tt("Collega un provider", "Connect a provider")}</span>${icon("chev")}</button>`
		}</div>
		<hr>
		<button class="opt sub" data-effort-menu ${cur && !cur.reasoning ? "disabled" : ""}>${icon("psychology")}<span class="grow">${t("effort")}</span><span class="val">${esc(cur && !cur.reasoning ? tt("non supportato", "not supported") : effortLabel(resolveEffortFor(cur, o.effort)))}</span><span class="chev">${icon("chev")}</span></button>`,
		{ alignRight: true, cls: "model-menu", focus: false },
	);
	let hoverTimer;
	const openSub = (row) => {
		$$(".opt.sub", root).forEach((r) => r.classList.toggle("on", r === row));
		if (row.dataset.prov) openProviderMenu(row, row.dataset.prov, kind);
		else if (row.hasAttribute("data-effort-menu") && !row.disabled) openEffortMenu(row, kind);
	};
	root.addEventListener("mouseover", (e) => {
		const row = e.target.closest(".opt.sub");
		if (!row || row.classList.contains("on")) return;
		clearTimeout(hoverTimer);
		hoverTimer = setTimeout(() => openSub(row), 140);
	});
	root.onclick = (e) => {
		if (e.target.closest("[data-go-prov]")) {
			closePop();
			return go("/settings/providers");
		}
		const row = e.target.closest(".opt.sub");
		if (row) {
			clearTimeout(hoverTimer);
			openSub(row);
		}
	};
	const first = $(`.opt.sub[data-prov="${curProv}"]`, root);
	if (first) setTimeout(() => openSub(first), 0);
}

async function openProviderMenu(row, prov, kind) {
	const o = currentOpts();
	const pname = S.providers.find((p) => p.id === prov)?.name ?? prov;
	const sub = popover(
		row,
		`<div class="mhead">${providerBadge(prov)}<div class="grow"><div class="t1">${esc(pname)}</div><div class="t2" data-status>${tt("Carico i modelli…", "Loading models…")}</div></div><button class="icon-btn" data-refresh title="${tt("Aggiorna dal provider", "Refresh from provider")}">${icon("refresh")}</button></div>
		<label class="msearch">${icon("search")}<input placeholder="${tt("Cerca per nome, id, prezzo…", "Search by name, id, price…")}"></label>
		<div class="mrows">${loader(36, "center")}</div>`,
		{ level: 1, side: true, cls: "prov-menu", focus: false },
	);
	const input = $("input", sub);
	let data = S.provModels[prov];
	const render = () => {
		if (!data) return;
		const q = input.value.trim().toLowerCase();
		const list = data.models.filter((m) => !q || m.name.toLowerCase().includes(q) || m.id.toLowerCase().includes(q));
		const ago = data.fetchedAt ? relTime(data.fetchedAt, lang()) : "";
		$("[data-status]", sub).innerHTML = `${data.models.length} ${tt("modelli", "models")}${data.live ? ` · ${tt("dal provider", "from provider")} ${ago}` : ` · ${tt("catalogo integrato", "built-in catalog")}`}${data.error ? ` · <span class="err" title="${esc(data.error)}">${tt("aggiornamento non riuscito", "refresh failed")}</span>` : ""}`;
		$(".mrows", sub).innerHTML =
			list
				.slice(0, 400)
				.map((m) => {
					const key = prov + "/" + m.id;
					const on = o.model === key;
					return `<button class="mrow ${on ? "on" : ""}" data-model="${esc(key)}">
						<span class="grow"><span class="t1">${esc(m.name)}</span><span class="t2">${esc(m.id)}</span></span>
						<span class="meta"><span class="tag" title="${tt("Finestra di contesto", "Context window")}">${icon("memory")}${fmtTokens(m.contextWindow)}</span>
						<span class="tag price ${m.estimated ? "est" : ""}" title="${tt("$ per milione di token, input / output", "$ per million tokens, input / output")}${m.estimated ? " · " + tt("stimato", "estimated") : ""}">${fmtPrice(m.cost)}${m.estimated ? "*" : ""}</span>
						${m.reasoning ? `<span class="tag ico" title="${tt("Ragionamento", "Reasoning")}">${icon("psychology")}</span>` : ""}${(m.input || []).includes("image") ? `<span class="tag ico" title="${tt("Immagini", "Images")}">${icon("image")}</span>` : ""}</span>
						${on ? `<span class="check">${icon("check")}</span>` : ""}</button>`;
				})
				.join("") || `<div class="empty">${t("noResults")}</div>`;
		sub.reposition();
	};
	const load = async (force) => {
		if (force || !data) {
			$(".mrows", sub).innerHTML = loader(36, "center");
			try {
				data = S.provModels[prov] = await api(`/providers/${encodeURIComponent(prov)}/models${force ? "?refresh=1" : ""}`);
			} catch (e) {
				$(".mrows", sub).innerHTML = `<div class="empty">${esc(e.message)}</div>`;
				return;
			}
		}
		render();
		input.focus();
	};
	input.oninput = render;
	input.onkeydown = (e) => {
		if (e.key === "Enter") $(".mrow", sub)?.click();
	};
	sub.onclick = (e) => {
		if (e.target.closest("[data-refresh]")) return load(true);
		const r = e.target.closest("[data-model]");
		if (!r) return;
		closePop();
		setOpt(kind, { model: r.dataset.model });
	};
	load(false);
}

function openEffortMenu(row, kind) {
	const o = currentOpts();
	const m = modelInfo(o.model);
	const levels = m?.levels?.length ? m.levels : EFFORTS;
	const cur = resolveEffortFor(m, o.effort);
	const def = m?.defaultEffort;
	const prov = S.providers.find((p) => p.id === (o.model || "").split("/")[0])?.name ?? "";
	const warn = { xhigh: tt("~2× utilizzo", "~2× usage"), max: tt("3× o più utilizzo", "3× or more usage") };
	const sub = popover(
		row,
		`<div class="mnote">${tt("Più ragionamento significa risposte più accurate, ma più lente e che consumano più velocemente i limiti.", "Higher effort means more thorough responses, but takes longer and uses your limits faster.")}</div>
		${EFFORTS.filter((e) => levels.includes(e))
			.map(
				(e) => `<button class="opt" data-effort="${e}"><span class="grow">${effortLabel(e)}${e === def ? ` <span class="badge">${tt("Predefinito", "Default")}</span>` : ""}${warn[e] ? ` <span class="badge warn">${icon("warn")} ${warn[e]}</span>` : ""}</span>${cur === e ? `<span class="check">${icon("check")}</span>` : ""}</button>`,
			)
			.join("")}
		<div class="mfoot">${icon(m?.effortSource === "provider" ? "verified" : "menu_book")} ${m?.effortSource === "provider" ? tt(`Livelli dichiarati da ${esc(prov)} per questo modello`, `Levels reported by ${esc(prov)} for this model`) : tt("Livelli dal catalogo integrato", "Levels from the built-in catalog")}</div>`,
		{ level: 1, side: true, cls: "effort-menu", focus: false },
	);
	sub.onclick = (e) => {
		const b = e.target.closest("[data-effort]");
		if (!b) return;
		closePop();
		setOpt(kind, { effort: b.dataset.effort });
	};
}

export function limitRowHtml(label, w, unit, enabled) {
	const pct = Math.round(w.percent);
	const cls = w.percent >= 100 ? "over" : w.percent >= 80 ? "warn" : "";
	const reset = w.resetsAt
		? `${t("resets")} ${new Date(w.resetsAt).toLocaleString(lang(), new Date(w.resetsAt).toDateString() === new Date().toDateString() ? { hour: "2-digit", minute: "2-digit" } : { weekday: "short", hour: "2-digit", minute: "2-digit" })}`
		: t("startsFirst");
	return `<div class="lim"><div class="top"><span>${label}</span><span class="r">${reset}${enabled ? ` · ${pct}%` : ""}</span></div>
		<div class="bar ${cls}"><i style="width:${enabled ? Math.min(100, w.percent) : 0}%"></i></div>
		<div class="amt">${fmtAmount(w.used, unit)}${enabled ? ` / ${fmtAmount(w.limit, unit)}` : ""}</div></div>`;
}

export function spendHtml(sp) {
	if (!sp) return "";
	const maxProv = Math.max(0.0001, ...sp.byProvider.map((x) => x.cost));
	return `<div class="spend">
		<div class="spend-head"><span>${icon("payments")} ${tt("Speso", "Spent")}</span><span class="spend-note">${tt("costo equivalente API", "API-equivalent cost")}</span></div>
		<div class="spend-today"><span class="big" data-count="${sp.today}" data-money>$0.00</span><span class="lbl">${tt("oggi", "today")}</span></div>
		<div class="spend-grid">
			${[[tt("5 ore", "5 hours"), sp.fiveHour], [tt("Settimana", "Week"), sp.weekly], [tt("Mese", "Month"), sp.month], [tt("Totale", "Total"), sp.total]]
				.map(([k, v]) => `<div class="sg"><span class="v" data-count="${v}" data-money>$0.00</span><span class="k">${k}</span></div>`)
				.join("")}
		</div>
		${sp.byProvider.length ? `<div class="spend-prov">${sp.byProvider.slice(0, 4).map((x) => `<div class="sp-row">${providerBadge(x.provider, "xs")}<span class="n">${esc(S.providers.find((p) => p.id === x.provider)?.name ?? x.provider)}</span><span class="track"><i style="--w:${(x.cost / maxProv) * 100}%"></i></span><span class="c">$${x.cost.toFixed(2)}</span></div>`).join("")}</div>` : ""}
	</div>`;
}

/** Count numbers up from 0 (expressive emphasis on figures). */
export function animateCounters(root) {
	const motion = document.documentElement.dataset.motion;
	for (const el of root.querySelectorAll("[data-count]")) {
		const target = Number(el.dataset.count) || 0;
		const money = el.hasAttribute("data-money");
		const fmt = (v) => (money ? "$" + v.toFixed(v >= 100 ? 0 : 2) : el.dataset.fmt === "tokens" ? fmtTokens(v) : Math.round(v).toLocaleString(lang()));
		if (motion === "off" || target === 0) {
			el.textContent = fmt(target);
			continue;
		}
		const t0 = performance.now();
		const dur = 900 + Math.min(600, Math.log10(target + 1) * 200);
		const step = (now) => {
			const k = Math.min(1, (now - t0) / dur);
			const e = 1 - Math.pow(1 - k, 4);
			el.textContent = fmt(target * e);
			if (k < 1) requestAnimationFrame(step);
		};
		requestAnimationFrame(step);
	}
}

function limitsPopover(chip) {
	const l = S.limits;
	const en = S.settings.limits.enabled;
	const p = popover(
		chip,
		`<div class="head"><span>${t("usageLimits")} · ${l.unit === "cost" ? tt("credito", "credit") : "token"}</span><a data-go>${t("seeAll")} →</a></div>
		 ${limitRowHtml(t("fiveHour"), l.fiveHour, l.unit, en && l.fiveHour.enabled)}
		 ${limitRowHtml(t("weekly"), l.weekly, l.unit, en && l.weekly.enabled)}
		 ${en ? "" : `<div class="lim-off">${t("limitsOff")}</div>`}
		 ${spendHtml(l.spend)}`,
		{ alignRight: true, cls: "limits-pop" },
	);
	animateCounters(p);
	p.onclick = (e) => {
		if (e.target.closest("[data-go]")) {
			closePop();
			go("/settings/limits");
		}
	};
}

// ───────────────────────── session view ─────────────────────────
function mergeCur(payload) {
	const keep = S.cur && S.cur.meta.id === payload.meta.id ? { notices: S.cur.notices, tools: S.cur.tools } : {};
	return prepare({ ...payload, ...keep });
}

function prepare(p) {
	p.notices ??= [];
	p.tools ??= {};
	if (p.streaming) {
		p.messages.push(p.streaming);
		delete p.streaming;
	}
	for (const m of p.messages) {
		if (m.role === "toolResult") p.tools[m.toolCallId] = { status: m.isError ? "error" : "done", result: { content: m.content, details: m.details } };
	}
	return p;
}

export function setCur(payload) {
	S.cur = prepare(payload);
	if (payload.status !== "idle") {
		S.running.add(payload.meta.id);
		S.cur.runStart ??= Date.now();
	}
	renderSessionView();
}

async function openSession(id) {
	if (S.cur?.meta.id !== id) {
		try {
			S.cur = prepare(await api(`/sessions/${id}`));
		} catch (e) {
			toast(e.message);
			return go("/");
		}
	}
	if (envOf(S.cur.meta) !== S.envId) {
		S.envId = envOf(S.cur.meta);
		saveUi();
		refreshChips();
	}
	renderSessionView();
}

function renderSessionView() {
	renderSidebar();
	renderTopbar();
	const view = $("#view");
	view.innerHTML = `<div class="center-col"><div class="transcript" id="transcript"></div></div>`;
	$("#dock").innerHTML = `<div id="todo-dock"></div><div class="session-composer"><div class="composer-wrap" id="session-composer"></div></div>`;
	mountComposer($("#session-composer"), "session");
	loadSlashExtra();
	renderTranscript(true);
	renderTodos();
	renderRightPanel();
}

let rafPending = false;
function scheduleRender() {
	if (rafPending) return;
	rafPending = true;
	requestAnimationFrame(() => {
		rafPending = false;
		renderTranscript();
	});
}

const mdCache = new Map();
function mdCached(key, text) {
	const hit = mdCache.get(key);
	if (hit && hit.len === text.length) return hit.html;
	const html = md(text);
	mdCache.set(key, { len: text.length, html });
	if (mdCache.size > 2000) mdCache.delete(mdCache.keys().next().value);
	return html;
}

const TOOL_ICONS = { bash: "terminal", read: "file", write: "file", edit: "edit", ls: "folder", glob: "search", grep: "search", web_fetch: "globe", web_search: "globe", todo: "list", memory: "brain", skill: "spark", task: "layers", ask_user: "question" };
const TOOL_LABELS = {
	bash: ["Shell", "Shell"], read: ["Lettura", "Read"], write: ["Scrittura", "Write"], edit: ["Modifica", "Edit"], ls: ["Elenco", "List"], glob: ["Trova file", "Glob"], grep: ["Cerca", "Search"],
	web_fetch: ["Pagina web", "Fetch"], web_search: ["Ricerca web", "Web search"], todo: ["Attività", "Tasks"], memory: ["Memoria", "Memory"], skill: ["Skill", "Skill"], task: ["Sub-agente", "Sub-agent"], ask_user: ["Domanda", "Question"],
};
const toolLabel = (n) => (TOOL_LABELS[n] ? TOOL_LABELS[n][lang() === "it" ? 0 : 1] : n.startsWith("mcp__") ? n.split("__").slice(1).join(" · ") : n);
const toolArg = (a) => String(a?.command ?? a?.path ?? a?.pattern ?? a?.url ?? a?.query ?? a?.description ?? a?.name ?? (a ? JSON.stringify(a) : "")).replace(/\s+/g, " ");

function renderTranscript(forceBottom = false) {
	const box = $("#transcript");
	if (!box || !S.cur) return;
	const view = $("#view");
	const nearBottom = forceBottom || view.scrollHeight - view.scrollTop - view.clientHeight < 120;
	const c = S.cur;
	let html = c.summary ? `<div class="summary-box">${icon("compress")} ${t("summaryNote")}</div>` : "";
	let group = null;
	const flush = () => {
		if (!group) return;
		html += toolGroupHtml(group);
		group = null;
	};
	c.messages.forEach((m, mi) => {
		if (m.role === "user") {
			flush();
			const text = typeof m.content === "string" ? m.content : m.content.filter((x) => x.type === "text").map((x) => x.text).join("\n");
			const imgs = typeof m.content === "string" ? [] : m.content.filter((x) => x.type === "image");
			html += `<div class="msg-user"><div class="bubble">${imgs.length ? `<div class="imgs">${imgs.map((i) => `<img src="data:${i.mimeType};base64,${i.data}">`).join("")}</div>` : ""}${esc(text)}</div></div>`;
		} else if (m.role === "assistant") {
			(m.content || []).forEach((part, pi) => {
				if (part.type === "text" && part.text?.trim()) {
					flush();
					const last = mi === c.messages.length - 1 && pi === m.content.length - 1 && c.status === "running";
					html += `<div class="md ${last ? "cursor" : ""}">${mdCached(`${mi}:${pi}`, part.text)}</div>`;
				} else if (part.type === "thinking" && part.thinking?.trim()) {
					flush();
					html += `<details class="thinking"><summary>${icon("brain")} ${t("thinking")}</summary><div class="body">${esc(part.thinking)}</div></details>`;
				} else if (part.type === "toolCall" && part.name !== "todo") {
					group ??= [];
					group.push(part);
				}
			});
			if (m.stopReason === "error" && m.errorMessage) {
				flush();
				html += `<div class="notice error">${icon("x")} <span>${esc(m.errorMessage)}</span></div>`;
			}
			if (m.stopReason === "aborted") {
				flush();
				html += `<div class="notice info">${icon("stop")} <span>${t("stopped")}</span></div>`;
			}
		}
	});
	flush();
	for (const a of c.pendingApprovals || []) html += approvalHtml(a);
	for (const q of c.pendingQuestions || []) html += questionHtml(q);
	for (const n of (c.notices || []).slice(-4)) html += `<div class="notice ${n.level}">${icon(n.level === "error" ? "x" : n.level === "warn" ? "gauge" : "spark")} <span>${esc(n.text)}</span></div>`;
	if (c.status !== "idle" && !(c.pendingApprovals || []).length && !(c.pendingQuestions || []).length) {
		html += `<div class="working">${loader(28)}<span class="shimmer">${c.status === "compacting" ? tt("Compattando", "Compacting") : activeSubagents(c) ? tt(`${activeSubagents(c)} sub-agenti al lavoro`, `${activeSubagents(c)} sub-agents working`) : t("working")}…</span><span id="elapsed"></span></div>`;
	}
	reconcile(box, html);
	markNewBlocks(box);
	bindTranscript(box);
	if (nearBottom) view.scrollTop = view.scrollHeight;
}

/**
 * Replace only the top-level blocks whose HTML changed. Unchanged blocks (and their loaders,
 * shimmer and timers) stay in place, so streaming doesn't restart animations on every token.
 */
function reconcile(box, html) {
	const tpl = document.createElement("template");
	tpl.innerHTML = html;
	const next = [...tpl.content.children];
	const prev = [...box.children];
	next.forEach((node, i) => {
		const src = node.outerHTML;
		const old = prev[i];
		if (old && old._src === src) return;
		node._src = src;
		if (old) {
			box.replaceChild(node, old);
		} else box.appendChild(node);
	});
	for (let i = next.length; i < prev.length; i++) prev[i].remove();
}

/** Give the "enter" animation only to transcript blocks that were not on screen before. */
function markNewBlocks(box) {
	const seen = (S._seen ??= new Map());
	const key = S.cur.meta.id;
	const set = seen.get(key) ?? new Set();
	const first = !seen.has(key);
	const blocks = box.querySelectorAll(":scope > *");
	blocks.forEach((el, i) => {
		const k = el.dataset.group || el.dataset.approval || el.dataset.question || el.className.split(" ")[0] + ":" + i;
		if (!set.has(k)) {
			set.add(k);
			if (!first) el.classList.add("enter");
		}
	});
	seen.set(key, set);
}

function toolGroupHtml(calls) {
	const id = calls[0].id;
	const allBash = calls.every((x) => x.name === "bash");
	const allEdit = calls.every((x) => x.name === "edit" || x.name === "write");
	const running = calls.find((x) => S.cur.tools[x.id]?.status === "running" || (!S.cur.tools[x.id] && x.name !== "…"));
	const anyErr = calls.some((x) => S.cur.tools[x.id]?.status === "error");
	const label = allBash ? t("ran", calls.length) : allEdit ? t("edited", calls.length) : t("used", calls.length);
	const open = S.openGroups.has(id) || calls.some((x) => x.name === "task" && S.cur.subagents?.[x.id]?.phase && S.cur.subagents[x.id].phase !== "end");
	const live = running && S.cur.status !== "idle" ? ` · <span class="shimmer">${esc(toolLabel(running.name))} ${esc(toolArg(running.arguments).slice(0, 60))}</span>` : "";
	return `<div class="tools ${open ? "open" : ""}" data-group="${id}">
		<div class="tools-head">${label}${anyErr ? ` <span class="del">●</span>` : ""}${live} <span class="chev">${icon("chev")}</span></div>
		<div class="tools-list">${calls.map(toolHtml).join("")}</div></div>`;
}

const activeSubagents = (c) => Object.values(c.subagents ?? {}).filter((x) => x.phase !== "end").length;

function subagentHtml(call, status, open, out) {
	const sa = S.cur.subagents?.[call.id];
	const name = sa?.agent ?? call.arguments?.agent ?? "general";
	const live = sa && sa.phase !== "end";
	const steps = sa?.steps ?? [];
	return `<div class="tool subagent ${open ? "open" : ""} ${live ? "live" : ""}" data-tool="${call.id}" style="--ac:${esc(sa?.color ?? "var(--primary)")}">
		<div class="tool-line">${icon("smart_toy")}<b>${esc(toolLabel("task"))}</b><span class="agent-chip">${esc(name)}</span><span class="arg">${esc(call.arguments?.description ?? "")}</span>${steps.length ? `<span class="steps-count">${steps.length} ${tt("passi", "steps")}</span>` : ""}${status}</div>
		${steps.length ? `<div class="sa-steps">${steps.slice(-8).map((p) => `<div class="sa-step ${p.status}">${p.status === "running" ? loader(14, "sm") : icon(p.status === "error" ? "close" : "check")}<b>${esc(toolLabel(p.tool))}</b><span>${esc(p.text ?? "")}</span></div>`).join("")}${steps.length > 8 ? `<div class="sa-more">+${steps.length - 8} ${tt("passi precedenti", "earlier steps")}</div>` : ""}</div>` : ""}
		${sa?.model ? `<div class="sa-meta">${icon("memory")} ${esc(sa.model)}</div>` : ""}
		<div class="tool-out">${out}</div></div>`;
}

function toolHtml(call) {
	const st = S.cur.tools[call.id];
	const res = st?.result;
	const d = res?.details || {};
	const status = !st || st.status === "running" ? loader(16, "sm") : st.status === "error" ? `<span class="st err">${icon("x")}</span>` : `<span class="st ok">${icon("check")}</span>`;
	const stat = call.name === "edit" || call.name === "write" ? `<span class="stat"><span class="add">+${d.added ?? (call.arguments?.content ?? "").split("\n").length}</span> <span class="del">-${d.removed ?? 0}</span></span>` : "";
	const open = S.openTools.has(call.id);
	let out = "";
	if (open) {
		if (call.name === "edit" && call.arguments) {
			out = `<div class="diff">${String(call.arguments.old_string ?? "").split("\n").map((l) => `<span class="l-del">- ${esc(l)}</span>`).join("")}${String(call.arguments.new_string ?? "").split("\n").map((l) => `<span class="l-add">+ ${esc(l)}</span>`).join("")}</div>`;
			if (st?.status === "error") out += "\n" + esc(resText(res));
		} else if (call.name === "write" && call.arguments) {
			out = `<div class="diff">${String(call.arguments.content ?? "").split("\n").slice(0, 60).map((l) => `<span class="l-add">+ ${esc(l)}</span>`).join("")}</div>`;
		} else {
			const args = call.name === "bash" ? `$ ${call.arguments?.command ?? ""}\n\n` : `${JSON.stringify(call.arguments ?? {}, null, 2)}\n\n`;
			const imgs = (res?.content || []).filter((x) => x.type === "image").map((i) => `<img src="data:${i.mimeType};base64,${i.data}">`).join("");
			out = esc(args) + esc(st?.partial && st.status === "running" ? st.partial : resText(res)) + imgs;
		}
	}
	if (call.name === "task") return subagentHtml(call, status, open, out);
	return `<div class="tool ${open ? "open" : ""}" data-tool="${call.id}">
		<div class="tool-line">${icon(TOOL_ICONS[call.name] || "plug")}<b>${esc(toolLabel(call.name))}</b><span class="arg">${esc(toolArg(call.arguments))}</span>${status}${stat}</div>
		<div class="tool-out">${out}</div></div>`;
}

const resText = (res) => (res?.content || []).filter((x) => x.type === "text").map((x) => x.text).join("\n").slice(0, 20000);

function approvalHtml(a) {
	const body = a.tool === "bash" ? `$ ${a.args.command}` : a.tool === "edit" ? `${a.args.path}\n- ${String(a.args.old_string).slice(0, 600)}\n+ ${String(a.args.new_string).slice(0, 600)}` : a.tool === "write" ? `${a.args.path}\n\n${String(a.args.content).slice(0, 1200)}` : JSON.stringify(a.args, null, 2).slice(0, 1500);
	return `<div class="card approval" data-approval="${a.id}">
		<div class="ttl">${icon("shield")} ${t("permission")} · ${esc(toolLabel(a.tool))}</div>
		${a.outside?.length ? `<div class="why">${icon("folder_off")} ${tt(`Scrive fuori dall'ambiente «${esc(a.envName ?? "")}»`, `Writes outside the “${esc(a.envName ?? "")}” environment`)}: ${a.outside.map(esc).join(", ")}</div>` : ""}
		${a.args?.description ? `<div style="color:var(--muted);font-size:12.5px;margin-bottom:6px">${esc(a.args.description)}</div>` : ""}
		<pre>${esc(body)}</pre>
		<div class="acts"><button class="btn pri" data-choice="allow">${t("approve")}</button><button class="btn" data-choice="always" title="${esc(a.suggestion)}">${t("always")} <span style="color:var(--muted);font-family:var(--mono);font-size:11px">${esc(a.suggestion)}</span></button><button class="btn danger" data-choice="deny">${t("deny")}</button></div></div>`;
}

function questionHtml(q) {
	return `<div class="card" data-question="${q.id}">
		<div class="ttl">${icon("question")} ${t("question")}</div>
		<div style="margin-bottom:10px">${esc(q.question)}</div>
		<div class="acts">${q.options.map((o) => `<button class="btn" data-answer="${esc(o)}">${esc(o)}</button>`).join("")}</div>
		<div class="keyrow" style="margin-top:8px"><input class="inp" placeholder="${tt("Oppure scrivi una risposta…", "Or type an answer…")}"><button class="btn pri" data-answer-free>${t("answer")}</button></div></div>`;
}

function bindTranscript(box) {
	box.onclick = async (e) => {
		const copy = e.target.closest(".copy");
		if (copy) {
			navigator.clipboard.writeText(copy.nextElementSibling.textContent);
			copy.textContent = t("copied");
			return;
		}
		const head = e.target.closest(".tools-head");
		if (head) {
			const id = head.parentElement.dataset.group;
			S.openGroups.has(id) ? S.openGroups.delete(id) : S.openGroups.add(id);
			head.parentElement.classList.toggle("open");
			return;
		}
		const line = e.target.closest(".tool-line");
		if (line) {
			const id = line.parentElement.dataset.tool;
			S.openTools.has(id) ? S.openTools.delete(id) : S.openTools.add(id);
			renderTranscript();
			return;
		}
		const ch = e.target.closest("[data-choice]");
		if (ch) {
			const id = ch.closest("[data-approval]").dataset.approval;
			await api(`/sessions/${S.cur.meta.id}/approval`, { body: { id, choice: ch.dataset.choice } });
			return;
		}
		const ans = e.target.closest("[data-answer],[data-answer-free]");
		if (ans) {
			const card = ans.closest("[data-question]");
			const answer = ans.dataset.answer ?? card.querySelector("input").value;
			await api(`/sessions/${S.cur.meta.id}/answer`, { body: { id: card.dataset.question, answer } });
		}
	};
}

function renderTodos() {
	const dock = $("#todo-dock");
	if (!dock || !S.cur) return;
	const todos = S.cur.todos || [];
	if (!todos.length || S.cur.status === "idle") {
		dock.innerHTML = "";
		return;
	}
	const done = todos.filter((x) => x.status === "completed").length;
	dock.innerHTML = `<div class="todo-dock"><div class="h"><span>${t("tasks")} ${done}/${todos.length}</span></div>${todos.map((x) => `<div class="todo ${x.status === "completed" ? "done" : x.status === "in_progress" ? "cur" : ""}"><span class="c">${x.status === "completed" ? icon("check") : x.status === "in_progress" ? loader(18, "sm") : icon("radio_button_unchecked")}</span>${esc(x.content)}</div>`).join("")}</div>`;
}

export function renderRightPanel() {
	const rp = $("#rightpanel");
	if (!rp) return;
	if (!S.cur || !S.rightPanel) {
		rp.classList.remove("show");
		$("#layout")?.classList.remove("rp-open");
		return;
	}
	if (!rp.classList.contains("show")) setTimeout(() => staggerOnce(rp), 0);
	rp.classList.add("show");
	$("#layout")?.classList.add("rp-open");
	const c = S.cur;
	const env = S.environments.find((e) => e.id === c.meta.envId);
	const ctx = c.context || { percent: 0, used: 0, window: modelInfo(c.meta.model)?.contextWindow ?? 0 };
	const g = c.git || {};
	const mcpOn = S.mcp.filter((m) => m.status === "connected");
	const todos = c.todos || [];
	rp.innerHTML = `
		<div class="rp-sec"><div class="rp-h">${t("environment")} ${env ? `<button class="icon-btn" style="width:22px;height:22px" data-go="/settings/environments">${icon("settings")}</button>` : ""}</div>
			<div class="rp-row">${icon("monitor")}<span class="t">${esc(env?.name ?? t("noEnv"))}</span></div>
			<div class="rp-row" title="${esc(c.meta.cwd)}">${icon("folder")}<span class="t">${esc(c.meta.cwd)}</span></div>
			<div class="rp-row">${icon("branch")}<span class="t">${g.branch ? esc(g.branch) : `<span class="dim">${t("noGit")}</span>`}</span></div>
		</div>
		<div class="rp-sec"><div class="rp-h">${t("context")} <span>${Math.round(ctx.percent)}%</span></div>
			<div class="ctxbar"><div class="bar ${ctx.percent >= 80 ? "warn" : ""}"><i style="width:${ctx.percent}%"></i></div></div>
			<div class="rp-row"><span class="dim">${fmtTokens(ctx.used)} / ${fmtTokens(ctx.window)} token</span></div>
		</div>
		<div class="rp-sec"><div class="rp-h">${t("connectors")} <span>${mcpOn.length} ${t("connected")}</span></div>
			${S.mcp.map((m) => `<div class="rp-row click" data-go="/customize/connectors">${icon("plug")}<span class="t">${esc(m.name)}</span><span class="dim" style="margin-left:auto">${m.status === "connected" ? m.tools.length + " tools" : m.status}</span></div>`).join("") || `<div class="rp-row click" data-go="/customize/connectors"><span class="dim">${t("none")} · ${t("add")} →</span></div>`}
		</div>
		${rpChanges(c, g)}${rpGit(c)}${rpBackground(c)}
		${todos.length ? `<div class="rp-sec"><div class="rp-h">${t("tasks")} <span>${todos.filter((x) => x.status === "completed").length}/${todos.length}</span></div>${todos.map((x) => `<div class="todo ${x.status === "completed" ? "done" : x.status === "in_progress" ? "cur" : ""}" style="font-size:12.5px"><span class="c">${x.status === "completed" ? "✓" : x.status === "in_progress" ? "◐" : "○"}</span>${esc(x.content)}</div>`).join("")}</div>` : ""}
		<div class="rp-sec"><div class="rp-h">${t("usage")}</div>
			<div class="rp-row"><span class="t">$${(c.usage?.cost ?? 0).toFixed(3)}</span><span class="dim" style="margin-left:auto">${fmtTokens(c.usage?.tokens ?? 0)} token</span></div>
			${c.usage?.subagentCost ? `<div class="rp-row"><span class="dim">${tt("di cui sub-agenti", "of which sub-agents")} $${c.usage.subagentCost.toFixed(3)}</span></div>` : ""}
			${S.settings.limits.enabled ? `<div class="rp-row"><span class="dim">5h ${Math.round(S.limits.fiveHour.percent)}% · ${tt("sett.", "week")} ${Math.round(S.limits.weekly.percent)}%</span></div>` : ""}
		</div>
		${c.instructions?.length ? `<div class="rp-sec"><div class="rp-h">${t("instructions")}</div>${c.instructions.map((p) => `<div class="rp-row" title="${esc(p)}">${icon("book")}<span class="t">${esc(p.split(/[\\/]/).slice(-2).join("/"))}</span></div>`).join("")}</div>` : ""}`;
	rp.onclick = (e) => {
		const g2 = e.target.closest("[data-go]");
		if (g2) go(g2.dataset.go);
	};
}

// ───────────────────────── websocket events ─────────────────────────
const refreshCurSoon = debounce(async () => {
	if (!S.cur) return;
	const id = S.cur.meta.id;
	const p = await api(`/sessions/${id}`);
	if (S.cur?.meta.id !== id) return;
	S.cur.context = p.context;
	S.cur.git = p.git;
	S.cur.usage = p.usage;
	S.cur.instructions = p.instructions;
	renderRightPanel();
}, 400);

const reloadBootSoon = debounce(reloadBoot, 300);

function onWs(msg) {
	if (msg.type?.startsWith("oauth_")) return onOAuthEvent(msg);
	if (!msg.sessionId) {
		if (msg.type === "limits") {
			S.limits = msg.limits;
			refreshChips();
		}
		if (msg.type === "sessions_changed") refreshSessionsSoon();
		if (msg.type === "environments_changed") reloadBootSoon();
		if (msg.type === "settings_changed") reloadBootSoon();
		if (msg.type === "models_changed") {
			S.provModels = {};
			reloadBootSoon();
		}
		if (msg.type === "mcp_changed") {
			S.mcp = msg.mcp;
			renderRightPanel();
		}
		return;
	}
	const sid = msg.sessionId;
	if (msg.type === "status") {
		msg.status === "idle" ? S.running.delete(sid) : S.running.add(sid);
		if (msg.status === "idle") S.waiting.delete(sid);
		renderSidebar();
	}
	if (msg.type === "approval_request" || msg.type === "question") {
		S.waiting.add(sid);
		renderSidebar();
		if (document.hidden && Notification?.permission === "granted") new Notification("Argon", { body: t("permission") });
	}
	if (msg.type === "approval_resolved" || msg.type === "question_resolved") {
		S.waiting.delete(sid);
		renderSidebar();
	}
	if (msg.type === "limits") {
		notifyLimits(msg.limits);
		S.limits = msg.limits;
		refreshChips();
	}
	const c = S.cur;
	if (!c || c.meta.id !== sid) return;
	switch (msg.type) {
		case "message_start":
			c.messages.push(structuredClone(msg.message));
			break;
		case "message_update": {
			let last = c.messages[c.messages.length - 1];
			if (!last || last.role !== "assistant") {
				last = { role: "assistant", content: [] };
				c.messages.push(last);
			}
			const ev = msg.ev;
			const i = ev.contentIndex;
			if (ev.type === "text_start") last.content[i] = { type: "text", text: "" };
			else if (ev.type === "text_delta") (last.content[i] ??= { type: "text", text: "" }).text += ev.delta;
			else if (ev.type === "thinking_start") last.content[i] = { type: "thinking", thinking: "" };
			else if (ev.type === "thinking_delta") (last.content[i] ??= { type: "thinking", thinking: "" }).thinking += ev.delta;
			else if (ev.type === "toolcall_start") last.content[i] = { type: "toolCall", id: "pending-" + i, name: "…", arguments: {} };
			else if (ev.type === "toolcall_end" && ev.toolCall) last.content[i] = ev.toolCall;
			break;
		}
		case "message_end": {
			const last = c.messages[c.messages.length - 1];
			if (last && last.role === msg.message.role) c.messages[c.messages.length - 1] = msg.message;
			else c.messages.push(msg.message);
			break;
		}
		case "tool_execution_start":
			c.tools[msg.toolCallId] = { status: "running" };
			break;
		case "tool_execution_update":
			if (c.tools[msg.toolCallId]) c.tools[msg.toolCallId].partial = msg.text;
			break;
		case "tool_execution_end":
			c.tools[msg.toolCallId] = { status: msg.isError ? "error" : "done", result: msg.result };
			if (["write", "edit", "bash"].includes(msg.toolName)) refreshCurSoon();
			break;
		case "todos": {
			const wasDone = (c.todos || []).length && c.todos.every((x) => x.status === "completed");
			const nowDone = msg.todos.length > 1 && msg.todos.every((x) => x.status === "completed");
			if (nowDone && !wasDone) {
				const r = ($(".todo-dock") ?? $("#session-composer"))?.getBoundingClientRect();
				if (r) burst(r.left + r.width / 2, r.top + 10);
			}
			c.todos = msg.todos;
			renderTodos();
			renderRightPanel();
			break;
		}
		case "approval_request":
			c.pendingApprovals = [...(c.pendingApprovals || []), msg];
			break;
		case "approval_resolved":
			c.pendingApprovals = (c.pendingApprovals || []).filter((a) => a.id !== msg.id);
			break;
		case "question":
			c.pendingQuestions = [...(c.pendingQuestions || []), msg];
			break;
		case "question_resolved":
			c.pendingQuestions = (c.pendingQuestions || []).filter((a) => a.id !== msg.id);
			break;
		case "status":
			if (msg.status !== "idle" && c.status === "idle") c.runStart = Date.now();
			c.status = msg.status;
			if (msg.status === "idle") {
				c.subagent = null;
				refreshCurSoon();
				renderTodos();
			}
			$("#session-composer")?._updateSend?.();
			break;
		case "notice":
			c.notices.push(msg);
			break;
		case "meta":
			c.meta = msg.meta;
			renderTopbar();
			refreshChips();
			break;
		case "background":
			c.background = msg.processes;
			renderRightPanel();
			break;
		case "subagent": {
			c.subagents ??= {};
			const sa = (c.subagents[msg.toolCallId] ??= { agent: msg.agent, steps: [], phase: "start" });
			sa.phase = msg.phase;
			if (msg.phase === "start") Object.assign(sa, { model: msg.model, color: msg.color });
			if (msg.phase === "step") sa.steps.push({ tool: msg.tool, text: msg.text, status: "running" });
			if (msg.phase === "step_end") {
				const st = [...sa.steps].reverse().find((x) => x.tool === msg.tool && x.status === "running");
				if (st) st.status = msg.isError ? "error" : "done";
			}
			if (msg.phase === "end") for (const st of sa.steps) if (st.status === "running") st.status = "done";
			break;
		}
		case "agent_end":
			refreshCurSoon();
			break;
	}
	scheduleRender();
}

setInterval(() => {
	const e = document.getElementById("elapsed");
	if (e && S.cur?.runStart) e.textContent = `${Math.floor((Date.now() - S.cur.runStart) / 1000)}s`;
}, 1000);

if ("Notification" in window && Notification.permission === "default") setTimeout(() => Notification.requestPermission().catch(() => {}), 4000);

boot();

// ───────────────────────── git, pull requests, background, import ─────────────────────────
export const initFile = () => S.settings?.context?.initFile || "ARGON.md";

function rpChanges(c, g) {
	const ch = g?.changes;
	if (!g?.root) return "";
	const has = !!(ch && (ch.files || ch.added || ch.removed));
	return `<div class="rp-sec"><div class="rp-h">${t("changes")}</div>
		<div class="rp-changes">${icon("edit")}<span>${ch?.files ?? 0} file</span><span class="stats"><span class="add">+${ch?.added ?? 0}</span> <span class="del">-${ch?.removed ?? 0}</span></span></div>
		<div style="margin-top:8px;display:flex;justify-content:flex-end"><button class="pr-btn" data-pr ${has ? "" : "disabled"} title="${has ? tt("Crea una pull request (/pr)", "Create a pull request (/pr)") : tt("Nessuna modifica da proporre", "No changes to propose")}">${icon("merge")} ${tt("Crea PR", "Create PR")}</button></div>
	</div>`;
}

function rpGit(c) {
	const prs = [...(c.meta.prs ?? []).map((p) => ({ ...p, state: "OPEN" })), ...(c.meta.git?.prs ?? [])];
	const commits = c.meta.git?.commits ?? [];
	if (!prs.length && !commits.length) return "";
	return `<div class="rp-sec"><div class="rp-h">${tt("Git della sessione", "Session git")}</div>
		${prs.length ? `<div class="pr-list">${prs.slice(0, 6).map((p) => `<a href="${esc(p.url)}" target="_blank" rel="noopener">${icon("merge")} #${p.number} ${esc(p.title)}</a>`).join("")}</div>` : ""}
		${commits.slice(0, 5).map((m) => `<div class="rp-row"><code style="font:11.5px var(--mono);color:var(--primary)">${esc(m.hash)}</code><span class="t">${esc(m.subject)}</span></div>`).join("")}
	</div>`;
}

function rpBackground(c) {
	const list = c.background ?? [];
	if (!list.length) return "";
	return `<div class="rp-sec"><div class="rp-h">${tt("Terminali in background", "Background terminals")} <span>${list.filter((p) => p.status === "running").length}</span></div>
		${list.map((p) => `<div class="bg-row"><span class="dot ${p.status === "running" ? "" : "off"}"></span><code title="${esc(p.command)}">${esc(p.command)}</code>${p.status === "running" ? `<button class="icon-btn" data-bgkill="${p.id}" title="${tt("Ferma", "Stop")}">${icon("stop_circle")}</button>` : `<span class="dim">${p.exitCode ?? ""}</span>`}</div>`).join("")}
	</div>`;
}

document.addEventListener("click", async (e) => {
	if (e.target.closest("[data-pr]") && !e.target.closest("[data-pr]").disabled) return openPrDialog();
	const k = e.target.closest("[data-bgkill]");
	if (k && S.cur) {
		await api(`/sessions/${S.cur.meta.id}/background/${k.dataset.bgkill}/kill`, { body: {} });
		toast(tt("Processo fermato", "Process stopped"));
	}
});

export async function openPrDialog() {
	if (!S.cur) return toast(tt("Apri una sessione per creare una PR", "Open a session to create a PR"));
	const id = S.cur.meta.id;
	const [st, gh] = await Promise.all([api(`/sessions/${id}/gitstate`, { body: {} }).catch((e) => ({ error: e.message })), api("/github").catch(() => ({ connected: false }))]);
	if (!st.isRepo) return toast(tt("Questa cartella non è un repository git", "This folder is not a git repository"), 3500);
	const lastText = [...S.cur.messages].reverse().find((m) => m.role === "assistant" && m.content?.some((x) => x.type === "text" && x.text.trim()));
	const summary = (lastText?.content.find((x) => x.type === "text")?.text ?? "").slice(0, 1200);
	const body = `## ${tt("Riepilogo", "Summary")}\n\n${summary}\n\n## ${tt("Modifiche", "Changes")}\n\n${st.files.map((f) => `- \`${f.path}\``).join("\n")}\n\n---\n⚛ ${tt("Creata con", "Created with")} Argon`;
	const blocked = !gh.connected ? tt("GitHub non è collegato: collegalo in Impostazioni → GitHub.", "GitHub is not connected: connect it in Settings → GitHub.") : !st.isGithub ? tt("Il remote 'origin' non è su GitHub.", "The 'origin' remote is not on GitHub.") : !st.files.length && !st.ahead ? tt("Non ci sono modifiche.", "There are no changes.") : "";
	modal(
		`<h3>${icon("merge")} ${tt("Crea pull request", "Create pull request")}</h3>
		<div class="group">
			<div class="field col"><div class="lbl"><b>${tt("Titolo", "Title")}</b></div><input class="inp full" name="title" value="${esc(S.cur.meta.title === "New session" ? "" : S.cur.meta.title)}"></div>
			<div class="field col"><div class="lbl"><b>${tt("Descrizione", "Description")}</b></div><textarea class="inp full" rows="9" name="body">${esc(body)}</textarea></div>
			<div class="field"><div class="lbl"><b>${tt("Ramo di destinazione", "Base branch")}</b><small>${tt("Ramo attuale", "Current branch")}: ${esc(st.branch || "—")}${st.branch === st.defaultBranch ? tt(" → ne verrà creato uno nuovo", " → a new one will be created") : ""}</small></div><input class="inp s" name="base" value="${esc(st.defaultBranch || "main")}"></div>
			<div class="field"><div class="lbl"><b>${tt("Messaggio di commit", "Commit message")}</b><small>${st.files.length} ${tt("file non ancora committati", "uncommitted files")}</small></div><input class="inp w" name="commit" value="${esc(S.cur.meta.title === "New session" ? "Update" : S.cur.meta.title)}"></div>
			<div class="field"><div class="lbl"><b>${tt("Bozza", "Draft")}</b></div><label class="toggle"><input type="checkbox" name="draft"><i></i></label></div>
		</div>
		${st.files.length ? `<div class="pr-files">${st.files.slice(0, 80).map((f) => `<div><span class="st">${esc(f.status)}</span>${esc(f.path)}</div>`).join("")}</div>` : ""}
		${blocked ? `<div class="notice warn" style="margin-top:12px">${icon("info")} <span>${blocked} ${!gh.connected ? `<a href="#/settings/github" data-x>${tt("Apri impostazioni", "Open settings")}</a>` : ""}</span></div>` : ""}
		<div class="acts"><button class="btn" data-x>${t("cancel")}</button><button class="btn pri" data-ok ${blocked ? "disabled" : ""}>${icon("merge")} ${tt("Crea PR", "Create PR")}</button></div>`,
		(m, close) => {
			m.querySelectorAll("[data-x]").forEach((x) => (x.onclick = close));
			m.querySelector("[data-ok]").onclick = async (ev) => {
				const v = (n) => m.querySelector(`[name=${n}]`);
				if (!v("title").value.trim()) return toast(tt("Serve un titolo", "A title is required"));
				const btn = ev.target.closest("button");
				btn.disabled = true;
				btn.innerHTML = `${loader(18, "sm")} ${tt("Creazione…", "Creating…")}`;
				try {
					const r = await api(`/sessions/${id}/pr`, { body: { title: v("title").value.trim(), body: v("body").value, base: v("base").value.trim(), commitMessage: v("commit").value.trim(), draft: v("draft").checked } });
					close();
					setCur(r.session);
					toast(`✓ PR #${r.number} ${tt("creata", "created")}`, 3500);
					window.open(r.url, "_blank");
				} catch (err) {
					btn.disabled = false;
					btn.innerHTML = `${icon("merge")} ${tt("Crea PR", "Create PR")}`;
					toast(err.message, 6000);
				}
			};
		},
	);
}

export async function openImportDialog() {
	const list = await api("/import-cli");
	if (!list.length) return toast(tt("Nessuna sessione da importare", "No sessions to import"));
	modal(
		`<div class="del-head" style="background:var(--tertiary-container);color:var(--on-tertiary-container)">${icon("terminal")}</div>
		<h3>${tt("Importa da Argon CLI", "Import from Argon CLI")}</h3>
		<p class="del-sub">${tt("Viene importato tutto: messaggi, ultimo modello e modalità, attività, modifiche, repository, ultimi commit e pull request. Ogni sessione viene collegata all'ambiente della sua cartella.", "Everything comes along: messages, last model and mode, tasks, changes, repository, latest commits and pull requests. Each session is linked to the environment of its folder.")}</p>
		<div style="display:flex;align-items:baseline;gap:10px"><span class="import-count">${list.length}</span><span>${tt("sessioni da importare", "sessions to import")}</span></div>
		<div class="import-list">${list.map((s) => `<div class="ir">${icon("chat")}<div class="grow"><b>${esc(s.title === "New session" ? t("newSession") : s.title)}</b><small>${esc(s.cwd)}</small></div><span class="dim" style="font-size:12px">${relTime(s.updatedAt, lang())}</span></div>`).join("")}</div>
		<div class="acts"><button class="btn" data-x>${t("cancel")}</button><button class="btn pri" data-ok>${icon("download")} ${tt("Importa tutto", "Import all")}</button></div>`,
		(m, close) => {
			m.querySelector("[data-x]").onclick = close;
			m.querySelector("[data-ok]").onclick = async (ev) => {
				const btn = ev.target.closest("button");
				btn.disabled = true;
				btn.innerHTML = `${loader(18, "sm")} ${tt("Importazione…", "Importing…")}`;
				const r = await api("/import-cli", { body: {} });
				close();
				await reloadBoot();
				const envName = r.sessions.find((x) => x.envName)?.envName;
				const env = envName && S.environments.find((e) => e.name === envName);
				if (env) setEnv(env.id);
				go("/");
				const envs = r.environmentsCreated.length ? tt(` · ${r.environmentsCreated.length} ambienti creati`, ` · ${r.environmentsCreated.length} environments created`) : "";
				toast(`✓ ${r.imported} ${tt("sessioni importate", "sessions imported")}${envs}`, 4000);
			};
		},
	);
}

/** Toast + system notification when usage gets close to (or reaches) a limit. */
let lastLimitLevel = 0;
function notifyLimits(l) {
	if (!l?.enabled) return;
	const pct = Math.max(l.fiveHour.enabled ? l.fiveHour.percent : 0, l.weekly.enabled ? l.weekly.percent : 0);
	const level = pct >= 100 ? 2 : pct >= l.warnAt ? 1 : 0;
	if (level > lastLimitLevel) {
		const which = l.fiveHour.enabled && l.fiveHour.percent >= (level === 2 ? 100 : l.warnAt) ? t("fiveHour") : t("weekly");
		const msg = level === 2 ? tt(`Limite raggiunto: ${which}`, `Limit reached: ${which}`) : tt(`Attenzione: ${which} al ${Math.round(pct)}%`, `Heads up: ${which} at ${Math.round(pct)}%`);
		toast(msg, 5000);
		if (document.hidden && "Notification" in window && Notification.permission === "granted") new Notification("Argon", { body: msg });
	}
	lastLimitLevel = level;
}
