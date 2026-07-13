#!/usr/bin/env bash
# Serve Ka-Rae-oke to the local network.
# Binds serve.py to 0.0.0.0 and prints the LAN URL other devices should open.
# Extra args are passed straight through, e.g.:  ./serve-lan.sh --port 9000
set -euo pipefail

cd "$(dirname "$0")"

PORT=8080
# best-effort: pull a --port value out of the args just for the printed URL
prev=""
for a in "$@"; do
  [ "$prev" = "--port" ] && PORT="$a"
  prev="$a"
done

# Detect a private LAN IPv4 (192.168.* / 10.* / 172.16-31.*), best-effort per-OS.
detect_ip() {
  # Windows (Git Bash): parse ipconfig
  if command -v ipconfig >/dev/null 2>&1 && ipconfig 2>/dev/null | grep -qi "IPv4"; then
    ipconfig 2>/dev/null | grep -i "IPv4" | grep -oE "([0-9]+\.){3}[0-9]+" \
      | grep -E "^(192\.168|10\.|172\.(1[6-9]|2[0-9]|3[01]))\." | head -n1 && return
  fi
  # Linux
  if command -v hostname >/dev/null 2>&1 && hostname -I >/dev/null 2>&1; then
    hostname -I 2>/dev/null | tr ' ' '\n' \
      | grep -E "^(192\.168|10\.|172\.(1[6-9]|2[0-9]|3[01]))\." | head -n1 && return
  fi
  # macOS
  if command -v ipconfig >/dev/null 2>&1; then
    for i in en0 en1; do ipconfig getifaddr "$i" 2>/dev/null && return; done
  fi
}

PY=python
command -v python >/dev/null 2>&1 || PY=python3

IP="$(detect_ip || true)"
echo "-----------------------------------------------------------"
echo "  Ka-Rae-oke — serving to the local network"
if [ -n "${IP:-}" ]; then
  echo "  On this machine : http://localhost:${PORT}/"
  echo "  On the network  : http://${IP}:${PORT}/"
else
  echo "  On this machine : http://localhost:${PORT}/"
  echo "  On the network  : http://<this-PC-LAN-IP>:${PORT}/"
fi
echo "  (mic needs HTTPS/localhost, so it is off on remote devices)"
echo "  Windows: allow Python through the firewall on Private networks."
echo "  Ctrl+C to stop."
echo "-----------------------------------------------------------"

exec "$PY" serve.py --host 0.0.0.0 "$@"
