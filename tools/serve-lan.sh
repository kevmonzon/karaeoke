#!/usr/bin/env bash
# Serve Ka-Rae-oke to the local network.
# Binds serve.py to 0.0.0.0 and prints the LAN URL other devices should open.
# Extra args are passed straight through, e.g.:  ./serve-lan.sh --port 9000
#
# KIOSK / STEAM DECK (portable, no-install) mode
# ----------------------------------------------
# On a Steam Deck (SteamOS) this script auto-enables "kiosk" mode; force it
# anywhere with the --kiosk flag. Kiosk mode:
#   * runs the server OFFLINE (--no-setup) — everything is pre-baked on the drive,
#     and hosting a Wi-Fi hotspot leaves the Deck with no internet anyway;
#   * opens THIS screen's browser fullscreen at http://localhost:<port>/ so the
#     Deck is the host/TV display (a Flatpak Chromium/Chrome/Brave/Firefox already
#     installed on the Deck — nothing is installed by this script);
#   * still binds 0.0.0.0 so phones on your (manually-started) hotspot can reach
#     http://<deck-ip>:<port>/ and http://<deck-ip>:<port>/remote to queue/control.
# Force a specific browser with:  KARAEOKE_BROWSER=org.mozilla.firefox ./serve-lan.sh
# Nothing below changes for normal LAN use on macOS/Windows (kiosk stays off there).
set -euo pipefail

cd "$(dirname "$0")"

# --- kiosk mode: auto on SteamOS, or forced with --kiosk (stripped before forwarding) ---
KIOSK=0
STRIPPED=()
for a in "$@"; do
  if [ "$a" = "--kiosk" ]; then KIOSK=1; else STRIPPED+=("$a"); fi
done
set -- ${STRIPPED[@]+"${STRIPPED[@]}"}
if grep -qiE 'steamos|steamdeck' /etc/os-release 2>/dev/null || [ "${SteamDeck:-}" = "1" ]; then
  KIOSK=1
fi

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

# Wait until the server accepts a TCP connection on the port (bash /dev/tcp, no curl needed).
wait_for_port() {
  local port="$1" i
  for i in $(seq 1 60); do
    (exec 3<>"/dev/tcp/127.0.0.1/${port}") 2>/dev/null && return 0
    sleep 0.25
  done
  return 1
}

# Open a fullscreen (kiosk) browser at $1. Prefers Flatpak browsers (the Steam Deck norm),
# Chromium-family first (cleanest kiosk + COOP/COEP). Falls back to native binaries / xdg-open.
# Override the choice with KARAEOKE_BROWSER=<flatpak-id-or-binary>.
open_kiosk_browser() {
  local url="$1" id bin
  # Explicit override wins.
  if [ -n "${KARAEOKE_BROWSER:-}" ]; then
    if flatpak info "$KARAEOKE_BROWSER" >/dev/null 2>&1; then
      case "$KARAEOKE_BROWSER" in
        *firefox*) flatpak run "$KARAEOKE_BROWSER" --kiosk "$url" & return ;;
        *)         flatpak run "$KARAEOKE_BROWSER" --kiosk --app="$url" & return ;;
      esac
    elif command -v "$KARAEOKE_BROWSER" >/dev/null 2>&1; then
      "$KARAEOKE_BROWSER" --kiosk "$url" & return
    fi
  fi
  # Flatpak browsers, Chromium-family first.
  for id in org.chromium.Chromium com.google.Chrome com.brave.Browser org.mozilla.firefox; do
    if flatpak info "$id" >/dev/null 2>&1; then
      case "$id" in
        *firefox*) flatpak run "$id" --kiosk "$url" & return ;;
        *)         flatpak run "$id" --kiosk --app="$url" & return ;;
      esac
    fi
  done
  # Native binaries, just in case.
  for bin in chromium chromium-browser google-chrome google-chrome-stable brave-browser; do
    if command -v "$bin" >/dev/null 2>&1; then "$bin" --kiosk --app="$url" & return; fi
  done
  if command -v firefox >/dev/null 2>&1; then firefox --kiosk "$url" & return; fi
  if command -v xdg-open >/dev/null 2>&1; then xdg-open "$url" >/dev/null 2>&1 & return; fi
  echo "  ! No browser found — open this URL manually on the TV screen:  $url"
}

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
if [ "$KIOSK" = "1" ]; then
  echo "  Mode: KIOSK — offline, fullscreen browser on this screen (Steam Deck)."
  echo "  Guests: connect to this device's hotspot, then open the URL above."
else
  echo "  Windows: allow Python through the firewall on Private networks."
fi
echo "  Ctrl+C to stop."
echo "-----------------------------------------------------------"

if [ "$KIOSK" = "1" ]; then
  # Offline server in the background; open this screen's browser fullscreen at it.
  "$PY" serve.py --host 0.0.0.0 --no-setup --no-open "$@" &
  SERVER_PID=$!
  trap 'kill "$SERVER_PID" 2>/dev/null || true' EXIT INT TERM
  if wait_for_port "$PORT"; then
    open_kiosk_browser "http://localhost:${PORT}/"
  else
    echo "  ! Server didn't come up on port ${PORT} — open http://localhost:${PORT}/ manually."
  fi
  wait "$SERVER_PID"   # Ctrl+C (or closing this terminal) stops the server; Alt+F4 exits the browser.
else
  exec "$PY" serve.py --host 0.0.0.0 "$@"
fi
