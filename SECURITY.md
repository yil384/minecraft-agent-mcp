# Security

## Reporting a vulnerability

Please report it privately through GitHub's "Report a vulnerability" (Security advisories) on this repository, not in
a public issue. Say what you found, how to reproduce it, and what it lets someone do. We will answer as soon as we can.

## What runs, and who can reach it

- **The Minecraft server** (Paper) runs in offline mode, so it does not check accounts: anyone who could open a
  connection could join under a bot's name. It therefore listens on `127.0.0.1` inside the stack's own network
  namespace only (compose.yaml), lets in only whitelisted players (each bot is listed just before it joins and taken
  off when it leaves), hides the online players, and gives every bot a random name nobody can guess. Do not publish
  port 25565.
- **The agent's port** (8787: MCP, the watch page, the optional pages) is published on the host's `127.0.0.1` only
  (`WEB_BIND`). Nothing is reachable from your network or the internet until you put a tunnel or a reverse proxy in
  front of it.

## The MCP access key

There are no user accounts. Access to the MCP endpoint is the **access key** in its URL: `/mcp/<MCP_ACCESS_KEY>` (or
`Authorization: Bearer <key>` on `/mcp`). `setup.sh` generates a 128-bit key. Anyone with the URL can start games on
your server (within `MAX_GAMES`, `GAME_LEASE_MIN` and the per-address limits), so treat it like a password: share it
only with the clients you use, and change it (`.env`, then `docker compose up -d`) if it leaks. A wrong key in the path
is answered 404 and a missing one 401; wrong keys are counted per address (30 an hour, then 429). The key is compared in
constant time and never written to the log.

The agent refuses to start without a key when it listens on anything but loopback (it does in Docker). Without a key
(a development run on loopback, `npm run demo`) `/mcp` answers only requests straight from this machine: any request
that came through a proxy or tunnel (it carries `X-Forwarded-For`, `CF-Connecting-IP`, `Forwarded`, `X-Real-IP` or
`X-Forwarded-Host`) is refused, and so is any request for a host name other than `localhost` or a loopback address.

## The owner's key

`MCP_OWNER_KEY` (optional) is a second key, for you alone, on top of the access key: a connection that brings it
(`?owner=<key>` on the MCP URL, or the header `X-Owner-Key`) goes first in line for the camera and for a bot, plays
while public play is off, may use `say`, and is held to no per-address limit or ban. It must differ from the access
key (the agent refuses to start otherwise), is compared in constant time and is never logged. Keep it out of any URL
you share, and change it if it leaks.

## Host names and other websites (DNS rebinding)

A web page you visit could point a name of its own at your machine's address and then talk to the server as if it
were that page's own site. So the server answers only to host names it knows: `localhost` and loopback addresses,
IP addresses, the host of `WEB_PUBLIC_URL`, `WEB_ALLOWED_HOSTS`, and the quick tunnels' names, whose DNS nobody else
controls (`*.trycloudflare.com`, `*.ts.net`, ngrok's). Any other `Host` gets `421`; a browser request whose `Origin`
is another website gets `403`, and so does a state-changing form or API request another site's page made a browser
send. Requests from your own reverse proxy (with `WEB_PROXY_SECRET`) may carry any name.

Without `MCP_ACCESS_KEY`, anything that forwards this machine's port elsewhere without forwarding headers (`ssh -R`,
`socat`) hands the keyless endpoint to whoever can reach the other end as `localhost`: set a key before you forward
the port anywhere (in Docker there is always one).

## Exposing it safely

- Prefer a tunnel or a reverse proxy **on the same machine**, pointing at `http://127.0.0.1:8787`, and keep
  `WEB_BIND=127.0.0.1`.
- Set `WEB_TRUST_PROXY` to match (`cloudflare` for a Cloudflare tunnel, `1` for one proxy that appends to
  `X-Forwarded-For`), so the per-address limits see real addresses. Behind your own reverse proxy also set
  `WEB_PROXY_SECRET` (docs/CONFIG.md, "Behind a reverse proxy"): requests without it are not believed, and any that
  is not from loopback is refused.
- A Cloudflare quick tunnel (`./setup.sh --tunnel`) needs no account; its address is random and changes on every
  restart, which is not a secret: the access key is.
- The watch pages live under 128-bit ids (`/live/<view id>/`); repeated requests for ids that do not exist are cut off
  per address. A game's page gets only its own game's picture (the playlist and every segment). The page
  `/live/<WATCH_KEY>/` shows whatever the camera films; its key is not the MCP access key, so a watch link someone
  sees or forwards never lets them play.
- Keep `WEB_GUEST_PAGES=off` (the default) unless you want anyone who reaches the port to start bots from the zero-JS
  pages (`/play`, `/api`).
- `/log` and the `/admin/*` routes (games, end, ban, unban, public, stop) exist only with `WEB_ADMIN_TOKEN` and need
  it as a Bearer token; five wrong tokens lock an address out for an hour. With no `WEB_ADMIN_TOKEN` set they answer 404.

## Sharing the server with everyone

When you publish the MCP URL, anyone's agent can play (README, "Hosting a public server"):

- Every string an agent sends (its `why` and `plan`, its goal, `say`'s text, every argument) and its client's name are
  cleaned by a word filter before anything keeps or shows them; offensive words become `[removed]`. It cannot catch
  everything: the HUD shows only what an agent sent, under that client's own name, never as yours.
- `PUBLIC_CHAT=false` keeps in-game chat to your own key; `PUBLIC_PLAY=false` (or `POST /admin/public`) closes the
  server to new games at once.
- Per address: MCP sessions, games held at once, new games an hour; per session: requests a minute. Behind a tunnel or
  proxy, set `WEB_TRUST_PROXY` so these see real addresses.
- Addresses are shown and logged only as 12-character keyed hashes (`WEB_IP_SALT`, or derived from the admin token);
  `POST /admin/ban` bans a hash (and ends its games), kept across restarts.

## Limits

`MAX_GAMES` bots at once, `GAME_LEASE_MIN` per game, `GAME_IDLE_MIN` without calls, MCP sessions in all and per
address, MCP games held per address, new sessions and game starts per address per hour (`WEB_MCP_STARTS_PER_HOUR`),
requests per MCP session per minute (`WEB_MCP_REQUESTS_PER_MINUTE`), a 64 KiB cap on an MCP request and 8 KiB on a
form, and on the live views a cap on open connections per address. With `LIVE_VIEW=facebook`, `FB_MAX_PER_HOUR` and
`FB_MAX_PER_DAY` cap the live videos started: Facebook may lock an account that starts many automated public live
videos in a short time.

## Secrets on disk

| Secret | Where | Protection |
| --- | --- | --- |
| `MCP_ACCESS_KEY`, `MCP_OWNER_KEY`, `WATCH_KEY`, `WEB_ADMIN_TOKEN`, `WEB_PROXY_SECRET`, `WEB_IP_SALT` | `.env` (mode 600) | passed to the agent only (compose.yaml blanks them for the camera); never logged; never handed to a child process (a bot's runtime, ffmpeg, the X server, the game client) |
| `STREAM_SERVICE_TOKEN` | `.env` (mode 600) | shared by the agent and the camera service; the camera's control API answers no request without it; never logged |
| The camera's Microsoft and Minecraft tokens | `./data/camera-auth` (700, files 600) | refreshed silently; the token reaches the game client through its environment, never its command line |
| The Facebook token | `./secrets/fb-token` (600) | read by the camera only, sent only in the Authorization header to graph.facebook.com, scrubbed from every error |
| Stream keys (RTMPS ingest URLs) | memory only | never on a command line (ffmpeg writes to a pipe; src/rtmp.js publishes), masked in logs |
| Each bot's runtime token | memory and its process's environment | one per host, loopback only |

The game log (`./data/logs`) holds the calls with short summaries of their arguments, the agent's why texts (after the
word filter), results and times, and the MCP client's name and version; no tokens, no keys and no network addresses
(a game's address, and a peer that a proxy check is about, are written as a short keyed hash). Recordings
(`RECORD=true`, `./data/recordings`) hold the game's picture and sound and the HUD's text, nothing else.

## Containers

Every container runs as the user who ran `setup.sh`, with every Linux capability dropped and `no-new-privileges`.
Paper listens on `127.0.0.1` inside the stack's own network namespace; the camera's control API and each bot's
runtime listen on `127.0.0.1` there too, each behind a token.

## What players can and cannot do

A client plays only through the tools: every argument is checked against fixed lists and ranges before a bot sees it,
nothing a client sends is run as code or as a console command, other players' chat never reaches a reply, and every
string shown on a page is escaped. The camera's console commands are built from validated player names only.
