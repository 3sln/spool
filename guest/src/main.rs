mod execute;
mod workspace;

use execute::{execute, now_ms, prepare};
use serde::Deserialize;
use serde_json::{Value, json};
use std::{
    env,
    io::{self, BufRead, BufReader, Read, Write},
    path::{Path, PathBuf},
    process,
    sync::{Arc, Mutex},
    thread,
    time::{Duration, Instant},
};

const MAX_HEADER: u64 = 64 * 1024;
const MAX_INPUT: u64 = 12 * 1024 * 1024;
const CONTACT_TIMEOUT: Duration = Duration::from_secs(120);

#[derive(Deserialize)]
pub struct Work {
    manifest: Manifest,
    #[serde(default)]
    layers: Vec<String>,
    #[serde(default = "no_deadline")]
    expires: u64,
    #[serde(default)]
    claim: String,
}

fn no_deadline() -> u64 {
    u64::MAX
}

#[derive(Deserialize)]
struct Manifest {
    environment: Environment,
    command: Command,
    resources: Resources,
    #[serde(default)]
    outputs: Outputs,
}

#[derive(Deserialize)]
struct Environment {
    layers: Vec<Layer>,
}

#[derive(Deserialize)]
pub struct Layer {
    size: usize,
    digest: String,
    media_type: String,
}

#[derive(Deserialize)]
struct Command {
    argv: Vec<String>,
    cwd: String,
}

#[derive(Deserialize)]
struct Resources {
    timeout_s: u64,
    #[serde(default = "default_workspace")]
    disk_mib: u32,
}

#[derive(Default, Deserialize)]
struct Outputs {
    paths: Vec<String>,
}

fn read_work(input: impl Read) -> io::Result<Work> {
    let mut raw = Vec::new();
    input.take(MAX_INPUT + 1).read_to_end(&mut raw)?;
    if raw.len() as u64 > MAX_INPUT {
        return Err(io::Error::other("guest input exceeds limit"));
    }
    Ok(serde_json::from_slice(&raw)?)
}

fn default_workspace() -> u32 {
    256
}

fn read_header(reader: &mut impl BufRead) -> io::Result<Work> {
    let mut header = Vec::new();
    reader.take(MAX_HEADER).read_until(b'\n', &mut header)?;
    if !header.ends_with(b"\n") {
        return Err(io::Error::other("incomplete work header"));
    }
    Ok(serde_json::from_slice(&header)?)
}

struct Running {
    claim: String,
    expires: u64,
    contact: Instant,
    staging: bool,
    logs: Vec<Value>,
    result: Option<Value>,
}

type Task = Arc<Mutex<Option<Running>>>;

fn reply(request: tiny_http::Request, status: u16, body: Option<Value>) {
    // A lost response is safe to retry using the same claim or log cursor.
    if let Some(body) = body {
        let header = tiny_http::Header::from_bytes("Content-Type", "application/json").unwrap();
        let _ = request.respond(
            tiny_http::Response::from_string(body.to_string())
                .with_status_code(status)
                .with_header(header),
        );
    } else {
        let _ = request.respond(tiny_http::Response::empty(status));
    }
}

fn start(mut request: tiny_http::Request, root: &Path, task: &Task) {
    let mut input = BufReader::new(request.as_reader());
    let Ok(work) = read_header(&mut input) else {
        drop(input);
        reply(request, 400, None);
        return;
    };
    if work.expires <= now_ms() || work.expires == no_deadline() || work.claim.is_empty() {
        drop(input);
        reply(request, 400, None);
        return;
    }
    *task.lock().unwrap() = Some(Running {
        claim: work.claim.clone(),
        expires: work.expires,
        contact: Instant::now(),
        staging: true,
        logs: Vec::new(),
        result: None,
    });
    let prepared = prepare(&work, root, Some(&mut input));
    drop(input);
    {
        let mut current = task.lock().unwrap();
        let current = current.as_mut().unwrap();
        current.staging = false;
        current.contact = Instant::now();
        if let Err(error) = &prepared {
            current.result = Some(error.clone());
        }
    }
    reply(request, 202, None);
    if prepared.is_err() {
        return;
    }
    let root = root.to_owned();
    let task = Arc::clone(task);
    thread::spawn(move || {
        let result = execute(&work, &root, |channel, text| {
            task.lock()
                .unwrap()
                .as_mut()
                .unwrap()
                .logs
                .push(json!({ "channel": channel, "text": text }));
        });
        task.lock().unwrap().as_mut().unwrap().result = Some(result);
    });
}

fn status(request: tiny_http::Request, query: &str, task: &Task) {
    let Some(cursor) = query
        .strip_prefix("cursor=")
        .and_then(|cursor| cursor.parse::<usize>().ok())
    else {
        reply(request, 400, None);
        return;
    };
    let valid_claim = |claim: &str| {
        request
            .headers()
            .iter()
            .any(|header| header.field.equiv("x-spool-claim") && header.value.as_str() == claim)
    };
    let (code, page) = {
        let mut running = task.lock().unwrap();
        match running.as_mut().filter(|job| valid_claim(&job.claim)) {
            None => (404, None),
            Some(job) if cursor > job.logs.len() => (400, None),
            Some(job) => {
                job.contact = Instant::now();
                let next = job.logs.len().min(cursor + 32);
                let result = if next == job.logs.len() {
                    job.result.as_ref()
                } else {
                    None
                };
                (
                    200,
                    Some(
                        json!({ "logs": &job.logs[cursor..next], "cursor": next, "result": result }),
                    ),
                )
            }
        }
    };
    reply(request, code, page);
}

fn http(root: &Path) -> Result<(), Box<dyn std::error::Error + Send + Sync>> {
    let server = tiny_http::Server::http("0.0.0.0:8080")?;
    let task: Task = Arc::new(Mutex::new(None));
    let watchdog = Arc::clone(&task);
    thread::spawn(move || {
        loop {
            thread::sleep(Duration::from_millis(250));
            if watchdog.lock().unwrap().as_ref().is_some_and(|job| {
                now_ms() >= job.expires
                    || (!job.staging && job.contact.elapsed() >= CONTACT_TIMEOUT)
            }) {
                process::exit(124);
            }
        }
    });
    let mut started = false;
    for request in server.incoming_requests() {
        let url = request.url().to_owned();
        let (path, query) = url.split_once('?').unwrap_or((&url, ""));
        match (request.method(), path) {
            (tiny_http::Method::Get, "/healthz") => reply(request, 204, None),
            (tiny_http::Method::Post, "/start") => {
                if started {
                    reply(request, 409, None);
                } else {
                    started = true;
                    let root = root.to_owned();
                    let task = Arc::clone(&task);
                    thread::spawn(move || start(request, &root, &task));
                }
            }
            (tiny_http::Method::Get, "/status") => status(request, query, &task),
            _ => reply(request, 404, None),
        }
    }
    Ok(())
}

fn start_watchdog(expires: u64) {
    if expires == no_deadline() {
        return;
    }
    thread::spawn(move || {
        loop {
            if now_ms() >= expires {
                process::exit(124);
            }
            thread::sleep(Duration::from_millis(250));
        }
    });
}

fn stdio(root: &Path, stream: bool) -> io::Result<()> {
    // Keep a finite lifetime if the engine attach is interrupted mid-upload.
    let startup = Arc::new(std::sync::atomic::AtomicBool::new(true));
    let receiving = Arc::clone(&startup);
    thread::spawn(move || {
        thread::sleep(Duration::from_secs(30));
        if receiving.load(std::sync::atomic::Ordering::Acquire) {
            process::exit(124);
        }
    });
    let mut input = BufReader::new(io::stdin().lock());
    let work = if stream {
        read_header(&mut input)?
    } else {
        read_work(&mut input)?
    };
    startup.store(false, std::sync::atomic::Ordering::Release);
    start_watchdog(work.expires);
    let prepared = prepare(&work, root, if stream { Some(&mut input) } else { None });
    let mut output = io::stdout().lock();
    let mut stdout = String::new();
    let mut stderr = String::new();
    let mut write_error = None;
    let mut result = match prepared {
        Err(error) => error,
        Ok(()) => execute(&work, root, |channel, text| {
            if stream {
                let frame = json!({ "type":"log", "channel":channel, "text":text });
                if let Err(error) = writeln!(output, "{frame}").and_then(|_| output.flush()) {
                    write_error = Some(error);
                }
            } else if channel == "stdout" {
                stdout.push_str(&text);
            } else {
                stderr.push_str(&text);
            }
        }),
    };
    if let Some(error) = write_error {
        return Err(error);
    }
    if stream {
        result = json!({ "type":"result", "result":result });
    } else {
        result["stdout"] = stdout.into();
        result["stderr"] = stderr.into();
    }
    writeln!(output, "{result}")?;
    output.flush()
}

fn main() -> Result<(), Box<dyn std::error::Error + Send + Sync>> {
    let args: Vec<_> = env::args().skip(1).collect();
    let root = match args.get(1..).unwrap_or_default() {
        [] => PathBuf::from("/workspace"),
        [flag, path] if flag == "--workspace" => PathBuf::from(path),
        _ => return Err("usage: spool-guest [http|stdio-stream|stdio] [--workspace PATH]".into()),
    };
    match args.first().map(String::as_str).unwrap_or("http") {
        "http" => http(&root),
        "stdio-stream" => Ok(stdio(&root, true)?),
        "stdio" => Ok(stdio(&root, false)?),
        _ => Err("unknown guest mode".into()),
    }
}
