use crate::{
    Work,
    workspace::{self, UID},
};
use serde_json::{Value, json};
use std::{
    io::{self, Read},
    os::{
        fd::AsRawFd,
        unix::process::{CommandExt, ExitStatusExt},
    },
    path::Path,
    process::{Command, Stdio},
    thread,
    time::{Duration, Instant, SystemTime, UNIX_EPOCH},
};

const MAX_LOGS: usize = 128 * 1024;
const MAX_LOG_EVENTS: usize = 1024;

#[cfg(all(target_os = "linux", target_env = "gnu"))]
type RlimitResource = libc::__rlimit_resource_t;
#[cfg(not(all(target_os = "linux", target_env = "gnu")))]
type RlimitResource = libc::c_int;

pub fn now_ms() -> u64 {
    SystemTime::now()
        .duration_since(UNIX_EPOCH)
        .unwrap_or_default()
        .as_millis() as u64
}

fn restrict(cpu_seconds: u64, disk_mib: u32, _memory_mib: Option<u32>) -> io::Result<()> {
    #[cfg(target_os = "linux")]
    if unsafe { libc::prctl(libc::PR_SET_NO_NEW_PRIVS, 1, 0, 0, 0) } < 0 {
        return Err(io::Error::last_os_error());
    }
    fn set(kind: RlimitResource, soft: u64, hard: u64) -> io::Result<()> {
        let mut old = libc::rlimit {
            rlim_cur: 0,
            rlim_max: 0,
        };
        if unsafe { libc::getrlimit(kind, &mut old) } != 0 {
            return Err(io::Error::last_os_error());
        }
        let hard = old.rlim_max.min(hard as _);
        let value = libc::rlimit {
            rlim_cur: old.rlim_cur.min(soft as _).min(hard),
            rlim_max: hard,
        };
        if unsafe { libc::setrlimit(kind, &value) } != 0 {
            return Err(io::Error::last_os_error());
        }
        Ok(())
    }
    set(libc::RLIMIT_CPU, cpu_seconds, cpu_seconds + 1)?;
    let file_limit = u64::from(disk_mib) * 1024 * 1024;
    set(libc::RLIMIT_FSIZE, file_limit, file_limit)?;
    set(libc::RLIMIT_NOFILE, 256, 256)?;
    set(libc::RLIMIT_CORE, 0, 0)?;
    #[cfg(target_os = "linux")]
    {
        if let Some(memory_mib) = _memory_mib {
            let address_space = u64::from(memory_mib) * 1024 * 1024;
            set(libc::RLIMIT_AS, address_space, address_space)?;
        }
        set(libc::RLIMIT_NPROC, 64, 64)?;
    }
    Ok(())
}

fn nonblocking(fd: libc::c_int) -> io::Result<()> {
    let flags = unsafe { libc::fcntl(fd, libc::F_GETFL) };
    if flags < 0 || unsafe { libc::fcntl(fd, libc::F_SETFL, flags | libc::O_NONBLOCK) } < 0 {
        return Err(io::Error::last_os_error());
    }
    Ok(())
}

fn decode(pending: &mut Vec<u8>, bytes: &[u8], final_chunk: bool) -> String {
    pending.extend_from_slice(bytes);
    let mut text = String::new();
    let mut read = 0;
    while read < pending.len() {
        match std::str::from_utf8(&pending[read..]) {
            Ok(valid) => {
                text.push_str(valid);
                read = pending.len();
            }
            Err(error) => {
                let end = read + error.valid_up_to();
                text.push_str(std::str::from_utf8(&pending[read..end]).unwrap());
                read = end;
                if let Some(count) = error.error_len() {
                    text.push('\u{fffd}');
                    read += count;
                } else if final_chunk {
                    text.push('\u{fffd}');
                    read = pending.len();
                } else {
                    break;
                }
            }
        }
    }
    pending.drain(..read);
    text
}

fn execute_command(
    work: &Work,
    root: &Path,
    emit: &mut impl FnMut(&str, String),
) -> io::Result<Value> {
    let manifest = &work.manifest;
    let command = &manifest.command;
    let timeout = manifest.resources.timeout_s;
    let disk_mib = manifest.resources.disk_mib;
    let cpu = manifest.resources.cpu;
    let memory_mib = manifest.resources.memory_mib;
    if timeout == 0
        || timeout > 2_147_483
        || !(1..=4).contains(&cpu)
        || !(256..=12_288).contains(&memory_mib)
    {
        return Err(io::Error::other("invalid command resources"));
    }
    let path = workspace::workspace_parts(&command.cwd)?
        .iter()
        .fold(root.to_owned(), |path, part| path.join(part));
    let (program, args) = command
        .argv
        .split_first()
        .ok_or_else(|| io::Error::other("missing executable"))?;
    let mut child_command = Command::new(program);
    child_command
        .args(args)
        .current_dir(path)
        .env_clear()
        .env("PATH", "/usr/local/bin:/usr/bin:/bin")
        .env("HOME", root)
        .env("TMPDIR", "/tmp")
        .env("LANG", "C.UTF-8")
        .stdin(Stdio::null())
        .stdout(Stdio::piped())
        .stderr(Stdio::piped())
        .process_group(0);
    if let Some(shard) = &manifest.shard {
        child_command
            .env("SPOOL_SHARD_INDEX", shard.index.to_string())
            .env("SPOOL_SHARD_COUNT", shard.count.to_string());
    }
    if unsafe { libc::geteuid() } == 0 {
        // Command clears supplementary groups when a uid is explicitly set.
        child_command.uid(UID).gid(UID);
    }
    let address_limit = (!work.container_memory).then_some(memory_mib);
    unsafe {
        child_command.pre_exec(move || restrict(timeout * u64::from(cpu), disk_mib, address_limit));
    }
    let cpu_before = child_cpu_ms();
    let started = Instant::now();
    let mut child = child_command.spawn()?;
    let pid = child.id() as libc::pid_t;
    let kill_group = || unsafe {
        libc::kill(-pid, libc::SIGKILL);
    };
    let out = child.stdout.take().unwrap();
    let err = child.stderr.take().unwrap();
    let fds = [out.as_raw_fd(), err.as_raw_fd()];
    let mut pipes: [Box<dyn Read>; 2] = [Box::new(out), Box::new(err)];
    let channels = ["stdout", "stderr"];
    let mut pending = [Vec::new(), Vec::new()];
    let mut active = [true; 2];
    let mut budget = MAX_LOGS;
    let mut log_events = 0;
    let mut truncated = false;
    let deadline = Instant::now() + Duration::from_secs(timeout);
    let result = (|| {
        for fd in fds {
            nonblocking(fd)?;
        }
        let mut buffer = [0; 2048];
        loop {
            let status = child.try_wait()?;
            let expired = Instant::now() >= deadline || now_ms() >= work.expires;
            if status.is_some() || expired {
                kill_group();
            }
            let mut read_any = false;
            for index in 0..pipes.len() {
                if !active[index] {
                    continue;
                }
                match pipes[index].read(&mut buffer) {
                    Ok(0) => active[index] = false,
                    Ok(count) => {
                        read_any = true;
                        let kept = if log_events < MAX_LOG_EVENTS {
                            count.min(budget)
                        } else {
                            0
                        };
                        budget -= kept;
                        truncated |= kept < count;
                        let text = decode(&mut pending[index], &buffer[..kept], kept < count);
                        if !text.is_empty() {
                            emit(channels[index], text);
                            log_events += 1;
                        }
                    }
                    Err(error)
                        if error.kind() == io::ErrorKind::WouldBlock
                            || error.kind() == io::ErrorKind::Interrupted => {}
                    Err(error) => return Err(error),
                }
            }
            if expired {
                return Ok((child.wait()?, true));
            }
            if let Some(status) = status
                && (!read_any || budget == 0 || log_events >= MAX_LOG_EVENTS)
            {
                return Ok((status, false));
            }
            if !read_any {
                thread::sleep(Duration::from_millis(25));
            }
        }
    })();
    kill_group();
    let _ = child.wait();
    let (status, expired) = result?;
    let usage = json!({
        "wall_ms": started.elapsed().as_millis() as u64,
        "cpu_ms": child_cpu_ms().saturating_sub(cpu_before),
    });
    for (index, tail) in pending.iter_mut().enumerate() {
        let text = decode(tail, &[], true);
        if !text.is_empty() {
            emit(channels[index], text);
        }
    }
    let code = status
        .code()
        .or_else(|| status.signal().map(|signal| -signal))
        .unwrap_or(1);
    if expired {
        return Ok(
            json!({"error":"DEADLINE_EXCEEDED","exit_code":code,"output_truncated":truncated,"usage":usage}),
        );
    }
    Ok(json!({"exit_code":code,"output_truncated":truncated,"usage":usage}))
}

fn child_cpu_ms() -> u64 {
    let mut usage = std::mem::MaybeUninit::<libc::rusage>::uninit();
    if unsafe { libc::getrusage(libc::RUSAGE_CHILDREN, usage.as_mut_ptr()) } != 0 {
        return 0;
    }
    let usage = unsafe { usage.assume_init() };
    [usage.ru_utime, usage.ru_stime]
        .iter()
        .map(|time| (time.tv_sec as u64) * 1000 + (time.tv_usec as u64) / 1000)
        .sum()
}

pub fn prepare(work: &Work, root: &Path, source: Option<&mut dyn Read>) -> Result<(), Value> {
    if now_ms() >= work.expires {
        return Err(json!({"error":"DEADLINE_EXCEEDED"}));
    }
    if let Err(failure) = workspace::assemble(root, work, source) {
        let digest = failure
            .index
            .and_then(|index| work.manifest.environment.layers.get(index))
            .map(|layer| &layer.digest);
        return Err(json!({"error":"LAYER_INVALID","layer_error":{
            "index":failure.index,"digest":digest,"reason":failure.reason.chars().take(720).collect::<String>()
        }}));
    }
    Ok(())
}

pub fn execute(work: &Work, root: &Path, mut emit: impl FnMut(&str, String)) -> Value {
    if now_ms() >= work.expires {
        return json!({"error":"DEADLINE_EXCEEDED"});
    }
    execute_command(work, root, &mut emit).unwrap_or_else(|_| json!({"error":"EXECUTION_FAILED"}))
}
