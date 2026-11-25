#!/bin/sh
set -eu
spool_kin=${SPOOL_KIN_SRC:-../kin/src}
spool_snug=${SPOOL_SNUG_KIN_SRC:-../snug/kin/src}
bb --classpath "client/kin/src:$spool_kin:$spool_snug" client/kin/emit.clj "$@"
if [ "$#" -eq 0 ]; then
  cp client/generated/rust/spool/client/replay.rs sdk/rust/src/replay.rs
fi
