#!/bin/sh
set -eu
# Railway mounts volumes at runtime, owned by root; give the application user the mount directory. A root admin
# command or a restored file can also leave the database or its SQLite sidecars owned by root, which the node user
# could not open (OPS-03). Repair only these known files, never recursively, and leave symbolic links alone. The
# application itself refuses to start in production when the database is not on a persistent volume.
if [ "$(id -u)" = "0" ]; then
  mkdir -p /data
  chown node:node /data
  database="${MIRROR_DB:-/data/mirror.sqlite}"
  if [ "$database" != ":memory:" ]; then
    for file in "$database" "$database-wal" "$database-shm" "$(dirname "$database")/.amcp-volume-id"; do
      if [ -f "$file" ] && [ ! -L "$file" ]; then
        chown node:node "$file"
      fi
    done
  fi
  exec gosu node "$@"
fi
exec "$@"
