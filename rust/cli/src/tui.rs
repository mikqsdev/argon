//! Interactive full-screen terminal UI.

use crate::ansi::*;
use crate::api::{f, s, Client};
use crate::md::Md;
use crate::screen::{Cursor, Screen};
use crossterm::event::{self, Event, KeyCode, KeyEvent, KeyEventKind, KeyModifiers, MouseEventKind};
use serde_json::{json, Value};
use std::collections::HashMap;
use std::path::{Path, PathBuf};
use std::sync::mpsc::{channel, Receiver};
use std::time::{Duration, Instant};

pub struct Opts {
    pub cwd: PathBuf,
    pub model: Option<String>,
    pub effort: Option<String>,
    pub mode: Option<String>,
    /// Some("") = continue the last session here, Some(id) = that session.
    pub resume: Option<String>,
    pub prompt: Option<String>,
}

#[derive(Clone)]
struct Item {
    label: String,
    detail: String,
    value: String,
}

#[derive(Clone, Copy, PartialEq)]
enum Kind {
    Model,
    Effort,
    Mode,
    Session,
    Settings,
}

struct Picker {
    title: String,
    hint: String,
    items: Vec<Item>,
    sel: usize,
    kind: Kind,
}

const SPIN: [&str; 10] = ["⠋", "⠙", "⠹", "⠸", "⠼", "⠴", "⠦", "⠧", "⠇", "⠏"];
const MODES: [(&str, &str, &str); 4] = [("ask", "Chiedi", "Ask"), ("acceptEdits", "Accetta modifiche", "Accept edits"), ("auto", "Auto", "Auto"), ("plan", "Piano", "Plan")];

pub struct App {
    c: Client,
    rx: Receiver<Value>,
    scr: Screen,
    it: bool,
    cwd: PathBuf,
    settings: Value,
    models: Vec<Value>,
    env: Option<Value>,
    // session
    sid: Option<String>,
    title: String,
    model: String,
    effort: String,
    mode: String,
    ctx_pct: f64,
    cost: f64,
    branch: Option<String>,
    ctx_files: Vec<String>,
    limits: Value,
    todos: Vec<Value>,
    background: Vec<Value>,
    // editor
    text: Vec<char>,
    cur: usize,
    hist: Vec<String>,
    hist_i: Option<usize>,
    suggest: Option<(Vec<Item>, usize)>,
    picker: Option<Picker>,
    approval: Option<(Value, usize)>,
    question: Option<(Value, usize)>,
    extra_cmds: Vec<Item>,
    // run state
    running: bool,
    run_start: Option<Instant>,
    word: String,
    out_tok: usize,
    frame: usize,
    md: Option<Md>,
    thinking: Option<Md>,
    think_start: Option<Instant>,
    subagents: HashMap<String, (String, u32, bool)>,
    last_turn: Option<(u64, f64)>,
    turn_cost0: f64,
    ctrl_c: Option<Instant>,
    warned: (bool, bool),
    quit: bool,
    /// Messages queued with ctrl+enter (sent by the core when the run ends).
    queued: usize,
    /// /btw side questions still being answered.
    btw_running: Vec<String>,
}

fn now_ms() -> f64 {
    std::time::SystemTime::now().duration_since(std::time::UNIX_EPOCH).map(|d| d.as_millis() as f64).unwrap_or(0.0)
}

fn rel_time(ms: f64, it: bool) -> String {
    let m = ((now_ms() - ms) / 60000.0).max(0.0);
    let (n, u) = if m < 1.0 {
        return if it { "ora".into() } else { "now".into() };
    } else if m < 60.0 {
        (m, "m")
    } else if m < 1440.0 {
        (m / 60.0, "h")
    } else {
        (m / 1440.0, if it { "g" } else { "d" })
    };
    format!("{}{u}", n as i64)
}

/// Context files found from the git root (or cwd) down to cwd.
fn context_files(cwd: &Path, init_file: &str) -> Vec<String> {
    let mut found = vec![];
    let mut dirs = vec![];
    let mut d = Some(cwd);
    while let Some(p) = d {
        dirs.push(p.to_path_buf());
        if p.join(".git").exists() {
            break;
        }
        d = p.parent();
    }
    let mut names = vec!["AGENTS.md", "CLAUDE.md", "ARGON.md"];
    if !names.contains(&init_file) {
        names.push(init_file);
    }
    for dir in dirs.iter().rev() {
        for n in &names {
            if dir.join(n).is_file() && !found.contains(&n.to_string()) {
                found.push(n.to_string());
            }
        }
    }
    found
}

fn label(tool: &str, it: bool) -> String {
    let m: &[(&str, &str, &str)] = &[
        ("read", "Leggi", "Read"),
        ("write", "Scrivi", "Write"),
        ("edit", "Modifica", "Edit"),
        ("bash", "Bash", "Bash"),
        ("ls", "Elenca", "List"),
        ("glob", "Cerca file", "Glob"),
        ("grep", "Cerca", "Grep"),
        ("web_search", "Ricerca web", "Web search"),
        ("web_fetch", "Leggi pagina", "Fetch"),
        ("task", "Sub-agente", "Sub-agent"),
        ("memory", "Memoria", "Memory"),
        ("skill", "Skill", "Skill"),
        ("ask_user", "Domanda", "Ask"),
        ("bash_output", "Output", "Output"),
        ("kill_bash", "Termina", "Kill"),
    ];
    m.iter().find(|x| x.0 == tool).map(|x| (if it { x.1 } else { x.2 }).to_string()).unwrap_or_else(|| tool.to_string())
}

fn arg_of(args: &Value) -> String {
    for k in ["command", "path", "pattern", "query", "url", "description", "name"] {
        if let Some(v) = args[k].as_str() {
            return v.replace('\n', " ");
        }
    }
    args.to_string()
}

impl App {
    fn t(&self, it: &str, en: &str) -> String {
        if self.it { it.into() } else { en.into() }
    }
    fn w(&self) -> usize {
        self.scr.cols.max(20)
    }
    fn commit<S: AsRef<str>>(&mut self, lines: &[S]) {
        self.scr.commit(lines);
    }
    fn notice(&mut self, level: &str, msg: &str) {
        let l = match level {
            "error" => err(&format!("✖ {msg}")),
            "warn" => warn(&format!("▲ {msg}")),
            _ => dim(&format!("ℹ {msg}")),
        };
        self.commit(&["".to_string(), format!("  {l}")]);
    }

    fn cli(&self, k: &str) -> &Value {
        &self.settings["cli"][k]
    }

    fn load_settings(&mut self) {
        if let Ok(s) = self.c.get("/settings") {
            self.it = s["cli"]["language"].as_str() != Some("en");
            set_accent(s["cli"]["accent"].as_str().unwrap_or("violet"));
            self.settings = s;
        }
    }

    fn init_file(&self) -> String {
        self.settings["context"]["initFile"].as_str().unwrap_or("ARGON.md").to_string()
    }

    fn model_json(&self) -> Option<&Value> {
        self.models.iter().find(|m| s(m, "key") == self.model)
    }

    fn model_name(&self) -> String {
        self.model_json().map(|m| s(m, "name").to_string()).filter(|n| !n.is_empty()).unwrap_or_else(|| self.model.clone())
    }

    fn effort_label(&self, e: &str) -> String {
        let m: &[(&str, &str, &str)] = &[("off", "spento", "off"), ("minimal", "minimo", "minimal"), ("low", "basso", "low"), ("medium", "medio", "medium"), ("high", "alto", "high"), ("xhigh", "molto alto", "xhigh"), ("max", "massimo", "max")];
        m.iter().find(|x| x.0 == e).map(|x| (if self.it { x.1 } else { x.2 }).to_string()).unwrap_or_else(|| e.to_string())
    }

    fn mode_label(&self, m: &str) -> String {
        MODES.iter().find(|x| x.0 == m).map(|x| (if self.it { x.1 } else { x.2 }).to_string()).unwrap_or_else(|| m.to_string()).to_lowercase()
    }

    // ─────────────────────────── session ───────────────────────────

    fn apply_payload(&mut self, p: &Value) {
        let meta = &p["meta"];
        self.sid = Some(s(meta, "id").to_string());
        self.title = s(meta, "title").to_string();
        self.model = s(meta, "model").to_string();
        self.effort = s(meta, "effort").to_string();
        self.mode = s(meta, "mode").to_string();
        self.ctx_pct = f(&p["context"], "percent");
        self.cost = f(&p["usage"], "cost");
        self.branch = p["git"]["branch"].as_str().map(String::from);
        self.todos = p["todos"].as_array().cloned().unwrap_or_default();
        self.background = p["background"].as_array().cloned().unwrap_or_default();
        self.queued = p["queue"].as_array().map(|a| a.len()).unwrap_or(0);
        self.running = s(p, "status") != "idle" && !s(p, "status").is_empty();
        if let Some(a) = p["pendingApprovals"].as_array().and_then(|a| a.first()) {
            self.approval = Some((a.clone(), 0));
        }
        if let Some(q) = p["pendingQuestions"].as_array().and_then(|a| a.first()) {
            self.question = Some((q.clone(), 0));
        }
    }

    fn refresh(&mut self) {
        let Some(id) = self.sid.clone() else { return };
        if let Ok(p) = self.c.get(&format!("/sessions/{id}")) {
            self.apply_payload(&p);
        }
    }

    /// Create the session on the first message, so empty sessions never pile up.
    fn ensure_session(&mut self) -> Result<String, String> {
        if let Some(id) = &self.sid {
            return Ok(id.clone());
        }
        let p = self.c.post(
            "/sessions",
            json!({ "cwd": self.cwd, "envId": self.env.as_ref().map(|e| e["id"].clone()), "model": self.model, "effort": self.effort, "mode": self.mode, "origin": "cli" }),
        )?;
        self.apply_payload(&p);
        Ok(self.sid.clone().unwrap())
    }

    fn submit(&mut self, text: String) {
        if text.trim().is_empty() {
            return;
        }
        self.scr.scroll_to_bottom();
        self.hist.push(text.clone());
        self.hist_i = None;
        if text.starts_with('/') && self.command(&text) {
            return;
        }
        self.user_block(&text);
        let sid = match self.ensure_session() {
            Ok(id) => id,
            Err(e) => return self.notice("error", &e),
        };
        self.turn_cost0 = self.cost;
        self.running = true;
        self.run_start = Some(Instant::now());
        self.out_tok = 0;
        self.word = self.t("Elaboro", "Working");
        if let Err(e) = self.c.action(&sid, "prompt", json!({ "text": text })) {
            self.running = false;
            self.notice("error", &e);
        }
    }

    /// ctrl+enter: while the agent works the message waits in the core's queue; otherwise it is sent now.
    fn queue_msg(&mut self, text: String) {
        if text.trim().is_empty() {
            return;
        }
        let Some(sid) = self.sid.clone().filter(|_| self.running && !text.starts_with('/')) else {
            return self.submit(text);
        };
        self.hist.push(text.clone());
        self.hist_i = None;
        match self.c.action(&sid, "queue", json!({ "text": text })) {
            Ok(_) => {
                let first = text.lines().next().unwrap_or("").to_string();
                let l = format!("  {} {}", accent("⧗"), dim(&format!("{} {}", self.t("In coda:", "Queued:"), truncate(&first, self.w().saturating_sub(16)))));
                self.commit(&[String::new(), l]);
            }
            Err(e) => self.notice("error", &e),
        }
    }

    fn user_block(&mut self, t: &str) {
        let w = self.w();
        let tm = if self.cli("timestamps").as_bool().unwrap_or(true) {
            let secs = (now_ms() / 1000.0) as i64;
            let local = local_hm(secs);
            dim(&local)
        } else {
            String::new()
        };
        let mut rows = vec![String::new()];
        for (i, l) in t.split('\n').enumerate() {
            // "- item" lines read as a bulleted list.
            let trimmed = l.trim_start();
            let body = match trimmed.strip_prefix("- ").or_else(|| trimmed.strip_prefix("* ")) {
                Some(rest) if !rest.trim().is_empty() => format!("{}{} {}", &l[..l.len() - trimmed.len()], accent("•"), bold(rest)),
                _ => bold(l),
            };
            let left = format!("{}{}", if i == 0 { accent(" ❯ ") } else { "   ".into() }, body);
            let right = if i == 0 && !tm.is_empty() { format!("{tm} ") } else { String::new() };
            for seg in wrap(&left, w.saturating_sub(2 + width(&right))) {
                let line = pad(&seg, w.saturating_sub(1 + width(&right))) + &right;
                rows.push(bg(0x26232f, &line));
            }
        }
        self.commit(&rows);
    }

    fn render_history(&mut self, msgs: &[Value]) {
        for m in msgs {
            match s(m, "role") {
                "user" => {
                    let t = match &m["content"] {
                        Value::String(x) => x.clone(),
                        Value::Array(a) => a.iter().filter_map(|b| b["text"].as_str()).collect::<Vec<_>>().join("\n"),
                        _ => String::new(),
                    };
                    if !t.is_empty() {
                        self.user_block(&t);
                    }
                }
                "assistant" => {
                    for b in m["content"].as_array().cloned().unwrap_or_default() {
                        match s(&b, "type") {
                            "text" if !s(&b, "text").trim().is_empty() => {
                                let mut md = Md::new("  ");
                                let mut lines = vec![String::new()];
                                lines.extend(md.push(s(&b, "text")));
                                lines.extend(md.flush());
                                self.commit(&lines);
                            }
                            "toolCall" => {
                                let name = s(&b, "name").to_string();
                                if name != "todo" {
                                    let a = truncate(&arg_of(&b["arguments"]), self.w().saturating_sub(24));
                                    let line = format!("  {} {} {}", accent("⏺"), bold(&label(&name, self.it)), dim(&a));
                                    self.commit(&[String::new(), line]);
                                }
                            }
                            _ => {}
                        }
                    }
                }
                _ => {}
            }
        }
    }

    fn open_session(&mut self, id: &str) {
        match self.c.get(&format!("/sessions/{id}")) {
            Ok(p) => {
                self.scr.clear();
                self.subagents.clear();
                self.apply_payload(&p);
                let msgs = p["messages"].as_array().cloned().unwrap_or_default();
                self.render_history(&msgs);
                let t = self.title.clone();
                self.notice("info", &format!("{} «{t}»", self.t("Ripresa", "Resumed")));
                self.scr.title(&format!("Argon · {t}"));
            }
            Err(e) => self.notice("error", &e),
        }
    }

    fn sessions(&self) -> Vec<Value> {
        let scope_env = self.settings["cli"]["sessionScope"].as_str() != Some("all");
        let q = match (&self.env, scope_env) {
            (Some(e), true) => format!("/sessions?origin=all&envId={}", s(e, "id")),
            _ => "/sessions?origin=all".to_string(),
        };
        self.c.get(&q).ok().and_then(|v| v.as_array().cloned()).unwrap_or_default()
    }

    // ─────────────────────────── events ───────────────────────────

    fn schedule_live(&mut self) {
        let lines = if let Some(md) = &self.md {
            md.partial()
        } else if let Some(t) = &self.thinking {
            t.partial().into_iter().map(|l| dim(&italic(&l))).collect()
        } else {
            vec![]
        };
        self.scr.set_live(lines);
    }

    fn close_thinking(&mut self) {
        if let Some(mut t) = self.thinking.take() {
            let lines: Vec<String> = t.flush().into_iter().map(|l| dim(&italic(&l))).collect();
            self.scr.clear_live();
            self.commit(&lines);
        }
        if let Some(st) = self.think_start.take() {
            let secs = st.elapsed().as_secs();
            if !self.cli("showThinking").as_bool().unwrap_or(false) {
                let l = format!("  {}", dim(&italic(&format!("✻ {} {secs}s", self.t("Ragionato per", "Thought for")))));
                self.commit(&[String::new(), l]);
            }
        }
    }

    fn on_event(&mut self, e: Value) {
        let typ = s(&e, "type").to_string();
        match typ.as_str() {
            "settings_changed" => {
                self.load_settings();
                return;
            }
            "limits" => {
                self.limits = e["limits"].clone();
                self.check_limits();
                return;
            }
            "models_changed" => {
                if let Ok(m) = self.c.get("/models") {
                    self.models = m.as_array().cloned().unwrap_or_default();
                }
                return;
            }
            _ => {}
        }
        let Some(sid) = &self.sid else { return };
        if e["sessionId"].as_str() != Some(sid.as_str()) {
            return;
        }
        match typ.as_str() {
            "status" => {
                let st = s(&e, "status");
                self.running = st != "idle";
                if st == "compacting" {
                    self.word = self.t("Compatto", "Compacting");
                }
                if self.running && self.run_start.is_none() {
                    self.run_start = Some(Instant::now());
                }
            }
            "message_update" => {
                let ev = &e["ev"];
                let delta = s(ev, "delta").to_string();
                match s(ev, "type") {
                    "text_start" => {
                        self.close_thinking();
                        self.md = Some(Md::new("  "));
                        self.commit(&[""]);
                    }
                    "text_delta" => {
                        self.out_tok += delta.len() / 4 + 1;
                        let done = self.md.as_mut().map(|m| m.push(&delta)).unwrap_or_default();
                        if !done.is_empty() {
                            self.commit(&done);
                        }
                        self.schedule_live();
                    }
                    "text_end" => {
                        if let Some(mut m) = self.md.take() {
                            let rest = m.flush();
                            self.scr.clear_live();
                            self.commit(&rest);
                        }
                    }
                    "thinking_start" => {
                        self.think_start = Some(Instant::now());
                        if self.cli("showThinking").as_bool().unwrap_or(false) {
                            self.thinking = Some(Md::new("  "));
                            let l = format!("  {}", dim(&italic(&format!("✻ {}", self.t("Ragionamento", "Thinking")))));
                            self.commit(&[String::new(), l]);
                        } else {
                            self.word = self.t("Ragiono", "Thinking");
                        }
                    }
                    "thinking_delta" => {
                        self.out_tok += delta.len() / 4 + 1;
                        if let Some(t) = self.thinking.as_mut() {
                            let done: Vec<String> = t.push(&delta).into_iter().map(|l| dim(&italic(&l))).collect();
                            if !done.is_empty() {
                                self.commit(&done);
                            }
                            self.schedule_live();
                        }
                    }
                    "thinking_end" => self.close_thinking(),
                    _ => {}
                }
            }
            "tool_execution_start" => {
                let name = s(&e, "toolName").to_string();
                if name != "todo" {
                    let a = truncate(&arg_of(&e["args"]), self.w().saturating_sub(24));
                    let line = format!("  {} {} {}", accent("⏺"), bold(&label(&name, self.it)), dim(&a));
                    self.commit(&[String::new(), line]);
                    self.word = label(&name, self.it);
                }
            }
            "tool_execution_end" => {
                let name = s(&e, "toolName").to_string();
                if name != "todo" {
                    self.render_result(&name, &e["result"], e["isError"].as_bool().unwrap_or(false));
                }
            }
            "todos" => {
                self.todos = e["todos"].as_array().cloned().unwrap_or_default();
                let lines = self.todo_lines();
                let mut v = vec![String::new()];
                v.extend(lines);
                self.commit(&v);
            }
            "subagent" => {
                let id = s(&e, "toolCallId").to_string();
                let agent = s(&e, "agent").to_string();
                match s(&e, "phase") {
                    "start" => {
                        self.subagents.insert(id, (agent.clone(), 0, false));
                        let l = format!("    {} {} {}", dim("↳"), accent(&agent), dim(s(&e, "model")));
                        self.commit(&[l]);
                    }
                    "step" => {
                        if let Some(x) = self.subagents.get_mut(&id) {
                            x.1 += 1;
                        }
                        let t = truncate(s(&e, "text"), self.w().saturating_sub(30));
                        let l = format!("      {} {} {}", dim("·"), dim(&label(s(&e, "tool"), self.it)), dim(&t));
                        self.commit(&[l]);
                    }
                    "end" => {
                        if let Some(x) = self.subagents.get_mut(&id) {
                            x.2 = true;
                        }
                        let n = e["steps"].as_u64().unwrap_or(0);
                        let l = format!("    {}", dim(&format!("↳ {agent}: {n} {}", self.t("passi", "steps"))));
                        self.commit(&[l]);
                    }
                    _ => {}
                }
            }
            "background" => self.background = e["processes"].as_array().cloned().unwrap_or_default(),
            "queue" => {
                self.queued = e["queue"].as_array().map(|a| a.len()).unwrap_or(0);
                // The core sent a queued message: show it like a typed one.
                if let Some(t) = e["sent"]["text"].as_str().map(|t| t.to_string()) {
                    self.user_block(&t);
                    self.turn_cost0 = self.cost;
                    self.out_tok = 0;
                    self.word = self.t("Elaboro", "Working");
                }
            }
            "btw" => {
                let b = &e["btw"];
                let id = s(b, "id").to_string();
                let st = s(b, "status");
                if st != "running" && self.btw_running.contains(&id) {
                    self.btw_running.retain(|x| x != &id);
                    let mut lines = vec![String::new(), format!("  {} {}", accent("/btw"), bold(&truncate(s(b, "question"), self.w().saturating_sub(12))))];
                    if st == "error" && s(b, "text").is_empty() {
                        lines.push(format!("    {}", err(&format!("✖ {}", s(b, "error")))));
                    } else {
                        let mut md = Md::new("  │ ");
                        lines.extend(md.push(s(b, "text")));
                        lines.extend(md.flush());
                    }
                    self.commit(&lines);
                }
            }
            "approval_request" => {
                self.approval = Some((e.clone(), 0));
                self.scr.bell();
            }
            "approval_resolved" => {
                if self.approval.as_ref().map(|a| s(&a.0, "id") == s(&e, "id")).unwrap_or(false) {
                    self.approval = None;
                }
            }
            "question" => {
                self.question = Some((e.clone(), 0));
                self.text.clear();
                self.cur = 0;
            }
            "question_resolved" => self.question = None,
            "notice" => {
                let (lvl, txt) = (s(&e, "level").to_string(), s(&e, "text").to_string());
                self.notice(&lvl, &txt);
            }
            "meta" => {
                self.title = s(&e["meta"], "title").to_string();
                self.model = s(&e["meta"], "model").to_string();
                self.effort = s(&e["meta"], "effort").to_string();
                self.mode = s(&e["meta"], "mode").to_string();
                let t = self.title.clone();
                self.scr.title(&format!("Argon · {t}"));
            }
            "agent_end" => {
                self.close_thinking();
                if let Some(mut m) = self.md.take() {
                    let rest = m.flush();
                    self.scr.clear_live();
                    self.commit(&rest);
                }
                self.running = false;
                let secs = self.run_start.take().map(|t| t.elapsed().as_secs()).unwrap_or(0);
                self.refresh();
                self.last_turn = Some((secs, self.cost - self.turn_cost0));
            }
            _ => {}
        }
    }

    fn render_result(&mut self, name: &str, r: &Value, is_err: bool) {
        let text: String = r["content"].as_array().map(|a| a.iter().map(|c| c["text"].as_str().unwrap_or("[image]")).collect::<Vec<_>>().join("\n")).unwrap_or_default();
        let d = &r["details"];
        let pre = format!("    {}  ", dim("⎿"));
        if is_err {
            let t: String = text.lines().take(4).collect::<Vec<_>>().join(" ").chars().take(400).collect();
            return self.commit(&[pre + &err(&t)]);
        }
        if name == "edit" && d["diff"].is_object() {
            let mut v = vec![format!("{pre}{} {}", ok(&format!("+{}", d["added"])), err(&format!("-{}", d["removed"])))];
            for l in s(&d["diff"], "old").lines().take(5) {
                v.push(format!("       {}", bg(0x3b1219, &fg(0xfca5a5, &format!("- {l}")))));
            }
            for l in s(&d["diff"], "new").lines().take(5) {
                v.push(format!("       {}", bg(0x0f2e1a, &fg(0x86efac, &format!("+ {l}")))));
            }
            return self.commit(&v);
        }
        if name == "read" {
            let n = d["lines"].as_u64().map(|n| n.to_string()).unwrap_or("?".into());
            return self.commit(&[format!("{pre}{}", dim(&format!("{n} {}", self.t("righe", "lines"))))]);
        }
        if name == "task" {
            return;
        }
        let lines: Vec<&str> = text.lines().collect();
        let max = if name == "bash" { 6 } else { 3 };
        let mut v = vec![format!("{pre}{}", dim(lines.first().copied().unwrap_or("")))];
        for l in lines.iter().skip(1).take(max - 1) {
            v.push(format!("       {}", dim(l)));
        }
        if lines.len() > max {
            v.push(format!("       {}", dim(&format!("… +{} {}", lines.len() - max, self.t("righe", "lines")))));
        }
        self.commit(&v);
    }

    fn todo_lines(&self) -> Vec<String> {
        self.todos
            .iter()
            .map(|t| {
                let c = s(t, "content");
                match s(t, "status") {
                    "completed" => format!("    {} {}", ok("✔"), dim(&strike(c))),
                    "in_progress" => format!("    {} {}", accent("◐"), bold(c)),
                    _ => format!("    {} {c}", dim("○")),
                }
            })
            .collect()
    }

    fn check_limits(&mut self) {
        if !self.limits["enabled"].as_bool().unwrap_or(false) || !self.cli("notifyLimits").as_bool().unwrap_or(true) {
            return;
        }
        let warn_at = self.limits["warnAt"].as_f64().unwrap_or(80.0);
        let pct = f(&self.limits["fiveHour"], "percent").max(f(&self.limits["weekly"], "percent"));
        if pct >= 100.0 && !self.warned.1 {
            self.warned.1 = true;
            self.scr.bell();
            let m = self.t("Limite di utilizzo raggiunto", "Usage limit reached");
            self.notice("error", &m);
        } else if pct >= warn_at && !self.warned.0 {
            self.warned.0 = true;
            self.scr.bell();
            let m = format!("{} {pct:.0}%", self.t("Vicino al limite di utilizzo:", "Close to the usage limit:"));
            self.notice("warn", &m);
        }
    }

    // ─────────────────────────── drawing ───────────────────────────

    fn box_top(&self, title: &str) -> String {
        let w = self.w() - 2;
        if title.is_empty() {
            return dim(&format!("╭{}╮", "─".repeat(w)));
        }
        let t = format!(" {title} ");
        format!("{}{}{}", dim("╭─"), t, dim(&format!("{}╮", "─".repeat(w.saturating_sub(1 + width(&t))))))
    }
    fn box_row(&self, s: &str) -> String {
        let w = self.w() - 4;
        format!("{} {} {}", dim("│"), pad(s, w), dim("│"))
    }
    fn box_bottom(&self, lab: &str) -> String {
        let w = self.w() - 2;
        if lab.is_empty() {
            return dim(&format!("╰{}╯", "─".repeat(w)));
        }
        let l = format!(" {lab} ");
        format!("{}{}{}", dim(&format!("╰{}", "─".repeat(w.saturating_sub(1 + width(&l))))), l, dim("─╯"))
    }

    /// Editor text wrapped to `w`; returns lines and cursor (row, col).
    fn editor_lines(&self, w: usize) -> (Vec<String>, usize, usize) {
        let placeholder = self.picker.is_none() && self.question.is_none() && self.text.is_empty();
        if placeholder {
            let p = self.t("Scrivi un messaggio, / per i comandi, @ per i file", "Type a message, / for commands, @ for files");
            return (vec![format!("{} {}", accent("❯"), dim(&p))], 0, 2);
        }
        let mut lines = vec![];
        let (mut row, mut col) = (0, 2);
        let mut line = String::new();
        let mut lw = 0;
        let prefix = |first: bool| if first { accent("❯") + " " } else { "  ".to_string() };
        line += &prefix(true);
        lw += 2;
        for (i, ch) in self.text.iter().enumerate() {
            if i == self.cur {
                row = lines.len();
                col = lw;
            }
            if *ch == '\n' {
                lines.push(std::mem::take(&mut line));
                line = prefix(false);
                lw = 2;
                continue;
            }
            let cw = char_width(*ch);
            if lw + cw > w {
                lines.push(std::mem::take(&mut line));
                line = prefix(false);
                lw = 2;
                if i == self.cur {
                    row = lines.len();
                    col = lw;
                }
            }
            line.push(*ch);
            lw += cw;
        }
        if self.cur >= self.text.len() {
            if lw >= w {
                lines.push(std::mem::take(&mut line));
                line = prefix(false);
                lw = 2;
            }
            row = lines.len();
            col = lw;
        }
        lines.push(line);
        (lines, row, col)
    }

    fn status_line(&self) -> String {
        if self.running {
            let el = self.run_start.map(|t| t.elapsed().as_secs()).unwrap_or(0);
            let sp = if self.cli("animations").as_bool().unwrap_or(true) { SPIN[self.frame % SPIN.len()] } else { "●" };
            let esc_hint = self.t("esc per fermare", "esc to stop");
            return format!(" {} {} {}", accent(sp), bold(&format!("{}…", self.word)), dim(&format!("{el}s · ↓ {} tok · {esc_hint}", tokens(self.out_tok as f64))));
        }
        if let Some((secs, cost)) = self.last_turn {
            return format!(" {}", dim(&format!("✻ {} {secs}s · ${cost:.3}", self.t("Fatto in", "Done in"))));
        }
        String::new()
    }

    fn info_line(&self) -> String {
        let env = self.env.as_ref().map(|e| s(e, "name").to_string()).unwrap_or_else(|| self.cwd.file_name().map(|n| n.to_string_lossy().to_string()).unwrap_or_default());
        let mut left = format!(" {} {}", accent("◆"), bold(&env));
        left += &dim(&format!(" · {}", self.cwd.display()));
        if let Some(b) = &self.branch {
            left += &dim(&format!(" · ⎇ {b}"));
        }
        if !self.ctx_files.is_empty() {
            left += &dim(&format!(" · {}", self.ctx_files.join(", ")));
        }
        let mut right = dim(&format!("ctx {:.0}% · ${:.3} ", self.ctx_pct, self.cost));
        let running_bg = self.background.iter().filter(|p| p["running"].as_bool().unwrap_or(false)).count();
        let running_sa = self.subagents.values().filter(|x| !x.2).count();
        if running_sa > 0 {
            right = format!("{} {right}", accent(&format!("⑂ {running_sa}")));
        }
        if !self.btw_running.is_empty() {
            right = format!("{} {right}", accent(&format!("/btw {}", self.btw_running.len())));
        }
        if self.queued > 0 {
            right = format!("{} {right}", accent(&format!("⧗ {}", self.queued)));
        }
        if running_bg > 0 {
            right = format!("{} {right}", accent(&format!("▤ {running_bg}")));
        }
        if self.limits["enabled"].as_bool().unwrap_or(false) {
            let a = f(&self.limits["fiveHour"], "percent");
            let b = f(&self.limits["weekly"], "percent");
            right += &format!("{} {}", ring(a.max(b)), dim(&format!("· 5h {a:.0}% · {} {b:.0}%", self.t("sett.", "week"))));
        }
        let w = self.w();
        let lw = w.saturating_sub(width(&right) + 2);
        format!("{}  {right}", pad(&left, lw))
    }

    fn hints_line(&self) -> String {
        let h = if self.approval.is_some() {
            self.t("←→ scegli · invio conferma · y sì · a sempre · n no", "←→ choose · enter confirm · y yes · a always · n no")
        } else if self.picker.is_some() {
            self.t("↑↓ scegli · scrivi per cercare · invio conferma · esc chiudi", "↑↓ choose · type to search · enter confirm · esc close")
        } else if self.running {
            self.t("invio:invia ora  │  ctrl+invio:in coda  │  /btw:domanda a parte  │  esc:ferma", "enter:send now  │  ctrl+enter:queue  │  /btw:side question  │  esc:stop")
        } else {
            self.t("shift+tab:modalità  │  esc:ferma  │  /:comandi  │  @:file  │  ctrl+c:esci", "shift+tab:mode  │  esc:stop  │  /:commands  │  @:files  │  ctrl+c:quit")
        };
        if let Some(t) = self.ctrl_c {
            if t.elapsed() < Duration::from_secs(2) {
                return format!(" {}", warn(&self.t("Premi di nuovo Ctrl+C per uscire", "Press Ctrl+C again to quit")));
            }
        }
        format!(" {}", dim(&h))
    }

    fn list_panel(&self, items: &[Item], sel: usize, max: usize) -> Vec<String> {
        if items.is_empty() {
            return vec![format!("   {}", dim(&self.t("Nessun risultato", "No results")))];
        }
        let start = sel.saturating_sub(max - 1).min(items.len().saturating_sub(max));
        let lw = items.iter().map(|i| width(&i.label)).max().unwrap_or(10).min(40) + 2;
        let mut v: Vec<String> = items
            .iter()
            .enumerate()
            .skip(start)
            .take(max)
            .map(|(i, it)| {
                let l = pad(&it.label, lw);
                if i == sel {
                    format!(" {} {} {}", accent("❯"), bold(&accent(&l)), dim(&it.detail))
                } else {
                    format!("   {l} {}", dim(&it.detail))
                }
            })
            .collect();
        if items.len() > max {
            v.push(dim(&format!("   {}/{}", sel + 1, items.len())));
        }
        v
    }

    fn filtered(&self) -> Vec<Item> {
        let Some(p) = &self.picker else { return vec![] };
        let q: String = self.text.iter().collect::<String>().to_lowercase();
        let words: Vec<&str> = q.split_whitespace().collect();
        p.items.iter().filter(|i| { let h = format!("{} {} {}", i.label, i.detail, i.value).to_lowercase(); words.iter().all(|w| h.contains(w)) }).cloned().collect()
    }

    fn render(&mut self) {
        let mut lines = vec![self.status_line()];
        let mut cursor = None;
        let inner = self.w() - 4;
        if let Some((e, sel)) = &self.approval {
            let tool = s(e, "tool");
            lines.push(warn(&self.box_top(&format!("⚠ {} · {}", self.t("Permesso richiesto", "Permission needed"), label(tool, self.it)))));
            let a = &e["args"];
            let body = match tool {
                "bash" => format!("$ {}", s(a, "command")),
                "write" => format!("{} ({} {})", s(a, "path"), s(a, "content").lines().count(), self.t("righe", "lines")),
                "edit" => s(a, "path").to_string(),
                _ => a.to_string(),
            };
            let body: String = body.chars().take(400).collect();
            for l in wrap(&body, inner).into_iter().take(4) {
                lines.push(self.box_row(&l));
            }
            if let Some(out) = e["outside"].as_array().filter(|a| !a.is_empty()) {
                let dirs: Vec<&str> = out.iter().filter_map(|x| x.as_str()).collect();
                lines.push(self.box_row(&(warn(&format!("{} «{}»: ", self.t("Scrive fuori dall'ambiente", "Writes outside the environment"), s(e, "envName"))) + &dim(&dirs.join(", ")))));
            }
            let always = if e["outside"].is_array() { self.t("(questa cartella)", "(this folder)") } else { s(e, "suggestion").to_string() };
            let opts = [self.t("Sì", "Yes"), format!("{} {}", self.t("Sempre", "Always"), dim(&always)), "No".to_string()];
            let row = opts.iter().enumerate().map(|(i, o)| if i == *sel { bg(0x3b2f55, &bold(&format!(" {o} "))) } else { format!(" {o} ") }).collect::<Vec<_>>().join("   ");
            lines.push(self.box_row(&row));
            lines.push(warn(&self.box_bottom("")));
        } else {
            if let Some((q, sel)) = &self.question {
                lines.push(self.box_top(&format!("{}{}", accent("? "), bold(&self.t("Domanda", "Question")))));
                for l in wrap(s(q, "question"), inner) {
                    lines.push(self.box_row(&l));
                }
                for (i, o) in q["options"].as_array().cloned().unwrap_or_default().iter().enumerate() {
                    let o = o.as_str().unwrap_or("");
                    lines.push(self.box_row(&if i == *sel { format!("{}{}", accent("❯ "), bold(o)) } else { format!("  {o}") }));
                }
            } else {
                let t = self.picker.as_ref().map(|p| p.title.clone()).unwrap_or_default();
                lines.push(self.box_top(&t));
            }
            let (ed, row, col) = self.editor_lines(inner);
            let start = lines.len();
            for l in &ed {
                lines.push(self.box_row(l));
            }
            cursor = Some(Cursor { row: start + row, col: 2 + col });
            let lab = if self.picker.is_some() {
                self.t("cerca", "search")
            } else {
                format!("{} ({}) · {}", self.model_name(), self.effort_label(&self.effort), self.mode_label(&self.mode))
            };
            lines.push(self.box_bottom(&dim(&lab)));
        }
        if self.picker.is_some() {
            let items = self.filtered();
            let p = self.picker.as_mut().unwrap();
            p.sel = p.sel.min(items.len().saturating_sub(1));
            let (sel, hint) = (p.sel, p.hint.clone());
            if !hint.is_empty() {
                lines.push(dim(&format!("  {hint}")));
            }
            let max = (self.scr.rows / 2).clamp(5, 14);
            lines.extend(self.list_panel(&items, sel, max));
        } else if let Some((items, sel)) = &self.suggest {
            lines.extend(self.list_panel(items, *sel, 8));
        }
        if self.cli("statusBar").as_bool().unwrap_or(true) {
            lines.push(self.info_line());
        }
        lines.push(self.hints_line());
        let cur = if self.approval.is_some() { None } else { cursor };
        self.scr.set_bottom(lines, cur);
    }

    // ─────────────────────────── input ───────────────────────────

    fn commands(&self) -> Vec<Item> {
        let c = |n: &str, it: &str, en: &str| Item { label: format!("/{n}"), detail: if self.it { it.into() } else { en.into() }, value: n.into() };
        let init = self.init_file();
        let mut v = vec![
            c("help", "Comandi e scorciatoie", "Commands and shortcuts"),
            c("new", "Nuova sessione", "New session"),
            c("resume", "Riprendi una sessione", "Resume a session"),
            c("sessions", "Elenco sessioni", "List sessions"),
            c("search", "Cerca nelle sessioni", "Search sessions"),
            c("rename", "Rinomina la sessione", "Rename the session"),
            c("pin", "Fissa / sblocca la sessione", "Pin / unpin the session"),
            c("archive", "Archivia la sessione", "Archive the session"),
            c("delete", "Elimina la sessione", "Delete the session"),
            c("export", "Esporta in Markdown", "Export to Markdown"),
            c("clear", "Svuota la conversazione", "Clear the conversation"),
            c("compact", "Riassumi il contesto", "Summarise the context"),
            c("undo", "Annulla l'ultimo turno", "Undo the last turn"),
            c("todos", "Lista attività", "Task list"),
            c("context", "Uso del contesto", "Context usage"),
            c("btw", "Domanda a parte: risponde un sub-agente", "Side question: a sub-agent answers"),
            c("model", "Cambia modello", "Change model"),
            c("effort", "Livello di ragionamento", "Reasoning level"),
            c("mode", "Modalità permessi", "Permission mode"),
            c("usage", "Uso per modello, provider e sub-agente", "Usage per model, provider and sub-agent"),
            c("limits", "Limiti e spesa", "Limits and spend"),
            c("stats", "Statistiche", "Statistics"),
            c("subagents", "Sub-agenti della sessione", "Session sub-agents"),
            c("bgterminals", "Terminali in background", "Background terminals"),
            Item { label: "/init".into(), detail: if self.it { format!("Crea {init} analizzando il progetto") } else { format!("Create {init} by analyzing the project") }, value: "init".into() },
            c("pr", "Apri una pull request", "Open a pull request"),
            c("github", "Stato GitHub", "GitHub status"),
            c("login", "Collega un provider", "Connect a provider"),
            c("logout", "Scollega un provider", "Disconnect a provider"),
            c("providers", "Provider e account", "Providers and accounts"),
            c("mcp", "Server MCP", "MCP servers"),
            c("agents", "Sub-agenti disponibili", "Available sub-agents"),
            c("skills", "Skill", "Skills"),
            c("memory", "Memoria", "Memory"),
            c("hooks", "Hook configurati", "Configured hooks"),
            c("env", "Ambienti", "Environments"),
            c("settings", "Impostazioni della CLI", "CLI settings"),
            c("gui", "Apri l'app desktop", "Open the desktop app"),
            c("exit", "Esci", "Quit"),
        ];
        v.extend(self.extra_cmds.iter().cloned());
        v
    }

    fn update_suggest(&mut self) {
        let t: String = self.text.iter().collect();
        if t.starts_with('/') && !t.contains(' ') && self.picker.is_none() {
            let q = t[1..].to_lowercase();
            let items: Vec<Item> = self.commands().into_iter().filter(|c| c.value.to_lowercase().contains(&q) || c.detail.to_lowercase().contains(&q)).collect();
            let sel = self.suggest.as_ref().map(|s| s.1).unwrap_or(0).min(items.len().saturating_sub(1));
            self.suggest = if items.is_empty() { None } else { Some((items, sel)) };
        } else {
            self.suggest = None;
        }
    }

    fn set_text(&mut self, t: &str) {
        self.text = t.chars().collect();
        self.cur = self.text.len();
        self.update_suggest();
    }

    fn insert(&mut self, s: &str) {
        for ch in s.chars() {
            let ch = if ch == '\r' { '\n' } else { ch };
            self.text.insert(self.cur, ch);
            self.cur += 1;
        }
        self.update_suggest();
        if let Some(p) = self.picker.as_mut() {
            p.sel = 0;
        }
    }

    fn pick(&mut self, kind: Kind, title: String, hint: String, items: Vec<Item>, current: &str) {
        let sel = items.iter().position(|i| i.value == current).unwrap_or(0);
        self.text.clear();
        self.cur = 0;
        self.suggest = None;
        self.picker = Some(Picker { title, hint, items, sel, kind });
    }

    fn picked(&mut self, kind: Kind, value: String) {
        match kind {
            Kind::Model => self.set_option("model", &value),
            Kind::Effort => self.set_option("effort", &value),
            Kind::Mode => self.set_option("mode", &value),
            Kind::Session => self.open_session(&value),
            Kind::Settings => self.toggle_setting(&value),
        }
    }

    /// Change model / effort / mode: on the live session, or as the default for the next one.
    fn set_option(&mut self, what: &str, value: &str) {
        match what {
            "model" => self.model = value.to_string(),
            "effort" => self.effort = value.to_string(),
            _ => self.mode = value.to_string(),
        }
        if let Some(id) = self.sid.clone() {
            match self.c.action(&id, what, json!({ what: value })) {
                Ok(p) => self.apply_payload(&p),
                Err(e) => self.notice("error", &e),
            }
        } else {
            // No session yet: remember it as the shared default, like the GUI does.
            let mut st = self.settings.clone();
            match what {
                "model" => st["model"]["default"] = json!(value),
                "effort" => st["model"]["effort"] = json!(value),
                _ => st["permissions"]["mode"] = json!(value),
            }
            if let Ok(s2) = self.c.put_settings(&st) {
                self.settings = s2;
            }
            if what == "model" {
                if let Some(m) = self.model_json() {
                    let d = s(m, "defaultEffort").to_string();
                    let levels: Vec<String> = m["levels"].as_array().map(|a| a.iter().filter_map(|x| x.as_str().map(String::from)).collect()).unwrap_or_default();
                    if !levels.contains(&self.effort) && !d.is_empty() {
                        self.effort = d;
                    }
                }
            }
        }
        let msg = match what {
            "model" => format!("{} {}", self.t("Modello:", "Model:"), self.model_name()),
            "effort" => format!("{} {}", self.t("Ragionamento:", "Reasoning:"), self.effort_label(value)),
            _ => format!("{} {}", self.t("Modalità:", "Mode:"), self.mode_label(value)),
        };
        self.notice("info", &msg);
    }

    fn toggle_setting(&mut self, key: &str) {
        let mut st = self.settings.clone();
        let cur = st["cli"][key].clone();
        let next = match key {
            "language" => json!(if cur == "it" { "en" } else { "it" }),
            "sessionScope" => json!(if cur == "all" { "environment" } else { "all" }),
            "accent" => {
                let order = ["violet", "cyan", "green", "amber", "rose"];
                let i = order.iter().position(|x| cur == *x).unwrap_or(0);
                json!(order[(i + 1) % order.len()])
            }
            _ => json!(!cur.as_bool().unwrap_or(false)),
        };
        st["cli"][key] = next;
        match self.c.put_settings(&st) {
            Ok(_) => {
                self.load_settings();
                self.cmd_settings();
                if let Some(p) = self.picker.as_mut() {
                    p.sel = p.items.iter().position(|i| i.value == key).unwrap_or(0);
                }
            }
            Err(e) => self.notice("error", &e),
        }
    }

    fn on_key(&mut self, k: KeyEvent) {
        let ctrl = k.modifiers.contains(KeyModifiers::CONTROL);
        let alt = k.modifiers.contains(KeyModifiers::ALT);
        if ctrl && k.code == KeyCode::Char('c') {
            if !self.text.is_empty() || self.picker.is_some() {
                self.text.clear();
                self.cur = 0;
                self.picker = None;
                self.suggest = None;
            } else if self.running {
                self.abort();
            } else if self.ctrl_c.map(|t| t.elapsed() < Duration::from_secs(2)).unwrap_or(false) {
                self.quit = true;
            } else {
                self.ctrl_c = Some(Instant::now());
            }
            return;
        }
        if ctrl && k.code == KeyCode::Char('d') && self.text.is_empty() {
            self.quit = true;
            return;
        }
        if ctrl && k.code == KeyCode::Char('l') {
            self.scr.clear();
            return;
        }
        // Approval panel.
        if let Some((e, sel)) = self.approval.clone() {
            let choice = match k.code {
                KeyCode::Left | KeyCode::Up => {
                    self.approval = Some((e, (sel + 2) % 3));
                    None
                }
                KeyCode::Right | KeyCode::Down | KeyCode::Tab => {
                    self.approval = Some((e, (sel + 1) % 3));
                    None
                }
                KeyCode::Enter => Some(["allow", "always", "deny"][sel]),
                KeyCode::Char('y') => Some("allow"),
                KeyCode::Char('a') => Some("always"),
                KeyCode::Char('n') | KeyCode::Esc => Some("deny"),
                _ => None,
            };
            if let (Some(ch), Some(id)) = (choice, self.sid.clone()) {
                let aid = s(&self.approval.as_ref().unwrap().0, "id").to_string();
                self.approval = None;
                if let Err(er) = self.c.action(&id, "approval", json!({ "id": aid, "choice": ch })) {
                    self.notice("error", &er);
                }
            }
            return;
        }
        // Question with options.
        if let Some((q, sel)) = self.question.clone() {
            let n = q["options"].as_array().map(|a| a.len()).unwrap_or(0);
            match k.code {
                KeyCode::Up if n > 0 => {
                    self.question = Some((q, (sel + n - 1) % n));
                    return;
                }
                KeyCode::Down if n > 0 => {
                    self.question = Some((q, (sel + 1) % n));
                    return;
                }
                KeyCode::Enter => {
                    let typed: String = self.text.iter().collect();
                    let ans = if !typed.trim().is_empty() || n == 0 { typed } else { q["options"][sel].as_str().unwrap_or("").to_string() };
                    self.text.clear();
                    self.cur = 0;
                    self.question = None;
                    if let Some(id) = self.sid.clone() {
                        let _ = self.c.action(&id, "answer", json!({ "id": s(&q, "id"), "answer": ans }));
                    }
                    return;
                }
                _ => {}
            }
        }
        match k.code {
            KeyCode::Esc => {
                if self.picker.is_some() || self.suggest.is_some() {
                    self.picker = None;
                    self.suggest = None;
                    self.text.clear();
                    self.cur = 0;
                } else if self.running {
                    self.abort();
                }
            }
            KeyCode::BackTab => {
                let i = MODES.iter().position(|m| m.0 == self.mode).unwrap_or(0);
                let next = MODES[(i + 1) % MODES.len()].0.to_string();
                self.set_option("mode", &next);
            }
            // ctrl+enter (some terminals send it as ctrl+j): queue the message for when the agent is done.
            KeyCode::Enter | KeyCode::Char('j') if ctrl && self.picker.is_none() => {
                let t: String = self.text.iter().collect();
                self.text.clear();
                self.cur = 0;
                self.suggest = None;
                self.queue_msg(t);
            }
            KeyCode::Enter if alt || k.modifiers.contains(KeyModifiers::SHIFT) => self.insert("\n"),
            KeyCode::Enter => {
                if let Some(p) = &self.picker {
                    let items = self.filtered();
                    if let Some(it) = items.get(p.sel).cloned() {
                        let kind = p.kind;
                        self.picker = None;
                        self.text.clear();
                        self.cur = 0;
                        self.picked(kind, it.value);
                    }
                    return;
                }
                if let Some((items, sel)) = &self.suggest {
                    if let Some(it) = items.get(*sel) {
                        let cmd = format!("/{}", it.value);
                        self.suggest = None;
                        self.text.clear();
                        self.cur = 0;
                        self.submit(cmd);
                    }
                    return;
                }
                if self.cur > 0 && self.text.get(self.cur - 1) == Some(&'\\') {
                    self.text.remove(self.cur - 1);
                    self.cur -= 1;
                    self.insert("\n");
                    return;
                }
                let t: String = self.text.iter().collect();
                self.text.clear();
                self.cur = 0;
                self.suggest = None;
                self.submit(t);
            }
            KeyCode::Tab => {
                if let Some((items, sel)) = &self.suggest {
                    if let Some(it) = items.get(*sel) {
                        let t = format!("/{} ", it.value);
                        self.set_text(&t);
                        self.suggest = None;
                    }
                }
            }
            KeyCode::Up => {
                if let Some(p) = self.picker.as_mut() {
                    p.sel = p.sel.saturating_sub(1);
                } else if let Some((items, sel)) = self.suggest.as_mut() {
                    *sel = if *sel == 0 { items.len() - 1 } else { *sel - 1 };
                } else if !self.hist.is_empty() && !self.text.contains(&'\n') {
                    let i = self.hist_i.map(|i| i.saturating_sub(1)).unwrap_or(self.hist.len() - 1);
                    self.hist_i = Some(i);
                    let h = self.hist[i].clone();
                    self.set_text(&h);
                    self.suggest = None;
                }
            }
            KeyCode::Down => {
                if let Some(p) = self.picker.as_mut() {
                    p.sel += 1;
                } else if let Some((items, sel)) = self.suggest.as_mut() {
                    *sel = (*sel + 1) % items.len();
                } else if let Some(i) = self.hist_i {
                    if i + 1 < self.hist.len() {
                        self.hist_i = Some(i + 1);
                        let h = self.hist[i + 1].clone();
                        self.set_text(&h);
                    } else {
                        self.hist_i = None;
                        self.set_text("");
                    }
                    self.suggest = None;
                }
            }
            KeyCode::PageUp => {
                if let Some(p) = self.picker.as_mut() {
                    p.sel = p.sel.saturating_sub(10);
                } else {
                    let n = self.scr.page();
                    self.scr.scroll_by(n);
                }
            }
            KeyCode::PageDown => {
                if let Some(p) = self.picker.as_mut() {
                    p.sel += 10;
                } else {
                    let n = self.scr.page();
                    self.scr.scroll_by(-n);
                }
            }
            KeyCode::Left => self.cur = self.cur.saturating_sub(1),
            KeyCode::Right => self.cur = (self.cur + 1).min(self.text.len()),
            KeyCode::Home => self.cur = 0,
            KeyCode::End => self.cur = self.text.len(),
            KeyCode::Backspace => {
                if self.cur > 0 {
                    self.cur -= 1;
                    self.text.remove(self.cur);
                    self.update_suggest();
                }
            }
            KeyCode::Delete => {
                if self.cur < self.text.len() {
                    self.text.remove(self.cur);
                    self.update_suggest();
                }
            }
            KeyCode::Char('a') if ctrl => self.cur = 0,
            KeyCode::Char('e') if ctrl => self.cur = self.text.len(),
            KeyCode::Char('u') if ctrl => {
                self.text.drain(..self.cur);
                self.cur = 0;
                self.update_suggest();
            }
            KeyCode::Char('w') if ctrl => {
                let mut i = self.cur;
                while i > 0 && self.text[i - 1] == ' ' {
                    i -= 1;
                }
                while i > 0 && self.text[i - 1] != ' ' {
                    i -= 1;
                }
                self.text.drain(i..self.cur);
                self.cur = i;
                self.update_suggest();
            }
            KeyCode::Char(ch) if !ctrl => {
                self.ctrl_c = None;
                self.insert(&ch.to_string());
            }
            _ => {}
        }
    }

    fn abort(&mut self) {
        if let Some(id) = self.sid.clone() {
            let _ = self.c.action(&id, "abort", json!({}));
            let m = self.t("Interrotto", "Stopped");
            self.notice("warn", &m);
        }
    }

    // ─────────────────────────── commands ───────────────────────────

    /// Handle a slash command. Returns false when it should be sent to the agent instead
    /// (custom commands and skills expand on the core).
    fn command(&mut self, line: &str) -> bool {
        let (name, arg) = match line[1..].split_once(' ') {
            Some((n, a)) => (n.to_string(), a.trim().to_string()),
            None => (line[1..].trim().to_string(), String::new()),
        };
        match name.as_str() {
            "help" | "?" => self.cmd_help(),
            "exit" | "quit" | "q" => self.quit = true,
            "new" => {
                self.sid = None;
                self.title.clear();
                self.subagents.clear();
                self.todos.clear();
                self.ctx_pct = 0.0;
                self.cost = 0.0;
                self.last_turn = None;
                self.scr.clear();
                self.banner();
            }
            "resume" | "sessions" | "continue" => {
                let items: Vec<Item> = self
                    .sessions()
                    .iter()
                    .map(|m| Item {
                        label: s(m, "title").to_string(),
                        detail: format!("{} · {} · {}", rel_time(f(m, "updatedAt"), self.it), s(m, "model"), s(m, "cwd")),
                        value: s(m, "id").to_string(),
                    })
                    .collect();
                if items.is_empty() {
                    let m = self.t("Nessuna sessione", "No sessions");
                    self.notice("info", &m);
                } else {
                    let scope = if self.env.is_some() && self.settings["cli"]["sessionScope"].as_str() != Some("all") { self.t("ambiente corrente · /settings per tutte", "current environment · /settings for all") } else { String::new() };
                    self.pick(Kind::Session, self.t("Riprendi sessione", "Resume session"), scope, items, "");
                }
            }
            "search" => {
                if arg.is_empty() {
                    let m = self.t("Uso: /search <testo>", "Usage: /search <text>");
                    self.notice("info", &m);
                } else {
                    let r = self.c.get(&format!("/search?q={}", urlenc(&arg))).ok().and_then(|v| v.as_array().cloned()).unwrap_or_default();
                    let items: Vec<Item> = r
                        .iter()
                        .map(|x| {
                            let m = if x["meta"].is_object() { &x["meta"] } else { x };
                            Item { label: s(m, "title").to_string(), detail: x["snippet"].as_str().unwrap_or(s(m, "cwd")).replace('\n', " "), value: s(m, "id").to_string() }
                        })
                        .collect();
                    self.pick(Kind::Session, format!("{} «{arg}»", self.t("Risultati per", "Results for")), String::new(), items, "");
                }
            }
            "btw" => {
                if arg.is_empty() {
                    let m = self.t("Uso: /btw <domanda> — risponde un sub-agente mentre l'agente lavora", "Usage: /btw <question> — a sub-agent answers while the agent works");
                    self.notice("info", &m);
                } else if let Some(id) = self.sid.clone() {
                    match self.c.action(&id, "btw", json!({ "text": arg })) {
                        Ok(b) => {
                            self.btw_running.push(s(&b, "id").to_string());
                            let l = format!("  {} {}", accent("/btw"), dim(&truncate(&arg, self.w().saturating_sub(12))));
                            self.commit(&[String::new(), l]);
                        }
                        Err(e) => self.notice("error", &e),
                    }
                } else {
                    // No conversation yet: it's simply the first question.
                    self.submit(arg);
                }
            }
            "rename" => self.patch_meta(json!({ "title": arg }), "Rinominata", "Renamed"),
            "pin" => self.patch_meta(json!({ "pinned": true }), "Fissata", "Pinned"),
            "unpin" => self.patch_meta(json!({ "pinned": false }), "Sbloccata", "Unpinned"),
            "archive" => self.patch_meta(json!({ "archived": true }), "Archiviata", "Archived"),
            "delete" => {
                if let Some(id) = self.sid.clone() {
                    let _ = self.c.delete(&format!("/sessions/{id}"));
                    self.command("/new");
                    let m = self.t("Sessione eliminata", "Session deleted");
                    self.notice("info", &m);
                }
            }
            "export" => {
                if let Some(id) = self.sid.clone() {
                    match self.c.get_text(&format!("/sessions/{id}/export")) {
                        Ok(md) => {
                            let file = self.cwd.join(format!("argon-{id}.md"));
                            match std::fs::write(&file, md) {
                                Ok(_) => self.notice("info", &format!("→ {}", file.display())),
                                Err(e) => self.notice("error", &e.to_string()),
                            }
                        }
                        Err(e) => self.notice("error", &e),
                    }
                }
            }
            "clear" => {
                if let Some(id) = self.sid.clone() {
                    let _ = self.c.action(&id, "clear", json!({}));
                }
                self.scr.clear();
                self.refresh();
            }
            "compact" => {
                if let Some(id) = self.sid.clone() {
                    let m = self.t("Compatto il contesto…", "Compacting the context…");
                    self.notice("info", &m);
                    self.render();
                    match self.c.action(&id, "compact", json!({ "instructions": arg })) {
                        Ok(p) => {
                            self.apply_payload(&p);
                            let m = format!("{} {:.0}%", self.t("Contesto compattato:", "Context compacted:"), self.ctx_pct);
                            self.notice("info", &m);
                        }
                        Err(e) => self.notice("error", &e),
                    }
                }
            }
            "undo" => {
                if let Some(id) = self.sid.clone() {
                    match self.c.action(&id, "undo", json!({})) {
                        Ok(r) => {
                            let n = r["restored"].as_u64().or(r["files"].as_u64()).unwrap_or(0);
                            if let Some(p) = r.get("session") {
                                self.apply_payload(p);
                            }
                            let m = format!("{} ({n} file)", self.t("Ultimo turno annullato", "Last turn undone"));
                            self.notice("info", &m);
                        }
                        Err(e) => self.notice("error", &e),
                    }
                }
            }
            "todos" => {
                let mut v = vec![String::new()];
                v.extend(self.todo_lines());
                if v.len() == 1 {
                    v.push(format!("  {}", dim(&self.t("Nessuna attività", "No tasks"))));
                }
                self.commit(&v);
            }
            "context" => {
                self.refresh();
                let l = format!("  {} {}", bar(self.ctx_pct, 30), dim(&format!("{:.0}% {}", self.ctx_pct, self.t("del contesto usato", "of the context used"))));
                self.commit(&[String::new(), l]);
            }
            "model" => {
                if !arg.is_empty() {
                    self.set_option("model", &arg);
                } else {
                    let items: Vec<Item> = self
                        .models
                        .iter()
                        .map(|m| {
                            let c = &m["cost"];
                            let price = if c.is_object() { format!(" · ${}/{}", f(c, "input"), f(c, "output")) } else { String::new() };
                            Item { label: s(m, "name").to_string(), detail: format!("{} · {} ctx{price}", s(m, "provider"), tokens(f(m, "contextWindow"))), value: s(m, "key").to_string() }
                        })
                        .collect();
                    let cur = self.model.clone();
                    self.pick(Kind::Model, self.t("Modello", "Model"), self.t("cerca per nome o provider · prezzi per 1M token", "search by name or provider · prices per 1M tokens"), items, &cur);
                }
            }
            "effort" => {
                if !arg.is_empty() {
                    self.set_option("effort", &arg);
                } else {
                    let levels: Vec<String> = self.model_json().and_then(|m| m["levels"].as_array().cloned()).unwrap_or_default().iter().filter_map(|x| x.as_str().map(String::from)).collect();
                    let def = self.model_json().map(|m| s(m, "defaultEffort").to_string()).unwrap_or_default();
                    let items: Vec<Item> = levels.iter().map(|l| Item { label: self.effort_label(l), detail: if *l == def { self.t("predefinito del provider", "provider default") } else { String::new() }, value: l.clone() }).collect();
                    let cur = self.effort.clone();
                    self.pick(Kind::Effort, self.t("Ragionamento", "Reasoning"), self.t("livelli riportati dal provider per questo modello", "levels reported by the provider for this model"), items, &cur);
                }
            }
            "mode" => {
                if !arg.is_empty() {
                    self.set_option("mode", &arg);
                } else {
                    let items: Vec<Item> = MODES.iter().map(|m| Item { label: (if self.it { m.1 } else { m.2 }).to_string(), detail: m.0.to_string(), value: m.0.to_string() }).collect();
                    let cur = self.mode.clone();
                    self.pick(Kind::Mode, self.t("Modalità permessi", "Permission mode"), String::new(), items, &cur);
                }
            }
            "usage" => self.cmd_usage(&arg),
            "limits" => self.cmd_limits(),
            "subagents" => {
                let mut v = vec![String::new()];
                for (agent, steps, done) in self.subagents.values() {
                    v.push(format!("  {} {} {}", if *done { ok("✔") } else { accent("◐") }, bold(agent), dim(&format!("{steps} {}", self.t("passi", "steps")))));
                }
                if v.len() == 1 {
                    v.push(format!("  {}", dim(&self.t("Nessun sub-agente in questa sessione", "No sub-agents in this session"))));
                }
                self.commit(&v);
            }
            "bgterminals" | "bashes" => {
                self.refresh();
                let mut v = vec![String::new()];
                for p in self.background.clone() {
                    let st = if p["running"].as_bool().unwrap_or(false) { accent("● running") } else { dim(&format!("exit {}", p["exitCode"])) };
                    v.push(format!("  {} {}  {}", dim(s(&p, "id")), bold(s(&p, "command")), st));
                }
                if v.len() == 1 {
                    v.push(format!("  {}", dim(&self.t("Nessun terminale in background", "No background terminals"))));
                }
                self.commit(&v);
            }
            "init" => {
                let file = self.init_file();
                let p = format!("Analyze this project (structure, languages, build/test commands, conventions) and create or update a {file} file in the working directory with concise instructions for an AI agent working here: overview, commands, code style, architecture notes, gotchas.");
                self.user_block(&format!("/init → {file}"));
                if let Ok(id) = self.ensure_session() {
                    self.running = true;
                    self.run_start = Some(Instant::now());
                    let _ = self.c.action(&id, "prompt", json!({ "text": p }));
                }
            }
            "pr" => {
                let Some(id) = self.sid.clone() else {
                    let m = self.t("Nessuna sessione attiva", "No active session");
                    self.notice("warn", &m);
                    return true;
                };
                let title = if arg.is_empty() { self.title.clone() } else { arg };
                let m = self.t("Creo la pull request…", "Creating the pull request…");
                self.notice("info", &m);
                self.render();
                match self.c.action(&id, "pr", json!({ "title": title, "body": "" })) {
                    Ok(r) => self.notice("info", &format!("PR #{} → {}", r["number"], s(&r, "url"))),
                    Err(e) => self.notice("error", &e),
                }
            }
            "github" => match self.c.get("/github") {
                Ok(g) => {
                    let l = if g["connected"].as_bool().unwrap_or(false) {
                        format!("  {} {} {}", ok("●"), bold(g["user"].as_str().unwrap_or("GitHub")), dim(&format!("· {}", s(&g, "source"))))
                    } else {
                        format!("  {} {}", dim("○"), self.t("GitHub non collegato: usa `gh auth login` o le impostazioni della GUI", "GitHub not connected: use `gh auth login` or the GUI settings"))
                    };
                    self.commit(&[String::new(), l]);
                }
                Err(e) => self.notice("error", &e),
            },
            "agents" => {
                let list = self.c.get(&format!("/agents?cwd={}", urlenc(&self.cwd.to_string_lossy()))).ok().and_then(|v| v.as_array().cloned()).unwrap_or_default();
                let mut v = vec![String::new()];
                for a in list {
                    v.push(format!("  {} {}", accent(&pad(s(&a, "name"), 14)), dim(s(&a, "description"))));
                }
                self.commit(&v);
            }
            "hooks" => {
                let h = self.settings["hooks"].clone();
                let mut v = vec![String::new()];
                if let Some(o) = h.as_object() {
                    for (k, list) in o {
                        for x in list.as_array().cloned().unwrap_or_default() {
                            v.push(format!("  {} {}", accent(&pad(k, 14)), dim(x["command"].as_str().unwrap_or(&x.to_string()))));
                        }
                    }
                }
                if v.len() == 1 {
                    v.push(format!("  {}", dim(&self.t("Nessun hook configurato", "No hooks configured"))));
                }
                self.commit(&v);
            }
            "settings" | "config" => self.cmd_settings(),
            "gui" | "app" => {
                let ok_ = crate::launch_desktop();
                let m = if ok_ { self.t("App desktop avviata", "Desktop app started") } else { self.t("App desktop non trovata", "Desktop app not found") };
                self.notice("info", &m);
            }
            // Account and configuration commands run the core's own CLI in the foreground.
            "login" | "logout" | "providers" | "mcp" | "skills" | "memory" | "env" | "stats" | "commands" => {
                let mut args = vec![name.clone()];
                args.extend(arg.split_whitespace().map(String::from));
                self.external(&args);
            }
            _ => return false,
        }
        true
    }

    fn patch_meta(&mut self, body: Value, it: &str, en: &str) {
        let Some(id) = self.sid.clone() else {
            let m = self.t("Nessuna sessione attiva", "No active session");
            return self.notice("warn", &m);
        };
        match self.c.patch(&format!("/sessions/{id}"), body) {
            Ok(_) => {
                self.refresh();
                let m = self.t(it, en);
                self.notice("info", &m);
            }
            Err(e) => self.notice("error", &e),
        }
    }

    fn external(&mut self, args: &[String]) {
        self.scr.stop();
        let _ = crossterm::terminal::disable_raw_mode();
        let _ = crate::core::run_ts(args);
        let _ = crossterm::terminal::enable_raw_mode();
        // the UI lives on the alternate screen: let the command's output be read before going back
        print!("\r\n{}", dim(&self.t("Premi un tasto per tornare ad Argon", "Press any key to return to Argon")));
        let _ = std::io::Write::flush(&mut std::io::stdout());
        while !matches!(event::read(), Ok(Event::Key(k)) if k.kind == KeyEventKind::Press) {}
        self.scr.start();
        self.load_settings();
        if let Ok(m) = self.c.get("/models") {
            self.models = m.as_array().cloned().unwrap_or_default();
        }
    }

    fn cmd_help(&mut self) {
        let mut v = vec![String::new(), format!("  {}", bold(&self.t("Comandi", "Commands")))];
        for c in self.commands() {
            v.push(format!("  {} {}", accent(&pad(&c.label, 14)), dim(&c.detail)));
        }
        v.push(String::new());
        v.push(format!("  {}", bold(&self.t("Tasti", "Keys"))));
        for (k, d) in [
            ("shift+tab", self.t("cambia modalità permessi", "cycle permission mode")),
            ("esc", self.t("ferma l'agente · chiude i menu", "stop the agent · close menus")),
            ("alt+enter, \\+enter", self.t("nuova riga", "new line")),
            ("ctrl+enter", self.t("in coda: parte quando l'agente ha finito", "queue: sent when the agent is done")),
            ("↑ ↓", self.t("cronologia · muoversi nei menu", "history · move in menus")),
            ("ctrl+l", self.t("pulisci lo schermo", "clear the screen")),
            ("ctrl+c ×2", self.t("esci", "quit")),
        ] {
            v.push(format!("  {} {}", accent(&pad(k, 20)), dim(&d)));
        }
        self.commit(&v);
    }

    fn cmd_settings(&mut self) {
        let c = self.settings["cli"].clone();
        let onoff = |k: &str| if c[k].as_bool().unwrap_or(false) { "on".to_string() } else { "off".to_string() };
        let item = |k: &str, it: &str, en: &str, v: String| Item { label: (if self.it { it } else { en }).to_string(), detail: v, value: k.to_string() };
        let items = vec![
            item("language", "Lingua", "Language", s(&c, "language").to_string()),
            item("accent", "Colore", "Accent colour", s(&c, "accent").to_string()),
            item("sessionScope", "Sessioni mostrate", "Sessions shown", if s(&c, "sessionScope") == "all" { self.t("tutte", "all") } else { self.t("ambiente corrente", "current environment") }),
            item("animations", "Animazioni", "Animations", onoff("animations")),
            item("timestamps", "Orari dei messaggi", "Message timestamps", onoff("timestamps")),
            item("showThinking", "Mostra il ragionamento", "Show reasoning", onoff("showThinking")),
            item("statusBar", "Barra di stato", "Status bar", onoff("statusBar")),
            item("notifyLimits", "Avvisi sui limiti", "Limit alerts", onoff("notifyLimits")),
            item("showBanner", "Banner iniziale", "Start banner", onoff("showBanner")),
        ];
        let hint = self.t("invio cambia · solo per la CLI (anche in GUI → Impostazioni → CLI)", "enter toggles · CLI only (also in GUI → Settings → CLI)");
        self.pick(Kind::Settings, self.t("Impostazioni CLI", "CLI settings"), hint, items, "");
    }

    fn cmd_limits(&mut self) {
        if let Ok(l) = self.c.get("/limits") {
            self.limits = l;
        }
        let l = self.limits.clone();
        let unit_cost = s(&l, "unit") == "cost";
        let amt = |v: f64| if unit_cost { format!("${v:.2}") } else { tokens(v) };
        let mut v = vec![String::new(), format!("  {}", bold(&self.t("Limiti di utilizzo", "Usage limits")))];
        if !l["enabled"].as_bool().unwrap_or(false) {
            v.push(format!("  {}", dim(&self.t("Limiti disattivati — attivali nelle impostazioni.", "Limits are off — enable them in Settings."))));
        }
        for (k, it, en) in [("fiveHour", "5 ore", "5 hours"), ("weekly", "Settimana", "Week")] {
            let w = &l[k];
            if !w["enabled"].as_bool().unwrap_or(false) {
                continue;
            }
            let p = f(w, "percent");
            v.push(format!("  {} {} {} {}", pad(&self.t(it, en), 10), bar(p, 28), bold(&format!("{p:.0}%")), dim(&format!("{} / {}", amt(f(w, "used")), amt(f(w, "limit"))))));
        }
        let sp = &l["spend"];
        v.push(String::new());
        v.push(format!("  {} {}", bold(&self.t("Spesa", "Spend")), dim(&self.t("costo equivalente API, sub-agenti inclusi", "API-equivalent cost, sub-agents included"))));
        v.push(format!(
            "  {} {}   {} {}   {} {}   {} {}   {} {}",
            dim(&self.t("oggi", "today")),
            bold(&format!("${:.2}", f(sp, "today"))),
            dim("5h"),
            bold(&format!("${:.2}", f(sp, "fiveHour"))),
            dim(&self.t("sett.", "week")),
            bold(&format!("${:.2}", f(sp, "weekly"))),
            dim(&self.t("mese", "month")),
            bold(&format!("${:.2}", f(sp, "month"))),
            dim(&self.t("totale", "total")),
            bold(&format!("${:.2}", f(sp, "total")))
        ));
        self.commit(&v);
    }

    fn cmd_usage(&mut self, arg: &str) {
        let range = match arg {
            "today" | "7d" | "30d" | "all" => arg,
            _ => "30d",
        };
        let u = match self.c.get(&format!("/usage?range={range}")) {
            Ok(u) => u,
            Err(e) => return self.notice("error", &e),
        };
        let t = &u["totals"];
        let mut v = vec![
            String::new(),
            format!("  {} {}", bold(&self.t("Utilizzo", "Usage")), dim(&format!("· {range} · /usage today|7d|30d|all"))),
            format!(
                "  {} {}   {} {}   {} {}   {} {}",
                dim(&self.t("costo", "cost")),
                bold(&format!("${:.2}", f(t, "cost"))),
                dim("token"),
                bold(&tokens(f(t, "tokens"))),
                dim(&self.t("chiamate", "calls")),
                bold(&format!("{}", f(t, "calls") as i64)),
                dim(&self.t("di cui sub-agenti", "of which sub-agents")),
                bold(&format!("${:.2}", f(t, "subagentCost")))
            ),
        ];
        // daily chart
        let daily = u["daily"].as_array().cloned().unwrap_or_default();
        let maxc = daily.iter().map(|d| f(d, "cost")).fold(0.0, f64::max);
        if maxc > 0.0 {
            let blocks = ['▁', '▂', '▃', '▄', '▅', '▆', '▇', '█'];
            let chart: String = daily.iter().map(|d| { let c = f(d, "cost"); if c <= 0.0 { '·' } else { blocks[((c / maxc) * 7.0).round() as usize] } }).collect();
            v.push(String::new());
            v.push(format!("  {}  {}", accent(&chart), dim(&format!("{} · max ${maxc:.2}", self.t("ultimi 30 giorni", "last 30 days")))));
        }
        let total = f(t, "cost").max(1e-9);
        v.push(String::new());
        v.push(format!("  {}", bold(&self.t("Per modello", "By model"))));
        let mut rows = u["rows"].as_array().cloned().unwrap_or_default();
        rows.sort_by(|a, b| f(b, "cost").partial_cmp(&f(a, "cost")).unwrap());
        for r in rows.iter().take(12) {
            let name = format!("{} {}", s(r, "model"), dim(s(r, "provider")));
            v.push(format!("  {} {} {} {}", pad(&name, 44), bar(f(r, "cost") / total * 100.0, 16), bold(&format!("${:>8.3}", f(r, "cost"))), dim(&format!("{} tok · {} {}", tokens(f(r, "tokens")), f(r, "calls") as i64, self.t("chiamate", "calls")))));
        }
        let prov = u["byProvider"].as_array().cloned().unwrap_or_default();
        if !prov.is_empty() {
            v.push(String::new());
            v.push(format!("  {}", bold(&self.t("Per provider", "By provider"))));
            for p in prov {
                v.push(format!("  {} {} {}", pad(s(&p, "provider"), 20), bar(f(&p, "cost") / total * 100.0, 16), bold(&format!("${:.3}", f(&p, "cost")))));
            }
        }
        let ag = u["byAgent"].as_array().cloned().unwrap_or_default();
        if !ag.is_empty() {
            v.push(String::new());
            v.push(format!("  {}", bold(&self.t("Sub-agenti e servizio", "Sub-agents and housekeeping"))));
            for a in ag {
                v.push(format!("  {} {} {}", pad(&accent(s(&a, "agent")), 20), bold(&format!("${:.3}", f(&a, "cost"))), dim(&format!("{} tok · {} {}", tokens(f(&a, "tokens")), f(&a, "calls") as i64, self.t("chiamate", "calls")))));
            }
        }
        self.commit(&v);
    }

    fn banner(&mut self) {
        if !self.cli("showBanner").as_bool().unwrap_or(true) {
            return;
        }
        let tile = |s: &str| format!("{}{}{}", accent("│"), s, accent("│"));
        let ver = env!("CARGO_PKG_VERSION");
        let right = [
            format!("{} {}  {}", bold(&gradient("Argon")), dim(&format!("v{ver}")), dim(&self.t("· il tuo agente AI open source", "· your open-source AI agent"))),
            dim(&format!("{} · {} · {}", self.model_name(), self.effort_label(&self.effort), self.mode_label(&self.mode))),
            dim(&format!("{}{}{}", self.cwd.display(), self.branch.as_ref().map(|b| format!("  ⎇ {b}")).unwrap_or_default(), if self.ctx_files.is_empty() { String::new() } else { format!(" · {}", self.ctx_files.join(", ")) })),
            dim(&self.t("/ per i comandi · @ per allegare file · shift+tab cambia modalità", "/ for commands · @ to attach files · shift+tab changes mode")),
        ];
        let v = vec![
            String::new(),
            format!("  {}", accent("╭──────────╮")),
            format!("  {}   {}", tile(&format!(" {}       ", dim("18"))), right[0]),
            format!("  {}   {}", tile(&format!("    {}    ", bold(&gradient("Ar")))), right[1]),
            format!("  {}   {}", tile("  Argon   "), right[2]),
            format!("  {}   {}", tile(&format!("  {}  ", dim("39.948"))), right[3]),
            format!("  {}", accent("╰──────────╯")),
            String::new(),
        ];
        self.commit(&v);
        if self.limits["enabled"].as_bool().unwrap_or(false) {
            let a = f(&self.limits["fiveHour"], "percent");
            let b = f(&self.limits["weekly"], "percent");
            let l = format!("  {} {}", ring(a.max(b)), dim(&format!("5h {a:.0}% · {} {b:.0}% · {} ${:.3}", self.t("settimana", "week"), self.t("oggi", "today"), f(&self.limits["spend"], "today"))));
            self.commit(&[l]);
        }
    }
}

/// Local HH:MM without pulling in a time-zone crate: ask the OS once for the UTC offset.
fn local_hm(utc_secs: i64) -> String {
    static OFFSET: std::sync::OnceLock<i64> = std::sync::OnceLock::new();
    let off = *OFFSET.get_or_init(|| {
        // `date +%z` on Unix; PowerShell on Windows. Falls back to UTC.
        let out = if cfg!(windows) {
            std::process::Command::new("powershell").args(["-NoProfile", "-Command", "[int][TimeZoneInfo]::Local.GetUtcOffset([DateTime]::UtcNow).TotalSeconds"]).output()
        } else {
            std::process::Command::new("date").arg("+%z").output()
        };
        out.ok()
            .and_then(|o| {
                let t = String::from_utf8_lossy(&o.stdout).trim().to_string();
                if cfg!(windows) {
                    t.parse::<i64>().ok()
                } else {
                    let sign = if t.starts_with('-') { -1 } else { 1 };
                    let d = t.trim_start_matches(['+', '-']);
                    let h: i64 = d.get(0..2)?.parse().ok()?;
                    let m: i64 = d.get(2..4)?.parse().ok()?;
                    Some(sign * (h * 3600 + m * 60))
                }
            })
            .unwrap_or(0)
    });
    let t = (utc_secs + off).rem_euclid(86400);
    format!("{:02}:{:02}", t / 3600, (t % 3600) / 60)
}

pub fn urlenc(s: &str) -> String {
    s.bytes().map(|b| if b.is_ascii_alphanumeric() || b"-_.~".contains(&b) { (b as char).to_string() } else { format!("%{b:02X}") }).collect()
}

pub fn run(c: Client, opts: Opts) -> Result<(), String> {
    let (tx, rx) = channel();
    c.events(tx);
    let mut app = App {
        c,
        rx,
        scr: Screen::new(),
        it: true,
        cwd: opts.cwd.clone(),
        settings: Value::Null,
        models: vec![],
        env: None,
        sid: None,
        title: String::new(),
        model: String::new(),
        effort: String::new(),
        mode: String::new(),
        ctx_pct: 0.0,
        cost: 0.0,
        branch: None,
        ctx_files: vec![],
        limits: Value::Null,
        todos: vec![],
        background: vec![],
        text: vec![],
        cur: 0,
        hist: vec![],
        hist_i: None,
        suggest: None,
        picker: None,
        approval: None,
        question: None,
        extra_cmds: vec![],
        running: false,
        run_start: None,
        word: String::new(),
        out_tok: 0,
        frame: 0,
        md: None,
        thinking: None,
        think_start: None,
        subagents: HashMap::new(),
        last_turn: None,
        turn_cost0: 0.0,
        ctrl_c: None,
        warned: (false, false),
        quit: false,
        queued: 0,
        btw_running: vec![],
    };
    app.load_settings();
    let boot = app.c.get("/bootstrap")?;
    app.models = boot["models"].as_array().cloned().unwrap_or_default();
    app.limits = boot["limits"].clone();
    // Current environment: the one whose folder contains cwd (deepest match).
    let cwd_s = app.cwd.to_string_lossy().to_lowercase();
    app.env = boot["environments"]
        .as_array()
        .cloned()
        .unwrap_or_default()
        .into_iter()
        .filter(|e| { let p = s(e, "cwd").to_lowercase(); cwd_s == p || cwd_s.starts_with(&format!("{}{}", p.trim_end_matches(['\\', '/']), std::path::MAIN_SEPARATOR)) })
        .max_by_key(|e| s(e, "cwd").len());
    let st = &app.settings;
    app.model = opts.model.clone().or_else(|| app.env.as_ref().and_then(|e| e["model"].as_str().map(String::from))).unwrap_or_else(|| s(&st["model"], "default").to_string());
    app.effort = opts.effort.clone().unwrap_or_else(|| s(&st["model"], "effort").to_string());
    app.mode = opts.mode.clone().or_else(|| app.env.as_ref().and_then(|e| e["permissionMode"].as_str().map(String::from))).unwrap_or_else(|| s(&st["permissions"], "mode").to_string());
    app.branch = app.c.get(&format!("/git?cwd={}", urlenc(&app.cwd.to_string_lossy()))).ok().and_then(|g| g["branch"].as_str().map(String::from));
    app.ctx_files = context_files(&app.cwd, &app.init_file());
    // Custom commands and skills show up in the / menu and expand on the core.
    let q = urlenc(&app.cwd.to_string_lossy());
    for (path, it, en) in [("/commands", "Comando", "Command"), ("/skills", "Skill", "Skill")] {
        for x in app.c.get(&format!("{path}?cwd={q}")).ok().and_then(|v| v.as_array().cloned()).unwrap_or_default() {
            let n = s(&x, "name").to_string();
            let d = x["description"].as_str().unwrap_or(if app.it { it } else { en }).to_string();
            app.extra_cmds.push(Item { label: format!("/{n}"), detail: d, value: n });
        }
    }

    crossterm::terminal::enable_raw_mode().map_err(|e| e.to_string())?;
    let _ = crossterm::execute!(std::io::stdout(), event::EnableBracketedPaste);
    app.scr.start();
    app.scr.title("Argon");
    app.banner();

    match opts.resume.as_deref() {
        Some("") => {
            if let Some(last) = app.sessions().iter().filter(|m| s(m, "cwd").eq_ignore_ascii_case(&app.cwd.to_string_lossy())).max_by(|a, b| f(a, "updatedAt").partial_cmp(&f(b, "updatedAt")).unwrap()) {
                let id = s(last, "id").to_string();
                app.open_session(&id);
            }
        }
        Some(id) => app.open_session(id),
        None => {}
    }
    if let Some(p) = opts.prompt.clone() {
        app.submit(p);
    }

    let mut last_draw = Instant::now() - Duration::from_secs(1);
    let mut dirty = true;
    while !app.quit {
        while let Ok(e) = app.rx.try_recv() {
            app.on_event(e);
            dirty = true;
        }
        if event::poll(Duration::from_millis(30)).unwrap_or(false) {
            match event::read() {
                Ok(Event::Key(k)) if k.kind != KeyEventKind::Release => app.on_key(k),
                Ok(Event::Paste(p)) => app.insert(&p.replace("\r\n", "\n")),
                Ok(Event::Resize(w, h)) => {
                    app.scr.resize(w as usize, h as usize);
                }
                // the wheel scrolls the transcript (drawn by the screen itself); other mouse events need no redraw
                Ok(Event::Mouse(m)) => {
                    match m.kind {
                        MouseEventKind::ScrollUp => app.scr.scroll_by(3),
                        MouseEventKind::ScrollDown => app.scr.scroll_by(-3),
                        _ => {}
                    }
                    continue;
                }
                _ => {}
            }
            dirty = true;
        }
        if app.running && last_draw.elapsed() > Duration::from_millis(90) {
            app.frame += 1;
            dirty = true;
        }
        if dirty {
            app.render();
            last_draw = Instant::now();
            dirty = false;
        }
    }
    if app.running {
        app.abort();
    }
    app.scr.stop();
    app.scr.print_transcript();
    let _ = crossterm::execute!(std::io::stdout(), event::DisableBracketedPaste);
    let _ = crossterm::terminal::disable_raw_mode();
    if let Some(id) = &app.sid {
        println!("  {}", dim(&format!("argon -r {id}")));
    }
    Ok(())
}
