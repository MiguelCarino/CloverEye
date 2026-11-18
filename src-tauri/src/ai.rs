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
#[cfg(test)]
fn models_at(kind: &str, port: u16) -> Option<Vec<String>> {
    probe(kind, port).ok().map(|list| list.into_iter().map(|(name, _)| name).collect())
}

/// Why a probe found no model server, in a few words (for the log).
fn why_not(e: ureq::Error) -> String {
    match e {
        ureq::Error::Status(code, _) => format!("answered HTTP {code}, not as a model server"),
        ureq::Error::Transport(t) => match t.kind() {
            ureq::ErrorKind::ConnectionFailed => "nothing listening".to_string(),
            ureq::ErrorKind::Io => "no answer in time".to_string(),
            k => format!("{k}"),
        },
    }
}

/// The models a server on `port` offers, each with its size in bytes when
/// the server says (Ollama does), or why there is no model server there.
fn probe(kind: &str, port: u16) -> Result<Vec<(String, Option<u64>)>, String> {
    let a = agent(Duration::from_millis(1500));
    let not_a_list = "answered, but not with a model list";
    if kind == "ollama" {
        if let Ok(r) = a.get(&format!("{}/api/tags", base(port))).call() {
            let v: Value = r.into_string().ok().and_then(|t| serde_json::from_str(&t).ok()).ok_or(not_a_list)?;
            let list = v.get("models").and_then(Value::as_array).ok_or(not_a_list)?;
            return Ok(list.iter().filter_map(|m| Some((m.get("name").and_then(Value::as_str)?.to_string(), m.get("size").and_then(Value::as_u64)))).collect());
        }
    }
    let r = a.get(&format!("{}/v1/models", base(port))).call().map_err(why_not)?;
    let v: Value = r.into_string().ok().and_then(|t| serde_json::from_str(&t).ok()).ok_or(not_a_list)?;
    let list = v.get("data").and_then(Value::as_array).ok_or(not_a_list)?;
    Ok(list.iter().filter_map(|m| m.get("id").and_then(Value::as_str).map(|id| (id.to_string(), None))).take(200).collect())
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

/// Where the memory size comes from, for the log.
const RAM_SOURCE: &str = if cfg!(target_os = "linux") {
    "/proc/meminfo"
} else if cfg!(target_os = "macos") {
    "sysctl hw.memsize"
} else if cfg!(windows) {
    "GlobalMemoryStatusEx"
} else {
    "none"
};

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

/// How long nvidia-smi may take before the card's memory reads 0.
const NVIDIA_SMI_LIMIT: Duration = Duration::from_secs(5);

/// Whether nvidia-smi is on the PATH (so no answer means it hung, not that
/// there is no NVIDIA driver).
fn nvidia_smi_present() -> bool {
    let names: &[&str] = if cfg!(windows) { &["nvidia-smi.exe"] } else { &["nvidia-smi"] };
    std::env::var_os("PATH").is_some_and(|p| std::env::split_paths(&p).any(|d| names.iter().any(|n| d.join(n).is_file())))
}

/// The largest NVIDIA GPU's memory (nvidia-smi), or an AMD GPU's (sysfs),
/// and where it was read.
fn gpu() -> (u64, String, &'static str) {
    let mut best = (0u64, String::new());
    let mut source = "none";
    let t0 = std::time::Instant::now();
    let mut cmd = std::process::Command::new("nvidia-smi");
    cmd.args(["--query-gpu=name,memory.total", "--format=csv,noheader,nounits"]).stdin(std::process::Stdio::null());
    #[cfg(windows)]
    {
        // no console window flashing up from a windowed app
        use std::os::windows::process::CommandExt;
        cmd.creation_flags(0x0800_0000);
    }
    // A hung driver can leave nvidia-smi waiting for ever: give it 5 s.
    let answer = crate::diag::output_within(&mut cmd, NVIDIA_SMI_LIMIT);
    let present = answer.is_some() || nvidia_smi_present();
    if answer.is_none() && present {
        log_warn!("ai", "nvidia-smi did not answer in time; graphics memory reads 0", limit_s = NVIDIA_SMI_LIMIT.as_secs());
    }
    if let Some(o) = answer {
        if !o.status.success() {
            // e.g. "Failed to initialize NVML: Driver/library version mismatch"
            // after a driver update without a restart: say why it reads 0
            let why = String::from_utf8_lossy(if o.stdout.is_empty() { &o.stderr } else { &o.stdout }).lines().next().unwrap_or_default().chars().take(160).collect::<String>();
            log_warn!("ai", "nvidia-smi could not read the graphics card", error = why, code = o.status.code().unwrap_or(-1));
        }
        for line in String::from_utf8_lossy(&o.stdout).lines() {
            if let Some((name, mib)) = line.rsplit_once(',') {
                let bytes = mib.trim().parse::<u64>().unwrap_or(0) * 1_048_576;
                if bytes > best.0 {
                    best = (bytes, name.trim().to_string());
                    source = "nvidia-smi";
                }
            }
        }
    }
    log_debug!("ai", "nvidia-smi", on_path = present, answered = source == "nvidia-smi", ms = crate::diag::ms(t0));
    #[cfg(target_os = "linux")]
    if let Ok(dir) = std::fs::read_dir("/sys/class/drm") {
        for e in dir.flatten() {
            let p = e.path().join("device/mem_info_vram_total");
            if let Some(bytes) = std::fs::read_to_string(&p).ok().and_then(|t| t.trim().parse::<u64>().ok()) {
                if bytes > best.0 {
                    best = (bytes, "AMD GPU".into());
                    source = "sysfs mem_info_vram_total";
                }
            }
        }
    }
    (best.0, best.1, source)
}

pub fn specs() -> Specs {
    let t0 = std::time::Instant::now();
    let ram = ram_bytes();
    let unified = cfg!(all(target_os = "macos", target_arch = "aarch64"));
    let (vram, name, source) = if unified { (0, "Apple silicon".to_string(), "unified memory") } else { gpu() };
    log_debug!("ai", "computer specs read", ram_gb = gb(ram), ram_from = RAM_SOURCE, vram_gb = gb(vram), vram_from = source, gpu = name, ms = crate::diag::ms(t0));
    Specs { ram_gb: gb(ram), vram_gb: gb(vram), gpu: name, unified }
}

/// "llama3.1:8b (4.7 GB), qwen2.5:7b" for the log: names and sizes only.
fn model_list(list: &[(String, Option<u64>)]) -> String {
    let mut out: Vec<String> = list.iter().take(40).map(|(n, size)| match size {
        Some(b) if *b > 0 => format!("{n} ({} GB)", gb(*b)),
        _ => n.clone(),
    }).collect();
    if list.len() > 40 {
        out.push(format!("+{} more", list.len() - 40));
    }
    out.join(", ")
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
        let t0 = std::time::Instant::now();
        let found: Vec<Value> = std::thread::scope(|s| {
            let jobs: Vec<_> = probes
                .iter()
                .map(|(kind, port)| {
                    s.spawn(move || {
                        let t = std::time::Instant::now();
                        let got = probe(kind, *port);
                        match &got {
                            Ok(list) => log_debug!("ai", "probe: model server found", kind = kind, port = port, models = list.len(), list = model_list(list), ms = crate::diag::ms(t)),
                            Err(why) => log_debug!("ai", "probe: no model server", kind = kind, port = port, why = why, ms = crate::diag::ms(t)),
                        }
                        got.ok().map(|list| json!({ "kind": kind, "port": port, "models": list.into_iter().map(|(n, _)| n).collect::<Vec<_>>() }))
                    })
                })
                .collect();
            jobs.into_iter().filter_map(|j| j.join().ok().flatten()).collect()
        });
        let sp = specs();
        // for the diagnostics report: what was found, never what is asked
        let list: Vec<String> = found.iter().map(|s| format!("{}:{} ({} models)", s["kind"].as_str().unwrap_or("?"), s["port"], s["models"].as_array().map_or(0, Vec::len))).collect();
        log_info!(
            "ai",
            "model servers detected",
            probed = probes.iter().map(|(k, p)| format!("{k}:{p}")).collect::<Vec<_>>().join(","),
            found = if list.is_empty() { "none".to_string() } else { list.join(", ") },
            ram_gb = sp.ram_gb,
            vram_gb = sp.vram_gb,
            gpu = sp.gpu,
            ms = crate::diag::ms(t0)
        );
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

/// What one answer took, for the log: timings, sizes and the server's own
/// counts when it gives them. Never the text.
#[derive(Debug, Default)]
pub(crate) struct StreamStats {
    /// When the server's answer started (its headers), from the request.
    pub headers_ms: Option<u128>,
    /// When the first piece of text came, from the request.
    pub first_ms: Option<u128>,
    pub chunks: u64,
    pub chars_out: usize,
    pub stop: Option<String>,
    pub tokens_in: Option<u64>,
    pub tokens_out: Option<u64>,
    /// The server's own time for the answer's tokens and for the prompt.
    pub eval_ms: Option<f64>,
    pub prompt_ms: Option<f64>,
    /// Ollama: how long loading the model took for this question.
    pub load_ms: Option<f64>,
    pub status: Option<u16>,
    pub cancelled: bool,
}

/// The server's counts and stop reason from one line of its stream, when
/// the line has them (Ollama's last line; an OpenAI-style finish_reason,
/// usage, or llama.cpp's timings).
fn read_meta(kind: &str, line: &str, st: &mut StreamStats) {
    let line = line.trim();
    let data = if kind == "ollama" { line } else { line.strip_prefix("data:").map(str::trim).unwrap_or("") };
    if data.is_empty() || data == "[DONE]" {
        return;
    }
    let Ok(v) = serde_json::from_str::<Value>(data) else { return };
    let ns_ms = |k: &str| v.get(k).and_then(Value::as_f64).map(|ns| ns / 1e6);
    if kind == "ollama" {
        if v.get("done").and_then(Value::as_bool) == Some(true) {
            st.stop = v.get("done_reason").and_then(Value::as_str).map(str::to_string).or(Some("done".into()));
            st.tokens_in = v.get("prompt_eval_count").and_then(Value::as_u64).or(st.tokens_in);
            st.tokens_out = v.get("eval_count").and_then(Value::as_u64).or(st.tokens_out);
            st.eval_ms = ns_ms("eval_duration").or(st.eval_ms);
            st.prompt_ms = ns_ms("prompt_eval_duration").or(st.prompt_ms);
            st.load_ms = ns_ms("load_duration").or(st.load_ms);
        }
        return;
    }
    if let Some(r) = v.pointer("/choices/0/finish_reason").and_then(Value::as_str) {
        st.stop = Some(r.to_string());
    }
    if let Some(u) = v.get("usage").filter(|u| u.is_object()) {
        st.tokens_in = u.get("prompt_tokens").and_then(Value::as_u64).or(st.tokens_in);
        st.tokens_out = u.get("completion_tokens").and_then(Value::as_u64).or(st.tokens_out);
    }
    if let Some(t) = v.get("timings").filter(|t| t.is_object()) {
        st.tokens_in = t.get("prompt_n").and_then(Value::as_u64).or(st.tokens_in);
        st.tokens_out = t.get("predicted_n").and_then(Value::as_u64).or(st.tokens_out);
        st.eval_ms = t.get("predicted_ms").and_then(Value::as_f64).or(st.eval_ms);
        st.prompt_ms = t.get("prompt_ms").and_then(Value::as_f64).or(st.prompt_ms);
    }
}

/// Tokens a second for the answer: the server's counts when it gave them,
/// else the pieces streamed after the first (about one token each).
fn rate(st: &StreamStats, total_ms: u128) -> Option<(f64, &'static str)> {
    if let (Some(n), Some(ms)) = (st.tokens_out, st.eval_ms.filter(|m| *m > 0.0)) {
        return Some(((n as f64 / (ms / 1000.0) * 10.0).round() / 10.0, "server"));
    }
    let first = st.first_ms?;
    let span = total_ms.saturating_sub(first);
    (st.chunks > 1 && span > 0).then(|| (((st.chunks - 1) as f64 / (span as f64 / 1000.0) * 10.0).round() / 10.0, "pieces"))
}

/// An error for the log: the server's own words when they read like a
/// system message, but never a line of its stream (that could hold the
/// answer) and never a body that may echo the question (FastAPI's 422
/// `{"detail":[{"input": ...}]}`, a quoted piece of the content, a raw
/// page): those keep only the status and their length.
fn loggable(e: &str) -> String {
    if e.starts_with("unexpected answer") {
        return "unexpected answer (not the server's stream format)".to_string();
    }
    let (status, rest) = match e.split_once(' ') {
        Some((c, r)) if c.len() == 3 && c.bytes().all(|b| b.is_ascii_digit()) => (Some(c), r),
        _ => (None, e),
    };
    if system_like(rest) {
        return e.to_string();
    }
    let n = rest.chars().count();
    match status {
        Some(c) => format!("{c} (message not shown, {n} chars)"),
        None => format!("(message not shown, {n} chars)"),
    }
}

/// Short, one line, no JSON, markup or address, and anything in quotes is
/// one word (a model name, not a sentence of the question).
fn system_like(m: &str) -> bool {
    if m.is_empty() || m.chars().count() > 160 || m.contains("://") {
        return false;
    }
    if m.chars().any(|c| c.is_control() || matches!(c, '{' | '}' | '[' | ']' | '<' | '>' | '`')) {
        return false;
    }
    for q in ['"', '\''] {
        // quoted parts are the odd pieces once split on the quote
        let parts: Vec<&str> = m.split(q).collect();
        if parts.len() % 2 == 0 {
            return false; // an unclosed quote
        }
        if parts.iter().skip(1).step_by(2).any(|p| p.len() > 64 || p.contains(char::is_whitespace)) {
            return false;
        }
    }
    true
}

#[cfg(test)]
fn stream(kind: &str, port: u16, body: &Value, stop: &AtomicBool, send: &dyn Fn(Value)) -> Result<(), String> {
    stream_with(kind, port, body, stop, send, &mut StreamStats::default())
}

fn stream_with(kind: &str, port: u16, body: &Value, stop: &AtomicBool, send: &dyn Fn(Value), st: &mut StreamStats) -> Result<(), String> {
    let path = if kind == "ollama" { "/api/chat" } else { "/v1/chat/completions" };
    let t0 = std::time::Instant::now();
    // a model that is still loading can take minutes before its first word
    let res = agent(Duration::from_secs(300)).post(&format!("{}{path}", base(port))).set("Content-Type", "application/json").send_string(&body.to_string());
    let res = match res {
        Ok(r) => r,
        Err(ureq::Error::Status(code, r)) => {
            st.status = Some(code);
            return Err(status_error(code, &r.into_string().unwrap_or_default()));
        }
        Err(ureq::Error::Transport(t)) => return Err(format!("connection refused or failed: {t}")),
    };
    st.status = Some(res.status());
    st.headers_ms = Some(t0.elapsed().as_millis());
    log_debug!("ai", "the server took the question; waiting for the first piece", status = res.status(), ms = t0.elapsed().as_millis());
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
            st.cancelled = true;
            return Ok(());
        }
        let line = match rx.recv_timeout(Duration::from_millis(200)) {
            Ok(l) => l.map_err(|e| e.to_string())?,
            Err(std::sync::mpsc::RecvTimeoutError::Timeout) => continue,
            Err(std::sync::mpsc::RecvTimeoutError::Disconnected) => break,
        };
        let (text, done) = chunk(kind, &line)?;
        read_meta(kind, &line, st);
        if !text.is_empty() {
            if st.first_ms.is_none() {
                st.first_ms = Some(t0.elapsed().as_millis());
                log_debug!("ai", "first piece of the answer", ms = t0.elapsed().as_millis());
            }
            st.chunks += 1;
            st.chars_out += text.chars().count();
            send(json!({ "type": "text", "text": text }));
        }
        if done {
            // the usage or timings can come on a line after the last piece
            // (OpenAI-style servers; blank lines between), for a moment only
            if kind != "ollama" {
                let until = std::time::Instant::now() + Duration::from_millis(100);
                for _ in 0..6 {
                    let left = until.saturating_duration_since(std::time::Instant::now());
                    let Ok(Ok(next)) = rx.recv_timeout(left) else { break };
                    if next.contains("[DONE]") {
                        break;
                    }
                    read_meta(kind, &next, st);
                }
            }
            break;
        }
    }
    Ok(())
}

/// The question's shape for the log: how many messages, characters by role
/// and pictures. Never the text.
fn question_shape(messages: &Value) -> (usize, usize, usize, usize) {
    let (mut system, mut user, mut images) = (0, 0, 0);
    let list = messages.as_array().map(Vec::as_slice).unwrap_or_default();
    for m in list {
        let chars = match m.get("content") {
            Some(Value::String(t)) => t.chars().count(),
            Some(Value::Array(parts)) => parts
                .iter()
                .map(|p| {
                    if p.get("type").and_then(Value::as_str) == Some("image_url") {
                        images += 1;
                    }
                    p.get("text").and_then(Value::as_str).map_or(0, |t| t.chars().count())
                })
                .sum(),
            _ => 0,
        };
        images += m.get("images").and_then(Value::as_array).map_or(0, Vec::len);
        if m.get("role").and_then(Value::as_str) == Some("system") {
            system += chars;
        } else {
            user += chars;
        }
    }
    (list.len(), system, user, images)
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
    let ctx = num_ctx.unwrap_or(8192).clamp(2048, 65536);
    let body = if kind == "ollama" {
        json!({ "model": model, "messages": messages, "stream": true, "options": { "num_ctx": ctx, "num_predict": MAX_ANSWER_TOKENS } })
    } else {
        json!({ "model": model, "messages": messages, "stream": true, "max_tokens": MAX_ANSWER_TOKENS })
    };
    let (count, system_chars, user_chars, images) = question_shape(&messages);
    let request_bytes = body.to_string().len();
    log_debug!(
        "ai",
        "question sent",
        kind = kind,
        port = port,
        model = model,
        messages = count,
        system_chars = system_chars,
        prompt_chars = user_chars,
        images = images,
        request_bytes = request_bytes,
        num_ctx = if kind == "ollama" { ctx.to_string() } else { "server's".to_string() },
        max_tokens = MAX_ANSWER_TOKENS,
        win = label
    );
    let t0 = std::time::Instant::now();
    // a Stop that came before this request started already counts
    let stop = state.stops.lock().unwrap().entry(id.clone()).or_insert_with(|| Arc::new(AtomicBool::new(false))).clone();
    if stop.load(Ordering::SeqCst) {
        state.stops.lock().unwrap().remove(&id);
        log_info!("ai", "question stopped before it was sent", kind = kind, model = model);
        let _ = on_event.send(json!({ "type": "done" }));
        return Ok(());
    }
    let ch = on_event.clone();
    let k = kind.clone();
    let (result, st) = tauri::async_runtime::spawn_blocking(move || {
        let send = |v: Value| {
            let _ = ch.send(v);
        };
        let mut st = StreamStats::default();
        let r = stream_with(&k, port, &body, &stop, &send, &mut st);
        (r, st)
    })
    .await
    .map_err(|e| e.to_string())
    .map(|(r, st)| (r, Some(st)))
    .unwrap_or_else(|e| (Err(e), None));
    state.stops.lock().unwrap().remove(&id);
    let st = st.unwrap_or_default();
    let total = t0.elapsed().as_millis();
    let opt = |v: Option<u64>| v.map_or_else(|| "?".to_string(), |n| n.to_string());
    let (tps, rate_from) = rate(&st, total).map_or(("?".to_string(), "none"), |(r, from)| (r.to_string(), from));
    let outcome = match &result {
        Ok(()) if st.cancelled => "stopped by the person",
        Ok(()) => "answered",
        Err(_) => "failed",
    };
    let fields = (
        st.first_ms.map_or_else(|| "none".to_string(), |m| m.to_string()),
        st.load_ms.map_or_else(|| "?".to_string(), |m| format!("{m:.0}")),
        st.stop.clone().unwrap_or_else(|| if st.cancelled { "cancelled".into() } else { "?".into() }),
    );
    if let Some(load) = st.load_ms.filter(|m| *m >= 500.0) {
        log_info!("ai", "the server loaded the model for this question", kind = kind, model = model, load_ms = format!("{load:.0}"));
    }
    log_debug!(
        "ai",
        "server timings",
        headers_ms = st.headers_ms.map_or_else(|| "?".to_string(), |m| m.to_string()),
        prompt_eval_ms = st.prompt_ms.map_or_else(|| "?".to_string(), |m| format!("{m:.0}")),
        eval_ms = st.eval_ms.map_or_else(|| "?".to_string(), |m| format!("{m:.0}")),
        pieces = st.chunks
    );
    match &result {
        Ok(()) => log_info!(
            "ai",
            outcome,
            kind = kind,
            port = port,
            model = model,
            prompt_chars = system_chars + user_chars,
            num_ctx = if kind == "ollama" { ctx.to_string() } else { "server's".to_string() },
            first_token_ms = fields.0,
            total_ms = total,
            tokens_in = opt(st.tokens_in),
            tokens_out = opt(st.tokens_out),
            tok_per_s = tps,
            rate_from = rate_from,
            stop = fields.2,
            answer_chars = st.chars_out,
            load_ms = fields.1
        ),
        Err(e) => log_warn!(
            "ai",
            "question failed",
            kind = kind,
            port = port,
            model = model,
            status = st.status.map_or_else(|| "none".to_string(), |s| s.to_string()),
            error = loggable(e),
            first_token_ms = fields.0,
            total_ms = total,
            answer_chars = st.chars_out
        ),
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
    let t0 = std::time::Instant::now();
    let r = agent(Duration::from_secs(3)).get(&format!("{}/api/ps", base(port))).call().map_err(|e| match e {
        ureq::Error::Status(code, r) => status_error(code, &r.into_string().unwrap_or_default()),
        ureq::Error::Transport(t) => format!("connection refused or failed: {t}"),
    })?;
    let v: Value = serde_json::from_str(&r.into_string().map_err(|e| e.to_string())?).map_err(|e| e.to_string())?;
    let list = v.get("models").and_then(Value::as_array).cloned().unwrap_or_default();
    if crate::diag::detailed() {
        let named: Vec<String> = list
            .iter()
            .filter_map(|m| {
                let name = m.get("name").or_else(|| m.get("model")).and_then(Value::as_str)?;
                Some(format!("{name} ({} GB, {} GB on the graphics card)", gb(m.get("size").and_then(Value::as_u64).unwrap_or(0)), gb(m.get("size_vram").and_then(Value::as_u64).unwrap_or(0))))
            })
            .collect();
        log_debug!("ai", "models in memory", kind = kind, port = port, loaded = if named.is_empty() { "none".to_string() } else { named.join(", ") }, ms = crate::diag::ms(t0));
    }
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
        Ok(match loaded_models(&kind, port).inspect_err(|e| log_warn!("ai", "could not ask what is in memory", kind = kind, port = port, error = loggable(e)))? {
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
    let t0 = std::time::Instant::now();
    agent(Duration::from_secs(30)).post(&format!("{}/api/generate", base(port))).set("Content-Type", "application/json").send_string(&body.to_string()).map_err(|e| match e {
        ureq::Error::Status(code, r) => status_error(code, &r.into_string().unwrap_or_default()),
        ureq::Error::Transport(t) => format!("connection refused or failed: {t}"),
    })?;
    log_info!("ai", "model unloaded", kind = kind, port = port, model = name, ms = crate::diag::ms(t0));
    Ok(json!({ "supported": true, "unloaded": true, "name": name }))
}

#[tauri::command]
pub async fn ai_unload(kind: String, port: u16, model: String) -> Result<Value, String> {
    if !KINDS.contains(&kind.as_str()) || port == 0 || model.trim().is_empty() || model.len() > 200 {
        return Err("Choose a model server and a model in Settings → Assistant.".into());
    }
    tauri::async_runtime::spawn_blocking(move || {
        let r = unload(&kind, port, &model);
        match &r {
            Ok(v) if v["unloaded"] == false => log_info!("ai", "unload: model was not in memory", kind = kind, port = port, model = model, supported = v["supported"]),
            Ok(_) => {}
            Err(e) => log_warn!("ai", "unload failed", kind = kind, port = port, model = model, error = loggable(e)),
        }
        r
    })
    .await
    .map_err(|e| e.to_string())?
}

/// Stops an answer under way.
#[tauri::command]
pub fn ai_stop(state: tauri::State<'_, AiState>, id: String) {
    if id.len() > 64 {
        return;
    }
    log_debug!("ai", "stop asked");
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
    fn the_servers_counts_and_stop_reason_are_read_never_the_text() {
        let mut st = StreamStats::default();
        read_meta("ollama", r#"{"message":{"content":"hi"},"done":false}"#, &mut st);
        assert!(st.stop.is_none() && st.tokens_out.is_none());
        read_meta("ollama", r#"{"message":{"content":""},"done":true,"done_reason":"length","prompt_eval_count":812,"eval_count":256,"eval_duration":4000000000,"prompt_eval_duration":900000000,"load_duration":2500000000}"#, &mut st);
        assert_eq!((st.stop.as_deref(), st.tokens_in, st.tokens_out), (Some("length"), Some(812), Some(256)));
        assert_eq!((st.eval_ms, st.load_ms), (Some(4000.0), Some(2500.0)));
        assert_eq!(rate(&st, 9000), Some((64.0, "server")));

        let mut st = StreamStats::default();
        read_meta("lmstudio", r#"data: {"choices":[{"delta":{},"finish_reason":"stop"}]}"#, &mut st);
        read_meta("lmstudio", r#"data: {"choices":[],"usage":{"prompt_tokens":100,"completion_tokens":20}}"#, &mut st);
        assert_eq!((st.stop.as_deref(), st.tokens_in, st.tokens_out), (Some("stop"), Some(100), Some(20)));
        let mut st = StreamStats::default();
        read_meta("llamacpp", r#"data: {"choices":[{"delta":{},"finish_reason":"stop"}],"timings":{"prompt_n":50,"predicted_n":30,"predicted_ms":1500.0,"prompt_ms":200.0}}"#, &mut st);
        assert_eq!((st.tokens_out, st.eval_ms), (Some(30), Some(1500.0)));
        assert_eq!(rate(&st, 0), Some((20.0, "server")));
        read_meta("llamacpp", "data: [DONE]", &mut st);
        read_meta("jan", ": keep-alive", &mut st);
        // without counts: the pieces after the first
        let st = StreamStats { first_ms: Some(1000), chunks: 11, ..StreamStats::default() };
        assert_eq!(rate(&st, 3000), Some((5.0, "pieces")));
        assert_eq!(rate(&StreamStats::default(), 3000), None);
    }

    #[test]
    fn the_question_is_measured_not_kept() {
        let m = json!([
            { "role": "system", "content": "You read posts." },
            { "role": "user", "content": "What is >>123 about?", "images": ["AAAA"] },
            { "role": "user", "content": [{ "type": "text", "text": "And this?" }, { "type": "image_url", "image_url": { "url": "data:x" } }] }
        ]);
        assert_eq!(question_shape(&m), (3, 15, 29, 2));
        assert_eq!(question_shape(&json!("nope")), (0, 0, 0, 0));
        assert_eq!(loggable("unexpected answer: the model said secret things"), "unexpected answer (not the server's stream format)");
        assert_eq!(loggable("404 model 'x' not found"), "404 model 'x' not found");
    }

    #[test]
    fn errors_that_may_echo_the_question_are_not_logged() {
        assert_eq!(loggable(&status_error(404, r#"{"error":"model \"q\" not found, try pulling it first"}"#)), "404 model \"q\" not found, try pulling it first");
        assert_eq!(loggable("400 the request exceeds the available context size, try increasing it"), "400 the request exceeds the available context size, try increasing it");
        assert_eq!(loggable("Connection refused (os error 111)"), "Connection refused (os error 111)");
        // FastAPI's 422 echoes the message content
        let e = status_error(422, r#"{"detail":[{"type":"string_type","loc":["body","messages",0],"msg":"bad","input":"Summarise this thread: anon says my landlord in Leeds"}]}"#);
        let l = loggable(&e);
        assert!(l.starts_with("422 (message not shown, ") && !l.contains("landlord"), "{l}");
        // a server message quoting the content
        let l = loggable("400 Invalid content: 'Summarise this thread: anon says'");
        assert!(l.starts_with("400 (message not shown") && !l.contains("anon"), "{l}");
        // a raw body that is not JSON with an error
        let l = loggable(&status_error(500, "<html>Summarise this thread</html>"));
        assert!(!l.contains("Summarise"), "{l}");
        assert!(!loggable("{\"error\":\"my question\"}").contains("question"));
    }

    #[test]
    fn a_stream_records_its_timings_and_counts() {
        let port = serve("HTTP/1.1 200 OK\r\nContent-Type: text/event-stream\r\nConnection: close\r\n\r\ndata: {\"choices\":[{\"delta\":{\"content\":\"See \"}}]}\n\ndata: {\"choices\":[{\"delta\":{\"content\":\">>123\"},\"finish_reason\":\"stop\"}]}\n\ndata: {\"choices\":[],\"usage\":{\"prompt_tokens\":9,\"completion_tokens\":2}}\n\ndata: [DONE]\n\n");
        let mut st = StreamStats::default();
        stream_with("llamacpp", port, &json!({}), &AtomicBool::new(false), &|_| {}, &mut st).unwrap();
        assert_eq!((st.chunks, st.chars_out, st.status), (2, 9, Some(200)));
        assert!(st.first_ms.is_some() && st.headers_ms.is_some());
        assert_eq!((st.stop.as_deref(), st.tokens_in, st.tokens_out), (Some("stop"), Some(9), Some(2)));
        assert!(!st.cancelled);
    }

    #[test]
    fn a_probe_says_why_there_is_no_server() {
        let l = TcpListener::bind("127.0.0.1:0").unwrap();
        let port = l.local_addr().unwrap().port();
        drop(l);
        assert_eq!(probe("lmstudio", port).unwrap_err(), "nothing listening");
        let port = serve("HTTP/1.1 404 Not Found\r\nConnection: close\r\n\r\nno");
        assert_eq!(probe("jan", port).unwrap_err(), "answered HTTP 404, not as a model server");
        let port = serve("HTTP/1.1 200 OK\r\nContent-Type: application/json\r\nConnection: close\r\n\r\n{\"models\":[{\"name\":\"llama3.1:8b\",\"size\":4920000000}]}");
        let list = probe("ollama", port).unwrap();
        assert_eq!(list, vec![("llama3.1:8b".to_string(), Some(4_920_000_000))]);
        assert_eq!(model_list(&list), "llama3.1:8b (4.6 GB)");
    }

    #[test]
    fn specs_read_the_memory() {
        assert!(specs().ram_gb > 0.5);
    }
}
