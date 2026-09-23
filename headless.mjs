/**
 * Run a logged-in CLI HEADLESS, with its progress streamed into the app. Once the
 * interview moved into the browser, the CLI no longer needs a terminal at all —
 * and an interactive `claude "<prompt>"` never exits on its own, so the app could
 * not tell when it had finished. Print mode (`-p`) runs to completion and exits.
 *
 * Permissions are confined, not bypassed: `dontAsk` refuses anything not listed,
 * and the list is read-only tools, read-only git, and edits under smartmonkey/
 * only (verified: a write to ./hack.txt is refused). The prompt goes over stdin —
 * `--allowedTools` is variadic and would swallow a positional prompt, and stdin
 * has no command-line length limit. Zero dependencies.
 */
import { spawn as _spawn } from 'node:child_process';
import { relative, isAbsolute } from 'node:path';
import { fileURLToPath } from 'node:url';
import { allTools } from './connectors/index.mjs';

const ASK_MCP = fileURLToPath(new URL('./ask-mcp.mjs', import.meta.url));
const ASK_TIMEOUT_MS = String(24 * 3600 * 1000);   // the owner may step away; Stop is how a run ends early

const READ_ONLY_GIT = ['rev-parse', 'log', 'ls-files', 'status', 'show', 'diff', 'branch'].map(c => `Bash(git ${c}:*)`);
export const CLAUDE_TOOLS = ['Read', 'Glob', 'Grep', 'Edit(smartmonkey/**)', ...READ_ONLY_GIT];

/**
 * The headless command for a driver, or null when we have no verified recipe for it.
 * `askBridge` ({url, token}) adds our ask_user MCP tool so the build can ask
 * project-specific questions in the app; --strict-mcp-config keeps the user's own
 * MCP servers out of the build.
 */
export function headlessCommand(driver, askBridge) {
  if (driver.id !== 'claude') return null;   // codex / cursor / gemini: not verified here → the terminal fallback
  const args = ['-p', '--output-format', 'stream-json', '--verbose', '--permission-mode', 'dontAsk'];
  const tools = [...CLAUDE_TOOLS];
  const env = {};
  if (askBridge) {
    const cfg = { mcpServers: { smartmonkey: { command: process.execPath, args: [ASK_MCP], env: { SMARTMONKEY_ASK_URL: askBridge.url, SMARTMONKEY_ASK_TOKEN: askBridge.token } } } };
    args.push('--mcp-config', JSON.stringify(cfg), '--strict-mcp-config');
    tools.push('mcp__smartmonkey__ask_user', 'mcp__smartmonkey__request_connections', ...allTools().map(t => `mcp__smartmonkey__${t.name}`));
    env.MCP_TOOL_TIMEOUT = ASK_TIMEOUT_MS;
  }
  args.push('--allowedTools', ...tools);   // variadic — must stay last
  return { args, env };
}

const rel = (p, cwd) => (typeof p === 'string' && isAbsolute(p) ? (relative(cwd, p) || '.') : p);
const summarize = (input = {}, cwd) => rel(input.file_path || input.path || '', cwd) || input.pattern || input.command || '';

/** One line of claude's stream-json → app events ({ type: 'text'|'tool'|'result', data }). */
export function parseClaudeLine(line, cwd) {
  let j; try { j = JSON.parse(line); } catch { return []; }
  if (j.type === 'assistant') {
    const out = [];
    for (const b of (j.message && j.message.content) || []) {
      if (b.type === 'text' && b.text && b.text.trim()) out.push({ type: 'text', data: b.text });
      else if (b.type === 'tool_use' && b.name === 'mcp__smartmonkey__ask_user') out.push({ type: 'tool', data: { name: 'asking you', summary: (b.input && b.input.question) || '' } });
      else if (b.type === 'tool_use' && b.name === 'mcp__smartmonkey__request_connections') out.push({ type: 'tool', data: { name: 'connect', summary: ((b.input && b.input.services) || []).join(', ') } });
      else if (b.type === 'tool_use' && /^mcp__smartmonkey__linear_/.test(b.name)) out.push({ type: 'tool', data: { name: 'Linear', summary: `${b.name.replace('mcp__smartmonkey__linear_', '').replace(/_/g, ' ')} ${(b.input && (b.input.query || b.input.id)) || ''}`.trim() } });
      else if (b.type === 'tool_use') out.push({ type: 'tool', data: { name: b.name, summary: summarize(b.input, cwd) } });
    }
    return out;
  }
  if (j.type === 'result') return [{ type: 'result', data: { ok: !j.is_error && j.subtype === 'success', message: j.is_error ? (j.result || j.subtype) : (j.result || '') } }];
  if (j.type === 'system' && j.subtype === 'permission_denied') return [{ type: 'tool', data: { name: j.tool_name, summary: '(not allowed)' } }];
  return [];
}

/**
 * A runCli that runs the driver headless. `onEvent(type, data)` receives text/tool
 * progress. Returns { launched, headless, cancel }; throws code 'UNSUPPORTED' for a
 * driver without a recipe, before starting anything.
 */
export function makeHeadlessRunCli({ spawn = _spawn } = {}) {
  return ({ driver, prompt, cwd, askBridge, onEvent = () => {}, onDone, onError }) => {
    const cmd = headlessCommand(driver, askBridge);
    if (!cmd) { const e = new Error(`no headless mode for ${driver.id}`); e.code = 'UNSUPPORTED'; throw e; }

    const child = spawn(driver.bin, cmd.args, { cwd, stdio: ['pipe', 'pipe', 'pipe'], env: { ...process.env, ...cmd.env } });
    let buf = '', stderr = '', result = null, settled = false;
    const settle = (fn, arg) => { if (settled) return; settled = true; fn(arg); };

    child.stdout.on('data', chunk => {
      buf += chunk.toString('utf8');
      let i;
      while ((i = buf.indexOf('\n')) >= 0) {
        const l = buf.slice(0, i); buf = buf.slice(i + 1);
        for (const ev of parseClaudeLine(l, cwd)) {
          if (ev.type === 'result') result = ev.data;
          else if (!settled) onEvent(ev.type, ev.data);
        }
      }
    });
    child.stderr.on('data', chunk => { stderr = (stderr + chunk.toString('utf8')).slice(-4000); });
    child.on('error', e => settle(onError, e));
    child.on('close', code => {
      if (code === 0 && (!result || result.ok)) return settle(onDone);
      const lastErr = stderr.trim().split('\n').filter(Boolean).pop();
      const why = (result && !result.ok && result.message) || lastErr || `${driver.bin} exited with code ${code}`;
      settle(onError, new Error(why));
    });
    child.stdin.end(prompt);

    return { launched: true, headless: true, cancel: () => { if (settled) return; settled = true; try { child.kill(); } catch {} } };
  };
}
