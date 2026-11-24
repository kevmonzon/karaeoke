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
#     http://<deck-ip>:<port>/ and http://<deck-ip>:<port>/remote to queue/control;
#   * closes with the CONTROLLER: serve.py runs with --kiosk, so the footer shows an Exit
#     button (D-pad or touch, then confirm). Exit stops the server, and this script then
#     closes the browser (Ctrl+C in the terminal does the same).
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

PORT=52723   # serve.py's default (DEFAULT_PORT); --port N below overrides both
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

# What open_kiosk_browser started, so the browser can be closed again when the server stops:
# the Flatpak app id (if it was one) and the PID of what was launched.
BROWSER_APP=""
BROWSER_PID=""

launch_flatpak() {   # $1 = app id, $2 = url
  case "$1" in
    *firefox*) flatpak run "$1" --kiosk "$2" & ;;
    *)         flatpak run "$1" --kiosk --app="$2" & ;;
  esac
  BROWSER_PID=$!; BROWSER_APP="$1"
}
launch_native() {    # the browser binary and its arguments
  "$@" &
  BROWSER_PID=$!
}

# Open a fullscreen (kiosk) browser at $1. Prefers Flatpak browsers (the Steam Deck norm),
# Chromium-family first (cleanest kiosk + COOP/COEP). Falls back to native binaries / xdg-open.
# Override the choice with KARAEOKE_BROWSER=<flatpak-id-or-binary>.
open_kiosk_browser() {
  local url="$1" id bin
  # Explicit override wins.
  if [ -n "${KARAEOKE_BROWSER:-}" ]; then
    if command -v flatpak >/dev/null 2>&1 && flatpak info "$KARAEOKE_BROWSER" >/dev/null 2>&1; then
      launch_flatpak "$KARAEOKE_BROWSER" "$url"; return
    elif command -v "$KARAEOKE_BROWSER" >/dev/null 2>&1; then
      case "$KARAEOKE_BROWSER" in
        *firefox*) launch_native "$KARAEOKE_BROWSER" --kiosk "$url" ;;
        *)         launch_native "$KARAEOKE_BROWSER" --kiosk --app="$url" ;;
      esac
      return
    fi
  fi
  # Flatpak browsers, Chromium-family first.
  if command -v flatpak >/dev/null 2>&1; then
    for id in org.chromium.Chromium com.google.Chrome com.brave.Browser org.mozilla.firefox; do
      if flatpak info "$id" >/dev/null 2>&1; then launch_flatpak "$id" "$url"; return; fi
    done
  fi
  # Native binaries, just in case.
  for bin in chromium chromium-browser google-chrome google-chrome-stable brave-browser; do
    if command -v "$bin" >/dev/null 2>&1; then launch_native "$bin" --kiosk --app="$url"; return; fi
  done
  if command -v firefox >/dev/null 2>&1; then launch_native firefox --kiosk "$url"; return; fi
  if command -v xdg-open >/dev/null 2>&1; then xdg-open "$url" >/dev/null 2>&1 & return; fi
  echo "  ! No browser found — open this URL manually on the TV screen:  $url"
}

# Close the kiosk browser once the server has stopped (Exit on the screen, or Ctrl+C here).
# GENTLY first: SIGTERM to the browser's own process, which Chromium and Firefox treat as a
# normal quit (no "restore pages?" next time). Inside a Flatpak that process is NOT
# $BROWSER_PID — that is the sandbox launcher (bwrap), and killing it SIGKILLs the browser —
# so the browser is found by its kiosk URL on the command line, minus the launcher processes.
# Then up to 5 s, and only if it is still there, force it (flatpak kill / kill -9).
close_kiosk_browser() {
  local pids="" p i alive
  [ -n "$BROWSER_PID" ] || return 0
  if command -v pgrep >/dev/null 2>&1; then
    for p in $(pgrep -f -- "--kiosk.*localhost:${PORT}/" 2>/dev/null || true); do
      case "$(ps -o comm= -p "$p" 2>/dev/null)" in
        ""|bwrap|*/bwrap|flatpak*|*/flatpak*) ;;   # gone already, or the sandbox launcher
        *) pids="$pids $p" ;;
      esac
    done
  fi
  if [ -z "$pids" ]; then
    # Not found by its URL: it already closed, or `flatpak run` handed the URL to a copy of
    # that browser which was already running (single-instance) and exited. In the second
    # case the Flatpak app is still up — stop it, or the Deck is left on a dead page.
    # (No `grep -q` here: under pipefail its early exit can fail the pipeline.)
    if [ -n "$BROWSER_APP" ] && flatpak ps --columns=application 2>/dev/null | grep -x -- "$BROWSER_APP" >/dev/null; then
      flatpak kill "$BROWSER_APP" >/dev/null 2>&1 || true
    fi
    kill -TERM "$BROWSER_PID" 2>/dev/null || true
    return 0
  fi
  # shellcheck disable=SC2086  # $pids is a space-separated list on purpose
  kill -TERM $pids 2>/dev/null || true
  for i in $(seq 1 20); do
    alive=""
    for p in $pids; do kill -0 "$p" 2>/dev/null && alive=1; done
    [ -n "$alive" ] || return 0
    sleep 0.25
  done
  echo "  ! The browser did not close by itself — forcing it."
  if [ -n "$BROWSER_APP" ]; then flatpak kill "$BROWSER_APP" >/dev/null 2>&1 || true; fi
  # shellcheck disable=SC2086
  kill -KILL $pids 2>/dev/null || true
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
  echo "  To quit with the controller: Exit (⏻) at the bottom-right of the screen."
else
  echo "  Windows: allow Python through the firewall on Private networks."
fi
echo "  Ctrl+C to stop."
echo "-----------------------------------------------------------"

if [ "$KIOSK" = "1" ]; then
  # Offline server in the background; open this screen's browser fullscreen at it.
  # --kiosk gives this screen's page the Exit button (POST /api/quit, loopback only).
  "$PY" serve.py --host 0.0.0.0 --no-setup --no-open --kiosk "$@" &
  SERVER_PID=$!
  # However the server ends — Exit on the screen, Ctrl+C, or this terminal closing — the
  # browser goes with it, so a controller-only Deck is never left on a dead fullscreen page.
  # SIGTERM to serve.py is a clean stop (it flushes the play counts, as Ctrl+C does).
  cleanup() {
    trap - EXIT INT TERM HUP
    kill -TERM "$SERVER_PID" 2>/dev/null || true
    wait "$SERVER_PID" 2>/dev/null || true
    close_kiosk_browser
  }
  trap cleanup EXIT
  trap 'exit 130' INT TERM HUP   # → the EXIT trap → cleanup
  if wait_for_port "$PORT"; then
    open_kiosk_browser "http://localhost:${PORT}/"
  else
    echo "  ! Server didn't come up on port ${PORT} — open http://localhost:${PORT}/ manually."
  fi
  wait "$SERVER_PID" || true
  echo "  Server stopped — closing the browser."
else
  exec "$PY" serve.py --host 0.0.0.0 "$@"
fi
