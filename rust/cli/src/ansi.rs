//! ANSI styling and width-aware text helpers (port of the TS `screen.ts` helpers).

use std::sync::atomic::{AtomicU32, Ordering};
use unicode_width::UnicodeWidthChar;

pub const RESET: &str = "\x1b[0m";

static ACCENT: AtomicU32 = AtomicU32::new(0xa78bfa);

pub fn set_accent(name: &str) {
    let hex = match name {
        "cyan" => 0x22d3ee,
        "green" => 0x86efac,
        "amber" => 0xfbbf24,
        "rose" => 0xfb7185,
        _ => 0xa78bfa,
    };
    ACCENT.store(hex, Ordering::Relaxed);
}

pub fn accent_hex() -> u32 {
    ACCENT.load(Ordering::Relaxed)
}

pub fn fg(hex: u32, s: &str) -> String {
    format!("\x1b[38;2;{};{};{}m{}\x1b[39m", hex >> 16, (hex >> 8) & 0xff, hex & 0xff, s)
}
pub fn bg(hex: u32, s: &str) -> String {
    format!("\x1b[48;2;{};{};{}m{}\x1b[49m", hex >> 16, (hex >> 8) & 0xff, hex & 0xff, s)
}
pub fn bold(s: &str) -> String {
    format!("\x1b[1m{s}\x1b[22m")
}
pub fn dim(s: &str) -> String {
    format!("\x1b[2m{s}\x1b[22m")
}
pub fn italic(s: &str) -> String {
    format!("\x1b[3m{s}\x1b[23m")
}
pub fn underline(s: &str) -> String {
    format!("\x1b[4m{s}\x1b[24m")
}
pub fn strike(s: &str) -> String {
    format!("\x1b[9m{s}\x1b[29m")
}
pub fn accent(s: &str) -> String {
    fg(accent_hex(), s)
}
pub fn ok(s: &str) -> String {
    fg(0x86efac, s)
}
pub fn warn(s: &str) -> String {
    fg(0xfbbf24, s)
}
pub fn err(s: &str) -> String {
    fg(0xf87171, s)
}

/// Purple → cyan gradient, used for the product name.
pub fn gradient(s: &str) -> String {
    let chars: Vec<char> = s.chars().collect();
    let n = chars.len().max(2) - 1;
    let (a, b) = ((0xa7u32, 0x8bu32, 0xfau32), (0x22u32, 0xd3u32, 0xeeu32));
    let mut out = String::new();
    for (i, c) in chars.iter().enumerate() {
        let t = i as f32 / n as f32;
        let mix = |x: u32, y: u32| (x as f32 + (y as f32 - x as f32) * t) as u32;
        out += &fg((mix(a.0, b.0) << 16) | (mix(a.1, b.1) << 8) | mix(a.2, b.2), &c.to_string());
    }
    out
}

/// Length in bytes of an escape sequence starting at `s[0] == ESC`, if any.
fn esc_len(s: &str) -> Option<usize> {
    let b = s.as_bytes();
    if b.len() < 2 || b[0] != 0x1b {
        return None;
    }
    if b[1] == b'[' {
        for (i, &c) in b.iter().enumerate().skip(2) {
            if c.is_ascii_alphabetic() {
                return Some(i + 1);
            }
            if !(c.is_ascii_digit() || c == b';' || c == b'?') {
                return None;
            }
        }
        None
    } else if b[1] == b']' {
        b.iter().position(|&c| c == 0x07).map(|p| p + 1)
    } else {
        None
    }
}

pub fn char_width(c: char) -> usize {
    if c == '\t' {
        return 4;
    }
    UnicodeWidthChar::width(c).unwrap_or(0)
}

pub fn strip(s: &str) -> String {
    let mut out = String::with_capacity(s.len());
    let mut i = 0;
    while i < s.len() {
        if let Some(n) = esc_len(&s[i..]) {
            i += n;
            continue;
        }
        let c = s[i..].chars().next().unwrap();
        out.push(c);
        i += c.len_utf8();
    }
    out
}

pub fn width(s: &str) -> usize {
    strip(s).chars().map(char_width).sum()
}

/// Truncate to a visible width (ANSI-safe), adding an ellipsis when cut.
pub fn truncate(s: &str, w: usize) -> String {
    if width(s) <= w {
        return s.to_string();
    }
    let limit = w.saturating_sub(1);
    let mut out = String::new();
    let mut cw = 0;
    let mut i = 0;
    while i < s.len() {
        if let Some(n) = esc_len(&s[i..]) {
            out += &s[i..i + n];
            i += n;
            continue;
        }
        let c = s[i..].chars().next().unwrap();
        let w1 = char_width(c);
        if cw + w1 > limit {
            break;
        }
        out.push(c);
        cw += w1;
        i += c.len_utf8();
    }
    out + "…" + RESET
}

/// Pad with spaces to an exact visible width (truncating if longer).
pub fn pad(s: &str, w: usize) -> String {
    let t = truncate(s, w);
    let n = w.saturating_sub(width(&t));
    t + &" ".repeat(n)
}

/// Word-wrap an ANSI-styled line to `w` columns. Each segment re-opens the active styles and
/// ends with a reset.
pub fn wrap(line: &str, w: usize) -> Vec<String> {
    let w = w.max(4);
    let mut out = Vec::new();
    let mut active = String::new();
    let mut cur = String::new();
    let mut cur_w = 0usize;
    let mut last_space: Option<(usize, usize, String)> = None; // (byte idx in cur, width, active)
    let mut i = 0;
    let line = line.replace('\t', "    ");
    while i < line.len() {
        if let Some(n) = esc_len(&line[i..]) {
            let seq = &line[i..i + n];
            cur += seq;
            if seq.ends_with('m') {
                if seq == "\x1b[0m" || seq == "\x1b[m" {
                    active.clear();
                } else {
                    active += seq;
                }
            }
            i += n;
            continue;
        }
        let c = line[i..].chars().next().unwrap();
        let cw = char_width(c);
        if cur_w + cw > w {
            if c == ' ' {
                out.push(cur.clone() + RESET);
                cur = active.clone();
                cur_w = 0;
                last_space = None;
                i += 1;
                continue;
            }
            match last_space.take() {
                Some((idx, sw, act)) if sw > 4 => {
                    let rest = cur[idx..].to_string();
                    out.push(cur[..idx].to_string() + RESET);
                    cur_w = width(&rest);
                    cur = act + &rest;
                }
                _ => {
                    out.push(cur.clone() + RESET);
                    cur = active.clone();
                    cur_w = 0;
                }
            }
        }
        cur.push(c);
        cur_w += cw;
        if c == ' ' {
            last_space = Some((cur.len(), cur_w, active.clone()));
        }
        i += c.len_utf8();
    }
    out.push(cur + RESET);
    out
}

/// Human-friendly token counts: 950, 12.3k, 4.1M.
pub fn tokens(n: f64) -> String {
    if n >= 1e6 {
        format!("{:.1}M", n / 1e6)
    } else if n >= 1e3 {
        format!("{:.1}k", n / 1e3)
    } else {
        format!("{}", n as i64)
    }
}

/// Horizontal bar of `w` cells filled to `pct` (0..100).
pub fn bar(pct: f64, w: usize) -> String {
    let p = pct.clamp(0.0, 100.0);
    let full = ((p / 100.0) * w as f64).round() as usize;
    let col = if p >= 100.0 { 0xf87171 } else if p >= 80.0 { 0xfbbf24 } else { accent_hex() };
    fg(col, &"━".repeat(full)) + &fg(0x3a3644, &"━".repeat(w - full.min(w)))
}

/// Small usage ring glyph for a percentage.
pub fn ring(pct: f64) -> String {
    let g = match pct {
        p if p >= 100.0 => "●",
        p if p >= 75.0 => "◕",
        p if p >= 50.0 => "◑",
        p if p >= 20.0 => "◔",
        _ => "○",
    };
    let col = if pct >= 100.0 { 0xf87171 } else if pct >= 80.0 { 0xfbbf24 } else { 0x86efac };
    fg(col, g)
}

#[cfg(test)]
mod tests {
    use super::*;
    #[test]
    fn wraps_words_and_keeps_style() {
        let segs = wrap(&format!("{} hello world again", bold("x")), 10);
        assert!(segs.len() >= 2);
        assert!(segs.iter().all(|s| width(s) <= 10));
    }
    #[test]
    fn wide_chars() {
        assert_eq!(width("日本"), 4);
        assert_eq!(width(&accent("ab")), 2);
        assert_eq!(width(&truncate("abcdefgh", 5)), 5);
    }
}
