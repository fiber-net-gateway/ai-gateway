#!/bin/bash
set -euo pipefail

node_pid=''
nginx_pid=''

shutdown() {
  trap - TERM INT
  if [[ -n "$nginx_pid" ]]; then
    kill -TERM "$nginx_pid" 2>/dev/null || true
  fi
  if [[ -n "$node_pid" ]]; then
    kill -TERM "$node_pid" 2>/dev/null || true
  fi
  wait "$nginx_pid" 2>/dev/null || true
  wait "$node_pid" 2>/dev/null || true
}

trap shutdown TERM INT

setpriv --reuid=node --regid=node --init-groups node server/dist/index.js &
node_pid=$!
nginx -g 'daemon off;' &
nginx_pid=$!

set +e
wait -n "$node_pid" "$nginx_pid"
status=$?
set -e
shutdown
exit "$status"
