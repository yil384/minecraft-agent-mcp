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
volumes: ./data/world (the world), ./data/logs, ./data/mineai (the bots' data, 700), ./data/camera-auth (700),
         ./data/minecraft-client (downloaded at the camera's first start), ./secrets (the Facebook token, 600),
         a named volume for the console FIFO
```

Paper owns the namespace because it restarts least: the agent can be rebuilt and restarted without taking the camera
or the tunnel down. Every container runs as the user who ran `setup.sh` (`RUN_UID`, `RUN_GID`).

## A game

1. An MCP client connects to `/mcp/<key>` (streamable HTTP, JSON replies; `src/web.js` checks the key in constant
   time, then hands the request to `src/mcp.js`). `initialize` returns the server's instructions: the standing rules,
   so one line from the user is enough.
2. `start_game` takes a bot slot (or a place in the queue), picks a private player name, puts it on the server's
   whitelist through the console FIFO and starts a Mine AI MCP host for it (`src/mineai/host.js`): a Bun process with
   a random token, on a loopback port, its data in `./data/mineai/<game>`. The bot joins Paper and is spread to fresh
   ground (`spreadplayers` through the console).
3. `play` and `play_sequence` are checked first (`src/plan.js`: missing items or bad arguments refuse the call whole;
   planks, sticks, a table or a furnace that can be made are added as crafts), then queued (`src/mcp-queue.js`). Each
   step becomes one call to the host's own tools (`src/mineai/body.js`, `src/mineai/skills.js`). Every reply carries
   the results, the state and the body's advice within 45 s; longer steps keep running and a later reply reports them.
4. Between calls the body has only its reflexes (advise mode) or also looks after itself (`BOT_CARE=full`;
   `src/mineai/care.js`). Everything it does on its own is reported and counted (`src/report.js`).
5. `end_game` (or the lease, or `GAME_IDLE_MIN` without calls) ends the game: the host stops, the bot leaves and is
   taken off the whitelist, its data goes (the last failed games are kept for diagnosis).

## The live view

The camera service (`scripts/stream.mjs --serve`, `src/camera.js`, `src/stream.js`) owns one camera rig: Xvfb, a
PulseAudio sink, and a Minecraft client signed in with the operator's account, kept in the world between games and
parked in the sky. The agent reports each game to the service once its bot has landed (`PUT /streams/<game>` with
the bot's player name; `src/stream.js` `createRemoteStreamManager`), and every HUD line as it happens. Every request
to the service carries `STREAM_SERVICE_TOKEN`.

A **channel** decides what the camera films: only games whose `live_view` asked, the last asker first. Two channels
share that behaviour and the HUD keeping (`src/live-terms.js`):

- **local** (`src/live-local.js`): ffmpeg writes HLS (one 2 s segment per keyframe interval, six kept, numbered from
  the clock) into a folder of the camera's tmpfs; the service serves those files on loopback (`GET /hls/<file>`, names
  checked), and the agent proxies them under `/live/<view id>/hls/`. The watch page (`src/watch-page.js`) is a
  `<video>` element with hls.js from the agent itself, a status line from `/live/<view id>/status`, and a strict
  Content-Security-Policy (own scripts only, no third-party request, no frames). A game's page plays the picture only
  while the camera films that game, and only from the segment after the camera came to it (the channel reports that
  segment number; the agent cuts the playlist there and refuses older segments). `/live/<WATCH_KEY>/` shows whatever
  the camera films.
- **facebook** (`src/fb-live.js`): when a game asks and no broadcast runs, the channel creates a live video on the
  operator's profile or Page through the Graph API (the token from its 600 file, in the Authorization header only),
  and ffmpeg's FLV goes to the live video's RTMPS ingest through `src/rtmp.js` (the stream key never on a command
  line). Caps per hour and per day, counted across restarts; the live video ends with the last game that asked and is
  deleted later on a profile; a crash's leftovers of this install (its marker in the description) are ended at start.

`live_view` (`src/mcp.js`) points the camera at the caller's game and waits up to about 40 s for the channel to show
it: in local mode it returns the watch page's link, in facebook mode a small page with Facebook's player (for clients
whose preview panel plays Facebook's player and nothing else, `src/live-page.js`).

The HUD (`src/terminal.js` turns calls and replies into lines; `src/ui-panel.js` and `src/hud.js` draw them with
node-canvas 30 times a second into a BMP that ffmpeg overlays): the agent's why and plan as it sent them, its calls,
the steps and the body's execution, the advice and whether the agent followed it, reflexes, milestones, the goal, the
items, health, food and the clock. The caller is the MCP client's own name.

## Modules

| Module | What |
| --- | --- |
| `src/index.js` | wires everything from the config; bots, names, whitelist, spread, the camera hooks |
| `src/config.js` | every setting, checked and frozen; secrets non-enumerable |
| `src/web.js` | the HTTP server: the access key, the host names it answers to, the landing page, the watch page routes, the guest pages, leases, queues, per-address limits, proxy trust |
| `src/mcp.js`, `src/mcp-queue.js`, `src/plan.js`, `src/tolerant.js` | the MCP tools, the per-game queue, the check before a call, lenient argument reading |
| `src/report.js`, `src/goals.js` | goals in the player's words, milestones, the report |
| `src/mineai/*` | the Mine AI host manager, the body that talks to a host, its skills, the body's care and advice, the preload that ends a host with the agent |
| `src/body.js`, `src/skills/*` | a mineflayer body inside the agent (`BODY=ours`: development and the test world) |
| `src/camera.js`, `src/stream.js`, `src/rtmp.js` | the camera rig, ffmpeg, the RTMP(S) publisher, the camera service and its client |
| `src/live-local.js`, `src/fb-live.js`, `src/live-terms.js`, `src/watch-page.js`, `src/live-page.js` | the two channels, the HUD kept per game, the watch page, the page `live_view` returns |
| `src/terminal.js`, `src/ui-panel.js`, `src/hud.js`, `src/terminal-panel.js` | the HUD |
| `mineai/` | the Mine AI pin and our patches (MIT), built into the agent image |
| `docker/` | the three Dockerfiles, Paper's and the camera's entry scripts (the EULA gate), the camera's client installer and pins, the camera's datapack |
| `scripts/` | `self-check.mjs` (a scripted game over MCP), `stdio-bridge.mjs`, `camera-login.mjs`, `fb-token.mjs`, `stream.mjs` (the camera service), `mineai-fetch.mjs`, samples of the HUD |

## Tests

`npm test` runs everything without Docker, Minecraft or an account: an in-memory test world (`test/fake-bot.js`), a
fake Mine AI runtime (`test/fake-mineai.js`), a fake Graph API (`test/fake-graph.js`), stand-in camera rigs, and real
ffmpeg where it is installed (the HLS path end to end through the camera service and the agent, and RTMP to a local
sink). `test/fixtures/replay-games.json` replays an agent's real calls from seven games through the MCP endpoint.
