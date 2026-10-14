// test/watch.test.js - the local watch page (LIVE_VIEW=local): the channel (src/live-local.js: on demand only, one
// camera, first come, first served, its HLS folder emptied when nothing is filmed), MCP live_view
// in local mode (the watch page's link, never a player), the page and its routes in src/web.js (the page with its CSP,
// hls.js and the page script from this server, the status in words, the HLS files, a game's page only while the camera
// films it, unknown and ended ids, the camera page under the access key), and end to end with real ffmpeg: a test
// pattern through the camera stream as HLS, the camera service, the agent's proxy, to segments a player can play.
// No Minecraft, no account, no network beyond loopback.

import { test } from 'node:test';
import assert from 'node:assert/strict';
import { EventEmitter } from 'node:events';
import { execFileSync } from 'node:child_process';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { Client } from '@modelcontextprotocol/sdk/client/index.js';
import { StreamableHTTPClientTransport } from '@modelcontextprotocol/sdk/client/streamableHttp.js';
import { createLocalChannel } from '../src/live-local.js';
import { createStreamService, createRemoteStreamManager, findFfmpeg, HLS_FILE_RE } from '../src/stream.js';
import { createCameraStream } from '../src/camera.js';
import http from 'node:http';
import { loadConfig, watchKeyOf } from '../src/config.js';
import { createWeb, playlistFrom } from '../src/web.js';
import { startAgent } from '../src/index.js';
import { LOCAL_NEXT } from '../src/mcp.js';
import { WATCH_CSP } from '../src/watch-page.js';

const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
async function until(fn, ms = 10_000) {
  const t0 = Date.now();
  while (!(await fn())) {
    if (Date.now() - t0 > ms) throw new Error('timed out waiting');
    await sleep(20);
  }
}
const tmp = () => fs.mkdtempSync(path.join(os.tmpdir(), 'mcagent-watch-'));
const KEY = 'k3yForTheTests_0123456789abcdef';
const SVC = 'svc-token-for-the-tests-0123456789';
const PLAYLIST = '#EXTM3U\n#EXT-X-VERSION:6\n#EXT-X-TARGETDURATION:2\n#EXT-X-MEDIA-SEQUENCE:1700000000\n#EXTINF:2.000000,\nseg-1700000000.ts\n';

/** Camera streams that stand in for createCameraStream: on start they write a playlist and a segment into the output's folder. */
function stubStreams({ write = true } = {}) {
  const made = [];
  const create = (o) => {
    const em = new EventEmitter();
    let done;
    const st = {
      o, player: o.player, state: 'idle', calls: [], terms: [], captions: [],
      finished: new Promise((r) => { done = r; }),
      on: (e, fn) => { em.on(e, fn); return () => em.off(e, fn); },
      async start() {
        st.state = 'live';
        st.calls.push(`start ${st.player}`);
        if (write) {
          fs.writeFileSync(path.join(path.dirname(o.output), 'seg-1700000000.ts'), Buffer.alloc(376, 0x47));
          fs.writeFileSync(o.output, PLAYLIST);
        }
      },
      async stop() { if (st.state === 'stopped') return; st.calls.push('stop'); st.state = 'stopped'; done({ ok: true }); },
      async follow(p) { st.calls.push(`follow ${p}`); st.player = p; },
      caption(t) { st.captions.push(t); },
      term(u) { st.terms.push(u); },
      pose() {},
      get aspect() { return '1080/1080'; },
      async stats() { return { state: st.state }; },
    };
    made.push(st);
    return st;
  };
  return { create, made };
}

test('local channel: a game is filmed only after live_view asks; first come, first served (a later asker waits in line); HLS files by name only; the folder goes with the broadcast', async (t) => {
  const dir = tmp();
  const rows = [];
  const streams = stubStreams();
  const ch = createLocalChannel({ createStream: streams.create, dir, log: { event: (k, d) => rows.push({ k, ...d }) }, pollMs: 20, aspect: '1080/1080' });
  t.after(async () => { await ch.stopAll('test over'); fs.rmSync(dir, { recursive: true, force: true }); });
  assert.deepEqual(ch.live(), { fb: false, channel: 'local', state: 'off', game: null, liveSince: null, aspect: '1080/1080', games: 0, error: null, retryInS: null, fromSeg: 0, lastSeg: -1 });
  assert.deepEqual(ch.start('g1', { player: 'Bot_aaaa' }), { id: 'g1' });
  assert.equal(ch.start('g2', { player: 'not a name' }), null, 'a bad player name');
  await ch.settled();
  assert.equal(ch.live().state, 'off', 'a game that only started is never filmed');
  assert.equal(streams.made.length, 0);
  assert.equal(ch.hlsFile('live.m3u8'), null, 'nothing to serve');
  ch.focus('g1');
  await until(() => ch.live().state === 'live');
  assert.equal(ch.live().game, 'g1');
  assert.match(ch.live().liveSince, /^\d{4}-\d\d-\d\dT/);
  const file = ch.hlsFile('live.m3u8');
  assert.equal(fs.readFileSync(file, 'utf8'), PLAYLIST);
  assert.equal(path.dirname(file).startsWith(dir), true, 'under the channel\'s folder');
  for (const bad of ['../x', 'live.m3u8/..', 'seg-x.ts', 'seg-1.ts.bak', '.env', 'seg-1234567890123.ts']) assert.equal(ch.hlsFile(bad), null, bad);
  assert.ok(ch.hlsFile('seg-1700000000.ts'));
  assert.equal(streams.made[0].o.output, file);
  assert.equal(streams.made[0].o.player, 'Bot_aaaa');
  ch.term('g1', { lines: [{ k: 'call', t: '> play' }] });
  assert.equal(streams.made[0].terms.length, 1, 'the HUD of the game on camera');
  // a second game asks: first come, first served: it is in line, the camera stays on g1
  ch.start('g2', { player: 'Bot_bbbb' });
  const q = ch.focus('g2');
  await ch.settled();
  assert.deepEqual([q.state, q.game, q.queue.position], ['queued', 'g1', 1]);
  assert.ok(q.queue.waitMin >= 1, 'about how long');
  assert.equal(ch.live().game, 'g1');
  assert.equal(ch.live('g1').state, 'live', 'the game on camera is not in line');
  assert.deepEqual(streams.made[0].calls, ['start Bot_aaaa']);
  // g1 ends: the camera moves to g2, the broadcast (and its folder) stays; then nothing is left and the folder goes
  await ch.stop('g1');
  await until(() => ch.live().game === 'g2');
  await ch.settled();
  assert.deepEqual(streams.made[0].calls, ['start Bot_aaaa', 'follow Bot_bbbb']);
  assert.equal(streams.made.length, 1);
  await ch.stop('g2');
  await until(() => ch.live().state === 'off');
  await until(() => !fs.existsSync(path.dirname(file)));
  assert.equal(ch.hlsFile('live.m3u8'), null);
  assert.ok(rows.some((r) => r.k === 'live_local_live') && rows.some((r) => r.k === 'live_local_stop'));
  assert.ok(HLS_FILE_RE.test('seg-1791912055.ts') && !HLS_FILE_RE.test('seg-.ts'));
});

test('local channel: a stream that fails is tried again with a backoff while a game asks', async (t) => {
  const dir = tmp();
  const streams = stubStreams({ write: false });
  const ch = createLocalChannel({ createStream: streams.create, dir, pollMs: 20, retryMs: [80, 160] });
  t.after(async () => { await ch.stopAll('test over'); fs.rmSync(dir, { recursive: true, force: true }); });
  ch.start('g1', { player: 'Bot_aaaa' });
  ch.focus('g1');
  await until(() => streams.made.length === 1);
  assert.equal(ch.live().state, 'starting');
  streams.made[0].stop('crashed');
  await until(() => ch.live().state === 'retrying');
  assert.ok(ch.live().retryInS >= 0);
  await until(() => streams.made.length === 2, 3_000);
});

/** A web server in local mode with stub hooks (the channel is a plain object the test drives). */
async function localWeb(t, { env = {}, live } = {}) {
  const dir = tmp();
  fs.writeFileSync(path.join(dir, 'live.m3u8'), PLAYLIST);
  fs.writeFileSync(path.join(dir, 'seg-1700000000.ts'), Buffer.alloc(376, 0x47));
  const state = { value: live ?? { fb: false, channel: 'local', state: 'off', game: null, liveSince: null, aspect: '1080/1080' } };
  const asked = [];
  const config = loadConfig({ WEB_HOST: '127.0.0.1', WEB_PORT: '0', LOG_DIR: '', ...env });
  const log = { event: () => {}, tail: () => [] };
  const body = () => Object.assign(new EventEmitter(), {
    ready: Promise.resolve(), busy: false, connected: true, state: () => 'inventory: nothing', snapshot: () => null,
    run: async () => ({ ok: true, result: 'done', delta: {} }), stop: async () => {}, close: async () => {}, on() { return () => {}; },
  });
  const web = createWeb({
    config, log, makeBody: () => body(), mcpCallMs: 2_000, liveMode: 'local',
    liveView: async (gameId) => { asked.push(gameId); return { ...state.value, camera: state.value.game }; },
    watch: { live: async () => state.value, hlsFile: (name) => (state.value.state === 'live' ? path.join(dir, name) : null) },
  });
  const { url } = await web.start();
  t.after(async () => { await web.stop(); fs.rmSync(dir, { recursive: true, force: true }); });
  return { url, state, asked, web };
}

test('MCP live_view (LIVE_VIEW=local): start_game says to get the link; live_view points the camera and gives the watch page, never a player', async (t) => {
  const { url, state, asked } = await localWeb(t);
  const c = new Client({ name: 'example-agent', version: '1' });
  t.after(() => c.close().catch(() => {}));
  await c.connect(new StreamableHTTPClientTransport(new URL(`${url}/mcp`)));
  assert.match(c.getInstructions(), /Then call live_view and give your user the watch page link it returns/);
  const tools = await c.listTools();
  assert.match(tools.tools.find((x) => x.name === 'live_view').description, /link of its watch page/);
  const s = (await c.callTool({ name: 'start_game', arguments: {} })).content[0].text;
  const game = /game (g\w+)/.exec(s)[1];
  assert.ok(s.startsWith(`${LOCAL_NEXT}\n\n`), 'the first line, before the game');
  state.value = { fb: false, channel: 'local', state: 'live', game, liveSince: '2026-10-13T10:00:00.000Z', aspect: '1080/1080' };
  const r = await c.callTool({ name: 'live_view', arguments: {} });
  assert.deepEqual(asked, [game], 'the camera was pointed at the game');
  const txt = r.content[0].text;
  const watchUrl = r.structuredContent.watch_url;
  assert.match(watchUrl, new RegExp(`^${url}/live/[A-Za-z0-9_-]{22}/$`), 'the 128-bit view id, not the game id');
  assert.equal(watchUrl.includes(game), false);
  assert.match(txt, new RegExp(`^Live view of game ${game}: live since 10:00:00 UTC\\. Watch it in a browser \\(about 5 to 8 s behind\\): ${watchUrl.replace(/[./]/g, '\\$&')}\\n`));
  assert.match(txt, /a preview panel cannot play it/);
  assert.equal(r.structuredContent.live, true);
  assert.match(r.structuredContent.html, /<a class="b" href="http:\/\/127\.0\.0\.1:\d+\/live\/[A-Za-z0-9_-]{22}\/" target="_blank" rel="noopener noreferrer">Open the watch page<\/a>/);
  assert.equal(r.structuredContent.html.includes('<iframe'), false);
  const link = JSON.parse((await c.callTool({ name: 'live_view', arguments: { format: 'link' } })).content[0].text);
  assert.deepEqual(link, { format: 'link', game, live: true, state: 'live', camera_game: game, watch_url: watchUrl });
  // the camera on another game, then not answering
  state.value = { ...state.value, game: 'gother1' };
  assert.match((await c.callTool({ name: 'live_view', arguments: {} })).content[0].text, /^Live view: the camera is on game gother1 now, not on g\w+/);
  state.value = null;
  // (a channel that answers nothing: the agent's liveView turns it into 'unreachable')
});

test('watch page: the page with its CSP, the scripts from this server, the status in words, the HLS files; a game\'s page plays only while the camera films it', async (t) => {
  const { url, state } = await localWeb(t, { env: { MCP_ACCESS_KEY: KEY } });
  const c = new Client({ name: 'example-agent', version: '1' });
  t.after(() => c.close().catch(() => {}));
  await c.connect(new StreamableHTTPClientTransport(new URL(`${url}/mcp/${KEY}`)));
  const game = /game (g\w+)/.exec((await c.callTool({ name: 'start_game', arguments: {} })).content[0].text)[1];
  const r = await c.callTool({ name: 'live_view', arguments: { format: 'link' } });
  const watchUrl = JSON.parse(r.content[0].text).watch_url;
  const base = new URL(watchUrl).pathname;

  const page = await fetch(watchUrl);
  assert.equal(page.status, 200);
  assert.equal(page.headers.get('content-security-policy'), WATCH_CSP);
  assert.match(WATCH_CSP, /default-src 'none'; script-src 'self';/);
  assert.match(WATCH_CSP, /frame-ancestors 'none'/);
  const html = await page.text();
  assert.match(html, /<video id="v" autoplay muted playsinline controls><\/video>/);
  assert.match(html, /<script src="\/live\/assets\/hls\.light\.min\.js"><\/script>/);
  assert.match(html, new RegExp(`<script src="/live/assets/watch\\.js" data-base="${base}" data-aspect="1080/1080"></script>`));
  assert.match(html, new RegExp(`This page follows game ${game} while the camera films it\\.`));
  assert.match(html, /NOT AN OFFICIAL MINECRAFT SERVICE\. NOT APPROVED BY OR ASSOCIATED WITH MOJANG OR MICROSOFT\. Not affiliated with, endorsed by or sponsored by Meta Platforms, Mojang Studios or Microsoft\./);
  assert.equal(/https?:\/\/(?!127\.0\.0\.1)/.test(html), false, 'nothing from anywhere else');
  const hls = await fetch(`${url}/live/assets/hls.light.min.js`);
  assert.equal(hls.status, 200);
  assert.match(hls.headers.get('content-type'), /javascript/);
  assert.ok((await hls.text()).length > 100_000, 'hls.js itself');
  assert.match(await (await fetch(`${url}/live/assets/watch.js`)).text(), /fetch\(base \+ 'status'/);

  const status = async (b = base) => (await fetch(`${url}${b}status`)).json();
  assert.deepEqual(await status(), { state: 'off', live: false, here: false, since: null, aspect: '1080/1080', text: `Game ${game} is not on camera. Its agent's live_view call puts it there.` });
  assert.equal((await fetch(`${url}${base}hls/live.m3u8`)).status, 404, 'nothing to play yet');
  state.value = { fb: false, channel: 'local', state: 'starting', game, liveSince: null, aspect: '1080/1080' };
  await sleep(1_100); // the state is asked once a second at most
  assert.match((await status()).text, /^The camera is starting: the first picture takes 10 to 40 seconds\./);
  await sleep(1_100); // the state is asked once a second at most
  state.value = { fb: false, channel: 'local', state: 'live', game, liveSince: '2026-10-13T10:00:00.000Z', aspect: '1080/1080' };
  await sleep(1_100);
  const st = await status();
  assert.deepEqual([st.live, st.here, st.text], [true, true, `Live on game ${game}, since 10:00 UTC.`]);
  const pl = await fetch(`${url}${base}hls/live.m3u8`);
  assert.equal(pl.status, 200);
  assert.equal(pl.headers.get('content-type'), 'application/vnd.apple.mpegurl');
  assert.equal(pl.headers.get('cache-control'), 'no-store');
  assert.equal(await pl.text(), PLAYLIST);
  const seg = await fetch(`${url}${base}hls/seg-1700000000.ts`);
  assert.equal(seg.status, 200);
  assert.equal(seg.headers.get('content-type'), 'video/mp2t');
  assert.equal(Buffer.from(await seg.arrayBuffer())[0], 0x47);
  for (const bad of ['hls/..%2F..%2Fetc%2Fpasswd', 'hls/x.ts', 'hls/live.m3u8.tmp', 'hls/.env']) assert.equal((await fetch(`${url}${base}${bad}`)).status, 404, bad);
  // the camera moves to another game: this game's page stops playing and says why
  state.value = { ...state.value, game: 'gother1' };
  await sleep(1_100);
  assert.equal((await fetch(`${url}${base}hls/live.m3u8`)).status, 404);
  assert.match((await status()).text, new RegExp(`^The camera is on another game now\\. Game ${game} gets it when its turn comes`));
  // the camera page under the watch key (WATCH_KEY, here derived from the access key): whatever the camera films; the
  // access key itself is no watch link (a shared watch link must never let anyone play)
  const WK = watchKeyOf(KEY);
  assert.notEqual(WK, KEY);
  const cam = await fetch(`${url}/live/${WK}/`);
  assert.equal(cam.status, 200);
  assert.match(await cam.text(), /This page shows whichever game the camera films/);
  assert.equal((await status(`/live/${WK}/`)).here, true);
  assert.equal((await fetch(`${url}/live/${WK}/hls/live.m3u8`)).status, 200);
  assert.equal((await fetch(`${url}/live/${KEY}/`)).status, 404, 'the MCP access key opens no watch page');
  // unknown ids, a wrong key, and the game's end
  assert.equal((await fetch(`${url}/live/AAAAAAAAAAAAAAAAAAAAAA/`)).status, 404);
  assert.equal((await fetch(`${url}/live/${KEY.slice(0, -1)}x/`)).status, 404);
  assert.equal((await fetch(`${url}/live/${base.split('/')[2]}`, { redirect: 'manual' })).status, 303);
  await c.callTool({ name: 'end_game', arguments: {} });
  assert.equal((await fetch(watchUrl)).status, 410);
  assert.equal((await fetch(`${url}/live/assets/nope.js`)).status, 404);
});

test('access: with MCP_ACCESS_KEY the endpoint is /mcp/<key> (or a Bearer header); without one, nothing that came through a proxy or tunnel is answered', async (t) => {
  const { url } = await localWeb(t, { env: { MCP_ACCESS_KEY: KEY } });
  const init = (p, headers = {}) => fetch(`${url}${p}`, {
    method: 'POST', headers: { 'content-type': 'application/json', accept: 'application/json, text/event-stream', ...headers },
    body: JSON.stringify({ jsonrpc: '2.0', id: 1, method: 'initialize', params: { protocolVersion: '2025-06-18', capabilities: {}, clientInfo: { name: 'raw', version: '1' } } }),
  });
  assert.equal((await init('/mcp')).status, 401);
  assert.equal((await init(`/mcp/${KEY}x`)).status, 404);
  assert.equal((await init(`/mcp/${KEY}`)).status, 200);
  assert.equal((await init('/mcp', { authorization: `Bearer ${KEY}` })).status, 200);
  assert.equal((await init('/mcp', { authorization: 'Bearer nope' })).status, 401);
  const home = await (await fetch(`${url}/`)).text();
  assert.equal(home.includes(KEY), false, 'the key is never on a page');
  assert.match(home, /\/mcp\/&lt;your MCP_ACCESS_KEY&gt;/);

  const open = await localWeb(t, { env: { WEB_GUEST_PAGES: 'on' } });
  const openInit = (headers) => fetch(`${open.url}/mcp`, {
    method: 'POST', headers: { 'content-type': 'application/json', accept: 'application/json, text/event-stream', ...headers },
    body: JSON.stringify({ jsonrpc: '2.0', id: 1, method: 'initialize', params: { protocolVersion: '2025-06-18', capabilities: {}, clientInfo: { name: 'raw', version: '1' } } }),
  });
  assert.equal((await openInit({})).status, 200, 'this machine\'s own clients');
  for (const h of [{ 'cf-connecting-ip': '203.0.113.9' }, { 'x-forwarded-for': '203.0.113.9' }, { forwarded: 'for=203.0.113.9' }]) {
    const res = await openInit(h);
    assert.equal(res.status, 403, JSON.stringify(h));
    assert.match((await res.json()).error, /no MCP_ACCESS_KEY/);
  }
  assert.equal((await fetch(`${open.url}/session`, { method: 'POST', headers: { 'x-forwarded-for': '203.0.113.9' } })).status, 403, 'nor the guest pages');
  assert.equal((await fetch(`${open.url}/mcp/${KEY}`, { method: 'POST' })).status, 404, 'no key, no /mcp/<key>');
  // the guest pages are off unless asked for
  const off = await localWeb(t);
  for (const p of ['/openapi.json', '/play/x', '/api/session']) assert.equal((await fetch(`${off.url}${p}`)).status, 404, p);
  assert.equal((await fetch(`${off.url}/session`, { method: 'POST' })).status, 404);
  assert.doesNotMatch(await (await fetch(`${off.url}/`)).text(), /Start a .* session/);
});

/** A camera rig that is always in the world (no Minecraft, no X server). */
function readyRig() {
  const em = new EventEmitter();
  const calls = [];
  return {
    calls, state: 'ready', name: 'AgentCam', options: { display: 4243, width: 320, height: 180, followMs: 60_000 },
    start() { calls.push('start'); }, waitReady: async () => true, follow: async (p) => { calls.push(`follow ${p}`); return true; },
    keepFollowing: async () => true, park: async () => { calls.push('park'); }, stats: async () => ({ state: 'ready' }),
    on: (e, fn) => { em.on(e, fn); return () => em.off(e, fn); },
  };
}

test('end to end: a test pattern through the camera stream as HLS -> the camera service -> the agent -> segments a player can play', { timeout: 90_000 }, async (t) => {
  const ffmpeg = findFfmpeg();
  if (!ffmpeg) { t.skip('no ffmpeg'); return; }
  const dir = tmp();
  const rig = readyRig();
  const ch = createLocalChannel({
    dir, pollMs: 100,
    createStream: (o) => createCameraStream({ ...o, rig, ffmpeg, font: null, settleMs: 10, testSource: '320x180', width: 640, height: 360, fps: 15, bitrateK: 600, layout: 'landscape', music: false, gameAudio: false }),
  });
  const service = createStreamService({ manager: ch, token: SVC });
  await new Promise((r) => service.listen(0, '127.0.0.1', r));
  const serviceUrl = `http://127.0.0.1:${service.address().port}`;
  // the control API answers only the agent's token
  assert.equal((await fetch(`${serviceUrl}/live`)).status, 401);
  assert.equal((await fetch(`${serviceUrl}/hls/live.m3u8`, { headers: { authorization: 'Bearer nope' } })).status, 401);
  assert.equal((await fetch(`${serviceUrl}/streams/g1`, { method: 'PUT', body: '{"player":"Bot_x1"}' })).status, 401);
  const streams = createRemoteStreamManager({ url: serviceUrl, refreshMs: 0, token: SVC });
  const agent = await startAgent({
    config: loadConfig({ WEB_HOST: '127.0.0.1', WEB_PORT: '0', LOG_DIR: dir, LIVE_VIEW: 'local', MCP_ACCESS_KEY: KEY, STREAM_SERVICE_URL: serviceUrl, STREAM_SERVICE_TOKEN: SVC }),
    fakeBot: true, print: () => {}, loadViewer: () => null, streams, loopStatsMs: 0,
  });
  const c = new Client({ name: 'example-agent', version: '1' });
  try {
    await c.connect(new StreamableHTTPClientTransport(new URL(`${agent.url}/mcp/${KEY}`)));
    const game = /game (g\w+)/.exec((await c.callTool({ name: 'start_game', arguments: {} })).content[0].text)[1];
    // the fake world has no camera of its own: the game goes on the channel the way the agent puts it there
    streams.start(game, { player: 'Bot_e2e1' });
    await until(() => ch.has(game), 5_000);
    const t0 = Date.now();
    const r = await c.callTool({ name: 'live_view', arguments: {} });
    assert.equal(r.structuredContent.state, 'live', r.content[0].text);
    const firstPictureMs = Date.now() - t0;
    assert.ok(firstPictureMs < 20_000, `${firstPictureMs} ms to the first segment`);
    const watch = r.structuredContent.watch_url;
    const st = await (await fetch(`${watch}status`)).json();
    assert.deepEqual([st.live, st.here], [true, true]);
    const playlist = await (await fetch(`${watch}hls/live.m3u8`)).text();
    assert.match(playlist, /^#EXTM3U\n/);
    assert.match(playlist, /#EXT-X-TARGETDURATION:2\n/);
    const first = playlist.match(/^seg-\d+\.ts$/m)[0];
    const seg = Buffer.from(await (await fetch(`${watch}hls/${first}`)).arrayBuffer());
    assert.ok(seg.length > 10_000, `${seg.length} bytes`);
    assert.equal(seg[0], 0x47, 'MPEG-TS');
    const file = path.join(dir, 'probe.ts');
    fs.writeFileSync(file, seg);
    const probe = JSON.parse(execFileSync(ffmpeg.replace(/ffmpeg$/, 'ffprobe'), ['-v', 'error', '-show_entries', 'stream=codec_name,width,height', '-of', 'json', file], { encoding: 'utf8' }));
    assert.deepEqual(probe.streams.map((s) => s.codec_name).sort(), ['aac', 'h264']);
    assert.equal(probe.streams.find((s) => s.codec_name === 'h264').width, 640);
    // a few seconds later the playlist has moved on (live), and old segments go
    await sleep(5_000);
    const later = await (await fetch(`${watch}hls/live.m3u8`)).text();
    assert.notEqual(later, playlist);
    assert.ok((later.match(/^seg-\d+\.ts$/mg) ?? []).length <= 6, 'at most six segments listed');
    // the game ends: the camera stops and its folder goes
    await c.callTool({ name: 'end_game', arguments: {} });
    await streams.stop(game);
    await until(() => ch.live().state === 'off', 20_000);
    assert.equal(rig.calls.at(-1), 'park');
    await until(() => fs.readdirSync(dir).filter((n) => /^b\d+-\d+$/.test(n)).length === 0, 5_000); // the HLS folder is gone
  } finally {
    await c.close().catch(() => {});
    await agent.stop('test over');
    await ch.stopAll();
    service.close();
    fs.rmSync(dir, { recursive: true, force: true });
  }
});

/** A raw request with a Host (and other headers) of our choosing: what a browser sends for a name it resolved. */
function raw(url, { method = 'GET', path: p = '/', headers = {}, body = null } = {}) {
  const u = new URL(url);
  return new Promise((resolve, reject) => {
    const req = http.request({ host: u.hostname, port: u.port, method, path: p, headers }, (res) => {
      const chunks = [];
      res.on('data', (c) => chunks.push(c));
      res.on('end', () => resolve({ status: res.statusCode, text: Buffer.concat(chunks).toString('utf8') }));
    });
    req.on('error', reject);
    req.end(body ?? undefined);
  });
}
const INIT = JSON.stringify({ jsonrpc: '2.0', id: 1, method: 'initialize', params: { protocolVersion: '2025-06-18', capabilities: {}, clientInfo: { name: 'raw', version: '1' } } });
const MCP_HEADERS = { 'content-type': 'application/json', accept: 'application/json, text/event-stream' };

test('DNS rebinding: only host names this server answers to; another website\'s Origin is refused; a keyless server answers only to localhost', async (t) => {
  // without a key (npm run demo): localhost and loopback addresses only
  const open = await localWeb(t, { env: { WEB_GUEST_PAGES: 'on' } });
  const port = new URL(open.url).port;
  assert.equal((await raw(open.url, { method: 'POST', path: '/mcp', headers: { ...MCP_HEADERS, host: `127.0.0.1:${port}` }, body: INIT })).status, 200);
  assert.equal((await raw(open.url, { method: 'POST', path: '/mcp', headers: { ...MCP_HEADERS, host: `localhost:${port}` }, body: INIT })).status, 200);
  for (const host of [`rebind.attacker.example:${port}`, `192.168.1.5:${port}`, 'x.trycloudflare.com']) {
    const r = await raw(open.url, { method: 'POST', path: '/mcp', headers: { ...MCP_HEADERS, host, origin: `http://${host}` }, body: INIT });
    assert.equal(r.status, 421, host);
    assert.equal((await raw(open.url, { method: 'POST', path: '/api/session', headers: { host, 'content-type': 'application/json' }, body: '{}' })).status, 421, host);
    assert.equal((await raw(open.url, { path: '/', headers: { host } })).status, 421, host);
  }
  // a page of another website (the right Host, another Origin)
  assert.equal((await raw(open.url, { method: 'POST', path: '/mcp', headers: { ...MCP_HEADERS, host: `127.0.0.1:${port}`, origin: 'https://evil.example' }, body: INIT })).status, 403);
  assert.equal((await raw(open.url, { method: 'POST', path: '/mcp', headers: { ...MCP_HEADERS, host: `127.0.0.1:${port}`, origin: `http://localhost:${port}` }, body: INIT })).status, 200);

  // with a key: also IP addresses, the tunnel services' names, WEB_PUBLIC_URL's and WEB_ALLOWED_HOSTS
  const keyed = await localWeb(t, { env: { MCP_ACCESS_KEY: KEY, WEB_PUBLIC_URL: 'https://play.example.org', WEB_ALLOWED_HOSTS: 'mybox.lan,.home.example' } });
  const ok = (host) => raw(keyed.url, { path: '/', headers: { host } }).then((r) => r.status);
  for (const host of ['127.0.0.1:8787', '192.168.1.5:18917', '[::1]:8787', 'abc-def.trycloudflare.com', 'box.tail1234.ts.net', 'play.example.org', 'mybox.lan:8787', 'a.home.example']) assert.equal(await ok(host), 200, host);
  for (const host of ['rebind.attacker.example', 'example.org', 'trycloudflare.com.attacker.example', 'home.example.attacker.example']) assert.equal(await ok(host), 421, host);
  assert.equal((await raw(keyed.url, { method: 'POST', path: `/mcp/${KEY}`, headers: { ...MCP_HEADERS, host: 'rebind.attacker.example' }, body: INIT })).status, 421);
});

test('links: a direct request\'s own host and port (never 0.0.0.0); WEB_LOCAL_URL when a request does not say', async (t) => {
  const { url } = await localWeb(t, { env: { MCP_ACCESS_KEY: KEY, WEB_GUEST_PAGES: 'on' } });
  const spec = async (host) => JSON.parse((await raw(url, { path: '/openapi.json', headers: { host } })).text).servers[0].url;
  assert.equal(await spec('127.0.0.1:18917'), 'http://127.0.0.1:18917', 'the published port, not the listen port');
  assert.equal(await spec('192.168.1.5:18917'), 'http://192.168.1.5:18917');
  assert.equal(await spec('abc.trycloudflare.com'), 'https://abc.trycloudflare.com');
  assert.equal(await spec('0.0.0.0:8787'), url, 'never 0.0.0.0');
  // the agent in Docker listens on 0.0.0.0: without a request, its links use WEB_LOCAL_URL (the host's side)
  const d = await localWeb(t, { env: { MCP_ACCESS_KEY: KEY, WEB_HOST: '0.0.0.0', WEB_LOCAL_URL: 'http://127.0.0.1:18917' } });
  const started = await d.web.start();
  assert.equal(started.localUrl, 'http://127.0.0.1:18917');
  const z = await localWeb(t, { env: { MCP_ACCESS_KEY: KEY, WEB_HOST: '0.0.0.0' } });
  assert.match((await z.web.start()).localUrl, /^http:\/\/127\.0\.0\.1:\d+$/);
});

test('watch page: a game\'s page gets only its own picture: segments from where the camera came to it, never another game\'s', async (t) => {
  const { url, state } = await localWeb(t, { env: { MCP_ACCESS_KEY: KEY } });
  const c = new Client({ name: 'example-agent', version: '1' });
  t.after(() => c.close().catch(() => {}));
  await c.connect(new StreamableHTTPClientTransport(new URL(`${url}/mcp/${KEY}`)));
  const game = /game (g\w+)/.exec((await c.callTool({ name: 'start_game', arguments: {} })).content[0].text)[1];
  const base = new URL(JSON.parse((await c.callTool({ name: 'live_view', arguments: { format: 'link' } })).content[0].text).watch_url).pathname;
  // the camera came to this game after segment 1700000000 was written: that one shows the game before
  state.value = { fb: false, channel: 'local', state: 'live', game, liveSince: '2026-10-13T10:00:00.000Z', aspect: '1080/1080', fromSeg: 1700000002, lastSeg: 1700000000 };
  await sleep(1_100);
  const st = await (await fetch(`${url}${base}status`)).json();
  assert.deepEqual([st.live, st.here, st.state], [false, true, 'starting'], 'waits for its own first segment');
  assert.match(st.text, /moving to this game/);
  assert.equal((await fetch(`${url}${base}hls/seg-1700000000.ts`)).status, 404, 'the game before\'s segment');
  const pl = await (await fetch(`${url}${base}hls/live.m3u8`)).text();
  assert.doesNotMatch(pl, /seg-1700000000\.ts/);
  assert.match(pl, /#EXT-X-MEDIA-SEQUENCE:1700000001/);
  // the camera page (the watch key) shows everything the camera films
  assert.equal((await fetch(`${url}/live/${watchKeyOf(KEY)}/hls/seg-1700000000.ts`)).status, 200);
  // its own segments are there: it plays
  state.value = { ...state.value, lastSeg: 1700000003 };
  await sleep(1_100);
  assert.equal((await (await fetch(`${url}${base}status`)).json()).live, true);
  // another game on camera: no segment at all for this one, not even a current one
  state.value = { ...state.value, game: 'gother1', fromSeg: 0 };
  await sleep(1_100);
  assert.equal((await fetch(`${url}${base}hls/seg-1700000000.ts`)).status, 404);
});

test('playlistFrom: the segments before `from` go with their tags; the media sequence moves on by as many', () => {
  const pl = '#EXTM3U\n#EXT-X-VERSION:6\n#EXT-X-TARGETDURATION:2\n#EXT-X-MEDIA-SEQUENCE:100\n#EXT-X-INDEPENDENT-SEGMENTS\n#EXTINF:2.0,\nseg-100.ts\n#EXTINF:2.0,\nseg-101.ts\n#EXTINF:2.0,\nseg-102.ts\n';
  assert.equal(playlistFrom(pl, 102), '#EXTM3U\n#EXT-X-VERSION:6\n#EXT-X-TARGETDURATION:2\n#EXT-X-MEDIA-SEQUENCE:102\n#EXT-X-INDEPENDENT-SEGMENTS\n#EXTINF:2.0,\nseg-102.ts\n');
  assert.equal(playlistFrom(pl, 0), pl);
  assert.doesNotMatch(playlistFrom(pl, 200), /seg-|EXTINF/);
});

test('local channel: a camera move records the first segment of the new game\'s picture', async () => {
  const dir = tmp();
  const streams = stubStreams();
  const ch = createLocalChannel({ dir, pollMs: 20, createStream: streams.create });
  try {
    ch.start('g1', { player: 'Bot_aaaa' });
    ch.start('g2', { player: 'Bot_bbbb' });
    ch.focus('g1');
    await until(() => ch.live().state === 'live');
    assert.equal(ch.live().fromSeg, 0, 'the first game: every segment is its own');
    assert.equal(ch.live().lastSeg, 1700000000);
    ch.focus('g2');
    await ch.stop('g1'); // its turn: the game that had the camera ended
    await until(() => ch.live().game === 'g2');
    assert.equal(ch.live().fromSeg, 1700000002, 'after the segment being written when the camera moved');
  } finally {
    await ch.stopAll();
    fs.rmSync(dir, { recursive: true, force: true });
  }
});
