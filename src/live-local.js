// src/live-local.js - the local watch page's channel (LIVE_VIEW=local): one camera, its picture written as HLS (a
// playlist and 2 s segments) into a folder of the camera's own, which the agent serves at /live/<view id>/. It has the
// stream manager's interface (start, stop, caption, term, has, slot, list, stats, stopAll) plus focus(id), live() and
// hlsFile(name), like the Facebook channel (src/fb-live.js), and the same behaviour: a game is filmed only after
// live_view asked for it, first come, first served: the camera stays on the game that has it until that game ends (or
// has made no call for 5 minutes while others wait), then moves to the next game in line (the games that called
// live_view in the order of their first call; the owner's games, MCP_OWNER_KEY, first; a test's game last); when none
// is left the encoder stops and the folder is emptied (no stale picture ever plays). No account, no API, no caps: the
// video never leaves this machine unless the operator exposes the page.

import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { captionsOf, cleanCaption, HLS_FILE_RE } from './stream.js';
import { createTermStore } from './live-terms.js';

const NAME_RE = /^[A-Za-z0-9_]{3,16}$/;
const ID_RE = /^[A-Za-z0-9_-]{1,40}$/;
const clip = (s, n = 300) => String(s ?? '').replace(/\s+/g, ' ').trim().slice(0, n);

/** The number of the newest finished segment in a broadcast's folder (-1: none yet; one being written ends in .tmp). */
export function lastSegment(dir) {
  let max = -1;
  try {
    for (const f of fs.readdirSync(dir)) {
      const m = /^seg-(\d{1,12})\.ts$/.exec(f);
      if (m) max = Math.max(max, Number(m[1]));
    }
  } catch { /* no folder: none */ }
  return max;
}

/**
 * @param {object} o
 * @param {(opts: {output: string, player: string, event: Function}) => object} o.createStream   a camera stream
 *   (createCameraStream's interface, with follow(player))
 * @param {string} [o.dir]            where the HLS folders go (one per broadcast, removed when it ends)
 * @param {{event: Function}} [o.log]
 * @param {object} [o.streamOptions]  passed to every stream (fps, bitrate, layout, ...)
 * @param {number} [o.gameTtlMs]      a game the agent has not reported for this long leaves the channel (0: never)
 * @param {number} [o.idleMs]         a game on camera that makes no call this long gives the camera to the next (5 min)
 * @param {number} [o.leaseMs]        a game's longest life, for the wait in line (30 min)
 * @param {object} [o.record]         the recording's options (RECORD=on: src/recorder.js), or none
 * @param {string} [o.aspect]         the picture's shape for the watch page ("1080/1080")
 * @param {number} [o.pollMs]         how often a starting broadcast checks for its first segments
 * @param {number[]} [o.retryMs]      waits after failures
 */
export function createLocalChannel(o) {
  const now = o.now ?? Date.now;
  const root = o.dir || path.join(os.tmpdir(), 'agent-hls');
  const pollMs = o.pollMs ?? 1_000;
  const retryMs = o.retryMs ?? [5_000, 15_000, 30_000, 60_000];
  const event = (kind, data = {}) => { try { o.log?.event(kind, data); } catch { /* best effort */ } };

  const games = new Map(); // id -> {id, player, startedAt, seenAt, requestedAt, reqN, activeAt, camAt, local, owner, yielded, offs}
  const idleMs = o.idleMs ?? 300_000;
  const leaseMs = o.leaseMs ?? 1_800_000;
  const terms = createTermStore();
  const asked = new Map(); // id -> when live_view asked for a game the channel does not have yet
  const askedLocal = new Set(); // of those, the tests' games
  const askedOwner = new Set(); // of those, the owner's
  const askedN = new Map(); // their order
  let b = null; // the broadcast: {n, game, state, dir, stream, startedAt, liveAt, timer}
  let serial = 0;
  let failures = [];
  let restingUntil = 0;
  let lastError = null;
  let closing = false;
  let running = null;
  let dirty = false;

  let focus = null; // the game that has the camera
  // the line: the games that asked, by their first call; the owner's games first, a test's game after every player's
  const rank = (g) => (g.owner ? 0 : g.local ? 2 : 1);
  let reqN = 0; // the order of the calls, for calls in the same millisecond
  const queue = () => [...games.values()].filter((g) => g.requestedAt > 0).sort((x, y) => rank(x) - rank(y) || x.requestedAt - y.requestedAt || (x.reqN ?? 0) - (y.reqN ?? 0));
  /** The game the camera should film: the one that has it (until it ends, goes idle while others wait, or a game of a higher rank asks), else the first in line. */
  const pick = () => {
    const q = queue();
    if (!q.length) return null;
    const cur = focus ? games.get(focus) : null;
    if (cur && cur.requestedAt > 0 && !cur.yielded && rank(q[0]) >= rank(cur)) return cur.id;
    return q[0].id;
  };

  function kick() {
    dirty = true;
    running ??= (async () => {
      try {
        while (dirty) { dirty = false; await reconcile(); }
      } catch (err) {
        event('live_local_error', { message: clip(err?.message ?? err) });
      } finally { running = null; }
    })();
    return running;
  }

  async function reconcile() {
    const was = focus;
    focus = pick();
    // the idle clock of a game starts again when it gets the camera (in line it made no call: it was waiting)
    if (focus) { const fg = games.get(focus); fg.yielded = false; if (focus !== was) fg.camAt = now(); }
    if (b && (closing || !focus)) { await finish(closing ? 'the service stopped' : 'no game that asked for it is left'); return; }
    if (closing || !focus) return;
    if (!b) {
      if (restingUntil > now()) return;
      begin(focus);
      return;
    }
    if (b.game !== focus && b.state !== 'ending') {
      const g = games.get(focus);
      const from = b.game;
      b.game = focus;
      // the new game's picture starts after the segment being written now (which still shows the game before): a
      // game's watch page is served only segments from here on (src/web.js)
      b.fromSeg = lastSegment(b.dir) + 2;
      event('live_local_camera', { from, to: focus });
      let moving;
      // the recording (RECORD=on) goes on in the new game's folder
      try { moving = b.stream.follow(g.player, focus); } catch (err) { moving = Promise.reject(err); }
      terms.backfill(focus, b.stream); // follow() empties the HUD before its first wait: the new game's HUD goes in now
      try { await moving; } catch (err) { event('live_local_error', { what: 'move the camera', message: clip(err?.message ?? err) }); }
    }
  }

  function begin(game) {
    serial += 1;
    const dir = path.join(root, `b${process.pid}-${serial}`);
    const me = { n: serial, game, state: 'starting', dir, stream: null, startedAt: now(), liveAt: 0, timer: null, lost: false, fromSeg: 0 };
    b = me;
    try {
      fs.rmSync(dir, { recursive: true, force: true });
      fs.mkdirSync(dir, { recursive: true, mode: 0o755 });
      const stream = o.createStream({ ...(o.streamOptions ?? {}), output: path.join(dir, 'live.m3u8'), player: games.get(game).player, ...(o.record ? { record: { ...o.record, game } } : {}), event: (k, d) => event(k, { session: me.game, ...d }) });
      me.stream = stream;
      terms.backfill(game, stream);
      stream.finished.then((res) => { if (b === me && me.state !== 'ending') lost(me, res?.reason ?? 'the stream ended'); });
      Promise.resolve().then(() => stream.start()).catch((err) => { if (b === me && me.state !== 'ending') lost(me, `could not start: ${clip(err?.message ?? err)}`); });
      event('live_local_start', { game });
      lastError = null;
      poll(me);
    } catch (err) {
      lost(me, `could not start: ${clip(err?.message ?? err)}`);
    }
  }

  /** Live once the playlist lists a segment: what a watcher's player needs to start. */
  function poll(me) {
    clearTimeout(me.timer);
    me.timer = setTimeout(() => {
      if (b !== me || me.state === 'ending') return;
      let ok = false;
      try { ok = /#EXTINF/.test(fs.readFileSync(path.join(me.dir, 'live.m3u8'), 'utf8')); } catch { ok = false; }
      if (ok) {
        me.state = 'live';
        me.liveAt = now();
        event('live_local_live', { game: me.game, afterMs: me.liveAt - me.startedAt });
        return;
      }
      poll(me);
    }, pollMs);
    me.timer.unref?.();
  }

  function rest() {
    const t = now();
    failures = failures.filter((x) => x > t - 600_000);
    failures.push(t);
    const wait = retryMs[Math.min(retryMs.length - 1, failures.length - 1)];
    restingUntil = t + wait;
    setTimeout(() => kick(), wait + 10).unref?.();
  }

  function lost(me, why) {
    if (me.lost) return;
    me.lost = true;
    lastError = clip(why, 200);
    event('live_local_lost', { game: me.game, reason: lastError });
    rest();
    finish(`the stream failed: ${why}`, me).finally(() => kick());
  }

  async function finish(why, which = b) {
    const me = which;
    if (!me || me.state === 'ending') return;
    me.state = 'ending';
    clearTimeout(me.timer);
    if (me.stream) await Promise.resolve(me.stream.stop(why)).catch(() => {});
    fs.rm(me.dir, { recursive: true, force: true, maxRetries: 3 }, () => {});
    event('live_local_stop', { game: me.game, why: clip(why, 160), seconds: Math.round((now() - me.startedAt) / 1000), wasLive: Boolean(me.liveAt) });
    if (b === me) b = null;
  }

  const sweeper = setInterval(() => {
    if (o.gameTtlMs > 0) for (const g of [...games.values()]) if (now() - g.seenAt > o.gameTtlMs) api.stop(g.id, 'the agent stopped reporting the game');
    // the game on camera has made no call for idleMs while others wait: it goes to the back of the line
    const cur = focus ? games.get(focus) : null;
    const lastSign = cur ? Math.max(cur.activeAt ?? 0, cur.camAt ?? 0, cur.requestedAt) : 0;
    if (cur && !cur.yielded && cur.requestedAt > 0 && now() - lastSign > idleMs && queue().some((g) => g !== cur)) {
      cur.yielded = true;
      cur.requestedAt = now();
      cur.reqN = ++reqN;
      event('live_local_idle_handover', { game: cur.id, idleS: Math.round((now() - lastSign) / 1000) });
      kick();
    }
  }, o.sweepMs ?? 30_000);
  sweeper.unref?.();

  const api = {
    enabled: true,
    channel: true,
    /** Put a game on the channel (its bot's name is what the camera follows). Returns {id} or null for a bad name. */
    start(id, { player, body } = {}) {
      if (closing || !ID_RE.test(String(id)) || !NAME_RE.test(String(player ?? ''))) return null;
      const known = games.get(id);
      if (known) { known.seenAt = now(); return { id }; }
      const g = { id, player, startedAt: now(), seenAt: now(), activeAt: now(), requestedAt: asked.get(id) ?? 0, reqN: askedN.get(id) ?? 0, local: askedLocal.has(id), owner: askedOwner.has(id), yielded: false, offs: [] };
      asked.delete(id);
      askedN.delete(id);
      askedLocal.delete(id);
      askedOwner.delete(id);
      games.set(id, g);
      if (typeof body?.on === 'function') {
        try {
          g.offs.push(...captionsOf(body, (text) => api.caption(id, text)));
          g.offs.push(body.on('end', () => api.stop(id, 'the game ended')));
        } catch { /* no captions */ }
      }
      kick();
      return { id };
    },
    /** A game left: the camera moves on, or the broadcast ends. */
    stop(id, why = 'the game ended') {
      const g = games.get(id);
      asked.delete(id);
      askedN.delete(id);
      askedLocal.delete(id);
      askedOwner.delete(id);
      terms.delete(id);
      if (!g) return running ?? Promise.resolve();
      games.delete(id);
      for (const off of g.offs) { try { off?.(); } catch { /* ignore */ } }
      event('live_local_game_end', { session: id, why: clip(why, 120), games: games.size });
      return kick();
    },
    /**
     * live_view asked for this game: in line for the camera (its place kept from its first call), or on it. owner: the
     * owner's game (MCP_OWNER_KEY), first in line and taking the camera from a player's; local: a test's game, last.
     * Returns live(id).
     */
    focus(id, { local = false, owner = false } = {}) {
      if (!ID_RE.test(String(id))) return api.live();
      const g = games.get(id);
      if (g) {
        if (!(g.requestedAt > 0)) { g.requestedAt = now(); g.reqN = ++reqN; }
        g.seenAt = now(); g.activeAt = now();
        if (local) g.local = true;
        if (owner) g.owner = true;
      } else {
        if (!asked.has(id)) { asked.set(id, now()); askedN.set(id, ++reqN); }
        if (local) askedLocal.add(id);
        if (owner) askedOwner.add(id);
        for (const [k, t] of asked) if (now() - t > 120_000) { asked.delete(k); askedN.delete(k); askedLocal.delete(k); askedOwner.delete(k); }
      }
      kick();
      return api.live(id);
    },
    /**
     * What the channel shows now: state off | starting | live | ending | retrying, the game on camera. For a game (id)
     * in line behind another: state queued, with its place and the wait (about, from the games' leases).
     */
    live(id = null) {
      const out = api.liveNow();
      if (id === null || !ID_RE.test(String(id))) return out;
      const g = games.get(id);
      const holder = pick() ?? b?.game;
      if (!g || !(g.requestedAt > 0) || !holder || holder === id) return out;
      const line = queue().filter((x) => x.id !== holder);
      const position = line.findIndex((x) => x.id === id) + 1;
      if (position < 1) return out;
      const left = (x) => Math.max(1, Math.ceil((leaseMs - (now() - x.startedAt)) / 60_000));
      const h = games.get(holder);
      const waitMin = (h ? left(h) : 0) + line.slice(0, position - 1).reduce((a, x) => a + left(x), 0);
      return { ...out, state: 'queued', game: holder, queue: { position, waitMin } };
    },
    liveNow() {
      const want = pick();
      const resting = !b && want && restingUntil > now();
      return {
        fb: false,
        channel: 'local',
        state: b ? b.state : want ? (resting ? 'retrying' : 'starting') : 'off',
        game: b?.game ?? want,
        liveSince: b?.liveAt ? new Date(b.liveAt).toISOString() : null,
        aspect: b?.stream?.aspect ?? o.aspect ?? '16/9',
        games: games.size,
        error: lastError,
        retryInS: resting ? Math.ceil((restingUntil - now()) / 1000) : null,
        // the first segment of the game on camera, and the newest segment written: a game's page plays from fromSeg
        fromSeg: b?.fromSeg ?? 0,
        lastSeg: b ? lastSegment(b.dir) : -1,
      };
    },
    /** The path of one file of the broadcast's HLS folder (the playlist or a segment), or null. */
    hlsFile(name) {
      if (!b || !HLS_FILE_RE.test(String(name))) return null;
      return path.join(b.dir, String(name));
    },
    term(id, u) {
      if (!ID_RE.test(String(id)) || !u) return;
      terms.keep(id, u);
      // a call of the game: it is not idle (the camera's hand-over after idleMs without one)
      const g = games.get(id);
      if (g && Array.isArray(u.lines) && u.lines.some((l) => l?.k === 'call')) g.activeAt = now();
      if (id === b?.game && b?.stream) b.stream.term?.(u);
    },
    caption(id, text, pose) {
      if (id !== b?.game || !b?.stream) return;
      if (pose) b.stream.pose?.(pose);
      b.stream.caption?.(cleanCaption(text));
    },
    has: (id) => games.has(id),
    slot: (id) => (b && b.game === id ? 0 : null),
    get size() { return games.size; },
    list: () => [...games.values()].map((g) => ({ id: g.id, state: g.id === b?.game ? b.state : 'waiting', focused: g.id === b?.game })),
    stats: (id) => (b?.stream && b.game === id ? b.stream.stats({ resources: true }) : null),
    /** Every game off the channel and the stream stopped. */
    async stopAll(why = 'shutdown') {
      closing = true;
      for (const id of [...games.keys()]) api.stop(id, why);
      await kick();
      if (b) await finish(why);
      clearInterval(sweeper);
    },
    /** (tests) the work in progress has settled. */
    settled: async () => { while (running) await running; },
  };
  return api;
}
