#!/bin/sh
# Seeds a fresh AI E2E playground: API key, users alice/bob, four registered devices,
# and three pending routes on dev-router. Run after `docker compose down -v` (user IDs 1/2 are assumed).
set -eu
cd "$(dirname "$0")"
SECRETS=../../../.claude/ai-e2e # gitignored; the browser agent reads these via the dev server
umask 077
mkdir -p "$SECRETS"

dc() { docker compose -f compose.yml "$@"; }
hs() { dc exec -T headscale headscale "$@"; }

dc up -d --wait
hs apikeys create --expiration 90d | tail -1 | tr -d '\r\n' > "$SECRETS/api-key.txt"
[ -s "$SECRETS/profile-password.txt" ] || openssl rand -base64 18 | tr -d '\n' > "$SECRETS/profile-password.txt"
hs users create alice > /dev/null
hs users create bob > /dev/null

register() {
  service=$1 user=$2
  shift 2
  key=$(hs preauthkeys create --user "$user" --expiration 1h | grep -oE 'hskey-auth-[A-Za-z0-9_-]+' | head -1)
  dc exec -T "$service" tailscale up --login-server=http://headscale:8080 --auth-key="$key" \
    --accept-dns=false --timeout=30s "$@"
}
register laptop 1 --hostname=dev-laptop
register desktop 1 --hostname=dev-desktop
register server 2 --hostname=dev-server
register router 2 --hostname=dev-router --advertise-routes=10.42.0.0/16 --advertise-exit-node

hs nodes list
