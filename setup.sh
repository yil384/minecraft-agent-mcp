#!/bin/sh
# setup.sh - one command to run minecraft-agent-mcp on this machine with Docker Compose: checks what is needed, writes
# .env (keys generated here), asks you to accept the Minecraft EULA yourself, asks which live view you want, builds the
# images locally (Paper, Bun and every client download are pinned by hash), signs in the camera's Minecraft account and
# your Facebook app when the mode needs them, starts everything, runs a scripted test game over MCP and prints the MCP
# URL (and the watch page). Safe to run again: every step checks what is already done.
#
#   ./setup.sh                                   ask what is needed
#   ./setup.sh --mode local --accept-eula        no questions where the answer is given
#   ./setup.sh --tunnel                          also a Cloudflare quick tunnel (a public https URL, no account)
#   ./setup.sh --status                          print the URLs again (and whether the camera is signed in)
#   ./setup.sh --camera-login                    sign the camera's Minecraft account in (again)
#   ./setup.sh --facebook                        write the Facebook token (again)
#   ./setup.sh --stop                            stop everything (the camera and the tunnel too); the world stays
#
# Options: --mode off|local|facebook, --accept-eula, --tunnel, --no-tunnel, --port N (the host port, default 8787),
# --name NAME (the Compose project: a second copy on one machine needs its own name and port), --no-check (skip the
# test game), --no-build, -y/--yes (take the defaults instead of asking).
set -eu

cd "$(dirname "$0")"
ENV_FILE=.env

say() { printf '%s\n' "$*"; }
warn() { printf 'note: %s\n' "$*" >&2; }
die() { printf 'setup: %s\n' "$*" >&2; exit 1; }

MODE="" ACCEPT=0 TUNNEL="" CHECK=1 BUILD=1 YES=0 ACTION=setup PORT="" NAME=""
while [ $# -gt 0 ]; do
  case "$1" in
    --mode) [ $# -ge 2 ] || die "--mode needs off, local or facebook"; MODE=$2; shift ;;
    --mode=*) MODE=${1#--mode=} ;;
    --accept-eula) ACCEPT=1 ;;
    --tunnel) TUNNEL=on ;;
    --no-tunnel) TUNNEL=off ;;
    --no-check) CHECK=0 ;;
    --no-build) BUILD=0 ;;
    -y|--yes) YES=1 ;;
    --status) ACTION=status ;;
    --camera-login) ACTION=camera-login ;;
    --facebook) ACTION=facebook ;;
    --port) [ $# -ge 2 ] || die "--port needs a port number"; PORT=$2; shift ;;
    --port=*) PORT=${1#--port=} ;;
    --name) [ $# -ge 2 ] || die "--name needs a project name"; NAME=$2; shift ;;
    --name=*) NAME=${1#--name=} ;;
    --stop) ACTION=stop ;;
    -h|--help) sed -n '2,20p' "$0" | sed 's/^# \{0,1\}//'; exit 0 ;;
    *) die "unknown option $1 (--help)" ;;
  esac
  shift
done
case "$MODE" in ""|off|local|facebook) ;; *) die "--mode must be off, local or facebook" ;; esac
case "$PORT" in "") ;; *[!0-9]*) die "--port must be a number from 1 to 65535" ;; *) [ "$PORT" -ge 1 ] && [ "$PORT" -le 65535 ] || die "--port must be a number from 1 to 65535" ;; esac
case "$NAME" in "") ;; *[!a-z0-9_-]*|[!a-z0-9]*) die "--name must be lower-case letters, digits, - or _, starting with a letter or digit" ;; esac

# ----- small helpers

# KEY's value in .env (empty when unset)
get_env() { [ -f "$ENV_FILE" ] && sed -n "s/^$1=//p" "$ENV_FILE" | tail -n 1 || true; }
# set KEY=VALUE in .env (replaced in place, else appended); values are plain words here
set_env() {
  if grep -q "^$1=" "$ENV_FILE" 2>/dev/null; then
    tmp="$ENV_FILE.tmp.$$"
    awk -v k="$1" -v v="$2" 'BEGIN { FS = OFS = "=" } $1 == k { print k "=" v; next } { print }' "$ENV_FILE" > "$tmp" && mv "$tmp" "$ENV_FILE"
  else
    printf '%s=%s\n' "$1" "$2" >> "$ENV_FILE"
  fi
}
random_hex() {
  if command -v openssl >/dev/null 2>&1; then openssl rand -hex "$1"
  else od -An -N"$1" -tx1 /dev/urandom | tr -d ' \n'; fi
}
ask() { # ask "question" default -> the answer (the default with --yes or without a terminal)
  if [ "$YES" = 1 ] || [ ! -t 0 ]; then printf '%s' "$2"; return; fi
  printf '%s [%s] ' "$1" "$2" >&2
  read -r a || a=""
  printf '%s' "${a:-$2}"
}
compose() { docker compose "$@"; }
# the host this machine reaches the published port on: WEB_BIND, or 127.0.0.1 when it is every address
url_host() {
  b=$(get_env WEB_BIND); b=${b:-127.0.0.1}
  case "$b" in 0.0.0.0|::|"[::]") b=127.0.0.1 ;; esac
  case "$b" in *:*) printf '[%s]' "$b" ;; *) printf '%s' "$b" ;; esac
}
# the camera's own word on itself (docker/camera-entry.sh writes it), in a line, or nothing
camera_state() {
  f=data/logs/camera-status.json
  [ -f "$f" ] || return 0
  st=$(sed -n 's/.*"state" *: *"\([a-z-]*\)".*/\1/p' "$f" | head -n 1)
  case "$st" in
    not-signed-in) say "Camera: NOT SIGNED IN: run ./setup.sh --camera-login" ;;
    no-eula) say "Camera: waiting for the Minecraft EULA (MINECRAFT_EULA=true in .env)" ;;
    installing) say "Camera: downloading the Minecraft client (the first start takes a few minutes)" ;;
    running) say "Camera: signed in and running" ;;
    failed) say "Camera: could not start (docker compose logs camera)" ;;
  esac
}
# the services of the profiles that are off now: stopped and removed (switching to --mode off stops the camera)
drop_unused() {
  case ",$1," in *,camera,*) ;; *) compose --profile camera rm -s -f camera >/dev/null 2>&1 || true ;; esac
  case ",$1," in *,tunnel,*) ;; *) compose --profile tunnel rm -s -f tunnel >/dev/null 2>&1 || true ;; esac
}
http_ok() { # http_ok URL -> 0 when it answers 200
  if command -v curl >/dev/null 2>&1; then curl -fsS -o /dev/null --max-time 5 "$1" 2>/dev/null
  else wget -q -O /dev/null -T 5 "$1" 2>/dev/null; fi
}

# ----- what this prints at the end, and for --status

print_urls() {
  key=$(get_env MCP_ACCESS_KEY)
  watch=$(get_env WATCH_KEY)
  port=$(get_env WEB_PORT); port=${port:-8787}
  mode=$(get_env LIVE_VIEW); mode=${mode:-off}
  host=$(url_host)
  local_url="http://$host:$port/mcp/$key"
  public=""
  if compose ps --status running --services 2>/dev/null | grep -qx tunnel; then
    i=0
    while [ $i -lt 20 ] && [ -z "$public" ]; do
      public=$(compose exec -T agent node -e "fetch('http://127.0.0.1:20241/quicktunnel').then((r) => r.json()).then((j) => console.log(j.hostname || '')).catch(() => {})" 2>/dev/null | tr -d '\r\n' || true)
      [ -n "$public" ] || { i=$((i + 1)); sleep 2; }
    done
  fi
  say ""
  say "================================================================================================"
  say "MCP URL on this machine:  $local_url"
  if [ -n "$public" ]; then
    say "MCP URL through the tunnel: https://$public/mcp/$key"
    say "  (a Cloudflare quick tunnel: the address changes whenever the tunnel restarts)"
  fi
  if [ "$mode" = local ]; then
    say "Watch page (whatever the camera films): http://$host:$port/live/$watch/"
    say "  (it only lets people watch, never play; each game's own watch link comes from its live_view call)"
  elif [ "$mode" = facebook ]; then
    say "Live view: your Facebook live, started when a client calls live_view (docs/CONFIG.md, Facebook)"
  fi
  say "Treat the MCP URLs like passwords: anyone who has one can play on your server."
  [ "$mode" = off ] || camera_state
  say ""
  say "Connect a client (README.md, \"Connect a client\", has the steps for each one):"
  say "  a client that takes an MCP URL (streamable HTTP): the URL above"
  say "  a client that only starts local (stdio) servers: node scripts/stdio-bridge.mjs $local_url"
  if [ -n "$public" ]; then
    say "  a client that runs in the cloud: the tunnel URL above"
  else
    say "  a client that runs in the cloud needs a public https URL: ./setup.sh --tunnel"
  fi
  say "Then tell your agent: Play Minecraft with the minecraft tools and get to the Nether and back."
  say "================================================================================================"
}

# ----- checks

command -v docker >/dev/null 2>&1 || die "Docker is needed (https://docs.docker.com/get-docker/)"
docker compose version >/dev/null 2>&1 || die "Docker Compose v2 is needed (docker compose version)"

if [ "$ACTION" = status ]; then
  [ -f "$ENV_FILE" ] || die "no .env yet: run ./setup.sh"
  compose ps
  print_urls
  exit 0
fi
if [ "$ACTION" = stop ]; then
  [ -f "$ENV_FILE" ] || die "no .env yet: nothing to stop"
  compose --profile camera --profile tunnel down
  say "stopped; the world and the accounts stay in ./data (./setup.sh starts it again)"
  exit 0
fi

# ----- .env, the keys, the folders

if [ ! -f "$ENV_FILE" ]; then
  cp .env.example "$ENV_FILE"
  say "wrote $ENV_FILE from .env.example"
fi
chmod 600 "$ENV_FILE"
[ -n "$(get_env MCP_ACCESS_KEY)" ] || set_env MCP_ACCESS_KEY "$(random_hex 16)"
[ -n "$(get_env WEB_ADMIN_TOKEN)" ] || set_env WEB_ADMIN_TOKEN "$(random_hex 24)"
[ -n "$(get_env INSTALL_ID)" ] || set_env INSTALL_ID "$(random_hex 6)"
[ -n "$(get_env WATCH_KEY)" ] || set_env WATCH_KEY "$(random_hex 16)"
[ -n "$(get_env STREAM_SERVICE_TOKEN)" ] || set_env STREAM_SERVICE_TOKEN "$(random_hex 24)"
[ -z "$PORT" ] || set_env WEB_PORT "$PORT"
[ -z "$NAME" ] || set_env COMPOSE_PROJECT_NAME "$NAME"
set_env RUN_UID "$(id -u)"
set_env RUN_GID "$(id -g)"
umask 077
mkdir -p data/world data/logs data/mineai data/camera-auth data/minecraft-client data/recordings secrets
chmod 700 data/mineai data/camera-auth secrets
umask 022

# ----- the Minecraft EULA: yours to accept, never ours

if [ "$(get_env MINECRAFT_EULA)" != true ]; then
  say ""
  say "This server runs Minecraft: Java Edition software from Mojang (the server, and for a live view the client),"
  say "which you may only use under the Minecraft End User License Agreement: https://aka.ms/MinecraftEULA"
  if [ "$ACCEPT" = 1 ]; then
    say "--accept-eula: you have read and accept it."
  else
    [ -t 0 ] || die "the Minecraft EULA must be accepted: read it, then run ./setup.sh --accept-eula (or answer on a terminal)"
    printf 'Type yes if you have read and accept the Minecraft EULA: ' >&2
    read -r answer || answer=""
    [ "$answer" = yes ] || die "not accepted: nothing from Mojang is downloaded and nothing starts"
  fi
  set_env MINECRAFT_EULA true
fi

# ----- the live view

if [ -z "$MODE" ]; then
  current=$(get_env LIVE_VIEW)
  if [ "$ACTION" = setup ]; then
    say ""
    say "Live view: off (play only) | local (a watch page in your browser; needs your Minecraft: Java account and an"
    say "x86-64 machine with about 4 free cores) | facebook (your own Facebook live; also needs your own Meta app)"
    MODE=$(ask "Which live view?" "${current:-off}")
  else
    MODE=${current:-off}
  fi
fi
case "$MODE" in off|local|facebook) ;; *) die "the live view must be off, local or facebook (got $MODE)" ;; esac
if [ "$MODE" != off ]; then
  arch=$(uname -m)
  case "$arch" in x86_64|amd64) ;; *)
    die "the camera (LIVE_VIEW=$MODE) runs on x86-64 only (Mojang ships x86-64 Linux natives for 1.21.4); this machine is $arch. Use --mode off here."
  esac
fi
set_env LIVE_VIEW "$MODE"
if [ -z "$TUNNEL" ]; then
  case ",$(get_env COMPOSE_PROFILES)," in *,tunnel,*) TUNNEL=on ;; *) TUNNEL=off ;; esac
fi
profiles=""
[ "$MODE" = off ] || profiles="camera"
if [ "$TUNNEL" = on ]; then
  profiles="${profiles:+$profiles,}tunnel"
  # the tunnel's connections come from 127.0.0.1 (it shares the stack's network namespace): its forwarded headers are
  # believed from there only (setup's own setting, undone by --no-tunnel; one you set yourself stays)
  if [ "$(get_env WEB_TRUST_PROXY)" = off ] || [ -z "$(get_env WEB_TRUST_PROXY)" ]; then
    set_env WEB_TRUST_PROXY cloudflare
    set_env WEB_TRUSTED_PROXIES 127.0.0.1
    set_env SETUP_TUNNEL_TRUST 1
  fi
elif [ "$(get_env SETUP_TUNNEL_TRUST)" = 1 ]; then
  set_env WEB_TRUST_PROXY off
  set_env WEB_TRUSTED_PROXIES ""
  set_env SETUP_TUNNEL_TRUST ""
fi
set_env COMPOSE_PROFILES "$profiles"
export COMPOSE_PROFILES="$profiles"

# disk and memory: warnings only
free_kb=$(df -Pk . | awk 'NR == 2 { print $4 }')
[ "${free_kb:-0}" -ge 10000000 ] || warn "less than 10 GB free here: the images take about 3 GB and the world grows"

# ----- build

if [ "$BUILD" = 1 ] && [ "$ACTION" = setup ]; then
  say ""
  say "Building the images (the first time takes 5-10 minutes: Paper, Bun and the Mine AI runtime are downloaded,"
  say "checked against their pinned hashes, and the runtime's own tests run)..."
  compose build
fi

# ----- accounts

camera_login() {
  say ""
  say "The camera plays Minecraft as your own Minecraft: Java Edition account. You sign in on Microsoft's page; the"
  say "tokens stay in ./data/camera-auth on this machine (mode 700). Never type your password anywhere else."
  compose up -d paper agent >/dev/null
  if compose run --rm --no-deps camera node scripts/camera-login.mjs --dir /auth --check >/dev/null 2>&1; then
    say "The camera account is signed in already."
    [ "$ACTION" = camera-login ] || return 0
  fi
  if ! compose run --rm --no-deps camera node scripts/camera-login.mjs --dir /auth ${FORCE_LOGIN:+--force}; then
    say ""
    say "If Microsoft refused the device code ('first party application ... not permitted to consent'), use your own"
    say "Azure app: put its client id into CAMERA_MSA_CLIENT_ID in .env (README, Troubleshooting), then run"
    say "./setup.sh --camera-login. Then run ./setup.sh again: it starts the camera, runs the check and prints the URLs."
    die "the camera account is not signed in"
  fi
}

facebook_token() {
  say ""
  say "Facebook: the camera goes live on your own profile (FB_TARGET=me) or a Page of yours, through your own Meta app."
  say "Before this step (docs/CONFIG.md, Facebook, has the details):"
  say "  1. a Meta developer app of your own (developers.facebook.com), with you as its admin, in Live mode"
  say "  2. Facebook settings, Business integrations, the app: 'Who can see you use it' set to Public"
  say "  3. a short-lived user token from the Graph API Explorer for that app, with publish_video"
  say "     (for a Page also pages_show_list, pages_read_engagement, pages_manage_posts)"
  say "  4. a Page goes live through the API only once it is at least 60 days old: until then use your profile"
  target=$(get_env FB_TARGET); target=${target:-me}
  target=$(ask "Live on your profile (me) or a Page (page)?" "$target")
  case "$target" in me|page) ;; *) die "me or page" ;; esac
  set_env FB_TARGET "$target"
  [ -t 0 ] || die "the Facebook step needs a terminal (it asks for the App Secret and a token without echoing them)"
  printf 'Your Meta App ID (digits): ' >&2
  read -r app_id || app_id=""
  case "$app_id" in *[!0-9]*|"") die "the App ID is digits only" ;; esac
  extra="--user"
  if [ "$target" = page ]; then
    page=$(ask "The Page's numeric id (Page settings, About, Page transparency)" "$(get_env FB_PAGE_ID)")
    case "$page" in *[!0-9]*|"") die "the Page id is digits only" ;; esac
    extra="--page $page"
  fi
  compose up -d paper agent >/dev/null
  # the App Secret and the token are typed into the script (no echo), never on a command line
  # shellcheck disable=SC2086
  compose run --rm --no-deps -v "$(pwd)/secrets:/secrets-rw" camera node scripts/fb-token.mjs --app-id "$app_id" --dir /secrets-rw --name fb-token $extra \
    || die "no Facebook token written"
  chmod 600 secrets/fb-token
  if [ "$target" = page ]; then set_env FB_PAGE_ID "$page"; fi
  if [ "$target" = me ]; then say "A user token lasts about 60 days: run ./setup.sh --facebook again before it runs out."; fi
}

case "$ACTION" in
  camera-login) FORCE_LOGIN=1 camera_login; compose up -d; say "Then ./setup.sh --status prints the URLs."; exit 0 ;;
  facebook) facebook_token; compose up -d; exit 0 ;;
esac

if [ "$MODE" != off ]; then camera_login; fi
if [ "$MODE" = facebook ] && [ ! -s secrets/fb-token ]; then facebook_token; fi

# ----- start, wait, check

say ""
say "Starting..."
drop_unused "$profiles"
compose up -d
port=$(get_env WEB_PORT); port=${port:-8787}
host=$(url_host)
i=0
until http_ok "http://$host:$port/"; do
  i=$((i + 1))
  [ $i -lt 90 ] || { compose logs --tail 40 agent paper >&2 || true; die "the server did not answer on http://$host:$port/ within 3 minutes (README, Troubleshooting)"; }
  sleep 2
done
say "The server answers on http://$host:$port/"
if [ "$CHECK" = 1 ]; then
  say ""
  say "A scripted test game over MCP (no model: a wooden pickaxe from an empty inventory)..."
  if ! compose exec -T agent node scripts/self-check.mjs http://127.0.0.1:8787 --minutes 8; then
    warn "the test game failed (above); the server runs anyway. Logs: docker compose logs agent paper"
  fi
fi
print_urls
