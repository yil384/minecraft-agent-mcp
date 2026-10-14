# Architecture

## The stack

`compose.yaml` runs up to four containers in one network namespace, the `paper` container's, so they talk over
`127.0.0.1` and nothing outside the stack reaches the Minecraft server. The only published port is the agent's, on
the host's `127.0.0.1`.

```
host 127.0.0.1:8787 ──► ┌──────────── one network namespace (owned by "paper") ───────────────────────────────┐
(the only published     │ paper   Paper 1.21.4          127.0.0.1:25565  offline mode, whitelist, console FIFO   │
 port)                  │ agent   node src/index.js     0.0.0.0:8787     /mcp/<key>, /live/<id>/, pages          │
                        │         bun host.ts x games   127.0.0.1:27100+ one Mine AI MCP host per game (its bot) │
                        │ camera  scripts/stream.mjs    127.0.0.1:7862   the camera service (profile "camera")   │
                        │         Xvfb + Minecraft client (spectator) + ffmpeg + the HUD (node-canvas)          │
                        │ tunnel  cloudflared           -> 127.0.0.1:8787 (profile "tunnel")                    │
                        └────────────────────────────────────────────────────────────────────────────────────────┘
volumes: ./data/world (the world), ./data/logs, ./data/mineai (the bots' data and the bans, 700),
         ./data/camera-auth (700), ./data/minecraft-client (downloaded at the camera's first start),
         ./data/recordings (RECORD=true), ./secrets (the Facebook token, 600), a named volume for the console FIFO
```

Paper owns the namespace because it restarts least: the agent can be rebuilt and restarted without taking the camera
or the tunnel down. Every container runs as the user who ran `setup.sh` (`RUN_UID`, `RUN_GID`).

## A game

1. An MCP client connects to `/mcp/<key>` (streamable HTTP, JSON replies; `src/web.js` checks the key in constant
   time, the address's limits and bans, then hands the request to `src/mcp.js`). `initialize` returns the server's
   instructions: the standing rules, so one sentence from the user is enough. Every string in every call, and the
   client's name, goes through the word filter first (`src/moderation.js`); then the call is logged.
2. `start_game` takes a bot slot (or a place in the queue; the owner's key goes first; `CLOSED`, `RATE_LIMITED` or
   `SERVER_FULL` otherwise), picks a private player name, puts it on the server's whitelist through the console FIFO
   and starts a Mine AI MCP host for it (`src/mineai/host.js`): a Bun process with a random token, on a loopback port,
   its data in `./data/mineai/<game>`. The bot joins Paper and is spread to fresh ground (`spreadplayers` through the
   console). The agent's rules (`start_game` `rules`, all off by default) go to the body. With a live view on, steps
   wait for the game's `live_view` (`NEED_LIVE_VIEW`).
3. `play` and `play_sequence` are checked first (`src/plan.js`: missing items or bad arguments refuse the call whole;
   planks, sticks, a table or a furnace that can be made are added as crafts), then queued (`src/mcp-queue.js`). Each
   step becomes one call to the host's own tools (`src/mineai/body.js`, `src/mineai/skills.js`). Every reply carries
   the results, the state and the body's advice within 45 s; longer steps keep running and a later reply reports them.
4. Between calls the body acts only by the rules the agent set (advise mode: the runtime's reflexes, switched by
   `defend`, `flee`, `escape` and `eat_below` through the runtime's survival policy, patch 0012), or also looks after
   itself (`BOT_CARE=full`; `src/mineai/care.js`). Each reply's "Body advice" comes from the same place, with the
   stuck detector and the time left from `src/mcp.js`. Everything the body does outside the agent's calls is reported
   and counted as direct, rules or body (`src/mineai/body.js` `attributionOf`, `src/report.js`).
5. `end_game` (or the lease, or `GAME_IDLE_MIN` without calls) ends the game: the host stops, the bot leaves and is
   taken off the whitelist, its data goes (the last failed games are kept for diagnosis).

## The live view

The camera service (`scripts/stream.mjs --serve`, `src/camera.js`, `src/stream.js`) owns one camera rig: Xvfb, a
PulseAudio sink, and a Minecraft client signed in with the operator's account, kept in the world between games and
parked in the sky. The agent reports each game to the service once its bot has landed (`PUT /streams/<game>` with
the bot's player name; `src/stream.js` `createRemoteStreamManager`), and every HUD line as it happens. Every request
to the service carries `STREAM_SERVICE_TOKEN`.

A **channel** decides what the camera films: only games whose `live_view` asked, first come, first served. The game on
camera keeps it until it ends, or until it has made no call for 5 minutes while others wait; the others wait in line
in the order of their first `live_view` (the owner's games first, a check script's last), and each is told its place
and an estimate from the games ahead and their leases. A game higher in that order does not wait: the owner's game
takes the camera from a player's at once (the player's live video ends and its game waits in line again), and a
player's game from a check script's. Two channels share that behaviour and the HUD keeping (`src/live-terms.js`:
each game's HUD state, kept while it is off camera and drawn again when the camera reaches it):

- **local** (`src/live-local.js`): ffmpeg writes HLS (one 2 s segment per keyframe interval, six kept, numbered from
  the clock) into a folder of the camera's tmpfs; the service serves those files on loopback (`GET /hls/<file>`, names
  checked), and the agent proxies them under `/live/<view id>/hls/`. The watch page (`src/watch-page.js`) is a
  `<video>` element with hls.js from the agent itself, a status line from `/live/<view id>/status`, and a strict
  Content-Security-Policy (own scripts only, no third-party request, no frames). A game's page plays the picture only
  while the camera films that game, and only from the segment after the camera came to it (the channel reports that
  segment number; the agent cuts the playlist there and refuses older segments). `/live/<WATCH_KEY>/` shows whatever
  the camera films.
- **facebook** (`src/fb-live.js`): when the camera reaches a game, the channel creates a live video for that game on
  the operator's profile or Page through the Graph API (the token from its 600 file, in the Authorization header
  only), and ffmpeg's FLV goes to the live video's RTMPS ingest through `src/rtmp.js` (the stream key never on a
  command line). Each game has a live video of its own: it ends when the camera moves on or the game ends, and is
  deleted later on a profile. Caps per hour and per day, counted across restarts; while a cap holds the game can still
  be filmed for the recording. A crash's leftovers of this install (its marker in the description) are ended at start.

`live_view` (`src/mcp.js`) puts the caller's game in line for the camera and waits up to about 40 s for the channel to
show it (it answers at once with the place in line when another game has the camera): in local mode it returns the
watch page's link, in facebook mode a small page with Facebook's player (for clients whose preview panel plays
Facebook's player and nothing else, `src/live-page.js`). That page draws a poster first (inline SVG, no request), and
asks the agent about its game by the game's secret view id with images (`/live/<view id>/state.svg`, `v0..v2.svg`,
`end.svg`: a preview panel allows no fetch): 1, 2 or 3 pixels wide for running, ended, or on camera and live; the
live video's id when a game in line comes on camera; and the end card once the game is over.

With `RECORD=true` the camera also writes each filmed game to `RECORD_DIR` (`src/recorder.js`): the clean game by a
second, niced ffmpeg on the same display, the stream's own bytes (teed from the RTMPS pipe, or the stream's output
when there is no live video), and every HUD update with its time.

The HUD (`src/terminal.js` turns calls and replies into lines and state; `src/ui-panel.js` keeps the HUD's state and
draws it with node-canvas into a BMP that ffmpeg overlays, only when the picture changed): concept B
(`src/hud-b.js`, `STREAM_HUD=b`, the default) draws over the whole frame: each command a toast with the agent's why,
floaters for what the bot gains, the agent's rules in the action bar, banners for goals, splits and deaths; and under
the game a broadcast package: health, food, time of day, who acted, the command with its why and plan, the goal's
splits, the last events and the raw calls. `src/hud.js` is the earlier design (`STREAM_HUD=final`). The caller is the
MCP client's own name; an optional logo (`STREAM_LOGO`) sits at the top right.

## Modules

| Module | What |
| --- | --- |
| `src/index.js` | wires everything from the config; bots, names, whitelist, spread, the camera hooks |
| `src/config.js` | every setting, checked and frozen; secrets non-enumerable |
| `src/web.js` | the HTTP server: the access key and the owner's key, the host names it answers to, the landing page and the page a browser gets at the MCP URL, the watch page and live page routes, the guest pages, leases, queues, per-address limits, bans, the admin routes, proxy trust |
| `src/moderation.js`, `src/moderation/` | the word filter over every string an agent sends (LDNOOBW's English list, CC BY 4.0) |
| `src/mcp.js`, `src/mcp-queue.js`, `src/plan.js`, `src/tolerant.js` | the MCP tools, the per-game queue, the check before a call, lenient argument reading |
| `src/report.js`, `src/goals.js` | goals in the player's words, milestones, the report |
| `src/mineai/*` | the Mine AI host manager, the body that talks to a host, its skills, the body's care and advice, the preload that ends a host with the agent |
| `src/body.js`, `src/skills/*` | a mineflayer body inside the agent (`BODY=ours`: development and the test world) |
| `src/camera.js`, `src/stream.js`, `src/rtmp.js`, `src/recorder.js` | the camera rig, ffmpeg, the RTMP(S) publisher, the camera service and its client, the recordings |
| `src/live-local.js`, `src/fb-live.js`, `src/live-terms.js`, `src/watch-page.js`, `src/live-page.js` | the two channels, the HUD kept per game, the watch page, the page `live_view` returns |
| `src/terminal.js`, `src/ui-panel.js`, `src/hud-b.js`, `src/hud.js`, `src/terminal-panel.js` | the HUD |
| `mineai/` | the Mine AI pin and our patches (MIT), built into the agent image |
| `docker/` | the three Dockerfiles, Paper's and the camera's entry scripts (the EULA gate), the camera's client installer and pins, the camera's datapack |
| `scripts/` | `self-check.mjs` (a scripted game over MCP), `stdio-bridge.mjs`, `camera-login.mjs`, `fb-token.mjs`, `stream.mjs` (the camera service), `mineai-fetch.mjs`, samples of the HUD |

## Tests

`npm test` runs everything without Docker, Minecraft or an account: an in-memory test world (`test/fake-bot.js`), a
fake Mine AI runtime (`test/fake-mineai.js`), a fake Graph API (`test/fake-graph.js`), stand-in camera rigs, and real
ffmpeg where it is installed (the HLS path end to end through the camera service and the agent, and RTMP to a local
sink). `test/fixtures/replay-games.json` replays an agent's real calls from eleven games through the MCP endpoint, and
the `test/g*.test.js` files each pin down what went wrong in one real game.
