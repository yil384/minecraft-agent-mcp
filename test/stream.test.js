// test/stream.test.js - the video side of the live view (src/stream.js): ffmpeg's arguments (FLV to an RTMP(S) ingest
// on fd 3, HLS for the local watch page, MP4 to a file), the stream keys masked and scrubbed, the captions, ps CPU
// times, the stream manager (one stream per game, at most max and one per output URL), the camera service and the
// agent's client over loopback (a game goes on the camera by its player name), the HLS files the service serves, and
// the configuration. The camera itself is test/camera.test.js; the channels are test/fb-live.test.js and
// test/watch.test.js.

import { test } from 'node:test';
import assert from 'node:assert/strict';
import { EventEmitter } from 'node:events';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import {
  ffmpegArgs, hlsArgs, isHlsOutput, maskOutput, scrubOutputs, captionFor, captionsOf, cleanCaption, createStreamManager,
  createStreamService, createRemoteStreamManager, managerConfig, cpuSeconds, isNetworkOutput, channelOf, HLS_FILE_RE,
} from '../src/stream.js';
import { loadConfig } from '../src/config.js';
import { createLogger } from '../src/log.js';

const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
async function until(fn, ms = 5_000) {
  const t0 = Date.now();
  while (!(await fn())) {
    if (Date.now() - t0 > ms) throw new Error('timed out waiting');
    await sleep(10);
  }
}
const KEY = 'FB-123456789012345-0-AbCdEfGhIjKlMnOp';
const FB = `rtmps://live-api-s.facebook.com:443/rtmp/${KEY}`;

// ffmpeg, keys, captions

test('ffmpeg: H.264 CBR with a 2 s keyframe interval, silent 48 kHz stereo AAC, FLV to RTMPS, HLS for the watch page, MP4 to a file, caption only with a font', () => {
  const a = ffmpegArgs({ output: FB, fps: 30, bitrateK: 3000, width: 1280, height: 720 });
  const after = (flag) => a[a.indexOf(flag) + 1];
  assert.equal(after('-c:v'), 'mjpeg', 'the input');
  assert.equal(a[a.lastIndexOf('-c:v') + 1], 'libx264');
  assert.equal(after('-g'), '60');
  assert.equal(after('-keyint_min'), '60');
  assert.equal(after('-sc_threshold'), '0');
  assert.equal(after('-b:v'), '3000k');
  assert.equal(after('-maxrate'), '3000k');
  assert.equal(after('-minrate'), '3000k');
  assert.equal(after('-c:a'), 'aac');
  assert.equal(after('-ar'), '48000');
  assert.equal(after('-ac'), '2');
  assert.equal(after('-f'), 'image2pipe');
  assert.equal(a[a.length - 2], 'flv');
  assert.equal(a[a.length - 1], 'pipe:3', 'FLV to fd 3, which src/rtmp.js publishes');
  assert.equal(a.some((x) => x.includes(KEY) || x.includes('rtmp')), false, 'the stream key and the ingest URL are never arguments');
  assert.match(after('-vf'), /^scale=1280:720:flags=bicubic,format=yuv420p$/);
  const f = ffmpegArgs({ output: '/tmp/x.mp4', fps: 24, font: '/fonts/a b.ttf', captionFile: "/tmp/it's:here.txt", scaleFlags: 'neighbor' });
  assert.equal(f[f.indexOf('-g') + 1], '48');
  assert.ok(f.includes('mp4') && f.includes('+faststart'));
  assert.match(f[f.indexOf('-vf') + 1], /flags=neighbor,drawtext=fontfile='\/fonts\/a b\.ttf':textfile='\/tmp\/it'\\''s\\:here\.txt':reload=1/);
  assert.equal(isNetworkOutput('rtmp://x/app/key'), true);
  assert.equal(isNetworkOutput('/tmp/a.mp4'), false);
  // the local watch page: segments of one GOP each, numbered from the clock, the playlist written whole
  const h = ffmpegArgs({ output: '/camera/hls/b1-1/live.m3u8', fps: 30 });
  assert.equal(isHlsOutput('/camera/hls/b1-1/live.m3u8'), true);
  assert.equal(isHlsOutput('rtmp://x/live.m3u8'), false);
  assert.deepEqual(h.slice(h.indexOf('-f', h.indexOf('-shortest'))), [...hlsArgs('/camera/hls/b1-1/live.m3u8'), '/camera/hls/b1-1/live.m3u8']);
  assert.equal(h[h.indexOf('-hls_time') + 1], '2', 'one segment per keyframe interval');
  assert.equal(h[h.indexOf('-g') + 1], '60');
  assert.equal(h[h.indexOf('-hls_list_size') + 1], '6');
  assert.match(h[h.indexOf('-hls_flags') + 1], /delete_segments.*omit_endlist.*temp_file/);
  assert.equal(h[h.indexOf('-hls_start_number_source') + 1], 'epoch');
  assert.equal(h[h.indexOf('-hls_segment_filename') + 1], '/camera/hls/b1-1/seg-%d.ts');
  assert.ok(HLS_FILE_RE.test('live.m3u8') && HLS_FILE_RE.test('seg-1791912055.ts') && !HLS_FILE_RE.test('live.m3u8.tmp') && !HLS_FILE_RE.test('../live.m3u8'));
});



test('stream keys: masked in what is logged, scrubbed from ffmpeg messages and from the JSONL log', () => {
  assert.equal(maskOutput(FB), 'rtmps://live-api-s.facebook.com:443/rtmp/***');
  assert.equal(maskOutput(`${FB}?s_bl=1&s_sc=secret`), 'rtmps://live-api-s.facebook.com:443/rtmp/***');
  assert.equal(maskOutput('/tmp/a.mp4'), '/tmp/a.mp4');
  const msg = `[tls] error connecting to ${FB}: I/O error\nrtmp://other.example/live/abcdefabcdef123456 failed`;
  const clean = scrubOutputs(msg, [FB]);
  assert.equal(clean.includes(KEY), false);
  assert.equal(clean.includes('abcdefabcdef123456'), false);
  assert.match(clean, /rtmps:\/\/live-api-s\.facebook\.com:443\/rtmp\/\*\*\*/);

  const config = loadConfig({ STREAM_ENABLED: '1', STREAM_RTMP_URL: FB, STREAM_SERVICE_URL: 'http://127.0.0.1:7862', STREAM_SERVICE_TOKEN: 'svc-token-for-the-tests-0123456789' });
  assert.equal(JSON.stringify(config).includes(KEY), false, 'the URL is not enumerable');
  const log = createLogger({ dir: null, config });
  log.event('stream_error', { message: `could not open ${FB} (key ${KEY})` });
  assert.equal(JSON.stringify(log.tail()).includes(KEY), false);
});

test('captions: fixed words from the skill and its validated names and numbers, with who acts (The agent or a reflex); chat text never shows', async () => {
  assert.equal(captionFor({ phase: 'start', tool: 'collect', args: { block: 'oak_log', n: 3 } }), 'Collecting oak log (3)');
  assert.equal(captionFor({ phase: 'start', tool: 'go_to', args: { x: -133, y: 70, z: 45 } }), 'Walking to -133 70 45');
  assert.equal(captionFor({ phase: 'start', tool: 'craft', args: { item: 'crafting_table', n: 1 } }), 'Crafting crafting table');
  assert.equal(captionFor({ phase: 'start', tool: 'say', args: { text: 'visit evil.example now' } }), 'Chatting');
  assert.equal(captionFor({ phase: 'start', tool: 'build', args: { blueprint: 'hut_3x3', material: 'oak_planks' } }), 'Building a hut 3x3 from oak planks');
  assert.equal(captionFor({ phase: 'end', tool: 'collect', args: {} }), '');
  assert.equal(captionFor({ phase: 'start', tool: 'get_state', args: {} }), '');
  assert.equal(cleanCaption('Walking %{pts} \\n to: <b>x</b>'), "Walking pts n to: b x b");
  // who acts: the player's skills as the agent's, the runtime's reflexes as reflexes, then the skill again
  const { EventEmitter } = await import('node:events');
  const em = new EventEmitter();
  const fake = { on: (n, f) => { em.on(n, f); return () => em.off(n, f); } };
  const shown = [];
  const offs = captionsOf(fake, (t) => shown.push(t));
  em.emit('skill', { phase: 'start', tool: 'collect', args: { block: 'iron_ore', n: 3 } });
  em.emit('reflex', { name: 'hostile_reflex' });
  em.emit('reflex', { name: null });
  em.emit('skill', { phase: 'end', tool: 'collect', args: {} });
  em.emit('skill', { phase: 'start', tool: 'shelter', args: {} });
  assert.deepEqual(shown, ['The agent: collecting iron ore (3)', 'Reflex: defending itself', 'The agent: collecting iron ore (3)', '', 'The agent: building a shelter']);
  assert.equal(cleanCaption(shown[1]), 'Reflex: defending itself');
  for (const off of offs) off();
  assert.equal(em.listenerCount('skill') + em.listenerCount('reflex'), 0);
});

test('ps CPU times: every format ps prints', () => {
  assert.equal(cpuSeconds('0:01.50'), 1.5);
  assert.equal(cpuSeconds('12:03.25'), 723.25);
  assert.equal(cpuSeconds('01:02:03'), 3723);
  assert.equal(cpuSeconds('2-01:00:00'), 2 * 86_400 + 3600);
  assert.equal(cpuSeconds('junk'), 0);
});

// ---------------------------------------------------------------------------------------------------------------
// the manager, the service and its client

function fakeStreams() {
  const made = [];
  const create = (o) => {
    let done;
    const s = {
      o, state: 'idle', captions: [], poses: [], stopped: null,
      finished: new Promise((r) => { done = r; }),
      async start() { s.state = 'live'; },
      async stop(reason) { if (s.state === 'stopped') return s.finished; s.state = 'stopped'; s.stopped = reason; done({ ok: true }); return s.finished; },
      caption(t) { s.captions.push(t); },
      pose(p) { s.poses.push(p); },
      async stats() { return { state: s.state }; },
      fail() { s.state = 'failed'; done({ ok: false }); },
    };
    made.push(s);
    return s;
  };
  return { made, create };
}

function fakeBody() {
  const e = new EventEmitter();
  return { on(event, fn) { e.on(event, fn); return () => e.off(event, fn); }, emit: (...a) => e.emit(...a), count: (ev) => e.listenerCount(ev) };
}

test('manager: off unless enabled; one stream per game, at most max and one per output URL; caption and end from the body', async () => {
  const off = createStreamManager({ config: { enabled: false, outputs: [FB], max: 1 } });
  assert.equal(off.start('g1', { player: 'Bot_aaaa' }), null);

  const { made, create } = fakeStreams();
  const log = { rows: [], event(kind, data) { this.rows.push({ kind, ...data }); } };
  const m = createStreamManager({ config: { enabled: true, outputs: [FB, `${FB}2`], max: 4 }, log, create });
  const b1 = fakeBody();
  assert.equal(m.start('g0', { player: 'not a name' }), null, 'the camera follows a player name');
  const s1 = m.start('g1', { player: 'Bot_aaaa', body: b1 });
  assert.equal(m.start('g1', { player: 'Bot_aaaa' }), s1, 'the same game: the same stream');
  m.start('g2', { player: 'Bot_bbbb' });
  assert.equal(m.start('g3', { player: 'Bot_cccc' }), null, 'two URLs, two streams');
  assert.ok(log.rows.some((r) => r.kind === 'stream_skipped' && /output URL/.test(r.reason)));
  assert.deepEqual(made.map((s) => s.o.output), [FB, `${FB}2`]);
  assert.deepEqual([m.slot('g1'), m.slot('g2'), m.slot('g3')], [0, 1, null], 'which output URL each game\'s stream holds');
  assert.equal(JSON.stringify(m.list()).includes(KEY), false, 'list() masks the keys');

  b1.emit('skill', { phase: 'start', tool: 'collect', args: { block: 'oak_log', n: 2 } });
  b1.emit('skill', { phase: 'end', tool: 'collect', args: {} });
  assert.deepEqual(made[0].captions, ['The agent: collecting oak log (2)', '']);
  b1.emit('end', {});
  await until(() => made[0].state === 'stopped' && !m.has('g1'));
  assert.equal(made[0].stopped, 'the game ended');
  assert.equal(b1.count('skill'), 0, 'listeners removed');
  assert.ok(m.start('g3', { player: 'Bot_cccc' }), 'its URL is free again');
  assert.equal(made[2].o.output, FB);

  made[1].fail(); // a stream that gives up frees its slot
  await until(() => !m.has('g2'));
  const capped = createStreamManager({ config: { enabled: true, outDir: '/tmp/streams', max: 1 }, log, create });
  assert.ok(capped.start('a', { player: 'Bot_aaaa' }));
  assert.match(made.at(-1).o.output, /^\/tmp\/streams\/stream-a-.*\.mp4$/);
  assert.equal(capped.start('b', { player: 'Bot_bbbb' }), null, 'never more than max');
  await m.stopAll();
  await capped.stopAll();
  assert.equal(m.size + capped.size, 0);
  const mc = managerConfig(loadConfig({ STREAM_ENABLED: '1', STREAM_RTMP_URL: FB, STREAM_FPS: '24', STREAM_SERVICE_URL: 'http://127.0.0.1:7862', STREAM_SERVICE_TOKEN: 'svc-token-for-the-tests-0123456789' }).stream);
  assert.deepEqual([mc.enabled, mc.outputs, mc.max, mc.options.fps], [true, [FB], 1, 24]);
});

test('manager: a stream that is still closing keeps its output URL, so two never push to one stream key', async () => {
  let finish;
  const slow = (o) => {
    let done;
    const st = {
      o, state: 'live', finished: new Promise((r) => { done = r; }), async start() {}, caption() {}, pose() {},
      stop() { return new Promise((r) => { finish = () => { st.state = 'stopped'; done({ ok: true }); r(); }; }); },
    };
    return st;
  };
  const m = createStreamManager({ config: { enabled: true, outputs: [FB], max: 2 }, create: slow });
  assert.ok(m.start('g1', { player: 'Bot_aaaa' }));
  const stopping = m.stop('g1');
  assert.equal(m.has('g1'), false);
  assert.equal(m.start('g2', { player: 'Bot_bbbb' }), null, 'the only URL is still in use while g1 closes');
  finish();
  await stopping;
  assert.ok(m.start('g2', { player: 'Bot_bbbb' }), 'free once g1 is down');
});

test('service and client: the agent starts, captions and stops a stream over loopback by the bot\'s player name; HLS files by name only', async () => {
  const { made, create } = fakeStreams();
  const manager = createStreamManager({ config: { enabled: true, outputs: [FB], max: 2 }, create });
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'mcagent-hls-'));
  fs.writeFileSync(path.join(dir, 'live.m3u8'), '#EXTM3U\n');
  fs.writeFileSync(path.join(dir, 'seg-17.ts'), Buffer.alloc(188, 0x47));
  manager.hlsFile = (name) => (HLS_FILE_RE.test(name) ? path.join(dir, name) : null);
  const server = createStreamService({ manager });
  await new Promise((r) => server.listen(0, '127.0.0.1', r));
  const url = `http://127.0.0.1:${server.address().port}`;
  try {
    for (const body of [{}, { player: 'x y' }, { player: 'Bot_aaaa; op me' }, { source: 'http://127.0.0.1:1/eyes/g1/' }]) {
      const put = await fetch(`${url}/streams/g1`, { method: 'PUT', body: JSON.stringify(body) });
      assert.equal(put.status, 400, JSON.stringify(body));
    }
    const client = createRemoteStreamManager({ url });
    assert.equal(client.serviceUrl, url);
    assert.equal(client.start('g1', { player: 'not a name' }), null);
    const body = fakeBody();
    client.start('g1', { player: 'Bot_aaaa', body });
    await until(() => made.length === 1 && made[0].state === 'live');
    assert.equal(made[0].o.output, FB, 'the output is the service\'s own');
    assert.equal(made[0].o.player, 'Bot_aaaa');
    await until(() => client.slot('g1') === 0);
    assert.equal(client.slot('g2'), null);
    body.bot = { entity: { position: { x: 5, y: 70, z: -2 }, yaw: 1.5, pitch: 0 } };
    body.emit('skill', { phase: 'start', tool: 'go_to', args: { x: 1, y: 2, z: 3 } });
    await until(() => made[0].captions.length === 1);
    assert.equal(made[0].captions[0], 'The agent: walking to 1 2 3');
    assert.deepEqual(made[0].poses, [{ x: 5, y: 70, z: -2, yaw: 1.5, pitch: 0 }], 'the bot\'s pose goes along');
    const list = await (await fetch(`${url}/streams`)).json();
    assert.deepEqual(list.streams.map((s) => s.id), ['g1']);
    body.emit('end', {});
    await until(() => made[0].state === 'stopped');
    assert.equal(client.size, 0);
    // the watch page's files: the playlist never cached, segments immutable, nothing else
    const pl = await fetch(`${url}/hls/live.m3u8`);
    assert.deepEqual([pl.status, pl.headers.get('content-type'), pl.headers.get('cache-control')], [200, 'application/vnd.apple.mpegurl', 'no-store']);
    const seg = await fetch(`${url}/hls/seg-17.ts`);
    assert.deepEqual([seg.status, seg.headers.get('content-type')], [200, 'video/mp2t']);
    for (const bad of ['seg-18.ts', '..%2Fx', 'live.m3u8.tmp', 'x.ts']) assert.equal((await fetch(`${url}/hls/${bad}`)).status, 404, bad);
    // the plain manager has no channel: /live says so
    assert.deepEqual(await (await fetch(`${url}/live`)).json(), { fb: false, channel: null, state: 'off' });
    assert.equal(channelOf({ channel: 'local' }), 'local');
    assert.equal(channelOf({ fb: true }), 'facebook');
    assert.equal(channelOf({ fb: false }), null);

    // a service that is down: the game goes on, the failure is logged
    const log = { rows: [], event(kind, data) { this.rows.push({ kind, ...data }); } };
    const dead = createRemoteStreamManager({ url: 'http://127.0.0.1:9/', log, timeoutMs: 500 });
    dead.start('g9', { player: 'Bot_dead' });
    await until(() => log.rows.some((r) => r.kind === 'stream_error'));
    assert.equal(dead.size, 0);
  } finally {
    server.close();
    fs.rmSync(dir, { recursive: true, force: true });
  }
});

test('config: off by default, checked, the URLs hidden; the camera needs somewhere to send the picture', () => {
  const c = loadConfig({});
  assert.equal(c.stream.enabled, false);
  assert.deepEqual(c.stream.outputs, []);
  const camera = { STREAM_ROLE: 'camera', MC_CONSOLE: '/c', CAMERA_AUTH_DIR: '/a' };
  const on = loadConfig({ ...camera, STREAM_ENABLED: 'true', STREAM_RTMP_URL: `${FB}, rtmp://a.example/live/k2`, STREAM_MAX: '2' });
  assert.equal(on.stream.outputs.length, 2);
  assert.equal(Object.keys(on.stream).includes('outputs'), false);
  assert.throws(() => loadConfig({ ...camera, STREAM_ENABLED: '1' }), /the camera has nowhere to send the picture/);
  assert.throws(() => loadConfig({ STREAM_RTMP_URL: 'https://example.com/x' }), /STREAM_RTMP_URL must be rtmp/);
  assert.throws(() => loadConfig({ STREAM_SERVICE_URL: 'http://10.0.0.2:7861' }), /STREAM_SERVICE_URL must be an http URL on this machine/);
  assert.throws(() => loadConfig({ STREAM_FPS: '60' }), /STREAM_FPS/);
  assert.equal(loadConfig({ STREAM_ENABLED: '1', STREAM_SERVICE_URL: 'http://127.0.0.1:7861', STREAM_SERVICE_TOKEN: 'svc-token-for-the-tests-0123456789' }).stream.serviceUrl, 'http://127.0.0.1:7861');
  assert.equal(loadConfig({ ...camera, LIVE_VIEW: 'local' }).stream.hls, true, 'the watch page needs no other output');
  assert.match(loadConfig({ ...camera, LIVE_VIEW: 'local', CAMERA_HOME: '/camera' }).stream.hlsDir, /^\/camera\/hls$/);
});

