use super::{Descriptor, Error, Result};
use crate::cache_leases::{self, Lease, transaction};
use sha2::{Digest, Sha256};
use std::{
    collections::BTreeMap,
    fs,
    io::{self, Read, Write},
    path::{Path, PathBuf},
    time::Duration,
};

pub const TAR: &str = "application/vnd.oci.image.layer.v1.tar";
pub const TAR_GZIP: &str = "application/vnd.oci.image.layer.v1.tar+gzip";
pub const PATCH_MEDIA: &str = "application/vnd.spool.workspace.patch.v1+vcdiff";
const MAX: usize = 4 * 1024 * 1024;

pub(crate) fn sha256(bytes: &[u8]) -> String {
    hex_digest(Sha256::digest(bytes))
}

pub(crate) fn hex_digest(bytes: impl IntoIterator<Item = u8>) -> String {
    const HEX: &[u8; 16] = b"0123456789abcdef";
    let mut digest = String::with_capacity(71);
    digest.push_str("sha256:");
    for byte in bytes {
        digest.push(char::from(HEX[(byte >> 4) as usize]));
        digest.push(char::from(HEX[(byte & 15) as usize]));
    }
    digest
}

pub fn describe_reader(
    mut input: impl Read,
    media_type: &str,
    maximum: usize,
) -> Result<Descriptor> {
    if !matches!(media_type, TAR | TAR_GZIP | PATCH_MEDIA) {
        return Err(Error::Invalid("Expected a supported layer media type"));
    }
    let mut hasher = Sha256::new();
    let mut buffer = [0; 64 * 1024];
    let mut size: usize = 0;
    loop {
        let count = input.read(&mut buffer)?;
        if count == 0 {
            break;
        }
        size = size
            .checked_add(count)
            .filter(|size| *size <= maximum)
            .ok_or(Error::Invalid("Layer exceeded its declared size"))?;
        hasher.update(&buffer[..count]);
    }
    if size == 0 {
        return Err(Error::Invalid("Expected a nonempty layer"));
    }
    Ok(Descriptor {
        digest: hex_digest(hasher.finalize()),
        size,
        media_type: media_type.to_owned(),
    })
}

pub fn describe(bytes: &[u8], media_type: &str) -> Result<Descriptor> {
    if bytes.is_empty() || !matches!(media_type, TAR | TAR_GZIP | PATCH_MEDIA) {
        return Err(Error::Invalid(
            "Expected nonempty bytes and a supported layer media type",
        ));
    }
    Ok(Descriptor {
        digest: sha256(bytes),
        size: bytes.len(),
        media_type: media_type.to_owned(),
    })
}

pub struct LayerCache {
    directory: PathBuf,
    lease: Option<Lease>,
}

#[derive(Debug, PartialEq, Eq)]
pub struct CacheGc {
    pub removed_layers: Vec<String>,
    pub removed_leases: usize,
}

impl LayerCache {
    pub fn open(path: impl AsRef<Path>) -> Result<Self> {
        let path = path.as_ref();
        let mut builder = fs::DirBuilder::new();
        builder.recursive(true);
        #[cfg(unix)]
        {
            use std::os::unix::fs::DirBuilderExt;
            builder.mode(0o700);
        }
        builder.create(path)?;
        Ok(Self {
            directory: cache_leases::canonical_path(path)?,
            lease: None,
        })
    }

    /// Bind cached layers to a marker file in this workspace.
    pub fn for_workspace(&self, workspace: impl AsRef<Path>, ttl: Duration) -> Result<Self> {
        Ok(Self {
            directory: self.directory.clone(),
            lease: Some(Lease::new(&self.directory, workspace.as_ref(), ttl)?),
        })
    }

    pub fn lease_path(&self) -> Option<&Path> {
        self.lease.as_ref().map(|lease| lease.path.as_path())
    }

    fn lease(&self) -> Result<&Lease> {
        self.lease
            .as_ref()
            .ok_or(Error::Invalid("A workspace lease is required"))
    }

    pub fn renew(&self) -> Result<usize> {
        let lease = self.lease()?;
        transaction(&self.directory, |db| lease.renew(db))
    }

    pub fn release(&self) -> Result<usize> {
        let lease = self.lease()?;
        transaction(&self.directory, |db| lease.release(db))
    }

    pub fn retain(&self, digest: &str) -> Result<bool> {
        let lease = self.lease()?;
        let path = self.path(digest)?;
        transaction(&self.directory, |db| {
            match fs::symlink_metadata(path) {
                Ok(metadata) if metadata.is_file() => lease.retain(db, digest)?,
                Ok(_) => return Ok(false),
                Err(error) if cache_leases::missing(&error) => return Ok(false),
                Err(error) => return Err(error.into()),
            }
            Ok(true)
        })
    }

    fn path(&self, digest: &str) -> Result<PathBuf> {
        let key = digest
            .strip_prefix("sha256:")
            .ok_or(Error::Invalid("Invalid layer digest"))?;
        if key.len() != 64
            || !key
                .bytes()
                .all(|byte| byte.is_ascii_digit() || (b'a'..=b'f').contains(&byte))
        {
            return Err(Error::Invalid("Invalid layer digest"));
        }
        Ok(self.directory.join(key))
    }

    pub fn put(&self, bytes: &[u8], media_type: &str) -> Result<Descriptor> {
        if bytes.len() > MAX {
            return Err(Error::Invalid("Layer exceeds cache limit"));
        }
        let descriptor = describe(bytes, media_type)?;
        let mut tempfile = tempfile::NamedTempFile::new_in(&self.directory)?;
        tempfile.write_all(bytes)?;
        tempfile.as_file().sync_all()?;
        transaction(&self.directory, |db| {
            if let Some(lease) = &self.lease {
                lease.retain(db, &descriptor.digest)?;
            }
            tempfile
                .persist(self.path(&descriptor.digest)?)
                .map_err(|error| error.error)?;
            Ok(())
        })?;
        Ok(descriptor)
    }

    pub fn read(&self, descriptor: &Descriptor) -> Result<Vec<u8>> {
        if descriptor.size > MAX {
            return Err(Error::Invalid("Layer exceeds cache limit"));
        }
        let path = self.path(&descriptor.digest)?;
        if self.lease.is_some() && !self.retain(&descriptor.digest)? {
            return Err(io::Error::from(io::ErrorKind::NotFound).into());
        }
        if !fs::symlink_metadata(&path)?.is_file() {
            return Err(Error::Invalid("Expected a regular cached layer file"));
        }
        let mut bytes = Vec::new();
        fs::File::open(path)?
            .take(descriptor.size as u64 + 1)
            .read_to_end(&mut bytes)?;
        if &describe(&bytes, &descriptor.media_type)? != descriptor {
            return Err(Error::Invalid("Cached layer bytes do not match descriptor"));
        }
        Ok(bytes)
    }

    pub fn delete(&self, digest: &str) -> Result<()> {
        let path = self.path(digest)?;
        transaction(&self.directory, |db| {
            if cache_leases::active(db)?.0.contains(digest) {
                return Err(Error::Invalid("Layer has an active lease"));
            }
            Self::remove(path)
        })
    }

    fn remove(path: PathBuf) -> Result<()> {
        match fs::remove_file(path) {
            Err(error) if cache_leases::missing(&error) => Ok(()),
            result => Ok(result?),
        }
    }

    pub fn gc(&self) -> Result<CacheGc> {
        transaction(&self.directory, |db| {
            let (retained, removed_leases) = cache_leases::active(db)?;
            let mut removed_layers = Vec::new();
            for entry in fs::read_dir(&self.directory)? {
                let entry = entry?;
                let Some(name) = entry.file_name().into_string().ok() else {
                    continue;
                };
                let digest = format!("sha256:{name}");
                if let Ok(path) = self.path(&digest)
                    && !retained.contains(&digest)
                {
                    Self::remove(path)?;
                    removed_layers.push(digest);
                }
            }
            removed_layers.sort();
            Ok(CacheGc {
                removed_layers,
                removed_leases,
            })
        })
    }
}

pub enum Entry<'a> {
    File {
        path: &'a str,
        bytes: &'a [u8],
        executable: bool,
    },
    Directory(&'a str),
    Delete(&'a str),
    Opaque(&'a str),
}

fn path_ok(path: &str) -> bool {
    path.encode_utf16().count() <= 1024
        && path.split('/').count() <= 32
        && path.split('/').all(|part| {
            !matches!(part, "" | "." | "..") && !part.starts_with(".wh.") && !part.contains('\0')
        })
}

fn tar_path(path: &str) -> Result<(&str, &str)> {
    if path.len() <= 100 {
        return Ok(("", path));
    }
    for (at, _) in path.match_indices('/') {
        let prefix = &path[..at];
        let suffix = &path[at + 1..];
        if suffix.len() <= 100 && prefix.len() <= 155 {
            return Ok((prefix, suffix));
        }
    }
    Err(Error::Invalid("Layer path exceeds the USTAR field limit"))
}

fn octal(field: &mut [u8], value: usize) {
    let text = format!("{value:0width$o}", width = field.len() - 1);
    field[..text.len()].copy_from_slice(text.as_bytes());
}

/// Encode deterministic USTAR bytes with workspace paths and OCI whiteouts.
pub fn build_layer<'a>(entries: impl IntoIterator<Item = Entry<'a>>) -> Result<Vec<u8>> {
    let mut items = BTreeMap::new();
    let mut total = 1024;
    for entry in entries {
        let (path, data, mode, kind) = match entry {
            Entry::File {
                path,
                bytes,
                executable,
            } if path_ok(path) => (
                path.to_owned(),
                bytes,
                if executable { 0o755 } else { 0o644 },
                b'0',
            ),
            Entry::Directory(path) if path_ok(path) => (path.to_owned(), &[][..], 0o755, b'5'),
            Entry::Delete(path) if path_ok(path) => {
                let (parent, name) = path
                    .rsplit_once('/')
                    .map(|(p, n)| (format!("{p}/"), n))
                    .unwrap_or_default();
                let name = if parent.is_empty() { path } else { name };
                (format!("{parent}.wh.{name}"), &[][..], 0o644, b'0')
            }
            Entry::Opaque(path) if path.is_empty() || path_ok(path) => (
                if path.is_empty() {
                    ".wh..wh..opq".to_owned()
                } else {
                    format!("{path}/.wh..wh..opq")
                },
                &[][..],
                0o644,
                b'0',
            ),
            _ => return Err(Error::Invalid("Invalid workspace layer entry")),
        };
        if data.len() > MAX {
            return Err(Error::Invalid("Layer exceeds workspace profile limits"));
        }
        total += 512 + data.len().div_ceil(512) * 512;
        if total > MAX || items.len() >= 4096 {
            return Err(Error::Invalid("Layer exceeds workspace profile limits"));
        }
        let key: Vec<u16> = path.encode_utf16().collect();
        if items.insert(key, (path, data, mode, kind)).is_some() {
            return Err(Error::Invalid("Duplicate layer entry"));
        }
    }
    let mut bytes = Vec::with_capacity(total);
    for (path, data, mode, kind) in items.into_values() {
        let (prefix, name) = tar_path(&path)?;
        let mut header = [0u8; 512];
        header[..name.len()].copy_from_slice(name.as_bytes());
        header[345..345 + prefix.len()].copy_from_slice(prefix.as_bytes());
        octal(&mut header[100..108], mode);
        octal(&mut header[108..116], 0);
        octal(&mut header[116..124], 0);
        octal(&mut header[124..136], data.len());
        octal(&mut header[136..148], 0);
        header[148..156].fill(b' ');
        header[156] = kind;
        header[257..265].copy_from_slice(b"ustar\x0000");
        let sum: usize = header.iter().map(|&value| value as usize).sum();
        octal(&mut header[148..155], sum);
        header[154] = 0;
        bytes.extend(header);
        bytes.extend(data);
        bytes.resize(bytes.len().next_multiple_of(512), 0);
    }
    bytes.resize(total, 0);
    Ok(bytes)
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn cache_and_builder_agree() {
        let bytes = build_layer([
            Entry::File {
                path: "hello",
                bytes: b"spool\n",
                executable: false,
            },
            Entry::Delete("old"),
            Entry::Opaque("nested"),
        ])
        .unwrap();
        let directory = tempfile::tempdir().unwrap();
        let local = LayerCache::open(directory.path()).unwrap();
        let descriptor = local.put(&bytes, TAR).unwrap();
        assert_eq!(local.read(&descriptor).unwrap(), bytes);
        assert_eq!(bytes.len(), 3072);
        assert_eq!(
            descriptor.digest,
            "sha256:5ea94316a89ba0fb13bc2a22ad34cb710489a08f39c33d62d7dd8111a7e69cc4"
        );
    }

    #[test]
    fn workspace_markers_fence_collection_until_return_or_removal() {
        let directory = tempfile::tempdir().unwrap();
        let cache = LayerCache::open(directory.path().join("cache")).unwrap();
        let alpha = tempfile::tempdir_in(directory.path()).unwrap();
        let beta = tempfile::tempdir_in(directory.path()).unwrap();
        let a = cache
            .for_workspace(alpha.path(), crate::DEFAULT_LEASE_TTL)
            .unwrap();
        let b = cache
            .for_workspace(beta.path(), crate::DEFAULT_LEASE_TTL)
            .unwrap();
        let shared = a.put(b"shared", TAR).unwrap();
        let unleased = cache.put(b"no workspace", TAR).unwrap();
        assert!(b.retain(&shared.digest).unwrap());
        assert_eq!(a.renew().unwrap(), 1);
        assert_eq!(cache.gc().unwrap().removed_layers, [unleased.digest]);
        fs::remove_file(a.lease_path().unwrap()).unwrap();
        assert_eq!(cache.gc().unwrap().removed_leases, 1);
        assert!(cache.delete(&shared.digest).is_err());
        assert_eq!(b.release().unwrap(), 1);
        assert_eq!(cache.gc().unwrap().removed_layers, [shared.digest]);
    }
}
