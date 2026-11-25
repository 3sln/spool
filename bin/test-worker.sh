#!/bin/sh
set -eu
spool_modules=${SPOOL_TOOL_MODULES:-"$(npm root -g)"}
"${SPOOL_ESBUILD:-$spool_modules/esbuild/bin/esbuild}" test/worker.fixture.mjs \
  --bundle --format=esm --platform=neutral '--external:cloudflare:*' \
  --outfile=.wrangler/worker.fixture.js
"${SPOOL_WORKERD:-$spool_modules/workerd/bin/workerd}" test -I"$spool_modules" test/worker.capnp
