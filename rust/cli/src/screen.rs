//! Full-screen terminal layout (port of the TS `screen.ts`), drawn on the alternate screen.
//!
//!   transcript (kept here, scrolled with the mouse wheel / PgUp / PgDn)
//!   live block (streaming text)         ← redrawn in place until its line is complete
//!   bottom panel (fixed)                ← status, input box, menus, info, hints
//!
//! Nothing goes to the terminal's own scrollback: the wheel scrolls the transcript instead of the
//! whole UI, and the console buffer doesn't grow with the chat (Windows conhost / Terminal).

use crate::ansi::{truncate, wrap, RESET};
use crossterm::event::{DisableMouseCapture, EnableMouseCapture};
use std::io::Write;

const ESC: &str = "\x1b[";
// shortcut: older lines are dropped from the scroll view past this; the session keeps them all.
const MAX_LINES: usize = 5000;

#[derive(Clone, Copy)]
pub struct Cursor {
    pub row: usize,
    pub col: usize,
}

pub struct Screen {
    pub rows: usize,
    pub cols: usize,
    /// Committed lines as given (re-wrapped on resize) and wrapped to `cols`.
    lines: Vec<String>,
    wrapped: Vec<String>,
    /// `clear()` starts an empty view at this line (`floor` = same point in wrapped rows); older
    /// lines stay reachable by scrolling up.
    clear_at: usize,
    floor: usize,
    /// Rows scrolled up from the bottom of the transcript.
    scroll: usize,
    live: Vec<String>,
    bottom: Vec<String>,
    cursor: Option<Cursor>,
    started: bool,
    buf: String,
}

impl Screen {
    pub fn new() -> Self {
        let (c, r) = crossterm::terminal::size().unwrap_or((80, 24));
        Screen { rows: r as usize, cols: c as usize, lines: vec![], wrapped: vec![], clear_at: 0, floor: 0, scroll: 0, live: vec![], bottom: vec![], cursor: None, started: false, buf: String::new() }
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
        self.w(&format!("{ESC}?1049h{ESC}H{ESC}2J{ESC}?2004h"));
        self.flush();
        let _ = crossterm::execute!(std::io::stdout(), EnableMouseCapture);
        self.started = true;
        self.bottom.clear();
        self.draw_transcript();
        self.flush();
    }

    pub fn stop(&mut self) {
        if !self.started {
            return;
        }
        self.started = false;
        let _ = crossterm::execute!(std::io::stdout(), DisableMouseCapture);
        self.w(&format!("{ESC}?2004l{ESC}?1049l{ESC}?25h"));
        self.flush();
    }

    /// Print the transcript to the normal screen (after `stop`), so it stays in the terminal on exit.
    pub fn print_transcript(&self) {
        let mut o = std::io::stdout().lock();
        for l in &self.lines[self.clear_at..] {
            let _ = writeln!(o, "{l}");
        }
    }

    pub fn resize(&mut self, cols: usize, rows: usize) {
        self.cols = cols;
        self.rows = rows;
        self.rewrap();
        self.w(&format!("{ESC}2J"));
        self.bottom.clear();
        self.draw_transcript();
        self.flush();
    }

    fn rewrap(&mut self) {
        let cols = self.cols;
        self.floor = self.lines[..self.clear_at].iter().map(|l| wrap(l, cols).len()).sum();
        self.wrapped = self.lines.iter().flat_map(|l| wrap(l, cols)).collect();
    }

    /// Redraw the transcript area: committed rows then the live block, `scroll` rows up from the end.
    fn draw_transcript(&mut self) {
        if !self.started {
            return;
        }
        let h = self.region_bottom();
        let live: Vec<String> = self.live.iter().flat_map(|l| wrap(l, self.cols)).collect();
        let total = self.wrapped.len() + live.len();
        let base = self.floor.max(total.saturating_sub(h));
        self.scroll = self.scroll.min(base);
        let start = base - self.scroll;
        let mut s = format!("{ESC}?25l");
        for r in 0..h {
            let i = start + r;
            let line = if i < self.wrapped.len() { self.wrapped[i].as_str() } else { live.get(i - self.wrapped.len()).map_or("", |l| l.as_str()) };
            s += &format!("{ESC}{};1H{ESC}2K{line}{RESET}", r + 1);
        }
        if self.scroll > 0 {
            // how far the view is from the latest output
            let tag = format!(" ↓ {} ", self.scroll);
            s += &format!("{ESC}{h};{}H{ESC}7m{tag}{RESET}", self.cols.saturating_sub(tag.chars().count()) + 1);
        }
        self.w(&s);
    }

    fn place_cursor(&mut self) {
        if let Some(c) = self.cursor {
            let r = self.region_bottom() + 1 + c.row;
            self.w(&format!("{ESC}{r};{}H{ESC}?25h", c.col + 1));
        } else {
            self.w(&format!("{ESC}?25l"));
        }
    }

    fn redraw(&mut self) {
        self.draw_transcript();
        self.place_cursor();
        self.flush();
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
        let before = self.wrapped.len();
        for l in lines {
            self.lines.push(l.as_ref().to_string());
            self.wrapped.extend(wrap(l.as_ref(), self.cols));
        }
        if self.scroll > 0 {
            // keep a scrolled-up view still while output arrives
            self.scroll += self.wrapped.len() - before;
        }
        if self.lines.len() > MAX_LINES {
            let n = self.lines.len() - MAX_LINES * 4 / 5;
            self.lines.drain(..n);
            self.clear_at = self.clear_at.saturating_sub(n);
            self.rewrap();
        }
        self.redraw();
    }

    pub fn set_live(&mut self, lines: Vec<String>) {
        if !self.started {
            return;
        }
        self.live = lines;
        self.redraw();
    }

    pub fn clear_live(&mut self) {
        self.set_live(vec![]);
    }

    /// Clear the transcript area (earlier lines stay reachable by scrolling up).
    pub fn clear(&mut self) {
        self.clear_at = self.lines.len();
        self.floor = self.wrapped.len();
        self.scroll = 0;
        self.redraw();
    }

    /// Scroll the transcript: positive = up (older), negative = down.
    pub fn scroll_by(&mut self, delta: isize) {
        self.scroll = self.scroll.saturating_add_signed(delta);
        self.redraw();
    }

    pub fn scroll_to_bottom(&mut self) {
        if self.scroll > 0 {
            self.scroll = 0;
            self.redraw();
        }
    }

    /// Rows moved by PgUp / PgDn.
    pub fn page(&self) -> isize {
        (self.region_bottom() / 2).max(1) as isize
    }

    /// Draw the fixed bottom panel.
    pub fn set_bottom(&mut self, lines: Vec<String>, cursor: Option<Cursor>) {
        if !self.started {
            return;
        }
        let keep = self.rows.saturating_sub(3).max(3);
        let trimmed: Vec<String> = lines[lines.len().saturating_sub(keep)..].to_vec();
        self.w(&format!("{ESC}?25l"));
        let resized = trimmed.len() != self.bottom.len();
        self.bottom = trimmed;
        if resized {
            self.draw_transcript();
        }
        let top = self.region_bottom() + 1;
        for k in 0..self.bottom.len() {
            let s = format!("{ESC}{};1H{ESC}2K{}{RESET}", top + k, truncate(&self.bottom[k], self.cols));
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
