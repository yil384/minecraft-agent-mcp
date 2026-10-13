#!/bin/sh
# docker/camera-entry.sh - the camera container's start: the Minecraft client is installed from Mojang on the first
# start (into /opt/mc, which is ./data/minecraft-client on your machine), only after you accepted the Minecraft EULA,
# and only when the camera account is signed in; then the camera service. What it is waiting for goes into
# $LOG_DIR/camera-status.json (./data/logs), so the agent, the watch page and ./setup.sh --status can say why the camera
# does not answer (not signed in, the EULA, the first download) instead of guessing.
set -eu
status() { printf '{"state":"%s","at":"%s"}\n' "$1" "$(date -u +%Y-%m-%dT%H:%M:%SZ)" > "${LOG_DIR:-/logs}/camera-status.json.tmp" 2>/dev/null \
  && mv "${LOG_DIR:-/logs}/camera-status.json.tmp" "${LOG_DIR:-/logs}/camera-status.json" 2>/dev/null || true; }
if [ "${MINECRAFT_EULA:-false}" != "true" ]; then
  status no-eula
  echo "The Minecraft EULA has not been accepted, so the camera does not install or start the Minecraft client." >&2
  echo "Read it at https://aka.ms/MinecraftEULA and, if you agree, set MINECRAFT_EULA=true in .env (./setup.sh asks)." >&2
  exit 64
fi
if ! node /app/scripts/camera-login.mjs --dir "${CAMERA_AUTH_DIR:-/auth}" --check >/dev/null 2>&1; then
  status not-signed-in
  echo "The camera account is not signed in: run ./setup.sh --camera-login (or: docker compose run --rm camera node scripts/camera-login.mjs --dir /auth)." >&2
  echo "Waiting 60 s before the next try." >&2
  sleep 60
  exit 1
fi
status installing
if ! node /app/docker/camera/install-client.mjs /opt/mc 1.21.4 /app/docker/camera/mods.json; then
  status failed
  exit 1
fi
status running
exec node /app/scripts/stream.mjs --serve --port "${STREAM_SERVICE_PORT:-7862}"
