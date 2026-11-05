use std::io::Read;
use std::sync::Arc;
use std::time::Duration;

/// One GET. Headers are exactly what goes on the wire besides what the
/// transport itself adds (Host, Accept-Encoding).
#[derive(Debug, Clone, PartialEq, Eq)]
pub struct Request {
    pub url: String,
    pub headers: Vec<(String, String)>,
}

impl Request {
    pub fn header(&self, name: &str) -> Option<&str> {
        self.headers
            .iter()
            .find(|(k, _)| k.eq_ignore_ascii_case(name))
            .map(|(_, v)| v.as_str())
    }
}

/// Any HTTP answer, success or not.
#[derive(Debug, Clone, PartialEq, Eq)]
pub struct Response {
    pub status: u16,
    pub headers: Vec<(String, String)>,
    pub body: Vec<u8>,
}

impl Response {
    pub fn header(&self, name: &str) -> Option<&str> {
        self.headers
            .iter()
            .find(|(k, _)| k.eq_ignore_ascii_case(name))
            .map(|(_, v)| v.as_str())
    }
}

/// The network. `Err` means no HTTP answer at all.
pub trait Transport: Send + Sync {
    fn send(&self, req: &Request) -> Result<Response, String>;
}

impl<T: Transport + ?Sized> Transport for Arc<T> {
    fn send(&self, req: &Request) -> Result<Response, String> {
        (**self).send(req)
    }
}

/// Real transport: ureq with rustls (no OpenSSL), gzip, short timeouts, no
/// cookies sent by the read API path, and a cap on the body size. Redirects
/// are not followed: a follow-up GET would skip the queue and its 1 s floor,
/// so a 3xx comes back to the client as an ordinary (failed) answer.
pub struct UreqTransport {
    agent: ureq::Agent,
    max_body: u64,
}

impl UreqTransport {
    /// 8 MiB is far above the largest catalog or thread JSON (a /g/
    /// catalog is about 0.4 MB).
    pub const DEFAULT_MAX_BODY: u64 = 8 * 1024 * 1024;

    pub fn new() -> Self {
        let agent = ureq::AgentBuilder::new()
            .timeout_connect(Duration::from_secs(10))
            .timeout(Duration::from_secs(30))
            .redirects(0)
            .build();
        Self {
            agent,
            max_body: Self::DEFAULT_MAX_BODY,
        }
    }
}

impl Default for UreqTransport {
    fn default() -> Self {
        Self::new()
    }
}

impl Transport for UreqTransport {
    fn send(&self, req: &Request) -> Result<Response, String> {
        let mut r = self.agent.get(&req.url);
        for (k, v) in &req.headers {
            r = r.set(k, v);
        }
        let resp = match r.call() {
            Ok(resp) => resp,
            // 4xx/5xx are answers, not transport errors.
            Err(ureq::Error::Status(_, resp)) => resp,
            Err(e) => return Err(e.to_string()),
        };
        let status = resp.status();
        let headers = resp
            .headers_names()
            .into_iter()
            .filter_map(|n| resp.header(&n).map(|v| (n.clone(), v.to_string())))
            .collect();
        let mut body = Vec::new();
        resp.into_reader()
            .take(self.max_body + 1)
            .read_to_end(&mut body)
            .map_err(|e| e.to_string())?;
        if body.len() as u64 > self.max_body {
            return Err(format!("response larger than {} bytes", self.max_body));
        }
        Ok(Response { status, headers, body })
    }
}
