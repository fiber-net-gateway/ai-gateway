#!/bin/sh
set -eu

: "${AI_SERVER_ADVERTISE_ADDRESS:?AI_SERVER_ADVERTISE_ADDRESS is required}"
: "${NACOS_SERVER_ADDRESSES:?NACOS_SERVER_ADDRESSES is required}"
: "${NACOS_USERNAME:?NACOS_USERNAME is required}"
: "${NACOS_PASSWORD:?NACOS_PASSWORD is required}"
: "${CAT_COLLECTOR_ADDRESSES:?CAT_COLLECTOR_ADDRESSES is required}"

envsubst < /etc/ai-server/ai-server.env.template > /tmp/ai-server.env
chmod 0600 /tmp/ai-server.env
exec /usr/local/bin/ai-server /tmp/ai-server.env
