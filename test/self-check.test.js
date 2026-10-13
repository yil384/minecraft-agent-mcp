// test/self-check.test.js - the check setup.sh runs after the first start (scripts/self-check.mjs), against the agent
// on its in-memory test world: a Minecraft server still making its world (a fresh machine's first start, 2026-10-13: the
// stack run's check gave up at the first SERVER_STARTING) is waited for, as long as start_game says, and the game
// then passes, within the check's time limit.
import { test, after } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { loadConfig } from '../src/config.js';
import { startAgent } from '../src/index.js';
import { runCheck } from '../scripts/self-check.mjs';

const keepAlive = setInterval(() => {}, 60_000);
after(() => clearInterval(keepAlive));

test('self-check: SERVER_STARTING is tried again after the time it names; the scripted game then passes', async () => {
  let asks = 0;
  const serverReady = async (w) => { asks += 1; return asks <= 2 ? { ok: false, waitedMs: w.waitMs, error: 'ECONNREFUSED' } : { ok: true, waitedMs: 0 }; };
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'self-check-'));
  const agent = await startAgent({ config: loadConfig({ WEB_HOST: '127.0.0.1', WEB_PORT: '0', LOG_DIR: dir }), fakeBot: true, serverReady, print: () => {}, loadViewer: () => null });
  const lines = [];
  const paused = [];
  try {
    const code = await runCheck({ base: agent.url, minutes: 5, print: (l) => lines.push(l), pause: async (ms) => { paused.push(ms); } });
    assert.equal(code, 0, lines.join('\n'));
    assert.deepEqual(paused, [15_000, 15_000], 'twice, as long as start_game said');
    assert.equal(lines.filter((l) => /start_game: SERVER_STARTING: .*; trying again in 15 s$/.test(l)).length, 2, lines.join('\n'));
    assert.ok(lines.some((l) => /PASS: wooden pickaxe/.test(l)), lines.join('\n'));
  } finally {
    await agent.stop();
  }
});

test('self-check: the waits are bounded: with less than two minutes left, SERVER_STARTING fails the check at once', async () => {
  const serverReady = async (w) => ({ ok: false, waitedMs: w.waitMs, error: 'ECONNREFUSED' });
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'self-check-'));
  const agent = await startAgent({ config: loadConfig({ WEB_HOST: '127.0.0.1', WEB_PORT: '0', LOG_DIR: dir }), fakeBot: true, serverReady, print: () => {}, loadViewer: () => null });
  const lines = [];
  const paused = [];
  try {
    const code = await runCheck({ base: agent.url, minutes: 1, print: (l) => lines.push(l), pause: async (ms) => { paused.push(ms); } });
    assert.equal(code, 1, lines.join('\n'));
    assert.deepEqual(paused, []);
    assert.match(lines.at(-1), /^self-check: FAIL: start_game: SERVER_STARTING/);
  } finally {
    await agent.stop();
  }
});
