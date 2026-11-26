use crate::{Layer, Work};
use base64::{Engine, engine::general_purpose::STANDARD};
use flate2::read::MultiGzDecoder;
use sha2::{Digest, Sha256};
use std::{
    collections::HashSet,
    ffi::CString,
    fs::{self, File, OpenOptions},
    io::{self, Read, Write},
    os::{
        fd::{AsRawFd, FromRawFd},
        unix::fs::{MetadataExt, PermissionsExt},
    },
    path::{Path, PathBuf},
};

const MAX_ENTRIES: usize = 65_536;
pub const UID: u32 = 65532;
const TAR: &str = "application/vnd.oci.image.layer.v1.tar";

fn invalid(message: impl Into<String>) -> io::Error {
    io::Error::new(io::ErrorKind::InvalidData, message.into())
}

fn parts(name: &str) -> io::Result<Vec<&str>> {
    if name.starts_with('/') {
        return Err(invalid("absolute archive path"));
    }
    let name = name.trim_start_matches("./").trim_end_matches('/');
    if name.is_empty() || name == "." {
        return Ok(Vec::new());
    }
    let parts: Vec<_> = name.split('/').collect();
    if name.len() > 1024
        || parts.len() > 32
        || parts
            .iter()
            .any(|p| p.is_empty() || *p == "." || *p == ".." || p.len() > 255 || p.contains('\0'))
    {
        return Err(invalid("invalid archive path"));
    }
    Ok(parts)
}

pub fn workspace_parts(name: &str) -> io::Result<Vec<&str>> {
    if name == "/workspace" {
        return Ok(Vec::new());
    }
    let path = name
        .strip_prefix("/workspace/")
        .ok_or_else(|| invalid("invalid workspace path"))?;
    parts(path)
}

fn remove(path: &Path) -> io::Result<()> {
    match path.symlink_metadata() {
        Ok(metadata) if metadata.is_dir() => fs::remove_dir_all(path),
        Ok(_) => fs::remove_file(path),
        Err(error) if error.kind() == io::ErrorKind::NotFound => Ok(()),
        Err(error) => Err(error),
    }
}

fn directory(root: &Path, parts: &[String]) -> io::Result<PathBuf> {
    let mut path = root.to_owned();
    for part in parts {
        path.push(part);
        if path
            .symlink_metadata()
            .is_ok_and(|metadata| metadata.is_dir())
        {
            continue;
        }
        remove(&path)?;
        fs::create_dir(&path)?;
        fs::set_permissions(&path, fs::Permissions::from_mode(0o755))?;
    }
    Ok(path)
}

struct Entry {
    path: Vec<String>,
    directory: bool,
    executable: bool,
    file: Option<PathBuf>,
    link: Option<String>,
}

fn link_within(target: &str, mut depth: usize) -> bool {
    if target.is_empty() || target.starts_with('/') || target.len() > 1024 || target.contains('\0')
    {
        return false;
    }
    let mut descending = false;
    for part in target.split('/') {
        match part {
            ".." if depth == 0 || descending => return false,
            ".." => depth -= 1,
            "." | "" => {}
            _ => descending = true,
        }
    }
    true
}

fn extract_layer(root: &Path, input: impl Read, remaining_entries: &mut usize) -> io::Result<()> {
    let stage = tempfile::Builder::new()
        .prefix(".spool-stage-")
        .tempdir_in(root)?;
    let mut entries = Vec::new();
    let mut names = HashSet::new();
    for member in tar::Archive::new(input).entries()?.raw(true) {
        *remaining_entries = remaining_entries
            .checked_sub(1)
            .ok_or_else(|| invalid("too many layer entries"))?;
        let mut member = member?;
        let header = member.header();
        let entry_type = header.entry_type();
        let executable = header.mode()? & 0o111 != 0;
        let name = member.path_bytes().into_owned();
        let name =
            std::str::from_utf8(&name).map_err(|_| invalid("invalid archive path encoding"))?;
        let entry_error = |reason: &str| invalid(format!("entry {name:?}: {reason}"));
        if entry_type.is_pax_global_extensions() && name == "pax_global_header" {
            if member.size() > 4096 {
                return Err(entry_error("oversized global archive metadata"));
            }
            let extensions = member
                .pax_extensions()?
                .ok_or_else(|| invalid("invalid global archive metadata"))?;
            for extension in extensions {
                if extension?.key_bytes() != b"comment" {
                    return Err(entry_error("unsupported global archive metadata key"));
                }
            }
            continue;
        }
        if !entry_type.is_file() && !entry_type.is_dir() && !entry_type.is_symlink() {
            return Err(entry_error("unsupported archive entry type"));
        }
        let path: Vec<_> = parts(name)
            .map_err(|error| entry_error(&error.to_string()))?
            .into_iter()
            .map(str::to_owned)
            .collect();
        if path.is_empty() && entry_type.is_dir() && member.size() == 0 {
            continue;
        }
        if path.is_empty()
            || path[..path.len() - 1].iter().any(|p| p.starts_with(".wh."))
            || !names.insert(path.clone())
            || path[0].starts_with(".spool-stage-")
            || path[0].starts_with(".wh..spool-stage-")
            || (entry_type.is_dir() && member.size() != 0)
        {
            return Err(entry_error("invalid or duplicate archive entry"));
        }
        let link = if entry_type.is_symlink() {
            let target = header
                .link_name_bytes()
                .ok_or_else(|| entry_error("missing symlink target"))?;
            let target = std::str::from_utf8(&target)
                .map_err(|_| entry_error("invalid symlink target encoding"))?;
            if path.last().unwrap().starts_with(".wh.") || !link_within(target, path.len() - 1) {
                return Err(entry_error(
                    "symlink target must stay inside the workspace with parent segments before named segments",
                ));
            }
            Some(target.to_owned())
        } else {
            if header.link_name_bytes().is_some() {
                return Err(entry_error("unexpected link metadata"));
            }
            None
        };
        let file = if entry_type.is_file() && !path.last().unwrap().starts_with(".wh.") {
            let destination = stage.path().join(entries.len().to_string());
            let mut file = File::create(&destination)?;
            if io::copy(&mut member, &mut file)? != member.size() {
                return Err(entry_error("incomplete archive entry"));
            }
            file.flush()?;
            Some(destination)
        } else {
            if member.size() != 0 {
                return Err(entry_error("nonempty metadata entry"));
            }
            None
        };
        entries.push(Entry {
            path,
            directory: entry_type.is_dir(),
            executable,
            file,
            link,
        });
    }

    for entry in &entries {
        let (name, parents) = entry.path.split_last().unwrap();
        let Some(target) = name.strip_prefix(".wh.") else {
            continue;
        };
        if entry.directory
            || matches!(target, "" | "." | "..")
            || (target.starts_with(".wh.") && name != ".wh..wh..opq")
        {
            return Err(invalid("invalid whiteout"));
        }
        let mut parent = root.to_owned();
        if !parents.iter().all(|part| {
            parent.push(part);
            parent
                .symlink_metadata()
                .is_ok_and(|metadata| metadata.is_dir())
        }) {
            continue;
        }
        if name == ".wh..wh..opq" {
            for child in fs::read_dir(parent)? {
                let path = child?.path();
                if path != stage.path() {
                    remove(&path)?;
                }
            }
        } else {
            remove(&parent.join(target))?;
        }
    }

    for entry in entries {
        let (name, parents) = entry.path.split_last().unwrap();
        if name.starts_with(".wh.") {
            continue;
        }
        if entry.directory {
            directory(root, &entry.path)?;
        } else {
            let path = directory(root, parents)?.join(name);
            remove(&path)?;
            if let Some(target) = entry.link {
                std::os::unix::fs::symlink(target, &path)?;
                continue;
            }
            fs::rename(entry.file.ok_or_else(|| invalid("missing payload"))?, &path)?;
            fs::set_permissions(
                &path,
                fs::Permissions::from_mode(if entry.executable { 0o755 } else { 0o644 }),
            )?;
        }
    }
    Ok(())
}

struct Verify<R> {
    input: R,
    digest: Sha256,
}

impl<R: Read> Read for Verify<R> {
    fn read(&mut self, buffer: &mut [u8]) -> io::Result<usize> {
        let count = self.input.read(buffer)?;
        self.digest.update(&buffer[..count]);
        Ok(count)
    }
}

fn apply(
    root: &Path,
    layer: &Layer,
    input: impl Read,
    disk_left: &mut u64,
    entries: &mut usize,
) -> io::Result<()> {
    let mut input = Verify {
        input: input.take(layer.size as u64),
        digest: Sha256::new(),
    };
    let stream: Box<dyn Read> = match layer.media_type.as_str() {
        TAR => Box::new(&mut input),
        "application/vnd.oci.image.layer.v1.tar+gzip" => Box::new(MultiGzDecoder::new(&mut input)),
        _ => return Err(invalid("unsupported archive format")),
    };
    let budget = disk_left.saturating_add(1);
    let mut bounded = stream.take(budget);
    extract_layer(root, &mut bounded, entries)?;
    io::copy(&mut bounded, &mut io::sink())?;
    let consumed = budget - bounded.limit();
    drop(bounded);
    if consumed > *disk_left {
        return Err(invalid("expanded layers exceed the workspace budget"));
    }
    *disk_left -= consumed;
    let digest: String = input
        .digest
        .finalize()
        .iter()
        .map(|byte| format!("{byte:02x}"))
        .collect();
    if input.input.limit() != 0 || layer.digest.strip_prefix("sha256:") != Some(digest.as_str()) {
        return Err(invalid("layer length or digest mismatch"));
    }
    Ok(())
}

pub struct AssemblyError {
    pub index: Option<usize>,
    pub reason: String,
}

impl From<io::Error> for AssemblyError {
    fn from(error: io::Error) -> Self {
        Self {
            index: None,
            reason: error.to_string(),
        }
    }
}

pub fn assemble(
    root: &Path,
    work: &Work,
    mut stream: Option<&mut dyn Read>,
) -> Result<(), AssemblyError> {
    if root.read_dir()?.next().is_some() {
        return Err(invalid("workspace must be empty").into());
    }
    let layers = &work.manifest.environment.layers;
    if stream.is_none() && layers.len() != work.layers.len() {
        return Err(invalid("missing layer").into());
    }
    // Leave space for workspace outputs. The provider separately bounds the filesystem.
    let mut bytes_left = u64::from(work.manifest.resources.disk_mib) * 1024 * 1024 * 3 / 4;
    let mut entries_left = MAX_ENTRIES;
    for (index, layer) in layers.iter().enumerate() {
        let assembled = (|| {
            if let Some(input) = stream.as_deref_mut() {
                apply(root, layer, input, &mut bytes_left, &mut entries_left)
            } else {
                let bytes = STANDARD
                    .decode(&work.layers[index])
                    .map_err(|_| invalid("invalid layer encoding"))?;
                if bytes.len() != layer.size {
                    return Err(invalid("invalid layer size"));
                }
                apply(root, layer, &bytes[..], &mut bytes_left, &mut entries_left)
            }
        })();
        assembled.map_err(|error| AssemblyError {
            index: Some(index),
            reason: error.to_string(),
        })?;
    }
    if let Some(input) = stream {
        let mut tail = [0; 1];
        if input.read(&mut tail)? != 0 {
            return Err(invalid("unexpected trailing input").into());
        }
    }
    if unsafe { libc::geteuid() } == 0 {
        chown_tree(root)?;
    }
    Ok(())
}

fn chown_tree(path: &Path) -> io::Result<()> {
    std::os::unix::fs::lchown(path, Some(UID), Some(UID))?;
    if path.symlink_metadata()?.is_dir() {
        for child in fs::read_dir(path)? {
            chown_tree(&child?.path())?;
        }
    }
    Ok(())
}

pub fn open_artifact(root: &Path, name: &str, limit: usize) -> io::Result<(File, usize)> {
    let parts = workspace_parts(name)?;
    let (name, parents) = parts
        .split_last()
        .ok_or_else(|| invalid("artifact is a directory"))?;
    let mut directory = OpenOptions::new()
        .read(true)
        .custom_flags(libc::O_DIRECTORY | libc::O_NOFOLLOW)
        .open(root)?;
    for part in parents {
        directory = open_at(&directory, part, libc::O_DIRECTORY)?;
    }
    let file = open_at(&directory, name, libc::O_NONBLOCK)?;
    let stat = file.metadata()?;
    if !stat.is_file() || stat.nlink() != 1 || stat.len() > limit as u64 {
        return Err(invalid("invalid artifact"));
    }
    Ok((file, stat.len() as usize))
}

use std::os::unix::fs::OpenOptionsExt;

fn open_at(parent: &File, part: &str, flags: libc::c_int) -> io::Result<File> {
    let name = CString::new(part.as_bytes())?;
    let fd = unsafe {
        libc::openat(
            parent.as_raw_fd(),
            name.as_ptr(),
            flags | libc::O_RDONLY | libc::O_NOFOLLOW | libc::O_CLOEXEC,
        )
    };
    if fd < 0 {
        return Err(io::Error::last_os_error());
    }
    Ok(unsafe { File::from_raw_fd(fd) })
}
