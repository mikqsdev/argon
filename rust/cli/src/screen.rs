//! Full-screen terminal layout (port of the TS `screen.ts`).
//!
//!   transcript (DECSTBM scroll region)  ← committed lines scroll into the native scrollback
//!   live block (streaming text)         ← redrawn in place until its line is complete
//!   bottom panel (fixed)                ← status, input box, menus, info, hints

use crate::ansi::{truncate, wrap, RESET};
use std::io::Write;

const ESC: &str = "\x1b[";

#[derive(Clone, Copy)]
pub struct Cursor {
    pub row: usize,
    pub col: usize,
}

pub struct Screen {
    pub rows: usize,
    pub cols: usize,
    out_row: usize,
    live_rows: usize,
    live: Vec<String>,
    bottom: Vec<String>,
    cursor: Option<Cursor>,
    started: bool,
    buf: String,
}

impl Screen {
    pub fn new() -> Self {
        let (c, r) = crossterm::terminal::size().unwrap_or((80, 24));
        Screen { rows: r as usize, cols: c as usize, out_row: 1, live_rows: 0, live: vec![], bottom: vec![], cursor: None, started: false, buf: String::new() }
    }

    fn region_bottom(&self) -> usize {
        self.rows.saturating_sub(self.bottom.len()).max(1)
    }

    fn w(&mut self, s: &str) {
        self.buf.push_str(s);
    }

    fn flush(&mut self) {
        if !self.buf.is_empty() {
            let mut o = std::io::stdout().lock();
            let _ = o.write_all(self.buf.as_bytes());
            let _ = o.flush();
            self.buf.clear();
        }
    }

    pub fn start(&mut self) {
        // Push previous terminal content into the scrollback and start clean.
        let s = format!("{}{ESC}H{ESC}2J{ESC}?2004h", "\n".repeat(self.rows));
        self.w(&s);
        self.out_row = 1;
        self.started = true;
        self.flush();
    }

    pub fn stop(&mut self) {
        if !self.started {
            return;
        }
        self.started = false;
        self.w(&format!("{ESC}r{ESC}?2004l"));
        for r in self.region_bottom() + 1..=self.rows {
            self.w(&format!("{ESC}{r};1H{ESC}2K"));
        }
        let row = (self.out_row + self.live_rows).min(self.rows);
        self.w(&format!("{ESC}{row};1H{ESC}?25h\n"));
        self.flush();
    }

    pub fn resize(&mut self, cols: usize, rows: usize) {
        self.cols = cols;
        self.rows = rows;
        self.w(&format!("{ESC}2J"));
        self.bottom.clear();
        self.out_row = self.out_row.min(self.region_bottom());
        self.live_rows = 0;
    }

    fn scroll_up(&mut self, n: usize) {
        if n == 0 {
            return;
        }
        let s = format!("{ESC}{};1H{}", self.region_bottom(), "\n".repeat(n));
        self.w(&s);
        self.out_row = self.out_row.saturating_sub(n).max(1);
    }

    fn ensure_room(&mut self, count: usize) {
        let end = self.out_row + count;
        let rb = self.region_bottom();
        if end > rb + 1 {
            self.scroll_up((end - rb - 1).min(rb.saturating_sub(1)));
        }
    }

    fn draw_live(&mut self) {
        let segs: Vec<String> = self.live.iter().flat_map(|l| wrap(l, self.cols)).collect();
        let max = self.region_bottom().saturating_sub(1).max(1);
        let shown: Vec<String> = segs[segs.len().saturating_sub(max)..].to_vec();
        self.ensure_room(shown.len());
        for k in 0..shown.len().max(self.live_rows) {
            let r = self.out_row + k;
            if r > self.region_bottom() {
                break;
            }
            let line = shown.get(k).cloned().unwrap_or_default();
            self.w(&format!("{ESC}{r};1H{ESC}2K{line}"));
        }
        self.live_rows = shown.len();
    }

    fn place_cursor(&mut self) {
        if let Some(c) = self.cursor {
            let r = self.region_bottom() + 1 + c.row;
            self.w(&format!("{ESC}{r};{}H{ESC}?25h", c.col + 1));
        } else {
            self.w(&format!("{ESC}?25l"));
        }
    }

    /// Append finished lines to the transcript.
    pub fn commit<S: AsRef<str>>(&mut self, lines: &[S]) {
        if !self.started {
            let mut o = std::io::stdout().lock();
            for l in lines {
                let _ = writeln!(o, "{}", l.as_ref());
            }
            return;
        }
        self.w(&format!("{ESC}?25l"));
        let had_live = !self.live.is_empty();
        for k in 0..self.live_rows {
            if self.out_row + k <= self.region_bottom() {
                let r = self.out_row + k;
                self.w(&format!("{ESC}{r};1H{ESC}2K"));
            }
        }
        self.live_rows = 0;
        for line in lines {
            for seg in wrap(line.as_ref(), self.cols) {
                self.ensure_room(1);
                let r = self.out_row;
                self.w(&format!("{ESC}{r};1H{ESC}2K{seg}"));
                self.out_row += 1;
            }
        }
        if had_live {
            self.draw_live();
        }
        self.place_cursor();
        self.flush();
    }

    pub fn set_live(&mut self, lines: Vec<String>) {
        if !self.started {
            return;
        }
        self.live = lines;
        self.w(&format!("{ESC}?25l"));
        self.draw_live();
        self.place_cursor();
        self.flush();
    }

    pub fn clear_live(&mut self) {
        self.set_live(vec![]);
    }

    /// Clear the transcript area (keeps the scrollback).
    pub fn clear(&mut self) {
        let rb = self.region_bottom();
        self.scroll_up(rb);
        self.out_row = 1;
        self.live_rows = 0;
        self.flush();
    }

    /// Draw the fixed bottom panel.
    pub fn set_bottom(&mut self, lines: Vec<String>, cursor: Option<Cursor>) {
        if !self.started {
            return;
        }
        let keep = self.rows.saturating_sub(3).max(3);
        let trimmed: Vec<String> = lines[lines.len().saturating_sub(keep)..].to_vec();
        self.w(&format!("{ESC}?25l"));
        if trimmed.len() > self.bottom.len() {
            // Panel grows: push transcript up so nothing hides behind it.
            let content_end = self.out_row + self.live_rows;
            let new_bottom = self.rows - trimmed.len();
            if content_end > new_bottom + 1 {
                let n = (content_end - new_bottom - 1).min(self.region_bottom().saturating_sub(1));
                self.scroll_up(n);
            }
        }
        if trimmed.len() != self.bottom.len() {
            let first = (self.rows - trimmed.len()).min(self.region_bottom()) + 1;
            for r in first..=self.rows {
                self.w(&format!("{ESC}{r};1H{ESC}2K"));
            }
            self.bottom = trimmed.clone();
            let rb = self.region_bottom();
            self.w(&format!("{ESC}1;{rb}r"));
            if self.out_row > rb {
                self.out_row = rb;
            }
        } else {
            self.bottom = trimmed.clone();
        }
        let top = self.region_bottom() + 1;
        for (k, l) in trimmed.iter().enumerate() {
            let s = format!("{ESC}{};1H{ESC}2K{}{RESET}", top + k, truncate(l, self.cols));
            self.w(&s);
        }
        self.cursor = cursor;
        self.place_cursor();
        self.flush();
    }

    pub fn bell(&mut self) {
        self.w("\x07");
        self.flush();
    }

    pub fn title(&mut self, t: &str) {
        let clean: String = t.chars().filter(|c| !c.is_control()).collect();
        self.w(&format!("\x1b]0;{clean}\x07"));
        self.flush();
    }
}
