// src/log.js - the game log: one JSONL row per event (a game's start and end, every MCP call with a short summary of
// its arguments and outcome, milestones, the camera's state). Secrets are scrubbed before anything is written, kept in
// memory or handed to a subscriber, so the operator's /log can serve rows as they are.

import fs from 'node:fs';
import path from 'node:path';
import crypto from 'node:crypto';
import { config as defaultConfig } from './config.js';

const KEY_PATTERNS = [
  /\bsk-[A-Za-z0-9_-]{16,}/g, // API-key-shaped strings
  /Bearer\s+[A-Za-z0-9._\-|~+/=]+/gi,
];

/** Replace the configured secrets and anything shaped like an API key with [redacted]. */
export function scrub(text, secrets = []) {
  let s = String(text);
  for (const secret of secrets) if (secret && secret.length >= 8) s = s.split(secret).join('[redacted]');
  for (const re of KEY_PATTERNS) s = s.replace(re, '[redacted]');
  return s;
}

/**
 * @param {object} [opts]
 * @param {string|null} [opts.dir]    folder for run-<id>.jsonl; null keeps rows in memory only
 * @param {string} [opts.runId]
 * @param {number} [opts.keep]        rows kept in memory for tail()
 * @param {object} [opts.config]
 * @returns {import('./contracts.js').Logger}
 */
export function createLogger(opts = {}) {
  const cfg = opts.config ?? defaultConfig;
  const dir = opts.dir === undefined ? cfg.log.dir : opts.dir;
  const runId = opts.runId ?? `${new Date().toISOString().replace(/[:.]/g, '-')}-${crypto.randomBytes(2).toString('hex')}`;
  const keep = opts.keep ?? 200;
  // stream URLs hold stream keys: the whole URL and the key alone are both secrets
  const streamKeys = (cfg.stream?.outputs ?? []).flatMap((u) => [u, u.split('/').pop()?.split('?')[0]]);
  const secrets = [cfg.web?.adminToken, cfg.web?.accessKey, cfg.web?.watchKey, cfg.web?.proxySecret, cfg.stream?.serviceToken, ...streamKeys];
  const file = dir ? path.join(dir, `run-${runId.replace(/[^A-Za-z0-9_.-]/g, '_')}.jsonl`) : null;
  if (file) fs.mkdirSync(dir, { recursive: true });

  const started = Date.now();
  const rows = [];
  const subs = new Set();
  let closed = false;

  function write(row) {
    const line = scrub(JSON.stringify(row), secrets);
    const clean = JSON.parse(line);
    if (file && !closed) fs.appendFileSync(file, `${line}\n`);
    rows.push(clean);
    if (rows.length > keep) rows.shift();
    for (const fn of subs) { try { fn(clean); } catch { /* a subscriber must not break logging */ } }
    return clean;
  }

  const base = (type) => ({ type, time: new Date().toISOString(), elapsedMs: Date.now() - started, run: runId });

  return {
    runId,
    path: file,
    event(kind, data = {}) {
      return write({ ...data, ...base('event'), kind: String(kind) });
    },
    tail: (n = 20) => rows.slice(-n),
    subscribe(fn) { subs.add(fn); return () => subs.delete(fn); },
    close() { closed = true; subs.clear(); },
  };
}

/** Read a JSONL log back into rows (skips blank or broken lines). */
export function readJsonl(file) {
  return fs.readFileSync(file, 'utf8').split('\n').filter(Boolean).flatMap((line) => {
    try { return [JSON.parse(line)]; } catch { return []; }
  });
}
