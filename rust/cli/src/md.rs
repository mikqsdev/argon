//! Line-based streaming Markdown → ANSI renderer (port of `MarkdownStream` in the TS `ui.ts`).
//! Complete lines are rendered and handed back; the incomplete tail can be previewed with `partial`.

use crate::ansi::{accent, bg, bold, dim, fg, italic, underline, width};

pub struct Md {
    indent: String,
    buf: String,
    in_code: bool,
    table: Vec<String>,
}

impl Md {
    pub fn new(indent: &str) -> Self {
        Md { indent: indent.to_string(), buf: String::new(), in_code: false, table: vec![] }
    }

    /// Add streamed text; returns the rendered lines that are now complete.
    pub fn push(&mut self, delta: &str) -> Vec<String> {
        self.buf.push_str(delta);
        let mut out = vec![];
        while let Some(i) = self.buf.find('\n') {
            let line: String = self.buf[..i].trim_end_matches('\r').to_string();
            self.buf.drain(..=i);
            out.extend(self.line(&line));
        }
        out
    }

    /// Render whatever is left (end of the message).
    pub fn flush(&mut self) -> Vec<String> {
        let mut out = vec![];
        if !self.buf.is_empty() {
            let l = std::mem::take(&mut self.buf);
            out.extend(self.line(&l));
        }
        out.extend(self.end_table());
        out
    }

    /// Preview of the line still being streamed.
    pub fn partial(&self) -> Vec<String> {
        let mut out: Vec<String> = self.table.iter().map(|l| format!("{}{}", self.indent, dim(l))).collect();
        if !self.buf.is_empty() {
            if self.in_code {
                out.push(format!("{}{}", self.indent, code_line(&self.buf)));
            } else {
                out.push(format!("{}{}", self.indent, inline(&self.buf)));
            }
        }
        out
    }

    fn end_table(&mut self) -> Vec<String> {
        if self.table.is_empty() {
            return vec![];
        }
        let rows: Vec<Vec<String>> = std::mem::take(&mut self.table)
            .iter()
            .filter(|r| !r.chars().all(|c| matches!(c, '|' | '-' | ':' | ' ')))
            .map(|r| r.trim().trim_matches('|').split('|').map(|c| inline(c.trim())).collect())
            .collect();
        let cols = rows.iter().map(|r| r.len()).max().unwrap_or(0);
        let mut w = vec![0usize; cols];
        for r in &rows {
            for (i, c) in r.iter().enumerate() {
                w[i] = w[i].max(width(c));
            }
        }
        let border = |l: &str, m: &str, r: &str| dim(&format!("{l}{}{r}", w.iter().map(|n| "─".repeat(n + 2)).collect::<Vec<_>>().join(m)));
        let mut out = vec![format!("{}{}", self.indent, border("┌", "┬", "┐"))];
        for (k, r) in rows.iter().enumerate() {
            let cells: Vec<String> = (0..cols)
                .map(|i| {
                    let c = r.get(i).cloned().unwrap_or_default();
                    let c = if k == 0 { bold(&c) } else { c };
                    format!(" {}{} ", c, " ".repeat(w[i].saturating_sub(width(&c))))
                })
                .collect();
            out.push(format!("{}{}{}{}", self.indent, dim("│"), cells.join(&dim("│")), dim("│")));
            if k == 0 && rows.len() > 1 {
                out.push(format!("{}{}", self.indent, border("├", "┼", "┤")));
            }
        }
        out.push(format!("{}{}", self.indent, border("└", "┴", "┘")));
        out
    }

    fn line(&mut self, l: &str) -> Vec<String> {
        let ind = self.indent.clone();
        let t = l.trim_start();
        if t.starts_with("```") {
            self.in_code = !self.in_code;
            let lang = t.trim_start_matches('`').trim();
            return if self.in_code && !lang.is_empty() { vec![format!("{ind}{}", dim(lang))] } else { vec![] };
        }
        if self.in_code {
            return vec![format!("{ind}{}", code_line(l))];
        }
        if t.starts_with('|') {
            self.table.push(t.to_string());
            return vec![];
        }
        let mut out = self.end_table();
        let r = if let Some(h) = t.strip_prefix("### ") {
            bold(h)
        } else if let Some(h) = t.strip_prefix("## ") {
            bold(&accent(h))
        } else if let Some(h) = t.strip_prefix("# ") {
            bold(&accent(&h.to_uppercase()))
        } else if t == "---" || t == "***" {
            dim(&"─".repeat(40))
        } else if let Some(q) = t.strip_prefix("> ") {
            format!("{} {}", accent("│"), italic(&inline(q)))
        } else if let Some(rest) = t.strip_prefix("- ").or_else(|| t.strip_prefix("* ")) {
            let depth = (l.len() - t.len()) / 2;
            let (mark, rest) = if let Some(x) = rest.strip_prefix("[x] ") {
                (crate::ansi::ok("✔"), x)
            } else if let Some(x) = rest.strip_prefix("[ ] ") {
                (dim("○"), x)
            } else {
                (accent("•"), rest)
            };
            format!("{}{mark} {}", "  ".repeat(depth), inline(rest))
        } else if let Some(p) = t.find(". ").filter(|&p| p > 0 && p < 4 && t[..p].chars().all(|c| c.is_ascii_digit())) {
            format!("{} {}", accent(&t[..=p]), inline(&t[p + 2..]))
        } else {
            inline(l)
        };
        out.push(format!("{ind}{r}"));
        out
    }
}

fn code_line(l: &str) -> String {
    bg(0x1e1b26, &fg(0xc4b5fd, &format!(" {l} ")))
}

/// Inline formatting: **bold**, *italic*, `code`, [text](url).
pub fn inline(s: &str) -> String {
    let c: Vec<char> = s.chars().collect();
    let mut out = String::new();
    let mut i = 0;
    let find = |from: usize, pat: &[char]| -> Option<usize> {
        (from..c.len().saturating_sub(pat.len() - 1)).find(|&k| c[k..k + pat.len()] == *pat)
    };
    while i < c.len() {
        if c[i] == '`' {
            if let Some(e) = find(i + 1, &['`']) {
                let t: String = c[i + 1..e].iter().collect();
                out += &fg(0xc4b5fd, &bg(0x26232f, &t));
                i = e + 1;
                continue;
            }
        }
        if i + 1 < c.len() && c[i] == '*' && c[i + 1] == '*' {
            if let Some(e) = find(i + 2, &['*', '*']) {
                let t: String = c[i + 2..e].iter().collect();
                out += &bold(&inline(&t));
                i = e + 2;
                continue;
            }
        }
        if (c[i] == '*' || c[i] == '_') && i + 1 < c.len() && c[i + 1] != ' ' && (i == 0 || !c[i - 1].is_alphanumeric()) {
            if let Some(e) = find(i + 1, &[c[i]]) {
                if e > i + 1 {
                    let t: String = c[i + 1..e].iter().collect();
                    out += &italic(&t);
                    i = e + 1;
                    continue;
                }
            }
        }
        if c[i] == '[' {
            if let Some(e) = find(i + 1, &[']', '(']) {
                if let Some(p) = find(e + 2, &[')']) {
                    let t: String = c[i + 1..e].iter().collect();
                    out += &underline(&accent(&t));
                    i = p + 1;
                    continue;
                }
            }
        }
        out.push(c[i]);
        i += 1;
    }
    out
}
