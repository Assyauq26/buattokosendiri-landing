#!/usr/bin/env bash
# Operator-only static landing activation. No CI/PR check, no backend mutation.
# Usage: sudo bash activate-static-landing.sh deploy|rollback SHA_40 CADDY_CONTAINER
set -Eeuo pipefail
umask 077
ACTION=${1:-}
SHA=${2:-}
CONTAINER=${3:-}
[[ $EUID -eq 0 ]] || { echo 'Run as an authorized sudo operator.' >&2; exit 1; }
[[ "$ACTION" == deploy || "$ACTION" == rollback ]] || { echo 'Use deploy or rollback.' >&2; exit 1; }
[[ "$SHA" =~ ^[0-9a-f]{40}$ ]] || { echo 'Exact 40-character SHA required.' >&2; exit 1; }
[[ "$CONTAINER" =~ ^[a-zA-Z0-9_.-]+$ ]] || { echo 'Explicit Caddy container name required.' >&2; exit 1; }
for tool in docker python3 curl tar flock readlink mv ln grep sha256sum; do
  command -v "$tool" >/dev/null || { echo "Missing tool: $tool" >&2; exit 1; }
done
exec 9>/run/lock/btos-landing-static.lock
flock -n 9 || { echo 'Another landing deployment is running.' >&2; exit 1; }

MOUNT=$(docker inspect "$CONTAINER" --format '{{range .Mounts}}{{if eq .Destination "/data"}}{{.Source}}{{end}}{{end}}')
[[ -n "$MOUNT" && -d "$MOUNT" && ! -L "$MOUNT" ]] || { echo 'Caddy /data host mount unavailable.' >&2; exit 1; }
case "$MOUNT" in /|/opt|/var|/tmp) echo 'Unsafe broad mount.' >&2; exit 1;; esac
SITE="$MOUNT/landing/buattokosendiri"
RELEASES="$SITE/releases"
CURRENT="$SITE/current"
TARGET="$RELEASES/$SHA"
[[ -d "$SITE" && ! -L "$SITE" && -d "$RELEASES" && ! -L "$RELEASES" ]] || {
  echo 'Expected dedicated landing release directory missing.' >&2; exit 1;
}
[[ -d "$TARGET" && ! -L "$TARGET" ]] || { echo 'Target release directory missing or symlink.' >&2; exit 1; }
[[ -L "$CURRENT" ]] || { echo 'Current must be an existing release symlink; initial Caddy setup requires operator review.' >&2; exit 1; }
PREVIOUS=$(readlink "$CURRENT")
[[ "$PREVIOUS" =~ ^releases/[0-9a-f]{40}$ && -d "$SITE/$PREVIOUS" ]] || {
  echo 'Current points outside immutable releases.' >&2; exit 1;
}

# Refuse activation if Caddy is not serving precisely the dedicated domain/root.
docker exec "$CONTAINER" caddy validate --config /etc/caddy/Caddyfile --adapter caddyfile >/dev/null
CADDY_TMP=$(mktemp /tmp/btos-caddy.XXXXXXXX)
trap 'rm -f -- "$CADDY_TMP"' EXIT
docker cp "$CONTAINER:/etc/caddy/Caddyfile" "$CADDY_TMP"
grep -Fq 'buattokosendiri.web.id' "$CADDY_TMP" || { echo 'Expected domain missing from Caddy config.' >&2; exit 1; }
grep -Fq '/data/landing/buattokosendiri/current' "$CADDY_TMP" || {
  echo 'Caddy root does not use the expected current pointer.' >&2; exit 1;
}

# Validate every shipped byte without requiring CI. Reject symlinks or undeclared files.
python3 - "$TARGET" "$SHA" <<'PY'
import hashlib, json, pathlib, sys
root=pathlib.Path(sys.argv[1]); expected_sha=sys.argv[2]
manifest=json.loads((root/'release-manifest.json').read_text())
assert manifest.get('commit')==expected_sha
assert manifest.get('mode')=='static-landing'
assert manifest.get('canonical_origin')=='https://buattokosendiri.web.id'
listed=set()
for item in manifest['files']:
    name=item['file']
    p=pathlib.PurePosixPath(name)
    assert name not in listed and not p.is_absolute() and all(x not in ('.','..') for x in p.parts)
    f=root.joinpath(*p.parts)
    assert f.is_file() and not f.is_symlink() and f.stat().st_size==item['bytes']
    assert hashlib.sha256(f.read_bytes()).hexdigest()==item['sha256']
    listed.add(name)
required={'index.html','panduan-instalasi/index.html','panduan-instalasi/panduan-instalasi.pdf'}
assert required.issubset(listed)
actual={str(p.relative_to(root)) for p in root.rglob('*') if p.is_file()}
assert actual==listed|{'release-manifest.json'}
assert not any(p.is_symlink() for p in root.rglob('*'))
print('Immutable landing manifest and assets: OK')
PY

STAMP=$(date -u +%Y%m%dT%H%M%SZ)
BACKUP_DIR=/var/backups/btos-landing
install -d -o root -g root -m 0700 "$BACKUP_DIR"
BACKUP="$BACKUP_DIR/landing-$STAMP-$SHA.tgz"
[[ ! -e "$BACKUP" ]] || { echo 'Backup collision.' >&2; exit 1; }
OLD_SHA=${PREVIOUS##*/}
tar -czf "$BACKUP" -C "$RELEASES" "$OLD_SHA"
test -s "$BACKUP"
tar -tzf "$BACKUP" >/dev/null
printf 'Previous=%s\nTarget=%s\nBackup=%s\n' "$PREVIOUS" "releases/$SHA" "$BACKUP"

NEXT="$SITE/.current-next-$SHA-$$"
[[ ! -e "$NEXT" && ! -L "$NEXT" ]] || { echo 'Temporary pointer exists.' >&2; exit 1; }
SWAPPED=0
DONE=0
clean_up() {
  code=$?
  trap - EXIT INT TERM
  if [[ "$SWAPPED" == 1 && "$DONE" == 0 ]]; then
    echo 'Activation verification failed; restoring previous pointer.' >&2
    ln -s "$PREVIOUS" "$NEXT" && mv -Tf -- "$NEXT" "$CURRENT" || {
      echo "CRITICAL: automatic pointer rollback failed. Previous=$PREVIOUS Backup=$BACKUP" >&2
      exit 1
    }
    code=1
  fi
  [[ ! -e "$NEXT" && ! -L "$NEXT" ]] || rm -f -- "$NEXT"
  rm -f -- "$CADDY_TMP"
  exit "$code"
}
trap clean_up EXIT
trap 'exit 130' INT
trap 'exit 143' TERM

ln -s "releases/$SHA" "$NEXT"
mv -Tf -- "$NEXT" "$CURRENT"
SWAPPED=1

# Use uncached public URL checks. Never accept HTTP-only or a failed PDF response.
CHECK_DIR=$(mktemp -d /tmp/btos-landing-check.XXXXXXXX)
curl --fail --silent --show-error --max-time 25 -H 'Cache-Control: no-cache' \
  "https://buattokosendiri.web.id/?release=$SHA" -o "$CHECK_DIR/index.html"
grep -Fq '/panduan-instalasi/' "$CHECK_DIR/index.html"
curl --fail --silent --show-error --max-time 25 -H 'Cache-Control: no-cache' \
  "https://buattokosendiri.web.id/panduan-instalasi/?release=$SHA" -o "$CHECK_DIR/guide.html"
grep -Fq 'Unduh Panduan PDF' "$CHECK_DIR/guide.html"
curl --fail --silent --show-error --max-time 25 \
  "https://buattokosendiri.web.id/panduan-instalasi/panduan-instalasi.pdf?release=$SHA" -o "$CHECK_DIR/guide.pdf"
[[ "$(head -c 4 "$CHECK_DIR/guide.pdf")" == '%PDF' ]] || { echo 'PDF response is invalid.' >&2; exit 1; }
rm -f -- "$CHECK_DIR/index.html" "$CHECK_DIR/guide.html" "$CHECK_DIR/guide.pdf"
rmdir "$CHECK_DIR"
DONE=1
echo "SUCCESS: static landing $ACTION complete at commit $SHA; prior pointer $PREVIOUS"
echo "Backup retained: $BACKUP"
