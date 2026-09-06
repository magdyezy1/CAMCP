#!/bin/sh
set -eu
# Railway mounts volumes at runtime; give the application user the mount directory.
if [ "$(id -u)" = "0" ]; then
  mkdir -p /data
  chown node:node /data
  exec gosu node "$@"
fi
exec "$@"
