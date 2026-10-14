# Configuration

Every setting is an environment variable. With Docker Compose they live in `.env` (`./setup.sh` writes it from
`.env.example`); after a change, `docker compose up -d` applies it. The agent checks every setting at start and refuses
to start with a list of every problem at once. Secrets (the access key, the watch key, the admin token, the proxy
secret, the camera service's token, stream URLs) are never printed or logged.

- [Required](#required)
- [The server and MCP](#the-server-and-mcp)
- [Sharing the server](#sharing-the-server)
- [Games and bots](#games-and-bots)
- [The world](#the-world)
- [The live view and the camera](#the-live-view-and-the-camera)
- [Facebook](#facebook)
- [Recordings](#recordings)
- [Behind a reverse proxy](#behind-a-reverse-proxy)
- [A GPU for the camera](#a-gpu-for-the-camera)
- [Advanced](#advanced)
- [Running without Docker](#running-without-docker)

## Required

| Variable | Default | What |
| --- | --- | --- |
| `MINECRAFT_EULA` | `false` | `true` once you have read and accepted the [Minecraft EULA](https://aka.ms/MinecraftEULA). Until then Paper does not start and the camera downloads nothing (the agent itself starts, but has no server to play on) |
| `LIVE_VIEW` | `off` | `off` (play only), `local` (a watch page served by this server), `facebook` (your own Facebook live). `local` and `facebook` start the camera container (`COMPOSE_PROFILES=camera`) |
| `MCP_ACCESS_KEY` | (empty) | 16-128 letters, digits, `_` or `-`. The MCP endpoint is `/mcp/<key>` (or `/mcp` with `Authorization: Bearer <key>`). Required whenever the agent listens on anything but loopback, which it does in Docker. `setup.sh` generates it (`openssl rand -hex 16`) |
| `WATCH_KEY` | (empty: derived from `MCP_ACCESS_KEY`) | 16-128 letters, digits, `_` or `-`, different from the access key. The camera's watch page is `/live/<WATCH_KEY>/` (`LIVE_VIEW=local`): it only lets people watch, never play. `setup.sh` generates it |
| `WEB_ADMIN_TOKEN` | (empty) | at least 24 characters; enables the operator's routes, each with `Authorization: Bearer <token>`: `GET /log` (the log's last rows), `GET /admin/games`, `POST /admin/end`, `/admin/ban`, `/admin/unban`, `/admin/public` and `/admin/stop` (README, "Hosting a public server"). Five wrong tokens from one address lock it out for an hour |

## The server and MCP

| Variable | Default | What |
| --- | --- | --- |
| `SERVER_NAME` | `Agent game server` | the page title, the Minecraft server's MOTD, the start of a Facebook live's title |
| `SITE_OPERATOR` | (empty) | who runs the server, in the pages' footer ("Run by ...") and the privacy text |
| `WEB_PORT` | `8787` | the host port of the agent (Compose publishes it on `WEB_BIND`; `./setup.sh --port`) |
| `WEB_BIND` | `127.0.0.1` | the host address the port is published on. Keep `127.0.0.1` and use an SSH tunnel, a tunnel service or a reverse proxy on this machine; a LAN address of this machine publishes it to that network (README, "Server on another machine") |
| `WEB_PUBLIC_URL` | (empty) | your stable public https URL; links in replies use it, and the server answers to its host name. Empty: links follow the host each request came in on (through a trusted proxy, its forwarded host) |
| `WEB_ALLOWED_HOSTS` | (empty) | more host names the server answers to, comma-separated (`.example.org` allows its subdomains). Without them it answers only to `localhost`/`127.0.0.1`, IP addresses, `WEB_PUBLIC_URL`'s host and the quick tunnels' names (`*.trycloudflare.com`, `*.ts.net`, ngrok's); any other name gets `421`, so a web page elsewhere cannot reach the server by pointing its own name at your machine (DNS rebinding). Without `MCP_ACCESS_KEY` only `localhost` and loopback addresses count |
| `WEB_TRUST_PROXY` | `off` | where a request's address comes from, for the per-address limits: `off` (the socket), `cloudflare` (`CF-Connecting-IP`; the tunnel profile), or `1`-`5` (that many proxies that append to `X-Forwarded-For`) |
| `WEB_TRUSTED_PROXIES` | (empty) | the proxy's own addresses or CIDR ranges: forwarded headers count only on its connections, and any other peer that is not this machine is refused. `./setup.sh --tunnel` sets `127.0.0.1` (the tunnel shares the stack's network namespace) and `--no-tunnel` takes it away again |
| `WEB_LOCAL_PEERS` | `gateway` in Docker | peers that count as this machine besides loopback: addresses, ranges, or `gateway` (the container's default gateway, which every connection through Docker's published port comes from). They are never refused as "not the proxy" |
| `WEB_LOCAL_URL` | the published port, in Docker | this server's URL on this machine, for links when a request does not say (compose.yaml sets `http://<WEB_BIND>:<WEB_PORT>`) |
| `WEB_GUEST_PAGES` | `off` | the zero-JS pages that start bots without MCP (`/session`, `/play/<token>`, `/api/...`, `/openapi.json`). Anyone who reaches the port can start bots there |
| `MCP_SESSIONS`, `MCP_SESSIONS_PER_ADDRESS` | `200`, `20` | MCP sessions held at once, in all and per address (the oldest idle one is evicted first) |
| `MCP_TEST_LIVE` | `false` | this project's own check scripts (MCP client names `self-check`, `*-smoke`, `e2e-*`, exactly these patterns) get no Facebook live from `live_view` unless this is on; their games go last in line for the camera |
| `MCP_TEST_RECORD` | `false` | with `RECORD` on in the camera: a check script's `live_view` has the camera film its game for the recording only, never on Facebook (how a recording is tested without spending a live video) |
| `OPEN_SOURCE_URL` | this repository | linked from the page a browser gets at the MCP URL; empty: no link. An https URL |
| `COMPOSE_PROJECT_NAME` | `mcagent` | the Compose project's name (`./setup.sh --name`): a second copy on one machine needs its own name and its own `WEB_PORT` |

## Sharing the server

For a server other people's agents play on (README, "Hosting a public server"). The defaults suit one person.

| Variable | Default | What |
| --- | --- | --- |
| `MCP_OWNER_KEY` | (empty) | your own key: 16 or more letters, digits, `_` or `-`, different from `MCP_ACCESS_KEY` (`openssl rand -hex 16`). An MCP connection that brings it (`?owner=<key>` on the MCP URL, or the header `X-Owner-Key`) is first in line for the camera and for a bot, plays while `PUBLIC_PLAY` is off, may use `say`, and is held to none of the per-address limits or bans. Never logged |
| `PUBLIC_PLAY` | `true` | `false`: `start_game` answers `CLOSED` to every connection but the owner's; games already running go on. `POST /admin/public` with `{"on": false}` or `{"on": true}` switches it at once (until the next restart) |
| `PUBLIC_CHAT` | `true` | `false`: `say` (in-game chat) only for the owner's key; others get `NOT_ALLOWED` and are told that their `why` and `plan` reach viewers |
| `WEB_MCP_STARTS_PER_HOUR` | `10` | new games one address may start in an hour (`RATE_LIMITED` with `retryAfterS` beyond it) |
| `WEB_MCP_REQUESTS_PER_MINUTE` | `120` | requests one MCP session may send in a minute |
| `WEB_BANNED_IPS` | (empty) | address hashes that may not play, comma-separated (the 12-character hashes `GET /admin/games` shows). `POST /admin/ban` and `/admin/unban` add and lift bans at run time; those are kept in the bot data folder (`bans.json`) |
| `WEB_IP_SALT` | (derived from `WEB_ADMIN_TOKEN`, else random at each start) | the key of the address hashes in the log, the admin routes and the bans. Set it to keep hashes (and bans) stable when you change the admin token |

The word filter (`src/moderation.js`, LDNOOBW's English list, CC BY 4.0) is always on: every string in every MCP call,
and the client's name, is cleaned before anything keeps or shows it.

## Games and bots

| Variable | Default | What |
| --- | --- | --- |
| `MAX_GAMES` | `2` | bots at once; when all are in use, `start_game` answers with a place in the queue and an estimate. Each bot is a process of 0.3-1 GB |
| `WEB_MCP_GAMES_PER_ADDRESS` | `MAX_GAMES` (at least 2) | MCP games one address may hold. Behind a cloud client many people can share one address |
| `GAME_LEASE_MIN` | `60` | a game ends after this many minutes (1-1440) |
| `GAME_IDLE_MIN` | `10` | ...or after this many minutes without an MCP call while nothing runs (unless someone watches a 3D view) |
| `BOT_CARE` | `advise` | what the body does by itself between calls: `advise` (the agent decides everything: the body acts on its own only by the rules the agent sets, `defend`, `flee`, `escape` and `eat_below`, all off at the start of every game, and gives "Body advice" in every reply), `full` (it also shelters at night, eats and hunts when hungry, wears and crafts armor, crafts a spare tool, goes back for its items after a death), `off` (only the runtime's reflexes, as they come). `MINEAI_CARE` is an older name for it |
| `MC_USERNAME` | `Bot` | the start of each bot's player name (with `MC_WHITELIST`, the rest is random: nobody can guess a bot's name) |

## The world

Paper 1.21.4, offline mode, reachable only from inside the stack. Set in `.env`, passed by `compose.yaml`.

| Variable | Default | What |
| --- | --- | --- |
| `PAPER_SEED` | (empty: random) | the world seed (only for a new world: delete `./data/world` to start over) |
| `PAPER_DIFFICULTY` | `normal` | `peaceful`, `easy`, `normal`, `hard` |
| `PAPER_DAYLIGHT` | `cycle` | `cycle`, or `locked` (always morning) |
| `PAPER_NETHER` | `true` | `false`: no portal leads to the Nether |
| `PAPER_BORDER` | `20000` | the Overworld's world border as a width in blocks (the Nether's is an eighth), so the world on disk stays bounded |
| `PAPER_MEMORY` | `3G` | the server's Java heap |
| `PAPER_BSTATS` | `false` | bStats (bundled with Paper) sends anonymous server statistics to bstats.org when `true` |

Each new bot is spread to a random dry spot up to `SPREAD_RANGE` (400) blocks from the world spawn, so earlier games
never leave a new bot at a stripped spawn.

## The live view and the camera

`LIVE_VIEW=local` or `facebook` runs the camera: a Minecraft: Java Edition client signed in with your account
(`./setup.sh --camera-login`; tokens in `./data/camera-auth`), downloaded from Mojang at its first start into
`./data/minecraft-client`. It joins the server as a spectator, rides along with one game's bot and is filmed by ffmpeg
with the HUD. A game is filmed only after its `live_view` asks. The camera is **first come, first served**: it stays on
a game until that game ends, or until it has made no call for 5 minutes while others wait; then it goes to the next
game in line (the games that asked, in the order they first asked; the owner's games first, the check scripts' last).
A game in line runs normally, and `live_view` says its place and about how long. With a live view on, `play` and
`play_sequence` answer `NEED_LIVE_VIEW` until the game has called `live_view` (`start_game` with `live: false` for a
user who does not want to watch). When no game that asked is left, the camera stops filming (and after
`CAMERA_IDLE_MS` without a game its client quits until the next).

| Variable | Default | What |
| --- | --- | --- |
| `CAMERA_GL` | `cpu` | `cpu` (Mesa llvmpipe, about 4 cores while it films) or `gpu` ([below](#a-gpu-for-the-camera)) |
| `CAMERA_MSA_CLIENT_ID` | (empty) | your own Azure app's client id (a GUID) for the camera account's sign-in, through Microsoft's device code (MSAL). The app must be a public client with personal Microsoft accounts and be allowed for the Minecraft services API. Empty: prismarine-auth's default device-code sign-in (as mineflayer signs Java accounts in) |
| `CAMERA_VIEW` | `third` | `third` (over the bot's shoulder: its arm, its tool and its swing in view) or `first` (in its head) |
| `CAMERA_MODS` | `sodium` | client mods, comma-separated: `sodium` (about 3x the frames on the CPU), `immediatelyfast`, `ferritecore`; `none` runs the vanilla client. Sodium is licensed under the [PolyForm Shield License 1.0.0](https://polyformproject.org/licenses/shield/1.0.0): source-available, not open source. It is downloaded unmodified, only when named here |
| `STREAM_LAYOUT` | `ui` | `ui` (square: the game on top, the HUD under it), `terminal` (vertical: the game over a terminal of the calls), `landscape` (the game alone at 1280x720) |
| `STREAM_HUD` | `b` | the `ui` layout's HUD: `b` (a speedrun broadcast: toasts with the agent's why, floaters, banners and the agent's rules over the game; health, who acted, the command, the goal's splits, the events and the raw calls under it) or `final` (the earlier design) |
| `STREAM_LOGO` | `off` | a logo at the top right of the video (HUD `b`) and on the live page's poster: `plain` (a transparent light logo drawn as it is, with a hard shadow) or `card` (a light logo on a white card) |
| `STREAM_LOGO_FILE` | (the project's pixel logo) | your logo, a PNG: a path under `assets/` (for example `brand/mine.png`: put it in `assets/brand` before you build, so both the agent and the camera have it), a name in `assets/ui`, or an absolute path inside the containers. The default, `assets/brand/picasso-lab-pixel-230.png`, is not under the Apache licence (NOTICE): use your own on your server |
| `STREAM_UI_SIZE` | `1080x1080` | also `1080x1200`, `1080x1350` |
| `STREAM_BITRATE_K` | `3500` | the video's bitrate (500-8000 kbit/s); a watcher through a tunnel needs about that much bandwidth |
| `STREAM_FPS` | `30` | 10-30 |
| `STREAM_MUSIC` | `true` | a soft CC0 music bed under the game's own sound (`assets/ui/music`), ducked while the game is loud. The game's music and records are never in the stream |
| `STREAM_GAME_AUDIO` | `true` | the game's sound effects and ambience |
| `CAMERA_CPUS`, `CAMERA_MEM` | `6`, `3g` | the camera container's limits |
| `CAMERA_RENDER_DISTANCE` | `5` | chunks; more costs CPU |
| `CAMERA_SCALE` | `0.75` | the client draws at 1280x720 times this; ffmpeg scales up |
| `CAMERA_IDLE_MS` | `600000` | the client quits after this long without a game |

The local watch page: `live_view` returns `<host>/live/<view id>/` (128 random bits, a different id from the game's).
The page plays HLS (2 s segments, six kept) with the browser's own player (Safari) or hls.js (served by this server,
no third-party request); it is about 5-8 s behind the game. A game's page plays only while the camera films that game,
and only the segments filmed since the camera came to it (never another game's picture); it says in words what the
camera does otherwise. `<host>/live/<WATCH_KEY>/` always shows whatever the camera films.

The agent and the camera service share `STREAM_SERVICE_TOKEN` (at least 24 characters; `setup.sh` writes it): the
camera's control API on `127.0.0.1:7862`, which can start a Facebook live, answers no request without it. The camera
container does not get the MCP access key, the watch key, the admin token or the proxy secret.

## Facebook

`LIVE_VIEW=facebook`. The setup steps are in [README.md](../README.md#live-view-facebook-your-own-facebook-live);
`./setup.sh --facebook` writes the token to `./secrets/fb-token` (mode 600, read only by the camera, never put in an
environment variable, a command line, a URL or a log).

| Variable | Default | What |
| --- | --- | --- |
| `FB_TARGET` | `me` | `me` (your profile, with a long-lived user token: about 60 days, then `./setup.sh --facebook` again) or `page` (a Page, with a Page token that does not expire; the Page must be at least 60 days old to go live through the API) |
| `FB_PAGE_ID` | (empty) | the Page's numeric id (`FB_TARGET=page`) |
| `FB_PRIVACY` | `EVERYONE` | a profile's live videos: `EVERYONE` (the embedded player plays only public videos), `ALL_FRIENDS`, `SELF` |
| `FB_MAX_PER_HOUR`, `FB_MAX_PER_DAY` | `4`, `12` | live videos started at most in any hour and any 24 hours, counted across restarts. Facebook may lock an account that starts many automated public live videos in a short time ("API access blocked", an identity check); keep these low. When a cap holds, `live_view` says until when, and the game goes on |
| `FB_DELETE_AFTER` | `true` for `me` | delete each live video (with its recording) `FB_DELETE_DELAY_S` (600) seconds after its game, so your timeline stays clean |
| `FB_TITLE` | `<SERVER_NAME>: an AI agent plays Minecraft` | the live video's title (" (game <id>)" is added) |
| `FB_DESCRIPTION` | (a neutral text) | the live video's description. The not-affiliated sentence and this install's marker are always added |
| `INSTALL_ID` | (random, from setup) | marks this install's live videos; at start the camera ends (and on a profile deletes) only live videos that carry this install's marker and were left open by a crash, never anything else on the account |
| `FB_GRAPH_VERSION` | `v23.0` | the Graph API version |

Each game the camera films gets a live video of its own, titled with the game: when the game ends (or the camera
moves on to the next game in line) its live video ends, and the next game's starts. While a cap holds or Facebook
refuses (a backoff), the game is still filmed for the recording when `RECORD` is on, and `live_view` says until when.
The page `live_view` returns shows a poster at once, then Facebook's player; a game in line shows its place and swaps
the player in when the camera arrives; an ended game's page shows its end card (`/live/<view id>/end.svg`: the goal,
the time, deaths and who acted).

## Recordings

`RECORD=true` (in `.env`; the camera does the recording) keeps every game the camera films, for films made later: a
folder per game under `RECORD_DIR` (in Docker `./data/recordings`) with `clean-<n>.mp4` (the game alone with its sound,
no HUD, at the client's size, by a second ffmpeg below the stream's priority), `stream-<n>.mp4` (the stream as it went
out), `hud.jsonl` (every update the HUD got, with its time, and its whole state every 30 s, so the HUD can be drawn
again) and `meta.json`. Before each new folder, recordings older than `RECORD_KEEP_DAYS` go, then the oldest until
the total is under `RECORD_MAX_GB`.

| Variable | Default | What |
| --- | --- | --- |
| `RECORD` | `false` | keep the recordings |
| `RECORD_DIR` | `/recordings` in Docker | where |
| `RECORD_MAX_GB`, `RECORD_KEEP_DAYS` | `150`, `30` | the total size and the age kept |
| `RECORD_CRF`, `RECORD_PRESET`, `RECORD_NICE` | `18`, `veryfast`, `10` | the clean recording's quality, x264 preset and niceness |
| `CAMERA_FILM` | `false` | the client draws at 1920x1080 for the clean recording (the stream is scaled down as always); costs client frames on the CPU (`CAMERA_GL_THREADS` 16 and `CAMERA_CPUS` 24 suggested) |

## Behind a reverse proxy

Keep `WEB_BIND=127.0.0.1` and run the proxy on the same machine, pointing at `http://127.0.0.1:8787`. Set
`WEB_TRUST_PROXY=1` (one proxy that appends to `X-Forwarded-For`) and `WEB_PUBLIC_URL=https://your.host` (the server
answers to that name). Because connections through Docker's published port all come from the same gateway address,
give the proxy a shared secret that it adds to every request: `WEB_PROXY_SECRET` (at least 24 printable characters,
`openssl rand -hex 24`). Then forwarded headers count only on requests that carry it, any other request that is not
from this machine is refused, and the secret never reaches a watch page. Requests from this machine itself (your
browser on `127.0.0.1:8787`, `setup.sh`'s check; in Docker they come from the gateway, `WEB_LOCAL_PEERS`) are still
answered, without the proxy's forwarded headers. With Caddy:

```
your.host {
  reverse_proxy 127.0.0.1:8787 {
    header_up X-Proxy-Secret {env.WEB_PROXY_SECRET}
  }
}
```

`WEB_TRUSTED_PROXIES` (addresses or CIDR ranges) instead limits forwarded headers to connections from the proxy's own
address, when it has one of its own.

## A GPU for the camera

With an NVIDIA GPU, the NVIDIA Container Toolkit and a driver whose OpenGL has framebuffer objects (consumer GeForce
cards do; some data-centre GPUs do not), the camera draws on the GPU through VirtualGL and saves about 3-4 cores:

```sh
echo CAMERA_GL=gpu >> .env
CAMERA_GPU_BUILD=1 docker compose -f compose.yaml -f compose.gpu.yaml up -d --build
```

## Advanced

| Variable | Default | What |
| --- | --- | --- |
| `VIEW_3D` | `true` | the 3D browser views of each bot (`/eyes/<view id>/`, `/watch/<view id>/`), rendered in the viewer's browser. They need the optional `prismarine-viewer` npm package, which is not a dependency of this project because its textures are Mojang's: install it yourself (`npm install --no-save prismarine-viewer@1.33.0`) only if you accept that |
| `STREAM_RTMP_URL` | (empty) | instead of a channel: every game streamed to these RTMP(S) URLs (stream keys included; never logged), one per game at once |
| `STREAM_OUT_DIR` | (empty) | instead of a channel: every game recorded as an MP4 file in this folder |
| `STREAM_SERVICE_URL` | `http://127.0.0.1:7862` | where the agent finds the camera service; `off` runs the camera inside the agent's own process (one machine, no camera container) |
| `CAMERA_JVM_ARGS`, `CAMERA_HEAP_MB`, `CAMERA_JAVA_THREADS`, `CAMERA_GL_THREADS`, `CAMERA_MAX_FPS`, `CAMERA_GRAPHICS`, `CAMERA_CHUNK_THREADS`, `CAMERA_NICE`, `CAMERA_DISPLAY` | | the camera client's tuning (src/camera.js) |
| `STREAM_MUSIC_FILE`, `STREAM_MUSIC_DB`, `STREAM_GAME_DB` | | another music bed, and the two levels in dB |
| `STREAM_CLOCK`, `STREAM_CLOCK_TZ` | `false`, `UTC` | a large wall clock burned into the video, to measure the delay against a clock on the viewer's screen |
| `MINEAI_MAX_HOSTS`, `MINEAI_START_MS`, `MINEAI_HEARTBEAT_MS`, `MINEAI_HEARTBEAT_MISSES`, `MINEAI_UNRESPONSIVE_MS`, `MINEAI_PORT_BASE`, `MINEAI_PORTS`, `MINEAI_KEEP_FAILED`, `MINEAI_DATA_DAYS` | | the bot runtime's processes (src/mineai/host.js) |
| `BODY` | `mineai` in Docker | `mineai` (the Mine AI runtime, one process per game) or `ours` (mineflayer inside the agent: development and tests) |
| `WEB_LEASE_MS`, `WEB_MAX_SESSIONS` | | the older names of `GAME_LEASE_MIN` (in ms) and `MAX_GAMES`; they win when set |
| `LOG_DIR` | `logs` | the game log (JSONL, one row per event; no tokens, no network addresses: a peer a proxy check is about is written as a short hash and its kind) |

## Running without Docker

For development, or to try the tools on a Mac without Docker:

```sh
npm ci
npm run demo                    # the agent on an in-memory test world, http://127.0.0.1:8787/mcp (no server needed)
npm test                        # the test suite (no Docker, no Minecraft, no account)
```

A real server without Docker needs Java 21, Node 22+, Bun 1.4+ and git:

1. Download Paper 1.21.4 build 232 from PaperMC
   (`https://fill-data.papermc.io/v1/objects/5ee4f542f628a14c644410b08c94ea42e772ef4d29fe92973636b6813d4eaffc/paper-1.21.4-232.jar`)
   and check its SHA-256 (`5ee4f542f628a14c644410b08c94ea42e772ef4d29fe92973636b6813d4eaffc`). Read the Minecraft EULA;
   if you accept it, write `eula=true` into `eula.txt` next to the jar yourself. Set `online-mode=false`,
   `server-ip=127.0.0.1` and `white-list=true` in `server.properties`, copy `docker/datapack/agentcam` into
   `world/datapacks/`, create a FIFO for the console (`mkfifo console.in`) and start Paper with its stdin from it
   (`java -jar paper.jar --nogui <> console.in`).
2. Build the bot runtime: `BUN=/path/to/bun mineai/fetch-and-patch.sh ../mineai-runtime`.
3. Start the agent: `BODY=mineai MINEAI_DIR=../mineai-runtime MINEAI_RUNTIME=bun MINEAI_EXEC=/path/to/bun
   MC_CONSOLE=/path/to/console.in MC_WHITELIST=true MCP_ACCESS_KEY=... npm start`.

Without an access key the agent answers `/mcp` only for requests straight from this machine (never one that came
through a proxy or tunnel, and only to the names `localhost` and `127.0.0.1`), so set `MCP_ACCESS_KEY` before you
expose it.

The camera without Docker: either in the agent's own process (`STREAM_SERVICE_URL=off`, with `MC_CONSOLE` and
`CAMERA_AUTH_DIR`), or as its own service (`node scripts/stream.mjs --serve`) with the same `STREAM_SERVICE_TOKEN` in
both processes. On a machine other people log in to, run it inside Docker instead: outside it, the camera's X display
and its folders are as private as your user account makes them.
