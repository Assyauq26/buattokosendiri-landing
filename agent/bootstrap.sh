#!/usr/bin/env bash
set -Eeuo pipefail
set +x
umask 077
mode=${1:-}
[[ -z $mode || $mode == --enroll ]] || exit 1
if [[ $mode == --enroll ]]; then
  IFS= read -r enrollment
  [[ $enrollment =~ ^[a-f0-9]{64}$ ]] || exit 1
fi
[[ $EUID -eq 0 ]] || { echo 'Jalankan menggunakan sudo.'; exit 1; }
source /etc/os-release
[[ $ID == ubuntu && $VERSION_ID == 24.04 ]] || { echo 'Ubuntu 24.04 diperlukan.'; exit 1; }
[[ ! -L /opt/btos-agent && ! -L /etc/btos-agent ]] || exit 1
apt-get update
apt-get install -y ca-certificates curl git python3
install -d -o root -g root -m 0700 /opt/btos-agent /etc/btos-agent
curl --proto '=https' --tlsv1.2 --fail --silent --show-error '__PLATFORM_ORIGIN__/agent.py' -o /opt/btos-agent/agent.py.new
echo '__AGENT_SHA256__  /opt/btos-agent/agent.py.new' | sha256sum -c -
install -o root -g root -m 0700 /opt/btos-agent/agent.py.new /opt/btos-agent/agent.py
if [[ $mode == --enroll ]]; then
  printf '%s\n' "$enrollment" | python3 /opt/btos-agent/agent.py --setup --token-stdin
  unset enrollment
else
  python3 /opt/btos-agent/agent.py --setup </dev/tty
fi
cat >/etc/systemd/system/btos-agent.service <<'UNIT'
[Unit]
Description=BTOS outbound installation agent
Wants=network-online.target
After=network-online.target
[Service]
ExecStart=/usr/bin/python3 /opt/btos-agent/agent.py
Restart=on-failure
RestartSec=30
UMask=0077
StandardOutput=journal
StandardError=journal
[Install]
WantedBy=multi-user.target
UNIT
systemctl daemon-reload
systemctl enable btos-agent.service
systemctl restart btos-agent.service
echo 'Agent aktif. Kembali ke wizard platform untuk memantau proses.'
