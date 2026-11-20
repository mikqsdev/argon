//! HTTP + WebSocket client for the core API (`/api/*`, token in `X-Argon-Token`).

use serde_json::{json, Value};
use std::sync::mpsc::Sender;
use std::time::Duration;

#[derive(Clone)]
pub struct Client {
    base: String,
    token: String,
    port: u16,
}

pub type ApiResult = Result<Value, String>;

impl Client {
    pub fn new(port: u16, token: &str) -> Self {
        Client { base: format!("http://127.0.0.1:{port}/api"), token: token.to_string(), port }
    }

    fn done(r: Result<ureq::Response, ureq::Error>) -> ApiResult {
        match r {
            Ok(r) => r.into_json::<Value>().map_err(|e| e.to_string()),
            Err(ureq::Error::Status(_, r)) => {
                let v: Value = r.into_json().unwrap_or(Value::Null);
                Err(v["error"].as_str().unwrap_or("request failed").to_string())
            }
            Err(e) => Err(e.to_string()),
        }
    }

    pub fn get(&self, path: &str) -> ApiResult {
        Self::done(ureq::get(&format!("{}{path}", self.base)).set("X-Argon-Token", &self.token).timeout(Duration::from_secs(60)).call())
    }

    pub fn get_text(&self, path: &str) -> Result<String, String> {
        ureq::get(&format!("{}{path}", self.base))
            .set("X-Argon-Token", &self.token)
            .call()
            .map_err(|e| e.to_string())?
            .into_string()
            .map_err(|e| e.to_string())
    }

    pub fn post(&self, path: &str, body: Value) -> ApiResult {
        Self::done(ureq::post(&format!("{}{path}", self.base)).set("X-Argon-Token", &self.token).timeout(Duration::from_secs(600)).send_json(body))
    }

    pub fn patch(&self, path: &str, body: Value) -> ApiResult {
        Self::done(ureq::request("PATCH", &format!("{}{path}", self.base)).set("X-Argon-Token", &self.token).send_json(body))
    }

    pub fn delete(&self, path: &str) -> ApiResult {
        Self::done(ureq::delete(&format!("{}{path}", self.base)).set("X-Argon-Token", &self.token).call())
    }

    /// Session action (`POST /sessions/:id/:action`).
    pub fn action(&self, sid: &str, action: &str, body: Value) -> ApiResult {
        self.post(&format!("/sessions/{sid}/{action}"), body)
    }

    pub fn put_settings(&self, s: &Value) -> ApiResult {
        Self::done(ureq::put(&format!("{}/settings", self.base)).set("X-Argon-Token", &self.token).send_json(s.clone()))
    }

    /// Stream core events into `tx` from a background thread (reconnects if the socket drops).
    pub fn events(&self, tx: Sender<Value>) {
        let url = format!("ws://127.0.0.1:{}/ws?t={}", self.port, self.token);
        std::thread::spawn(move || loop {
            if let Ok((mut ws, _)) = tungstenite::connect(&url) {
                while let Ok(msg) = ws.read() {
                    if let tungstenite::Message::Text(t) = msg {
                        if let Ok(v) = serde_json::from_str::<Value>(&t) {
                            if tx.send(v).is_err() {
                                return;
                            }
                        }
                    }
                }
            }
            if tx.send(json!({ "type": "ws_closed" })).is_err() {
                return;
            }
            std::thread::sleep(Duration::from_millis(800));
        });
    }
}

/// Small helpers for reading JSON fields.
pub fn s<'a>(v: &'a Value, k: &str) -> &'a str {
    v[k].as_str().unwrap_or("")
}
pub fn f(v: &Value, k: &str) -> f64 {
    v[k].as_f64().unwrap_or(0.0)
}
