#!/usr/bin/env node
// scripts/stdio-bridge.mjs - this server for MCP clients that only start local (stdio) servers, such as a desktop app's
// config file: it reads JSON-RPC messages on stdin and sends them to the server's MCP URL (streamable HTTP), and writes
// the server's answers to stdout. Nothing is changed on the way; the MCP URL (with its key) comes from the command line
// or MCP_URL, and nothing but errors goes to stderr.
//
//   node scripts/stdio-bridge.mjs http://127.0.0.1:8787/mcp/<MCP_ACCESS_KEY>
//
// For example, in a desktop client's config:
//   { "mcpServers": { "minecraft": { "command": "node", "args": ["/path/to/minecraft-agent-mcp/scripts/stdio-bridge.mjs", "http://127.0.0.1:8787/mcp/<key>"] } } }

import path from 'node:path';
import { pathToFileURL } from 'node:url';
import { StdioServerTransport } from '@modelcontextprotocol/sdk/server/stdio.js';
import { StreamableHTTPClientTransport } from '@modelcontextprotocol/sdk/client/streamableHttp.js';

/** Pump messages both ways between a local transport and a remote one until either closes. Returns stop(). */
export async function bridge(local, remote, { onError = () => {} } = {}) {
  let closed = false;
  const stop = async () => {
    if (closed) return;
    closed = true;
    await Promise.allSettled([remote.close(), local.close()]);
  };
  local.onmessage = (m) => { remote.send(m).catch((err) => onError(err)); };
  remote.onmessage = (m) => { local.send(m).catch((err) => onError(err)); };
  local.onclose = () => { stop(); };
  remote.onclose = () => { stop(); };
  local.onerror = onError;
  remote.onerror = onError;
  await remote.start();
  await local.start();
  return stop;
}

export async function main(argv = process.argv.slice(2), { env = process.env, printErr = (l) => process.stderr.write(`${l}\n`) } = {}) {
  const target = argv[0] ?? env.MCP_URL;
  let url;
  try { url = new URL(target); } catch { printErr('usage: node scripts/stdio-bridge.mjs <MCP URL, e.g. http://127.0.0.1:8787/mcp/KEY>'); return 2; }
  if (!/^https?:$/.test(url.protocol)) { printErr('the MCP URL must be http(s)'); return 2; }
  const stop = await bridge(new StdioServerTransport(), new StreamableHTTPClientTransport(url), {
    onError: (err) => {
      const text = String(err?.message ?? err);
      if (err?.name === 'AbortError' || /aborted/i.test(text)) return; // the stream closing at the end
      printErr(`stdio-bridge: ${text.replace(/\/mcp\/[A-Za-z0-9_-]+/g, '/mcp/***')}`);
    },
  });
  await new Promise((resolve) => {
    process.stdin.once('end', resolve);
    process.once('SIGINT', resolve);
    process.once('SIGTERM', resolve);
  });
  await stop();
  return 0;
}

const isMain = process.argv[1] && import.meta.url === pathToFileURL(path.resolve(process.argv[1])).href;
if (isMain) process.exitCode = await main();
