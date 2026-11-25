//! A blocking client for the Spool 0.1 HTTP binding.
mod layer;
#[allow(clippy::needless_return)]
mod replay;

pub use layer::{Entry, LayerCache, TAR, TAR_GZIP, build_layer, describe, describe_reader};
use serde::{Deserialize, Serialize, de::DeserializeOwned};
use serde_json::Value;
use sha2::{Digest, Sha256};
use std::{
    collections::{BTreeMap, HashSet},
    error::Error as StdError,
    fmt::{self, Display},
    io::{BufRead, BufReader, Read, Seek, SeekFrom, Write},
    path::Path,
    thread,
    time::{Duration, Instant},
};
pub use ureq::http::{HeaderMap, HeaderValue};
use ureq::{
    Agent, AsSendBody, Body, SendBody,
    http::{Request, Response},
};
use url::Url;

const MAX_JSON: u64 = 1024 * 1024;
const MAX_FRAME: usize = 512 * 1024;

#[derive(Debug)]
pub enum Error {
    Invalid(&'static str),
    Server {
        status: u16,
        code: String,
        message: String,
    },
    Io(std::io::Error),
    Transport(Box<ureq::Error>),
    Json(serde_json::Error),
}

impl Display for Error {
    fn fmt(&self, f: &mut fmt::Formatter<'_>) -> fmt::Result {
        match self {
            Self::Invalid(message) => f.write_str(message),
            Self::Server {
                status,
                code,
                message,
            } => write!(f, "HTTP {status} {code}: {message}"),
            Self::Io(error) => Display::fmt(error, f),
            Self::Transport(error) => Display::fmt(error, f),
            Self::Json(error) => Display::fmt(error, f),
        }
    }
}

impl StdError for Error {}
impl From<std::io::Error> for Error {
    fn from(value: std::io::Error) -> Self {
        Self::Io(value)
    }
}
impl From<ureq::Error> for Error {
    fn from(value: ureq::Error) -> Self {
        Self::Transport(Box::new(value))
    }
}
impl From<serde_json::Error> for Error {
    fn from(value: serde_json::Error) -> Self {
        Self::Json(value)
    }
}

pub type Result<T> = std::result::Result<T, Error>;

#[derive(Debug, Clone, PartialEq, Eq, Deserialize, Serialize)]
pub struct Descriptor {
    pub digest: String,
    pub size: usize,
    pub media_type: String,
}
#[derive(Debug, Deserialize)]
pub struct Task {
    pub task_id: String,
    pub state: String,
    pub cursor: i64,
    pub deadline: String,
    pub task_deadline: String,
    pub hard_deadline: String,
    pub execution_deadline_limit: Option<String>,
    pub required: Vec<Descriptor>,
    #[serde(default)]
    pub upload_plans: BTreeMap<String, Value>,
    pub result: Option<Value>,
}
impl Task {
    pub fn terminal(&self) -> bool {
        matches!(
            self.state.as_str(),
            "SUCCEEDED" | "FAILED" | "CANCELLED" | "EXPIRED"
        )
    }
}
#[derive(Debug, Deserialize)]
pub struct Artifact {
    pub path: String,
    pub url: String,
    pub size: usize,
    pub digest: String,
}
#[derive(Debug, Deserialize)]
pub struct Event {
    pub job_id: String,
    pub sequence: i64,
    #[serde(rename = "type")]
    pub kind: String,
    pub data: Value,
}

#[derive(Debug, Deserialize)]
pub struct EventPage {
    pub events: Vec<Event>,
    pub next_cursor: i64,
    pub terminal: bool,
    pub has_more: bool,
}

pub struct Client {
    base: Url,
    agent: Agent,
    transfer_agent: Agent,
    headers: Box<dyn Fn() -> Result<HeaderMap> + Send + Sync>,
    transfer_origins: HashSet<String>,
}
impl Client {
    /// Resolve per-request headers with this callback, including refreshed credentials.
    pub fn new(
        origin: &str,
        headers: impl Fn() -> Result<HeaderMap> + Send + Sync + 'static,
    ) -> Result<Self> {
        let base = Url::parse(origin).map_err(|_| Error::Invalid("Invalid runner URL"))?;
        if !matches!(base.scheme(), "http" | "https")
            || !base.username().is_empty()
            || base.password().is_some()
            || base.path() != "/"
            || base.query().is_some()
            || base.fragment().is_some()
        {
            return Err(Error::Invalid("Expected an HTTP or HTTPS runner origin"));
        }
        let agent = Agent::config_builder()
            .max_redirects(0)
            .http_status_as_error(false)
            .timeout_global(Some(Duration::from_secs(30)))
            .build()
            .into();
        let transfer_agent = Agent::config_builder()
            .max_redirects(0)
            .http_status_as_error(false)
            .timeout_global(Some(Duration::from_secs(1800)))
            .build()
            .into();
        Ok(Self {
            base,
            agent,
            transfer_agent,
            headers: Box::new(headers),
            transfer_origins: HashSet::new(),
        })
    }

    /// Permit anonymous, signed transfers to this explicit HTTPS origin.
    pub fn with_transfer_origin(mut self, origin: &str) -> Result<Self> {
        let url = Url::parse(origin).map_err(|_| Error::Invalid("Invalid transfer origin"))?;
        if url.scheme() != "https"
            || url.path() != "/"
            || url.query().is_some()
            || url.fragment().is_some()
            || !url.username().is_empty()
            || url.password().is_some()
        {
            return Err(Error::Invalid("Expected an HTTPS transfer origin"));
        }
        self.transfer_origins
            .insert(url.origin().ascii_serialization());
        Ok(self)
    }

    fn request(
        &self,
        method: &str,
        path: &str,
        bytes: impl AsSendBody,
        content: Option<(&str, Option<usize>)>,
        cursor: Option<i64>,
        authenticated: bool,
    ) -> Result<Response<Body>> {
        let url = self
            .base
            .join(path)
            .map_err(|_| Error::Invalid("Invalid runner response URL"))?;
        if (url.origin() != self.base.origin()
            && (authenticated
                || url.scheme() != "https"
                || !self
                    .transfer_origins
                    .contains(&url.origin().ascii_serialization())))
            || !url.username().is_empty()
            || url.password().is_some()
        {
            return Err(Error::Invalid("Runner returned an off-origin transfer URL"));
        }
        let mut request = Request::builder().method(method).uri(url.as_str());
        if authenticated {
            for (name, value) in (self.headers)()?.iter() {
                request = request.header(name, value);
            }
        }
        if let Some((content, length)) = content {
            request = request.header("content-type", content);
            if let Some(length) = length {
                request = request.header("content-length", length.to_string());
            }
        }
        if let Some(cursor) = cursor {
            request = request
                .header("accept", "text/event-stream")
                .header("last-event-id", cursor.to_string());
        }
        let agent = if method == "PUT"
            || url.path().ends_with("/complete")
            || (method == "GET" && url.path().contains("/artifacts/"))
        {
            &self.transfer_agent
        } else {
            &self.agent
        };
        let mut response = agent.run(
            request
                .body(bytes)
                .map_err(|_| Error::Invalid("Invalid HTTP request"))?,
        )?;
        if !response.status().is_success() {
            let failure: Value = decode(response.body_mut()).unwrap_or(Value::Null);
            return Err(Error::Server {
                status: response.status().as_u16(),
                code: failure["error"].as_str().unwrap_or("HTTP_ERROR").to_owned(),
                message: failure["message"]
                    .as_str()
                    .unwrap_or("Runner rejected the request")
                    .to_owned(),
            });
        }
        Ok(response)
    }

    fn json<T: DeserializeOwned>(
        &self,
        method: &str,
        path: &str,
        body: Option<&[u8]>,
    ) -> Result<T> {
        decode(
            self.request(
                method,
                path,
                body.unwrap_or(&[][..]),
                body.map(|_| ("application/json", None)),
                None,
                true,
            )?
            .body_mut(),
        )
    }

    pub fn capabilities(&self) -> Result<Value> {
        self.json("GET", "/.well-known/portable-task-runner", None)
    }

    pub fn submit(&self, manifest: &Value) -> Result<Task> {
        if manifest["client_request_id"]
            .as_str()
            .is_none_or(str::is_empty)
        {
            return Err(Error::Invalid("Supply a stable client_request_id"));
        }
        let bytes = serde_json::to_vec(manifest)?;
        retry(|| self.json("POST", "/v1/tasks", Some(&bytes)))
    }

    pub fn status(&self, id: &str) -> Result<Task> {
        let path = task_path(id)?;
        retry(|| self.json("GET", &path, None))
    }

    pub fn extend(&self, id: &str, task_timeout_s: u64) -> Result<Task> {
        if task_timeout_s == 0 {
            return Err(Error::Invalid(
                "Supply positive total seconds since submission",
            ));
        }
        let path = format!("{}/extend", task_path(id)?);
        let bytes = serde_json::to_vec(&serde_json::json!({ "task_timeout_s": task_timeout_s }))?;
        retry(|| self.json("POST", &path, Some(&bytes)))
    }

    pub fn event_page(&self, id: &str, cursor: i64, limit: u8) -> Result<EventPage> {
        if !(0..=9_007_199_254_740_991).contains(&cursor) || !(1..=100).contains(&limit) {
            return Err(Error::Invalid("Invalid page cursor or limit"));
        }
        self.json(
            "GET",
            &format!("{}/events?cursor={cursor}&limit={limit}", task_path(id)?),
            None,
        )
    }

    pub fn cancel(&self, id: &str) -> Result<Task> {
        self.json("POST", &format!("{}/cancel", task_path(id)?), None)
    }

    pub fn upload(&self, id: &str, layer: &Descriptor, bytes: &[u8]) -> Result<()> {
        if &describe(bytes, &layer.media_type)? != layer {
            return Err(Error::Invalid("Layer bytes do not match the descriptor"));
        }
        self.upload_with(id, layer, |url, offset, size, authenticated| {
            self.request(
                "PUT",
                url,
                &bytes[offset..offset + size],
                Some(("application/octet-stream", None)),
                None,
                authenticated,
            )
        })
    }

    /// Upload a prepared layer from a local file without buffering it in memory.
    pub fn upload_file(&self, id: &str, layer: &Descriptor, path: impl AsRef<Path>) -> Result<()> {
        let mut file = std::fs::File::open(path)?;
        if !file.metadata()?.is_file()
            || layer::describe_reader(&mut file, &layer.media_type, layer.size)? != *layer
        {
            return Err(Error::Invalid("Layer file does not match the descriptor"));
        }
        self.upload_with(id, layer, |url, offset, size, authenticated| {
            file.seek(SeekFrom::Start(offset as u64))?;
            let mut part = (&mut file).take(size as u64);
            self.request(
                "PUT",
                url,
                SendBody::from_reader(&mut part),
                Some(("application/octet-stream", Some(size))),
                None,
                authenticated,
            )
        })
    }

    fn upload_with(
        &self,
        id: &str,
        layer: &Descriptor,
        mut send_part: impl FnMut(&str, usize, usize, bool) -> Result<Response<Body>>,
    ) -> Result<()> {
        #[derive(Deserialize)]
        struct Part {
            number: usize,
            offset: usize,
            size: usize,
            url: String,
        }
        #[derive(Deserialize)]
        struct Offer {
            #[serde(rename = "type")]
            kind: Option<String>,
            method: String,
            url: Option<String>,
            authenticated: bool,
            max_size: Option<usize>,
            #[serde(default)]
            parts: Vec<Part>,
            complete_url: Option<String>,
        }
        let path = format!("{}/layers/{}/upload", task_path(id)?, layer.digest);
        let offer: Offer = retry(|| self.json("POST", &path, None))?;
        if offer.method != "PUT" || offer.max_size.is_some_and(|size| size < layer.size) {
            return Err(Error::Invalid(
                "Runner did not offer a compatible PUT transfer",
            ));
        }
        let mut put =
            |url: &str, offset, size| retry(|| send_part(url, offset, size, offer.authenticated));
        let mut parts = Vec::new();
        if offer.kind.as_deref() == Some("presigned-multipart") {
            let mut offset: usize = 0;
            for (index, part) in offer.parts.iter().enumerate() {
                let end = offset
                    .checked_add(part.size)
                    .filter(|end| *end <= layer.size)
                    .ok_or(Error::Invalid("Invalid upload part range"))?;
                if part.number != index + 1 || part.offset != offset || part.size == 0 {
                    return Err(Error::Invalid("Invalid upload part range"));
                }
                let response = put(&part.url, offset, part.size)?;
                let etag = response
                    .headers()
                    .get("etag")
                    .and_then(|value| value.to_str().ok())
                    .ok_or(Error::Invalid("Storage did not return a part ETag"))?;
                parts.push(serde_json::json!({ "number": part.number, "etag": etag }));
                offset = end;
            }
            if offset != layer.size || offer.complete_url.is_none() {
                return Err(Error::Invalid("Incomplete multipart upload plan"));
            }
        } else {
            let url = offer
                .url
                .as_deref()
                .ok_or(Error::Invalid("Runner returned no upload URL"))?;
            put(url, 0, layer.size)?;
        }
        if let Some(url) = offer.complete_url {
            let body = serde_json::to_vec(&serde_json::json!({ "parts": parts }))?;
            let _: Value = retry(|| self.json("POST", &url, Some(&body)))?;
        }
        Ok(())
    }

    /// Supply requested layers and wait for a terminal state. The timeout is for this local wait.
    pub fn wait(
        &self,
        id: &str,
        timeout: Duration,
        mut source: impl FnMut(&Descriptor) -> Result<Vec<u8>>,
    ) -> Result<Task> {
        let started = Instant::now();
        while started.elapsed() < timeout {
            let task = self.status(id)?;
            if task.terminal() {
                return Ok(task);
            }
            for descriptor in &task.required {
                if started.elapsed() >= timeout {
                    break;
                }
                let bytes = source(descriptor)?;
                if let Err(error) = self.upload(id, descriptor, &bytes)
                    && (!matches!(
                        error,
                        Error::Server {
                            status: 403 | 404 | 409,
                            ..
                        }
                    ) || self
                        .status(id)?
                        .required
                        .iter()
                        .any(|layer| layer.digest == descriptor.digest))
                {
                    return Err(error);
                }
            }
            thread::sleep(
                Duration::from_millis(250).min(timeout.saturating_sub(started.elapsed())),
            );
        }
        Err(Error::Invalid("Local wait timed out"))
    }

    pub fn artifacts(&self, id: &str) -> Result<Vec<Artifact>> {
        #[derive(Deserialize)]
        struct Artifacts {
            artifacts: Vec<Artifact>,
        }
        let result: Artifacts = self.json("GET", &format!("{}/artifacts", task_path(id)?), None)?;
        Ok(result.artifacts)
    }

    pub fn download(&self, artifact: &Artifact) -> Result<Vec<u8>> {
        if artifact.size > 512 * 1024 {
            return Err(Error::Invalid("Artifact exceeds the client limit"));
        }
        let mut bytes = Vec::new();
        self.download_to(artifact, &mut bytes)?;
        Ok(bytes)
    }

    /// Stream the declared bytes into a writer and verify the recorded SHA-256.
    pub fn download_to(&self, artifact: &Artifact, mut writer: impl Write) -> Result<()> {
        let mut response = self.request("GET", &artifact.url, &[][..], None, None, true)?;
        let mut reader = response.body_mut().as_reader();
        let mut hash = Sha256::new();
        let mut buffer = [0; 64 * 1024];
        let mut remaining = artifact.size;
        loop {
            let count = reader.read(&mut buffer)?;
            if count == 0 {
                break;
            }
            remaining = remaining
                .checked_sub(count)
                .ok_or(Error::Invalid("Artifact exceeded its declared size"))?;
            hash.update(&buffer[..count]);
            writer.write_all(&buffer[..count])?;
        }
        if remaining != 0 || layer::hex_digest(hash.finalize()) != artifact.digest {
            return Err(Error::Invalid("Artifact bytes do not match the descriptor"));
        }
        Ok(())
    }

    /// Consume one bounded SSE response. Call again using the last delivered cursor to reconnect.
    pub fn events(&self, id: &str, mut cursor: i64, mut deliver: impl FnMut(Event)) -> Result<i64> {
        if !(0..=9_007_199_254_740_991).contains(&cursor) {
            return Err(Error::Invalid("Invalid event cursor"));
        }
        let response = self.request(
            "GET",
            &format!("{}/events", task_path(id)?),
            &[][..],
            None,
            Some(cursor),
            true,
        )?;
        let content = response
            .headers()
            .get("content-type")
            .and_then(|value| value.to_str().ok())
            .unwrap_or("");
        if content.split(';').next() != Some("text/event-stream") {
            return Err(Error::Invalid("Expected an SSE response"));
        }
        let mut reader = BufReader::new(response.into_body().into_reader());
        let mut data = String::new();
        let mut frame_id = String::new();
        let mut line = String::new();
        loop {
            line.clear();
            if reader
                .by_ref()
                .take(MAX_FRAME as u64 + 1)
                .read_line(&mut line)?
                == 0
            {
                break;
            }
            if line.len() > MAX_FRAME {
                return Err(Error::Invalid("Event line exceeds client limit"));
            }
            let value = line.trim_end_matches(['\r', '\n']);
            if value.is_empty() {
                if !data.is_empty() {
                    let event: Event = serde_json::from_str(&data)?;
                    let valid = event.job_id == id
                        && frame_id == event.sequence.to_string()
                        && event.sequence <= 9_007_199_254_740_991;
                    match replay::replay_decision(cursor, event.sequence, i32::from(valid)) {
                        -1 => return Err(Error::Invalid("Invalid event identity or sequence")),
                        0 => {}
                        2 => return Ok(cursor),
                        _ => {
                            cursor = event.sequence;
                            let completed = event.kind == "task.completed";
                            deliver(event);
                            if completed {
                                break;
                            }
                        }
                    }
                    data.clear();
                }
                frame_id.clear();
                continue;
            }
            let (name, value) = value.split_once(':').unwrap_or((value, ""));
            let value = value.strip_prefix(' ').unwrap_or(value);
            match name {
                "id" => frame_id = value.to_owned(),
                "data" => {
                    if data.len() + value.len() + 1 > MAX_FRAME {
                        return Err(Error::Invalid("Event frame exceeds client limit"));
                    }
                    data.push_str(value);
                    data.push('\n');
                }
                _ => {}
            }
        }
        Ok(cursor)
    }
}

fn decode<T: DeserializeOwned>(body: &mut Body) -> Result<T> {
    let mut bytes = Vec::new();
    body.as_reader()
        .take(MAX_JSON + 1)
        .read_to_end(&mut bytes)?;
    if bytes.len() as u64 > MAX_JSON {
        return Err(Error::Invalid("JSON response exceeds client limit"));
    }
    Ok(serde_json::from_slice(&bytes)?)
}
fn task_path(id: &str) -> Result<String> {
    if id.is_empty()
        || id.len() > 128
        || matches!(id, "." | "..")
        || !id
            .bytes()
            .all(|byte| byte.is_ascii_alphanumeric() || b"._~-".contains(&byte))
    {
        return Err(Error::Invalid("Invalid task ID"));
    }
    Ok(format!("/v1/tasks/{id}"))
}
fn retry<T>(mut job: impl FnMut() -> Result<T>) -> Result<T> {
    for n in 0..3 {
        match job() {
            Err(
                Error::Transport(_)
                | Error::Server {
                    status: 408 | 429 | 500..=599,
                    ..
                },
            ) => thread::sleep(Duration::from_millis(100 << n)),
            result => return result,
        }
    }
    job()
}
