#!/bin/sh
set -eu
dest=${1:-dist}
mkdir -p "$dest"
version=$(node -p 'require("./package.json").version')
crate_version=$(sed -n 's/^version = "\([^"]*\)"/\1/p' sdk/rust/Cargo.toml)
if [ "$version" != "$crate_version" ]; then
  echo "Rust and npm package versions differ" >&2
  exit 1
fi
cargo package --locked --allow-dirty --manifest-path sdk/rust/Cargo.toml
cp "${CARGO_TARGET_DIR:-sdk/rust/target}/package/spool-client-$version.crate" "$dest/"
if [ "${SPOOL_RELEASE_OCI:-0}" = 1 ]; then
  image="spool-guest:$version"
  docker build --platform linux/amd64 -t "$image" guest
  temp="$dest/.spool-image-$$.tar"
  trap 'rm -f "$temp" "$temp.gz"' EXIT HUP INT TERM
  docker save --output "$temp" "$image"
  gzip -n "$temp"
  mv "$temp.gz" "$dest/spool-guest-$version-linux-amd64.tar.gz"
fi
node release/package.mjs "$dest"
node release/check.mjs "$dest"
