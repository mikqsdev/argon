//! Argon desktop app: a Tauri window around the GUI served by the Argon core.
//!
//! On start it shows a splash page, launches the core (`argon-core serve --advertise`, the
//! TypeScript engine built on Pi) and navigates to the URL it prints. The core advertises itself in
//! `~/.argon/core.json` so the Rust CLI reuses it; it exits when this app closes its stdin.

#![cfg_attr(not(debug_assertions), windows_subsystem = "windows")]

use serde::{Deserialize, Serialize};
use std::io::{BufRead, BufReader};
use std::path::{Path, PathBuf};
use std::process::{Child, Command, Stdio};
use std::sync::Mutex;
use tauri::webview::PageLoadEvent;
use tauri::{Manager, RunEvent, WebviewUrl, WebviewWindow, WebviewWindowBuilder, WindowEvent};
use tauri_plugin_dialog::DialogExt;

struct CoreProc(Mutex<Option<Child>>);
struct CoreOrigin(Mutex<String>);

#[derive(Serialize, Deserialize, Default)]
struct WinState {
    x: Option<i32>,
    y: Option<i32>,
    width: Option<u32>,
    height: Option<u32>,
    maximized: bool,
}

fn argon_home() -> PathBuf {
    if let Ok(h) = std::env::var("ARGON_HOME") {
        return PathBuf::from(h);
    }
    let home = std::env::var("USERPROFILE").or_else(|_| std::env::var("HOME")).unwrap_or_else(|_| ".".into());
    PathBuf::from(home).join(".argon")
}

fn which(name: &str) -> Option<PathBuf> {
    let path = std::env::var_os("PATH")?;
    for dir in std::env::split_paths(&path) {
        for ext in if cfg!(windows) { &[".exe", ""][..] } else { &[""][..] } {
            let p = dir.join(format!("{name}{ext}"));
            if p.is_file() {
                return Some(p);
            }
        }
    }
    None
}

/// Drop the Windows verbatim prefix (`\\?\C:\…`): Node cannot load modules from such paths.
fn plain(p: PathBuf) -> PathBuf {
    let s = p.to_string_lossy();
    if let Some(rest) = s.strip_prefix(r"\\?\UNC\") {
        return PathBuf::from(format!(r"\\{rest}"));
    }
    match s.strip_prefix(r"\\?\") {
        Some(rest) => PathBuf::from(rest),
        None => p,
    }
}

/// Node binary + core entry (`dist/cli/main.js`): bundled resources, or the repository in development.
fn runtime(app: &tauri::AppHandle) -> Option<(PathBuf, PathBuf)> {
    if let (Ok(n), Ok(e)) = (std::env::var("ARGON_NODE"), std::env::var("ARGON_CORE_ENTRY")) {
        return Some((n.into(), e.into()));
    }
    let node_name = if cfg!(windows) { "node.exe" } else { "node" };
    if let Ok(res) = app.path().resource_dir().map(plain) {
        let core = res.join("core");
        let entry = core.join("app").join("dist").join("cli").join("main.js");
        if entry.is_file() {
            let node = core.join(node_name);
            return Some((if node.is_file() { node } else { which("node")? }, entry));
        }
    }
    let exe = plain(std::env::current_exe().ok()?);
    let mut d: Option<&Path> = exe.parent();
    while let Some(p) = d {
        let entry = p.join("dist").join("cli").join("main.js");
        if entry.is_file() && p.join("package.json").is_file() {
            return Some((which("node")?, entry));
        }
        d = p.parent();
    }
    None
}

fn start_core(node: &Path, entry: &Path) -> Result<(Child, String), String> {
    let mut cmd = Command::new(node);
    cmd.arg(entry).args(["serve", "--advertise"]).stdin(Stdio::piped()).stdout(Stdio::piped()).stderr(Stdio::null());
    #[cfg(windows)]
    {
        use std::os::windows::process::CommandExt;
        cmd.creation_flags(0x0800_0000); // CREATE_NO_WINDOW
    }
    let mut child = cmd.spawn().map_err(|e| format!("Cannot start the Argon core: {e}"))?;
    let out = child.stdout.take().ok_or("no stdout")?;
    let mut lines = BufReader::new(out).lines();
    while let Some(Ok(l)) = lines.next() {
        if let Some(json) = l.strip_prefix("ARGON_READY ") {
            let v: serde_json::Value = serde_json::from_str(json).map_err(|e| e.to_string())?;
            let url = v["url"].as_str().ok_or("bad ready line")?.to_string();
            std::thread::spawn(move || for _ in lines.by_ref() {});
            return Ok((child, url));
        }
    }
    let _ = child.kill();
    Err("The Argon core exited during startup.".into())
}

fn stop_core(app: &tauri::AppHandle) {
    if let Some(mut c) = app.state::<CoreProc>().0.lock().unwrap().take() {
        // Closing stdin lets the core remove core.json and exit cleanly.
        drop(c.stdin.take());
        for _ in 0..20 {
            if let Ok(Some(_)) = c.try_wait() {
                return;
            }
            std::thread::sleep(std::time::Duration::from_millis(50));
        }
        let _ = c.kill();
    }
}

fn open_url(url: &str) {
    if !(url.starts_with("http://") || url.starts_with("https://")) {
        return;
    }
    #[cfg(windows)]
    let r = Command::new("rundll32").args(["url.dll,FileProtocolHandler", url]).spawn();
    #[cfg(target_os = "macos")]
    let r = Command::new("open").arg(url).spawn();
    #[cfg(all(unix, not(target_os = "macos")))]
    let r = Command::new("xdg-open").arg(url).spawn();
    let _ = r;
}

// ─────────────────────────── commands called by the GUI (window.argonDesktop) ───────────────────────────

#[tauri::command]
async fn pick_folder(app: tauri::AppHandle) -> Option<String> {
    app.dialog().file().blocking_pick_folder().and_then(|p| p.into_path().ok()).map(|p| p.to_string_lossy().to_string())
}

fn parse_hex(s: &Option<String>) -> Option<(u8, u8, u8)> {
    let s = s.as_deref()?.strip_prefix('#')?;
    if s.len() != 6 {
        return None;
    }
    let v = u32::from_str_radix(s, 16).ok()?;
    Some(((v >> 16) as u8, (v >> 8) as u8, v as u8))
}

#[tauri::command]
fn set_theme(window: WebviewWindow, dark: bool, bg: Option<String>, fg: Option<String>) {
    let _ = window.set_theme(Some(if dark { tauri::Theme::Dark } else { tauri::Theme::Light }));
    let bgc = parse_hex(&bg).unwrap_or(if dark { (0x12, 0x10, 0x16) } else { (0xf7, 0xf5, 0xfb) });
    let _ = window.set_background_color(Some(tauri::window::Color(bgc.0, bgc.1, bgc.2, 255)));
    // Windows 11: paint the native title bar with the app's own background.
    #[cfg(windows)]
    if let Ok(hwnd) = window.hwnd() {
        use windows_sys::Win32::Graphics::Dwm::{DwmSetWindowAttribute, DWMWA_CAPTION_COLOR, DWMWA_TEXT_COLOR};
        let fgc = parse_hex(&fg).unwrap_or(if dark { (0xe6, 0xe1, 0xe9) } else { (0x1d, 0x1b, 0x20) });
        let rgb = |c: (u8, u8, u8)| (c.0 as u32) | ((c.1 as u32) << 8) | ((c.2 as u32) << 16);
        let (cap, txt) = (rgb(bgc), rgb(fgc));
        unsafe {
            DwmSetWindowAttribute(hwnd.0 as _, DWMWA_CAPTION_COLOR as u32, &cap as *const u32 as _, 4);
            DwmSetWindowAttribute(hwnd.0 as _, DWMWA_TEXT_COLOR as u32, &txt as *const u32 as _, 4);
        }
    }
}

#[tauri::command]
fn set_zoom(window: WebviewWindow, factor: f64) {
    let _ = window.set_zoom(factor.clamp(0.7, 1.5));
}

#[tauri::command]
fn open_external(url: String) {
    open_url(&url);
}

const BRIDGE: &str = r#"
(function () {
  if (window.argonDesktop) return;
  const inv = (cmd, args) => window.__TAURI_INTERNALS__.invoke(cmd, args || {});
  window.argonDesktop = {
    isDesktop: true,
    shell: "tauri",
    platform: "__PLATFORM__",
    pickFolder: () => inv("pick_folder"),
    setTheme: (dark, colors) => inv("set_theme", { dark: !!dark, bg: (colors && colors.bg) || null, fg: (colors && colors.fg) || null }),
    setZoom: (factor) => inv("set_zoom", { factor: Number(factor) || 1 }),
    openExternal: (url) => inv("open_external", { url: String(url) }),
  };
  // Links that would open a new window go to the system browser instead.
  const external = (href) => /^https?:/i.test(href) && new URL(href, location.href).origin !== location.origin;
  const open = window.open;
  window.open = function (url, target, features) {
    if (url && external(String(url))) { window.argonDesktop.openExternal(new URL(url, location.href).href); return null; }
    return open.call(window, url, target, features);
  };
  document.addEventListener("click", (e) => {
    const a = e.target && e.target.closest ? e.target.closest("a[href]") : null;
    if (a && (a.target === "_blank" || external(a.href)) && /^https?:/i.test(a.href)) {
      e.preventDefault();
      window.argonDesktop.openExternal(a.href);
    }
  }, true);
})();
"#;

fn state_file() -> PathBuf {
    argon_home().join("window-state.json")
}

fn save_state(w: &WebviewWindow) {
    let maximized = w.is_maximized().unwrap_or(false);
    let mut st: WinState = std::fs::read_to_string(state_file()).ok().and_then(|s| serde_json::from_str(&s).ok()).unwrap_or_default();
    st.maximized = maximized;
    if !maximized {
        if let (Ok(p), Ok(s), Ok(f)) = (w.outer_position(), w.inner_size(), w.scale_factor()) {
            st.x = Some(p.x);
            st.y = Some(p.y);
            st.width = Some((s.width as f64 / f) as u32);
            st.height = Some((s.height as f64 / f) as u32);
        }
    }
    let _ = std::fs::write(state_file(), serde_json::to_string(&st).unwrap_or_default());
}

fn main() {
    let app = tauri::Builder::default()
        .plugin(tauri_plugin_single_instance::init(|app, _args, _cwd| {
            if let Some(w) = app.get_webview_window("main") {
                let _ = w.unminimize();
                let _ = w.set_focus();
            }
        }))
        .plugin(tauri_plugin_dialog::init())
        .manage(CoreProc(Mutex::new(None)))
        .manage(CoreOrigin(Mutex::new(String::new())))
        .invoke_handler(tauri::generate_handler![pick_folder, set_theme, set_zoom, open_external])
        .setup(|app| {
            let st: WinState = std::fs::read_to_string(state_file()).ok().and_then(|s| serde_json::from_str(&s).ok()).unwrap_or_default();
            let handle = app.handle().clone();
            let platform = if cfg!(windows) { "win32" } else if cfg!(target_os = "macos") { "darwin" } else { "linux" };
            let mut b = WebviewWindowBuilder::new(app, "main", WebviewUrl::App("index.html".into()))
                .title("Argon")
                .inner_size(st.width.unwrap_or(1360) as f64, st.height.unwrap_or(860) as f64)
                .min_inner_size(820.0, 560.0)
                .background_color(tauri::window::Color(0x12, 0x10, 0x16, 255))
                .initialization_script(&BRIDGE.replace("__PLATFORM__", platform))
                .on_navigation({
                    let handle = handle.clone();
                    move |url| {
                        let origin = handle.state::<CoreOrigin>().0.lock().unwrap().clone();
                        let host = url.host_str().unwrap_or("");
                        let local = url.scheme() == "tauri" || host == "tauri.localhost" || (!origin.is_empty() && url.as_str().starts_with(&origin));
                        if !local {
                            open_url(url.as_str());
                        }
                        local
                    }
                });
            b = match (st.x, st.y) {
                (Some(x), Some(y)) => b.position(x as f64, y as f64),
                _ => b.center(),
            };
            let win = b.build()?;
            if st.maximized {
                let _ = win.maximize();
            }
            // Start the core off the UI thread, then load the GUI.
            std::thread::spawn(move || {
                let Some(win) = handle.get_webview_window("main") else { return };
                let result = match runtime(&handle) {
                    Some((node, entry)) => start_core(&node, &entry),
                    None => Err("Argon core not found. Reinstall Argon.".to_string()),
                };
                match result {
                    Ok((child, url)) => {
                        *handle.state::<CoreProc>().0.lock().unwrap() = Some(child);
                        if let Ok(u) = tauri::Url::parse(&url) {
                            *handle.state::<CoreOrigin>().0.lock().unwrap() = u.origin().ascii_serialization();
                            let _ = win.navigate(u);
                        }
                    }
                    Err(e) => {
                        let _ = win.eval(&format!("window.showError && window.showError({})", serde_json::to_string(&e).unwrap_or_default()));
                    }
                }
            });
            Ok(())
        })
        .on_page_load(|webview, payload| {
            if payload.event() == PageLoadEvent::Finished {
                let _ = webview.window().show();
            }
        })
        .on_window_event(|window, event| {
            if let WindowEvent::CloseRequested { .. } = event {
                if let Some(w) = window.app_handle().get_webview_window(window.label()) {
                    save_state(&w);
                }
            }
        })
        .build(tauri::generate_context!())
        .expect("error while building the Argon desktop app");

    app.run(|handle, event| {
        if let RunEvent::Exit = event {
            stop_core(handle);
        }
    });
}
