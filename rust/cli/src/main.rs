//! Argon CLI (Rust). The agent engine — Pi providers, tools, MCP, sessions, limits — runs in the
//! Argon core (TypeScript); this binary is the terminal front end and talks to it over HTTP/WebSocket.

mod ansi;
mod api;
mod core;
mod md;
mod screen;
mod tui;

use ansi::{accent, bold, dim, err, gradient};
use api::{s, Client};
use serde_json::json;
use std::io::{IsTerminal, Read, Write};
use std::path::PathBuf;
use std::process::ExitCode;
use std::sync::mpsc::channel;

struct Args {
    rest: Vec<String>,
    print: Option<String>,
    model: Option<String>,
    effort: Option<String>,
    mode: Option<String>,
    cwd: Option<String>,
    resume: Option<String>,
    help: bool,
    version: bool,
}

fn parse(argv: Vec<String>) -> Args {
    let mut a = Args { rest: vec![], print: None, model: None, effort: None, mode: None, cwd: None, resume: None, help: false, version: false };
    let mut i = 0;
    let next = |i: &mut usize| -> Option<String> {
        *i += 1;
        argv.get(*i).cloned()
    };
    while i < argv.len() {
        let x = argv[i].clone();
        let (k, inline) = match x.split_once('=') {
            Some((k, v)) if k.starts_with("--") => (k.to_string(), Some(v.to_string())),
            _ => (x.clone(), None),
        };
        match k.as_str() {
            "-p" | "--print" => {
                let v = inline.or_else(|| argv.get(i + 1).filter(|n| !n.starts_with('-')).cloned());
                if v.is_some() && argv.get(i + 1) == v.as_ref() {
                    i += 1;
                }
                a.print = Some(v.unwrap_or_default());
            }
            "-m" | "--model" => a.model = inline.or_else(|| next(&mut i)),
            "-e" | "--effort" => a.effort = inline.or_else(|| next(&mut i)),
            "--mode" => a.mode = inline.or_else(|| next(&mut i)),
            "-C" | "--cwd" => a.cwd = inline.or_else(|| next(&mut i)),
            "-c" | "--continue" => a.resume = Some(String::new()),
            "-r" | "--resume" => {
                let v = inline.or_else(|| argv.get(i + 1).filter(|n| !n.starts_with('-')).cloned());
                if v.is_some() && argv.get(i + 1) == v.as_ref() {
                    i += 1;
                }
                a.resume = Some(v.unwrap_or_default());
            }
            "-h" | "--help" => a.help = true,
            "-v" | "--version" => a.version = true,
            _ => a.rest.push(x),
        }
        i += 1;
    }
    a
}

fn help() {
    let v = env!("CARGO_PKG_VERSION");
    println!(
        "
  {} {}  {}

  {}
    argon                         {}
    argon \"prompt\"                {}
    argon -p \"prompt\"             {}
    argon -c | -r [id]            {}
    argon gui                     {}

  {}
    -m, --model <provider/model>  -e, --effort <level>  --mode <ask|acceptEdits|auto|plan>  -C, --cwd <dir>

  {}
    login [provider] · logout <provider> · key <provider> <key> · providers · models · limits
    usage · stats · sessions · mcp · skills · commands · memory · config · env · serve
",
        bold(&gradient("Argon")),
        dim(&format!("v{v}")),
        dim("open-source AI agent"),
        bold("Usage"),
        dim("interactive terminal UI"),
        dim("start with a prompt"),
        dim("headless: print the answer and exit (stdin is appended)"),
        dim("continue the last session here / resume one"),
        dim("open the desktop app"),
        bold("Options"),
        bold("Commands (run by the Argon core)")
    );
}

/// Start the desktop app (Tauri) that ships next to this binary.
pub fn launch_desktop() -> bool {
    let dir = std::env::current_exe().ok().and_then(|p| p.parent().map(|p| p.to_path_buf())).unwrap_or_default();
    let names = if cfg!(windows) { vec!["Argon.exe", "argon-desktop.exe"] } else { vec!["argon-desktop", "Argon"] };
    for base in [dir.clone(), dir.join("..")] {
        for n in &names {
            let p = base.join(n);
            if p.is_file() {
                return std::process::Command::new(p).stdin(std::process::Stdio::null()).stdout(std::process::Stdio::null()).stderr(std::process::Stdio::null()).spawn().is_ok();
            }
        }
    }
    false
}

/// Headless mode: run one prompt, stream the answer to stdout, tool activity to stderr.
fn print_mode(c: &Client, cwd: &PathBuf, a: &Args, prompt: String) -> Result<(), String> {
    let (tx, rx) = channel();
    c.events(tx);
    let st = c.get("/settings")?;
    let body = json!({
        "cwd": cwd,
        "model": a.model.clone().unwrap_or_else(|| s(&st["model"], "default").to_string()),
        "effort": a.effort.clone().unwrap_or_else(|| s(&st["model"], "effort").to_string()),
        "mode": a.mode.clone().unwrap_or_else(|| s(&st["permissions"], "mode").to_string()),
        "origin": "cli",
    });
    let p = c.post("/sessions", body)?;
    let sid = s(&p["meta"], "id").to_string();
    // Wait for the WebSocket to be connected before prompting, so no event is lost.
    let t0 = std::time::Instant::now();
    while t0.elapsed() < std::time::Duration::from_secs(5) {
        if let Ok(v) = rx.recv_timeout(std::time::Duration::from_millis(100)) {
            if s(&v, "type") == "hello" {
                break;
            }
        }
    }
    c.action(&sid, "prompt", json!({ "text": prompt }))?;
    let mut out = std::io::stdout();
    let mut errw = std::io::stderr();
    let tty = errw.is_terminal();
    loop {
        let e = rx.recv().map_err(|e| e.to_string())?;
        if e["sessionId"].as_str() != Some(sid.as_str()) {
            continue;
        }
        match s(&e, "type") {
            "message_update" if s(&e["ev"], "type") == "text_delta" => {
                let _ = out.write_all(s(&e["ev"], "delta").as_bytes());
                let _ = out.flush();
            }
            "message_update" if s(&e["ev"], "type") == "text_end" => {
                let _ = writeln!(out);
            }
            "tool_execution_start" if tty => {
                let _ = writeln!(errw, "{}", dim(&format!("⏺ {} {}", s(&e, "toolName"), e["args"].to_string().chars().take(100).collect::<String>())));
            }
            "approval_request" => {
                let _ = writeln!(errw, "{}", err(&format!("✖ {} needs approval: denied in headless mode (use --mode auto)", s(&e, "tool"))));
                let _ = c.action(&sid, "approval", json!({ "id": s(&e, "id"), "choice": "deny" }));
            }
            "question" => {
                let _ = c.action(&sid, "answer", json!({ "id": s(&e, "id"), "answer": "(no answer: headless mode)" }));
            }
            "notice" if s(&e, "level") == "error" => {
                let _ = writeln!(errw, "{}", err(&format!("✖ {}", s(&e, "text"))));
            }
            "agent_end" => break,
            _ => {}
        }
    }
    Ok(())
}

fn main() -> ExitCode {
    let a = parse(std::env::args().skip(1).collect());
    if a.version {
        println!("{}", env!("CARGO_PKG_VERSION"));
        return ExitCode::SUCCESS;
    }
    if a.help {
        help();
        return ExitCode::SUCCESS;
    }
    // Subcommands are implemented by the core's own CLI (login, mcp, env, …).
    let subs = ["login", "logout", "key", "providers", "models", "limits", "usage", "stats", "sessions", "mcp", "skills", "commands", "memory", "config", "env", "serve"];
    if let Some(first) = a.rest.first() {
        if first == "gui" || first == "app" {
            if launch_desktop() {
                println!("\n  {} {} {}\n", accent("●"), bold("Argon"), dim("— desktop app started"));
                return ExitCode::SUCCESS;
            }
            return ExitCode::from(core::run_ts(&std::env::args().skip(1).collect::<Vec<_>>()) as u8);
        }
        if subs.contains(&first.as_str()) {
            return ExitCode::from(core::run_ts(&std::env::args().skip(1).collect::<Vec<_>>()) as u8);
        }
    }

    let cwd = a.cwd.as_ref().map(PathBuf::from).unwrap_or_else(|| std::env::current_dir().unwrap_or_default());
    let cwd = std::fs::canonicalize(&cwd).map(core::plain).unwrap_or(cwd);
    let core = match core::connect() {
        Ok(c) => c,
        Err(e) => {
            eprintln!("\n  {}\n", err(&format!("✖ {e}")));
            return ExitCode::FAILURE;
        }
    };
    let client = Client::new(core.info.port, &core.info.token);

    let mut piped = String::new();
    if !std::io::stdin().is_terminal() && (a.print.is_some() || !a.rest.is_empty()) {
        let _ = std::io::stdin().read_to_string(&mut piped);
    }
    if let Some(p) = &a.print {
        let text = [if p.is_empty() { a.rest.join(" ") } else { p.clone() }, piped].into_iter().filter(|x| !x.is_empty()).collect::<Vec<_>>().join("\n\n");
        if text.is_empty() {
            eprintln!("Nothing to do: pass a prompt to -p");
            return ExitCode::FAILURE;
        }
        return match print_mode(&client, &cwd, &a, text) {
            Ok(_) => ExitCode::SUCCESS,
            Err(e) => {
                eprintln!("{}", err(&format!("✖ {e}")));
                ExitCode::FAILURE
            }
        };
    }
    if !std::io::stdout().is_terminal() {
        eprintln!("Interactive mode needs a terminal. Use argon -p \"…\" for scripts.");
        return ExitCode::FAILURE;
    }
    let prompt = if a.rest.is_empty() { None } else { Some(a.rest.join(" ")) };
    let opts = tui::Opts { cwd, model: a.model.clone(), effort: a.effort.clone(), mode: a.mode.clone(), resume: a.resume.clone(), prompt };
    let r = tui::run(client, opts);
    drop(core);
    match r {
        Ok(_) => ExitCode::SUCCESS,
        Err(e) => {
            let _ = crossterm::terminal::disable_raw_mode();
            eprintln!("{}", err(&format!("✖ {e}")));
            ExitCode::FAILURE
        }
    }
}
