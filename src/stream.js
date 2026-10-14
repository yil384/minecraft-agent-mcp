// src/stream.js - the video side of a game's live view: ffmpeg's arguments (the camera's X display, the HUD panel, the
// sound, H.264 + AAC), the encoder with its RTMP(S) publisher (src/rtmp.js: the stream key never on a command line),
// and three ways to send the picture: FLV to an RTMP(S) ingest (a Facebook live, or any RTMP URL), HLS segments into a
// folder (the local watch page, LIVE_VIEW=local), or an MP4 file (tests and samples). createStreamManager ties streams
// to games: one per game at most, never more than STREAM_MAX or than output URLs, each stopped with its game.
// createStreamService and createRemoteStreamManager run the camera in its own container (compose profile "camera")
// behind a loopback-only HTTP API; the agent talks to it through the remote manager. The streams themselves are the
// real-client camera's (src/camera.js).

import crypto from 'node:crypto';
import { spawn, execFile } from 'node:child_process';
import fs from 'node:fs';
import http from 'node:http';
import path from 'node:path';
import { createRtmpPublisher } from './rtmp.js';
import { cleanTerm } from './terminal.js';

export const STREAM_DEFAULTS = Object.freeze({
  width: 1280, // the video (Facebook Live: H.264 + AAC, up to 1280x720 at 30 fps, keyframe every 2 s, CBR)
  height: 720,
  fps: 30,
  bitrateK: 3000,
  audioK: 128,
  keyframeSec: 2,
  preset: 'veryfast',
  threads: 2, // x264 threads
  encoderNice: 0, // ffmpeg is cheap and must keep real time (a starved encoder stalls the broadcast)
  maxRestarts: 6, // per child within restartWindowMs, before the stream gives up
  restartWindowMs: 300_000,
  hlsSegmentSec: 2, // the local watch page: one HLS segment per keyframe interval
  hlsListSize: 6, // segments kept in the playlist (and on disk)
});

const sleep = (ms) => new Promise((r) => { setTimeout(r, ms).unref?.(); });
const clip = (s, n = 300) => String(s ?? '').replace(/\s+/g, ' ').trim().slice(0, n);
const alive = (child) => child && child.exitCode === null && child.signalCode === null;

/** An output URL safe to log: the stream key (the last path part), any query and credentials are hidden. */
export function maskOutput(output) {
  const s = String(output ?? '');
  if (!/^[a-z][a-z0-9+.-]*:\/\//i.test(s)) return s;
  try {
    const u = new URL(s);
    const parts = u.pathname.split('/').filter(Boolean);
    const shown = parts.length > 1 ? `/${parts.slice(0, -1).join('/')}/***` : parts.length ? '/***' : '';
    return `${u.protocol}//${u.host}${shown}`;
  } catch {
    return s.replace(/^([a-z]+:\/\/[^/]+).*$/i, '$1/***');
  }
}

/** Every output URL in a text (ffmpeg's messages name it) masked, and any other rtmp(s) URL too. */
export function scrubOutputs(text, outputs = []) {
  let t = String(text ?? '');
  for (const o of outputs) if (o) t = t.split(o).join(maskOutput(o));
  return t.replace(/rtmps?:\/\/[^\s'"]+/gi, (u) => {
    const tail = u.match(/[:.,;)]+$/)?.[0] ?? ''; // punctuation after the URL in a message
    return maskOutput(tail ? u.slice(0, -tail.length) : u) + tail;
  });
}

export const isNetworkOutput = (output) => /^(rtmps?|srt|udp|tcp):\/\//i.test(String(output));
/** An RTMP(S) ingest: ffmpeg writes FLV to its fd 3 and src/rtmp.js publishes it, so the key is on no command line. */
export const isRtmpOutput = (output) => /^rtmps?:\/\//i.test(String(output));
/** What a stream's ffmpeg writes to: the FLV pipe (fd 3) for an RTMP(S) ingest, else the output itself. */
export const encoderTarget = (output) => (isRtmpOutput(output) ? 'pipe:3' : String(output));
/** True for an HLS playlist path (the local watch page): ffmpeg writes the playlist and its segments into its folder. */
export const isHlsOutput = (output) => !isNetworkOutput(output) && /\.m3u8$/i.test(String(output));
/** The names an HLS folder of ours holds: the playlist and its numbered segments, nothing else is ever served. */
export const HLS_FILE_RE = /^(live\.m3u8|seg-\d{1,12}\.ts)$/;

/**
 * The muxer arguments for an HLS output: short segments cut at every keyframe (the GOP is keyframeSec, so a segment is
 * exactly one GOP), the oldest deleted as new ones come, the playlist rewritten atomically (temp_file) so a reader never
 * sees half of it, no end tag while it runs. Numbered from the clock (epoch seconds), so an encoder that restarts keeps
 * counting up and a player that is watching never sees a number it has already played.
 */
export function hlsArgs(output, o = {}) {
  const dir = path.dirname(String(output));
  return [
    '-f', 'hls', '-hls_time', String(o.hlsSegmentSec ?? STREAM_DEFAULTS.hlsSegmentSec), '-hls_list_size', String(o.hlsListSize ?? STREAM_DEFAULTS.hlsListSize),
    '-hls_flags', 'delete_segments+independent_segments+omit_endlist+temp_file', '-hls_segment_type', 'mpegts',
    '-hls_start_number_source', 'epoch', '-hls_segment_filename', path.join(dir, 'seg-%d.ts'), '-y',
  ];
}

/** A text for drawtext's textfile: fixed characters only (the caption is never viewer text, and this keeps it so). */
export const cleanCaption = (text) => String(text ?? '').replace(/[^A-Za-z0-9 ,.:()'-]/g, ' ').replace(/\s+/g, ' ').trim().slice(0, 80);

/** A pose {x, y, z, yaw, pitch} of finite numbers, or null. */
export function cleanPose(p) {
  const v = p && [p.x, p.y, p.z, p.yaw ?? 0, p.pitch ?? 0].map(Number);
  return v && v.every(Number.isFinite) ? { x: v[0], y: v[1], z: v[2], yaw: v[3], pitch: v[4] } : null;
}

/** The pose of a body's bot (feet position, yaw, pitch), or null before it is in the world. */
export function poseOf(body) {
  try {
    const e = body?.bot?.entity;
    return e?.position ? cleanPose({ x: e.position.x, y: e.position.y, z: e.position.z, yaw: e.yaw, pitch: e.pitch }) : null;
  } catch { return null; }
}

/** Escape a path for a value in an ffmpeg filter graph. */
const filterPath = (p) => `'${String(p).replace(/\\/g, '/').replace(/'/g, "'\\''").replace(/:/g, '\\:')}'`;

/**
 * The sound: the game's own (o.pulse, the camera's PulseAudio monitor source: the client's sound effects and ambience,
 * its music at 0), else silence, and with o.music a soft bed under it (a CC0 track looped in real time, o.musicDb, ducked
 * by a side-chain compressor whenever the game is loud), then a limiter at -1 dBFS. Inputs 1 (and 2) of ffmpeg; the
 * mix on a complex graph of its own, the picture stays on -vf (input 0).
 * @param {{pulse?: string, music?: string, musicDb?: number, gameDb?: number}} [a]
 */
export function audioArgs(a = {}) {
  const inputs = a?.pulse
    ? ['-thread_queue_size', '1024', '-f', 'pulse', '-sample_rate', '48000', '-channels', '2', '-fragment_size', '3840', '-i', String(a.pulse)]
    : ['-re', '-f', 'lavfi', '-i', 'anullsrc=channel_layout=stereo:sample_rate=48000'];
  const db = (v, d) => (Number.isFinite(v) ? v : d).toFixed(1);
  const game = `aresample=48000,aformat=sample_fmts=fltp:channel_layouts=stereo,volume=${db(a?.gameDb, 12)}dB`;
  const limit = 'alimiter=limit=0.891:attack=5:release=80:level=disabled';
  if (!a?.music) return { inputs, maps: ['-map', '1:a', '-af', `${game},${limit}`] };
  inputs.push('-re', '-stream_loop', '-1', '-i', String(a.music));
  const graph = `[1:a]${game},asplit=2[g][key];`
    + `[2:a]aresample=48000,aformat=sample_fmts=fltp:channel_layouts=stereo,volume=${db(a.musicDb, -15)}dB[bed];`
    + '[bed][key]sidechaincompress=threshold=0.02:ratio=8:attack=10:release=700:knee=4[ducked];'
    + `[g][ducked]amix=inputs=2:duration=first:dropout_transition=0:normalize=0,${limit}[aout]`;
  return { inputs, maps: ['-filter_complex', graph, '-map', '[aout]'] };
}

/**
 * ffmpeg arguments: JPEG frames on stdin at a constant rate (or, with o.x11 = {display, width, height}, an X display
 * grabbed at that rate: src/camera.js), silent stereo AAC paced in real time, scaled to width x height (with the
 * caption from captionFile, when there is a font), H.264 CBR with a closed GOP of keyframeSec; FLV for a network
 * output, HLS segments for a .m3u8 path (the local watch page), MP4 (faststart) for any other file. An RTMP(S) URL is never among the arguments: ffmpeg writes the FLV to its fd 3
 * (spawnEncoder publishes it), because on a shared host other users can read every process's command line. o.progress:
 * key=value progress on stdout every 5 s.
 */
export function ffmpegArgs(o) {
  const fps = o.fps ?? STREAM_DEFAULTS.fps;
  const kbps = o.bitrateK ?? STREAM_DEFAULTS.bitrateK;
  const gop = Math.max(1, Math.round(fps * (o.keyframeSec ?? STREAM_DEFAULTS.keyframeSec)));
  const width = o.width ?? STREAM_DEFAULTS.width;
  const height = o.height ?? STREAM_DEFAULTS.height;
  const net = isNetworkOutput(o.output);
  // with a panel (o.panel = {file, top, fps}: the vertical layout, src/terminal-panel.js) the game is width x top at
  // the top and the panel image below it; the caption and the clock belong to the game's part
  const gameH = o.panel ? o.panel.top : height;
  const ui = o.panel?.kind === 'ui';
  const size = Math.round(gameH / 26);
  // the UI layout says what the agent does in its own panel (src/ui-panel.js): no caption on the game
  const caption = !ui && o.font && o.captionFile
    ? `,drawtext=fontfile=${filterPath(o.font)}:textfile=${filterPath(o.captionFile)}:reload=1:fontsize=${size}:fontcolor=0xF4F1EA`
      + `:box=1:boxcolor=0x0C0E10@0.62:boxborderw=${Math.round(size / 2)}:x=${Math.round(gameH / 20)}:y=h-th-${Math.round(gameH / 18)}`
    : '';
  // test only (STREAM_CLOCK): the wall clock, large, top right; its time zone is ffmpeg's TZ (encoderEnv)
  const big = Math.round(gameH / 11);
  const clock = o.clock && o.font
    ? `,drawtext=fontfile=${filterPath(o.font)}:text='%{localtime\\:%T}':fontsize=${big}:fontcolor=white`
      + `:box=1:boxcolor=0x000000@0.7:boxborderw=${Math.round(big / 4)}:x=w-tw-${Math.round(gameH / 24)}:y=${Math.round(gameH / 24)}`
    : '';
  const video = o.testSource // tests only: a moving test pattern instead of a picture source
    ? ['-re', '-f', 'lavfi', '-i', `testsrc2=size=${o.testSource}:rate=${fps}`]
    : o.fileSource // samples only: a recorded video as the picture source, played in real time
      ? ['-re', '-i', String(o.fileSource)]
      : o.x11
      ? ['-thread_queue_size', '64', '-f', 'x11grab', '-draw_mouse', '0', '-framerate', String(fps), '-video_size', `${o.x11.width ?? width}x${o.x11.height ?? height}`, '-i', String(o.x11.display)]
      : ['-thread_queue_size', '64', '-f', 'image2pipe', '-framerate', String(fps), '-c:v', 'mjpeg', '-i', 'pipe:0'];
  // the game's part: scaled to the frame's width; in the UI layout cut to its shape first (the middle of a 16:9
  // picture: Minecraft's field of view is vertical, so this is what a window of that shape shows)
  const scaleGame = `${ui ? `crop=w='min(iw,ih*${width}/${gameH})':h='min(ih,iw*${gameH}/${width})',` : ''}scale=${width}:${gameH}:flags=${o.scaleFlags ?? 'bicubic'}`;
  const { inputs: audioInputs, maps: audioMaps } = audioArgs(o.audio);
  return [
    '-hide_banner', '-nostdin', '-loglevel', 'warning', '-nostats', ...(o.progress ? ['-progress', 'pipe:1', '-stats_period', '5'] : []),
    ...video,
    ...audioInputs,
    ...(o.panel
      // the vertical layout in the same single-input chain as the landscape one (-vf): the game padded to the full
      // frame, and the panel a movie source overlaid under it. Not -filter_complex with the panel as an input of its
      // own: on the real camera display ffmpeg 5.1 configured that graph again at the first frame and failed ("Error
      // reinitializing filters!", "Failed to configure output pad"), and paced with -re it held
      // the picture back (0.72x of real time). The movie source re-reads the file on every loop (it is replaced by
      // renaming, never half written) and its frames are counted at 4 a second (setpts), so it is read 4 times a
      // second; this chain ran at real time (0.996x) on the real display.
      // The UI panel is read the same way at the video's own rate (an uncompressed BMP, renamed over the file 30 times a
      // second by src/ui-panel.js), so the HUD moves smoothly.
      ? ['-map', '0:v', ...audioMaps, '-vf', `[in]setpts=PTS-STARTPTS,${scaleGame}${caption}${clock},pad=${width}:${height}:0:0:color=0x0B0D0F,format=yuv420p[top];`
        // with o.panel.over the panel image is that much taller and see-through at its top (a toast over the game):
        // overlaid with its alpha, that much higher
        + `movie=${filterPath(o.panel.file)}:f=image2:loop=0,setpts=N/(${o.panel.fps ?? 4}*TB),scale=${width}:${height - gameH + (o.panel.over ?? 0)},format=${o.panel.over ? 'yuva420p' : 'yuv420p'}[pan];[top][pan]overlay=0:${gameH - (o.panel.over ?? 0)}:format=yuv420[out]`]
      : ['-map', '0:v', ...audioMaps, '-vf', `scale=${width}:${height}:flags=${o.scaleFlags ?? 'bicubic'}${caption}${clock},format=yuv420p`]),
    '-c:v', 'libx264', '-preset', o.preset ?? STREAM_DEFAULTS.preset, '-tune', 'zerolatency', '-profile:v', 'high',
    '-threads', String(o.threads ?? STREAM_DEFAULTS.threads),
    '-r', String(fps), '-g', String(gop), '-keyint_min', String(gop), '-sc_threshold', '0', '-bf', '0',
    '-b:v', `${kbps}k`, '-minrate', `${kbps}k`, '-maxrate', `${kbps}k`, '-bufsize', `${kbps}k`, '-x264-params', 'nal-hrd=cbr:force-cfr=1',
    '-c:a', 'aac', '-b:a', `${o.audioK ?? STREAM_DEFAULTS.audioK}k`, '-ar', '48000', '-ac', '2',
    '-shortest',
    ...(net ? ['-flvflags', 'no_duration_filesize', '-f', 'flv'] : isHlsOutput(o.output) ? hlsArgs(o.output, o) : ['-movflags', '+faststart', '-f', 'mp4', '-y']),
    encoderTarget(o.output),
  ];
}

/** Environment variables that hold secrets (stream keys, the page token's path): never handed to a child process. */
const SECRET_ENV = /^(STREAM_RTMP_URL|STREAM_SERVICE_TOKEN|FB_TOKEN_FILE|FB_.*TOKEN.*|FB_APP_SECRET|MCP_ACCESS_KEY|WATCH_KEY|WEB_ADMIN_TOKEN|WEB_PROXY_SECRET|MC_ACCESS_TOKEN)$/;
/** This process's environment without its secrets, plus extra: what a child (ffmpeg, the game client) gets. */
export const childEnv = (extra = {}) => ({ ...Object.fromEntries(Object.entries(process.env).filter(([k]) => !SECRET_ENV.test(k))), ...extra });

/** ffmpeg's environment: with the test clock on, its time zone (drawtext's localtime reads TZ). */
export const encoderEnv = (o, extra = {}) => childEnv({ ...extra, ...(o.clock ? { TZ: o.clockTz || 'UTC' } : {}) });

/**
 * ffmpeg for one stream. To an RTMP(S) ingest it writes FLV to its fd 3 and src/rtmp.js sends that to the URL, so the
 * stream key is on no command line and in no child's environment. A publisher that fails (refused, stalled, cut)
 * kills ffmpeg, so the caller's exit handler restarts both with its backoff; `failure()` gives the publisher's reason.
 * @param {{ffmpeg: string, args: string[], output: string, nice?: number, stdio: Array, env?: object,
 *   event?: (kind: string, data: object) => void, createPublisher?: typeof createRtmpPublisher, timeoutMs?: number}} o
 */
export function spawnEncoder(o) {
  const rtmp = isRtmpOutput(o.output);
  const child = spawnNiced(o.ffmpeg, o.args, o.nice ?? 0, { stdio: rtmp ? [...o.stdio.slice(0, 3), 'pipe'] : o.stdio, env: o.env ?? childEnv() });
  if (!rtmp) return { child, publisher: null, failure: () => null };
  let why = null;
  // the same bytes into a file as well (a recording of the stream as it went out: src/recorder.js)
  if (o.tee) {
    try {
      const ws = fs.createWriteStream(o.tee);
      ws.on('error', () => {});
      child.stdio[3].on('data', (d) => { ws.write(d); });
      child.on('exit', () => ws.end());
    } catch { /* the recording goes without it */ }
  }
  const publisher = (o.createPublisher ?? createRtmpPublisher)({ url: o.output, event: o.event, timeoutMs: o.timeoutMs, ca: o.ca });
  publisher.on('error', (err) => {
    why = `the ingest: ${clip(err?.message ?? err, 200)}`;
    if (alive(child)) child.kill('SIGKILL');
  });
  publisher.on('publishing', () => { try { o.event?.('stream_publishing', { output: maskOutput(o.output) }); } catch { /* best effort */ } });
  publisher.input(child.stdio[3]);
  child.on('error', () => publisher.close());
  return { child, publisher, failure: () => why };
}

function executable(p) {
  try { fs.accessSync(p, fs.constants.X_OK); return fs.statSync(p).isFile(); } catch { return false; }
}

/** STREAM_FFMPEG, else the first ffmpeg on PATH, else a usual install place; null if none. */
export function findFfmpeg(env = process.env) {
  if (env.STREAM_FFMPEG) return executable(env.STREAM_FFMPEG) ? env.STREAM_FFMPEG : null;
  const onPath = String(env.PATH ?? '').split(path.delimiter).filter(Boolean).map((d) => path.join(d, 'ffmpeg'));
  const list = [...onPath, '/opt/homebrew/bin/ffmpeg', '/usr/local/bin/ffmpeg', '/usr/bin/ffmpeg'];
  return list.find(executable) ?? null;
}

/** STREAM_FONT, else a plain sans-serif font that is usually installed; null (no caption) if none. */
export function findFont(env = process.env) {
  const list = env.STREAM_FONT ? [env.STREAM_FONT] : [
    '/usr/share/fonts/truetype/dejavu/DejaVuSans.ttf', '/usr/share/fonts/truetype/liberation/LiberationSans-Regular.ttf',
    '/System/Library/Fonts/Supplemental/Arial.ttf', '/System/Library/Fonts/Helvetica.ttc', '/Library/Fonts/Arial.ttf',
  ];
  return list.find((p) => { try { return fs.statSync(p).isFile(); } catch { return false; } }) ?? null;
}

/** spawn, below normal priority when `nice` is there (the agent and the game come first). */
export function spawnNiced(file, args, niceness, options) {
  const niceBin = ['/usr/bin/nice', '/bin/nice'].find(executable);
  if (niceness > 0 && niceBin) return spawn(niceBin, ['-n', String(niceness), file, ...args], options);
  return spawn(file, args, options);
}

/** Sum of RSS (MB) and CPU seconds of a process and its descendants, from ps (macOS and Linux); null if gone. */
export function processTree(rootPid) {
  return new Promise((resolve) => {
    if (!rootPid) { resolve(null); return; }
    execFile('ps', ['-A', '-o', 'pid=,ppid=,rss=,time='], { timeout: 5_000 }, (err, stdout) => {
      if (err) { resolve(null); return; }
      const kids = new Map();
      const info = new Map();
      for (const line of String(stdout).trim().split('\n')) {
        const [pid, ppid, rss, time] = line.trim().split(/\s+/);
        info.set(Number(pid), { rss: Number(rss), time });
        if (!kids.has(Number(ppid))) kids.set(Number(ppid), []);
        kids.get(Number(ppid)).push(Number(pid));
      }
      if (!info.has(rootPid)) { resolve(null); return; }
      resolve(sumTree(rootPid, kids, info));
    });
  });
}

/** CPU time as ps prints it ([dd-]hh:mm:ss[.ss] or mm:ss.ss) in seconds. */
export function cpuSeconds(t) {
  const m = String(t).match(/^(?:(\d+)-)?([\d:]+)(?:\.(\d+))?$/);
  if (!m) return 0;
  let s = 0;
  for (const x of m[2].split(':')) s = s * 60 + Number(x);
  return s + Number(m[1] ?? 0) * 86_400 + (m[3] ? Number(`0.${m[3]}`) : 0);
}

function sumTree(rootPid, kids, info) {
  let rss = 0;
  let cpu = 0;
  let n = 0;
  const stack = [rootPid];
  while (stack.length) {
    const p = stack.pop();
    const i = info.get(p);
    if (i) { rss += i.rss; cpu += cpuSeconds(i.time); n += 1; }
    stack.push(...(kids.get(p) ?? []));
  }
  return { rssMB: rss / 1024, cpuSec: cpu, processes: n };
}

/** Plain words for the caption from a body 'skill' event: fixed names and numbers only, never viewer text. */
export function captionFor(evt) {
  if (!evt || evt.phase !== 'start') return '';
  const a = evt.args ?? {};
  const name = (v) => String(v ?? '').replace(/[^a-z0-9_]/gi, '').replace(/_/g, ' ').slice(0, 40);
  const n = (v) => (Number.isInteger(v) ? v : '');
  const count = (v) => (Number.isInteger(v) && v > 1 ? ` (${v})` : '');
  switch (evt.tool) {
    case 'go_to': return `Walking to ${n(a.x)} ${n(a.y)} ${n(a.z)}`.trim();
    case 'collect': return `Collecting ${name(a.block)}${count(a.n)}`;
    case 'craft': return `Crafting ${name(a.item)}${count(a.n)}`;
    case 'smelt': return `Smelting ${name(a.item)}${count(a.n)}`;
    case 'place': return `Placing ${name(a.block)}`;
    case 'build': return `Building a ${name(a.blueprint)} from ${name(a.material)}`;
    case 'attack': return `Fighting a ${name(a.target)}`;
    case 'eat': return 'Eating';
    case 'say': return 'Chatting';
    case 'hunt': return `Hunting a ${name(a.mob)}`;
    case 'shelter': return 'Building a shelter';
    case 'shield': return 'Making a shield';
    case 'sleep': return 'Sleeping';
    case 'armor': return 'Crafting armor';
    case 'equip': return `Equipping ${name(a.item)}`;
    case 'explore': return 'Exploring';
    case 'pick_up': return a.death_items ? 'Going back for its items' : 'Picking up items';
    case 'portal': return a.action === 'light' ? 'Lighting a portal' : 'Entering a portal';
    default: return '';
  }
}

/** Their reflexes in caption words (the runtime's reflex names, from the body's 'reflex' events). */
export const REFLEX_CAPTIONS = Object.freeze({
  hostile_reflex: 'defending itself', hunger_reflex: 'eating', breath_reflex: 'swimming up for air',
  fire_reflex: 'getting out of fire', recover_footing: 'getting its footing back', dragon_reflex: 'dodging the dragon',
});

/** A caption with who acts: "The agent: collecting iron ore", "Reflex: defending itself"; '' stays ''. */
export const sourced = (who, words) => (words ? `${who}: ${words.charAt(0).toLowerCase()}${words.slice(1)}` : '');

/**
 * The live caption of a game from its body's events, with who acts: the player's skills (the agent), and while one of the
 * runtime's reflexes has the body (BODY=mineai 'reflex' events), that reflex, then the skill again. put(text) shows
 * it. Returns the listeners' offs.
 */
export function captionsOf(body, put) {
  let skill = '';
  let reflex = '';
  const show = () => put(reflex || skill);
  return [
    body.on('skill', (evt) => { skill = sourced('The agent', captionFor(evt)); show(); }),
    body.on('reflex', (evt) => { reflex = sourced('Reflex', REFLEX_CAPTIONS[evt?.name] ?? (evt?.name ? 'acting on its own' : '')); show(); }),
  ];
}

/** The picture's shape for live_view's page ("1080/1080"): the UI and terminal layouts' sizes, else 16:9. */
export function streamAspect(c) {
  if (c?.layout === 'ui') return String(c.uiSize ?? '1080x1080').replace('x', '/');
  if (c?.layout === 'terminal') return String(c.terminalSize ?? '1080x1920').replace('x', '/');
  return '16/9';
}

/** The manager's configuration from config.stream (STREAM_*). */
export function managerConfig(c) {
  return {
    enabled: Boolean(c?.enabled), outputs: c?.outputs ?? [], outDir: c?.outDir || '', max: c?.max ?? 0,
    options: {
      fps: c?.fps, bitrateK: c?.bitrateK, clock: c?.clock || undefined, clockTz: c?.clockTz,
      layout: c?.layout, terminalSize: c?.terminalSize, uiSize: c?.uiSize, hud: c?.hud, logo: c?.logo, logoFile: c?.logoFile,
      gameAudio: c?.gameAudio, music: c?.music, musicFile: c?.musicFile, musicDb: c?.musicDb, gameDb: c?.gameDb,
    },
  };
}

/**
 * Streams tied to games: one per game, at most `max` at once and never more than outputs (an RTMP ingest takes one
 * stream at a time, so each stream holds one URL until it ends). With no output URL but `outDir`, every stream is a
 * file there. Off (every call a no-op) unless enabled.
 * @param {object} o
 * @param {{enabled: boolean, outputs?: string[], outDir?: string, max: number, options?: object}} o.config
 * @param {{event: (kind: string, data: object) => void}} [o.log]
 * @param {(opts: object) => object} o.create   makes one stream (the camera pool's create: src/camera.js)
 */
export function createStreamManager({ config, log, create } = {}) {
  const cfg = config ?? { enabled: false, outputs: [], max: 0 };
  const outputs = cfg.outputs ?? [];
  const streams = new Map(); // id -> {stream, output, offs, stopping}; a stopping stream keeps its output and slot
  const event = (kind, data) => { try { log?.event(kind, data); } catch { /* best effort */ } };
  const enabled = Boolean(cfg.enabled && (outputs.length || cfg.outDir) && cfg.max > 0);

  function freeOutput(id) {
    if (outputs.length) {
      const used = new Set([...streams.values()].map((s) => s.output));
      return outputs.find((u) => !used.has(u)) ?? null;
    }
    const stamp = new Date().toISOString().replace(/[:.]/g, '-');
    return path.join(cfg.outDir, `stream-${String(id).replace(/[^A-Za-z0-9_-]/g, '')}-${stamp}.mp4`);
  }

  function detach(entry) {
    for (const off of entry.offs.splice(0)) { try { off?.(); } catch { /* ignore */ } }
  }

  const api = {
    get enabled() { return enabled; },
    /**
     * Start the stream of a game (body, optional: captions from its skill events, stop when it ends; player: the bot's
     * name, which the real-client camera spectates). Returns the stream, the one already running for this id, or null
     * (off, every slot or output in use).
     */
    start(id, { body, pose, player } = {}) {
      if (!enabled || typeof create !== 'function' || !NAME_RE.test(String(player ?? ''))) return null;
      const running = streams.get(id);
      if (running) return running.stopping ? null : running.stream;
      if (streams.size >= cfg.max) { event('stream_skipped', { session: id, reason: `${cfg.max} stream(s) already running` }); return null; }
      const output = freeOutput(id);
      if (!output) { event('stream_skipped', { session: id, reason: 'every output URL is in use' }); return null; }
      const stream = create({
        ...(cfg.options ?? {}), output, player, pose: body ? () => poseOf(body) : pose ?? null,
        event: (kind, data) => event(kind, { session: id, ...data }),
      });
      const entry = { stream, output, offs: [], stopping: null };
      streams.set(id, entry);
      if (typeof body?.on === 'function') {
        try {
          entry.offs.push(...captionsOf(body, (text) => stream.caption(text)));
          entry.offs.push(body.on('end', () => { api.stop(id, 'the game ended'); }));
        } catch { /* a body without these events: no caption */ }
      }
      stream.finished.then(() => { detach(entry); if (streams.get(id) === entry) streams.delete(id); });
      Promise.resolve().then(() => stream.start()).catch((err) => {
        event('stream_error', { session: id, message: clip(err?.message ?? err) });
        api.stop(id, 'could not start');
      });
      return stream;
    },
    /** Stop the stream of a game; resolves when it is down (its output URL is free only then). */
    stop(id, reason = 'stopped') {
      const entry = streams.get(id);
      if (!entry) return Promise.resolve();
      if (!entry.stopping) {
        detach(entry);
        entry.stopping = Promise.resolve(entry.stream.stop(reason)).catch(() => {}).then(() => { if (streams.get(id) === entry) streams.delete(id); });
      }
      return entry.stopping;
    },
    /** The caption of a game's stream (fixed words only), and the bot's pose when known. */
    caption(id, text, pose) {
      const e = streams.get(id);
      if (!e || e.stopping) return;
      if (pose) e.stream.pose(pose);
      e.stream.caption(text);
    },
    /** The terminal under a game's video (the vertical layout): new lines and the status line. */
    term(id, u) {
      const e = streams.get(id);
      if (e && !e.stopping) e.stream.term?.(u);
    },
    has: (id) => Boolean(streams.get(id) && !streams.get(id).stopping),
    /** Which output URL (its index in STREAM_RTMP_URL) a game's running stream holds; null for files or no stream. */
    slot(id) {
      const e = streams.get(id);
      if (!e || e.stopping || !outputs.length) return null;
      const i = outputs.indexOf(e.output);
      return i >= 0 ? i : null;
    },
    get size() { return streams.size; },
    list: () => [...streams.entries()].map(([id, e]) => ({ id, state: e.stream.state, output: maskOutput(e.output) })),
    stats: (id) => streams.get(id)?.stream.stats({ resources: true }) ?? null,
    async stopAll(reason = 'shutdown') {
      await Promise.allSettled([...streams.keys()].map((id) => api.stop(id, reason)));
    },
  };
  return api;
}

// ---------------------------------------------------------------------------------------------------------------
// The camera as its own service (the camera container of compose.yaml shares the agent's network namespace). The API
// listens on loopback only and knows no output URL from the caller: outputs are the service's own configuration.

const ID_RE = /^[A-Za-z0-9_-]{1,40}$/;
const NAME_RE = /^[A-Za-z0-9_]{3,16}$/;

/** The channel kind a manager's live() reports: 'facebook', 'local' or null (no channel). */
export const channelOf = (v) => (v?.channel === 'facebook' || v?.channel === 'local' ? v.channel : v?.fb ? 'facebook' : null);

/**
 * Send one file of the local watch page's HLS folder: the playlist (never cached) or a segment (immutable once
 * written). 404 when the camera has no such file now (between games, or a segment already rotated out).
 */
function sendHlsFile(res, file, method = 'GET') {
  const playlist = file.endsWith('.m3u8');
  fs.stat(file, (err, st) => {
    if (err || !st.isFile()) {
      res.writeHead(404, { 'content-type': 'text/plain; charset=utf-8', 'cache-control': 'no-store' });
      res.end('no live video here right now\n');
      return;
    }
    res.writeHead(200, {
      'content-type': playlist ? 'application/vnd.apple.mpegurl' : 'video/mp2t',
      'content-length': st.size,
      'cache-control': playlist ? 'no-store' : 'public, max-age=60, immutable',
    });
    if (method === 'HEAD') { res.end(); return; }
    const rs = fs.createReadStream(file);
    rs.on('error', () => res.destroy());
    rs.pipe(res);
  });
}

/**
 * The control API around a manager: PUT /streams/<id> {player, pose?} starts (and answers with the output slot it
 * holds, and channel: true for a live channel), DELETE /streams/<id> stops, POST /streams/<id>/caption {text},
 * GET /streams lists, GET /streams/<id> gives the numbers. With a live channel (LIVE_VIEW=facebook or local) also
 * POST /streams/<id>/focus {player?} (the camera films this game from now on; a game the channel does not have yet is
 * put on it first), GET /live (the channel's state) and, for the local channel, GET /hls/<file> (the playlist and the
 * segments of the watch page). Nothing here ever answers with an ingest URL or a token.
 */
export function createStreamService({ manager, log, token = '' } = {}) {
  // the shared token (STREAM_SERVICE_TOKEN): every request must carry it, so no other local user drives the camera
  const want = token ? crypto.createHash('sha256').update(String(token)).digest() : null;
  const authorized = (req) => {
    if (!want) return true;
    const got = String(req.headers.authorization ?? '').match(/^Bearer\s+(\S+)$/i)?.[1];
    return typeof got === 'string' && crypto.timingSafeEqual(crypto.createHash('sha256').update(got).digest(), want);
  };
  const json = (res, status, body) => {
    const text = `${JSON.stringify(body)}\n`;
    res.writeHead(status, { 'content-type': 'application/json; charset=utf-8', 'content-length': Buffer.byteLength(text) });
    res.end(text);
  };
  const readJson = (req, max = 4_096) => new Promise((resolve) => {
    let size = 0;
    const chunks = [];
    req.on('data', (c) => { size += c.length; if (size <= max) chunks.push(c); });
    req.on('end', () => { try { resolve(size > max ? null : JSON.parse(Buffer.concat(chunks).toString('utf8') || '{}')); } catch { resolve(null); } });
    req.on('error', () => resolve(null));
  });
  return http.createServer(async (req, res) => {
    try {
      if (!authorized(req)) { req.resume(); return json(res, 401, { error: 'this camera service needs its token (STREAM_SERVICE_TOKEN)' }); }
      if (/^\/live\/?(?:\?.*)?$/.test(String(req.url))) {
        if (req.method !== 'GET') return json(res, 405, { error: 'use GET' });
        // ?game=<id>: that game's place in line when another has the camera
        const g = new URL(String(req.url), 'http://local').searchParams.get('game');
        return json(res, 200, typeof manager.live === 'function' ? manager.live(g && ID_RE.test(g) ? g : null) : { fb: false, channel: null, state: 'off' });
      }
      const h = String(req.url).match(/^\/hls\/([^/?]+)(?:\?.*)?$/);
      if (h) {
        if (req.method !== 'GET' && req.method !== 'HEAD') return json(res, 405, { error: 'use GET' });
        const file = HLS_FILE_RE.test(h[1]) && typeof manager.hlsFile === 'function' ? manager.hlsFile(h[1]) : null;
        if (!file) return json(res, 404, { error: 'no live video here right now' });
        return sendHlsFile(res, file, req.method);
      }
      const m = String(req.url).match(/^\/streams(?:\/([^/?]+))?(\/caption|\/focus)?\/?(?:\?.*)?$/);
      if (!m) return json(res, 404, { error: 'not found' });
      const [, id, sub] = m;
      const caption = sub === '/caption';
      if (sub === '/focus') {
        if (!ID_RE.test(String(id))) return json(res, 400, { error: 'bad id' });
        if (req.method !== 'POST') return json(res, 405, { error: 'use POST' });
        if (typeof manager.focus !== 'function') return json(res, 404, { error: 'no live channel (LIVE_VIEW is off)' });
        const body = (await readJson(req)) ?? {};
        if (!manager.has(id) && body.player !== undefined) {
          if (!NAME_RE.test(String(body.player))) return json(res, 400, { error: 'player must be a Minecraft name' });
          manager.start(id, { player: body.player });
        }
        // local: a test's game filmed for the recording only, never on Facebook (MCP_TEST_RECORD); owner: the owner's
        // game (MCP_OWNER_KEY, checked by the agent), first in line
        return json(res, 200, await manager.focus(id, { ...(body.local === true ? { local: true } : {}), ...(body.owner === true ? { owner: true } : {}) }));
      }
      if (id !== undefined && !ID_RE.test(id)) return json(res, 400, { error: 'bad id' });
      if (!id) return req.method === 'GET' ? json(res, 200, { enabled: manager.enabled, streams: manager.list() }) : json(res, 405, { error: 'use GET' });
      if (caption) {
        if (req.method !== 'POST') return json(res, 405, { error: 'use POST' });
        const body = await readJson(req, 32_768);
        // the HUD under the video (src/terminal.js): its lines, cleaned again here
        if (body?.term) { manager.term?.(id, cleanTerm(body.term)); return json(res, 200, { ok: true }); }
        manager.caption(id, cleanCaption(body?.text), cleanPose(body?.pose));
        return json(res, 200, { ok: true });
      }
      if (req.method === 'PUT') {
        const body = await readJson(req);
        if (!body || !NAME_RE.test(String(body.player ?? ''))) return json(res, 400, { error: 'player must be a Minecraft name' });
        const s = manager.start(id, { pose: cleanPose(body.pose), player: body.player });
        return json(res, s ? 200 : 409, s ? { started: true, slot: manager.slot?.(id) ?? null, channel: Boolean(manager.channel) } : { started: false, error: 'not started (off, or every slot in use)' });
      }
      if (req.method === 'DELETE') {
        // ffmpeg may take seconds to close the file or the ingest: answer now, the slot frees up once it has
        manager.stop(id, 'the game ended');
        return json(res, 202, { stopping: true });
      }
      if (req.method === 'GET') { const s = await manager.stats(id); return s ? json(res, 200, s) : json(res, 404, { error: 'no such stream' }); }
      return json(res, 405, { error: 'use GET, PUT, DELETE or POST .../caption' });
    } catch (err) {
      try { log?.event('stream_service_error', { message: clip(err?.message ?? err) }); } catch { /* ignore */ }
      if (!res.headersSent) json(res, 500, { error: 'failed' });
    }
  });
}

/**
 * The agent's side of the service: the manager interface, each call one request to `url` (a loopback URL). Calls never
 * throw; a service that is down is logged and the game goes on without a stream. With a live channel (the service
 * answers channel: true) every live game is reported again each refreshMs: a restarted service gets its games back
 * (and goes live again), and one whose agent died lets them expire. focus(id) and live() return the channel's state,
 * or null when the service has no channel or does not answer. serviceUrl: where the watch page's HLS files come from.
 */
export function createRemoteStreamManager({ url, log, token = '', timeoutMs = 5_000, refreshMs = 60_000 } = {}) {
  const base = String(url).replace(/\/+$/, '');
  const live = new Map(); // id -> offs
  const slots = new Map(); // id -> the output slot the service gave its stream
  const asks = new Map(); // id -> the PUT body (player), for focus and the refresh
  const channel = new Set(); // ids the service keeps on its live channel
  const accepted = new Set(); // ids whose stream the service took (its PUT answered 200)
  const early = new Map(); // id -> terminal updates from before that (start_game's can come first), kept to send then
  const termChain = new Map(); // id -> its last terminal POST: each waits for the one before, so lines stay in order
  const event = (kind, data) => { try { log?.event(kind, data); } catch { /* best effort */ } };
  const auth = token ? { authorization: `Bearer ${token}` } : {};
  const call = (method, p, body) => fetch(`${base}${p}`, {
    method, headers: body ? { 'content-type': 'application/json', ...auth } : auth, body: body ? JSON.stringify(body) : undefined, signal: AbortSignal.timeout(timeoutMs),
  }).then(async (r) => ({ status: r.status, body: await r.json().catch(() => ({})) }));
  const sendTerm = (id, u) => {
    const next = (termChain.get(id) ?? Promise.resolve()).then(() => call('POST', `/streams/${encodeURIComponent(id)}/caption`, { term: u })).catch(() => {});
    termChain.set(id, next);
  };
  const isChannel = (b) => Boolean(channelOf(b));
  const api = {
    enabled: true,
    serviceUrl: base,
    start(id, { body, player } = {}) {
      if (!NAME_RE.test(String(player ?? '')) || live.has(id)) return null;
      const offs = [];
      live.set(id, offs);
      const ask = { player };
      asks.set(id, ask);
      call('PUT', `/streams/${encodeURIComponent(id)}`, { ...ask, pose: poseOf(body) }).then((r) => {
        if (r.status !== 200) { event('stream_skipped', { session: id, reason: clip(r.body?.error ?? `HTTP ${r.status}`) }); api.forget(id); return; }
        if (live.has(id) && Number.isInteger(r.body?.slot)) slots.set(id, r.body.slot);
        if (live.has(id) && r.body?.channel) channel.add(id);
        if (live.has(id)) { accepted.add(id); for (const u of early.get(id) ?? []) sendTerm(id, u); }
        early.delete(id);
      }, (err) => { event('stream_error', { session: id, message: `stream service: ${clip(err?.message ?? err)}` }); api.forget(id); });
      if (typeof body?.on === 'function') {
        try {
          offs.push(...captionsOf(body, (text) => { api.caption(id, text, poseOf(body)); }));
          offs.push(body.on('end', () => { api.stop(id); }));
        } catch { /* no captions */ }
      }
      return { id };
    },
    forget(id) {
      for (const off of live.get(id) ?? []) { try { off?.(); } catch { /* ignore */ } }
      live.delete(id);
      slots.delete(id);
      asks.delete(id);
      channel.delete(id);
      accepted.delete(id);
      early.delete(id);
      termChain.delete(id);
    },
    /** live_view asked for this game: the channel's camera films it from now on. The channel's state, or null. */
    async focus(id, { local = false, owner = false } = {}) {
      const r = await call('POST', `/streams/${encodeURIComponent(id)}/focus`, { ...(asks.get(id) ?? {}), ...(local ? { local: true } : {}), ...(owner ? { owner: true } : {}) }).catch(() => null);
      return r?.status === 200 && isChannel(r.body) ? r.body : null;
    },
    /** The channel's state (GET /live; with a game: its place in line), or null. */
    async live(id = null) {
      const r = await call('GET', id ? `/live?game=${encodeURIComponent(id)}` : '/live').catch(() => null);
      return r?.status === 200 && isChannel(r.body) ? r.body : null;
    },
    async stop(id) {
      if (!live.has(id)) return;
      api.forget(id);
      await call('DELETE', `/streams/${encodeURIComponent(id)}`).catch((err) => event('stream_error', { session: id, message: `stream service: ${clip(err?.message ?? err)}` }));
    },
    caption(id, text, pose = null) {
      if (live.has(id)) call('POST', `/streams/${encodeURIComponent(id)}/caption`, { text: cleanCaption(text), pose }).catch(() => {});
    },
    /**
     * The HUD under the video (the service keeps it per game and draws it for the game on camera). Before the service
     * took the game's stream, the updates wait here (the first and the last 7 of at most 16 games).
     */
    term(id, u) {
      if (accepted.has(id)) { sendTerm(id, u); return; }
      if (!early.has(id)) {
        if (early.size >= 16) early.delete(early.keys().next().value);
        early.set(id, []);
      }
      const q = early.get(id);
      q.push(u);
      if (q.length > 8) q.splice(1, 1);
    },
    has: (id) => live.has(id),
    slot: (id) => (live.has(id) ? slots.get(id) ?? null : null),
    get size() { return live.size; },
    list: () => [...live.keys()].map((id) => ({ id })),
    stats: (id) => call('GET', `/streams/${encodeURIComponent(id)}`).then((r) => r.body, () => null),
    async stopAll() { clearInterval(refresher); await Promise.allSettled([...live.keys()].map((id) => api.stop(id))); },
  };
  const refresher = refreshMs > 0 ? setInterval(() => {
    for (const id of channel) {
      const ask = asks.get(id);
      if (ask && live.has(id)) call('PUT', `/streams/${encodeURIComponent(id)}`, ask).catch(() => {});
    }
  }, refreshMs) : null;
  refresher?.unref?.();
  return api;
}
