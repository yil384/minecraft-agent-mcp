// src/config.js - every setting comes from an env var with a default, is checked once and frozen. The secrets (the MCP
// access key, the admin token, the proxy secret, the stream URLs, which hold stream keys) are non-enumerable, so
// JSON.stringify(config) and console.log(config) never print them. The user-facing settings are few (.env.example,
// docs/CONFIG.md); LIVE_VIEW=off|local|facebook decides the camera's settings, which stay overridable one by one.

import crypto from 'node:crypto';
import fs from 'node:fs';
import net from 'node:net';
import os from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

export const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
/** What a game shows of itself: nothing (off), a watch page served here (local), or a Facebook live (facebook). */
export const LIVE_VIEWS = Object.freeze(['off', 'local', 'facebook']);
/** The camera service's control API, inside the shared network namespace (compose.yaml). */
export const CAMERA_SERVICE_URL = 'http://127.0.0.1:7862';
/** An access key: what goes into the MCP URL (/mcp/<key>). */
export const ACCESS_KEY_RE = /^[A-Za-z0-9_-]{16,128}$/;

export class ConfigError extends Error {
  constructor(problems) {
    super(`bad configuration:\n- ${problems.join('\n- ')}`);
    this.name = 'ConfigError';
    this.problems = problems;
  }
}

/** True for localhost / 127.x / ::1: the only hosts tests may talk to and where no key is needed. */
export function isLoopbackHost(host) {
  const h = String(host).replace(/^\[|\]$/g, '').toLowerCase();
  return h === 'localhost' || h === '::1' || /^127\.\d+\.\d+\.\d+$/.test(h);
}

/**
 * Host names a browser may use for this server without any setting, besides loopback and IP addresses: the public
 * names of tunnel services whose DNS nobody else controls (so a page elsewhere cannot point one at this machine, as a
 * DNS-rebinding attack needs). Any other name must be WEB_PUBLIC_URL's or listed in WEB_ALLOWED_HOSTS.
 */
export const TUNNEL_DOMAINS = Object.freeze(['trycloudflare.com', 'ts.net', 'ngrok-free.app', 'ngrok-free.dev', 'ngrok.app', 'ngrok.io']);

/** The default gateway's IPv4 address from /proc/net/route (Linux; in a container, the host's side of the bridge). */
export function defaultGateway(routeFile = '/proc/net/route') {
  let text;
  try { text = fs.readFileSync(routeFile, 'utf8'); } catch { return null; }
  for (const line of text.split('\n').slice(1)) {
    const f = line.trim().split(/\s+/);
    if (f.length < 3 || f[1] !== '00000000' || !/^[0-9A-Fa-f]{8}$/.test(f[2]) || f[2] === '00000000') continue;
    const n = Number.parseInt(f[2], 16); // little-endian
    return [n & 255, (n >>> 8) & 255, (n >>> 16) & 255, n >>> 24].join('.');
  }
  return null;
}

/** True for loopback or a private LAN address: where the Minecraft server is allowed to live. */
export function isLanHost(host) {
  const h = String(host).replace(/^\[|\]$/g, '').toLowerCase();
  if (isLoopbackHost(h) || h.endsWith('.local')) return true;
  const m = h.match(/^(\d+)\.(\d+)\.\d+\.\d+$/);
  if (m) {
    const [a, b] = [Number(m[1]), Number(m[2])];
    return a === 10 || (a === 172 && b >= 16 && b <= 31) || (a === 192 && b === 168) || (a === 169 && b === 254);
  }
  return /^f[cd][0-9a-f]{2}:/.test(h) || /^fe80:/.test(h);
}

/** True when a URL points at this machine, false for anything remote. */
export function isLocalUrl(url) {
  try { return isLoopbackHost(new URL(url).hostname); } catch { return false; }
}

/** An IP address or an IP/prefix range (CIDR) such as 172.18.0.5 or 172.18.0.0/16: [address, prefix|null], or null. */
export function parseAddressRange(text) {
  const m = String(text ?? '').trim().match(/^([^/\s]+)(?:\/(\d{1,3}))?$/);
  if (!m) return null;
  const ip = m[1].replace(/^\[|\]$/g, '');
  const family = net.isIP(ip);
  if (!family) return null;
  if (m[2] === undefined) return [ip, null];
  const prefix = Number(m[2]);
  return prefix <= (family === 4 ? 32 : 128) ? [ip, prefix] : null;
}

/**
 * The Facebook video plugin URL that plays a live video (its public URL) inside another page's frame: the form some
 * MCP clients' preview panels allow.
 */
export function facebookEmbedUrl(videoUrl) {
  return `https://www.facebook.com/plugins/video.php?href=${encodeURIComponent(videoUrl)}&show_text=false&width=1280`;
}

/** True for an https URL on facebook.com (or fb.watch): the only live-video player such a panel frames. */
export function isFacebookVideoUrl(url) {
  try {
    const u = new URL(url);
    return u.protocol === 'https:' && (/(^|\.)facebook\.com$/i.test(u.hostname) || /^fb\.watch$/i.test(u.hostname)) && !u.username;
  } catch { return false; }
}

function reader(env, problems) {
  const raw = (k) => {
    const v = env[k];
    return v === undefined || String(v).trim() === '' ? undefined : String(v).trim();
  };
  const bad = (k, want, v) => problems.push(`${k} must be ${want} (got "${v}")`);
  return {
    str: (k, def) => raw(k) ?? def,
    int(k, def, min, max) {
      const v = raw(k);
      if (v === undefined) return def;
      const n = Number(v);
      if (!Number.isInteger(n) || n < min || n > max) { bad(k, `an integer from ${min} to ${max}`, v); return def; }
      return n;
    },
    num(k, def, min, max) {
      const v = raw(k);
      if (v === undefined) return def;
      const n = Number(v);
      if (!Number.isFinite(n) || n < min || n > max) { bad(k, `a number from ${min} to ${max}`, v); return def; }
      return n;
    },
    bool(k, def) {
      const v = raw(k);
      if (v === undefined) return def;
      if (/^(1|true|yes|on)$/i.test(v)) return true;
      if (/^(0|false|no|off)$/i.test(v)) return false;
      bad(k, 'true or false', v);
      return def;
    },
    oneOf(k, def, list) {
      const v = raw(k);
      if (v === undefined) return def;
      if (!list.includes(v)) { bad(k, `one of ${list.join(', ')}`, v); return def; }
      return v;
    },
  };
}

function deepFreeze(o) {
  for (const v of Object.values(o)) if (v && typeof v === 'object' && !Object.isFrozen(v)) deepFreeze(v);
  return Object.freeze(o);
}

function hidden(obj, key, value) {
  Object.defineProperty(obj, key, { value, enumerable: false });
  return obj;
}

/** The camera watch page's key derived from the MCP access key (WATCH_KEY unset): 32 hex characters of an HMAC. */
export function watchKeyOf(accessKey) {
  return crypto.createHmac('sha256', String(accessKey)).update('watch').digest('hex').slice(0, 32);
}

/** Build a frozen config from an env object (defaults to process.env). Throws ConfigError listing every problem. */
export function loadConfig(env = process.env) {
  const problems = [];
  const r = reader(env, problems);
  const fromRoot = (p) => path.resolve(ROOT, p);

  // Minecraft: offline-mode server, so it must never be reachable from the internet.
  const mc = {
    host: r.str('MC_HOST', '127.0.0.1'),
    port: r.int('MC_PORT', 25565, 1, 65535),
    version: r.str('MC_VERSION', '1.21.4'),
    username: r.str('MC_USERNAME', 'Bot'),
    // the server lets in only listed players (the Paper container): each guest bot gets a name nobody can guess and is
    // put on the list through the console (MC_CONSOLE) just before it joins, and taken off when it leaves
    whitelist: r.bool('MC_WHITELIST', false),
    auth: 'offline',
  };
  if (!isLanHost(mc.host)) problems.push(`MC_HOST must be localhost or a LAN address, never a public host (got "${mc.host}")`);
  if (!/^[A-Za-z0-9_]{3,16}$/.test(mc.username)) problems.push(`MC_USERNAME must be 3-16 letters, digits or _ (got "${mc.username}")`);

  // The web port: MCP for the agents, the watch pages; the only part meant to be exposed (through a tunnel).
  const trustRaw = r.str('WEB_TRUST_PROXY', 'off').toLowerCase();
  let trustProxy = 'off';
  if (trustRaw === 'cloudflare' || trustRaw === 'off') trustProxy = trustRaw;
  else if (/^[1-5]$/.test(trustRaw)) trustProxy = Number(trustRaw);
  else problems.push(`WEB_TRUST_PROXY must be off, cloudflare or a number of proxy hops from 1 to 5 (got "${trustRaw}")`);
  // The proxy's own address(es): forwarded headers count only on connections from there, and any other peer that is
  // not this machine is refused (for example the reverse proxy container in front of the published port).
  const trustedProxies = r.str('WEB_TRUSTED_PROXIES', '').split(',').map((x) => x.trim()).filter(Boolean);
  for (const t of trustedProxies) if (!parseAddressRange(t)) problems.push(`WEB_TRUSTED_PROXIES must be IP addresses or ranges such as 172.18.0.5 or 172.18.0.0/16, separated by commas (got "${t}")`);
  if (trustedProxies.length && trustProxy === 'off') problems.push('WEB_TRUSTED_PROXIES needs WEB_TRUST_PROXY (cloudflare, or the number of proxies that append to X-Forwarded-For)');
  // bots at once (MAX_GAMES; WEB_MAX_SESSIONS is the older name): each one is a bot process of 0.3-1 GB
  const maxSessions = r.int('WEB_MAX_SESSIONS', r.int('MAX_GAMES', 2, 1, 64), 1, 64);
  const host = r.str('WEB_HOST', '127.0.0.1');
  const web = {
    host,
    port: r.int('WEB_PORT', 8787, 0, 65535),
    publicUrl: r.str('WEB_PUBLIC_URL', '').replace(/\/+$/, ''),
    // the page title, the server's MOTD and the start of a Facebook live's title
    name: r.str('SERVER_NAME', 'Agent game server'),
    // the operator, named in the pages' footer when set ("Run by <operator>")
    operator: r.str('SITE_OPERATOR', ''),
    trustProxy,
    trustedProxies,
    // a game lasts GAME_LEASE_MIN minutes (WEB_LEASE_MS in ms, if set, wins), and ends after GAME_IDLE_MIN without calls
    leaseMs: r.int('WEB_LEASE_MS', r.int('GAME_LEASE_MIN', 60, 1, 1_440) * 60_000, 10_000, 86_400_000),
    idleMs: r.int('GAME_IDLE_MIN', 10, 1, 1_440) * 60_000,
    // a test caller (TEST SCRIPT: the check scripts, by their MCP client name) gets no Facebook live from live_view
    // unless this is on: the live videos a day are few (FB_MAX_PER_DAY) and meant for real games
    testLives: r.bool('MCP_TEST_LIVE', false),
    // with it on, a test caller's live_view has the camera film its game for the recording only (RECORD on the camera
    // service), never on Facebook: how the recording is tested without spending a live video
    testRecord: r.bool('MCP_TEST_RECORD', false),
    maxSessions,
    // live MCP games one address may hold (behind a cloud client, many people can share one address)
    mcpGamesPerAddress: r.int('WEB_MCP_GAMES_PER_ADDRESS', Math.max(2, maxSessions), 1, 64),
    // MCP sessions (connections) in all, and per address
    mcpSessions: r.int('MCP_SESSIONS', 200, 1, 10_000),
    mcpSessionsPerAddress: r.int('MCP_SESSIONS_PER_ADDRESS', 20, 1, 10_000),
    // the zero-JS pages (/play, /api, /session, /openapi.json) that start bots without MCP: off unless asked for
    guestPages: r.bool('WEB_GUEST_PAGES', false),
    // host names this server answers to besides loopback, IP addresses, WEB_PUBLIC_URL's and the tunnel services'
    // (TUNNEL_DOMAINS): a request for any other name is refused (DNS rebinding). ".example.org" allows its subdomains.
    allowedHosts: r.str('WEB_ALLOWED_HOSTS', '').split(',').map((x) => x.trim().toLowerCase()).filter(Boolean),
    // peers that count as this machine besides loopback: addresses or ranges, or "gateway" (in a container: the
    // bridge's gateway, which every connection through Docker's published port on 127.0.0.1 comes from)
    localPeers: r.str('WEB_LOCAL_PEERS', '').split(',').map((x) => x.trim()).filter(Boolean),
    // this server's URL on this machine, for links when a request does not say (compose.yaml sets the host's port)
    localUrl: r.str('WEB_LOCAL_URL', '').replace(/\/+$/, ''),
    // limits for a server you share (README, "Hosting a public server"): new games one address may start in an
    // hour, the requests one MCP session may send in a minute
    mcpStartsPerHour: r.int('WEB_MCP_STARTS_PER_HOUR', 10, 1, 10_000),
    mcpRequestsPerMinute: r.int('WEB_MCP_REQUESTS_PER_MINUTE', 120, 10, 100_000),
    // PUBLIC_PLAY=off closes the server to new games (start_game answers CLOSED) except for the owner's key
    // (MCP_OWNER_KEY); POST /admin/public does the same at once, without a restart. PUBLIC_CHAT=off keeps say (in-game
    // chat) to the owner's key
    publicPlay: r.bool('PUBLIC_PLAY', true),
    publicChat: r.bool('PUBLIC_CHAT', true),
    // the project's source, linked from the page a browser gets at /mcp (off: no link; empty: this project)
    openSourceUrl: ((u) => (/^(off|none|false)$/i.test(u) ? '' : u))(r.str('OPEN_SOURCE_URL', 'https://github.com/yil384/minecraft-agent-mcp')),
    // address hashes that may not play (GET /admin/games shows them): comma separated
    bannedIps: r.str('WEB_BANNED_IPS', '').split(',').map((x) => x.trim().toLowerCase()).filter(Boolean),
    maxBodyBytes: r.int('WEB_MAX_BODY', 8_192, 1_024, 1_048_576),
  };
  if (web.openSourceUrl && !/^https:\/\/[^\s"<>]+$/.test(web.openSourceUrl)) problems.push(`OPEN_SOURCE_URL must be an https URL (got "${web.openSourceUrl}")`);
  for (const h of web.allowedHosts) if (!/^\.?[a-z0-9]([a-z0-9.-]{0,251}[a-z0-9])?$/.test(h)) problems.push(`WEB_ALLOWED_HOSTS must be host names (or .domain for its subdomains), separated by commas (got "${h}")`);
  for (const t of web.localPeers) if (t !== 'gateway' && !parseAddressRange(t)) problems.push(`WEB_LOCAL_PEERS must be IP addresses, ranges or the word gateway, separated by commas (got "${t}")`);
  if (web.localUrl) {
    try { if (!/^https?:$/.test(new URL(web.localUrl).protocol)) problems.push('WEB_LOCAL_URL must be http(s)'); } catch { problems.push(`WEB_LOCAL_URL is not a URL (got "${web.localUrl}")`); }
  }
  if (web.name.length > 60 || /[\r\n<>]/.test(web.name)) problems.push('SERVER_NAME must be one line of at most 60 characters, without < or >');
  if (web.operator.length > 80 || /[\r\n<>]/.test(web.operator)) problems.push('SITE_OPERATOR must be one line of at most 80 characters, without < or >');
  // The MCP endpoint's key: /mcp/<key> (or /mcp with "Authorization: Bearer <key>"). Without one, /mcp answers only
  // requests that did not come through a proxy or tunnel, and only on a loopback WEB_HOST.
  const accessKey = r.str('MCP_ACCESS_KEY', '');
  if (accessKey && !ACCESS_KEY_RE.test(accessKey)) problems.push('MCP_ACCESS_KEY must be 16-128 letters, digits, _ or - (make one with: openssl rand -hex 16)');
  if (!accessKey && !isLoopbackHost(host)) problems.push(`MCP_ACCESS_KEY is required when WEB_HOST (${host}) is not this machine's loopback: anyone who reaches the port could play (make one with: openssl rand -hex 16)`);
  hidden(web, 'accessKey', accessKey);
  // The watch page of whatever the camera films (/live/<WATCH_KEY>/): its own key, so a shared watch link never lets
  // anyone play. Empty: derived from MCP_ACCESS_KEY (an HMAC, so it gives the access key away to nobody).
  const watchKeyRaw = r.str('WATCH_KEY', '');
  if (watchKeyRaw && !ACCESS_KEY_RE.test(watchKeyRaw)) problems.push('WATCH_KEY must be 16-128 letters, digits, _ or - (make one with: openssl rand -hex 16)');
  if (watchKeyRaw && watchKeyRaw === accessKey) problems.push('WATCH_KEY must differ from MCP_ACCESS_KEY: a watch link must never let anyone play');
  hidden(web, 'watchKey', watchKeyRaw || (accessKey ? watchKeyOf(accessKey) : ''));
  if (web.publicUrl) {
    try {
      if (!/^https?:$/.test(new URL(web.publicUrl).protocol)) problems.push('WEB_PUBLIC_URL must be http(s)');
    } catch { problems.push(`WEB_PUBLIC_URL is not a URL (got "${web.publicUrl}")`); }
  }
  const adminToken = r.str('WEB_ADMIN_TOKEN', '');
  if (adminToken && adminToken.length < 24) {
    problems.push('WEB_ADMIN_TOKEN must be at least 24 characters (make one with: openssl rand -base64 24)');
  }
  hidden(web, 'adminToken', adminToken);
  // the salt of the address hashes (logs and the operator see a hash, never an address); without it, one made from
  // the admin token (stable across restarts), else a random one for this process
  hidden(web, 'ipSalt', r.str('WEB_IP_SALT', ''));
  // A secret the proxy in front adds to every request it forwards (X-Proxy-Secret; Caddy: header_up). When the published
  // port goes through docker-proxy, every connection arrives from the bridge gateway, the proxy's and any local user's
  // alike: the address cannot tell them apart, the secret can.
  const proxySecret = r.str('WEB_PROXY_SECRET', '');
  if (proxySecret && (proxySecret.length < 24 || !/^[\x21-\x7e]+$/.test(proxySecret))) {
    problems.push('WEB_PROXY_SECRET must be at least 24 printable characters without spaces (make one with: openssl rand -hex 24)');
  }
  if (proxySecret && trustProxy === 'off') problems.push('WEB_PROXY_SECRET needs WEB_TRUST_PROXY (cloudflare, or the number of proxies that append to X-Forwarded-For)');
  hidden(web, 'proxySecret', proxySecret);
  // The owner's key (.env, never in code): an MCP connection that brings it (?owner=<key> on the MCP URL, or the header
  // X-Owner-Key) puts its games first in line for the camera (src/fb-live.js, src/live-local.js) and for a bot, plays
  // while public play is off, may use say, and is held to none of the per-address limits or bans
  const ownerKey = r.str('MCP_OWNER_KEY', '');
  if (ownerKey && (ownerKey.length < 16 || !/^[A-Za-z0-9_-]+$/.test(ownerKey))) problems.push('MCP_OWNER_KEY must be at least 16 letters, digits, _ or - (make one with: openssl rand -hex 16)');
  if (ownerKey && ownerKey === accessKey) problems.push('MCP_OWNER_KEY must differ from MCP_ACCESS_KEY: everyone with the MCP URL has the access key');
  hidden(web, 'ownerKey', ownerKey);

  // Which body plays a guest game: mineai (one Mine AI MCP host per game in its own process, src/mineai/; what the
  // Docker setup runs) or ours (mineflayer in this process, src/body.js; development, tests and --fake-bot).
  const body = {
    kind: r.oneOf('BODY', 'ours', ['ours', 'mineai']),
    maxTravel: r.int('BODY_MAX_TRAVEL', 256, 8, 10_000),
  };
  // BODY=mineai: the Mine AI MCP runtime (built by mineai/fetch-and-patch.sh), one host per guest game on
  // a loopback port of a private range, with a random token per host (never on a command line)
  const mineaiDir = r.str('MINEAI_DIR', '');
  const mineaiData = r.str('MINEAI_DATA_DIR', '');
  const mineai = {
    dir: mineaiDir ? path.resolve(ROOT, mineaiDir) : '',
    runtime: r.oneOf('MINEAI_RUNTIME', 'node', ['node', 'bun']),
    exec: r.str('MINEAI_EXEC', ''), // the node (24.15 or newer) or bun binary; default: this node, or "bun" on the PATH
    portBase: r.int('MINEAI_PORT_BASE', 27100, 1024, 65_000),
    ports: r.int('MINEAI_PORTS', 64, 1, 512),
    maxHosts: r.int('MINEAI_MAX_HOSTS', maxSessions, 1, 64),
    startMs: r.int('MINEAI_START_MS', 90_000, 5_000, 600_000),
    heartbeatMs: r.int('MINEAI_HEARTBEAT_MS', 5_000, 200, 60_000),
    heartbeatMisses: r.int('MINEAI_HEARTBEAT_MISSES', 3, 1, 100),
    // the runtime's own watchdog (its child's event loop), patched to read this: 5 s upstream, more for a loaded host
    unresponsiveMs: r.int('MINEAI_UNRESPONSIVE_MS', 5_000, 5_000, 120_000),
    dataDir: mineaiData ? path.resolve(ROOT, mineaiData) : '', // per-bot SQLite; empty: temporary, gone with the host
    // a game's bot data and incidents are deleted when it ends, except the last keepFailed games that crashed or failed
    // to join (for diagnosis); at agent start, game folders older than dataDays go
    keepFailed: r.int('MINEAI_KEEP_FAILED', 10, 0, 1_000),
    dataDays: r.num('MINEAI_DATA_DAYS', 3, 0.01, 365),
    // the 3D browser views (/eyes, /watch) from a viewer inside the host's bot process (VIEW_3D; only when the optional
    // prismarine-viewer package is installed: its textures are Mojang's, so it is not a dependency of this project)
    views: r.bool('MINEAI_VIEWS', r.bool('VIEW_3D', true)),
    // the body and the player (src/mineai/care.js): advise (the default: the player plans its survival from the advice
    // in every reply; the body acts by itself only by the rules the player set, none at the start), full (it also shelters, eats, hunts, crafts
    // a shield, armor and spare tools and goes back after a death by itself, between the player's calls: for casual
    // guests), off (only their reflexes, as they come). true and false, the old values, are full and off.
    care: (() => {
      const key = env.MINEAI_CARE !== undefined && String(env.MINEAI_CARE).trim() !== '' ? 'MINEAI_CARE' : 'BOT_CARE';
      const v = String(r.str(key, '')).trim();
      if (/^(1|true|yes|on)$/i.test(v)) return 'full';
      if (/^(0|false|no)$/i.test(v)) return 'off';
      return r.oneOf(key, 'advise', ['advise', 'full', 'off']);
    })(),
  };
  if (body.kind === 'mineai' && !mineai.dir) problems.push('BODY=mineai needs MINEAI_DIR, the folder with the Mine AI MCP runtime (mineai/fetch-and-patch.sh <dir>)');
  if (mineai.portBase + 3 * mineai.ports > 65_535) problems.push('MINEAI_PORT_BASE + 3 x MINEAI_PORTS must stay under 65536 (each host takes a port and its two live views two more)');

  const log = { dir: fromRoot(r.str('LOG_DIR', 'logs')) };

  // The live view (LIVE_VIEW): off; local, the camera's picture as HLS for the watch page served here; facebook, a live
  // video on the operator's own Facebook profile or Page. The camera (the real Minecraft client) runs in its own
  // container (STREAM_ROLE=camera) behind a loopback API that the agent reaches at STREAM_SERVICE_URL.
  const liveView = r.oneOf('LIVE_VIEW', 'off', LIVE_VIEWS);
  const role = r.oneOf('STREAM_ROLE', 'agent', ['agent', 'camera']);
  // advanced: every game streamed to these RTMP(S) URLs (or as MP4 files into STREAM_OUT_DIR) instead of a channel
  const outputs = r.str('STREAM_RTMP_URL', '').split(',').map((x) => x.trim()).filter(Boolean);
  if (outputs.some((o) => !/^rtmps?:\/\/[^\s/]+\/\S+$/i.test(o))) problems.push('STREAM_RTMP_URL must be rtmp:// or rtmps:// URLs with their stream key, separated by commas');
  const outDir = r.str('STREAM_OUT_DIR', '');
  const serviceRaw = r.str('STREAM_SERVICE_URL', role === 'agent' && liveView !== 'off' ? CAMERA_SERVICE_URL : '');
  // The camera service's control API (PUT /streams/<game> can start a Facebook live) answers only requests with this
  // token, which the agent and the camera share (setup.sh writes it; at least 24 characters)
  const serviceToken = r.str('STREAM_SERVICE_TOKEN', '');
  if (serviceToken && (serviceToken.length < 24 || !/^[\x21-\x7e]+$/.test(serviceToken))) problems.push('STREAM_SERVICE_TOKEN must be at least 24 printable characters without spaces (make one with: openssl rand -hex 24)');
  const stream = {
    liveView,
    role,
    enabled: r.bool('STREAM_ENABLED', liveView !== 'off'),
    // the camera service the agent talks to; 'off' runs the camera inside the agent's own process
    serviceUrl: role === 'camera' || /^off$/i.test(serviceRaw) ? '' : serviceRaw.replace(/\/+$/, ''),
    // LIVE_VIEW=local: the camera writes HLS for the watch page into folders under this one
    hls: liveView === 'local',
    hlsDir: path.resolve(r.str('STREAM_HLS_DIR', path.join(r.str('CAMERA_HOME', os.tmpdir()), 'hls'))),
    outDir: outDir ? fromRoot(outDir) : '',
    max: r.int('STREAM_MAX', 1, 0, 16),
    fps: r.int('STREAM_FPS', 30, 10, 30),
    bitrateK: r.int('STREAM_BITRATE_K', 3500, 500, 8000),
    // test only: a large wall clock (HH:MM:SS in STREAM_CLOCK_TZ) burned into the top-right corner, to read the
    // end-to-end delay against a clock on the viewer's screen
    clock: r.bool('STREAM_CLOCK', false),
    clockTz: r.str('STREAM_CLOCK_TZ', 'UTC'),
    // the camera's picture: 'ui', square by default, the game on top and the HUD under it (src/ui-panel.js: the
    // command in plain words, the why and plan, the advice, the status); 'terminal', vertical, the game over a terminal
    // of the agent's calls; or 'landscape', the game alone at 1280x720
    layout: r.oneOf('STREAM_LAYOUT', 'ui', ['ui', 'terminal', 'landscape']),
    uiSize: r.oneOf('STREAM_UI_SIZE', '1080x1080', ['1080x1080', '1080x1200', '1080x1350']),
    // the HUD's design in the ui layout: 'b' (concept B "Speedrun broadcast", src/hud-b.js) or 'final' (the one before)
    hud: r.oneOf('STREAM_HUD', 'b', ['b', 'final']),
    // a logo at the top right of the video and on the live page's poster (B only; never in the clean recording): off
    // (the default), a transparent light logo drawn as it is with a hard dark shadow (plain), or a light logo on a white
    // card (card); STREAM_LOGO_FILE its PNG, a path under assets/ (brand/...) or an absolute path. There is no default:
    // the lab's pixel logo in assets/brand is not under the Apache licence (NOTICE) and is shown only when named here
    logo: r.oneOf('STREAM_LOGO', 'off', ['off', 'card', 'plain']),
    logoFile: r.str('STREAM_LOGO_FILE', ''),
    terminalSize: r.oneOf('STREAM_TERMINAL_SIZE', '1080x1920', ['1080x1920', '1080x1350']),
    // the sound: the game's own from the client (STREAM_GAME_AUDIO, its music off), and a soft CC0 music bed under it
    // (STREAM_MUSIC, assets/ui/music), ducked while the game is loud, then a limiter
    gameAudio: r.bool('STREAM_GAME_AUDIO', true),
    music: r.bool('STREAM_MUSIC', true),
    musicFile: r.str('STREAM_MUSIC_FILE', ''),
    musicDb: r.num('STREAM_MUSIC_DB', -15, -40, 6),
    gameDb: r.num('STREAM_GAME_DB', 12, -30, 24),
    camera: {
      mcDir: r.str('CAMERA_MC_DIR', '/opt/mc'),
      mainDir: r.str('CAMERA_MAIN_DIR', ''), // the launcher class (docker/camera/CameraMain.java); default <mcDir>/camera-main
      home: path.resolve(r.str('CAMERA_HOME', path.join(os.tmpdir(), 'agent-camera'))),
      authDir: r.str('CAMERA_AUTH_DIR', '') ? path.resolve(r.str('CAMERA_AUTH_DIR', '')) : '',
      // your own Azure app for the camera's sign-in (empty: prismarine-auth's default device-code flow)
      msaClientId: r.str('CAMERA_MSA_CLIENT_ID', ''),
      name: r.str('CAMERA_NAME', ''),
      gl: r.oneOf('CAMERA_GL', 'cpu', ['cpu', 'gpu']),
      // llvmpipe's threads: 8 at 960x540; the film's 1920x1080 wants 16 (and CAMERA_CPUS=24)
      glThreads: r.int('CAMERA_GL_THREADS', r.bool('CAMERA_FILM', false) ? 16 : 8, 1, 64),
      javaThreads: r.int('CAMERA_JAVA_THREADS', 4, 1, 64),
      heapMB: r.int('CAMERA_HEAP_MB', 2048, 512, 16_384),
      maxFps: r.int('CAMERA_MAX_FPS', 30, 10, 120),
      renderDistance: r.int('CAMERA_RENDER_DISTANCE', 5, 2, 32),
      graphics: r.oneOf('CAMERA_GRAPHICS', 'fast', ['fast', 'fancy']),
      display: r.int('CAMERA_DISPLAY', 99, 1, 900),
      scale: r.num('CAMERA_SCALE', 0.75, 0.5, 1),
      // film mode (off by default): the client drawn at 1920x1080 for the clean recording (the live is scaled down to
      // its 1080 square as always); costs client frames on llvmpipe (docs/CONFIG.md, "Recordings")
      film: r.bool('CAMERA_FILM', false),
      javaNice: r.int('CAMERA_NICE', 5, 0, 19),
      idleMs: r.int('CAMERA_IDLE_MS', 600_000, 0, 86_400_000),
      // client mods from the camera's install (docker/camera/mods.json), comma-separated; 'none' runs the vanilla client
      mods: r.str('CAMERA_MODS', 'sodium'),
      // over the bot's shoulder (third, the default: its body, held tool and swing in view) or in its head (first)
      view: r.oneOf('CAMERA_VIEW', 'third', ['third', 'first']),
      chunkThreads: r.int('CAMERA_CHUNK_THREADS', 0, 0, 32),
      jvmArgs: r.str('CAMERA_JVM_ARGS', '').split(/\s+/).filter(Boolean),
      console: r.str('MC_CONSOLE', ''),
    },
  };
  hidden(stream, 'outputs', outputs);
  hidden(stream, 'serviceToken', serviceToken);
  if (stream.logo !== 'off' && !stream.logoFile) problems.push('STREAM_LOGO needs STREAM_LOGO_FILE, your own logo: a PNG under assets/ (for example brand/mine.png) or an absolute path');
  if (role === 'agent' && stream.serviceUrl && !serviceToken) problems.push('the camera service needs STREAM_SERVICE_TOKEN, the same in the agent and the camera (setup.sh writes it; make one with: openssl rand -hex 24)');
  if (stream.camera.msaClientId && !/^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i.test(stream.camera.msaClientId)) problems.push('CAMERA_MSA_CLIENT_ID must be your Azure app\'s client id (a GUID)');
  if (stream.camera.name && !/^[A-Za-z0-9_]{3,16}$/.test(stream.camera.name)) problems.push(`CAMERA_NAME must be 3-16 letters, digits or _ (got "${stream.camera.name}")`);
  if (stream.enabled && !stream.serviceUrl) {
    // the camera runs in this process (the camera container, or the agent with STREAM_SERVICE_URL=off)
    if (!stream.camera.console) problems.push('the camera needs MC_CONSOLE: it is put in spectator mode through the server console');
    if (!stream.camera.authDir) problems.push('the camera needs CAMERA_AUTH_DIR, the folder with the camera account\'s login (scripts/camera-login.mjs)');
  }
  if (stream.serviceUrl && !(/^http:/.test(stream.serviceUrl) && isLocalUrl(stream.serviceUrl))) problems.push('STREAM_SERVICE_URL must be an http URL on this machine (loopback)');

  // A live video on your own Facebook profile or Page (src/fb-live.js, LIVE_VIEW=facebook): read by the process that
  // runs the camera. A game goes live only when its live_view asks; the token is a file (600), never an environment
  // variable, and never logged.
  const fbTarget = r.oneOf('FB_TARGET', 'me', ['page', 'me']);
  const fb = {
    live: r.bool('FB_LIVE', liveView === 'facebook'),
    // 'me': the token owner's own profile with a long-lived user token (about 60 days), public so the embed plays,
    // each video deleted after its game; 'page': a Page's live videos with the Page token (the Page must be 60 days old)
    target: fbTarget,
    privacy: r.oneOf('FB_PRIVACY', 'EVERYONE', ['EVERYONE', 'ALL_FRIENDS', 'SELF']),
    deleteAfter: r.bool('FB_DELETE_AFTER', fbTarget === 'me'),
    deleteDelayS: r.int('FB_DELETE_DELAY_S', 600, 0, 86_400),
    // live videos started at most per hour and per 24 hours: Facebook may lock an account that starts many automated
    // public live videos in a short time (an identity check, "API access blocked")
    maxPerHour: r.int('FB_MAX_PER_HOUR', 4, 1, 60),
    maxPerDay: r.int('FB_MAX_PER_DAY', 12, 1, 500),
    pageId: r.str('FB_PAGE_ID', ''),
    tokenFile: r.str('FB_TOKEN_FILE', '') ? path.resolve(r.str('FB_TOKEN_FILE', '')) : '',
    graphVersion: r.str('FB_GRAPH_VERSION', 'v23.0'),
    graphUrl: r.str('FB_GRAPH_URL', 'https://graph.facebook.com').replace(/\/+$/, ''),
    stateFile: path.resolve(r.str('FB_STATE_FILE', path.join(log.dir, 'fb-live-state.json'))),
    title: r.str('FB_TITLE', `${web.name}: an AI agent plays Minecraft`),
    description: r.str('FB_DESCRIPTION', ''),
    // marks this install's live videos, so a crash sweep never ends or deletes another install's (setup.sh writes it)
    installId: r.str('INSTALL_ID', ''),
  };
  if (fb.pageId && !/^\d{5,25}$/.test(fb.pageId)) problems.push(`FB_PAGE_ID must be the Page's numeric id (got "${fb.pageId}")`);
  if (!/^v\d{1,2}\.\d$/.test(fb.graphVersion)) problems.push(`FB_GRAPH_VERSION must look like v23.0 (got "${fb.graphVersion}")`);
  try {
    const u = new URL(fb.graphUrl);
    if (!(u.protocol === 'https:' || (u.protocol === 'http:' && isLoopbackHost(u.hostname)))) problems.push('FB_GRAPH_URL must be https (http only on this machine, for tests)');
  } catch { problems.push(`FB_GRAPH_URL is not a URL (got "${fb.graphUrl}")`); }
  if (fb.title.length > 200 || /[\r\n]/.test(fb.title)) problems.push('FB_TITLE must be one line of at most 200 characters');
  if (fb.description.length > 600 || /[\r\n]/.test(fb.description)) problems.push('FB_DESCRIPTION must be one line of at most 600 characters');
  if (fb.installId && !/^[A-Za-z0-9_-]{4,64}$/.test(fb.installId)) problems.push('INSTALL_ID must be 4-64 letters, digits, _ or -');
  if (fb.live && !stream.serviceUrl) {
    if (!fb.pageId && fb.target === 'page') problems.push('LIVE_VIEW=facebook with FB_TARGET=page needs FB_PAGE_ID (scripts/fb-token.mjs prints it)');
    if (!fb.tokenFile) problems.push(`LIVE_VIEW=facebook needs FB_TOKEN_FILE, the file (600) with the ${fb.target === 'me' ? 'long-lived user' : 'Page'} token that scripts/fb-token.mjs writes`);
  }
  if (stream.enabled && !stream.serviceUrl && !outputs.length && !stream.outDir && !fb.live && !stream.hls) {
    problems.push('the camera has nowhere to send the picture: set LIVE_VIEW=local or facebook (or STREAM_RTMP_URL, STREAM_OUT_DIR)');
  }

  // the recordings of the games the camera films (the camera service; src/recorder.js): the clean game, the stream as it
  // went out, the HUD's timeline, per game under RECORD_DIR; old ones out by age and by the total size
  const record = {
    on: r.bool('RECORD', false),
    root: r.str('RECORD_DIR', '') ? path.resolve(r.str('RECORD_DIR', '')) : path.join(ROOT, 'recordings'),
    maxBytes: r.int('RECORD_MAX_GB', 150, 1, 10_000) * 2 ** 30,
    keepDays: r.int('RECORD_KEEP_DAYS', 30, 1, 3_650),
    crf: r.int('RECORD_CRF', 18, 10, 35),
    preset: r.oneOf('RECORD_PRESET', 'veryfast', ['ultrafast', 'superfast', 'veryfast', 'faster', 'fast', 'medium']),
    nice: r.int('RECORD_NICE', 10, 0, 19),
  };

  // every problem at once, the recording's too
  if (problems.length) throw new ConfigError(problems);
  return deepFreeze({ root: ROOT, mc, web, body, mineai, log, stream, fb, record });
}

/** The process-wide config, read from process.env at first import. */
export const config = loadConfig();
