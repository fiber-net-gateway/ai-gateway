#!/bin/bash
set -euo pipefail

: "${MYSQL_URL:?MYSQL_URL is required}"
: "${MYSQL_PORT:?MYSQL_PORT is required}"
: "${MYSQL_USERNAME:?MYSQL_USERNAME is required}"
: "${MYSQL_PASSWD:?MYSQL_PASSWD is required}"
: "${MYSQL_SCHEMA:?MYSQL_SCHEMA is required}"

if [ ! -e /lib/ld-linux-x86-64.so.2 ]; then
  ln -s /lib/libc.musl-x86_64.so.1 /lib/ld-linux-x86-64.so.2
fi
/usr/local/tomcat/datasources.sh
exec catalina.sh run
