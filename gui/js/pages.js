import { api, esc, $, $$, el, icon, t, tt, lang, modal, toast, fmtTokens, fmtAmount, debounce, relTime, loader, staggerOnce, setSel } from "./lib.js";
import { S, go, saveSettings, touchSettings, reloadBoot, loadStatsCard, limitRowHtml, refreshSessions, applyTheme, revealTransition, spendHtml, animateCounters, providerBadge, setEnv, renameEnv, confirmDeleteEnv } from "./app.js";
import { PRESETS, SCHEME_NAMES, buildScheme } from "./theme.js";

// ───────────────────────── generic settings form helpers ─────────────────────────
const getP = (o, p) => p.split(".").reduce((a, k) => (a == null ? undefined : a[k]), o);
function setP(o, p, v) {
	const ks = p.split(".");
	let x = o;
	for (const k of ks.slice(0, -1)) x = x[k] ??= {};
	x[ks[ks.length - 1]] = v;
}

function parseAmount(v) {
	const m = String(v).trim().replace(/^\$/, "").replace(",", ".").match(/^([\d.]+)\s*([kmb])?$/i);
	if (!m) return NaN;
	return Number(m[1]) * ({ k: 1e3, m: 1e6, b: 1e9 }[(m[2] || "").toLowerCase()] || 1);
}

/** One settings row. kind: text | number | bool | select | lines | csv | textarea | amount | password */
function F(path, label, help = "", kind = "text", opts = {}) {
	const v = getP(S.settings, path);
	let ctrl = "";
	const attrs = `data-path="${path}" data-kind="${kind}"`;
	if (kind === "bool") ctrl = `<label class="toggle"><input type="checkbox" ${attrs} ${v ? "checked" : ""}><i></i></label>`;
	else if (kind === "select")
		ctrl = `<select class="inp ${opts.w || "w"}" ${attrs}>${opts.options.map(([val, l]) => `<option value="${esc(val)}" ${String(v) === String(val) ? "selected" : ""}>${esc(l)}</option>`).join("")}</select>`;
	else if (kind === "lines" || kind === "textarea")
		ctrl = `<textarea class="inp full" rows="${opts.rows || 4}" ${attrs} placeholder="${esc(opts.ph || "")}">${esc(kind === "lines" ? (v || []).join("\n") : v ?? "")}</textarea>`;
	else if (kind === "csv") ctrl = `<input class="inp w" ${attrs} value="${esc((v || []).join(", "))}" placeholder="${esc(opts.ph || "")}">`;
	else if (kind === "amount") ctrl = `<input class="inp s" ${attrs} value="${esc(opts.unit === "cost" ? v : fmtTokens(v))}">`;
	else ctrl = `<input class="inp ${opts.w || (kind === "number" ? "s" : "w")}" type="${kind === "password" ? "password" : kind === "number" ? "number" : "text"}" ${attrs} value="${esc(v ?? "")}" placeholder="${esc(opts.ph || "")}" ${opts.step ? `step="${opts.step}"` : ""}>`;
	const col = kind === "lines" || kind === "textarea";
	return `<div class="field ${col ? "col" : ""}"><div class="lbl"><b>${label}</b>${help ? `<small>${help}</small>` : ""}</div>${ctrl}</div>`;
}

function bindForm(root, after) {
	const save = debounce(async () => {
		await saveSettings(S.settings);
		after?.();
	}, 350);
	root.addEventListener("change", (e) => {
		const c = e.target.closest("[data-path]");
		if (!c) return;
		const k = c.dataset.kind;
		let v;
		if (k === "bool") v = c.checked;
		else if (k === "number") v = c.value === "" ? null : Number(c.value);
		else if (k === "lines") v = c.value.split("\n").map((s) => s.trim()).filter(Boolean);
		else if (k === "csv") v = c.value.split(",").map((s) => s.trim()).filter(Boolean);
		else if (k === "amount") {
			v = parseAmount(c.value);
			if (Number.isNaN(v)) return toast(tt("Valore non valido (es. 2M, 500k, 5)", "Invalid value (e.g. 2M, 500k, 5)"));
		} else if (k === "select") v = /^\d+$/.test(c.value) && typeof getP(S.settings, c.dataset.path) === "number" ? Number(c.value) : c.value;
		else v = c.value;
		setP(S.settings, c.dataset.path, v);
		save();
	});
}

function pageShell(view, title, tabs, cur, base) {
	// Same page (e.g. Settings → another Settings section): keep the menu, move the selection in
	// place and replace only the section content.
	const sig = [base, title, ...tabs.map(([id, , l]) => id + ":" + l)].join("|");
	const reuse = view.querySelector(".page")?.dataset.sig === sig;
	if (!reuse) {
		view.innerHTML = `<div class="page" data-sig="${esc(sig)}"><nav class="page-nav"><h2>${title}</h2>${tabs.map(([id, ic, l]) => `<button class="nav-item" data-go="${base}/${id}">${icon(ic)} ${l}</button>`).join("")}</nav><div class="page-body" id="page-body"></div></div>`;
		view.querySelector(".page-nav").onclick = (e) => {
			const b = e.target.closest("[data-go]");
			// the section already open: nothing to do (re-rendering would replay its animations)
			if (b && !b.classList.contains("sel")) go(b.dataset.go);
		};
	}
	for (const b of view.querySelectorAll(".page-nav .nav-item")) {
		const on = b.dataset.go === `${base}/${cur}`;
		if (reuse) setSel(b, on);
		else b.classList.toggle("sel", on);
	}
	let body = $("#page-body", view);
	if (reuse) {
		// A new container per section: late async results of the previous section land in the
		// detached old one instead of overwriting this section.
		const next = document.createElement("div");
		next.className = "page-body";
		next.id = "page-body";
		body.replaceWith(next);
		body = next;
		view.scrollTop = 0;
	}
	setTimeout(() => staggerOnce(body, 1100), 0);
	return body;
}

// ───────────────────────── settings ─────────────────────────
export function renderSettings(view, tab) {
	const tabs = [
		["general", "settings", tt("Generale", "General")],
		["appearance", "palette", tt("Aspetto", "Appearance")],
		["providers", "key", tt("Provider e account", "Providers & accounts")],
		["github", "code", "GitHub"],
		["models", "cpu", tt("Modelli", "Models")],
		["limits", "gauge", tt("Limiti di utilizzo", "Usage limits")],
		["permissions", "shield", tt("Permessi", "Permissions")],
		["tools", "terminal", tt("Strumenti", "Tools")],
		["context", "book", tt("Contesto", "Context")],
		["environments", "monitor", tt("Ambienti", "Environments")],
		["cli", "terminal", "CLI"],
		["control", "smart_toy", tt("Controllo agenti AI", "AI agent control")],
		["advanced", "sliders", tt("Avanzate", "Advanced")],
	];
	const body = pageShell(view, t("settings"), tabs, tab, "/settings");
	const R = { general, appearance, providers, github, models, limits, permissions, tools, context, environments, cli, control, advanced }[tab] ?? general;
	R(body);
}

// ───────────────────────── appearance ─────────────────────────
function seg(path, options, cur) {
	return `<div class="tabs seg-group" data-seg="${path}">${options.map(([v, l, ic]) => `<button class="${String(cur) === String(v) ? "on" : ""}" data-v="${v}">${ic ? icon(ic) : ""}${l}</button>`).join("")}</div>`;
}

function appearance(b) {
	let ap = S.settings.appearance;
	const live = () => (ap = S.settings.appearance);
	const th = S.settings.general.theme;
	const schemeLabels = {
		tonalSpot: tt("Tonale", "Tonal spot"),
		vibrant: tt("Vivace", "Vibrant"),
		expressive: tt("Espressivo", "Expressive"),
		fidelity: tt("Fedele", "Fidelity"),
		neutral: tt("Neutro", "Neutral"),
		monochrome: tt("Monocromo", "Monochrome"),
	};
	const swatch = (seed, scheme) => {
		const p = buildScheme(seed, scheme || ap.scheme).dark;
		return `<span class="sw-dots"><i style="background:${p["--primary"]}"></i><i style="background:${p["--secondary-container"]}"></i><i style="background:${p["--tertiary"]}"></i></span>`;
	};
	b.innerHTML = `<h3>${tt("Aspetto", "Appearance")}</h3><p class="lead">${tt("Scegli un colore: Argon genera l'intera palette Material 3 (toni primari, secondari, terziari e superfici) per il tema chiaro e quello scuro.", "Pick a colour: Argon generates the whole Material 3 palette (primary, secondary, tertiary tones and surfaces) for light and dark.")}</p>
	<div class="preview stagger">
		<div class="pv-fab">${icon("edit_square")} ${t("newSession")}</div>
		<div class="pv-row"><span class="btn pri">${tt("Primario", "Primary")}</span><span class="btn tonal">${tt("Tonale", "Tonal")}</span><span class="btn">${tt("Contorno", "Outlined")}</span></div>
		<div class="pv-row"><span class="chip">${icon("auto_awesome")} chip</span><label class="toggle"><input type="checkbox" checked><i></i></label><span class="pv-bubble">${tt("Ciao Argon!", "Hi Argon!")}</span></div>
		<div class="bar" style="width:100%"><i style="width:62%"></i></div>
		<div class="pv-tones">${["--primary", "--primary-container", "--secondary-container", "--tertiary", "--tertiary-container", "--surface-high", "--outline"].map((v) => `<i style="background:var(${v})" title="${v}"></i>`).join("")}</div>
	</div>
	<div class="group"><div class="gh">${tt("Colore", "Colour")}</div>
		<div class="presets stagger">${PRESETS.map((p) => `<button class="preset ${ap.preset === p.id ? "on" : ""}" data-preset="${p.id}" style="--sw:${p.seed}"><span class="sym">${p.sym}</span>${swatch(p.seed, p.scheme)}<span class="nm">${p.name}</span></button>`).join("")}
			<label class="preset custom ${ap.preset === "custom" ? "on" : ""}" style="--sw:${esc(ap.seed)}"><span class="sym">${icon("colorize")}</span>${swatch(ap.seed)}<span class="nm">${tt("Personale", "Custom")}</span><input type="color" value="${esc(ap.seed)}" data-color></label>
		</div>
		<div class="field"><div class="lbl"><b>${tt("Colore di base", "Seed colour")}</b><small>${tt("Esadecimale, es. #7c4dff", "Hex, e.g. #7c4dff")}</small></div><span class="hexrow"><i class="hexdot" style="background:${esc(ap.seed)}"></i><input class="inp s" data-hex value="${esc(ap.seed)}"></span></div>
		<div class="field col"><div class="lbl"><b>${tt("Variante della palette", "Palette variant")}</b><small>${tt("Quanto colore usare e come distribuirlo tra i ruoli", "How much colour and how it spreads across roles")}</small></div>${seg("appearance.scheme", SCHEME_NAMES.map((n) => [n, schemeLabels[n]]), ap.scheme)}</div>
		<div class="field col"><div class="lbl"><b>${tt("Contrasto", "Contrast")}</b></div>${seg("appearance.contrast", [["standard", "Standard"], ["medium", tt("Medio", "Medium")], ["high", tt("Alto", "High")]], ap.contrast)}</div>
	</div>
	<div class="group"><div class="gh">${tt("Tema e forma", "Theme and shape")}</div>
		<div class="field col"><div class="lbl"><b>${tt("Tema", "Theme")}</b></div>${seg("general.theme", [["dark", tt("Scuro", "Dark"), "dark_mode"], ["light", tt("Chiaro", "Light"), "light_mode"], ["system", tt("Sistema", "System"), "contrast"]], th)}</div>
		<div class="field col"><div class="lbl"><b>${tt("Forme", "Shapes")}</b><small>${tt("Raggio degli angoli di card, menu e pulsanti", "Corner radius of cards, menus and buttons")}</small></div>${seg("appearance.radius", [["square", tt("Squadrate", "Square"), "crop_square"], ["standard", "Standard", "rounded_corner"], ["round", tt("Arrotondate", "Round"), "circle"]], ap.radius)}</div>
	</div>
	<div class="group"><div class="gh">${tt("Movimento e dimensioni", "Motion and size")}</div>
		<div class="field col"><div class="lbl"><b>${tt("Animazioni", "Animations")}</b><small>${tt("Complete: transizioni, rimbalzi, onde e forme che cambiano. Ridotte: solo dissolvenze.", "Full: transitions, springs, waves and morphing shapes. Reduced: fades only.")}</small></div>${seg("appearance.motion", [["full", tt("Complete", "Full"), "animation"], ["reduced", tt("Ridotte", "Reduced"), "motion_photos_paused"], ["off", tt("Nessuna", "None"), "block"]], ap.motion)}</div>
		<div class="field"><div class="lbl"><b>${tt("Dimensione interfaccia", "Interface size")}</b><small>${ap.scale}%</small></div><input type="range" class="slider" min="80" max="130" step="5" value="${ap.scale}" data-scale></div>
	</div>`;
	const save = debounce(() => saveSettings(S.settings, true), 400);
	const apply = (fn, ev) => {
		const r = ev?.target?.getBoundingClientRect?.();
		// Record the choice right away (not inside the animation callback): with quick clicks a newer
		// transition can interrupt this one, and the newest state must always win.
		fn();
		touchSettings();
		revealTransition(
			() => {
				applyTheme();
				appearance(b);
			},
			r ? r.left + r.width / 2 : undefined,
			r ? r.top + r.height / 2 : undefined,
		);
		save();
	};
	b.onclick = (e) => {
		live();
		const p = e.target.closest("[data-preset]");
		if (p) {
			const pr = PRESETS.find((x) => x.id === p.dataset.preset);
			return apply(() => Object.assign(live(), { preset: pr.id, seed: pr.seed, scheme: pr.scheme ?? (ap.scheme === "monochrome" ? "tonalSpot" : ap.scheme) }), e);
		}
		const sb = e.target.closest("[data-seg] button");
		if (sb) {
			const [grp, key] = sb.parentElement.dataset.seg.split(".");
			return apply(() => (S.settings[grp][key] = sb.dataset.v), e);
		}
	};
	b.oninput = (e) => {
		live();
		if (e.target.matches("[data-color]") || (e.target.matches("[data-hex]") && /^#[0-9a-f]{6}$/i.test(e.target.value))) {
			Object.assign(ap, { seed: e.target.value.toLowerCase(), preset: "custom" });
			touchSettings();
			applyTheme();
			$(".hexdot", b).style.background = ap.seed;
			if (e.target.matches("[data-color]")) $("[data-hex]", b).value = ap.seed;
			save();
		}
		// While dragging only the label follows: zooming the window under the pointer would move the
		// slider itself and make the value jump. The size is applied when the slider is released.
		if (e.target.matches("[data-scale]")) e.target.closest(".field").querySelector("small").textContent = e.target.value + "%";
	};
	b.onchange = (e) => {
		if (e.target.matches("[data-color]")) appearance(b);
		if (e.target.matches("[data-scale]")) {
			ap.scale = Number(e.target.value);
			touchSettings();
			applyTheme();
			save();
		}
	};
}

function general(b) {
	b.innerHTML = `<h3>${tt("Generale", "General")}</h3><p class="lead">${tt("Personalizza Argon a tuo gusto.", "Make Argon yours.")}</p>
	<div class="group">
		${F("general.userName", tt("Il tuo nome", "Your name"), tt("Usato nel saluto della home", "Used in the home greeting"))}
		${F("general.language", tt("Lingua", "Language"), "", "select", { options: [["it", "Italiano"], ["en", "English"]] })}
		${F("general.greeting", tt("Saluto", "Greeting"), tt("Mostrato quando il nome è vuoto", "Shown when no name is set"))}
		${F("general.showStatsOnHome", tt("Statistiche nella home", "Stats on home"), "", "bool")}
		${F("general.autoTitle", tt("Titoli automatici", "Automatic titles"), tt("Il modello dà un nome alle nuove sessioni", "The model names new sessions"), "bool")}
	</div>
	<div class="group"><div class="gh">GUI</div>
		${F("general.openGuiAs", tt("Apri la GUI come", "Open the GUI as"), tt("Comando argon gui: app desktop, finestra Edge/Chrome o scheda del browser", "argon gui command: desktop app, Edge/Chrome window or browser tab"), "select", { options: [["desktop", tt("App desktop", "Desktop app")], ["app", tt("Finestra Edge/Chrome", "Edge/Chrome window")], ["browser", "Browser"], ["none", tt("Non aprire", "Don't open")]] })}
		${F("general.guiPort", tt("Porta (versione web)", "Port (web version)"), tt("Solo per argon gui --web; l'app desktop sceglie una porta libera", "Only for argon gui --web; the desktop app picks a free port"), "number")}
	</div>`;
	bindForm(b, () => general(b));
}

const initials = (n) => n.replace(/\(.*\)/, "").trim().split(/\s+/).map((w) => w[0]).join("").slice(0, 2).toUpperCase();

function providers(b) {
	const list = S.providers;
	const featured = ["anthropic", "openai", "openai-codex", "openrouter", "google", "github-copilot", "ollama", "lmstudio"];
	const top = list.filter((p) => featured.includes(p.id));
	const rest = list.filter((p) => !featured.includes(p.id));
	const row = (p) => `
		<div class="prov" data-prov="${p.id}">
			${providerBadge(p.id, "lg")}
			<div class="info"><b>${esc(p.name)}</b><small>${esc(p.hint || p.id)}${p.envKeys?.length ? ` · env: ${esc(p.envKeys.join(", "))}` : ""}</small></div>
			${p.connected ? `<span class="badge on">${p.connected === "oauth" ? "OAuth" : p.connected === "env" ? tt("variabile d'ambiente", "env variable") : p.connected === "local" ? "local" : "API key"}</span>` : `<span class="badge">${tt("non collegato", "not connected")}</span>`}
			${p.oauth ? `<button class="btn sm" data-oauth>${icon("user")} ${t("loginOAuth")}</button>` : ""}
			${p.connected && p.connected !== "env" && p.connected !== "local" ? `<button class="btn sm danger" data-logout>${t("disconnect")}</button>` : ""}
			${p.apiKey ? `<div class="keyrow"><input class="inp" type="password" placeholder="${t("apiKey")}${p.custom ? "" : ` (${esc(p.id)})`}"><button class="btn sm" data-key>${t("save")}</button></div>` : ""}
			${p.custom && p.id && (p.baseUrl || "").includes("localhost") ? `<div class="keyrow"><span style="color:var(--muted);font-size:12px;flex:1">${p.modelCount} ${tt("modelli", "models")} · ${esc(p.baseUrl)}</span><button class="btn sm" data-discover>${icon("refresh")} ${tt("Rileva modelli", "Discover models")}</button></div>` : ""}
		</div>`;
	b.innerHTML = `<h3>${tt("Provider e account", "Providers & accounts")}</h3>
	<p class="lead">${tt("Collega un account (OAuth) o una API key per ogni provider. Le credenziali restano sul tuo PC in", "Connect an account (OAuth) or an API key per provider. Credentials stay on your PC in")} <code>~/.argon/auth.json</code>.</p>
	<div class="notice warn" style="margin-bottom:16px">${icon("shield")}<span>${tt("Claude Pro/Max via OAuth: i termini di Anthropic possono limitare l'uso degli abbonamenti fuori dalle app ufficiali. Usalo a tuo rischio; la API key è l'opzione supportata.", "Claude Pro/Max via OAuth: Anthropic's terms may restrict using subscriptions outside official apps. Use at your own risk; an API key is the supported option.")}</span></div>
	<div class="group">${top.map(row).join("")}</div>
	<details class="group"><summary class="field" style="cursor:pointer"><div class="lbl"><b>${tt("Altri provider", "More providers")} (${rest.length})</b><small>xAI, Groq, Mistral, DeepSeek, Bedrock, Azure, Vercel, Cloudflare, Hugging Face…</small></div></summary>${rest.map(row).join("")}</details>
	<div class="group"><div class="gh">${tt("Provider personalizzati (compatibili OpenAI)", "Custom providers (OpenAI-compatible)")}</div>
		${S.settings.providers.custom.map((c, i) => `<div class="list-item"><div class="grow"><b>${esc(c.name)}</b> <span class="badge">${esc(c.id)}</span><small>${esc(c.baseUrl)} · ${c.models.length} ${tt("modelli", "models")}: ${esc(c.models.slice(0, 6).join(", "))}</small></div><button class="btn sm" data-edit-custom="${i}">${icon("edit")}</button><button class="btn sm danger" data-rm-custom="${i}">${icon("trash")}</button></div>`).join("")}
		<div class="list-item"><button class="btn sm" data-add-custom>${icon("plus")} ${tt("Aggiungi provider", "Add provider")}</button></div>
	</div>
	<div class="group"><div class="gh">${tt("Modelli aggiuntivi", "Extra models")}</div>
		<div class="field"><div class="lbl"><small>${tt("Aggiungi modelli nuovi non ancora nel catalogo (es. anthropic/claude-opus-5-5). Copiano impostazioni e prezzi da un modello modello.", "Add new models not yet in the catalog (e.g. anthropic/claude-opus-5-5). They copy settings and pricing from a template model.")}</small></div></div>
		${S.settings.providers.customModels.map((m, i) => `<div class="list-item"><div class="grow"><b>${esc(m.provider)}/${esc(m.id)}</b><small>${m.template ? "template " + esc(m.template) : ""} ${m.cost ? `· $${m.cost.input ?? "?"}/$${m.cost.output ?? "?"}` : ""} ${m.contextWindow ? "· " + fmtTokens(m.contextWindow) + " ctx" : ""}</small></div><button class="btn sm danger" data-rm-model="${i}">${icon("trash")}</button></div>`).join("")}
		<div class="list-item"><button class="btn sm" data-add-model>${icon("plus")} ${tt("Aggiungi modello", "Add model")}</button></div>
	</div>
	<div class="group"><div class="gh">OpenRouter</div>
		${F("providers.openRouterRouting.sort", tt("Ordina provider per", "Sort upstream by"), "", "select", { options: [["", tt("predefinito", "default")], ["price", tt("prezzo", "price")], ["throughput", "throughput"], ["latency", tt("latenza", "latency")]] })}
		${F("providers.openRouterRouting.dataCollection", tt("Raccolta dati", "Data collection"), tt("deny = solo provider che non salvano i dati", "deny = only providers that don't store data"), "select", { options: [["", tt("predefinito", "default")], ["allow", "allow"], ["deny", "deny"]] })}
		${F("providers.openRouterRouting.zdr", "Zero Data Retention", "", "bool")}
	</div>`;
	bindForm(b);
	b.onclick = async (e) => {
		const pr = e.target.closest("[data-prov]")?.dataset.prov;
		if (e.target.closest("[data-key]")) {
			const key = e.target.closest("[data-prov]").querySelector("input").value.trim();
			if (!key) return;
			S.providers = (await api(`/providers/${pr}/key`, { body: { key } })).providers;
			await reloadBoot();
			toast(`✓ ${pr}`);
			providers(b);
		}
		if (e.target.closest("[data-logout]")) {
			S.providers = (await api(`/providers/${pr}`, { method: "DELETE" })).providers;
			await reloadBoot();
			providers(b);
		}
		if (e.target.closest("[data-oauth]")) startOAuth(pr, () => providers(b));
		if (e.target.closest("[data-discover]")) {
			const cp = S.settings.providers.custom.find((c) => c.id === pr);
			try {
				const r = await api("/providers/discover", { body: { baseUrl: cp.baseUrl } });
				cp.models = r.models;
				await saveSettings(S.settings, true);
				toast(`${r.models.length} ${tt("modelli trovati", "models found")}`);
			} catch (err) {
				toast(`${tt("Server non raggiungibile", "Server unreachable")}: ${err.message}`, 3500);
			}
			providers(b);
		}
		const rmc = e.target.closest("[data-rm-custom]");
		if (rmc) {
			S.settings.providers.custom.splice(Number(rmc.dataset.rmCustom), 1);
			await saveSettings(S.settings);
			providers(b);
		}
		const edc = e.target.closest("[data-edit-custom]");
		if (e.target.closest("[data-add-custom]") || edc) customProviderModal(edc ? Number(edc.dataset.editCustom) : -1, () => providers(b));
		const rmm = e.target.closest("[data-rm-model]");
		if (rmm) {
			S.settings.providers.customModels.splice(Number(rmm.dataset.rmModel), 1);
			await saveSettings(S.settings);
			providers(b);
		}
		if (e.target.closest("[data-add-model]")) customModelModal(() => providers(b));
	};
}

function customProviderModal(index, done) {
	const c = index >= 0 ? S.settings.providers.custom[index] : { id: "", name: "", baseUrl: "http://localhost:11434/v1", api: "openai-completions", models: [], noAuth: false };
	modal(
		`<h3>${tt("Provider personalizzato", "Custom provider")}</h3>
		<div class="group">
			<div class="field"><div class="lbl"><b>ID</b><small>${tt("es. vllm, together, mio-server", "e.g. vllm, together, my-server")}</small></div><input class="inp w" name="id" value="${esc(c.id)}"></div>
			<div class="field"><div class="lbl"><b>${t("name")}</b></div><input class="inp w" name="name" value="${esc(c.name)}"></div>
			<div class="field"><div class="lbl"><b>Base URL</b></div><input class="inp w" name="baseUrl" value="${esc(c.baseUrl)}"></div>
			<div class="field"><div class="lbl"><b>API</b></div><select class="inp w" name="api">${["openai-completions", "openai-responses", "anthropic-messages"].map((a) => `<option ${c.api === a ? "selected" : ""}>${a}</option>`).join("")}</select></div>
			<div class="field col"><div class="lbl"><b>${tt("Modelli", "Models")}</b><small>${tt("uno per riga", "one per line")}</small></div><textarea class="inp full" rows="4" name="models">${esc(c.models.join("\n"))}</textarea></div>
			<div class="field"><div class="lbl"><b>${tt("Senza chiave", "No key needed")}</b><small>${tt("server locali", "local servers")}</small></div><label class="toggle"><input type="checkbox" name="noAuth" ${c.noAuth ? "checked" : ""}><i></i></label></div>
		</div>
		<div class="acts"><button class="btn" data-x>${t("cancel")}</button><button class="btn pri" data-ok>${t("save")}</button></div>`,
		(m, close) => {
			m.querySelector("[data-x]").onclick = close;
			m.querySelector("[data-ok]").onclick = async () => {
				const v = (n) => m.querySelector(`[name=${n}]`);
				const next = { id: v("id").value.trim(), name: v("name").value.trim() || v("id").value.trim(), baseUrl: v("baseUrl").value.trim(), api: v("api").value, models: v("models").value.split("\n").map((s) => s.trim()).filter(Boolean), noAuth: v("noAuth").checked };
				if (!next.id || !next.baseUrl) return toast("ID + Base URL");
				if (index >= 0) S.settings.providers.custom[index] = next;
				else S.settings.providers.custom.push(next);
				await saveSettings(S.settings);
				close();
				done();
			};
		},
	);
}

function customModelModal(done) {
	const provs = S.providers.filter((p) => !p.custom);
	modal(
		`<h3>${tt("Aggiungi modello", "Add model")}</h3>
		<div class="group">
			<div class="field"><div class="lbl"><b>Provider</b></div><select class="inp w" name="provider">${provs.map((p) => `<option value="${p.id}">${esc(p.name)}</option>`).join("")}</select></div>
			<div class="field"><div class="lbl"><b>Model ID</b><small>${tt("es. claude-opus-5-5", "e.g. claude-opus-5-5")}</small></div><input class="inp w" name="id"></div>
			<div class="field"><div class="lbl"><b>Template</b><small>${tt("modello da cui copiare (vuoto = l'ultimo)", "model to copy from (empty = latest)")}</small></div><input class="inp w" name="template"></div>
			<div class="field"><div class="lbl"><b>${tt("Prezzo input/output", "Input/output price")}</b><small>$ / 1M token</small></div><input class="inp s" name="ci" placeholder="5"><input class="inp s" name="co" placeholder="25"></div>
			<div class="field"><div class="lbl"><b>${tt("Finestra di contesto", "Context window")}</b></div><input class="inp s" name="ctx" placeholder="200000"></div>
		</div>
		<div class="acts"><button class="btn" data-x>${t("cancel")}</button><button class="btn pri" data-ok>${t("add")}</button></div>`,
		(m, close) => {
			m.querySelector("[data-x]").onclick = close;
			m.querySelector("[data-ok]").onclick = async () => {
				const v = (n) => m.querySelector(`[name=${n}]`).value.trim();
				if (!v("id")) return;
				const cm = { provider: v("provider"), id: v("id") };
				if (v("template")) cm.template = v("template");
				if (v("ci") || v("co")) cm.cost = { input: Number(v("ci") || 0), output: Number(v("co") || 0) };
				if (v("ctx")) cm.contextWindow = Number(v("ctx"));
				S.settings.providers.customModels.push(cm);
				await saveSettings(S.settings);
				close();
				done();
			};
		},
	);
}

// OAuth login flow (events arrive over the websocket)
let oauth = null;
function startOAuth(provider, done) {
	const name = S.providers.find((p) => p.id === provider)?.name ?? provider;
	const close = modal(`<h3>${tt("Accesso a", "Sign in to")} ${esc(name)}</h3><div id="oauth-body"><div class="working">${loader(28)}<span class="shimmer">${tt("Avvio…", "Starting…")}</span></div></div><div class="acts"><button class="btn" data-x>${t("close")}</button></div>`, (m, c) => {
		m.querySelector("[data-x]").onclick = () => {
			oauth = null;
			c();
		};
	});
	oauth = { provider, done, close, loginId: null };
	api(`/providers/${provider}/oauth`, { body: {} }).then((r) => oauth && (oauth.loginId = r.loginId)).catch((e) => setOAuthBody(`<div class="notice error">${esc(e.message)}</div>`));
}
function setOAuthBody(html, append) {
	const b = document.getElementById("oauth-body");
	if (!b) return;
	if (append) b.insertAdjacentHTML("beforeend", html);
	else b.innerHTML = html;
}
export function onOAuthEvent(msg) {
	if (!oauth) return;
	if (msg.type === "oauth_auth")
		setOAuthBody(`<p>${tt("Si è aperta la pagina di accesso nel browser. Completa il login: Argon riceve il risultato da solo.", "A sign-in page opened in your browser. Complete the login: Argon receives the result automatically.")}</p>
			<p><a href="${esc(msg.url)}" target="_blank" rel="noopener" class="btn">${icon("external")} ${tt("Apri pagina di accesso", "Open sign-in page")}</a></p>${msg.instructions ? `<p style="color:var(--muted)">${esc(msg.instructions)}</p>` : ""}<div id="oauth-prompts"></div>`);
	if (msg.type === "oauth_progress") setOAuthBody(`<div style="color:var(--muted);font-size:12.5px">${esc(msg.message)}</div>`, true);
	if (msg.type === "oauth_prompt") {
		const box = document.getElementById("oauth-prompts") || document.getElementById("oauth-body");
		const opts = msg.options ? msg.options.map((o) => `<button class="btn sm" data-sel="${esc(o.id)}">${esc(o.label)}</button>`).join(" ") : "";
		const node = el(`<div class="card"><div style="margin-bottom:8px">${esc(msg.message)}</div>${opts ? `<div class="acts">${opts}</div>` : `<div class="keyrow"><input class="inp" placeholder="${esc(msg.placeholder || "")}"><button class="btn pri sm">OK</button></div>`}</div>`);
		box.appendChild(node);
		node.onclick = async (e) => {
			const sel = e.target.closest("[data-sel]");
			const okBtn = e.target.closest(".btn.pri");
			if (!sel && !okBtn) return;
			await api("/oauth/prompt", { body: { promptId: msg.promptId, value: sel ? sel.dataset.sel : node.querySelector("input").value } });
			node.remove();
		};
	}
	if (msg.type === "oauth_done") {
		const o = oauth;
		oauth = null;
		o.close();
		toast(`✓ ${tt("Collegato", "Connected")}: ${msg.provider}`);
		reloadBoot().then(() => o.done());
	}
	if (msg.type === "oauth_error") setOAuthBody(`<div class="notice error">${esc(msg.error)}</div>`, true);
}

async function github(b) {
	b.innerHTML = `<h3>GitHub</h3><p class="lead">${tt("Serve per creare pull request (/pr) e importare PR e commit delle sessioni. Senza collegamento questi comandi restano disattivati.", "Used to create pull requests (/pr) and import a session's PRs and commits. Without a connection these commands stay disabled.")}</p>${loader(36, "center")}`;
	const st = await api("/github?refresh=1").catch((e) => ({ connected: false, error: e.message, ghInstalled: false }));
	b.innerHTML = `<h3>GitHub</h3><p class="lead">${tt("Serve per creare pull request (/pr) e importare PR e commit delle sessioni. Senza collegamento questi comandi restano disattivati.", "Used to create pull requests (/pr) and import a session's PRs and commits. Without a connection these commands stay disabled.")}</p>
	<div class="group"><div class="gh-card">
		<span class="av" style="${st.avatar ? `background-image:url('${esc(st.avatar)}')` : ""}">${st.avatar ? "" : icon("code")}</span>
		<div class="grow"><b>${st.connected ? esc(st.name || st.login) : tt("Non collegato", "Not connected")}</b>
			<small>${st.connected ? `@${esc(st.login)} · ${st.method === "token" ? tt("token personale salvato da Argon", "personal token saved by Argon") : tt("tramite GitHub CLI (gh)", "via GitHub CLI (gh)")}` : st.error ? esc(st.error) : tt("Collega un token o accedi con GitHub CLI", "Connect a token or sign in with GitHub CLI")}</small></div>
		${st.connected ? `<span class="badge on">${tt("collegato", "connected")}</span>` : ""}
		${st.method === "token" ? `<button class="btn sm danger" data-disc>${t("disconnect")}</button>` : ""}
	</div></div>
	<div class="group"><div class="gh">${tt("Token di accesso personale", "Personal access token")}</div>
		<div class="field col"><div class="lbl"><small>${tt("Crea un token con i permessi <b>repo</b> e <b>workflow</b>, poi incollalo qui. Viene salvato solo sul tuo PC (~/.argon/auth.json).", "Create a token with the <b>repo</b> and <b>workflow</b> scopes and paste it here. It is stored only on your PC (~/.argon/auth.json).")} <a href="https://github.com/settings/tokens/new?scopes=repo,workflow&description=Argon" target="_blank" rel="noopener">${tt("Crea token", "Create token")} ${icon("open_in_new")}</a></small></div>
			<div class="keyrow"><input class="inp" type="password" placeholder="ghp_… / github_pat_…" data-token><button class="btn sm pri" data-save>${t("connect")}</button></div></div>
	</div>
	<div class="group"><div class="gh">GitHub CLI</div>
		<div class="field"><div class="lbl"><b>gh</b><small>${st.ghInstalled ? tt("Installata. Se hai già fatto <code>gh auth login</code>, Argon la usa automaticamente quando non c'è un token.", "Installed. If you already ran <code>gh auth login</code>, Argon uses it automatically when no token is set.") : tt("Non trovata. Serve per creare le PR: installala da cli.github.com.", "Not found. It is needed to create PRs: install it from cli.github.com.")}</small></div>${st.ghInstalled ? `<span class="badge on">OK</span>` : `<a class="btn sm" href="https://cli.github.com" target="_blank" rel="noopener">${icon("download")} ${tt("Scarica", "Download")}</a>`}</div>
	</div>`;
	b.onclick = async (e) => {
		if (e.target.closest("[data-save]")) {
			const token = $("[data-token]", b).value.trim();
			if (!token) return;
			try {
				await api("/github", { body: { token } });
				toast(tt("GitHub collegato", "GitHub connected"));
			} catch (err) {
				toast(err.message, 4000);
			}
			github(b);
		}
		if (e.target.closest("[data-disc]")) {
			await api("/github", { method: "DELETE" });
			github(b);
		}
	};
}

function models(b) {
	const opts = S.models.map((m) => [m.key, `${m.name} — ${m.key}`]);
	const def = S.settings.model.default;
	if (!opts.some(([k]) => k === def)) opts.unshift([def, def + tt(" (non disponibile)", " (unavailable)")]);
	b.innerHTML = `<h3>${tt("Modelli", "Models")}</h3><p class="lead">${tt("Modello predefinito e parametri di generazione. Ogni sessione può cambiarli dal compositore.", "Default model and generation parameters. Each session can change them from the composer.")}</p>
	<div class="group">
		${F("model.default", tt("Modello predefinito", "Default model"), "", "select", { options: opts, w: "w" })}
		${F("model.effort", tt("Ragionamento predefinito", "Default effort"), tt("Per i modelli che ragionano", "For reasoning models"), "select", { options: ["off", "minimal", "low", "medium", "high", "xhigh"].map((x) => [x, x]) })}
		${F("model.small", tt("Modello leggero", "Small model"), tt("Per titoli, riassunti e sub-agenti (vuoto = stesso modello)", "For titles, summaries and sub-agents (empty = same model)"), "select", { options: [["", "—"], ...opts] })}
		${F("model.temperature", tt("Temperatura", "Temperature"), tt("Vuoto = predefinita del provider", "Empty = provider default"), "number", { step: "0.1" })}
		${F("model.maxOutputTokens", tt("Token massimi in uscita", "Max output tokens"), tt("Vuoto = predefinito del modello", "Empty = model default"), "number")}
		${F("providers.enabled", tt("Provider mostrati", "Providers shown"), tt("Id separati da virgola; vuoto = tutti quelli collegati", "Comma-separated ids; empty = all connected"), "csv", { ph: "anthropic, openrouter" })}
	</div>`;
	bindForm(b);
}

const DAYS = () => (lang() === "it" ? ["Domenica", "Lunedì", "Martedì", "Mercoledì", "Giovedì", "Venerdì", "Sabato"] : ["Sunday", "Monday", "Tuesday", "Wednesday", "Thursday", "Friday", "Saturday"]);

function limits(b) {
	const L = S.settings.limits;
	const unit = L.unit;
	const st = S.limits;
	b.innerHTML = `<h3>${tt("Limiti di utilizzo", "Usage limits")}</h3>
	<p class="lead">${tt("Imposta un tetto all'uso, in token o in credito speso. Lo stato appare come anello accanto al modello e qui sotto.", "Cap your usage in tokens or credit spent. The status shows as a ring next to the model and below.")}</p>
	<div class="group"><div class="limit-preview">
		${limitRowHtml(t("fiveHour"), st.fiveHour, st.unit, L.enabled && L.fiveHour.enabled)}
		${limitRowHtml(t("weekly"), st.weekly, st.unit, L.enabled && L.weekly.enabled)}
	</div></div>
	<div class="group spend-card">${spendHtml(st.spend)}</div>
	<div class="group">
		${F("limits.enabled", tt("Attiva i limiti", "Enable limits"), tt("Disattivati, l'uso viene solo misurato", "When off, usage is only measured"), "bool")}
		${F("limits.unit", tt("Unità", "Unit"), tt("Token, oppure credito ($) calcolato coi prezzi dei modelli (per gli abbonamenti è il costo equivalente API)", "Tokens, or credit ($) computed from model prices (for subscriptions it's the API-equivalent cost)"), "select", { options: [["tokens", "Token"], ["cost", tt("Credito speso ($)", "Credit spent ($)")]] })}
		${F("limits.action", tt("Al raggiungimento", "When reached"), "", "select", { options: [["block", tt("Blocca nuovi turni", "Block new turns")], ["warn", tt("Avvisa soltanto", "Only warn")]] })}
		${F("limits.warnAt", tt("Soglia di avviso (%)", "Warning threshold (%)"), "", "number")}
	</div>
	<div class="group"><div class="gh">${t("fiveHour")}</div>
		${F("limits.fiveHour.enabled", tt("Attivo", "Enabled"), "", "bool")}
		${F("limits.fiveHour.value", tt("Limite", "Limit"), unit === "cost" ? tt("Dollari, es. 5", "Dollars, e.g. 5") : tt("Token, es. 2M o 500k", "Tokens, e.g. 2M or 500k"), "amount", { unit })}
		${F("limits.fiveHour.mode", tt("Finestra", "Window"), "", "select", { options: [["block", tt("Parte col primo messaggio e dura 5 ore", "Starts with the first message and lasts 5 hours")], ["rolling", tt("Ultime 5 ore (mobile)", "Rolling last 5 hours")]], w: "w" })}
	</div>
	<div class="group"><div class="gh">${t("weekly")}</div>
		${F("limits.weekly.enabled", tt("Attivo", "Enabled"), "", "bool")}
		${F("limits.weekly.value", tt("Limite", "Limit"), unit === "cost" ? tt("Dollari, es. 30", "Dollars, e.g. 30") : tt("Token, es. 20M", "Tokens, e.g. 20M"), "amount", { unit })}
		${F("limits.weekly.resetDay", tt("Giorno di reset", "Reset day"), "", "select", { options: DAYS().map((d, i) => [i, d]) })}
		${F("limits.weekly.resetHour", tt("Ora di reset", "Reset hour"), "0-23", "number")}
	</div>
	<div class="group"><div class="gh">${tt("Dettagli", "Details")}</div>
		${F("limits.providers", tt("Provider conteggiati", "Counted providers"), tt("Id separati da virgola; vuoto = tutti", "Comma-separated ids; empty = all"), "csv", { ph: "anthropic, openai" })}
		${F("limits.countCacheReads", tt("Conta i token letti dalla cache", "Count cache-read tokens"), tt("Di solito costano ~10% e gonfiano i numeri", "They usually cost ~10% and inflate counts"), "bool")}
		${F("limits.showWhenDisabled", tt("Mostra l'indicatore anche se disattivati", "Show the meter even when off"), "", "bool")}
	</div>`;
	animateCounters(b);
	// Switching unit: replace values with sensible defaults for that unit.
	b.addEventListener("change", (e) => {
		const c = e.target.closest('[data-path="limits.unit"]');
		if (!c || c.value === S.settings.limits.unit) return;
		const cost = c.value === "cost";
		S.settings.limits.fiveHour.value = cost ? 5 : 2_000_000;
		S.settings.limits.weekly.value = cost ? 50 : 20_000_000;
	});
	bindForm(b, async () => {
		S.limits = await api("/limits");
		limits(b);
	});
}

function permissions(b) {
	b.innerHTML = `<h3>${tt("Permessi", "Permissions")}</h3><p class="lead">${tt("Decidi cosa Argon può fare senza chiedere. Le regole accettano * come jolly: bash(git status*), edit, mcp__github__*.", "Decide what Argon may do without asking. Rules accept * wildcards: bash(git status*), edit, mcp__github__*.")}</p>
	<div class="group">
		${F("permissions.sandbox", tt("Sandbox degli ambienti", "Environment sandbox"), tt("In un ambiente, scrivere fuori dalla sua cartella (sottocartelle escluse) chiede sempre conferma, anche in modalità Auto", "Inside an environment, writing outside its folder (subfolders excluded) always asks, even in Auto mode"), "bool")}
		${F("permissions.mode", tt("Modalità predefinita", "Default mode"), "", "select", { options: S.boot.modes.map((m) => [m.id, lang() === "it" ? `${m.labelIt} — ${m.descIt}` : `${m.label} — ${m.desc}`]), w: "w" })}
		${F("permissions.allow", tt("Consenti sempre", "Always allow"), tt("Una regola per riga", "One rule per line"), "lines", { rows: 6 })}
		${F("permissions.deny", tt("Nega sempre", "Always deny"), tt("Vale anche in modalità Auto", "Applies in Auto mode too"), "lines", { rows: 4, ph: "bash(rm -rf*)\nbash(git push*)" })}
	</div>`;
	bindForm(b);
}

function tools(b) {
	const names = ["read", "write", "edit", "bash", "ls", "glob", "grep", "web_fetch", "web_search", "todo", "memory", "skill", "task", "ask_user"];
	const dis = new Set(S.settings.tools.disabled);
	b.innerHTML = `<h3>${tt("Strumenti", "Tools")}</h3><p class="lead">${tt("Strumenti integrati disponibili all'agente.", "Built-in tools available to the agent.")}</p>
	<div class="group">${names.map((n) => `<div class="field"><div class="lbl"><b>${n}</b></div><label class="toggle"><input type="checkbox" data-tool="${n}" ${dis.has(n) ? "" : "checked"}><i></i></label></div>`).join("")}</div>
	<div class="group">
		${F("tools.bashTimeoutMs", tt("Timeout comandi (ms)", "Command timeout (ms)"), "", "number")}
		${F("tools.maxOutputChars", tt("Output massimo (caratteri)", "Max output (characters)"), "", "number")}
		${F("tools.checkpoints", tt("Checkpoint dei file", "File checkpoints"), tt("Permette di annullare le modifiche di un turno", "Lets you undo a turn's file changes"), "bool")}
		${F("tools.webSearch.provider", tt("Motore di ricerca", "Search engine"), tt("DuckDuckGo non richiede chiavi", "DuckDuckGo needs no key"), "select", { options: [["duckduckgo", "DuckDuckGo"], ["brave", "Brave Search"], ["tavily", "Tavily"]] })}
		${F("tools.webSearch.apiKey", tt("Chiave del motore", "Search API key"), "", "password")}
	</div>`;
	bindForm(b);
	b.addEventListener("change", (e) => {
		const c = e.target.closest("[data-tool]");
		if (!c) return;
		const set = new Set(S.settings.tools.disabled);
		c.checked ? set.delete(c.dataset.tool) : set.add(c.dataset.tool);
		S.settings.tools.disabled = [...set];
		saveSettings(S.settings);
	});
}

async function context(b) {
	const g = await api("/instructions");
	b.innerHTML = `<h3>${tt("Contesto", "Context")}</h3><p class="lead">${tt("Cosa entra nel prompt di sistema e quando compattare.", "What goes into the system prompt and when to compact.")}</p>
	<div class="group">
		${F("context.autoCompactAt", tt("Compatta automaticamente al (%)", "Auto-compact at (%)"), tt("0 = mai", "0 = never"), "number")}
		${F("context.instructionFiles", tt("File di istruzioni del progetto", "Project instruction files"), tt("Letti dalla radice git alla cartella", "Read from the git root down to the folder"), "csv")}
		${F("context.initFile", tt("File creato da /init", "File created by /init"), tt("Nome del file di istruzioni che /init crea e che viene sempre letto (es. ARGON.md, AGENTS.md)", "Name of the instructions file /init creates and that is always read (e.g. ARGON.md, AGENTS.md)"))}
		${F("context.readClaudeCompat", tt("Compatibilità Claude Code", "Claude Code compatibility"), tt("Legge anche CLAUDE.md, .claude/skills e .claude/commands", "Also reads CLAUDE.md, .claude/skills and .claude/commands"), "bool")}
		${F("context.systemPromptAppend", tt("Aggiunta al prompt di sistema", "System prompt addition"), "", "textarea", { rows: 4 })}
	</div>
	<div class="group"><div class="gh">${tt("Istruzioni globali", "Global instructions")} <span style="color:var(--muted);font-weight:400;font-size:12px">${esc(g.path)}</span></div>
		<div class="field col"><textarea class="inp full" rows="10" id="global-md" placeholder="${tt("Es. Rispondi in italiano. Preferisco TypeScript. Usa pnpm.", "E.g. Prefer TypeScript. Use pnpm.")}">${esc(g.content)}</textarea>
		<div><button class="btn sm pri" id="save-md">${t("save")}</button></div></div>
	</div>`;
	bindForm(b);
	$("#save-md", b).onclick = async () => {
		await api("/instructions", { body: { path: g.path, content: $("#global-md", b).value } });
		toast(t("saved"));
	};
}

function environments(b) {
	const opts = [["", tt("predefinito", "default")], ...S.models.map((m) => [m.key, m.name])];
	const count = (id) => S.sessions.filter((s) => s.envId === id).length;
	b.innerHTML = `<h3>${tt("Ambienti", "Environments")}</h3><p class="lead">${tt("Un ambiente è una cartella di lavoro con le sue sessioni e preferenze. L'ambiente corrente è quello mostrato nella barra laterale e usato dalle nuove sessioni. Eliminarlo non tocca la cartella sul disco.", "An environment is a working folder with its own sessions and preferences. The current one is shown in the sidebar and used by new sessions. Deleting it never touches the folder on disk.")}</p>
	<div class="env-cards stagger">${S.environments
		.map(
			(e) => `
		<div class="env-item ${S.envId === e.id ? "cur" : ""}" data-env="${e.id}">
			<div class="ei-top"><span class="env-ico">${icon(S.envId === e.id ? "folder_open" : "folder")}</span>
				<div class="grow"><b>${esc(e.name)}</b>${S.envId === e.id ? ` <span class="badge on">${tt("corrente", "current")}</span>` : ""}<small>${esc(e.cwd)}</small></div>
				<span class="badge">${count(e.id)} ${tt("sessioni", "sessions")}</span></div>
			<div class="ei-opts">
				<label>${tt("Modello", "Model")}<select class="inp" data-f="model">${opts.map(([k, l]) => `<option value="${esc(k)}" ${(e.model || "") === k ? "selected" : ""}>${esc(l)}</option>`).join("")}</select></label>
				<label>${tt("Permessi", "Permissions")}<select class="inp" data-f="permissionMode"><option value="">${tt("predefiniti", "default")}</option>${S.boot.modes.map((m) => `<option value="${m.id}" ${e.permissionMode === m.id ? "selected" : ""}>${lang() === "it" ? m.labelIt : m.label}</option>`).join("")}</select></label>
			</div>
			<div class="ei-acts">
				${S.envId === e.id ? "" : `<button class="btn sm tonal" data-use>${icon("check_circle")} ${tt("Usa", "Use")}</button>`}
				<button class="btn sm" data-ren>${icon("edit")} ${t("rename")}</button>
				<span class="spacer"></span>
				<button class="btn sm danger" data-del>${icon("delete")} ${tt("Elimina", "Delete")}</button>
			</div>
		</div>`,
		)
		.join("")}
		<button class="env-item add" data-add>${icon("create_new_folder")}<b>${t("addEnv")}</b></button>
	</div>`;
	b.onchange = async (e) => {
		const s = e.target.closest("[data-f]");
		if (!s) return;
		const id = s.closest("[data-env]").dataset.env;
		await api(`/environments/${id}`, { method: "PATCH", body: { [s.dataset.f]: s.value || undefined } });
		S.environments = await api("/environments");
		toast(t("saved"));
	};
	b.onclick = async (e) => {
		const row = e.target.closest("[data-env]");
		const env = row && S.environments.find((x) => x.id === row.dataset.env);
		if (e.target.closest("[data-add]"))
			return openFolderModal(async (created) => {
				S.environments = await api("/environments");
				setEnv(created.id);
				environments(b);
			});
		if (!env) return;
		if (e.target.closest("[data-use]")) {
			setEnv(env.id);
			return environments(b);
		}
		if (e.target.closest("[data-ren]")) {
			await renameEnv(env);
			return environments(b);
		}
		if (e.target.closest("[data-del]")) confirmDeleteEnv(env, () => environments(b));
	};
}

function cli(b) {
	b.innerHTML = `<h3>Argon CLI</h3><p class="lead">${tt("Le impostazioni del comando <code>argon</code> nel terminale sono indipendenti dalla GUI (le trovi anche con /settings nella CLI). Chat, skill, MCP, modello e modalità restano condivisi; i limiti di utilizzo sono gli stessi.", "Settings of the <code>argon</code> terminal command are independent from the GUI (also available with /settings in the CLI). Chats, skills, MCP, model and mode stay shared; usage limits are the same.")}</p>
	<div class="group"><div class="gh">${tt("Aspetto", "Look")}</div>
		${F("cli.language", tt("Lingua", "Language"), "", "select", { options: [["it", "Italiano"], ["en", "English"]] })}
		${F("cli.accent", tt("Colore", "Accent color"), "", "select", { options: [["violet", "Violet (argon)"], ["cyan", "Cyan"], ["green", "Green"], ["amber", "Amber"], ["rose", "Rose"]] })}
		${F("cli.showBanner", tt("Logo all'avvio", "Startup logo"), "", "bool")}
		${F("cli.animations", tt("Animazioni", "Animations"), tt("Animazione di apertura e indicatori animati", "Opening animation and animated indicators"), "bool")}
		${F("cli.timestamps", tt("Orari dei messaggi", "Message timestamps"), "", "bool")}
		${F("cli.showThinking", tt("Mostra il ragionamento", "Show thinking"), "", "bool")}
		${F("cli.statusBar", tt("Barra di stato (limiti, contesto, costo)", "Status bar (limits, context, cost)"), "", "bool")}
	</div>
	<div class="group"><div class="gh">${tt("Comportamento", "Behaviour")}</div>
		${F("cli.sessionScope", tt("Sessioni mostrate", "Sessions shown"), tt("/resume e /sessions mostrano le sessioni dell'ambiente (cartella) in cui ti trovi, oppure tutte", "/resume and /sessions show the sessions of the environment (folder) you are in, or all of them"), "select", { options: [["environment", tt("Ambiente corrente", "Current environment")], ["all", tt("Tutte", "All")]] })}
		${F("cli.notifyLimits", tt("Avvisi sui limiti", "Limit alerts"), tt("Avviso e campanella del terminale quando ti avvicini o arrivi a un limite (soglia dai Limiti di utilizzo)", "Notice and terminal bell when you approach or reach a limit (threshold from Usage limits)"), "bool")}
	</div>`;
	bindForm(b);
}

// ───────────────────────── AI agent control (Argon as an MCP server) ─────────────────────────
const CONTROL_GROUPS = () => [
	["settings", tt("Aspetto e impostazioni", "Look and settings"), tt("Colori, tema, dimensione, modelli, ambienti, limiti; mostrare pagine nell'app", "Colours, theme, size, models, environments, limits; showing pages in the app")],
	["agents", tt("Sub-agenti, skill, comandi e memoria", "Sub-agents, skills, commands and memory"), tt("Crearli, modificarli ed eliminarli", "Create, change and delete them")],
	["connectors", tt("Connettori MCP", "MCP connectors"), tt("Aggiungere, rimuovere, accendere e spegnere server MCP. Un server locale esegue un comando sul tuo computer.", "Add, remove, turn MCP servers on and off. A local server runs a command on your computer.")],
	["sessions", tt("Sessioni", "Sessions"), tt("Leggere, avviare, scrivere e fermare sessioni; domande a parte (/btw)", "Read, start, message and stop sessions; side questions (/btw)")],
	["security", tt("Permessi e hook", "Permissions and hooks"), tt("Modalità permessi, regole allow/deny, hook e strumenti. Lascialo spento se non ti serve.", "Permission mode, allow/deny rules, hooks and tools. Leave it off unless you need it.")],
];

const shq = (x) => (/[\s"]/.test(x) ? `"${x.replace(/"/g, '\\"')}"` : x);

/** Snippets to connect an MCP client to Argon. */
function controlSnippets(info) {
	const { command, args } = info.stdio;
	const http = info.http?.url;
	const out = {
		claude: `claude mcp add argon -- ${[command, ...args].map(shq).join(" ")}`,
		json: JSON.stringify({ mcpServers: { argon: { command, args } } }, null, 2),
		codex: `[mcp_servers.argon]\ncommand = ${JSON.stringify(command)}\nargs = ${JSON.stringify(args)}`,
	};
	if (http) {
		out.claude += `\n\n# ${tt("oppure via HTTP", "or over HTTP")}\nclaude mcp add --transport http argon ${http} --header "Authorization: Bearer ${info.token}"`;
		out.http = `URL: ${http}\nHeader: Authorization: Bearer ${info.token}`;
	}
	return out;
}

async function control(b) {
	const ac = S.settings.agentControl;
	const info = S.controlInfo;
	const on = ac.enabled;
	const snip = S.controlSnip ?? "claude";
	const snips = info ? controlSnippets(info) : null;
	const tabsDef = [["claude", "Claude Code"], ["json", tt("JSON (Claude Desktop, Cursor…)", "JSON (Claude Desktop, Cursor…)")], ["codex", "Codex"], ...(snips?.http ? [["http", "HTTP"]] : [])];
	const cur = snips?.[snip] ? snip : "claude";
	const groupsOn = Object.fromEntries(CONTROL_GROUPS().map(([g]) => [g, !!ac.allow?.[g]]));
	b.innerHTML = `<h3>${tt("Controllo da agenti AI", "AI agent control")}</h3>
	<p class="lead">${tt("Lascia che altri agenti AI (Claude Code, Claude Desktop, Cursor, Codex…) e l'agente di Argon stesso usino Argon tramite il suo server MCP: cambiare l'aspetto, creare sub-agenti, collegare connettori, avviare sessioni e altro. Le modifiche si vedono subito nell'app.", "Let other AI agents (Claude Code, Claude Desktop, Cursor, Codex…) and Argon's own agent use Argon through its MCP server: change the look, create sub-agents, connect connectors, start sessions and more. Changes show up in the app right away.")}</p>
	<div class="group">
		${F("agentControl.enabled", tt("Permetti il controllo da agenti AI", "Allow AI agents to control Argon"), tt("Spento di default: finché è spento nessun agente può usare questi strumenti.", "Off by default: while it's off no agent can use these tools."), "bool")}
		${F("agentControl.builtin", tt("Connettore integrato «Argon»", "Built-in “Argon” connector"), tt("Anche l'agente di Argon riceve questi strumenti (Personalizza → Connettori). Nelle sessioni in modalità Chiedi ogni azione chiede conferma.", "Argon's own agent gets these tools too (Customize → Connectors). In Ask mode every action asks for confirmation."), "bool")}
	</div>
	<div class="group ${on ? "" : "dim-group"}"><div class="gh">${tt("Cosa possono fare", "What they can do")}</div>
		${CONTROL_GROUPS().map(([g, l, h]) => F(`agentControl.allow.${g}`, l, h, "bool")).join("")}
	</div>
	<div class="group ${on ? "" : "dim-group"}"><div class="gh">${tt("Collega un agente", "Connect an agent")}</div>
		${
			!snips
				? `<div class="field"><span class="dim">${loader(20, "sm")}</span></div>`
				: `<div class="field col"><div class="lbl"><b>${tt("Configurazione", "Configuration")}</b><small>${tt("Aggiungi Argon come server MCP nel tuo client. Usa l'app aperta se c'è, altrimenti avvia Argon in background.", "Add Argon as an MCP server in your client. It uses the open app if there is one, otherwise it starts Argon in the background.")}</small></div>
			<div class="tabs" data-snip-tabs>${tabsDef.map(([id, l]) => `<button class="${id === cur ? "on" : ""}" data-snip="${id}">${l}</button>`).join("")}</div>
			<div class="snip"><pre>${esc(snips[cur])}</pre><button class="icon-btn" data-copy title="${tt("Copia", "Copy")}">${icon("content_copy")}</button></div></div>`
		}
		${F("agentControl.port", tt("Porta HTTP fissa", "Fixed HTTP port"), tt("Facoltativa, per i client che si collegano via URL (es. 47823). 0 = solo il comando qui sopra.", "Optional, for clients that connect by URL (e.g. 47823). 0 = only the command above."), "number")}
		${
			info && ac.port > 0
				? `<div class="field"><div class="lbl"><b>${tt("Stato HTTP", "HTTP status")}</b><small>${
						!on ? tt("Spento", "Off") : !info.http.managed ? tt("La porta fissa la apre l'app desktop", "The desktop app opens the fixed port") : info.http.error ? esc(info.http.error) : info.http.listening ? tt(`In ascolto su ${esc(info.http.url)}`, `Listening on ${esc(info.http.url)}`) : tt("Avvio…", "Starting…")
					}</small></div><button class="btn sm" data-regen>${icon("refresh")} ${tt("Nuovo token", "New token")}</button></div>`
				: ""
		}
	</div>
	<div class="group"><div class="gh">${tt("Strumenti", "Tools")} <span class="dim">${info ? info.tools.filter((x) => groupsOn[x.group]).length + "/" + info.tools.length : ""}</span></div>
		${
			info
				? CONTROL_GROUPS()
						.map(([g, l]) => {
							const list = info.tools.filter((x) => x.group === g);
							return `<div class="tool-grp ${groupsOn[g] ? "" : "off"}"><div class="tg-h">${esc(l)}</div>${list.map((x) => `<div class="tg-row" title="${esc(x.description)}"><code>${esc(x.name)}</code><span>${esc(lang() === "it" ? x.titleIt : x.title)}</span>${x.readOnly ? `<span class="badge">${tt("lettura", "read")}</span>` : ""}</div>`).join("")}</div>`;
						})
						.join("")
				: ""
		}
	</div>`;
	bindForm(b, async () => {
		S.controlInfo = await api("/agent-control").catch(() => S.controlInfo);
		if (b.isConnected) control(b);
	});
	b.onclick = async (e) => {
		const t2 = e.target.closest("[data-snip]");
		if (t2) {
			S.controlSnip = t2.dataset.snip;
			for (const x of b.querySelectorAll("[data-snip]")) x.classList.toggle("on", x === t2);
			$(".snip pre", b).textContent = snips[t2.dataset.snip];
			return;
		}
		if (e.target.closest("[data-copy]")) {
			await navigator.clipboard.writeText($(".snip pre", b).textContent).catch(() => {});
			return toast(tt("Copiato", "Copied"));
		}
		if (e.target.closest("[data-regen]")) {
			S.controlInfo = await api("/agent-control", { body: { regenerate: true } });
			toast(tt("Nuovo token: aggiorna i client collegati via HTTP", "New token: update the clients connected over HTTP"), 4000);
			control(b);
		}
	};
	if (!info) {
		S.controlInfo = await api("/agent-control").catch(() => null);
		if (S.controlInfo && b.isConnected) control(b);
	}
}

function advanced(b) {
	b.innerHTML = `<h3>${tt("Avanzate", "Advanced")}</h3><p class="lead">${tt("Tutte le impostazioni in JSON (~/.argon/settings.json).", "All settings as JSON (~/.argon/settings.json).")}</p>
	<div class="group"><div class="field col"><textarea class="inp full" rows="28" id="json">${esc(JSON.stringify(S.settings, null, 2))}</textarea>
	<div style="display:flex;gap:8px"><button class="btn pri sm" id="save-json">${t("save")}</button><button class="btn sm danger" id="reset">${tt("Ripristina predefiniti", "Reset to defaults")}</button></div></div></div>`;
	$("#save-json", b).onclick = async () => {
		try {
			await saveSettings(JSON.parse($("#json", b).value));
		} catch (e) {
			toast(e.message, 4000);
		}
	};
	$("#reset", b).onclick = async () => {
		if (!confirm(tt("Ripristinare tutte le impostazioni? Ambienti e server MCP saranno mantenuti.", "Reset all settings? Environments and MCP servers are kept."))) return;
		const d = structuredClone(S.boot.defaults);
		d.environments = S.settings.environments;
		d.mcp = S.settings.mcp;
		await saveSettings(d);
		advanced(b);
	};
}

// ───────────────────────── customize ─────────────────────────
export function renderCustomize(view, tab) {
	const tabs = [
		["connectors", "plug", tt("Connettori (MCP)", "Connectors (MCP)")],
		["agents", "smart_toy", tt("Sub-agenti", "Sub-agents")],
		["skills", "spark", "Skill"],
		["commands", "terminal", tt("Comandi", "Commands")],
		["memory", "brain", tt("Memoria", "Memory")],
		["hooks", "hook", "Hook"],
	];
	const body = pageShell(view, t("customize"), tabs, tab, "/customize");
	// (pick the section first: `section?.(body) ?? connectors(body)` also ran Connectors after any
	// section that returns undefined, e.g. Hook, overwriting it)
	const section = { connectors, agents: agentsPage, skills, commands, memory, hooks }[tab] ?? connectors;
	section(body);
}

const MCP_PRESETS = [
	{ name: "filesystem", desc: () => tt("File di una cartella", "Files in a folder"), cfg: () => ({ command: "npx", args: ["-y", "@modelcontextprotocol/server-filesystem", S.boot.home] }) },
	{ name: "playwright", desc: () => tt("Controllo del browser", "Browser automation"), cfg: () => ({ command: "npx", args: ["-y", "@playwright/mcp@latest"] }) },
	{ name: "context7", desc: () => tt("Documentazione aggiornata delle librerie", "Up-to-date library docs"), cfg: () => ({ command: "npx", args: ["-y", "@upstash/context7-mcp"] }) },
	{ name: "github", desc: () => "GitHub (token in env)", cfg: () => ({ url: "https://api.githubcopilot.com/mcp/", headers: { Authorization: "Bearer <GITHUB_TOKEN>" } }) },
];

async function connectors(b) {
	// Render at once with the live state (bootstrap + WebSocket updates), then refresh it.
	const st = S.mcp ?? (await api("/mcp"));
	if (S.mcp)
		api("/mcp")
			.then((fresh) => {
				if (b.isConnected && JSON.stringify(fresh) !== JSON.stringify(st)) {
					S.mcp = fresh;
					connectors(b);
				}
			})
			.catch(() => {});
	const servers = S.settings.mcp.servers;
	const builtin = st.find((m) => m.builtin);
	const ac = S.settings.agentControl;
	const builtinRow = builtin
		? `<div class="list-item" data-builtin>${icon("smart_toy")}
			<div class="grow"><b>Argon</b> <span class="badge">${tt("integrato", "built-in")}</span> <span class="badge ${builtin.status === "connected" ? "on" : ""}">${builtin.status === "connected" ? builtin.tools.length + " tools" : tt("spento", "off")}</span>
			<small>${tt("Strumenti per usare Argon stesso: aspetto, sub-agenti, connettori, sessioni…", "Tools to operate Argon itself: look, sub-agents, connectors, sessions…")}${ac.enabled ? "" : " · " + tt("attiva il controllo da agenti AI nelle impostazioni", "turn on AI agent control in settings")}</small>
			${builtin.tools.length ? `<details><summary style="cursor:pointer;color:var(--muted);font-size:12px">${tt("strumenti", "tools")}</summary><div style="font-size:12px;color:var(--text-2);margin-top:4px">${builtin.tools.map((x) => `<div><b>${esc(x.name)}</b> <span style="color:var(--muted)">${esc(x.description)}</span></div>`).join("")}</div></details>` : ""}</div>
			<label class="toggle"><input type="checkbox" data-builtin-en ${builtin.status === "connected" ? "checked" : ""}><i></i></label>
			<button class="btn sm" data-go-control title="${tt("Impostazioni", "Settings")}">${icon("settings")}</button></div>`
		: "";
	b.innerHTML = `<h3>${tt("Connettori (MCP)", "Connectors (MCP)")}</h3><p class="lead">${tt("Collega server Model Context Protocol: i loro strumenti diventano strumenti di Argon (mcp__server__tool).", "Connect Model Context Protocol servers: their tools become Argon tools (mcp__server__tool).")}</p>
	<div class="group">${builtinRow}${st.filter((m) => !m.builtin).map((m) => `
		<div class="list-item" data-mcp="${esc(m.name)}">${icon("plug")}
			<div class="grow"><b>${esc(m.name)}</b> <span class="badge ${m.status === "connected" ? "on" : m.status === "error" ? "err" : ""}">${m.status === "connected" ? m.tools.length + " tools" : esc(m.status)}</span>
			<small>${esc(servers[m.name]?.url ?? [servers[m.name]?.command, ...(servers[m.name]?.args ?? [])].join(" "))}${m.error ? ` · ${esc(m.error)}` : ""}</small>
			${m.tools.length ? `<details><summary style="cursor:pointer;color:var(--muted);font-size:12px">${tt("strumenti", "tools")}</summary><div style="font-size:12px;color:var(--text-2);margin-top:4px">${m.tools.map((x) => `<div><b>${esc(x.name)}</b> <span style="color:var(--muted)">${esc(x.description.slice(0, 120))}</span></div>`).join("")}</div></details>` : ""}</div>
			<label class="toggle"><input type="checkbox" data-en ${m.status !== "disabled" ? "checked" : ""}><i></i></label>
			<button class="btn sm" data-re title="${tt("Riconnetti", "Reconnect")}">${icon("refresh")}</button>
			<button class="btn sm" data-ed>${icon("edit")}</button>
			<button class="btn sm danger" data-rm>${icon("trash")}</button></div>`).join("") || (builtin ? "" : `<div class="empty">${tt("Nessun connettore.", "No connectors.")}</div>`)}
		<div class="list-item"><button class="btn sm pri" data-add>${icon("plus")} ${tt("Aggiungi connettore", "Add connector")}</button></div></div>
	<div class="group"><div class="gh">${tt("Suggeriti", "Suggested")}</div>${MCP_PRESETS.map((p, i) => `<div class="list-item">${icon("spark")}<div class="grow"><b>${p.name}</b><small>${esc(p.desc())}</small></div><button class="btn sm" data-preset="${i}" ${servers[p.name] ? "disabled" : ""}>${servers[p.name] ? "✓" : t("add")}</button></div>`).join("")}</div>`;
	b.onclick = async (e) => {
		if (e.target.closest("[data-go-control]")) return go("/settings/control");
		const row = e.target.closest("[data-mcp]");
		const name = row?.dataset.mcp;
		if (row && e.target.closest("[data-rm]")) {
			delete S.settings.mcp.servers[name];
			await saveSettings(S.settings);
			setTimeout(() => connectors(b), 300);
		}
		if (row && e.target.closest("[data-re]")) {
			toast(tt("Riconnessione…", "Reconnecting…"));
			await api(`/mcp/reconnect/${encodeURIComponent(name)}`, { body: {} });
			connectors(b);
		}
		if (row && e.target.closest("[data-ed]")) mcpModal(name, () => setTimeout(() => connectors(b), 1500));
		if (e.target.closest("[data-add]")) mcpModal(null, () => setTimeout(() => connectors(b), 1500));
		const pr = e.target.closest("[data-preset]");
		if (pr) {
			const p = MCP_PRESETS[Number(pr.dataset.preset)];
			S.settings.mcp.servers[p.name] = { ...p.cfg(), enabled: true };
			await saveSettings(S.settings);
			toast(tt("Connessione in corso…", "Connecting…"));
			setTimeout(() => connectors(b), 2500);
		}
	};
	b.onchange = async (e) => {
		const be = e.target.closest("[data-builtin-en]");
		if (be) {
			// The master switch lives in settings: turning the connector on there is the user's choice.
			if (!S.settings.agentControl.enabled) {
				be.checked = false;
				toast(tt("Prima attiva il controllo da agenti AI", "Turn on AI agent control first"), 3500);
				return go("/settings/control");
			}
			S.settings.agentControl.builtin = be.checked;
			await saveSettings(S.settings);
			return setTimeout(() => connectors(b), 600);
		}
		const en = e.target.closest("[data-en]");
		if (!en) return;
		const name = en.closest("[data-mcp]").dataset.mcp;
		S.settings.mcp.servers[name].enabled = en.checked;
		await saveSettings(S.settings);
		setTimeout(() => connectors(b), 1000);
	};
}

function mcpModal(name, done) {
	const c = name ? S.settings.mcp.servers[name] : { command: "", args: [] };
	const type = c.url ? (c.type === "sse" ? "sse" : "http") : "stdio";
	modal(
		`<h3>${name ? esc(name) : tt("Nuovo connettore", "New connector")}</h3>
		<div class="group">
			<div class="field"><div class="lbl"><b>${t("name")}</b></div><input class="inp w" name="name" value="${esc(name ?? "")}" ${name ? "disabled" : ""}></div>
			<div class="field"><div class="lbl"><b>${tt("Tipo", "Type")}</b></div><select class="inp w" name="type"><option value="stdio" ${type === "stdio" ? "selected" : ""}>stdio (${tt("comando locale", "local command")})</option><option value="http" ${type === "http" ? "selected" : ""}>HTTP (streamable)</option><option value="sse" ${type === "sse" ? "selected" : ""}>SSE</option></select></div>
			<div class="field" data-for="stdio"><div class="lbl"><b>${tt("Comando", "Command")}</b></div><input class="inp w" name="command" value="${esc(c.command ?? "")}" placeholder="npx"></div>
			<div class="field col" data-for="stdio"><div class="lbl"><b>${tt("Argomenti", "Arguments")}</b><small>${tt("uno per riga", "one per line")}</small></div><textarea class="inp full" rows="3" name="args">${esc((c.args ?? []).join("\n"))}</textarea></div>
			<div class="field col" data-for="stdio"><div class="lbl"><b>${tt("Variabili d'ambiente", "Environment variables")}</b><small>KEY=value</small></div><textarea class="inp full" rows="2" name="env">${esc(Object.entries(c.env ?? {}).map(([k, v]) => `${k}=${v}`).join("\n"))}</textarea></div>
			<div class="field" data-for="url"><div class="lbl"><b>URL</b></div><input class="inp w" name="url" value="${esc(c.url ?? "")}" placeholder="https://…/mcp"></div>
			<div class="field col" data-for="url"><div class="lbl"><b>Headers</b><small>Name: value</small></div><textarea class="inp full" rows="2" name="headers">${esc(Object.entries(c.headers ?? {}).map(([k, v]) => `${k}: ${v}`).join("\n"))}</textarea></div>
		</div>
		<div class="acts"><button class="btn" data-x>${t("cancel")}</button><button class="btn pri" data-ok>${t("save")}</button></div>`,
		(m, close) => {
			const v = (n) => m.querySelector(`[name=${n}]`);
			const sync = () => $$("[data-for]", m).forEach((f) => (f.style.display = (f.dataset.for === "stdio") === (v("type").value === "stdio") ? "" : "none"));
			v("type").onchange = sync;
			sync();
			m.querySelector("[data-x]").onclick = close;
			m.querySelector("[data-ok]").onclick = async () => {
				const n = (name ?? v("name").value).trim().replace(/\s+/g, "-");
				if (!n) return;
				const kv = (s, sep) => Object.fromEntries(s.split("\n").map((l) => l.trim()).filter(Boolean).map((l) => { const i = l.indexOf(sep); return [l.slice(0, i).trim(), l.slice(i + 1).trim()]; }));
				S.settings.mcp.servers[n] =
					v("type").value === "stdio"
						? { type: "stdio", command: v("command").value.trim(), args: v("args").value.split("\n").map((s) => s.trim()).filter(Boolean), env: kv(v("env").value, "="), enabled: true }
						: { type: v("type").value, url: v("url").value.trim(), headers: kv(v("headers").value, ":"), enabled: true };
				await saveSettings(S.settings);
				toast(tt("Connessione in corso…", "Connecting…"));
				close();
				done();
			};
		},
	);
}

async function skills(b) {
	const cwd = (S.environments.find((e) => e.id === S.envId)?.cwd ?? S.boot.cwd);
	const list = await api(`/skills?cwd=${encodeURIComponent(cwd)}`);
	b.innerHTML = `<h3>Skill</h3><p class="lead">${tt("Pacchetti di istruzioni che l'agente carica quando servono (formato SKILL.md, compatibile con Claude). Si invocano anche con /nome.", "Instruction packages the agent loads when needed (SKILL.md format, Claude-compatible). Also invokable as /name.")}</p>
	<div class="group">${F("skills.enabled", tt("Skill attive", "Skills enabled"), "", "bool")}</div>
	<div class="group">${list.map((k) => `<div class="list-item" data-skill="${esc(k.name)}">${icon("spark")}<div class="grow"><b>/${esc(k.name)}</b> <span class="badge">${esc(k.source)}</span><small title="${esc(k.dir)}">${esc(k.description)}</small></div><label class="toggle"><input type="checkbox" data-sk ${k.enabled ? "checked" : ""}><i></i></label></div>`).join("") || `<div class="empty">${tt("Nessuna skill trovata in ~/.argon/skills, .argon/skills o .claude/skills.", "No skills found in ~/.argon/skills, .argon/skills or .claude/skills.")}</div>`}
	<div class="list-item"><button class="btn sm pri" data-new>${icon("plus")} ${tt("Nuova skill", "New skill")}</button></div></div>
	<div class="group">${F("skills.extraDirs", tt("Cartelle extra", "Extra folders"), tt("Una per riga", "One per line"), "lines", { rows: 2 })}</div>`;
	bindForm(b);
	b.onchange = async (e) => {
		const c = e.target.closest("[data-sk]");
		if (!c) return;
		const n = c.closest("[data-skill]").dataset.skill;
		const set = new Set(S.settings.skills.disabled);
		c.checked ? set.delete(n) : set.add(n);
		S.settings.skills.disabled = [...set];
		await saveSettings(S.settings);
	};
	b.onclick = (e) => {
		if (e.target.closest("[data-new]")) newFileModal("skill", () => skills(b));
	};
}

async function commands(b) {
	const cwd = (S.environments.find((e) => e.id === S.envId)?.cwd ?? S.boot.cwd);
	const list = await api(`/commands?cwd=${encodeURIComponent(cwd)}`);
	b.innerHTML = `<h3>${tt("Comandi personalizzati", "Custom commands")}</h3><p class="lead">${tt("Prompt riutilizzabili: /nome argomenti. Nel testo usa $ARGUMENTS, $1, $2.", "Reusable prompts: /name arguments. Use $ARGUMENTS, $1, $2 in the text.")}</p>
	<div class="group">${list.map((c) => `<div class="list-item">${icon("terminal")}<div class="grow"><b>/${esc(c.name)}</b> <span class="badge">${esc(c.source)}</span><small>${esc(c.description)}</small></div></div>`).join("") || `<div class="empty">${tt("Nessun comando.", "No commands.")}</div>`}
	<div class="list-item"><button class="btn sm pri" data-new>${icon("plus")} ${tt("Nuovo comando", "New command")}</button></div></div>`;
	b.onclick = (e) => {
		if (e.target.closest("[data-new]")) newFileModal("command", () => commands(b));
	};
}

function newFileModal(kind, done) {
	modal(
		`<h3>${kind === "skill" ? tt("Nuova skill", "New skill") : tt("Nuovo comando", "New command")}</h3>
		<div class="group">
			<div class="field"><div class="lbl"><b>${t("name")}</b><small>${tt("minuscole e trattini", "lowercase and dashes")}</small></div><input class="inp w" name="name"></div>
			<div class="field"><div class="lbl"><b>${tt("Descrizione", "Description")}</b><small>${kind === "skill" ? tt("Quando usarla: l'agente decide da qui", "When to use it: the agent decides from this") : ""}</small></div><input class="inp w" name="description"></div>
			<div class="field col"><div class="lbl"><b>${tt("Istruzioni", "Instructions")}</b></div><textarea class="inp full" rows="10" name="body" placeholder="${kind === "command" ? "Review $ARGUMENTS…" : "# …"}"></textarea></div>
		</div>
		<div class="acts"><button class="btn" data-x>${t("cancel")}</button><button class="btn pri" data-ok>${t("save")}</button></div>`,
		(m, close) => {
			m.querySelector("[data-x]").onclick = close;
			m.querySelector("[data-ok]").onclick = async () => {
				const v = (n) => m.querySelector(`[name=${n}]`).value;
				try {
					await api(kind === "skill" ? "/skills" : "/commands", { body: { name: v("name"), description: v("description"), body: v("body") } });
					close();
					done();
				} catch (e) {
					toast(e.message);
				}
			};
		},
	);
}

async function memory(b) {
	const list = await api("/memory");
	b.innerHTML = `<h3>${tt("Memoria", "Memory")}</h3><p class="lead">${tt("Fatti che Argon ricorda tra le sessioni. L'agente li gestisce con lo strumento memory; puoi anche aggiungerli tu.", "Facts Argon remembers across sessions. The agent manages them with the memory tool; you can add them too.")}</p>
	<div class="group">${list.map((m) => `<div class="list-item">${icon("brain")}<div class="grow">${esc(m.content)}<small>${m.scope === "global" ? tt("globale", "global") : esc(m.project)} · ${relTime(m.createdAt, lang())}</small></div><button class="btn sm danger" data-rm="${m.id}">${icon("trash")}</button></div>`).join("") || `<div class="empty">${tt("Nessun ricordo.", "No memories.")}</div>`}
	<div class="list-item"><input class="inp" style="flex:1" id="mem-new" placeholder="${tt("Es. Preferisco risposte brevi", "E.g. I prefer short answers")}"><select class="inp" id="mem-scope"><option value="global">${tt("globale", "global")}</option>${S.environments.map((e) => `<option value="${esc(e.cwd)}">${esc(e.name)}</option>`).join("")}</select><button class="btn sm pri" data-add>${t("add")}</button></div></div>`;
	b.onclick = async (e) => {
		const rm = e.target.closest("[data-rm]");
		if (rm) {
			await api(`/memory/${rm.dataset.rm}`, { method: "DELETE" });
			memory(b);
		}
		if (e.target.closest("[data-add]")) {
			const content = $("#mem-new", b).value.trim();
			if (!content) return;
			const sc = $("#mem-scope", b).value;
			await api("/memory", { body: { content, scope: sc === "global" ? "global" : "project", cwd: sc } });
			memory(b);
		}
	};
}

function hooks(b) {
	const H = S.settings.hooks;
	const events = ["sessionStart", "userPrompt", "preToolUse", "postToolUse", "stop"];
	b.innerHTML = `<h3>Hook</h3><p class="lead">${tt("Comandi shell eseguiti su eventi. Ricevono il payload JSON su stdin e in ARGON_HOOK_PAYLOAD. In preToolUse, exit code 2 blocca lo strumento; l'output di userPrompt viene aggiunto al prompt.", "Shell commands run on events. They receive the JSON payload on stdin and in ARGON_HOOK_PAYLOAD. In preToolUse, exit code 2 blocks the tool; userPrompt output is added to the prompt.")}</p>
	<div class="group">${H.map((h, i) => `<div class="list-item" data-h="${i}">
		<select class="inp" data-k="event">${events.map((ev) => `<option ${h.event === ev ? "selected" : ""}>${ev}</option>`).join("")}</select>
		<input class="inp" style="width:120px" data-k="matcher" value="${esc(h.matcher ?? "")}" placeholder="matcher regex">
		<input class="inp" style="flex:1" data-k="command" value="${esc(h.command)}" placeholder="command">
		<button class="btn sm danger" data-rm>${icon("trash")}</button></div>`).join("") || `<div class="empty">${tt("Nessun hook.", "No hooks.")}</div>`}
	<div class="list-item"><button class="btn sm pri" data-add>${icon("plus")} ${tt("Aggiungi hook", "Add hook")}</button></div></div>`;
	b.onchange = async (e) => {
		const row = e.target.closest("[data-h]");
		const k = e.target.dataset.k;
		if (!row || !k) return;
		H[Number(row.dataset.h)][k] = e.target.value || undefined;
		await saveSettings(S.settings);
	};
	b.onclick = async (e) => {
		if (e.target.closest("[data-add]")) {
			H.push({ event: "postToolUse", matcher: "edit|write", command: "echo edited" });
			await saveSettings(S.settings);
			hooks(b);
		}
		const row = e.target.closest("[data-h]");
		if (row && e.target.closest("[data-rm]")) {
			H.splice(Number(row.dataset.h), 1);
			await saveSettings(S.settings);
			hooks(b);
		}
	};
}

// ───────────────────────── sub-agents ─────────────────────────
async function agentsPage(b) {
	const cwd = (S.environments.find((e) => e.id === S.envId)?.cwd ?? S.boot.cwd);
	const list = await api(`/agents?cwd=${encodeURIComponent(cwd)}`);
	const toolsLabel = (tl) => (tl === "all" ? tt("tutti gli strumenti", "all tools") : tl === "read-only" ? tt("sola lettura", "read-only") : tl.join(", "));
	const modelLabel = (m) => (m === "inherit" ? tt("stesso modello", "same model") : m === "small" ? tt("modello leggero", "small model") : m);
	b.innerHTML = `<h3>${tt("Sub-agenti", "Sub-agents")}</h3><p class="lead">${tt("L'agente principale può delegare compiti a sub-agenti specializzati: lavorano in un contesto separato, anche in parallelo, e restituiscono solo un resoconto. I file .md in ~/.argon/agents, .argon/agents o .claude/agents vengono caricati automaticamente.", "The main agent can delegate to specialised sub-agents: they work in a separate context, even in parallel, and return only a report. .md files in ~/.argon/agents, .argon/agents or .claude/agents are loaded automatically.")}</p>
	<div class="group">${F("agents.enabled", tt("Sub-agenti attivi", "Sub-agents enabled"), "", "bool")}${F("agents.maxSteps", tt("Passi massimi per sub-agente", "Max steps per sub-agent"), tt("Oltre questo limite il sub-agente si ferma e riporta", "Beyond this the sub-agent stops and reports"), "number")}</div>
	<div class="agent-grid stagger">${list
		.map(
			(a) => `<div class="agent-card ${a.enabled ? "" : "off"}" data-agent="${esc(a.name)}" style="--ac:${esc(a.color ?? "var(--primary)")}">
			<div class="ac-top"><span class="ac-ico">${icon("smart_toy")}</span><div class="grow"><b>${esc(a.name)}</b><span class="badge">${esc(a.source)}</span></div><label class="toggle"><input type="checkbox" data-en ${a.enabled ? "checked" : ""}><i></i></label></div>
			<p>${esc(a.description)}</p>
			<div class="ac-tags"><span class="tag">${icon("build")}${esc(toolsLabel(a.tools))}</span><span class="tag">${icon("memory")}${esc(modelLabel(a.model))}</span>${a.effort ? `<span class="tag">${icon("psychology")}${esc(a.effort)}</span>` : ""}</div>
			${a.source === "user" ? `<div class="ac-acts"><button class="btn sm" data-edit>${icon("edit")} ${tt("Modifica", "Edit")}</button><button class="btn sm danger" data-del>${icon("delete")}</button></div>` : ""}
		</div>`,
		)
		.join("")}
		<button class="agent-card add" data-new>${icon("add")}<b>${tt("Nuovo sub-agente", "New sub-agent")}</b></button>
	</div>`;
	bindForm(b);
	b.onchange = async (e) => {
		const en = e.target.closest("[data-en]");
		if (!en) return;
		const name = en.closest("[data-agent]").dataset.agent;
		const set = new Set(S.settings.agents.disabled);
		en.checked ? set.delete(name) : set.add(name);
		S.settings.agents.disabled = [...set];
		en.closest(".agent-card").classList.toggle("off", !en.checked);
		await saveSettings(S.settings, true);
	};
	b.onclick = async (e) => {
		const card = e.target.closest("[data-agent]");
		if (e.target.closest("[data-new]")) return agentModal(null, () => agentsPage(b));
		if (card && e.target.closest("[data-edit]")) return agentModal(list.find((a) => a.name === card.dataset.agent), () => agentsPage(b));
		if (card && e.target.closest("[data-del]")) {
			if (!confirm(tt("Eliminare questo sub-agente?", "Delete this sub-agent?"))) return;
			await api(`/agents/${encodeURIComponent(card.dataset.agent)}`, { method: "DELETE" });
			agentsPage(b);
		}
	};
}

function agentModal(a, done) {
	const tools = a ? (Array.isArray(a.tools) ? a.tools.join(", ") : a.tools) : "read-only";
	const models = [["inherit", tt("Stesso modello dell'agente principale", "Same as main agent")], ["small", tt("Modello leggero (impostazioni)", "Small model (settings)")], ...S.models.map((m) => [m.key, m.name + " — " + m.key])];
	const colors = ["#d0bcff", "#a8c7fa", "#7fd8be", "#ffb4ab", "#f9c97f", "#efb8c8", "#c3e88d"];
	modal(
		`<h3>${a ? esc(a.name) : tt("Nuovo sub-agente", "New sub-agent")}</h3>
		<div class="group">
			<div class="field"><div class="lbl"><b>${t("name")}</b></div><input class="inp w" name="name" value="${esc(a?.name ?? "")}" ${a ? "readonly" : ""} placeholder="es. tester"></div>
			<div class="field col"><div class="lbl"><b>${tt("Quando usarlo", "When to use it")}</b><small>${tt("L'agente principale decide da questa descrizione", "The main agent decides from this description")}</small></div><input class="inp full" name="description" value="${esc(a?.description ?? "")}"></div>
			<div class="field"><div class="lbl"><b>${tt("Strumenti", "Tools")}</b><small>all, read-only, ${tt("oppure una lista", "or a list")}: read, grep, bash, mcp__github__*</small></div><input class="inp w" name="tools" value="${esc(tools)}"></div>
			<div class="field"><div class="lbl"><b>${tt("Modello", "Model")}</b></div><select class="inp w" name="model">${models.map(([k, l]) => `<option value="${esc(k)}" ${(a?.model ?? "inherit") === k ? "selected" : ""}>${esc(l)}</option>`).join("")}</select></div>
			<div class="field"><div class="lbl"><b>${t("effort")}</b></div><select class="inp s" name="effort"><option value="">${tt("eredita", "inherit")}</option>${["low", "medium", "high", "xhigh", "max"].map((x) => `<option ${a?.effort === x ? "selected" : ""}>${x}</option>`).join("")}</select></div>
			<div class="field"><div class="lbl"><b>${tt("Colore", "Colour")}</b></div><span class="color-pick">${colors.map((c) => `<button type="button" class="${(a?.color ?? colors[0]) === c ? "on" : ""}" data-c="${c}" style="background:${c}"></button>`).join("")}</span></div>
			<div class="field col"><div class="lbl"><b>${tt("Istruzioni (prompt di sistema)", "Instructions (system prompt)")}</b></div><textarea class="inp full" rows="9" name="prompt" placeholder="${tt("Sei un tester: scrivi ed esegui test…", "You are a tester: write and run tests…")}">${esc(a?.prompt ?? "")}</textarea></div>
		</div>
		<div class="acts"><button class="btn" data-x>${t("cancel")}</button><button class="btn pri" data-ok>${t("save")}</button></div>`,
		(m, close) => {
			let color = a?.color ?? colors[0];
			m.querySelector(".color-pick").onclick = (e) => {
				const c = e.target.closest("[data-c]");
				if (!c) return;
				color = c.dataset.c;
				$$(".color-pick button", m).forEach((x) => x.classList.toggle("on", x === c));
			};
			m.querySelector("[data-x]").onclick = close;
			m.querySelector("[data-ok]").onclick = async () => {
				const v = (n) => m.querySelector(`[name=${n}]`).value.trim();
				if (!v("name") || !v("description")) return toast(tt("Nome e descrizione sono obbligatori", "Name and description are required"));
				await api("/agents", { body: { name: v("name"), description: v("description"), tools: v("tools"), model: v("model"), effort: v("effort") || undefined, prompt: v("prompt"), color } });
				close();
				done();
			};
		},
	);
}

// ───────────────────────── stats & search ─────────────────────────
export async function renderUsagePage(view, range = "30d") {
	// Header and range buttons are built once; switching range only swaps the numbers, the table and
	// the agents (the 30-day chart does not depend on the range), so nothing replays its entrance.
	let page = view.querySelector(".usage-page");
	const first = !page;
	if (first) {
		view.innerHTML = `<div class="search-page usage-page" style="max-width:980px">
		<div class="page-head"><h3>${tt("Utilizzo dettagliato", "Detailed usage")}</h3>
			<div class="tabs" data-range>${[["today", tt("Oggi", "Today")], ["7d", "7d"], ["30d", "30d"], ["all", t("all")]].map(([k, l]) => `<button data-v="${k}">${l}</button>`).join("")}</div></div>
		<div id="usage-body">${loader(40, "center")}</div>
	</div>`;
		page = view.querySelector(".usage-page");
		view.querySelector("[data-range]").onclick = (e) => {
			const b = e.target.closest("[data-v]");
			if (b && !b.classList.contains("on")) renderUsagePage(view, b.dataset.v);
		};
	}
	for (const b of page.querySelectorAll("[data-range] button")) b.classList.toggle("on", b.dataset.v === range);
	page.dataset.range = range;
	const d = await api(`/usage?range=${range}`);
	if (!page.isConnected || page.dataset.range !== range) return;
	const body = $("#usage-body", page);
	const maxDay = Math.max(0.0001, ...d.daily.map((x) => x.cost));
	const fmt$ = (v) => "$" + (v < 1 ? v.toFixed(3) : v.toFixed(2));
	const money = (v) => "$" + v.toFixed(v >= 100 ? 0 : 2);
	// First load: values count up; later: shown directly.
	const kpi = (v, fmt, attrs, label) => `<div class="k"><b ${first ? attrs : ""}>${first ? (attrs.includes("money") ? "$0" : "0") : fmt(v)}</b><small>${label}</small></div>`;
	const kpis = `<div class="group" id="u-kpis"><div class="usage-kpis ${first ? "stagger" : ""}">
			${kpi(d.totals.cost, money, `data-count="${d.totals.cost}" data-money`, tt("Costo totale", "Total cost"))}
			${kpi(d.totals.tokens, fmtTokens, `data-count="${d.totals.tokens}" data-fmt="tokens"`, tt("Token", "Tokens"))}
			${kpi(d.totals.calls, (v) => Math.round(v).toLocaleString(lang()), `data-count="${d.totals.calls}"`, tt("Chiamate al modello", "Model calls"))}
			${kpi(d.totals.subagentCost, money, `data-count="${d.totals.subagentCost}" data-money`, tt("di cui sub-agenti", "of which sub-agents"))}
		</div></div>`;
	const daily = `<div class="group" id="u-daily"><div class="gh">${tt("Ultimi 30 giorni", "Last 30 days")}</div><div class="daily">${d.daily.map((x, i) => `<i style="height:${Math.max(2, (x.cost / maxDay) * 100)}%;animation-delay:${i * 18}ms" title="${x.day}: ${fmt$(x.cost)} · ${fmtTokens(x.tokens)}"></i>`).join("")}</div></div>`;
	const rest = `
		<div class="group" id="u-table" style="overflow-x:auto"><table class="usage-table">
			<thead><tr><th>${tt("Modello", "Model")}</th><th>${tt("Chiamate", "Calls")}</th><th>Input</th><th>Output</th><th>Cache</th><th>${tt("Costo", "Cost")}</th></tr></thead>
			<tbody>${d.rows.map((r) => `<tr><td><div class="mdl">${providerBadge(r.provider)}<div><b>${esc(r.model)}</b><small>${esc(S.providers.find((p) => p.id === r.provider)?.name ?? r.provider)}</small>${r.subagentCost || r.subagentTokens ? `<span class="sub">${icon("smart_toy")} ${tt("sub-agenti", "sub-agents")} ${esc(r.agents.join(", "))}: ${fmt$(r.subagentCost)} · ${fmtTokens(r.subagentTokens)}</span>` : ""}</div></div></td><td>${r.calls}</td><td>${fmtTokens(r.input)}</td><td>${fmtTokens(r.output)}</td><td>${fmtTokens(r.cacheRead + r.cacheWrite)}</td><td><b>${fmt$(r.cost)}</b></td></tr>`).join("") || `<tr><td colspan="6" class="empty">—</td></tr>`}</tbody>
			<tfoot><tr><td>${tt("Totale", "Total")}</td><td>${d.totals.calls}</td><td>${fmtTokens(d.totals.input)}</td><td>${fmtTokens(d.totals.output)}</td><td>${fmtTokens(d.totals.cacheRead + d.totals.cacheWrite)}</td><td>${fmt$(d.totals.cost)}</td></tr></tfoot>
		</table></div>
		<div class="group" id="u-agents"><div class="gh">${tt("Per agente", "By agent")}</div>${d.byAgent.map((a) => `<div class="list-item">${icon(a.agent === "main" ? "person" : a.agent === "title" || a.agent === "compaction" ? "build" : "smart_toy")}<div class="grow"><b>${a.agent === "main" ? tt("Agente principale", "Main agent") : esc(a.agent)}</b><small>${a.calls} ${tt("chiamate", "calls")} · ${fmtTokens(a.tokens)}</small></div><b>${fmt$(a.cost)}</b></div>`).join("") || `<div class="empty">—</div>`}</div>`;
	if (first || !$("#u-daily", body)) {
		body.innerHTML = kpis + daily + rest;
		animateCounters(body);
		return;
	}
	const tmp = document.createElement("div");
	tmp.innerHTML = kpis + rest;
	for (const id of ["u-kpis", "u-table", "u-agents"]) $(`#${id}`, body).replaceWith($(`#${id}`, tmp));
}

export function renderStatsPage(view) {
	const L = S.limits;
	view.innerHTML = `<div class="search-page" style="max-width:820px">
		<div class="page-head"><h3 style="font-size:20px">${t("stats")}</h3><div id="stats-head-host"></div></div>
		<div class="stats-card" id="stats-big" style="width:100%"></div>
		<h3 style="font-size:15px;margin:26px 0 10px">${t("usageLimits")}</h3>
		<div class="group"><div class="limit-preview">${limitRowHtml(t("fiveHour"), L.fiveHour, L.unit, S.settings.limits.enabled && L.fiveHour.enabled)}${limitRowHtml(t("weekly"), L.weekly, L.unit, S.settings.limits.enabled && L.weekly.enabled)}</div></div>
		<div class="group spend-card">${spendHtml(L.spend)}</div>
		<button class="btn sm" data-go="/settings/limits">${icon("settings")} ${tt("Configura limiti", "Configure limits")}</button>
	</div>`;
	animateCounters(view);
	// the card's tabs go in the title row (not in the card's corner)
	$("#stats-big", view)._headHost = $("#stats-head-host", view);
	loadStatsCard($("#stats-big", view));
	view.querySelector("[data-go]").onclick = () => go("/settings/limits");
}

export function renderSearch(view) {
	view.innerHTML = `<div class="search-page"><input class="inp" id="q" placeholder="${t("searchPh")}" autofocus><div id="results"></div></div>`;
	const q = $("#q", view);
	const run = debounce(async () => {
		const v = q.value.trim();
		const box = $("#results", view);
		if (!v) {
			box.innerHTML = S.sessions.slice(0, 20).map((s) => `<div class="result" data-sid="${s.id}"><b>${esc(s.title)}</b><small>${esc(s.preview ?? "")} · ${relTime(s.updatedAt, lang())}</small></div>`).join("");
			return;
		}
		const res = await api(`/search?q=${encodeURIComponent(v)}`);
		const hl = (s) => esc(s).replace(new RegExp(v.replace(/[.*+?^${}()|[\]\\]/g, "\\$&"), "gi"), (m) => `<mark>${m}</mark>`);
		box.innerHTML = res.map((r) => `<div class="result" data-sid="${r.meta.id}"><b>${hl(r.meta.title)}</b><small>${hl(r.snippet)} · ${relTime(r.meta.updatedAt, lang())}</small></div>`).join("") || `<div class="empty">${t("noResults")}</div>`;
	}, 200);
	q.oninput = run;
	run();
	setTimeout(() => q.focus(), 0);
	view.onclick = (e) => {
		const r = e.target.closest("[data-sid]");
		if (r) go("/s/" + r.dataset.sid);
	};
}

// ───────────────────────── folder picker ─────────────────────────
export async function openFolderModal(onDone) {
	// Desktop app: use the native Windows folder dialog.
	if (window.argonDesktop) {
		const dir = await window.argonDesktop.pickFolder();
		if (!dir) return;
		try {
			const env = await api("/environments", { body: { name: dir.split(/[\\/]/).filter(Boolean).pop(), cwd: dir } });
			toast(`✓ ${env.name}`);
			onDone?.(env);
		} catch (err) {
			toast(err.message);
		}
		return;
	}
	let cur = S.boot.cwd;
	modal(
		`<h3>${t("addEnv")}</h3>
		<div class="field" style="padding:0 0 10px"><div class="lbl"><b>${t("name")}</b></div><input class="inp w" name="name" placeholder="${tt("es. Il mio progetto", "e.g. My project")}"></div>
		<div class="keyrow"><button class="btn sm" data-up title="${t("up")}">${icon("left")}</button><input class="inp" name="path"><button class="btn sm" data-go>${t("open")}</button></div>
		<div class="dirlist" id="dirs"></div>
		<div class="acts"><button class="btn" data-x>${t("cancel")}</button><button class="btn pri" data-ok>${t("select")}</button></div>`,
		(m, close) => {
			const pathInp = m.querySelector("[name=path]");
			const nameInp = m.querySelector("[name=name]");
			let parent = null;
			const load = async (p) => {
				try {
					const r = await api(`/fs?path=${encodeURIComponent(p)}`);
					cur = r.path;
					parent = r.parent;
					pathInp.value = r.path;
					if (!nameInp.dataset.touched) nameInp.value = r.path.split(/[\\/]/).filter(Boolean).pop() ?? "";
					$("#dirs", m).innerHTML = r.dirs.filter((d) => !d.startsWith(".")).map((d) => `<div class="d" data-d="${esc(d)}">${icon("folder")} ${esc(d)}</div>`).join("") || `<div class="empty">—</div>`;
				} catch (e) {
					toast(e.message);
				}
			};
			nameInp.oninput = () => (nameInp.dataset.touched = "1");
			load(cur);
			m.onclick = async (e) => {
				const d = e.target.closest("[data-d]");
				if (d) load(cur.replace(/[\\/]$/, "") + (cur.includes("\\") ? "\\" : "/") + d.dataset.d);
				if (e.target.closest("[data-up]") && parent) load(parent);
				if (e.target.closest("[data-go]")) load(pathInp.value);
				if (e.target.closest("[data-x]")) close();
				if (e.target.closest("[data-ok]")) {
					try {
						const env = await api("/environments", { body: { name: nameInp.value.trim(), cwd: pathInp.value.trim() || cur } });
						close();
						onDone?.(env);
					} catch (err) {
						toast(err.message);
					}
				}
			};
			pathInp.onkeydown = (e) => e.key === "Enter" && load(pathInp.value);
		},
	);
}

void fmtAmount;
void refreshSessions;
