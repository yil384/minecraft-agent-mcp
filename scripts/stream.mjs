// scripts/stream.mjs - the camera from the command line: --serve, the camera service of compose.yaml's camera
// container (a loopback HTTP API the agent drives through STREAM_SERVICE_URL; LIVE_VIEW decides what it does with the
// picture: HLS for the local watch page, or your own Facebook live), or --camera, one camera stream of a player by hand
// (to check the camera, to a file or an RTMP(S) URL).
//
//   node scripts/stream.mjs --serve --port 7862                                         # in the camera container
//   node scripts/stream.mjs --camera --player Bot_ab12cd --out sample.mp4 --seconds 45   # in the camera container
//
// Exit codes: 0 done, 1 the stream failed, 2 bad arguments, 3 no ffmpeg.

import path from 'node:path';
import { parseArgs } from 'node:util';
import { pathToFileURL } from 'node:url';
import { createStreamService, findFfmpeg, maskOutput } from '../src/stream.js';
import { createCameraManager, createCameraRig, createCameraStream, cameraOptions, validName } from '../src/camera.js';
import { readTokenFile } from '../src/fb-live.js';

export const USAGE = `usage: node scripts/stream.mjs --serve [--port 7862]
       node scripts/stream.mjs --camera --player NAME --out FILE.mp4|rtmps://... [--seconds N]

  --serve            the camera service (LIVE_VIEW, CAMERA_*, FB_*, MC_*, STREAM_SERVICE_TOKEN from the environment),
                     listening on 127.0.0.1:--port (default STREAM_SERVICE_PORT, else 7862)
  --camera           the camera spectating --player (a bot's name), from CAMERA_* / MC_* in the environment
  --out TARGET       an .mp4 file, an .m3u8 playlist or an rtmp(s):// URL (default: the first of STREAM_RTMP_URL)
  --seconds N        stop after N seconds (default: at Ctrl-C)
  --fps N --bitrate KBPS
  --caption TEXT     a fixed caption
  --every N          print the numbers every N seconds (default 5); --json prints them as JSON lines`;

export async function main(argv = process.argv.slice(2), { print = console.log, printErr = console.error, env = process.env } = {}) {
  let values;
  try {
    ({ values } = parseArgs({
      args: argv, strict: true, options: {
        out: { type: 'string' }, seconds: { type: 'string' }, fps: { type: 'string' }, bitrate: { type: 'string' },
        caption: { type: 'string' }, every: { type: 'string' }, json: { type: 'boolean' }, serve: { type: 'boolean' },
        port: { type: 'string' }, camera: { type: 'boolean' }, player: { type: 'string' },
        help: { type: 'boolean', short: 'h' },
      },
    }));
  } catch (err) { printErr(`${err.message}\n\n${USAGE}`); return 2; }
  if (values.help) { print(USAGE); return 0; }
  if (values.serve) return serve(values, { print, printErr, env });
  if (values.camera) return camera(values, { print, printErr, env });
  printErr(USAGE);
  return 2;
}

/** --serve: the camera's manager (or live channel) and the control API on loopback, until SIGINT/SIGTERM. */
async function serve(values, { print, printErr, env }) {
  const { loadConfig } = await import('../src/config.js');
  const { createLogger } = await import('../src/log.js');
  let config;
  try { config = loadConfig({ ...env, STREAM_ROLE: 'camera' }); } catch (err) { printErr(err.message); return 2; }
  const port = Number(values.port ?? env.STREAM_SERVICE_PORT ?? 7862);
  if (!Number.isInteger(port) || port < 1 || port > 65535) { printErr('--port must be a port number'); return 2; }
  if (!findFfmpeg(env)) { printErr('no ffmpeg found (STREAM_FFMPEG)'); return 3; }
  if (!config.stream.enabled) { printErr('LIVE_VIEW is off: the camera has nothing to do'); return 2; }
  // the control API can start a Facebook live: it answers only the agent, which has the same token
  if (!config.stream.serviceToken) { printErr('the camera service needs STREAM_SERVICE_TOKEN (the same as the agent\'s; setup.sh writes it, or: openssl rand -hex 24)'); return 2; }
  const log = createLogger({ config, runId: `camera-${new Date().toISOString().replace(/[:.]/g, '-')}` });
  if (config.fb.live) {
    // the token's file must be there and private before anything goes live (it is never printed)
    try { readTokenFile(config.fb.tokenFile); } catch (err) { printErr(`LIVE_VIEW=facebook: ${err.message} (run scripts/fb-token.mjs, or ./setup.sh --facebook)`); return 2; }
  }
  // in the service, a game the agent stops reporting (it refreshes every minute) leaves the live channel after 3 min
  const manager = createCameraManager({ config, log, gameTtlMs: 180_000 });
  if (!manager.enabled) printErr('note: there is no output (LIVE_VIEW, STREAM_RTMP_URL or STREAM_OUT_DIR): every start is refused');
  const server = createStreamService({ manager, log, token: config.stream.serviceToken });
  await new Promise((resolve, reject) => { server.once('error', reject); server.listen(port, '127.0.0.1', resolve); });
  const what = config.fb.live ? `Facebook live channel on ${config.fb.target === 'me' ? `the token owner's profile (${config.fb.privacy}${config.fb.deleteAfter ? ', each video deleted after its game' : ''})` : `Page ${config.fb.pageId}`}, one camera`
    : config.stream.hls ? 'the local watch page (HLS), one camera' : manager.enabled ? `up to ${config.stream.max} stream(s)` : 'off';
  print(`camera service on http://127.0.0.1:${port}/streams (${what})`);
  const signal = await new Promise((resolve) => { process.once('SIGINT', () => resolve('SIGINT')); process.once('SIGTERM', () => resolve('SIGTERM')); });
  print(`${signal}: stopping every stream`);
  server.close();
  await manager.stopAll(signal);
  log.close();
  return 0;
}

/** --camera: one rig and one stream of --player, numbers every --every seconds, until --seconds or Ctrl-C. */
async function camera(values, { print, printErr, env }) {
  const { loadConfig } = await import('../src/config.js');
  let config;
  try { config = loadConfig({ ...env, STREAM_ROLE: 'camera', LIVE_VIEW: env.LIVE_VIEW || 'local' }); } catch (err) { printErr(err.message); return 2; }
  const out = values.out ?? env.STREAM_RTMP_URL?.split(',')[0]?.trim();
  if (!validName(values.player) || !out) { printErr(`--player NAME and --out are needed\n\n${USAGE}`); return 2; }
  if (!findFfmpeg(env)) { printErr('no ffmpeg found (STREAM_FFMPEG)'); return 3; }
  const target = /^[a-z]+:\/\//i.test(out) ? out : path.resolve(out);
  const line = (kind, data) => print(values.json ? JSON.stringify({ event: kind, ...data }) : `${kind} ${JSON.stringify(data)}`);
  const rig = createCameraRig({ ...cameraOptions(config), event: line });
  const num = (v, def) => (v === undefined ? def : Number(v));
  const stream = createCameraStream({
    rig, player: values.player, output: target, fps: num(values.fps, config.stream.fps), bitrateK: num(values.bitrate, config.stream.bitrateK), event: line,
  });
  print(`camera on ${cameraOptions(config).server}, spectating ${values.player} -> ${maskOutput(target)}`);
  if (values.caption) stream.caption(values.caption);
  const started = Date.now();
  let prev = null;
  const report = async () => {
    const s = await stream.stats({ resources: true });
    const t = Date.now();
    const per = (a, b) => (prev && a != null && b != null ? Math.round(((a - b) / ((t - prev.t) / 1000)) * 100) : null);
    const row = {
      t: Math.round((t - started) / 1000), state: s.state, camera: s.camera.state, clientFps: s.camera.clientFps, frame: s.encoder.frame,
      dup: s.encoder.dup, drop: s.encoder.drop, speed: s.encoder.speed,
      clientCpu: per(s.camera.clientTree?.cpuSec, prev?.clientTree?.cpuSec), clientMB: s.camera.clientTree ? Math.round(s.camera.clientTree.rssMB) : null,
      xvfbCpu: per(s.camera.xvfbTree?.cpuSec, prev?.xvfbTree?.cpuSec), ffmpegCpu: per(s.ffmpegTree?.cpuSec, prev?.ffmpegTree?.cpuSec),
      ffmpegMB: s.ffmpegTree ? Math.round(s.ffmpegTree.rssMB) : null,
    };
    prev = { t, clientTree: s.camera.clientTree, xvfbTree: s.camera.xvfbTree, ffmpegTree: s.ffmpegTree };
    print(values.json ? JSON.stringify(row) : Object.entries(row).map(([k, v]) => `${k}=${v}`).join(' '));
  };
  const timer = setInterval(() => { report().catch(() => {}); }, Math.max(1, num(values.every, 5)) * 1000);
  const startP = stream.start();
  const seconds = num(values.seconds, 0);
  const why = await new Promise((resolve) => {
    startP.then(() => { if (seconds > 0) setTimeout(() => resolve('time'), seconds * 1000); }, (err) => resolve(`could not start: ${err.message}`));
    process.once('SIGINT', () => resolve('SIGINT'));
    process.once('SIGTERM', () => resolve('SIGTERM'));
    stream.finished.then(() => resolve('finished'));
  });
  clearInterval(timer);
  await report().catch(() => {});
  const r = await stream.stop(why);
  await rig.stop();
  print(`stopped (${why}); ${r.ok ? 'ok' : `failed: ${r.reason}`}`);
  return r.ok ? 0 : 1;
}

const isMain = process.argv[1] && import.meta.url === pathToFileURL(path.resolve(process.argv[1])).href;
if (isMain) process.exitCode = await main();
