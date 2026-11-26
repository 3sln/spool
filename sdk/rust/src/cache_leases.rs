use crate::{Error, Result, layer::sha256};
use rusqlite::{Connection, Transaction, TransactionBehavior, params};
use std::{
    collections::{HashMap, HashSet},
    fs,
    io::{self, Read, Write},
    path::{Path, PathBuf},
    time::{Duration, SystemTime, UNIX_EPOCH},
};

pub const DEFAULT_LEASE_TTL: Duration = Duration::from_secs(7 * 24 * 60 * 60);
const DIRECTORY: &str = ".spool-leases";

pub(crate) fn transaction<T>(
    root: &Path,
    action: impl FnOnce(&Transaction<'_>) -> Result<T>,
) -> Result<T> {
    let mut db = Connection::open(root.join(".leases.sqlite"))?;
    db.busy_timeout(Duration::from_secs(30))?;
    let tx = db.transaction_with_behavior(TransactionBehavior::Immediate)?;
    tx.execute_batch(
        "CREATE TABLE IF NOT EXISTS leases (
         path TEXT NOT NULL, digest TEXT NOT NULL, token TEXT NOT NULL, expires INTEGER NOT NULL,
         PRIMARY KEY (path, digest))",
    )?;
    let result = action(&tx)?;
    tx.commit()?;
    Ok(result)
}

fn now() -> Result<i64> {
    SystemTime::now()
        .duration_since(UNIX_EPOCH)
        .ok()
        .and_then(|time| time.as_millis().try_into().ok())
        .ok_or(Error::Invalid("Invalid cache clock"))
}

fn text(path: &Path) -> Result<&str> {
    path.to_str()
        .ok_or(Error::Invalid("Expected a UTF-8 cache path"))
}

pub(crate) fn canonical_path(path: &Path) -> io::Result<PathBuf> {
    let path = fs::canonicalize(path)?;
    #[cfg(windows)]
    if let Some(path) = path.to_str() {
        if let Some(rest) = path.strip_prefix(r"\\?\UNC\") {
            return Ok(PathBuf::from(format!(r"\\{rest}")));
        }
        if let Some(rest) = path.strip_prefix(r"\\?\")
            && rest.as_bytes().get(1) == Some(&b':')
        {
            return Ok(PathBuf::from(rest));
        }
    }
    Ok(path)
}

pub(crate) fn missing(error: &io::Error) -> bool {
    matches!(
        error.kind(),
        io::ErrorKind::NotFound | io::ErrorKind::NotADirectory
    )
}

fn marker(path: &Path) -> Result<Option<String>> {
    let parent = path.parent().ok_or(Error::Invalid("Invalid lease path"))?;
    match canonical_path(parent) {
        Ok(actual) if actual == parent => {}
        Ok(_) => return Ok(None),
        Err(error) if missing(&error) => return Ok(None),
        Err(error) => return Err(error.into()),
    }
    let metadata = match fs::symlink_metadata(path) {
        Ok(metadata) => metadata,
        Err(error) if missing(&error) => return Ok(None),
        Err(error) => return Err(error.into()),
    };
    if !metadata.is_file() || metadata.len() != 36 {
        return Ok(None);
    }
    let mut data = Vec::with_capacity(37);
    match fs::File::open(path) {
        Ok(file) => file.take(37).read_to_end(&mut data)?,
        Err(error) if missing(&error) => return Ok(None),
        Err(error) => return Err(error.into()),
    };
    if data.len() != 36
        || !data.iter().enumerate().all(|(index, byte)| {
            if matches!(index, 8 | 13 | 18 | 23) {
                *byte == b'-'
            } else {
                byte.is_ascii_digit() || (b'a'..=b'f').contains(byte)
            }
        })
    {
        return Ok(None);
    }
    Ok(String::from_utf8(data).ok())
}

fn ensure_marker(path: &Path) -> Result<String> {
    let parent = path.parent().ok_or(Error::Invalid("Invalid lease path"))?;
    let mut builder = fs::DirBuilder::new();
    builder.recursive(true);
    #[cfg(unix)]
    {
        use std::os::unix::fs::DirBuilderExt;
        builder.mode(0o700);
    }
    builder.create(parent)?;
    if canonical_path(parent)? != parent {
        return Err(Error::Invalid(
            "Lease directory must be inside the workspace",
        ));
    }
    if let Some(token) = marker(path)? {
        return Ok(token);
    }
    let mut random = [0u8; 16];
    getrandom::fill(&mut random).map_err(|error| io::Error::other(error.to_string()))?;
    let data = crate::layer::hex_digest(random);
    let hex = &data[7..];
    let token = format!(
        "{}-{}-{}-{}-{}",
        &hex[0..8],
        &hex[8..12],
        &hex[12..16],
        &hex[16..20],
        &hex[20..]
    );
    let mut temp = tempfile::NamedTempFile::new_in(parent)?;
    temp.write_all(token.as_bytes())?;
    temp.as_file().sync_all()?;
    temp.persist(path).map_err(|error| error.error)?;
    Ok(token)
}

pub(crate) struct Lease {
    pub path: PathBuf,
    ttl_ms: i64,
}

impl Lease {
    pub fn new(root: &Path, workspace: &Path, ttl: Duration) -> Result<Self> {
        let workspace = canonical_path(workspace)?;
        if !workspace.is_dir() {
            return Err(Error::Invalid("Lease workspace must be a directory"));
        }
        let ttl_ms = i64::try_from(ttl.as_millis())
            .ok()
            .filter(|ttl| *ttl > 0 && *ttl < 9_007_199_254_740_991)
            .ok_or(Error::Invalid("Expected a positive lease duration"))?;
        let cache_id = sha256(text(root)?.as_bytes());
        let path = workspace
            .join(DIRECTORY)
            .join(format!("{}.lease", &cache_id[7..]));
        text(&path)?;
        Ok(Self { path, ttl_ms })
    }

    fn expires(&self, now: i64) -> Result<i64> {
        now.checked_add(self.ttl_ms)
            .filter(|time| *time <= 9_007_199_254_740_991)
            .ok_or(Error::Invalid("Lease expiration exceeds supported range"))
    }

    pub fn retain(&self, db: &Transaction<'_>, digest: &str) -> Result<()> {
        let token = ensure_marker(&self.path)?;
        db.execute(
            "INSERT INTO leases VALUES (?1, ?2, ?3, ?4)
             ON CONFLICT(path, digest) DO UPDATE SET token = excluded.token,
             expires = CASE WHEN leases.token = excluded.token THEN MAX(leases.expires, excluded.expires) ELSE excluded.expires END",
            params![text(&self.path)?, digest, token, self.expires(now()?)?],
        )?;
        Ok(())
    }

    pub fn renew(&self, db: &Transaction<'_>) -> Result<usize> {
        let Some(token) = marker(&self.path)? else {
            return Ok(0);
        };
        let now = now()?;
        Ok(db.execute(
            "UPDATE leases SET expires = MAX(expires, ?1) WHERE path = ?2 AND token = ?3 AND expires > ?4",
            params![self.expires(now)?, text(&self.path)?, token, now],
        )?)
    }

    pub fn release(&self, db: &Transaction<'_>) -> Result<usize> {
        if marker(&self.path)?.is_some() {
            match fs::remove_file(&self.path) {
                Err(error) if missing(&error) => {}
                result => result?,
            }
        }
        Ok(db.execute("DELETE FROM leases WHERE path = ?1", [text(&self.path)?])?)
    }
}

pub(crate) fn active(db: &Transaction<'_>) -> Result<(HashSet<String>, usize)> {
    let mut select = db.prepare("SELECT path, digest, token, expires FROM leases")?;
    let rows = select
        .query_map([], |row| {
            Ok((
                row.get::<_, String>(0)?,
                row.get::<_, String>(1)?,
                row.get::<_, String>(2)?,
                row.get::<_, i64>(3)?,
            ))
        })?
        .collect::<rusqlite::Result<Vec<_>>>()?;
    let mut markers = HashMap::new();
    let mut retained = HashSet::new();
    let mut removed = 0;
    let now = now()?;
    let mut delete = db.prepare("DELETE FROM leases WHERE path = ?1 AND digest = ?2")?;
    for (path, digest, token, expires) in rows {
        if expires > now {
            let found = match markers.entry(path.clone()) {
                std::collections::hash_map::Entry::Occupied(entry) => entry.into_mut(),
                std::collections::hash_map::Entry::Vacant(entry) => {
                    entry.insert(marker(Path::new(&path))?)
                }
            };
            if found.as_deref() == Some(&token) {
                retained.insert(digest);
                continue;
            }
        }
        removed += delete.execute(params![path, digest])?;
    }
    Ok((retained, removed))
}
