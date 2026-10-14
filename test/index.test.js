// test/index.test.js - the whole agent wired by src/index.js, in the fake world: a guest session drives its own bot
// over /api, the log is written, and stop() (and SIGINT on the real CLI) shuts everything down. No Minecraft server.

import { test } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import http from 'node:http';
import { spawn } from 'node:child_process';
import { fileURLToPath } from 'node:url';

import { loadConfig } from '../src/config.js';
import { createLogger, readJsonl } from '../src/log.js';
import { EventEmitter } from 'node:events';
import { createRequire } from 'node:module';
import { startAgent, usernameFor, privateName, listeningOn, loadViewer, startGuestViews, viewPorts, spreadSpots, leaseWarning, settleAfterSpread, SPREAD_SCAN_MS } from '../src/index.js';
import { consoleLine } from '../src/stations.js';

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
async function until(fn, ms = 5_000) {
  const t0 = Date.now();
  while (!(await fn())) {
    if (Date.now() - t0 > ms) throw new Error('timed out waiting');
    await sleep(10);
  }
}
const json = (url, method = 'GET', body) => fetch(url, {
  method, headers: { 'content-type': 'application/json' }, body: body === undefined ? undefined : JSON.stringify(body),
});
const freePort = () => new Promise((resolve) => {
  const s = http.createServer().listen(0, '127.0.0.1', () => { const { port } = s.address(); s.close(() => resolve(port)); });
});

test('SPREAD_SPOTS: pairs of whole block coordinates, in order; anything else is refused', () => {
  assert.deepEqual(spreadSpots(undefined), []);
  assert.deepEqual(spreadSpots('  '), []);
  assert.deepEqual(spreadSpots('1800 0; -1263 3049'), [{ x: 1800, z: 0 }, { x: -1263, z: 3049 }]);
  assert.deepEqual(spreadSpots('1800,0 -1263,3049'), [{ x: 1800, z: 0 }, { x: -1263, z: 3049 }]);
  assert.throws(() => spreadSpots('1800 0; 5'), /pairs of whole/);
  assert.throws(() => spreadSpots('1800.5 0'), /pairs of whole/);
  assert.throws(() => spreadSpots('a b'), /pairs of whole/);
});

// A spread bot on a new world (the first stack run, 2026-10-13): the chunks at the new spot arrive seconds after it
// lands, and a scan before them sees nothing, so the first state had no wood. A fake clock: wait() only advances it.
function spreadBody({ landAfter = 2, emptyScans = 0 } = {}) {
  let refreshes = 0;
  let scans = 0;
  let seen = [];
  const body = {
    bot: { entity: { position: { x: 0, y: 80, z: 0 } } },
    refresh: async () => { refreshes += 1; if (refreshes >= landAfter) body.bot.entity.position = { x: 291, y: 92, z: 182 }; },
    rescan: async () => { scans += 1; seen = scans > emptyScans ? [{ name: 'stone', count: 64 }, { name: 'oak_log', count: 9 }] : []; },
    snapshot: () => ({ nearbyBlocks: seen }),
  };
  return body;
}
function fakeClock() {
  const c = { t: 0, waits: [] };
  c.wait = async (ms) => { c.waits.push(ms); if (ms !== 10_000) c.t += ms; }; // the rescan's 10 s cap never wins here
  c.now = () => c.t;
  return c;
}

test('spread: the first scan of the new spot is read once it sees something; an empty one (chunks not there yet) is tried again, bounded', async () => {
  const c = fakeClock();
  assert.deepEqual(await settleAfterSpread(spreadBody({ emptyScans: 0 }), { x: 0, z: 0 }, c), { scans: 1, notable: 2 }, 'chunks there at once: one scan');
  assert.equal(c.waits.filter((ms) => ms === 500).length, 2, 'landed at the second look');

  const c2 = fakeClock();
  assert.deepEqual(await settleAfterSpread(spreadBody({ emptyScans: 3 }), { x: 0, z: 0 }, c2), { scans: 4, notable: 2 }, 'three empty scans, then the chunks');
  assert.equal(c2.waits.filter((ms) => ms === 2_000).length, 3, '2 s between scans');

  const c3 = fakeClock();
  const r = await settleAfterSpread(spreadBody({ emptyScans: 1e9 }), { x: 0, z: 0 }, c3);
  assert.equal(r.notable, 0, 'never anything: gives up');
  assert.equal(r.scans, SPREAD_SCAN_MS / 2_000 + 1, 'after SPREAD_SCAN_MS of scans');

  const c4 = fakeClock();
  const noSnap = { ...spreadBody(), snapshot: undefined };
  assert.deepEqual(await settleAfterSpread(noSnap, { x: 0, z: 0 }, c4), { scans: 1, notable: 1 }, 'a body without snapshot(): one scan, as before');
});

test('usernames: every game gets a valid name of its own', () => {
  assert.equal(usernameFor('Bot', 'g1a2b3c'), 'Bot_g1a2b3c');
  const long = usernameFor('ABCDEFGHIJKLMNOP', 'g1a2b3c');
  assert.equal(long, 'ABCDEFGH_g1a2b3c');
  for (const name of [long, usernameFor('Bot', 'g-!'), usernameFor('Abc', '')]) assert.match(name, /^[A-Za-z0-9_]{3,16}$/);
  // on a server that lets in only listed players (MC_WHITELIST): a name nobody can guess, not the game id
  const names = new Set(Array.from({ length: 50 }, () => privateName('Bot')));
  assert.equal(names.size, 50);
  for (const name of names) assert.match(name, /^Bot_[A-Za-z0-9]{12}$/);
  assert.match(privateName('Tst_fx'), /^Tst_fx_[A-Za-z0-9]{9}$/);
  assert.match(privateName('ABCDEFGHIJKLMNOP'), /^ABCDEFGH_[A-Za-z0-9]{7}$/);
  assert.equal(loadConfig({}).mc.whitelist, false);
  assert.equal(loadConfig({ MC_WHITELIST: 'true' }).mc.whitelist, true);
});

test('server console: only the fixed command shapes go to the FIFO (station removal, whitelist add and remove)', async () => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'console-'));
  const file = path.join(dir, 'console.in');
  fs.writeFileSync(file, '');
  await consoleLine(file, 'whitelist add Bot_aB3dE5gH7jK');
  await consoleLine(file, 'whitelist remove Tst_fx_g1a2b3c');
  for (const bad of ['whitelist add Bad Name', 'whitelist add x', 'op the agent', 'whitelist off', 'whitelist add the agent\nop the agent']) {
    await assert.rejects(consoleLine(file, bad), /refused console line/, bad);
  }
  assert.deepEqual(fs.readFileSync(file, 'utf8').trim().split('\n'), ['whitelist add Bot_aB3dE5gH7jK', 'whitelist remove Tst_fx_g1a2b3c']);
  fs.rmSync(dir, { recursive: true, force: true });
});

test('listeningOn: a server started inside listens on the given host only, and the patch is removed again', async () => {
  const inside = await new Promise((resolve) => {
    listeningOn('127.0.0.1', () => { const s = http.createServer().listen(0, () => resolve(s)); });
  });
  assert.equal(inside.address().address, '127.0.0.1');
  inside.close();
  assert.equal(Object.hasOwn(http.Server.prototype, 'listen'), false, 'the patch is removed again');
});

// prismarine-viewer is optional (its textures are Mojang's, so it is no dependency of this project)
let hasViewer = true;
try { createRequire(import.meta.url).resolve('prismarine-viewer/package.json'); } catch { hasViewer = false; }

test('live views are read-only: a watcher\'s mouseClick (no payload, or a NaN ray) reaches nothing', { skip: !hasViewer && 'prismarine-viewer is not installed (optional)' }, async () => {
  const require = createRequire(import.meta.url);
  const { Vec3 } = require('vec3');
  const { io } = require('socket.io-client');
  const { mineflayer } = loadViewer();
  const bot = new EventEmitter();
  Object.assign(bot, { version: '1.21.4', entity: { position: new Vec3(0, 64, 0), yaw: 0, pitch: 0 }, entities: {}, username: 'Tst_view' });
  let rays = 0;
  bot.world = { getColumnAt: async () => null, raycast: () => { rays += 1; return null; } };
  const rejections = [];
  const onRejection = (e) => rejections.push(e);
  process.on('unhandledRejection', onRejection);
  const port = await new Promise((resolve) => {
    listeningOn('127.0.0.1', () => mineflayer(bot, { port: 0, prefix: '/eyes/gtest' }), () => {}, (srv) => resolve(srv.address().port));
  });
  const socket = io(`http://127.0.0.1:${port}`, { path: '/eyes/gtest/socket.io', transports: ['websocket'] });
  try {
    await new Promise((resolve, reject) => { socket.on('connect', resolve); socket.on('connect_error', reject); });
    socket.emit('mouseClick');
    socket.emit('mouseClick', { origin: { x: 0, y: 64, z: 0 }, direction: {} });
    await sleep(300);
    assert.equal(rays, 0, 'no raycast for a click');
    assert.deepEqual(rejections, []);
  } finally {
    socket.close();
    bot.viewer.close();
    process.off('unhandledRejection', onRejection);
  }
});

test('guest views: both close and free their ports when the bot leaves; a port in use is never handed to the proxy', async () => {
  const config = loadConfig({});
  const log = createLogger({ dir: null, config });
  const servers = [];
  const fakeViewer = {
    // like prismarine-viewer: every call replaces bot.viewer with its own close
    mineflayer(bot, o) {
      const server = http.createServer().listen(o.port, () => {});
      servers.push(server);
      bot.viewer = new EventEmitter();
      bot.viewer.close = () => server.close();
    },
  };
  const makeBody = () => Object.assign(new EventEmitter(), { bot: {}, connected: true });
  const [w, e] = [await freePort(), await freePort()];
  const ports = { pairs: [{ watch: w, eyes: e }], take() { return this.pairs.shift() ?? null; }, free(pair) { this.pairs.push(pair); } };
  const body = makeBody();
  startGuestViews(body, 'g1', { log, ports, load: () => fakeViewer });
  await until(() => body.viewerPort === w && body.eyesPort === e);
  body.emit('end');
  await until(() => servers.every((s) => !s.listening));
  assert.equal(body.viewerPort, null);
  assert.deepEqual(ports.pairs, [{ watch: w, eyes: e }], 'the ports are free again');

  // the watch port is taken by another program: the proxy never gets it
  const other = http.createServer().listen(w, '127.0.0.1');
  await until(() => other.listening);
  const next = makeBody();
  startGuestViews(next, 'g2', { log, ports, load: () => fakeViewer });
  await until(() => next.eyesPort === e);
  await until(() => log.tail().some((r) => r.kind === 'viewer_error' && /EADDRINUSE/.test(r.message)));
  assert.equal(next.viewerPort, undefined, 'no proxy to a port this bot does not own');
  next.emit('end');
  other.close();

  const pairs = viewPorts(4000, 2);
  assert.deepEqual([pairs.take(), pairs.take(), pairs.take()], [{ watch: 4000, eyes: 4100 }, { watch: 4001, eyes: 4101 }, null]);
  pairs.free({ watch: 4000, eyes: 4100 });
  assert.deepEqual(pairs.take(), { watch: 4000, eyes: 4100 });
});

test('startAgent --fake-bot: a guest plays over /api, the event loop delay is logged, stop() ends it all', async () => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'mcagent-index-'));
  let agent = null;
  try {
    const config = loadConfig({ WEB_HOST: '127.0.0.1', WEB_PORT: '0', LOG_DIR: path.join(dir, 'logs'), WEB_GUEST_PAGES: 'on' });
    const lines = [];
    agent = await startAgent({ config, fakeBot: true, print: (l) => lines.push(l), loadViewer: () => null, loopStatsMs: 50 });
    const { url } = agent;
    assert.match(lines.join('\n'), /^Agent game server: http:\/\/127\.0\.0\.1:\d+\/ \(MCP: http:\/\/127\.0\.0\.1:\d+\/mcp\)$/m);
    assert.match(lines.join('\n'), /fake world/);
    assert.match(lines.join('\n'), /live view: off/);
    assert.match(lines.join('\n'), /MCP_ACCESS_KEY is not set/);

    const home = await fetch(`${url}/`);
    assert.equal(home.status, 200);
    const page = await home.text();
    assert.match(page, /<h1>Agent game server<\/h1>/);
    assert.match(page, /NOT AN OFFICIAL MINECRAFT SERVICE/);
    assert.match(page, /Not affiliated with, endorsed by or sponsored by Meta Platforms, Mojang Studios or Microsoft/);

    // a guest gets a bot of its own and drives it
    const started = await json(`${url}/api/session`, 'POST', { adult: true });
    assert.equal(started.status, 201);
    const { token } = await started.json();
    await until(async () => (await (await json(`${url}/api/${token}/state`)).json()).session.status === 'ready');
    const act = await json(`${url}/api/${token}/collect`, 'POST', { block: 'oak_log', n: 3 });
    assert.equal(act.status, 200);
    const done = await act.json();
    assert.equal(done.ok, true, done.result);
    assert.deepEqual(done.delta, { oak_log: 3 });
    assert.match(done.state, /oak_log 3/);
    await until(() => agent.log.tail(200).some((r) => r.kind === 'loop_delay'));
    const row = agent.log.tail(200).find((r) => r.kind === 'loop_delay');
    for (const k of ['p50Ms', 'p99Ms', 'maxMs']) assert.ok(Number.isFinite(row[k]) && row[k] >= 0, `${k} ${row[k]}`);

    await agent.stop('test');
    await agent.stop('twice is fine');
    await assert.rejects(fetch(`${url}/`), 'the server is closed');
    const rows = readJsonl(agent.log.path);
    const kinds = rows.map((r) => r.kind ?? r.type);
    for (const k of ['serve_start', 'web_start', 'session_start', 'viewer_action', 'serve_stop', 'session_end', 'web_stop']) {
      assert.ok(kinds.includes(k), `log has ${k}`);
    }
    assert.ok(!fs.readFileSync(agent.log.path, 'utf8').includes(token), 'the session token never reaches the log');
    agent = null;
  } finally {
    await agent?.stop('cleanup');
    fs.rmSync(dir, { recursive: true, force: true });
  }
});

test('npm start --fake-bot: serves the page, then SIGINT shuts down cleanly with exit code 0', async () => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'mcagent-serve-'));
  const env = Object.fromEntries(Object.entries(process.env).filter(([k]) => !/^(MC_|WEB_|MCP_|LIVE_VIEW|STREAM_|FB_|LOG_DIR)/.test(k)));
  Object.assign(env, { WEB_HOST: '127.0.0.1', WEB_PORT: '0', LOG_DIR: path.join(dir, 'logs') });
  const child = spawn(process.execPath, [path.join(ROOT, 'src', 'index.js'), '--fake-bot'], { env, stdio: ['ignore', 'pipe', 'pipe'] });
  let out = '';
  let err = '';
  child.stdout.on('data', (d) => { out += d; });
  child.stderr.on('data', (d) => { err += d; });
  const exited = new Promise((resolve) => child.on('exit', (code, signal) => resolve({ code, signal })));
  const killer = setTimeout(() => child.kill('SIGKILL'), 20_000);
  try {
    await until(() => /Ctrl-C stops everything/.test(out), 15_000);
    const url = out.match(/Agent game server: (http:\/\/127\.0\.0\.1:\d+)\//)?.[1];
    assert.ok(url, out);
    assert.equal((await fetch(`${url}/`)).status, 200);
    child.kill('SIGINT');
    const { code } = await exited;
    assert.equal(code, 0, `exit code\n${out}\n${err}`);
    assert.match(out, /SIGINT: stopping/);
    assert.match(out, /stopped\./);
    const log = fs.readdirSync(path.join(dir, 'logs')).find((f) => /^run-serve-.*\.jsonl$/.test(f));
    assert.ok(log, 'a serve log was written');
    assert.ok(readJsonl(path.join(dir, 'logs', log)).some((r) => r.kind === 'serve_stop' && r.reason === 'SIGINT'));
  } finally {
    clearTimeout(killer);
    if (child.exitCode === null) child.kill('SIGKILL');
    fs.rmSync(dir, { recursive: true, force: true });
  }
});

test('a lease longer than 2 hours is warned about at start', () => {
  assert.equal(leaseWarning(3_600_000), null);
  assert.equal(leaseWarning(7_200_000), null);
  assert.match(leaseWarning(14_400_000), /^a game lasts up to 240 min \(GAME_LEASE_MIN\): each bot keeps its memory that long/);
});
