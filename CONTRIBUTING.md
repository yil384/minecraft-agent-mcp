# Contributing

Thank you for helping. Issues and pull requests are welcome.

## Develop

Node 22 or newer. No build step: plain JavaScript modules, tested with `node --test`.

```sh
npm ci
npm test            # the whole suite: no Docker, no Minecraft, no account (ffmpeg, if installed, runs the video tests too)
npm run demo        # the agent on an in-memory test world: http://127.0.0.1:8787/mcp
node scripts/self-check.mjs http://127.0.0.1:8787     # a scripted game against it
```

A real server: `./setup.sh` (Docker), or docs/CONFIG.md, "Running without Docker".

CI (`.github/workflows/`): `test` runs `npm test` on every push and pull request; `image` builds the agent's image and
starts it as an unprivileged user (the runtime pin check, the key, host names). `stack` runs `./setup.sh` end to end
with Paper; it starts only by hand, because Paper downloads Mojang's server, which needs you to accept the Minecraft
EULA for that run.

## Pull requests

- One change per pull request, with a test that fails without it. Bugs found in real games make the best tests:
  record what the agent sent and what came back (the game log has it) and replay it against the test world or the
  fake runtime (see `test/replay.test.js`).
- `npm test` passes, on Node 22 and newer.
- Replies, the server's instructions and tool descriptions are read by models: keep them short, plain and exact, and
  say what the server did, not what it hopes.
- The HUD and every reply say who acted: the agent's own words stay the agent's, the body's reflexes stay the body's.
  Do not put a client's name on words it did not send.

## What must never be in this repository

- Minecraft's code or assets (the client, the server jar, textures, sounds, the logo), Paper, Fabric, mod jars or any
  other binary we do not have the right to redistribute. Downloads happen on the user's machine, pinned by hash, after
  the user accepted the Minecraft EULA.
- Secrets: tokens, keys, stream URLs, account names, private addresses. Tests use obvious fakes.
- Anything that suggests this project is official or endorsed by Mojang, Microsoft or Meta.

## The Mine AI patches

The bot runtime is Mine AI MCP at a pinned commit plus the patches in `mineai/patches` (MIT). To change one: build a
runtime with `mineai/fetch-and-patch.sh <new folder>`, change the code there, test it (`bun test` there), write the
change back as a patch (`git -C <folder> diff`, in the order of `mineai/UPSTREAM.json`), and build a fresh folder again
to check that every patch still applies and every test passes. A patch's SHA-256 is stamped into the built folder, so
the agent refuses a runtime built from older patches.

## Licence of contributions

By contributing you agree that your contribution is licensed under the Apache License 2.0, like the project, except
changes to `mineai/patches`, which are licensed under the MIT License, like the code they patch.
