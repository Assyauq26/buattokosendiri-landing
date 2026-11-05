#!/usr/bin/env bash
set -Eeuo pipefail
set +x
umask 077
[[ $EUID -eq 0 ]] || { echo 'Jalankan menggunakan sudo.'; exit 1; }
source /etc/os-release
[[ $ID == ubuntu && $VERSION_ID == 24.04 ]] || { echo 'Ubuntu 24.04 diperlukan.'; exit 1; }
[[ ! -L /opt/btos-agent && ! -L /etc/btos-agent ]] || exit 1
if [[ ! -f /etc/btos-agent/config.json ]]; then
  for path in /etc/single-store /opt/single-store /var/lib/single-store; do
    [[ ! -e $path && ! -L $path ]] || { echo 'Server berisi toko/data. Gunakan VPS kosong.'; exit 1; }
  done
  for port in 80 443 3000 8787; do
    [[ -z $(ss -H -ltn "sport = :$port") ]] || { echo "Port $port sedang dipakai. Gunakan VPS kosong."; exit 1; }
  done
fi
apt-get update
apt-get install -y ca-certificates curl git python3
install -d -o root -g root -m 0700 /opt/btos-agent /etc/btos-agent
curl --proto '=https' --tlsv1.2 --fail --silent --show-error '__PLATFORM_ORIGIN__/agent.py' -o /opt/btos-agent/agent.py.new
echo '__AGENT_SHA256__  /opt/btos-agent/agent.py.new' | sha256sum -c -
install -o root -g root -m 0700 /opt/btos-agent/agent.py.new /opt/btos-agent/agent.py
python3 /opt/btos-agent/agent.py --setup </dev/tty
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
systemctl enable --now btos-agent.service
echo 'Agent aktif. Kembali ke wizard platform untuk memantau proses.'
