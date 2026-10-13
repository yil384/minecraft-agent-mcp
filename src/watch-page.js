// src/watch-page.js - the local watch page (LIVE_VIEW=local): the camera's picture with the HUD, played from the HLS
// files the agent serves under /live/<id>/hls/ (src/web.js). A plain <video> element; Safari plays HLS by itself,
// every other browser through hls.js (Apache-2.0, served by the agent from its own node_modules, same origin, no
// worker). A small script asks /live/<id>/status every few seconds and says in words what the camera does: live on
// this game, on another game, starting, or off; it starts the player when the picture is there, and reloads it when the
// camera's broadcast changes or the picture stalls. The page makes no request to anything but this server.

import crypto from 'node:crypto';
import fs from 'node:fs';
import { createRequire } from 'node:module';

const esc = (s) => String(s ?? '').replace(/[&<>"']/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' })[c]);

const CSS = `:root{color-scheme:dark;--bg:#0d0e10;--fg:#ece8e0;--muted:#a59f94;--line:#2b2a27;--live:#e5484d;--accent:#7cc49b}
*{box-sizing:border-box}
html,body{margin:0;background:var(--bg);color:var(--fg);font:15px/1.5 ui-sans-serif,system-ui,-apple-system,"Segoe UI",sans-serif}
main{max-width:min(100vw,calc((100vh - 7.5rem) * var(--ar,1)),1100px);margin:0 auto;padding:12px 16px 0}
.frame{position:relative;width:100%;aspect-ratio:var(--ar,1);background:#000;border-radius:6px;overflow:hidden}
video{position:absolute;inset:0;width:100%;height:100%;object-fit:contain;background:#000}
.over{position:absolute;inset:0;display:flex;align-items:center;justify-content:center;padding:24px;text-align:center;color:var(--muted);background:#000}
.over[hidden]{display:none}
.bar{display:flex;gap:10px;align-items:baseline;flex-wrap:wrap;margin:10px 0 0}
.dot{display:inline-block;width:9px;height:9px;border-radius:50%;background:var(--muted);flex:none;transform:translateY(-1px)}
.dot.live{background:var(--live)}
#status{margin:0;flex:1 1 20rem}
.muted{color:var(--muted);font-size:.85rem;margin:6px 0 0}
footer{max-width:1100px;margin:14px auto 0;padding:10px 16px 18px;color:var(--muted);font-size:.78rem;border-top:1px solid var(--line)}`;

const STYLE_SRC = `'sha256-${crypto.createHash('sha256').update(CSS).digest('base64')}'`;
/** The watch page's policy: its own scripts only, video from this server (and the player's blob: buffers), no frames. */
export const WATCH_CSP = `default-src 'none'; script-src 'self'; style-src ${STYLE_SRC}; media-src 'self' blob:; connect-src 'self'; img-src 'self' data:; base-uri 'none'; form-action 'none'; frame-ancestors 'none'`;

/** The page's script (served as /live/assets/watch.js). Settings come from the script tag's data attributes. */
export const WATCH_SCRIPT = `(() => {
  const tag = document.currentScript;
  const base = tag.dataset.base;
  const v = document.getElementById('v');
  const over = document.getElementById('over');
  const status = document.getElementById('status');
  const dot = document.getElementById('dot');
  document.documentElement.style.setProperty('--ar', tag.dataset.aspect || '1');
  let hls = null;
  let playing = null; // the broadcast being played (its start time)
  let lastT = -1;
  let still = 0;
  const show = (text) => { over.textContent = text; over.hidden = false; };
  function detach() {
    if (hls) { try { hls.destroy(); } catch (e) { /* gone */ } hls = null; }
    v.removeAttribute('src');
    try { v.load(); } catch (e) { /* nothing loaded */ }
    playing = null;
  }
  function attach(since) {
    detach();
    playing = since || 'live';
    const src = base + 'hls/live.m3u8';
    if (window.Hls && window.Hls.isSupported()) {
      hls = new window.Hls({ enableWorker: false, lowLatencyMode: false, liveSyncDurationCount: 2, liveMaxLatencyDurationCount: 5, maxBufferLength: 8, backBufferLength: 8, manifestLoadingMaxRetry: 6, levelLoadingMaxRetry: 6, fragLoadingMaxRetry: 6 });
      hls.on(window.Hls.Events.ERROR, (ev, d) => { if (d && d.fatal) { detach(); } });
      hls.loadSource(src);
      hls.attachMedia(v);
    } else if (v.canPlayType('application/vnd.apple.mpegurl')) {
      v.src = src;
    } else { show('This browser cannot play the video (no HLS and no Media Source Extensions).'); return; }
    const p = v.play();
    if (p && p.catch) p.catch(() => {});
  }
  v.addEventListener('playing', () => { over.hidden = true; });
  // the sentence goes in one place: under the video while it plays, on the video (the overlay) while it does not
  function render(st) {
    const on = Boolean(st.live && st.here);
    dot.className = 'dot' + (on ? ' live' : '');
    status.textContent = on ? (st.text || '') : 'Not live here right now.';
  }
  async function poll() {
    try {
      const r = await fetch(base + 'status', { cache: 'no-store' });
      const st = await r.json();
      render(st);
      if (st.live && st.here) {
        if (!playing || (st.since && st.since !== playing)) attach(st.since);
      } else {
        if (playing) detach();
        show(st.text || 'Nothing on camera right now.');
      }
    } catch (e) {
      status.textContent = 'This server does not answer right now; trying again.';
    }
    setTimeout(poll, 4000);
  }
  // a picture that has not moved for 15 s while it should play: start the player again
  setInterval(() => {
    if (!playing || v.paused) { still = 0; return; }
    if (v.currentTime === lastT) { still += 1; if (still >= 3) { still = 0; attach(playing); } } else still = 0;
    lastT = v.currentTime;
  }, 5000);
  v.addEventListener('click', () => { if (v.muted) { v.muted = false; v.play().catch(() => {}); } });
  poll();
})();
`;

let hlsCache;
/** hls.js (the light build) from this server's node_modules, or null when it is not installed. */
export function hlsScript() {
  if (hlsCache !== undefined) return hlsCache;
  try {
    const req = createRequire(import.meta.url);
    hlsCache = fs.readFileSync(req.resolve('hls.js/dist/hls.light.min.js'), 'utf8');
  } catch { hlsCache = null; }
  return hlsCache;
}

/**
 * The page. base: the page's own path (/live/<id>/), aspect: the picture's shape ("1080/1080"), title: the server's
 * name, notice: the not-official line, what: one sentence about which game this page follows.
 */
export function watchPage({ base, aspect = '1', title = 'Live view', notice = '', what = '' }) {
  const ar = /^\d{1,5}\/\d{1,5}$/.test(String(aspect)) ? aspect : '1';
  return `<!doctype html>
<html lang="en">
<head>
<meta charset="utf-8">
<meta name="viewport" content="width=device-width, initial-scale=1">
<meta name="robots" content="noindex, nofollow">
<title>Live: ${esc(title)}</title>
<style>${CSS}</style>
</head>
<body>
<main>
<div class="frame"><video id="v" autoplay muted playsinline controls></video><div id="over" class="over">Waiting for the camera...</div></div>
<div class="bar"><span id="dot" class="dot" aria-hidden="true"></span><p id="status" role="status">Asking the server what the camera does...</p></div>
<p class="muted">${esc(what)} The video is about 5 to 8 seconds behind the game and starts muted: click it for sound.</p>
</main>
<footer>${esc(notice)}</footer>
<script src="/live/assets/hls.light.min.js"></script>
<script src="/live/assets/watch.js" data-base="${esc(base)}" data-aspect="${esc(ar)}"></script>
</body>
</html>
`;
}
