#!/usr/bin/env bash
set -Eeuo pipefail
set +x
umask 077
[[ $EUID -eq 0 && $(hostname) == VM-0-15-ubuntu ]] || exit 1
backup=${1:-}
[[ $backup =~ ^/var/backups/btos-platform/[0-9]{8}T[0-9]{6}Z$ ]] || exit 1
sha=$(cat "$backup/previous-sha")
source_dir=$(cat "$backup/previous-source")
[[ $sha =~ ^[a-f0-9]{40}$ && $source_dir == "/opt/btos-platform/releases/$sha" ]] || exit 1
export PLATFORM_SHA="$sha"
exec 9>/run/btos-platform-deploy.lock
flock -n 9 || exit 1
overlay=()
if [[ -f /etc/btos-platform/catalog-compose.json ]]; then
  [[ ! -L /etc/btos-platform/catalog-compose.json && $(stat -c %u /etc/btos-platform/catalog-compose.json) == 0 ]] || exit 1
  [[ $(( 8#$(stat -c %a /etc/btos-platform/catalog-compose.json) & 8#022 )) == 0 ]] || exit 1
  overlay=(-f /etc/btos-platform/catalog-compose.json)
fi
docker compose -f "$source_dir/deploy/compose.yaml" "${overlay[@]}" up -d --no-build --wait app
curl --fail --silent http://127.0.0.1:8088/api/platform/health
printf '%s\n' "$sha" >/etc/btos-platform/deployed-sha
ln -sfn "$source_dir" /opt/btos-platform/current
echo 'Code rollback complete; database unchanged. Restore database only after reviewed downtime plan.'
