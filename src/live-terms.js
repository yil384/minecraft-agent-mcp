// src/live-terms.js - the HUD of every game on a live channel, kept while the game is off camera. A channel films one
// game at a time (one camera); when the camera moves to another game, or a stream starts for it, the HUD begins with
// that game's start (start_game and what came with it), its last lines and its status, not with an empty panel. Shared
// by the Facebook channel (src/fb-live.js) and the local watch page's channel (src/live-local.js).

const TERM_HEAD = 4;
const TERM_TAIL = 36; // with the 4 first lines, within the 40 a term update carries
const GAMES_KEPT = 64;

export function createTermStore() {
  const terms = new Map(); // id -> {head: [{k, t}], tail: [{k, t}], cut: boolean, status: string, updates: number, ...}
  return {
    /** One HUD update (src/terminal.js) for a game, kept whether or not it is on camera. */
    keep(id, u) {
      let t = terms.get(id);
      if (!t) {
        if (terms.size >= GAMES_KEPT) terms.delete(terms.keys().next().value);
        t = { head: [], tail: [], cut: false, status: '', updates: 0 };
        terms.set(id, t);
      }
      for (const l of Array.isArray(u?.lines) ? u.lines : []) {
        if (t.updates === 0 && t.head.length < TERM_HEAD) t.head.push(l);
        else t.tail.push(l);
      }
      if (t.tail.length > TERM_TAIL) { t.tail.splice(0, t.tail.length - TERM_TAIL); t.cut = true; }
      if (typeof u?.status === 'string' && u.status) t.status = u.status;
      if (u?.st) t.st = u.st; // the numbers, and what is happening now, for the UI panel
      if (u?.live) t.live = u.live;
      if (u && 'sub' in u) t.sub = u.sub;
      // the HUD's state: the items, where the bot is, the goal, the advice, the game's age (when it was told)
      for (const k of ['inv', 'pos', 'goal', 'adv']) if (u?.[k]) t[k] = u[k];
      if (u?.game) t.game = { ...u.game, at: Date.now() };
      t.updates += 1;
    },
    /** The game's HUD so far onto a stream that films it from now on. */
    backfill(id, stream) {
      const t = terms.get(id);
      if (!t || typeof stream?.term !== 'function') return;
      const lines = [...t.head, ...(t.cut ? [{ k: 'info', t: '...' }] : []), ...t.tail];
      const hud = Object.fromEntries(['inv', 'pos', 'goal', 'adv'].filter((k) => t[k]).map((k) => [k, t[k]]));
      if (t.game) {
        const { at, ...game } = t.game;
        hud.game = Number.isFinite(game.s) ? { ...game, s: game.s + Math.max(0, Math.round((Date.now() - at) / 1000)) } : game;
      }
      try { stream.term({ lines, status: t.status, ...(t.st ? { st: t.st } : {}), ...(t.live ? { live: t.live } : {}), ...('sub' in t ? { sub: t.sub } : {}), ...hud }); } catch { /* the video goes on without it */ }
    },
    delete: (id) => terms.delete(id),
  };
}
