# Mine AI MCP: the bot body, pinned upstream plus our patches

Each game's bot is a host of the [Mine AI MCP](https://github.com/aibengineering/mine-ai-mcp) runtime (MIT, Copyright
(c) 2026 AI Bengineering), run by the agent behind its own MCP endpoint (`BODY=mineai`, `src/mineai/`). Their code
never enters this repository: we keep the pinned upstream commit and our patch files, and `fetch-and-patch.sh` clones
that commit into a folder, applies the patches and installs the dependencies at build time (`docker/Dockerfile.agent`
runs it). Our patches are offered under the same MIT licence as the upstream code (`LICENSE`).

| File | What it is |
| --- | --- |
| `UPSTREAM.json` | the pin: their repository, the commit, their mineflayer fork's commit, and our patches in the order they apply |
| `fetch-and-patch.sh` | the build: `mineai/fetch-and-patch.sh <new folder>` clones the pinned commit, `git apply`s our patches in order, runs `bun install --frozen-lockfile`, checks that `node_modules/mineflayer` is their pinned fork, stamps the folder (`.agent-mineai.json`: the commit and each patch's SHA-256), type-checks, and runs their tests for the patched code. `--no-install`, `--no-check` |
| `../scripts/mineai-fetch.mjs` | the same fetch in Node; `node scripts/mineai-fetch.mjs <dir> --check` says whether a folder is exactly the pin plus these patches. The agent refuses any other folder at start |
| `LICENSE` | the MIT licence of Mine AI MCP and of our patches |

## Pins

| What | Pinned at |
| --- | --- |
| Mine AI MCP | `2fe1306a0ac51efa99154048e65f2caff00a8934` |
| their mineflayer fork | `9fa1140b90877a084efd988905df0c0eceaa78d0` (mineflayer 4.39.0 with their fixes) |
| prismarine-physics, prismarine-recipe forks | their `bun.lock` (frozen) |
| Bun | 1.4.2, SHA-256 checked in `docker/Dockerfile.agent` |

## The patches

| Patch | What it changes |
| --- | --- |
| `0001-craft-by-confirmed-window-clicks` | Crafting by confirmed window clicks, so crafting works on Paper (Paper answers a recipe's click with a burst of slot updates that mineflayer's craft reads too early) |
| `0002-confirmed-crafting-tests` | Its tests: a bot double with a server's side of windows that also sends Paper's result burst |
| `0003-unresponsive-window-from-env` | Their supervisor's event-loop watchdog window from `MINEAI_UNRESPONSIVE_MS` (5-120 s) for a loaded machine |
| `0004-host-token` | With `MINEAI_HOST_TOKEN` set, the host and its runtime answer only requests with `Authorization: Bearer <token>` |
| `0005-player-name-off-the-command-line` | The player name and the runtime's bootstrap through the environment, never a command line (on a whitelisted server the private name is the secret) |
| `0006-runtime-exits-once-stopped` | The runtime process exits once a stop is done, instead of waiting for the supervisor's kill |
| `0007-no-placement-into-a-flower` | A placed block never goes into a cell the server will not replace (flowers, tulips; snow only as a single layer) |
| `0008-collect-retries-once-after-landing` | A `collect_block` that found no path right after a landing (a spread, a teleport, a respawn) is tried once more after the chunks around the bot loaded |
| `0009-placement-around-a-mob` | A block put down beside the bot never goes into a cell a mob or another player is in; the next cell is tried (3 at most) |
| `0010-build-never-stalls-the-event-loop` | `build_structure` never stops the runtime's event loop, and builds a shelter around the bot |
| `0011-build-on-rough-ground` | `build_structure` gives up on no cell the bot can reach: other places to stand, a support column over a drop, solid ground kept, water left as water, every cell yielding to the event loop |
| `0012-reflex-toggles` | Two policy fields so the player decides what the body does on its own: `food.reflex` (full, starving, never) and `navigation.escape_reflexes` |
| `0013-shield-waits-for-short-actions` | The hostile reflex's shield preparation waits for a short action of the player's (a craft, a smelt, an equip) to finish instead of interrupting it |
| `0014-collect-spares-lit-portal-frames` | `collect_block`'s search never takes obsidian from a lit nether portal's frame (an exact cell still can); with every loaded obsidian in lit frames it casts obsidian from lava instead |
| `0015-collect-spares-lit-frame-corners` | The same for a lit frame's corners: obsidian with a portal block on any of the 26 cells around it |
| `0016-cast-pools-from-their-shore` | A cast onto a lava lake starts from its shore: open sources beside the shore first, then open ones, then those under lava; a pour that forms nothing gives up its stance, the pool after 3 |

To build a runtime by hand (Bun 1.4 or newer, git, Node):

```sh
BUN=/path/to/bun mineai/fetch-and-patch.sh /path/to/a/new/folder
MINEAI_DIR=/path/to/a/new/folder BODY=mineai npm start
```

A change to a patch file changes its SHA-256, so a runtime built from the old patches is refused until it is built
again.
