#!/usr/bin/env bash
# Run only from an exact reviewed Git checkout on the authorized Tencent VPS.
set -Eeuo pipefail
set +x
umask 077
[[ $EUID -eq 0 && $(hostname) == VM-0-15-ubuntu ]] || { echo 'Authorized Tencent operator required'; exit 1; }
sha=${1:-}
[[ $sha =~ ^[a-f0-9]{40}$ ]] || exit 1
source_dir=$(cd -- "$(dirname -- "${BASH_SOURCE[0]}")/.." && pwd -P)
[[ $(git -c safe.directory="$source_dir" -C "$source_dir" rev-parse HEAD) == "$sha" ]] || exit 1
[[ -z $(git -c safe.directory="$source_dir" -C "$source_dir" status --porcelain) ]] || { echo 'Dirty source rejected'; exit 1; }
[[ $(df -Pk /var | awk 'NR==2 {print $4}') -gt 3000000 ]] || { echo 'At least 3 GB free needed'; exit 1; }
exec 9>/run/btos-platform-deploy.lock
flock -n 9 || exit 1
install -d -m 0700 /var/backups/btos-platform /opt/btos-platform
backup=/var/backups/btos-platform/$(date -u +%Y%m%dT%H%M%SZ)
mkdir -m 0700 "$backup"
old=$(readlink -f /opt/btos-platform/current || true)
old_sha=''
if [[ -f /etc/btos-platform/deployed-sha ]]; then
  old_sha=$(cat /etc/btos-platform/deployed-sha)
  [[ $old_sha =~ ^[a-f0-9]{40}$ && $old == /opt/btos-platform/releases/* ]] || exit 1
  tar -czf "$backup/config.tgz" -C /etc btos-platform
  docker exec btos-platform-db-1 pg_dump -U platform_owner -d platform -Fc > "$backup/platform.dump"
  test -s "$backup/platform.dump"
  printf '%s\n' "$old" > "$backup/previous-source"
  printf '%s\n' "$old_sha" > "$backup/previous-sha"
else
  [[ -z $(docker ps -aq --filter name='^btos-platform-') ]] || { echo 'Unmanaged platform containers found'; exit 1; }
  [[ -z $(docker volume ls -q --filter name='^btos-platform_') ]] || { echo 'Unmanaged platform volume found'; exit 1; }
  [[ -z $(ss -H -ltn 'sport = :8088') ]] || { echo 'Port 8088 in use'; exit 1; }
fi
# Snapshot Hubify routing for comparison only. Never reload or edit it here.
if [[ -f /etc/single-store/Caddyfile ]]; then sha256sum /etc/single-store/Caddyfile > "$backup/hubify-routing.sha256"; fi
python3 "$source_dir/deploy/init-production.py"
export PLATFORM_SHA="$sha"
dc() { docker compose -f "$source_dir/deploy/compose.yaml" "$@"; }
rollback() {
  code=$?
  if [[ -n $old_sha ]]; then
    export PLATFORM_SHA="$old_sha"
    docker compose -f "$old/deploy/compose.yaml" up -d --no-build app
  else
    dc stop app || true
  fi
  echo "Deployment failed; platform data and backup retained: $backup" >&2
  exit "$code"
}
trap rollback ERR
dc config --quiet
dc build app
dc up -d --wait db
dc run --rm migrate
dc up -d --no-build --wait app
curl --fail --silent --show-error http://127.0.0.1:8088/api/platform/health
if [[ -f "$backup/hubify-routing.sha256" ]]; then sha256sum -c "$backup/hubify-routing.sha256"; fi
printf '%s\n' "$sha" >/etc/btos-platform/deployed-sha
ln -sfn "$source_dir" /opt/btos-platform/current
trap - ERR
echo 'PLATFORM_DEPLOYED_LOOPBACK_ONLY — public DNS and Hubify unchanged'
