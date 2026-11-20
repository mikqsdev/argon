//! Locating and starting the Argon core (the TypeScript engine built on Pi).
//!
//! The core runs as a local HTTP + WebSocket server (`argon-core serve`). The CLI reuses a core the
//! desktop app already advertises in `~/.argon/core.json`; otherwise it starts a private one as a
//! child process that exits together with the CLI (its stdin is a pipe we hold open).

use serde::Deserialize;
use std::io::{BufRead, BufReader};
use std::path::{Path, PathBuf};
use std::process::{Child, Command, Stdio};
use std::time::Duration;

#[derive(Deserialize, Clone, Debug)]
pub struct CoreInfo {
    pub port: u16,
    pub token: String,
}

pub struct Core {
    pub info: CoreInfo,
    _child: Option<Child>,
}

impl Drop for Core {
    fn drop(&mut self) {
        if let Some(c) = self._child.as_mut() {
            let _ = c.kill();
        }
    }
}

pub fn argon_home() -> PathBuf {
    if let Ok(h) = std::env::var("ARGON_HOME") {
        return PathBuf::from(h);
    }
    let home = std::env::var("USERPROFILE").or_else(|_| std::env::var("HOME")).unwrap_or_else(|_| ".".into());
    PathBuf::from(home).join(".argon")
}

/// How to run the TypeScript side: a node binary and the CLI entry (`dist/cli/main.js`).
pub struct Runtime {
    pub node: PathBuf,
    pub entry: PathBuf,
}

/// Drop the Windows verbatim prefix (`\\?\C:\…`): Node cannot load modules from such paths.
pub fn plain(p: PathBuf) -> PathBuf {
    let s = p.to_string_lossy();
    if let Some(rest) = s.strip_prefix(r"\\?\UNC\") {
        return PathBuf::from(format!(r"\\{rest}"));
    }
    match s.strip_prefix(r"\\?\") {
        Some(rest) => PathBuf::from(rest),
        None => p,
    }
}

fn exe_dir() -> PathBuf {
    std::env::current_exe().ok().map(plain).and_then(|p| p.parent().map(Path::to_path_buf)).unwrap_or_else(|| PathBuf::from("."))
}

fn which(name: &str) -> Option<PathBuf> {
    let path = std::env::var_os("PATH")?;
    let exts: Vec<String> = if cfg!(windows) { vec![".exe".into(), ".cmd".into(), "".into()] } else { vec!["".into()] };
    for dir in std::env::split_paths(&path) {
        for e in &exts {
            let p = dir.join(format!("{name}{e}"));
            if p.is_file() {
                return Some(p);
            }
        }
    }
    None
}

/// Installed layout: `<app>/core/node(.exe)` + `<app>/core/app/dist/cli/main.js`, next to `argon(.exe)`
/// (or one folder up when the CLI lives in `<app>/bin`). Development: the repo's `dist/` with `node` on PATH.
pub fn runtime() -> Option<Runtime> {
    if let (Ok(n), Ok(e)) = (std::env::var("ARGON_NODE"), std::env::var("ARGON_CORE_ENTRY")) {
        return Some(Runtime { node: n.into(), entry: e.into() });
    }
    let node_name = if cfg!(windows) { "node.exe" } else { "node" };
    let dir = exe_dir();
    for base in [dir.clone(), dir.join(".."), dir.join("..").join("resources")] {
        let core = base.join("core");
        let entry = core.join("app").join("dist").join("cli").join("main.js");
        if entry.is_file() {
            let node = core.join(node_name);
            let node = if node.is_file() { node } else { which("node")? };
            return Some(Runtime { node, entry });
        }
    }
    // Development: walk up to the repository root.
    let mut d = Some(dir.as_path());
    while let Some(p) = d {
        let entry = p.join("dist").join("cli").join("main.js");
        if entry.is_file() && p.join("package.json").is_file() {
            return Some(Runtime { node: which("node")?, entry });
        }
        d = p.parent();
    }
    None
}

impl Runtime {
    pub fn command(&self) -> Command {
        let mut c = Command::new(&self.node);
        c.arg(&self.entry);
        c
    }
}

fn ping(port: u16) -> bool {
    ureq::get(&format!("http://127.0.0.1:{port}/api/ping"))
        .timeout(Duration::from_millis(700))
        .call()
        .ok()
        .and_then(|r| r.into_string().ok())
        .map(|s| s.starts_with("argon"))
        .unwrap_or(false)
}

/// Reuse an advertised core or start a private one.
pub fn connect() -> Result<Core, String> {
    let file = argon_home().join("core.json");
    if let Ok(raw) = std::fs::read_to_string(&file) {
        if let Ok(info) = serde_json::from_str::<CoreInfo>(&raw) {
            if ping(info.port) {
                return Ok(Core { info, _child: None });
            }
        }
    }
    let rt = runtime().ok_or("Argon core not found: reinstall Argon, or run `npm run build` in the repository.")?;
    let mut cmd = rt.command();
    cmd.arg("serve").stdin(Stdio::piped()).stdout(Stdio::piped()).stderr(Stdio::null());
    #[cfg(windows)]
    {
        use std::os::windows::process::CommandExt;
        cmd.creation_flags(0x0800_0000); // CREATE_NO_WINDOW
    }
    let mut child = cmd.spawn().map_err(|e| format!("Cannot start the Argon core: {e}"))?;
    let stdout = child.stdout.take().ok_or("no stdout")?;
    let mut lines = BufReader::new(stdout).lines();
    loop {
        match lines.next() {
            Some(Ok(l)) => {
                if let Some(json) = l.strip_prefix("ARGON_READY ") {
                    let info: CoreInfo = serde_json::from_str(json).map_err(|e| e.to_string())?;
                    // Keep draining stdout so the core never blocks on a full pipe.
                    std::thread::spawn(move || for _ in lines.by_ref() {});
                    return Ok(Core { info, _child: Some(child) });
                }
            }
            _ => {
                let _ = child.kill();
                return Err("The Argon core exited during startup.".into());
            }
        }
    }
}

/// Run a TypeScript CLI subcommand in the foreground (login, mcp, env, …).
pub fn run_ts(args: &[String]) -> i32 {
    let Some(rt) = runtime() else {
        eprintln!("Argon core not found.");
        return 1;
    };
    let mut c = rt.command();
    c.args(args);
    match c.status() {
        Ok(s) => s.code().unwrap_or(0),
        Err(e) => {
            eprintln!("{e}");
            1
        }
    }
}
