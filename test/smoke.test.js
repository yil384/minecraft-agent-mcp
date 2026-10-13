// test/smoke.test.js - the skeleton holds together: config defaults and guards (the access key, the live view
// modes), tool schemas and the argument validator, and the logger (secrets scrubbed).

import { test } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { inspect } from 'node:util';

import { loadConfig, ConfigError, isLanHost, isLocalUrl, watchKeyOf, defaultGateway } from '../src/config.js';
import { TOOLS, TOOL_NAMES, SCHEMAS, validateArgs, parseArgs, coerceArgs, toolsForApi, inventoryDelta } from '../src/contracts.js';
import * as game from '../src/game.js';
import { registryFor } from '../src/mc.js';
import { createLogger, readJsonl, scrub } from '../src/log.js';

const KEY = '0123456789abcdef0123456789abcdef';

test('config: defaults, guards, the access key and the admin token never printable', () => {
  const c = loadConfig({});
  assert.equal(c.mc.host, '127.0.0.1');
  assert.equal(c.mc.version, '1.21.4');
  assert.equal(c.mc.username, 'Bot');
  assert.equal(c.web.host, '127.0.0.1');
  assert.equal(c.web.name, 'Agent game server');
  assert.equal(c.web.leaseMs, 3_600_000, 'a game lasts 60 min on your own machine');
  assert.equal(c.web.idleMs, 600_000);
  assert.equal(c.web.maxSessions, 2);
  assert.equal(c.web.mcpGamesPerAddress, 2);
  assert.equal(c.web.guestPages, false, 'the zero-JS pages are off unless asked for');
  assert.equal(c.stream.liveView, 'off');
  assert.equal(c.stream.enabled, false);
  assert.equal(c.fb.live, false);
  assert.ok(Object.isFrozen(c) && Object.isFrozen(c.web) && Object.isFrozen(c.stream));
  assert.equal(loadConfig({ GAME_LEASE_MIN: '30', MAX_GAMES: '4' }).web.leaseMs, 1_800_000);
  assert.equal(loadConfig({ GAME_LEASE_MIN: '30', MAX_GAMES: '4' }).web.maxSessions, 4);
  assert.equal(loadConfig({ WEB_LEASE_MS: '120000', GAME_LEASE_MIN: '30' }).web.leaseMs, 120_000, 'the old name in ms wins');
  assert.throws(() => loadConfig({ GAME_LEASE_MIN: '0' }), /GAME_LEASE_MIN/);

  assert.throws(() => loadConfig({ MC_HOST: 'play.example.com' }), /localhost or a LAN/);
  assert.ok(isLanHost('192.168.1.20') && isLanHost('localhost') && !isLanHost('8.8.8.8'));
  assert.ok(isLocalUrl('http://127.0.0.1:9/v1') && !isLocalUrl('https://example.org/v1'));

  // the MCP access key: required as soon as the port is not this machine's loopback; never printable
  assert.throws(() => loadConfig({ WEB_HOST: '0.0.0.0' }), /MCP_ACCESS_KEY is required/);
  assert.throws(() => loadConfig({ MCP_ACCESS_KEY: 'short' }), /MCP_ACCESS_KEY must be/);
  const open = loadConfig({ WEB_HOST: '0.0.0.0', MCP_ACCESS_KEY: KEY });
  assert.equal(open.web.guestPages, false, 'the zero-JS pages are off on a port others reach');
  assert.equal(loadConfig({ WEB_HOST: '0.0.0.0', MCP_ACCESS_KEY: KEY, WEB_GUEST_PAGES: 'on' }).web.guestPages, true);

  assert.equal(c.web.trustProxy, 'off', 'no proxy header is trusted unless configured');
  assert.equal(loadConfig({ WEB_TRUST_PROXY: 'cloudflare' }).web.trustProxy, 'cloudflare');
  assert.equal(loadConfig({ WEB_TRUST_PROXY: '2' }).web.trustProxy, 2);
  assert.throws(() => loadConfig({ WEB_TRUST_PROXY: 'yes' }), /WEB_TRUST_PROXY/);
  assert.throws(() => loadConfig({ WEB_ADMIN_TOKEN: 'a' }), /at least 24 characters/);
  assert.throws(() => loadConfig({ SERVER_NAME: '<b>x</b>' }), /SERVER_NAME/);
  const k = loadConfig({ MCP_ACCESS_KEY: KEY, WEB_ADMIN_TOKEN: 'admin-token-123456789012345' });
  assert.equal(k.web.accessKey, KEY);
  for (const text of [JSON.stringify(k), inspect(k, { depth: 9 }), String(Object.keys(k.web))]) {
    assert.ok(!text.includes(KEY) && !text.includes('admin-token'), 'secrets must not be printable');
  }
});

test('config: LIVE_VIEW decides the camera\'s settings; the camera process is the service, the agent its client', () => {
  const agentLocal = loadConfig({ LIVE_VIEW: 'local', STREAM_SERVICE_TOKEN: 'svc-token-for-the-tests-0123456789' });
  assert.equal(agentLocal.stream.enabled, true);
  assert.equal(agentLocal.stream.serviceUrl, 'http://127.0.0.1:7862');
  assert.equal(agentLocal.stream.hls, true);
  assert.equal(agentLocal.fb.live, false);
  const cameraEnv = { LIVE_VIEW: 'local', STREAM_ROLE: 'camera', MC_CONSOLE: '/console/console.in', CAMERA_AUTH_DIR: '/auth' };
  const cam = loadConfig(cameraEnv);
  assert.equal(cam.stream.serviceUrl, '', 'the camera is the service');
  assert.throws(() => loadConfig({ LIVE_VIEW: 'local', STREAM_ROLE: 'camera' }), /MC_CONSOLE[\s\S]*CAMERA_AUTH_DIR/);
  const fb = loadConfig({ LIVE_VIEW: 'facebook', STREAM_SERVICE_TOKEN: 'svc-token-for-the-tests-0123456789' });
  assert.equal(fb.fb.live, true);
  assert.equal(fb.fb.target, 'me', 'a profile by default: a new Page cannot go live for 60 days');
  assert.equal(fb.fb.deleteAfter, true);
  assert.deepEqual([fb.fb.maxPerHour, fb.fb.maxPerDay], [4, 12], 'conservative caps by default');
  assert.equal(fb.fb.title, 'Agent game server: an AI agent plays Minecraft');
  assert.throws(() => loadConfig({ ...cameraEnv, LIVE_VIEW: 'facebook' }), /FB_TOKEN_FILE/);
  assert.throws(() => loadConfig({ ...cameraEnv, LIVE_VIEW: 'facebook', FB_TOKEN_FILE: '/x', FB_TARGET: 'page' }), /FB_PAGE_ID/);
  assert.equal(loadConfig({ ...cameraEnv, LIVE_VIEW: 'facebook', FB_TOKEN_FILE: '/x', INSTALL_ID: 'abcd1234' }).fb.installId, 'abcd1234');
  assert.throws(() => loadConfig({ INSTALL_ID: 'no spaces' }), /INSTALL_ID/);
  assert.throws(() => loadConfig({ LIVE_VIEW: 'youtube' }), /LIVE_VIEW must be one of off, local, facebook/);
  assert.throws(() => loadConfig({ LIVE_VIEW: 'local', STREAM_SERVICE_URL: 'http://example.org:7862' }), /STREAM_SERVICE_URL/);
  assert.equal(loadConfig({ LIVE_VIEW: 'local', STREAM_SERVICE_URL: 'off', MC_CONSOLE: '/c', CAMERA_AUTH_DIR: '/a' }).stream.serviceUrl, '', 'off: the camera in the agent\'s own process');
  assert.ok(ConfigError);
});

test('config: the watch key, the camera service token, the host names, the local peers, your own Azure app', () => {
  // the camera watch page has its own key: WATCH_KEY, or derived from the access key (never the access key itself)
  const k = loadConfig({ MCP_ACCESS_KEY: KEY });
  assert.equal(k.web.watchKey, watchKeyOf(KEY));
  assert.match(k.web.watchKey, /^[0-9a-f]{32}$/);
  assert.notEqual(k.web.watchKey, KEY);
  assert.equal(loadConfig({ MCP_ACCESS_KEY: KEY, WATCH_KEY: 'w-0123456789abcdef' }).web.watchKey, 'w-0123456789abcdef');
  assert.throws(() => loadConfig({ MCP_ACCESS_KEY: KEY, WATCH_KEY: KEY }), /WATCH_KEY must differ from MCP_ACCESS_KEY/);
  assert.throws(() => loadConfig({ WATCH_KEY: 'short' }), /WATCH_KEY must be/);
  assert.equal(loadConfig({}).web.watchKey, '', 'no key, no camera page');
  for (const text of [JSON.stringify(k), inspect(k, { depth: 9 })]) assert.ok(!text.includes(k.web.watchKey), 'the watch key is not printable');
  // the agent and the camera service share a token
  assert.throws(() => loadConfig({ LIVE_VIEW: 'local' }), /needs STREAM_SERVICE_TOKEN/);
  assert.throws(() => loadConfig({ STREAM_SERVICE_TOKEN: 'short' }), /STREAM_SERVICE_TOKEN must be at least 24/);
  assert.equal(loadConfig({ LIVE_VIEW: 'local', STREAM_SERVICE_URL: 'off', MC_CONSOLE: '/c', CAMERA_AUTH_DIR: '/a' }).stream.serviceUrl, '', 'the camera in this process needs no token');
  assert.equal(JSON.stringify(loadConfig({ STREAM_SERVICE_TOKEN: 't'.repeat(30) })).includes('t'.repeat(30)), false);
  // host names and local peers
  assert.deepEqual(loadConfig({ WEB_ALLOWED_HOSTS: 'Box.LAN, .home.example' }).web.allowedHosts, ['box.lan', '.home.example']);
  assert.throws(() => loadConfig({ WEB_ALLOWED_HOSTS: 'http://x.example' }), /WEB_ALLOWED_HOSTS/);
  assert.deepEqual(loadConfig({ WEB_LOCAL_PEERS: 'gateway, 172.17.0.0/16' }).web.localPeers, ['gateway', '172.17.0.0/16']);
  assert.throws(() => loadConfig({ WEB_LOCAL_PEERS: 'the-host' }), /WEB_LOCAL_PEERS/);
  assert.throws(() => loadConfig({ WEB_LOCAL_URL: 'ftp://x' }), /WEB_LOCAL_URL/);
  // the default gateway, as a container sees it (little-endian hex in /proc/net/route)
  const route = path.join(fs.mkdtempSync(path.join(os.tmpdir(), 'route-')), 'route');
  fs.writeFileSync(route, 'Iface\tDestination\tGateway \tFlags\tRefCnt\tUse\tMetric\tMask\t\tMTU\tWindow\tIRTT\neth0\t00000000\t010011AC\t0003\t0\t0\t0\t00000000\t0\t0\t0\neth0\t000011AC\t00000000\t0001\t0\t0\t0\t0000FFFF\t0\t0\t0\n');
  assert.equal(defaultGateway(route), '172.17.0.1');
  assert.equal(defaultGateway('/nonexistent'), null);
  // your own Azure app for the camera's sign-in
  assert.equal(loadConfig({ CAMERA_MSA_CLIENT_ID: '01234567-89ab-cdef-0123-456789abcdef' }).stream.camera.msaClientId, '01234567-89ab-cdef-0123-456789abcdef');
  assert.throws(() => loadConfig({ CAMERA_MSA_CLIENT_ID: 'not-a-client-id' }), /CAMERA_MSA_CLIENT_ID/);
});

test('contracts: 10 strict tools, every name is real in 1.21.4, validator', () => {
  assert.deepEqual(TOOL_NAMES, ['get_state', 'go_to', 'collect', 'craft', 'smelt', 'place', 'build', 'attack', 'eat', 'say']);
  const strict = (s, where) => {
    if (s.type !== 'object') return;
    assert.equal(s.additionalProperties, false, `${where} closes`);
    assert.deepEqual([...s.required].sort(), Object.keys(s.properties).sort(), `${where} requires every key`);
    for (const [k, v] of Object.entries(s.properties)) {
      strict(v, `${where}.${k}`);
      if (v.type === 'integer') assert.ok(Number.isFinite(v.minimum) && Number.isFinite(v.maximum), `${where}.${k} bounded`);
    }
  };
  for (const t of TOOLS) {
    assert.equal(t.type, 'function');
    assert.equal(t.function.strict, true);
    strict(t.function.parameters, t.function.name);
  }
  assert.ok(Object.isFrozen(TOOLS[0].function.parameters));

  const reg = registryFor('1.21.4');
  const blocks = [...game.COLLECTABLE_BLOCKS, ...game.PLACEABLE_BLOCKS, ...game.BUILD_MATERIALS];
  const items = [...game.CRAFTABLE_ITEMS, ...game.SMELTABLE_ITEMS, ...Object.values(game.SMELT), ...Object.keys(game.FUEL)];
  for (const b of blocks) assert.ok(reg.blocksByName[b], `block ${b} exists`);
  for (const i of items) assert.ok(reg.itemsByName[i], `item ${i} exists`);
  for (const i of game.CRAFTABLE_ITEMS) assert.ok(reg.recipes[reg.itemsByName[i].id], `${i} has a recipe`);
  for (const m of game.ATTACK_TARGETS.filter((t) => t !== 'nearest_hostile')) assert.ok(reg.entitiesByName[m], `mob ${m} exists`);
  assert.equal(game.blueprintBlockCount('hut_3x3'), 23);

  assert.deepEqual(validateArgs('collect', { block: 'oak_log', n: 4 }), { ok: true, args: { block: 'oak_log', n: 4 } });
  assert.deepEqual(validateArgs('get_state', {}), { ok: true, args: {} });
  for (const [tool, args, why] of [
    ['collect', { block: 'bedrock', n: 1 }, /not allowed/],
    ['collect', { block: 'oak_log', n: 65 }, /from 1 to 64/],
    ['collect', { block: 'oak_log', n: 2.5 }, /integer/],
    ['collect', { block: 'oak_log' }, /required/],
    ['collect', { block: 'oak_log', n: 1, extra: 1 }, /not allowed/],
    ['say', { text: '/op the agent' }, /not allowed/],
    ['say', { text: 'hi\nthere' }, /control/],
    ['place', { block: 'dirt', pos: { x: 1, y: 400, z: 0 } }, /-64 to 320/],
    ['exec', {}, /unknown tool/],
    ['eat', null, /./],
  ]) {
    const r = validateArgs(tool, args ?? 'not-an-object');
    assert.equal(r.ok, false, `${tool} ${JSON.stringify(args)}`);
    assert.match(r.error, why);
  }
  assert.equal(parseArgs('eat', '').ok, true);
  assert.match(parseArgs('collect', '{"block":').error, /not valid JSON/);
  assert.equal(parseArgs('collect', '{"__proto__":{"x":1},"block":"oak_log","n":1}').ok, false);
  assert.deepEqual(coerceArgs('place', { block: 'dirt', 'pos.x': '3', 'pos.y': '64', 'pos.z': '-2', submit: 'Place' }),
    { ok: true, args: { block: 'dirt', pos: { x: 3, y: 64, z: -2 } } });
  assert.deepEqual(coerceArgs('collect', { block: ' oak_log ', n: '10' }), { ok: true, args: { block: 'oak_log', n: 10 } });

  const basic = toolsForApi('basic');
  assert.equal(JSON.stringify(basic).includes('"minimum"'), false);
  assert.match(basic.find((t) => t.function.name === 'collect').function.parameters.properties.n.description, /minimum 1/);
  assert.deepEqual(inventoryDelta({ oak_log: 4, stick: 1 }, { oak_log: 1, stick: 1, oak_planks: 12 }), { oak_log: -3, oak_planks: 12 });
  assert.ok(SCHEMAS.build.properties.blueprint.enum.includes('hut_3x3'));
});

test('logger: JSONL event rows, secrets scrubbed', () => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'mcagent-log-'));
  const cfg = loadConfig({ MCP_ACCESS_KEY: KEY, WEB_ADMIN_TOKEN: 'admin-token-123456789012345' });
  const log = createLogger({ dir, config: cfg, runId: 'smoke' });
  const seen = [];
  log.subscribe((r) => seen.push(r));
  log.event('run_start', { goal: 'iron_pickaxe' });
  const row = log.event('mcp_call', { tool: 'play', result: `got 4 logs /mcp/${KEY} Bearer abc.def admin-token-123456789012345` });
  for (const f of ['time', 'type', 'kind', 'run', 'elapsedMs', 'tool', 'result']) assert.ok(f in row, `row has ${f}`);
  const text = fs.readFileSync(log.path, 'utf8');
  assert.ok(!text.includes(KEY) && !text.includes('abc.def') && !text.includes('admin-token'));
  assert.equal(readJsonl(log.path).length, 2);
  assert.equal(seen.length, 2);
  assert.equal(log.tail(1)[0].kind, 'mcp_call');
  assert.equal(scrub('key sk-abcdefghijklmnopqrstuv'), 'key [redacted]');
  fs.rmSync(dir, { recursive: true, force: true });
});
