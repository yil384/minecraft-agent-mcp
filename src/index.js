// src/index.js - starts the agent from config: the web port (src/web.js: the MCP endpoint, the watch page, the optional
// zero-JS pages) with one bot per game, each a Mine AI MCP host of its own with BODY=mineai (src/mineai/) or a
// mineflayer body in this process (BODY=ours), the live view when LIVE_VIEW is local or facebook (the camera service,
// src/stream.js; nothing changes when it is off), the event loop's delay in the log every minute (loop_delay: p50,
// p99, max), and a graceful shutdown on SIGINT/SIGTERM. `npm start`; `npm start -- --fake-bot` puts every bot in the
// in-memory test world instead of a Minecraft server (a local demo with no Java and no server).

import fs from 'node:fs';
import http from 'node:http';
import path from 'node:path';
import crypto from 'node:crypto';
import { createRequire } from 'node:module';
import { parseArgs } from 'node:util';
import { pathToFileURL } from 'node:url';
import { monitorEventLoopDelay } from 'node:perf_hooks';
import { loadConfig, isLoopbackHost } from './config.js';
import { createLogger } from './log.js';
import { createBody } from './body.js';
import { createWeb } from './web.js';
import { createServerReady } from './mc-ready.js';
import { createRemoteStreamManager, channelOf } from './stream.js';
import { createCameraManager } from './camera.js';
import { consoleLine } from './stations.js';
import { createHostManager } from './mineai/host.js';
import { createMineAiBody } from './mineai/body.js';
import { MINEAI_SKILLS } from './mineai/skills.js';
import { check as checkRuntime } from '../scripts/mineai-fetch.mjs';

const require = createRequire(import.meta.url);

export const USAGE = `usage: npm start [-- --fake-bot]

  --fake-bot   every bot plays in the in-memory test world (test/fake-bot.js); no Minecraft server is needed
  -h, --help   this text

Everything else comes from the environment (.env.example, docs/CONFIG.md). Ctrl-C stops: games end, bots leave the
server, the log is written.`;

const runId = () => `serve-${new Date().toISOString().replace(/[:.]/g, '-')}-${crypto.randomBytes(2).toString('hex')}`;

function within(promise, ms) {
  let timer;
  return Promise.race([Promise.resolve(promise), new Promise((resolve) => { timer = setTimeout(resolve, ms); })])
    .finally(() => clearTimeout(timer));
}

/** How long a spread Mine AI bot waits, at most, for the first scan of its new spot to see anything (settleAfterSpread). */
export const SPREAD_SCAN_MS = 30_000;
const pauseMs = (ms) => new Promise((r) => { setTimeout(r, ms); });

/**
 * After a Mine AI bot was spread (src/index.js, joinMineAi): wait until it has landed (moved more than 8 blocks from
 * `from`, up to 10 s), then until the scan of the blocks around the new spot sees something notable, scanning again
 * every 2 s for up to SPREAD_SCAN_MS. Any overworld spot has stone, water, sand, gravel or logs within the scan radius,
 * so an empty scan means the chunks there had not arrived yet: on a new world the server makes them first, which on a
 * slow machine takes longer than a few seconds (the first stack run, 2026-10-13: three games in a row started with
 * "nothing notable" around, so the first state showed no wood). Returns {scans, notable} (the scans run, the kinds of
 * notable blocks the last one saw).
 */
export async function settleAfterSpread(body, from, { wait = pauseMs, now = Date.now, limitMs = SPREAD_SCAN_MS } = {}) {
  for (let i = 0; i < 20; i++) { // landed: moved away from the spawn (up to 10 s)
    await wait(500);
    await body.refresh().catch(() => {});
    const p = body.bot.entity?.position;
    if (p && Math.hypot(p.x - from.x, p.z - from.z) > 8) break;
  }
  await wait(3_000); // the chunks around the new spot load (their collect searches the loaded ones)
  const until = now() + limitMs;
  for (let scans = 1; ; scans++) {
    await body.refresh().catch(() => {});
    await Promise.race([body.rescan(), wait(10_000)]); // the blocks around the new spot, for the first state
    const notable = body.snapshot?.()?.nearbyBlocks?.length ?? 1;
    if (notable || now() >= until) return { scans, notable };
    await wait(2_000);
  }
}

/** The usual longest game lease (2 hours): a longer one keeps a bot (0.3-1 GB) for a long time. */
export const USUAL_LEASE_MS = 7_200_000;
/** A warning when the lease is longer than usual, else null. */
export function leaseWarning(leaseMs) {
  if (!(leaseMs > USUAL_LEASE_MS)) return null;
  return `a game lasts up to ${Math.round(leaseMs / 60_000)} min (GAME_LEASE_MIN): each bot keeps its memory that long; lower it if games are left running`;
}

/** Minecraft username for a game id: <name>_<id> (at most 16). */
export function usernameFor(base, sessionId) {
  const id = String(sessionId).replace(/[^A-Za-z0-9_]/g, '').slice(0, 7) || 'guest';
  return `${base.slice(0, 16 - id.length - 1)}_${id}`;
}

/**
 * SPREAD_SPOTS ("x z; x z; ..." or "x,z x,z ...") as [{x, z}]: the fixed spots new guest bots land at in turn. Empty
 * or unset: none (the random spread). Throws on anything that is not pairs of whole block coordinates.
 */
export function spreadSpots(raw) {
  const text = String(raw ?? '').trim();
  if (!text) return [];
  const nums = text.split(/[\s,;]+/).filter(Boolean).map(Number);
  if (nums.length % 2 || nums.some((n) => !Number.isInteger(n) || Math.abs(n) > 29_999_984)) {
    throw new Error(`SPREAD_SPOTS must be pairs of whole x z block coordinates ("x z; x z"), got "${text.slice(0, 80)}"`);
  }
  const out = [];
  for (let i = 0; i < nums.length; i += 2) out.push({ x: nums[i], z: nums[i + 1] });
  return out;
}

const NAME_CHARS = 'ABCDEFGHIJKLMNOPQRSTUVWXYZabcdefghijklmnopqrstuvwxyz0123456789';
/**
 * A guest bot's name on a server that lets in only listed players (MC_WHITELIST): MC_USERNAME (its first 8
 * characters) and random letters and digits up to 16 characters ("Bot_" and 12: 71 bits; at least 7, 41 bits),
 * never the game id, so nobody who learns a game id (logs, a reply) can join under its bot's name and take it over
 * (the server runs in offline mode).
 */
export function privateName(base) {
  const head = String(base).slice(0, 8);
  const bytes = crypto.randomBytes(16 - head.length - 1);
  return `${head}_${[...bytes].map((b) => NAME_CHARS[b % NAME_CHARS.length]).join('')}`;
}

/** How long Paper gets to read a whitelist line from its console before the bot it lets in connects. */
const LIST_SETTLE_MS = 400;

/**
 * Run fn while every http server it starts listens on `host` only. prismarine-viewer calls listen(port, cb) itself and
 * has no host option, which would put the watch page on every network interface. Errors (a port in use) are passed to
 * onError instead of crashing the process; onListening(server) runs once a server really listens.
 */
export function listeningOn(host, fn, onError = () => {}, onListening = null) {
  const proto = http.Server.prototype;
  const own = Object.hasOwn(proto, 'listen');
  const original = proto.listen;
  proto.listen = function listen(port, ...rest) {
    this.on('error', onError);
    if (onListening) this.once('listening', () => onListening(this));
    if (typeof port === 'number' && typeof rest[0] !== 'string') return original.call(this, port, host, ...rest);
    return original.call(this, port, ...rest);
  };
  try {
    return fn();
  } finally {
    if (own) proto.listen = original;
    else delete proto.listen;
  }
}

/**
 * prismarine-viewer with its live views made read-only. Its WorldView registers an async 'mouseClick' handler on every
 * viewer's socket that trusts the payload: a missing one is an unhandled rejection (the process exits), a NaN
 * direction makes the raycast loop forever. Nothing here uses clicks, so that handler is removed before any view
 * exists (lib/mineflayer takes WorldView from ../viewer when it is first loaded, so the patch goes in first).
 */
export function loadViewer() {
  const viewerLib = require('prismarine-viewer/viewer');
  if (!viewerLib.WorldView.readOnly) {
    const Base = viewerLib.WorldView;
    class ReadOnlyWorldView extends Base {
      constructor(...args) {
        super(...args);
        this.emitter.removeAllListeners('mouseClick');
      }
    }
    ReadOnlyWorldView.readOnly = true;
    viewerLib.WorldView = ReadOnlyWorldView;
  }
  return { mineflayer: require('prismarine-viewer/lib/mineflayer') };
}

/**
 * The event loop's delay, logged every `everyMs` as a loop_delay row: p50, p99, max and mean in ms over that window, how
 * late the loop was beyond the histogram's sampling interval (resolutionMs, taken off: Node records whole intervals),
 * and samples (fewer than everyMs / resolutionMs when the loop was blocked). One stalled loop holds up every bot's
 * physics and every reply. Returns stop().
 */
export function watchEventLoop(log, { everyMs = 60_000, resolutionMs = 10 } = {}) {
  const h = monitorEventLoopDelay({ resolution: resolutionMs });
  h.enable();
  const ms = (ns) => Math.max(0, Math.round(ns / 1e4) / 100 - resolutionMs);
  const timer = setInterval(() => {
    if (!h.count) return;
    try {
      log.event('loop_delay', { p50Ms: ms(h.percentile(50)), p99Ms: ms(h.percentile(99)), maxMs: ms(h.max), meanMs: ms(h.mean), samples: h.count, windowS: Math.round(everyMs / 1000) });
    } catch { /* logging is best effort */ }
    h.reset();
  }, everyMs);
  timer.unref();
  return () => { clearInterval(timer); h.disable(); };
}

/**
 * What the camera container last said about itself, in words, or null: docker/camera-entry.sh writes
 * <LOG_DIR>/camera-status.json ({state, at}) before it starts the camera service, and when it cannot (the account is
 * not signed in, the EULA). A note older than maxAgeMs is not believed.
 */
export function cameraStatusNote(dir, { now = Date.now(), maxAgeMs = 10 * 60_000 } = {}) {
  let j;
  try { j = JSON.parse(fs.readFileSync(path.join(dir, 'camera-status.json'), 'utf8')); } catch { return null; }
  const at = Date.parse(j?.at);
  if (!Number.isFinite(at) || now - at > maxAgeMs) return null;
  if (j.state === 'not-signed-in') return 'its Minecraft account is not signed in (run ./setup.sh --camera-login)';
  if (j.state === 'no-eula') return 'the Minecraft EULA has not been accepted (MINECRAFT_EULA in .env)';
  if (j.state === 'installing') return 'it is downloading the Minecraft client (the first start takes a few minutes)';
  if (j.state === 'failed') return 'it could not start (docker compose logs camera)';
  return null;
}

/** Local ports for the guests' live views: {watch, eyes} pairs (3101-3164 and 100 above), each pair once at a time. */
export function viewPorts(first = 3101, count = 64) {
  const used = new Set();
  let next = first;
  return {
    take() {
      for (let i = 0; i < count; i++) {
        const port = next;
        next = next + 1 >= first + count ? first : next + 1;
        if (!used.has(port)) { used.add(port); return { watch: port, eyes: port + 100 }; }
      }
      return null;
    },
    free(pair) { used.delete(pair.watch); },
  };
}

/**
 * The two live views of a guest bot, for people to watch (read-only): from behind under /watch/<view id>/ and
 * through its eyes under /eyes/<view id>/ (the game's unguessable view id; the session id without one), on local ports
 * src/web.js proxies. A port is set on the body (viewerPort, eyesPort) only once its view really listens; both views
 * close and their ports free up when the bot leaves (each mineflayer() call replaces bot.viewer, so each view's close is
 * kept right after it starts).
 * @param {object} body   a body whose bot has joined
 * @param {string} sessionId
 * @param {{log: object, ports: ReturnType<typeof viewPorts>, load?: () => object, onEyes?: (port: number, path: string) => void, viewId?: string}} opts
 *   onEyes runs once the first-person view listens (the live-video stream starts from it), with the view's path
 */
export function startGuestViews(body, sessionId, { log, ports, load = loadViewer, onEyes = null, viewId = null }) {
  if (body.connected === false) return; // it left before its views started
  let viewer;
  try { viewer = load(); } catch { return; }
  if (!viewer) return;
  const pair = ports.take();
  if (!pair) { log.event('viewer_error', { session: sessionId, message: 'no free port for the live views' }); return; }
  const closes = [];
  let ended = false;
  const onError = (err) => log.event('viewer_error', { session: sessionId, message: String(err?.message ?? err).slice(0, 200) });
  const view = (port, firstPerson, prefix, set) => {
    try {
      listeningOn('127.0.0.1', () => viewer.mineflayer(body.bot, { port, firstPerson, viewDistance: 4, prefix }), onError, () => { if (!ended) set(port); });
      const close = body.bot.viewer?.close;
      if (typeof close === 'function') closes.push(close);
    } catch (err) { onError(err); }
  };
  const id = viewId ?? sessionId;
  view(pair.watch, false, `/watch/${id}`, (port) => { body.viewerPort = port; });
  view(pair.eyes, true, `/eyes/${id}`, (port) => {
    body.eyesPort = port;
    try { onEyes?.(port, `/eyes/${id}/`); } catch (err) { onError(err); }
  });
  body.on('end', () => {
    ended = true;
    body.viewerPort = null;
    body.eyesPort = null;
    for (const close of closes) { try { close(); } catch { /* closed */ } }
    ports.free(pair);
  });
}

/**
 * Start everything. Returns {url, publicUrl, log, web, stop}; stop(reason) is the graceful shutdown and may be called
 * more than once.
 * @param {object} [opts]
 * @param {object} [opts.config]         a loadConfig() result (default: from process.env)
 * @param {boolean} [opts.fakeBot]       bots play in the fake world instead of joining the Minecraft server
 * @param {object} [opts.log]            a Logger (default: a JSONL log in LOG_DIR)
 * @param {(line: string) => void} [opts.print]
 * @param {() => object} [opts.loadViewer]   how prismarine-viewer is loaded (tests)
 * @param {object} [opts.streams]        a stream manager or live channel (tests; default: from LIVE_VIEW, null when off)
 * @param {number} [opts.loopStatsMs]    how often the event loop's delay is logged (default 60 s; 0: never)
 * @param {object} [opts.hosts]          the Mine AI host manager for BODY=mineai (tests; default src/mineai/host.js)
 * @param {number} [opts.mcpCallMs]      how long one MCP call may wait (tests; default 45 s)
 */
export async function startAgent(opts = {}) {
  const config = opts.config ?? loadConfig();
  const print = opts.print ?? console.log;
  const log = opts.log ?? createLogger({ config, runId: runId() });
  const createFakeBot = opts.fakeBot ? (await import('../test/fake-bot.js')).createFakeBot : null;
  // BODY=mineai: every guest bot is a Mine AI MCP host of its own (src/mineai/); the fake world always uses ours
  const mineai = config.body.kind === 'mineai' && !createFakeBot;
  // their runtime must be exactly the pin plus every patch of mineai/UPSTREAM.json (the host token of 0004, the player
  // name off the command line of 0005, ...): an older or unpatched folder is refused before anything is served
  if (mineai && !opts.hosts) {
    const built = checkRuntime(config.mineai.dir);
    if (!built.ok) throw new Error(`BODY=mineai: ${built.why}; build the runtime with mineai/fetch-and-patch.sh <new folder> and set MINEAI_DIR to it`);
  }
  const hosts = mineai ? (opts.hosts ?? createHostManager({ config, log })) : null;

  // The live view (LIVE_VIEW=local or facebook): each game goes on the camera's channel once its bot is in the world,
  // and the camera films it only after its live_view asks. The camera runs in the camera service (STREAM_SERVICE_URL),
  // or in this process (STREAM_SERVICE_URL=off), and needs the bot's player name.
  const ports = viewPorts();
  const streams = opts.streams !== undefined ? opts.streams : !config.stream.enabled ? null
    : config.stream.serviceUrl ? createRemoteStreamManager({ url: config.stream.serviceUrl, token: config.stream.serviceToken, log })
      : createCameraManager({ config, log });
  // player names: MC_USERNAME_<game id>, or with MC_WHITELIST a private one (privateName) kept for the game's life
  const names = new Map(); // session id -> player name
  const nameOf = (sessionId) => {
    if (!names.has(sessionId)) names.set(sessionId, config.mc.whitelist ? privateName(config.mc.username) : usernameFor(config.mc.username, sessionId));
    return names.get(sessionId);
  };
  const consolePath = process.env.MC_CONSOLE || null;
  /** On a whitelisted server: put a player on the list (or take it off) through the console. Never throws. */
  const listPlayer = async (how, name) => {
    if (!config.mc.whitelist || !consolePath || createFakeBot) return;
    try { await consoleLine(consolePath, `whitelist ${how} ${name}`); } catch (err) {
      log.event('whitelist_error', { how, name, message: String(err?.message ?? err).slice(0, 200) });
    }
  };
  // Where a new guest bot lands (MC_CONSOLE): a random dry spot up to SPREAD_RANGE blocks from the world spawn, or with
  // SPREAD_SPOTS ("x z; x z; ...", for measurements) the next spot of that list in turn, within a block of it, so every
  // body can be measured at the same fresh spots.
  const spots = spreadSpots(process.env.SPREAD_SPOTS);
  let spotsUsed = 0;
  const spreadLine = (from, username) => {
    if (spots.length) {
      const at = spots[spotsUsed++ % spots.length];
      return `spreadplayers ${at.x} ${at.z} 0 1 false ${username}`;
    }
    const range = Number(process.env.SPREAD_RANGE) || 400;
    return `spreadplayers ${Math.round(from.x)} ${Math.round(from.z)} 16 ${range} false ${username}`;
  };
  /** A game on the camera's channel, once its bot has landed (the camera follows the bot by its player name). */
  const toCamera = (body, sessionId) => {
    if (!streams || createFakeBot) return;
    body.ready.then(() => {
      if (body.connected === false || body.ended) return;
      try { streams.start(sessionId, { body, player: nameOf(sessionId) }); } catch (err) {
        log.event('stream_error', { session: sessionId, message: String(err?.message ?? err).slice(0, 200) });
      }
    }, () => {});
  };
  // live_view: the live view of a game. With a live channel (LIVE_VIEW=local or facebook) the camera is pointed at the
  // game and the call waits, up to waitMs, until the channel shows it live; it stops waiting early when another game has
  // taken the camera since. Returns {channel, fb, state, game, camera, videoUrl, embedUrl, liveSince, error, retryInS}.
  const pause = (ms) => new Promise((r) => { setTimeout(r, ms).unref?.(); });
  const liveView = async (gameId, { waitMs = 0, signal = null } = {}) => {
    if (typeof streams?.focus === 'function') {
      const t0 = Date.now();
      let st = await Promise.resolve(streams.focus(gameId)).catch(() => null);
      if (channelOf(st)) {
        let elsewhere = 0; // since when the camera has been live on another game
        while (Date.now() + 1_000 < t0 + waitMs && !signal?.aborted) {
          if (st.state === 'live' && st.game === gameId) break;
          if (st.state === 'live' && st.game !== gameId) { elsewhere ||= Date.now(); if (Date.now() - elsewhere > 5_000) break; } else elsewhere = 0;
          if ((st.state === 'retrying' || st.state === 'capped') && (st.retryInS ?? 0) * 1_000 > t0 + waitMs - Date.now()) break;
          await pause(1_000);
          st = (await Promise.resolve(streams.live?.()).catch(() => null)) ?? st;
        }
        return { ...st, channel: channelOf(st), camera: st.game ?? null, game: gameId };
      }
      // a channel that does not answer: the camera service is down or still starting (or not signed in: its note)
      return { channel: config.stream.liveView, fb: false, state: 'unreachable', reason: cameraStatusNote(config.log.dir), game: gameId, camera: null, videoUrl: null, embedUrl: null };
    }
    return { channel: null, fb: false, state: 'off', game: gameId, camera: null, videoUrl: null, embedUrl: null };
  };
  // what live_view does: LIVE_VIEW, or for a channel handed in (tests) the kind of channel it is
  const liveMode = !streams ? 'off' : config.stream.liveView !== 'off' ? config.stream.liveView : typeof streams.hlsFile === 'function' ? 'local' : 'facebook';
  // the local watch page: the channel's state, and where its HLS files come from (the camera service, on loopback)
  const watch = liveMode === 'local' ? {
    live: async () => { try { const st = await streams.live?.(); return channelOf(st) ? st : null; } catch { return null; } },
    hlsBase: streams.serviceUrl ?? null,
    hlsToken: config.stream.serviceToken || null,
    hlsFile: typeof streams.hlsFile === 'function' ? (name) => streams.hlsFile(name) : null,
  } : null;
  function newBody(sessionId, { viewId = null } = {}) {
    const username = nameOf(sessionId);
    const cfg = Object.freeze({ ...config, mc: Object.freeze({ ...config.mc, username }) });
    if (createFakeBot) return createBody({ bot: createFakeBot({ scene: 'forest', username }), config: cfg, log });
    if (config.mc.whitelist && consolePath) {
      // on the list first, then join (Paper checks the list at login); off the list once the bot has left
      log.event('bot_name', { session: sessionId, username });
      return listPlayer('add', username)
        .then(() => new Promise((r) => { setTimeout(r, LIST_SETTLE_MS); }))
        .then(() => {
          const body = joinBody(sessionId, username, cfg, viewId);
          body.on('end', () => { names.delete(sessionId); listPlayer('remove', username); });
          return body;
        });
    }
    return joinBody(sessionId, username, cfg, viewId);
  }
  function joinBody(sessionId, username, cfg, viewId) {
    if (mineai) return joinMineAi(sessionId, username, viewId);
    const body = createBody({ config: cfg, log });
    // Every guest bot starts on fresh ground: the server console (MC_CONSOLE) spreads it to a random dry spot up to
    // SPREAD_RANGE blocks from the world spawn, so earlier guests never leave a new one at a stripped spawn. The
    // session counts as ready only once the bot has landed and the chunks around it loaded.
    if (consolePath) {
      const joined = body.ready;
      body.ready = joined.then(async () => {
        const bot = body.bot;
        const sp = bot.spawnPoint ?? bot.entity.position;
        const landed = new Promise((resolve) => bot.once('forcedMove', resolve));
        try {
          await fs.promises.appendFile(consolePath, `${spreadLine(sp, username)}\n`);
        } catch (err) {
          log.event('spread_error', { session: sessionId, message: String(err?.message ?? err).slice(0, 200) });
          return;
        }
        const wait = (ms) => new Promise((r) => setTimeout(r, ms));
        await Promise.race([landed, wait(5_000)]);
        await Promise.race([Promise.resolve(bot.waitForChunksToLoad?.()).catch(() => {}), wait(8_000)]);
        log.event('spread', { session: sessionId, at: bot.entity.position.floored().toString() });
      });
      body.ready.catch(() => {});
    }
    body.ready.then(() => startGuestViews(body, sessionId, { log, ports, load: opts.loadViewer, viewId }), () => {});
    toCamera(body, sessionId);
    return body;
  }

  /**
   * A guest bot in a Mine AI MCP host of its own: the host starts, the bot joins, then (with MC_CONSOLE) it is spread
   * to fresh ground like ours, and its 3D views (when prismarine-viewer is installed) come from inside the host.
   */
  function joinMineAi(sessionId, username, viewId) {
    const body = createMineAiBody({ config, log, hosts, gameId: sessionId, username, viewId, care: config.mineai?.care ?? 'advise' });
    if (consolePath) {
      const joined = body.ready;
      body.ready = joined.then(async () => {
        const from = body.bot.entity?.position;
        if (!from) return;
        try {
          await fs.promises.appendFile(consolePath, `${spreadLine(from, username)}\n`);
        } catch (err) {
          log.event('spread_error', { session: sessionId, message: String(err?.message ?? err).slice(0, 200) });
          return;
        }
        const { scans, notable } = await settleAfterSpread(body, from);
        const at = body.bot.entity?.position;
        log.event('spread', { session: sessionId, at: at ? `${Math.floor(at.x)} ${Math.floor(at.y)} ${Math.floor(at.z)}` : null, scans, notable });
      });
      body.ready.catch(() => {});
      body.deferCare?.(body.ready); // nothing of its own at the spawn: the care starts where the bot was spread to
    }
    toCamera(body, sessionId);
    return body;
  }

  // start_game first asks whether the Minecraft server is up (right after a restart it is not yet): not in the fake world
  const serverReady = opts.serverReady !== undefined ? opts.serverReady
    : opts.fakeBot ? null : createServerReady({ host: config.mc.host, port: config.mc.port, version: config.mc.version });
  const web = createWeb({
    config, log, liveView: streams ? liveView : null, liveMode, watch, mcpCallMs: opts.mcpCallMs, serverReady,
    cameraNote: () => cameraStatusNote(config.log.dir),
    // the HUD under the live video: the lines go to the camera's channel, which draws them for the game on camera
    term: typeof streams?.term === 'function' ? (id, u) => streams.term(id, u) : null,
    ...(mineai ? { skills: MINEAI_SKILLS, careMode: config.mineai.care ?? 'advise', startTimeoutMs: config.mineai.startMs + 30_000 } : {}),
    makeBody: (sessionId, o) => newBody(sessionId, o),
  });
  const { url: listenUrl, localUrl, publicUrl } = await web.start();
  const url = localUrl ?? listenUrl;
  const stopLoopWatch = (opts.loopStatsMs ?? 60_000) > 0 ? watchEventLoop(log, { everyMs: opts.loopStatsMs ?? 60_000 }) : () => {};

  const world = createFakeBot ? 'the fake world (--fake-bot)' : `Minecraft ${config.mc.version} at ${config.mc.host}:${config.mc.port}`;
  if (mineai) print(`body: Mine AI MCP from ${config.mineai.dir}, one host per game on 127.0.0.1:${config.mineai.portBase}+ (at most ${config.mineai.maxHosts})`);
  log.event('serve_start', {
    url, publicUrl, world, maxSessions: config.web.maxSessions, leaseMs: config.web.leaseMs, liveView: config.stream.liveView,
    body: mineai ? 'mineai' : 'ours', mcpKey: Boolean(config.web.accessKey),
  });
  const mcpPath = config.web.accessKey ? '/mcp/<MCP_ACCESS_KEY>' : '/mcp';
  print(`${config.web.name}: ${url}/ (MCP: ${url}${mcpPath})${publicUrl && publicUrl !== url ? ` (public: ${publicUrl}/)` : ''}`);
  print(`world: ${world}; up to ${config.web.maxSessions} bot(s) at once, ${Math.round(config.web.leaseMs / 60_000)} min per game`);
  const longLease = leaseWarning(config.web.leaseMs);
  if (longLease) { print(`note: ${longLease}`); log.event('config_warning', { what: 'lease', leaseMs: config.web.leaseMs, text: longLease }); }
  print(config.web.adminToken ? 'kill switch: POST /admin/stop with "Authorization: Bearer $WEB_ADMIN_TOKEN"' : 'kill switch: set WEB_ADMIN_TOKEN to enable POST /admin/stop');
  if (config.stream.liveView === 'off') print('live view: off (LIVE_VIEW=off)');
  else if (config.stream.serviceUrl) print(`live view: ${config.stream.liveView}, through the camera service at ${config.stream.serviceUrl}`);
  else print(`live view: ${config.stream.liveView}, the camera in this process`);
  if (!config.web.accessKey) print('note: MCP_ACCESS_KEY is not set: /mcp answers only requests that come straight from this machine, never through a tunnel or proxy');
  if (!isLoopbackHost(config.web.host)) print(`note: WEB_HOST=${config.web.host} is reachable from the network; publish only this port`);
  if (config.web.guestPages && !isLoopbackHost(config.web.host)) print('note: WEB_GUEST_PAGES is on: anyone who reaches this port can start bots from /play and /api');
  if (config.web.trustProxy !== 'off' && !config.web.trustedProxies.length && !config.web.proxySecret) {
    print('note: neither WEB_PROXY_SECRET nor WEB_TRUSTED_PROXIES is set, so forwarded headers are believed from any peer that reaches this port (docs/CONFIG.md, "Behind a reverse proxy")');
  }
  if (log.path) {
    const rel = path.relative(process.cwd(), log.path);
    print(`log: ${rel && !rel.startsWith('..') ? rel : log.path}`);
  }

  let stopping = null;
  function stop(reason = 'shutdown') {
    stopping ??= (async () => {
      log.event('serve_stop', { reason });
      stopLoopWatch();
      await web.stop(); // ends every session and closes its bot
      if (streams) await within(streams.stopAll(reason), 12_000);
      if (hosts) await within(hosts.closeAll(reason), 12_000);
      log.close();
    })();
    return stopping;
  }

  return { url: listenUrl, localUrl: url, publicUrl, log, web, streams, stop };
}

/** The CLI: start, then wait for SIGINT/SIGTERM. Returns an exit code. */
export async function main(argv = process.argv.slice(2), { print = console.log, printErr = console.error } = {}) {
  let values;
  try {
    ({ values } = parseArgs({ args: argv, strict: true, options: { 'fake-bot': { type: 'boolean' }, help: { type: 'boolean', short: 'h' } } }));
  } catch (err) {
    printErr(`${err.message}\n\n${USAGE}`);
    return 2;
  }
  if (values.help) { print(USAGE); return 0; }

  let agent;
  // one stray rejection (a library's async handler) must not take down every guest's bot: log it and go on
  process.on('unhandledRejection', (err) => {
    const message = String(err?.stack ?? err?.message ?? err).slice(0, 500);
    try { agent?.log.event('unhandled_rejection', { message }); } catch { /* logging is best effort */ }
    printErr(`unhandled rejection (the service goes on): ${message}`);
  });
  try {
    agent = await startAgent({ config: loadConfig(), fakeBot: Boolean(values['fake-bot']), print });
  } catch (err) {
    printErr(`could not start: ${err.message}`);
    return 1;
  }
  print('Ctrl-C stops everything.');

  const signal = await new Promise((resolve) => {
    process.once('SIGINT', () => resolve('SIGINT'));
    process.once('SIGTERM', () => resolve('SIGTERM'));
  });
  print(`\n${signal}: stopping (games end, bots leave, the log is written)...`);
  const again = () => { printErr('second signal: exiting now'); process.exit(130); };
  process.once('SIGINT', again);
  process.once('SIGTERM', again);
  const late = setTimeout(() => { printErr('shutdown took longer than 15 s; exiting'); process.exit(1); }, 15_000);
  late.unref();
  await agent.stop(signal);
  clearTimeout(late);
  print('stopped.');
  return 0;
}

const isMain = process.argv[1] && import.meta.url === pathToFileURL(path.resolve(process.argv[1])).href;
if (isMain) {
  process.exitCode = await main();
  // a real mineflayer connection can keep the event loop alive for a moment after quit()
  setTimeout(() => process.exit(process.exitCode), 1_000).unref();
}
