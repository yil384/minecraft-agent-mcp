// test/patches.test.js - the Mine AI patches as shipped: mineai/UPSTREAM.json applies every patch in mineai/patches, in
// order, and nothing else; each patch names the upstream and its MIT licence; mineai/README.md lists each one
import { test } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const MINEAI = path.join(path.dirname(fileURLToPath(import.meta.url)), '..', 'mineai');

test('mineai patches: UPSTREAM.json lists every patch in order; each names the upstream and its MIT licence; the README lists each', () => {
  const up = JSON.parse(fs.readFileSync(path.join(MINEAI, 'UPSTREAM.json'), 'utf8'));
  const files = fs.readdirSync(path.join(MINEAI, 'patches')).filter((f) => f.endsWith('.patch')).sort();
  assert.deepEqual(up.patches, files.map((f) => `patches/${f}`), 'every patch, in the order of its number');
  files.forEach((f, i) => assert.equal(f.slice(0, 4), String(i + 1).padStart(4, '0'), `${f}: numbered without a gap`));
  const readme = fs.readFileSync(path.join(MINEAI, 'README.md'), 'utf8');
  for (const f of files) {
    // the header git apply skips: which upstream it changes, under which licence
    const head = fs.readFileSync(path.join(MINEAI, 'patches', f), 'utf8').split('\ndiff --git ')[0];
    assert.match(head, /https:\/\/github\.com\/aibengineering\/mine-ai-mcp/, `${f}: names the upstream`);
    assert.match(head, /\bMIT\b/, `${f}: says its licence`);
    assert.ok(readme.includes(`\`${f.replace(/\.patch$/, '')}\``), `${f}: listed in mineai/README.md`);
  }
});
