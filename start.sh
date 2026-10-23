#!/bin/sh
# Decant launcher for macOS and Linux. Same job as start.ps1: start rclone's
# remote-control server on 127.0.0.1 with a password made for this launch,
# write it where the page can read it, and open the page. A server that is
# already running is reused, so a running upload is never interrupted.
set -eu

here=$(cd "$(dirname "$0")" && pwd)
ui="$here/ui"
session="$ui/session.js"
logs="$here/logs"
page="$ui/index.html"

# `open` is the macOS command; Linux desktops open files with xdg-open.
open_page() {
  if [ "$(uname)" = Darwin ]; then open "$page"
  elif command -v xdg-open >/dev/null 2>&1; then xdg-open "$page" >/dev/null 2>&1 &
  else echo "Open this in your browser: $page"
  fi
}

# Is the server named in session.js answering?
alive() {
  [ -f "$session" ] || return 1
  port=$(sed -n 's/.*"port":\([0-9]*\).*/\1/p' "$session")
  user=$(sed -n 's/.*"user":"\([^"]*\)".*/\1/p' "$session")
  pass=$(sed -n 's/.*"pass":"\([^"]*\)".*/\1/p' "$session")
  [ -n "$port" ] || return 1
  curl -s -f -m 2 -u "$user:$pass" -H 'Content-Type: application/json' -d '{}' \
    "http://127.0.0.1:$port/core/version" >/dev/null 2>&1
}

if alive; then open_page; exit 0; fi

if ! command -v rclone >/dev/null 2>&1; then
  echo "Decant needs rclone, and it is not installed."
  echo "See https://rclone.org/install/ then connect your cloud once with: rclone config"
  exit 1
fi

mkdir -p "$logs"
pass=$(head -c 24 /dev/urandom | base64 | tr -d '+/=\n')

for port in $(seq 5573 5599); do
  # The password goes in through the environment, not the command line,
  # where other programs could read it from the process list.
  RCLONE_RC_USER=decant RCLONE_RC_PASS="$pass" nohup rclone rcd \
    --rc-addr "127.0.0.1:$port" \
    --rc-allow-origin null \
    --rc-job-expire-duration 24h \
    --log-file "$logs/rclone.log" --log-level INFO >/dev/null 2>&1 &
  pid=$!
  {
    echo '// Written by the launcher. Holds the password to the local server for this'
    echo '// run only: it is replaced on every launch and is never committed.'
    echo "window.DECANT_SESSION = {\"port\":$port,\"user\":\"decant\",\"pass\":\"$pass\"};"
  } > "$session"
  i=0
  while [ $i -lt 40 ]; do
    if alive; then open_page; exit 0; fi
    kill -0 "$pid" 2>/dev/null || break   # exited: most likely the port was taken
    sleep 0.25; i=$((i + 1))
  done
  kill "$pid" 2>/dev/null || true
done

echo "rclone did not start. The end of its log:"
tail -n 15 "$logs/rclone.log" 2>/dev/null || true
exit 1
