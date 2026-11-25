use crate::{Work, workspace};
use base64::{Engine, engine::general_purpose::STANDARD};
use serde_json::{Value, json};
use sha2::{Digest, Sha256};
use std::{
    fs::File,
    io::{self, Read, Write},
    os::unix::fs::FileExt,
    path::Path,
};

pub struct Artifact {
    path: String,
    size: usize,
    digest: String,
    file: File,
}

pub struct ArtifactReader {
    file: File,
    offset: u64,
    size: u64,
}

impl Read for ArtifactReader {
    fn read(&mut self, buffer: &mut [u8]) -> io::Result<usize> {
        let length = buffer.len().min((self.size - self.offset) as usize);
        if length == 0 {
            return Ok(0);
        }
        let count = self.file.read_at(&mut buffer[..length], self.offset)?;
        if count == 0 {
            return Err(io::ErrorKind::UnexpectedEof.into());
        }
        self.offset += count as u64;
        Ok(count)
    }
}

impl Artifact {
    pub fn reader(&self) -> io::Result<ArtifactReader> {
        Ok(ArtifactReader {
            file: self.file.try_clone()?,
            offset: 0,
            size: self.size as u64,
        })
    }

    pub fn size(&self) -> usize {
        self.size
    }

    pub fn metadata(&self) -> Value {
        json!({"path":self.path,"size":self.size,"digest":self.digest})
    }

    pub fn emit(&self, mut output: impl Write) -> io::Result<()> {
        let frame = json!({"type":"artifact","artifact":self.metadata()});
        writeln!(output, "{frame}")?;
        let mut reader = self.reader()?;
        let mut buffer = [0; 64 * 1024];
        loop {
            let length = reader.read(&mut buffer)?;
            if length == 0 {
                break;
            }
            let frame = json!({"type":"artifact.chunk","body":STANDARD.encode(&buffer[..length])});
            writeln!(output, "{frame}")?;
        }
        output.flush()
    }
}

pub fn collect(work: &Work, root: &Path, result: &mut Value) -> Vec<Artifact> {
    if !result["exit_code"].is_number() || result["error"] == "DEADLINE_EXCEEDED" {
        return Vec::new();
    }
    let mut remaining = work.artifact_limit.unwrap_or(512 * 1024);
    let mut artifacts = Vec::new();
    let mut metadata = Vec::new();
    for path in &work.manifest.outputs.paths {
        let Ok((file, size)) = workspace::open_artifact(root, path, remaining) else {
            continue;
        };
        if work.artifact_limit.is_none() {
            let mut data = Vec::new();
            if file.take(size as u64).read_to_end(&mut data).is_ok() && data.len() == size {
                remaining -= size;
                metadata.push(json!({"path":path,"body":STANDARD.encode(data)}));
            }
            continue;
        }
        let Ok(copy) = file.try_clone() else {
            continue;
        };
        let mut reader = ArtifactReader {
            file: copy,
            offset: 0,
            size: size as u64,
        };
        let mut hash = Sha256::new();
        let mut buffer = [0; 64 * 1024];
        let hashed = (|| -> io::Result<()> {
            loop {
                let count = reader.read(&mut buffer)?;
                if count == 0 {
                    return Ok(());
                }
                hash.update(&buffer[..count]);
            }
        })();
        if hashed.is_err() {
            continue;
        }
        let digest: String = hash
            .finalize()
            .iter()
            .map(|byte| format!("{byte:02x}"))
            .collect();
        remaining -= size;
        let artifact = Artifact {
            path: path.clone(),
            size,
            digest: format!("sha256:{digest}"),
            file,
        };
        metadata.push(artifact.metadata());
        artifacts.push(artifact);
    }
    result["artifacts"] = metadata.into();
    artifacts
}
