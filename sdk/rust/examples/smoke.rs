use serde_json::json;
use spool_client::{Client, Entry, HeaderMap, HeaderValue, LayerCache, TAR, build_layer};
use std::{env, time::Duration};

fn main() -> Result<(), Box<dyn std::error::Error>> {
    let raw = env::var("SPOOL_TOKEN")?;
    let authorization = HeaderValue::from_str(&format!("Bearer {raw}"))?;
    let client = Client::new(
        &env::var("SPOOL_URL").unwrap_or_else(|_| "http://127.0.0.1:8787".to_owned()),
        move || {
            let mut headers = HeaderMap::new();
            headers.insert("authorization", authorization.clone());
            Ok(headers)
        },
    )?;
    let capabilities = client.capabilities()?;
    let cache_dir = tempfile::tempdir()?;
    let cache = LayerCache::open(cache_dir.path())?;
    let message = b"Rust client executed in Spool\n";
    let bytes = build_layer([Entry::File {
        path: "message.txt",
        bytes: message,
        executable: false,
    }])?;
    let layer = cache.put(&bytes, TAR)?;
    let id = format!(
        "rust-smoke-{}",
        std::time::SystemTime::now()
            .duration_since(std::time::UNIX_EPOCH)?
            .as_nanos()
    );
    let manifest = json!({
        "protocol_version": "0.1", "client_request_id": id,
        "platform": {"os": "linux", "arch": "amd64"},
        "environment": {"base": capabilities["bases"][0], "layers": [layer]},
        "command": {"argv": ["sh", "-ec", "cat message.txt; cp message.txt result.txt"], "cwd": "/workspace"},
        "resources": {"cpu": 1, "memory_mib": 256, "disk_mib": 64, "timeout_s": 10},
        "network": {"mode": "none"}, "outputs": {"paths": ["/workspace/result.txt"]}
    });
    let job = client.submit(&manifest)?;
    let done = client.wait(&job.task_id, Duration::from_secs(120), |layer| {
        cache.read(layer)
    })?;
    assert_eq!(done.state, "SUCCEEDED", "{done:?}");
    let artifacts = client.artifacts(&job.task_id)?;
    assert_eq!(client.download(&artifacts[0])?, message);
    let mut replay = Vec::new();
    assert_eq!(
        client.events(&job.task_id, 0, |event| replay.push(event.kind))?,
        done.cursor
    );
    assert_eq!(replay.last().map(String::as_str), Some("task.completed"));
    println!("Rust SDK smoke passed");
    Ok(())
}
