// Ask: a model server on this computer answers questions about what is
// loaded in CloverEye (ui/js/ai-model.js builds the question).
//
// Local only: every request goes to 127.0.0.1 on a port; the page never
// hands over an address, so nothing here can reach another machine. Nothing
// is installed or downloaded; CloverEye only looks for servers that are
// already running (Ollama, LM Studio, llama.cpp's server, Jan) and lists
// their models.

use std::collections::HashMap;
use std::io::{BufRead, BufReader, Read};
use std::sync::atomic::{AtomicBool, Ordering};
use std::sync::{Arc, Mutex};
use std::time::Duration;

use serde_json::{json, Value};
use tauri::ipc::Channel;

/// Where each kind of server listens by default.
pub const KNOWN: [(&str, u16); 4] = [("ollama", 11434), ("lmstudio", 1234), ("llamacpp", 8080), ("jan", 1337)];
const KINDS: [&str; 5] = ["ollama", "lmstudio", "llamacpp", "jan", "custom"];
/// The question and posts sent at once (ai-model.js keeps it far below).
const MAX_REQUEST_BYTES: usize = 512 * 1024;
/// The longest answer (tokens): a model stuck repeating itself stops here.
const MAX_ANSWER_TOKENS: u32 = 1024;

#[derive(Default)]
pub struct AiState {
    stops: Mutex<HashMap<String, Arc<AtomicBool>>>,
}

fn agent(read: Duration) -> ureq::Agent {
    ureq::AgentBuilder::new().timeout_connect(Duration::from_millis(800)).timeout_read(read).redirects(0).build()
}

fn base(port: u16) -> String {
    format!("http://127.0.0.1:{port}")
}

/// The models a server on `port` offers, or None when nothing answers
/// there the way a model server does.
fn models_at(kind: &str, port: u16) -> Option<Vec<String>> {
    let a = agent(Duration::from_millis(1500));
    if kind == "ollama" {
        if let Ok(r) = a.get(&format!("{}/api/tags", base(port))).call() {
            let v: Value = serde_json::from_str(&r.into_string().ok()?).ok()?;
            let list = v.get("models")?.as_array()?;
            return Some(list.iter().filter_map(|m| m.get("name").and_then(Value::as_str).map(str::to_string)).collect());
        }
    }
    let r = a.get(&format!("{}/v1/models", base(port))).call().ok()?;
    let v: Value = serde_json::from_str(&r.into_string().ok()?).ok()?;
    let list = v.get("data")?.as_array()?;
    Some(list.iter().filter_map(|m| m.get("id").and_then(Value::as_str).map(str::to_string)).take(200).collect())
}

/// Memory and graphics memory, in GB, for setup's recommendation.
#[derive(serde::Serialize, Default)]
#[serde(rename_all = "camelCase")]
pub struct Specs {
    ram_gb: f64,
    vram_gb: f64,
    gpu: String,
    /// The GPU shares the system memory (Apple silicon).
    unified: bool,
}

fn gb(bytes: u64) -> f64 {
    (bytes as f64 / 1_073_741_824.0 * 10.0).round() / 10.0
}

#[cfg(target_os = "linux")]
fn ram_bytes() -> u64 {
    std::fs::read_to_string("/proc/meminfo")
        .ok()
        .and_then(|t| t.lines().find_map(|l| l.strip_prefix("MemTotal:").map(|v| v.trim().trim_end_matches("kB").trim().parse::<u64>().unwrap_or(0) * 1024)))
        .unwrap_or(0)
}

#[cfg(target_os = "macos")]
fn ram_bytes() -> u64 {
    std::process::Command::new("sysctl")
        .args(["-n", "hw.memsize"])
        .output()
        .ok()
        .and_then(|o| String::from_utf8_lossy(&o.stdout).trim().parse().ok())
        .unwrap_or(0)
}

#[cfg(target_os = "windows")]
fn ram_bytes() -> u64 {
    #[repr(C)]
    struct MemoryStatusEx {
        length: u32,
        memory_load: u32,
        total_phys: u64,
        avail_phys: u64,
        total_page_file: u64,
        avail_page_file: u64,
        total_virtual: u64,
        avail_virtual: u64,
        avail_extended_virtual: u64,
    }
    #[link(name = "kernel32")]
    extern "system" {
        fn GlobalMemoryStatusEx(buffer: *mut MemoryStatusEx) -> i32;
    }
    let mut m = MemoryStatusEx {
        length: std::mem::size_of::<MemoryStatusEx>() as u32,
        memory_load: 0,
        total_phys: 0,
        avail_phys: 0,
        total_page_file: 0,
        avail_page_file: 0,
        total_virtual: 0,
        avail_virtual: 0,
        avail_extended_virtual: 0,
    };
    if unsafe { GlobalMemoryStatusEx(&mut m) } != 0 {
        m.total_phys
    } else {
        0
    }
}

#[cfg(not(any(target_os = "linux", target_os = "macos", target_os = "windows")))]
fn ram_bytes() -> u64 {
    0
}

/// The largest NVIDIA GPU's memory (nvidia-smi), or an AMD GPU's (sysfs).
fn gpu() -> (u64, String) {
    let mut best = (0u64, String::new());
    let mut cmd = std::process::Command::new("nvidia-smi");
    cmd.args(["--query-gpu=name,memory.total", "--format=csv,noheader,nounits"]).stdin(std::process::Stdio::null());
    #[cfg(windows)]
    {
        // no console window flashing up from a windowed app
        use std::os::windows::process::CommandExt;
        cmd.creation_flags(0x0800_0000);
    }
    if let Ok(o) = cmd.output() {
        if !o.status.success() {
            // e.g. "Failed to initialize NVML: Driver/library version mismatch"
            // after a driver update without a restart: say why it reads 0
            let why = String::from_utf8_lossy(if o.stdout.is_empty() { &o.stderr } else { &o.stdout }).lines().next().unwrap_or_default().chars().take(160).collect::<String>();
            crate::diag::quiet(&format!("assistant: nvidia-smi could not read the graphics card: {why}"), false);
        }
        for line in String::from_utf8_lossy(&o.stdout).lines() {
            if let Some((name, mib)) = line.rsplit_once(',') {
                let bytes = mib.trim().parse::<u64>().unwrap_or(0) * 1_048_576;
                if bytes > best.0 {
                    best = (bytes, name.trim().to_string());
                }
            }
        }
    }
    #[cfg(target_os = "linux")]
    if let Ok(dir) = std::fs::read_dir("/sys/class/drm") {
        for e in dir.flatten() {
            let p = e.path().join("device/mem_info_vram_total");
            if let Some(bytes) = std::fs::read_to_string(&p).ok().and_then(|t| t.trim().parse::<u64>().ok()) {
                if bytes > best.0 {
                    best = (bytes, "AMD GPU".into());
                }
            }
        }
    }
    best
}

pub fn specs() -> Specs {
    let ram = ram_bytes();
    let unified = cfg!(all(target_os = "macos", target_arch = "aarch64"));
    let (vram, name) = if unified { (0, "Apple silicon".to_string()) } else { gpu() };
    Specs { ram_gb: gb(ram), vram_gb: gb(vram), gpu: name, unified }
}

/// The model servers running on this computer and their models, plus the
/// computer's specs. `port`: a server the person named (kind "custom").
#[tauri::command]
pub async fn ai_detect(port: Option<u16>) -> Result<Value, String> {
    tauri::async_runtime::spawn_blocking(move || {
        let mut probes: Vec<(&str, u16)> = KNOWN.to_vec();
        if let Some(p) = port.filter(|p| *p > 0 && !KNOWN.iter().any(|(_, k)| k == p)) {
            probes.push(("custom", p));
        }
        let found: Vec<Value> = std::thread::scope(|s| {
            let jobs: Vec<_> = probes.iter().map(|(kind, port)| s.spawn(move || models_at(kind, *port).map(|m| json!({ "kind": kind, "port": port, "models": m })))).collect();
            jobs.into_iter().filter_map(|j| j.join().ok().flatten()).collect()
        });
        let sp = specs();
        // for the diagnostics report: what was found, never what is asked
        let list: Vec<String> = found.iter().map(|s| format!("{}:{} ({} models)", s["kind"].as_str().unwrap_or("?"), s["port"], s["models"].as_array().map_or(0, Vec::len))).collect();
        crate::diag::quiet(&format!("assistant: found {}; memory {} GB, graphics {} GB {}", if list.is_empty() { "no model server".to_string() } else { list.join(", ") }, sp.ram_gb, sp.vram_gb, sp.gpu), false);
        json!({ "servers": found, "specs": sp })
    })
    .await
    .map_err(|e| e.to_string())
}

/// One piece of a streamed answer, from either API's line: the text, and
/// whether the answer is complete. An error the server sent is Err.
fn chunk(kind: &str, line: &str) -> Result<(String, bool), String> {
    let line = line.trim();
    if kind == "ollama" {
        if line.is_empty() {
            return Ok((String::new(), false));
        }
        let v: Value = serde_json::from_str(line).map_err(|_| format!("unexpected answer: {}", line.chars().take(200).collect::<String>()))?;
        if let Some(e) = v.get("error").and_then(Value::as_str) {
            return Err(e.to_string());
        }
        let text = v.pointer("/message/content").and_then(Value::as_str).unwrap_or_default().to_string();
        return Ok((text, v.get("done").and_then(Value::as_bool).unwrap_or(false)));
    }
    let Some(data) = line.strip_prefix("data:") else { return Ok((String::new(), false)) };
    let data = data.trim();
    if data == "[DONE]" {
        return Ok((String::new(), true));
    }
    let v: Value = serde_json::from_str(data).map_err(|_| format!("unexpected answer: {}", data.chars().take(200).collect::<String>()))?;
    if let Some(e) = v.get("error") {
        return Err(e.get("message").and_then(Value::as_str).map(str::to_string).unwrap_or_else(|| e.to_string()));
    }
    let text = v.pointer("/choices/0/delta/content").and_then(Value::as_str).unwrap_or_default().to_string();
    let done = v.pointer("/choices/0/finish_reason").is_some_and(|f| !f.is_null());
    Ok((text, done))
}

/// The server's own words for a refused request.
fn status_error(code: u16, body: &str) -> String {
    let said = serde_json::from_str::<Value>(body)
        .ok()
        .and_then(|v| v.get("error").map(|e| e.get("message").and_then(Value::as_str).map(str::to_string).unwrap_or_else(|| e.as_str().map(str::to_string).unwrap_or_else(|| e.to_string()))))
        .unwrap_or_else(|| body.chars().take(200).collect());
    format!("{code} {said}")
}

fn stream(kind: &str, port: u16, body: &Value, stop: &AtomicBool, send: &dyn Fn(Value)) -> Result<(), String> {
    let path = if kind == "ollama" { "/api/chat" } else { "/v1/chat/completions" };
    // a model that is still loading can take minutes before its first word
    let res = agent(Duration::from_secs(300)).post(&format!("{}{path}", base(port))).set("Content-Type", "application/json").send_string(&body.to_string());
    let res = match res {
        Ok(r) => r,
        Err(ureq::Error::Status(code, r)) => return Err(status_error(code, &r.into_string().unwrap_or_default())),
        Err(ureq::Error::Transport(t)) => return Err(format!("connection refused or failed: {t}")),
    };
    // Lines are read on their own thread, so Stop answers at once even while
    // the server is still reading the question; the connection closes when
    // that thread's next line finds nobody listening.
    let reader = BufReader::new(res.into_reader().take(64 * 1024 * 1024));
    let (tx, rx) = std::sync::mpsc::sync_channel::<std::io::Result<String>>(256);
    std::thread::spawn(move || {
        for line in reader.lines() {
            if tx.send(line).is_err() {
                break;
            }
        }
    });
    loop {
        if stop.load(Ordering::SeqCst) {
            return Ok(());
        }
        let line = match rx.recv_timeout(Duration::from_millis(200)) {
            Ok(l) => l.map_err(|e| e.to_string())?,
            Err(std::sync::mpsc::RecvTimeoutError::Timeout) => continue,
            Err(std::sync::mpsc::RecvTimeoutError::Disconnected) => break,
        };
        let (text, done) = chunk(kind, &line)?;
        if !text.is_empty() {
            send(json!({ "type": "text", "text": text }));
        }
        if done {
            break;
        }
    }
    Ok(())
}

/// Asks the model and streams its answer to `on_event`: { type: "text",
/// text } pieces, then { type: "done" } or { type: "error", message }.
#[tauri::command]
#[allow(clippy::too_many_arguments)]
pub async fn ai_chat(
    webview: tauri::Webview,
    state: tauri::State<'_, AiState>,
    id: String,
    kind: String,
    port: u16,
    model: String,
    messages: Value,
    num_ctx: Option<u32>,
    on_event: Channel<Value>,
) -> Result<(), String> {
    let label = webview.label();
    if label != "main" && !label.starts_with("w-") {
        return Err("not a CloverEye window".into());
    }
    if !KINDS.contains(&kind.as_str()) || port == 0 || model.trim().is_empty() || model.len() > 200 || id.len() > 64 {
        return Err("Choose a model server and a model in Settings → Assistant.".into());
    }
    if !messages.is_array() || messages.to_string().len() > MAX_REQUEST_BYTES {
        return Err("The question is too large.".into());
    }
    let body = if kind == "ollama" {
        json!({ "model": model, "messages": messages, "stream": true, "options": { "num_ctx": num_ctx.unwrap_or(8192).clamp(2048, 65536), "num_predict": MAX_ANSWER_TOKENS } })
    } else {
        json!({ "model": model, "messages": messages, "stream": true, "max_tokens": MAX_ANSWER_TOKENS })
    };
    // a Stop that came before this request started already counts
    let stop = state.stops.lock().unwrap().entry(id.clone()).or_insert_with(|| Arc::new(AtomicBool::new(false))).clone();
    if stop.load(Ordering::SeqCst) {
        state.stops.lock().unwrap().remove(&id);
        let _ = on_event.send(json!({ "type": "done" }));
        return Ok(());
    }
    let ch = on_event.clone();
    let k = kind.clone();
    let result = tauri::async_runtime::spawn_blocking(move || {
        let send = |v: Value| {
            let _ = ch.send(v);
        };
        stream(&k, port, &body, &stop, &send)
    })
    .await
    .map_err(|e| e.to_string())
    .and_then(|r| r);
    state.stops.lock().unwrap().remove(&id);
    if let Err(e) = &result {
        crate::diag::quiet(&format!("assistant: {kind} on port {port} with {model}: {e}"), false);
    }
    let _ = on_event.send(match &result {
        Ok(()) => json!({ "type": "done" }),
        Err(e) => json!({ "type": "error", "message": e }),
    });
    Ok(())
}

/// Ollama's name for a model: "llama3.1" is "llama3.1:latest".
fn same_model(a: &str, b: &str) -> bool {
    let full = |s: &str| if s.contains(':') { s.to_string() } else { format!("{s}:latest") };
    full(a) == full(b)
}

/// The models Ollama holds in memory now (/api/ps): name, GB in all and GB
/// on the graphics card. Other servers do not say, so None.
fn loaded_models(kind: &str, port: u16) -> Result<Option<Vec<Value>>, String> {
    if kind != "ollama" {
        return Ok(None);
    }
    let r = agent(Duration::from_secs(3)).get(&format!("{}/api/ps", base(port))).call().map_err(|e| match e {
        ureq::Error::Status(code, r) => status_error(code, &r.into_string().unwrap_or_default()),
        ureq::Error::Transport(t) => format!("connection refused or failed: {t}"),
    })?;
    let v: Value = serde_json::from_str(&r.into_string().map_err(|e| e.to_string())?).map_err(|e| e.to_string())?;
    let list = v.get("models").and_then(Value::as_array).cloned().unwrap_or_default();
    Ok(Some(
        list.iter()
            .filter_map(|m| {
                let name = m.get("name").or_else(|| m.get("model")).and_then(Value::as_str)?;
                Some(json!({
                    "name": name,
                    "gb": gb(m.get("size").and_then(Value::as_u64).unwrap_or(0)),
                    "vramGb": gb(m.get("size_vram").and_then(Value::as_u64).unwrap_or(0)),
                }))
            })
            .collect(),
    ))
}

/// What the model server holds in memory: { supported, models }.
/// `supported` is false for servers that cannot be asked (all but Ollama).
#[tauri::command]
pub async fn ai_loaded(kind: String, port: u16) -> Result<Value, String> {
    if !KINDS.contains(&kind.as_str()) || port == 0 {
        return Err("Choose a model server and a model in Settings → Assistant.".into());
    }
    tauri::async_runtime::spawn_blocking(move || {
        Ok(match loaded_models(&kind, port)? {
            Some(models) => json!({ "supported": true, "models": models }),
            None => json!({ "supported": false, "models": [] }),
        })
    })
    .await
    .map_err(|e| e.to_string())?
}

/// Frees the memory a model holds (Ollama: keep_alive 0). Only a model that
/// is loaded is touched, so this never loads one to unload it. Returns
/// { supported, unloaded }: unloaded is false when it was not in memory.
fn unload(kind: &str, port: u16, model: &str) -> Result<Value, String> {
    let Some(models) = loaded_models(kind, port)? else {
        return Ok(json!({ "supported": false, "unloaded": false }));
    };
    let Some(name) = models.iter().filter_map(|m| m["name"].as_str()).find(|n| same_model(n, model)).map(str::to_string) else {
        return Ok(json!({ "supported": true, "unloaded": false }));
    };
    let body = json!({ "model": name, "keep_alive": 0, "stream": false });
    agent(Duration::from_secs(30)).post(&format!("{}/api/generate", base(port))).set("Content-Type", "application/json").send_string(&body.to_string()).map_err(|e| match e {
        ureq::Error::Status(code, r) => status_error(code, &r.into_string().unwrap_or_default()),
        ureq::Error::Transport(t) => format!("connection refused or failed: {t}"),
    })?;
    crate::diag::quiet(&format!("assistant: unloaded {name} from {kind} on port {port}"), false);
    Ok(json!({ "supported": true, "unloaded": true, "name": name }))
}

#[tauri::command]
pub async fn ai_unload(kind: String, port: u16, model: String) -> Result<Value, String> {
    if !KINDS.contains(&kind.as_str()) || port == 0 || model.trim().is_empty() || model.len() > 200 {
        return Err("Choose a model server and a model in Settings → Assistant.".into());
    }
    tauri::async_runtime::spawn_blocking(move || unload(&kind, port, &model)).await.map_err(|e| e.to_string())?
}

/// Stops an answer under way.
#[tauri::command]
pub fn ai_stop(state: tauri::State<'_, AiState>, id: String) {
    if id.len() > 64 {
        return;
    }
    let mut stops = state.stops.lock().unwrap();
    if stops.len() < 256 || stops.contains_key(&id) {
        stops.entry(id).or_insert_with(|| Arc::new(AtomicBool::new(false))).store(true, Ordering::SeqCst);
    }
}

#[cfg(test)]
mod tests {
    use super::*;
    use std::io::Write;
    use std::net::TcpListener;

    #[test]
    fn ollama_lines() {
        assert_eq!(chunk("ollama", r#"{"message":{"role":"assistant","content":"Hi"},"done":false}"#).unwrap(), ("Hi".into(), false));
        assert_eq!(chunk("ollama", r#"{"message":{"content":""},"done":true}"#).unwrap(), ("".into(), true));
        assert_eq!(chunk("ollama", r#"{"error":"model 'x' not found"}"#).unwrap_err(), "model 'x' not found");
        assert_eq!(chunk("ollama", "").unwrap(), ("".into(), false));
    }

    #[test]
    fn openai_lines() {
        assert_eq!(chunk("lmstudio", r#"data: {"choices":[{"delta":{"content":"Yo"},"finish_reason":null}]}"#).unwrap(), ("Yo".into(), false));
        assert_eq!(chunk("lmstudio", r#"data: {"choices":[{"delta":{},"finish_reason":"stop"}]}"#).unwrap(), ("".into(), true));
        assert_eq!(chunk("llamacpp", "data: [DONE]").unwrap(), ("".into(), true));
        assert_eq!(chunk("jan", ": keep-alive").unwrap(), ("".into(), false));
        assert!(chunk("custom", r#"data: {"error":{"message":"busy"}}"#).unwrap_err().contains("busy"));
    }

    #[test]
    fn refusals_keep_the_servers_words() {
        assert_eq!(status_error(404, r#"{"error":"model \"q\" not found, try pulling it first"}"#), "404 model \"q\" not found, try pulling it first");
        assert_eq!(status_error(400, r#"{"error":{"message":"context too long"}}"#), "400 context too long");
        assert_eq!(status_error(500, "oops"), "500 oops");
    }

    /// A one-shot server on 127.0.0.1 that answers with `reply`.
    fn serve(reply: &'static str) -> u16 {
        let l = TcpListener::bind("127.0.0.1:0").unwrap();
        let port = l.local_addr().unwrap().port();
        std::thread::spawn(move || {
            if let Ok((mut s, _)) = l.accept() {
                // the whole request first (headers, then Content-Length bytes)
                let mut req = Vec::new();
                let mut buf = [0u8; 8192];
                loop {
                    let Ok(n) = s.read(&mut buf) else { break };
                    if n == 0 {
                        break;
                    }
                    req.extend_from_slice(&buf[..n]);
                    let text = String::from_utf8_lossy(&req);
                    if let Some(end) = text.find("\r\n\r\n") {
                        let len = text.lines().find_map(|l| l.to_ascii_lowercase().strip_prefix("content-length:").map(|v| v.trim().parse::<usize>().unwrap_or(0))).unwrap_or(0);
                        if req.len() >= end + 4 + len {
                            break;
                        }
                    }
                }
                let (head, body) = reply.split_once("\r\n\r\n").unwrap();
                let _ = write!(s, "{head}\r\nContent-Length: {}\r\n\r\n{body}", body.len());
                let _ = s.flush();
            }
        });
        port
    }

    #[test]
    fn streams_an_answer_from_a_local_server() {
        let port = serve("HTTP/1.1 200 OK\r\nContent-Type: text/event-stream\r\nConnection: close\r\n\r\ndata: {\"choices\":[{\"delta\":{\"content\":\"See \"}}]}\n\ndata: {\"choices\":[{\"delta\":{\"content\":\">>123\"}}]}\n\ndata: [DONE]\n\n");
        let got = Mutex::new(String::new());
        let stop = AtomicBool::new(false);
        stream("llamacpp", port, &json!({}), &stop, &|v| got.lock().unwrap().push_str(v["text"].as_str().unwrap())).unwrap();
        assert_eq!(*got.lock().unwrap(), "See >>123");
    }

    #[test]
    fn stop_works_while_the_server_is_still_silent() {
        let l = TcpListener::bind("127.0.0.1:0").unwrap();
        let port = l.local_addr().unwrap().port();
        std::thread::spawn(move || {
            if let Ok((mut s, _)) = l.accept() {
                let mut buf = [0u8; 65536];
                let _ = s.read(&mut buf);
                let _ = s.write_all(b"HTTP/1.1 200 OK\r\nContent-Type: text/event-stream\r\nTransfer-Encoding: chunked\r\n\r\n");
                let _ = s.flush();
                std::thread::sleep(Duration::from_secs(8)); // "reading the question"
            }
        });
        let stop = Arc::new(AtomicBool::new(false));
        let s2 = stop.clone();
        std::thread::spawn(move || {
            std::thread::sleep(Duration::from_millis(300));
            s2.store(true, Ordering::SeqCst);
        });
        let t = std::time::Instant::now();
        stream("llamacpp", port, &json!({}), &stop, &|_| {}).unwrap();
        assert!(t.elapsed() < Duration::from_secs(2), "{:?}", t.elapsed());
    }

    #[test]
    fn a_missing_model_is_reported_in_the_servers_words() {
        let port = serve("HTTP/1.1 404 Not Found\r\nContent-Type: application/json\r\nConnection: close\r\n\r\n{\"error\":\"model 'nope' not found\"}");
        let err = stream("ollama", port, &json!({}), &AtomicBool::new(false), &|_| {}).unwrap_err();
        assert_eq!(err, "404 model 'nope' not found");
    }

    /// A server on 127.0.0.1 answering `replies` in turn, one a connection;
    /// what each request was (method, path, body) is kept.
    fn serve_seq(replies: Vec<&'static str>) -> (u16, Arc<Mutex<Vec<String>>>) {
        let l = TcpListener::bind("127.0.0.1:0").unwrap();
        let port = l.local_addr().unwrap().port();
        let seen = Arc::new(Mutex::new(Vec::new()));
        let log = seen.clone();
        std::thread::spawn(move || {
            for reply in replies {
                let Ok((mut s, _)) = l.accept() else { return };
                let mut req = Vec::new();
                let mut buf = [0u8; 8192];
                loop {
                    let Ok(n) = s.read(&mut buf) else { break };
                    if n == 0 {
                        break;
                    }
                    req.extend_from_slice(&buf[..n]);
                    let text = String::from_utf8_lossy(&req);
                    if let Some(end) = text.find("\r\n\r\n") {
                        let len = text.lines().find_map(|l| l.to_ascii_lowercase().strip_prefix("content-length:").map(|v| v.trim().parse::<usize>().unwrap_or(0))).unwrap_or(0);
                        if req.len() >= end + 4 + len {
                            break;
                        }
                    }
                }
                let text = String::from_utf8_lossy(&req).to_string();
                let first = text.lines().next().unwrap_or_default().to_string();
                let body = text.split_once("\r\n\r\n").map(|(_, b)| b.to_string()).unwrap_or_default();
                log.lock().unwrap().push(format!("{first} {body}"));
                let (head, b) = reply.split_once("\r\n\r\n").unwrap();
                let _ = write!(s, "{head}\r\nContent-Length: {}\r\n\r\n{b}", b.len());
                let _ = s.flush();
            }
        });
        (port, seen)
    }

    const PS: &str = "HTTP/1.1 200 OK\r\nContent-Type: application/json\r\nConnection: close\r\n\r\n{\"models\":[{\"name\":\"llama3.1:8b\",\"size\":6000000000,\"size_vram\":5500000000}]}";
    const OK: &str = "HTTP/1.1 200 OK\r\nContent-Type: application/json\r\nConnection: close\r\n\r\n{\"done\":true,\"done_reason\":\"unload\"}";

    #[test]
    fn unloading_frees_a_loaded_model() {
        let (port, seen) = serve_seq(vec![PS, OK]);
        let r = unload("ollama", port, "llama3.1:8b").unwrap();
        assert_eq!(r["unloaded"], true);
        let seen = seen.lock().unwrap();
        assert!(seen[0].starts_with("GET /api/ps"), "{seen:?}");
        assert!(seen[1].starts_with("POST /api/generate") && seen[1].contains("\"keep_alive\":0") && seen[1].contains("llama3.1:8b"), "{seen:?}");
    }

    #[test]
    fn a_model_not_in_memory_is_left_alone() {
        // only /api/ps is asked: nothing is loaded to be unloaded
        let (port, seen) = serve_seq(vec![PS]);
        let r = unload("ollama", port, "qwen2.5:7b").unwrap();
        assert_eq!(r["unloaded"], false);
        assert_eq!(seen.lock().unwrap().len(), 1);
    }

    #[test]
    fn loaded_models_read_size_and_graphics_memory() {
        let (port, _) = serve_seq(vec![PS]);
        let list = loaded_models("ollama", port).unwrap().unwrap();
        assert_eq!(list[0]["name"], "llama3.1:8b");
        assert_eq!(list[0]["vramGb"], 5.1);
        assert!(loaded_models("lmstudio", port).unwrap().is_none(), "other servers cannot be asked");
        assert!(same_model("llama3.1", "llama3.1:latest"));
        assert!(!same_model("llama3.1:8b", "llama3.1:70b"));
    }

    #[test]
    fn detection_reads_an_ollama_model_list() {
        let port = serve("HTTP/1.1 200 OK\r\nContent-Type: application/json\r\nConnection: close\r\n\r\n{\"models\":[{\"name\":\"llama3.1:8b\"},{\"name\":\"nomic-embed-text\"}]}");
        assert_eq!(models_at("ollama", port).unwrap(), vec!["llama3.1:8b", "nomic-embed-text"]);
    }

    #[test]
    fn nothing_listening_is_no_server() {
        let l = TcpListener::bind("127.0.0.1:0").unwrap();
        let port = l.local_addr().unwrap().port();
        drop(l);
        assert!(models_at("lmstudio", port).is_none());
    }

    #[test]
    fn specs_read_the_memory() {
        assert!(specs().ram_gb > 0.5);
    }
}
