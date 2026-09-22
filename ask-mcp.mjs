#!/usr/bin/env node
/**
 * A tiny MCP server (stdio, zero dependencies) that gives a headless CLI agent an
 * `ask_user` tool whose questions appear IN THE APP'S BROWSER PAGE. Claude Code is
 * started with `--mcp-config` pointing here; when it calls ask_user, we POST the
 * question to the running `smartmonkey app` and hold the call open until the user
 * answers there (or stops the run). That's what lets a background build still ask
 * project-specific questions — clickable ones — instead of guessing.
 *
 * Wire format: newline-delimited JSON-RPC 2.0 over stdin/stdout (MCP stdio).
 * Config via env: SMARTMONKEY_ASK_URL (the app's /api/agent-ask), SMARTMONKEY_ASK_TOKEN.
 */
import { createInterface } from 'node:readline';
import { fileURLToPath } from 'node:url';
import { resolve } from 'node:path';

export const ASK_TOOL = {
  name: 'ask_user',
  description: 'Ask the project owner a question in the SmartMonkey app and wait for the answer. The owner answers by CLICKING, so always give 2–6 short `options` — drawn from what you found in the repo when the question is about this project (set `multi: true` if several can apply). They can still type their own if none fits. One question per call.',
  inputSchema: {
    type: 'object',
    properties: {
      question: { type: 'string', description: 'The question, in plain words.' },
      options: { type: 'array', items: { type: 'string' }, minItems: 2, maxItems: 8, description: '2–6 short choices the owner can click.' },
      multi: { type: 'boolean', description: 'True when several options can apply at once.' },
    },
    required: ['question', 'options'],
  },
};

export const CONNECT_TOOL = {
  name: 'request_connections',
  description: 'When the owner\'s answers mean the blueprint draws on external tools (Jira / Xray, TestRail, Zephyr, qTest, Confluence, Notion, Figma…), call this ONCE with those tool names. The app lets the owner connect or skip each, then returns which were connected. Call it before you try to use them.',
  inputSchema: { type: 'object', properties: { services: { type: 'array', items: { type: 'string' }, minItems: 1 } }, required: ['services'] },
};

/** Handle one JSON-RPC message; returns the response object, or null for notifications. `ask` does the real work. */
export async function handleMessage(msg, ask) {
  const reply = result => ({ jsonrpc: '2.0', id: msg.id, result });
  const error = (code, message) => ({ jsonrpc: '2.0', id: msg.id, error: { code, message } });
  if (msg.id === undefined || msg.id === null) return null;   // notification (e.g. notifications/initialized)
  switch (msg.method) {
    case 'initialize':
      return reply({ protocolVersion: msg.params?.protocolVersion || '2025-06-18', capabilities: { tools: {} }, serverInfo: { name: 'smartmonkey', version: '1' } });
    case 'ping':
      return reply({});
    case 'tools/list':
      return reply({ tools: [ASK_TOOL, CONNECT_TOOL] });
    case 'tools/call': {
      const name = msg.params?.name, a = msg.params?.arguments || {};
      const soft = text => reply({ content: [{ type: 'text', text }], isError: true });
      if (name === CONNECT_TOOL.name) {
        const services = Array.isArray(a.services) ? a.services.map(String).filter(Boolean) : [];
        if (!services.length) return soft('Give the tool names in `services`.');
        try { return reply({ content: [{ type: 'text', text: await ask({ kind: 'connections', services }) }] }); }
        catch (e) { return soft(`Could not reach the app (${e.message}). Treat the tools as not connected and continue.`); }
      }
      if (name !== ASK_TOOL.name) return error(-32602, `unknown tool ${name}`);
      const options = Array.isArray(a.options) ? a.options.map(String).filter(Boolean) : [];
      if (options.length < 2) return soft('The owner answers by clicking — call ask_user again with 2–6 short `options` (drawn from what you found in the repo).');
      try {
        const answer = await ask({ kind: 'ask', question: String(a.question || ''), options, multi: !!a.multi });
        return reply({ content: [{ type: 'text', text: answer || '(no answer — the owner skipped this; use the default or record it in openQuestions)' }] });
      } catch (e) {
        return reply({ content: [{ type: 'text', text: `Could not reach the owner (${e.message}). Do not wait; record this in openQuestions and continue.` }], isError: true });
      }
    }
    default:
      return error(-32601, `method not found: ${msg.method}`);
  }
}

/**
 * POST the question, then LONG-POLL for the answer. One request can't simply stay
 * open while the owner thinks: Node's fetch gives up waiting for headers after 5
 * minutes. So the app returns an id at once, and each poll waits up to ~25s.
 */
export function httpAsk(url, token, { fetchImpl = fetch, sleep = ms => new Promise(r => setTimeout(r, ms)) } = {}) {
  const headers = { 'content-type': 'application/json', 'x-smartmonkey-token': token || '' };
  const call = async (method, u, body) => {
    const res = await fetchImpl(u, { method, headers, body: body ? JSON.stringify(body) : undefined });
    const j = await res.json().catch(() => ({}));
    if (!res.ok) throw new Error(j.error || `HTTP ${res.status}`);
    return j;
  };
  return async payload => {
    const { id } = await call('POST', url, payload);
    for (let failures = 0; ;) {
      try {
        const j = await call('GET', `${url}/${encodeURIComponent(id)}`);
        if (!j.pending) return String(j.answer ?? '');
        failures = 0;
      } catch (e) {
        if (++failures >= 5) throw e;   // the app is gone; don't hang the build forever
        await sleep(1000);
      }
    }
  };
}

// Run as a process: stdio JSON-RPC loop. Calls run concurrently; each response is one line.
// Exact-path match: a looser "ends with ask-mcp.mjs" check also fired when test/ask-mcp.mjs imported this.
if (process.argv[1] && resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  const ask = httpAsk(process.env.SMARTMONKEY_ASK_URL, process.env.SMARTMONKEY_ASK_TOKEN);
  const rl = createInterface({ input: process.stdin });
  rl.on('line', line => {
    let msg; try { msg = JSON.parse(line); } catch { return; }
    handleMessage(msg, ask).then(r => { if (r) process.stdout.write(JSON.stringify(r) + '\n'); });
  });
}
