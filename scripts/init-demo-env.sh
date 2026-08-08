#!/bin/sh
set -eu

demo_env_file=${1:-.env.docker}
if [ -e "$demo_env_file" ]; then
  echo "$demo_env_file already exists; refusing to overwrite it" >&2
  exit 1
fi
if ! command -v openssl >/dev/null 2>&1; then
  echo "openssl is required to generate demo credentials" >&2
  exit 1
fi

umask 077
mysql_root_password=$(openssl rand -hex 24)
mysql_password=$(openssl rand -hex 24)
rnacos_username="demo_$(openssl rand -hex 4)"
rnacos_password=$(openssl rand -hex 24)
app_encryption_key=$(openssl rand -base64 32 | tr -d '\n')
bootstrap_bt1_secret=$(openssl rand -base64 32 | tr -d '\n')
audit_ingest_token=$(openssl rand -hex 32)
demo_bind_address=${DEMO_BIND_ADDRESS:-127.0.0.1}
console_public_host=${CONSOLE_PUBLIC_HOST:-localhost}

{
  printf 'MYSQL_ROOT_PASSWORD=%s\n' "$mysql_root_password"
  printf 'MYSQL_PASSWORD=%s\n' "$mysql_password"
  printf 'RNACOS_USERNAME=%s\n' "$rnacos_username"
  printf 'RNACOS_PASSWORD=%s\n' "$rnacos_password"
  printf 'APP_ENCRYPTION_KEY=%s\n' "$app_encryption_key"
  printf 'BOOTSTRAP_BT1_SECRET_BASE64=%s\n' "$bootstrap_bt1_secret"
  printf 'AUDIT_INGEST_TOKEN=%s\n' "$audit_ingest_token"
  printf 'DEMO_BIND_ADDRESS=%s\n' "$demo_bind_address"
  printf 'CONSOLE_PUBLIC_HOST=%s\n' "$console_public_host"
  printf 'CONSOLE_PORT=5173\n'
  printf 'AI_SERVER_PORT=8080\n'
  printf 'DEMO_PROVIDER_PORT=8081\n'
  printf 'CAT_UI_PORT=8082\n'
  printf 'RNACOS_CONSOLE_PORT=10848\n'
  printf 'RNACOS_HTTP_PORT=8848\n'
  printf 'MYSQL_EXPOSE_PORT=3306\n'
} > "$demo_env_file"

echo "Created $demo_env_file with mode 0600"
echo "Start the demo with: docker compose --env-file $demo_env_file up --build"
