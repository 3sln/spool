"""One-task guest. The calling provider owns the sandbox and must destroy it."""
import argparse
import base64
import ctypes
import gzip
import hashlib
from http.server import BaseHTTPRequestHandler, HTTPServer
import io
import json
import os
from pathlib import Path
import resource
import selectors
import shutil
import signal
import stat
import subprocess
import sys
import tarfile
import time
from contextlib import ExitStack

MIB = 1024 ** 2
MAX_INPUT = 12 * MIB
MAX_EXPANDED = 32 * MIB
MAX_ENTRIES = 4096
MAX_LOGS = 128 * 1024
MAX_ARTIFACTS = 512 * 1024
UID = 65532


class InvalidLayer(Exception):
    pass


def clean_path(name):
    while name.startswith("./"):
        name = name[2:]
    if name in ("", "."):
        return ()
    parts = name.split("/")
    if len(name) > 1024 or len(parts) > 32 or any(
        part in ("", ".", "..") or "\x00" in part or len(os.fsencode(part)) > 255 for part in parts
    ):
        raise InvalidLayer("Invalid archive path")
    return tuple(parts)


def ensure_directory(root, parts):
    path = root
    for part in parts:
        path /= part
        if path.exists() and not path.is_dir():
            path.unlink()
        path.mkdir(exist_ok=True)
    return path


def remove(path):
    if path.is_dir():
        shutil.rmtree(path)
    else:
        path.unlink(missing_ok=True)


def apply_layer(root, stream, entries_left):
    with tarfile.open(fileobj=io.BytesIO(stream), mode="r:") as archive:
        entries = []
        names = set()
        for member in archive:
            entries_left -= 1
            if entries_left < 0:
                raise InvalidLayer("Too many layer entries")
            parts = clean_path(member.name)
            if not parts and member.isdir():
                continue
            if (not parts or any(part.startswith(".wh.") for part in parts[:-1])
                    or parts in names or member.type not in (tarfile.REGTYPE, tarfile.AREGTYPE, tarfile.DIRTYPE)
                    or member.sparse is not None or member.linkname
                    or set(member.pax_headers) - {"path", "size", "mtime", "atime", "ctime"}):
                raise InvalidLayer("Unsupported or duplicate archive member")
            if member.size < 0 or (member.isdir() and member.size != 0):
                raise InvalidLayer("Invalid member size")
            names.add(parts)
            entries.append((parts, member))

        # Whiteouts affect only lower layers. Apply them before entries from this layer.
        for parts, member in entries:
            name = parts[-1]
            if not name.startswith(".wh."):
                continue
            target = name[4:]
            if not member.isfile() or member.size != 0 or target in ("", ".", "..") or target.startswith(".wh.") and target != ".wh..opq":
                raise InvalidLayer("Malformed whiteout")
            parent = root.joinpath(*parts[:-1])
            if parent.is_dir():
                if name == ".wh..wh..opq":
                    for child in parent.iterdir():
                        remove(child)
                else:
                    remove(parent / target)

        for parts, member in entries:
            if parts[-1].startswith(".wh."):
                continue
            parent = ensure_directory(root, parts[:-1])
            destination = parent / parts[-1]
            if member.isdir():
                ensure_directory(parent, parts[-1:])
                continue
            remove(destination)
            with archive.extractfile(member) as source, destination.open("xb") as output:
                shutil.copyfileobj(source, output, length=65536)
            destination.chmod(0o755 if member.mode & 0o111 else 0o644)
    return entries_left


def assemble(root, manifest, layers):
    descriptors = manifest["environment"]["layers"]
    remaining = MAX_EXPANDED
    entries = MAX_ENTRIES
    if len(descriptors) != len(layers):
        raise InvalidLayer("Missing archive")
    for descriptor, encoded in zip(descriptors, layers):
        data = base64.b64decode(encoded, validate=True)
        if len(data) != descriptor["size"] or "sha256:" + hashlib.sha256(data).hexdigest() != descriptor["digest"]:
            raise InvalidLayer("Invalid layer digest")
        media = descriptor["media_type"]
        if media == "application/vnd.oci.image.layer.v1.tar+gzip":
            with gzip.GzipFile(fileobj=io.BytesIO(data)) as packed:
                data = packed.read(remaining + 1)
        elif media != "application/vnd.oci.image.layer.v1.tar":
            raise InvalidLayer("Unsupported media type")
        remaining -= len(data)
        if remaining < 0:
            raise InvalidLayer("Expanded layers exceed the byte limit")
        entries = apply_layer(root, data, entries)


def open_artifact(root, parts, maximum):
    # Resolve every component relative to an open directory, rejecting symlinks.
    with ExitStack() as stack:
        fd = os.open(root, os.O_RDONLY | os.O_DIRECTORY | os.O_NOFOLLOW)
        stack.callback(os.close, fd)
        for part in parts[:-1]:
            fd = os.open(part, os.O_RDONLY | os.O_DIRECTORY | os.O_NOFOLLOW, dir_fd=fd)
            stack.callback(os.close, fd)
        artifact = os.open(parts[-1], os.O_RDONLY | os.O_NOFOLLOW | os.O_NONBLOCK, dir_fd=fd)
        with os.fdopen(artifact, "rb") as handle:
            info = os.fstat(artifact)
            if stat.S_ISREG(info.st_mode) and info.st_nlink == 1 and info.st_size <= maximum:
                data = handle.read(maximum + 1)
                if len(data) <= maximum:
                    return data
    return None


def workspace_parts(path):
    if path == "/workspace":
        return ()
    if not path.startswith("/workspace/"):
        raise ValueError("Path is outside workspace")
    return clean_path(path[len("/workspace/"):])


def child_limits(timeout):
    limits = [
        (resource.RLIMIT_CPU, timeout, timeout + 1),
        (resource.RLIMIT_FSIZE, 16 * MIB, 16 * MIB),
        (resource.RLIMIT_NOFILE, 256, 256),
        (resource.RLIMIT_CORE, 0, 0),
    ]
    if sys.platform == "linux":
        library = ctypes.CDLL(None, use_errno=True)
        if library.prctl(38, 1, 0, 0, 0) != 0:  # PR_SET_NO_NEW_PRIVS
            raise OSError(ctypes.get_errno(), "Could not disable privilege elevation")
        limits += [(resource.RLIMIT_AS, 256 * MIB, 256 * MIB), (resource.RLIMIT_NPROC, 64, 64)]
    for key, soft, hard in limits:
        old_soft, old_hard = resource.getrlimit(key)
        if old_hard != resource.RLIM_INFINITY:
            hard = min(hard, old_hard)
        if old_soft != resource.RLIM_INFINITY:
            soft = min(soft, old_soft)
        resource.setrlimit(key, (min(soft, hard), hard))


def run_command(root, manifest):
    command = manifest["command"]
    timeout = manifest["resources"]["timeout_s"]
    cwd = root.joinpath(*workspace_parts(command["cwd"]))
    identity = {}
    if os.geteuid() == 0:
        for directory, dirs, files in os.walk(root):
            os.chown(directory, UID, UID)
            for name in dirs + files:
                os.chown(Path(directory) / name, UID, UID)
        identity = {"user": UID, "group": UID, "extra_groups": []}
    proc = subprocess.Popen(
        command["argv"], cwd=cwd, stdin=subprocess.DEVNULL,
        stdout=subprocess.PIPE, stderr=subprocess.PIPE, start_new_session=True,
        env={"PATH": "/usr/local/bin:/usr/bin:/bin", "HOME": str(root),
             "TMPDIR": "/tmp", "LANG": "C.UTF-8", "PYTHONDONTWRITEBYTECODE": "1"},
        preexec_fn=lambda: child_limits(timeout), **identity,
    )
    chunks = {"stdout": bytearray(), "stderr": bytearray()}
    budget = MAX_LOGS
    truncated = False
    timed_out = False
    deadline = time.monotonic() + timeout
    try:
        with selectors.DefaultSelector() as selector:
            selector.register(proc.stdout, selectors.EVENT_READ, "stdout")
            selector.register(proc.stderr, selectors.EVENT_READ, "stderr")
            while selector.get_map():
                left = deadline - time.monotonic()
                if left <= 0:
                    raise subprocess.TimeoutExpired(command["argv"], timeout)
                for key, _ in selector.select(left):
                    data = os.read(key.fd, 32768)
                    if not data:
                        selector.unregister(key.fileobj)
                        continue
                    chunks[key.data].extend(data[:budget])
                    truncated |= len(data) > budget
                    budget = max(0, budget - len(data))
        proc.wait(timeout=max(0, deadline - time.monotonic()))
    except subprocess.TimeoutExpired:
        timed_out = True
    finally:
        try:
            os.killpg(proc.pid, signal.SIGKILL)
        except ProcessLookupError:
            pass
        proc.wait()
        proc.stdout.close()
        proc.stderr.close()

    result = {channel: data.decode("utf-8", "replace") for channel, data in chunks.items()}
    result.update(exit_code=proc.returncode, output_truncated=truncated, artifacts=[])
    if timed_out:
        result["error"] = "DEADLINE_EXCEEDED"
        return result
    remaining = MAX_ARTIFACTS
    for path in manifest.get("outputs", {}).get("paths", []):
        try:
            data = open_artifact(root, workspace_parts(path), remaining)
        except OSError:
            continue
        if data is not None:
            remaining -= len(data)
            result["artifacts"].append({"path": path, "body": base64.b64encode(data).decode("ascii")})
    return result


def execute(raw, root):
    try:
        work = json.loads(raw)
        assemble(root, work["manifest"], work["layers"])
    except (InvalidLayer, ValueError, EOFError, OSError, tarfile.TarError):
        return {"error": "LAYER_INVALID"}
    try:
        return run_command(root, work["manifest"])
    except (OSError, ValueError):
        return {"error": "EXECUTION_FAILED"}


def run_http(root):
    used = False

    class Handler(BaseHTTPRequestHandler):
        def do_GET(self):
            self.send_response(204 if self.path == "/healthz" else 404)
            self.end_headers()

        def do_POST(self):
            nonlocal used
            if self.path != "/run" or used:
                self.send_error(404)
                return
            try:
                length = int(self.headers.get("Content-Length", ""))
                if length < 1 or length > MAX_INPUT:
                    raise ValueError()
            except ValueError:
                self.send_error(413)
                return
            used = True
            result = json.dumps(execute(self.rfile.read(length), root), ensure_ascii=False).encode()
            self.send_response(200)
            self.send_header("Content-Type", "application/json")
            self.send_header("Content-Length", str(len(result)))
            self.end_headers()
            self.wfile.write(result)

        def log_message(self, *_args):
            pass

    with HTTPServer(("0.0.0.0", 8080), Handler) as server:
        server.serve_forever()


if __name__ == "__main__":
    parser = argparse.ArgumentParser()
    parser.add_argument("mode", choices=("http", "stdio"))
    parser.add_argument("--workspace", type=Path, default=Path("/workspace"))
    args = parser.parse_args()
    if not args.workspace.is_dir() or any(args.workspace.iterdir()):
        sys.exit("Guest workspace must be an empty directory")
    if args.mode == "http":
        run_http(args.workspace)
    else:
        raw = sys.stdin.buffer.read(MAX_INPUT + 1)
        result = execute(raw, args.workspace) if len(raw) <= MAX_INPUT else {"error": "RESOURCE_LIMIT"}
        print(json.dumps(result, ensure_ascii=False))
