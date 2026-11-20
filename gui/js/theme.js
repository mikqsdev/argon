// Dynamic Material 3 colour schemes from a seed colour (OKLCH-based tonal palettes).

// ───────────── colour math ─────────────
const toLin = (c) => (c <= 0.04045 ? c / 12.92 : ((c + 0.055) / 1.055) ** 2.4);
const toGam = (c) => (c <= 0.0031308 ? 12.92 * c : 1.055 * c ** (1 / 2.4) - 0.055);

export function hexToOklch(hex) {
	const n = parseInt(hex.replace("#", "").padEnd(6, "0").slice(0, 6), 16);
	const [r, g, b] = [(n >> 16) & 255, (n >> 8) & 255, n & 255].map((v) => toLin(v / 255));
	const l = Math.cbrt(0.4122214708 * r + 0.5363325363 * g + 0.0514459929 * b);
	const m = Math.cbrt(0.2119034982 * r + 0.6806995451 * g + 0.1073969566 * b);
	const s = Math.cbrt(0.0883024619 * r + 0.2817188376 * g + 0.6299787005 * b);
	const L = 0.2104542553 * l + 0.793617785 * m - 0.0040720468 * s;
	const A = 1.9779984951 * l - 2.428592205 * m + 0.4505937099 * s;
	const B = 0.0259040371 * l + 0.7827717662 * m - 0.808675766 * s;
	return { L, C: Math.hypot(A, B), h: ((Math.atan2(B, A) * 180) / Math.PI + 360) % 360 };
}

function oklchToRgb(L, C, h) {
	const a = C * Math.cos((h * Math.PI) / 180);
	const b = C * Math.sin((h * Math.PI) / 180);
	const l = (L + 0.3963377774 * a + 0.2158037573 * b) ** 3;
	const m = (L - 0.1055613458 * a - 0.0638541728 * b) ** 3;
	const s = (L - 0.0894841775 * a - 1.291485548 * b) ** 3;
	return [4.0767416621 * l - 3.3077115913 * m + 0.2309699292 * s, -1.2684380046 * l + 2.6097574011 * m - 0.3413193965 * s, -0.0041960863 * l - 0.7034186147 * m + 1.707614701 * s];
}

const inGamut = (rgb) => rgb.every((v) => v >= -0.0005 && v <= 1.0005);

/** M3 "tone" (CIE L*, 0–100) at a hue/chroma, chroma reduced until it fits sRGB. */
function tone(h, C, T) {
	const Y = T > 8 ? ((T + 16) / 116) ** 3 : T / 903.3;
	const L = Math.cbrt(Y);
	let lo = 0, hi = C, rgb = oklchToRgb(L, C, h);
	if (!inGamut(rgb)) {
		for (let i = 0; i < 18; i++) {
			const mid = (lo + hi) / 2;
			if (inGamut(oklchToRgb(L, mid, h))) lo = mid;
			else hi = mid;
		}
		rgb = oklchToRgb(L, lo, h);
	}
	return "#" + rgb.map((v) => Math.round(Math.min(1, Math.max(0, toGam(Math.min(1, Math.max(0, v))))) * 255).toString(16).padStart(2, "0")).join("");
}

// ───────────── schemes ─────────────
/** Palette recipes: [hueShift, chroma] for primary, secondary, tertiary, neutral, neutral-variant. */
const SCHEMES = {
	tonalSpot: (c) => ({ p: [0, Math.max(0.1, Math.min(c, 0.14))], s: [0, 0.045], t: [60, 0.085], n: [0, 0.012], nv: [0, 0.025] }),
	vibrant: (c) => ({ p: [0, Math.max(0.17, c)], s: [15, 0.085], t: [45, 0.12], n: [0, 0.02], nv: [0, 0.035] }),
	expressive: (c) => ({ p: [0, Math.max(0.14, c)], s: [-30, 0.08], t: [120, 0.12], n: [15, 0.028], nv: [15, 0.045] }),
	fidelity: (c) => ({ p: [0, c], s: [0, c / 3], t: [60, c / 2], n: [0, c / 12], nv: [0, c / 6] }),
	neutral: () => ({ p: [0, 0.045], s: [0, 0.02], t: [60, 0.03], n: [0, 0.005], nv: [0, 0.012] }),
	monochrome: () => ({ p: [0, 0], s: [0, 0], t: [0, 0], n: [0, 0], nv: [0, 0] }),
};

export const SCHEME_NAMES = Object.keys(SCHEMES);

/** Element-named presets (it's Argon, after all). */
export const PRESETS = [
	{ id: "argon", name: "Argon", sym: "Ar", seed: "#7c4dff" },
	{ id: "neon", name: "Neon", sym: "Ne", seed: "#ff4b2b" },
	{ id: "xenon", name: "Xenon", sym: "Xe", seed: "#3d7bff" },
	{ id: "helium", name: "Elio", sym: "He", seed: "#f2b300" },
	{ id: "copper", name: "Rame", sym: "Cu", seed: "#c06a3b" },
	{ id: "chromium", name: "Cromo", sym: "Cr", seed: "#2e9d5b" },
	{ id: "rhodium", name: "Rodio", sym: "Rh", seed: "#d81b60" },
	{ id: "carbon", name: "Carbonio", sym: "C", seed: "#5f6368", scheme: "monochrome" },
];

export function buildScheme(seed, scheme = "tonalSpot", contrast = "standard") {
	const { C, h } = hexToOklch(seed);
	const r = (SCHEMES[scheme] ?? SCHEMES.tonalSpot)(C);
	const P = (k, T) => tone((h + r[k][0] + 360) % 360, r[k][1], T);
	const E = (T) => tone(25, 0.17, T);
	const G = (T) => tone(150, 0.12, T);
	const W = (T) => tone(75, 0.13, T);
	const hi = contrast === "high" ? 2 : contrast === "medium" ? 1 : 0;
	const dark = {
		"--primary": P("p", 80 + hi * 5), "--on-primary": P("p", 20 - hi * 5),
		"--primary-container": P("p", 30 + hi * 5), "--on-primary-container": P("p", 90 + hi * 4),
		"--secondary": P("s", 80), "--secondary-container": P("s", 30 + hi * 3), "--on-secondary-container": P("s", 90 + hi * 4),
		"--tertiary": P("t", 80 + hi * 4), "--tertiary-container": P("t", 30 + hi * 3), "--on-tertiary-container": P("t", 90 + hi * 4),
		"--error": E(80), "--error-container": E(30), "--on-error-container": E(90),
		"--success": G(80), "--warning": W(82),
		"--bg": P("n", 10), "--surface": P("n", 6 - hi), "--surface-lowest": P("n", 4),
		"--surface-container": P("n", 12), "--surface-high": P("n", 17), "--surface-highest": P("n", 22),
		"--on-surface": P("n", 90 + hi * 5), "--on-surface-variant": P("nv", 80 + hi * 7),
		"--outline": P("nv", 60 + hi * 10), "--outline-variant": P("nv", 30 + hi * 12),
	};
	const light = {
		"--primary": P("p", 40 - hi * 6), "--on-primary": "#ffffff",
		"--primary-container": P("p", 90 - hi * 6), "--on-primary-container": P("p", 10),
		"--secondary": P("s", 40), "--secondary-container": P("s", 90 - hi * 4), "--on-secondary-container": P("s", 10),
		"--tertiary": P("t", 40 - hi * 5), "--tertiary-container": P("t", 90 - hi * 4), "--on-tertiary-container": P("t", 10),
		"--error": E(40), "--error-container": E(90), "--on-error-container": E(10),
		"--success": G(40), "--warning": W(45),
		"--bg": P("n", 95), "--surface": P("n", 98 + hi * 0.5), "--surface-lowest": "#ffffff",
		"--surface-container": P("n", 94), "--surface-high": P("n", 92), "--surface-highest": P("n", 90),
		"--on-surface": P("n", 10 - hi * 3), "--on-surface-variant": P("nv", 30 - hi * 8),
		"--outline": P("nv", 50 - hi * 10), "--outline-variant": P("nv", 80 - hi * 12),
	};
	return { dark, light };
}

const RADIUS = { square: 0.55, standard: 1, round: 1.45 };

/** Inject the generated palette + shape/motion/size preferences into the page. */
export function applyAppearance(ap = {}) {
	const seed = ap.seed || "#7c4dff";
	const { dark, light } = buildScheme(seed, ap.scheme || "tonalSpot", ap.contrast || "standard");
	const k = RADIUS[ap.radius] ?? 1;
	const radii = { "--r-xs": 8, "--r-s": 12, "--r-m": 16, "--r-l": 20, "--r-xl": 28, "--r-xxl": 36 };
	const shape = Object.entries(radii).map(([n, v]) => `${n}:${Math.round(v * k)}px`).join(";");
	const css = (o) => Object.entries(o).map(([n, v]) => `${n}:${v}`).join(";");
	let el = document.getElementById("argon-palette");
	if (!el) {
		el = document.createElement("style");
		el.id = "argon-palette";
		document.head.appendChild(el);
	}
	el.textContent = `:root{${css(dark)};${shape}} :root[data-theme="light"]{${css(light)}}`;
	const root = document.documentElement;
	root.dataset.motion = ap.motion || "full";
	root.style.setProperty("--ui-scale", String((ap.scale || 100) / 100));
	return { dark, light };
}
