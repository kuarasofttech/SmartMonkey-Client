/**
 * Embedded driver (stage 2b) — build the blueprint with the customer's API KEY,
 * no external CLI. A small, sandboxed agent loop: the model reads the repo
 * through read-only tools, interviews the owner through `ask_user`, and writes
 * ONLY smartmonkey/blueprint.json / cases.json. Nothing else on disk is touched,
 * and nothing leaves the machine but those files (which the owner reviews).
 *
 * The provider call is INJECTED (`callModel`) so the loop is testable with a
 * mock and provider-agnostic. Anthropic is wired here; OpenAI/Gemini slot in as
 * another `callModel`.
 */
import { readFileSync, writeFileSync, readdirSync, statSync, existsSync, mkdirSync } from 'node:fs';
import { spawnSync } from 'node:child_process';
import { resolve, join, relative, extname } from 'node:path';
import { createInterface } from 'node:readline';

export const SYSTEM = `You are SmartMonkey's blueprint builder, running as a LOCAL tool inside the user's repository on their own machine. Follow the instructions in the user's first message exactly. You have tools to read the repo, run read-only git, ask the user questions, and WRITE the outputs. Produce smartmonkey/blueprint.json (and cases.json if asked) by calling write_file — that is the only way to save your result; do not print the JSON. Never write anything except under smartmonkey/. The user's source must never appear in the output: no file paths, no pasted code — only the behaviour, described in words.`;

// Anthropic tool definitions (the shape the loop passes to callModel).
export const TOOLS = [
  { name: 'read_file', description: 'Read a UTF-8 text file in the repo.', input_schema: { type: 'object', properties: { path: { type: 'string' } }, required: ['path'] } },
  { name: 'list_dir', description: 'List entries of a directory in the repo (dirs end with /).', input_schema: { type: 'object', properties: { path: { type: 'string' } } } },
  { name: 'search', description: 'Search the repo for a substring/regex; returns matching path:line: text.', input_schema: { type: 'object', properties: { query: { type: 'string' }, path: { type: 'string' } }, required: ['query'] } },
  { name: 'git', description: 'Run a READ-ONLY git command (rev-parse, log, diff, ls-files, show, status, branch).', input_schema: { type: 'object', properties: { args: { type: 'array', items: { type: 'string' } } }, required: ['args'] } },
  { name: 'ask_user', description: 'Ask the project owner a question and get their answer. Provide options for a menu when the answer is a choice.', input_schema: { type: 'object', properties: { question: { type: 'string' }, options: { type: 'array', items: { type: 'string' } } }, required: ['question'] } },
  { name: 'request_connections', description: 'AFTER the interview, if the blueprint will draw on external tools (Jira, Figma, Confluence, TestRail, …), call this ONCE with those tool names. It pauses so the user can connect or skip each in the app, then returns — only then continue and build the blueprint. Do not call it if no external tools are involved.', input_schema: { type: 'object', properties: { services: { type: 'array', items: { type: 'string' } } }, required: ['services'] } },
  { name: 'write_file', description: 'Write an output file. Only paths under smartmonkey/ are allowed (blueprint.json, cases.json).', input_schema: { type: 'object', properties: { path: { type: 'string' }, contents: { type: 'string' } }, required: ['path', 'contents'] } },
];

const IGNORE = /(^|\/)(\.git|node_modules|build|dist|\.gradle|\.idea|DerivedData|Pods|\.next|out)(\/|$)/;
const GIT_OK = new Set(['rev-parse', 'log', 'diff', 'ls-files', 'ls-tree', 'show', 'status', 'branch', 'remote', 'config']);

/** Build the tool executor bound to a repo root. `ask` handles interview I/O. */
export function makeToolRunner(cwd, ask, requestConnections = async () => 'No connect step in this context; proceed to build the blueprint.') {
  const root = resolve(cwd);
  const inside = p => { const abs = resolve(root, p); if (abs !== root && !abs.startsWith(root + '/')) throw new Error('path escapes the repo'); return abs; };
  const walk = (dir, out, cap) => {
    if (out.length >= cap) return;
    let entries; try { entries = readdirSync(dir, { withFileTypes: true }); } catch { return; }
    for (const e of entries) {
      const abs = join(dir, e.name); const rel = relative(root, abs);
      if (IGNORE.test('/' + rel.replace(/\\/g, '/'))) continue;
      if (e.isDirectory()) walk(abs, out, cap);
      else if (out.length < cap) out.push(abs);
    }
  };
  return async (name, input = {}) => {
    if (name === 'read_file') {
      const abs = inside(input.path || '');
      const buf = readFileSync(abs);
      if (buf.length > 200_000) return buf.slice(0, 200_000).toString('utf8') + '\n…(truncated)';
      return buf.toString('utf8');
    }
    if (name === 'list_dir') {
      const abs = inside(input.path || '.');
      return readdirSync(abs, { withFileTypes: true })
        .filter(e => !IGNORE.test('/' + e.name)).map(e => e.name + (e.isDirectory() ? '/' : '')).join('\n');
    }
    if (name === 'search') {
      const files = []; walk(root, files, 4000);
      const q = input.query || ''; let re; try { re = new RegExp(q, 'i'); } catch { re = null; }
      const hits = [];
      for (const f of files) {
        if (input.path && !relative(root, f).includes(input.path)) continue;
        let text; try { text = readFileSync(f, 'utf8'); } catch { continue; }
        const lines = text.split('\n');
        for (let i = 0; i < lines.length && hits.length < 200; i++) {
          if (re ? re.test(lines[i]) : lines[i].toLowerCase().includes(q.toLowerCase())) hits.push(`${relative(root, f)}:${i + 1}: ${lines[i].trim().slice(0, 200)}`);
        }
        if (hits.length >= 200) break;
      }
      return hits.length ? hits.join('\n') : '(no matches)';
    }
    if (name === 'git') {
      const a = Array.isArray(input.args) ? input.args : [];
      if (!GIT_OK.has(a[0])) throw new Error(`git ${a[0] || ''} is not allowed (read-only subset only)`);
      const r = spawnSync('git', ['-C', root, ...a], { encoding: 'utf8' });
      if (r.status !== 0) throw new Error((r.stderr || 'git failed').split('\n')[0]);
      return r.stdout.slice(0, 50_000);
    }
    if (name === 'ask_user') return ask(input.question || '', input.options);
    if (name === 'request_connections') return requestConnections(input.services || []);
    if (name === 'write_file') {
      const rel = (input.path || '').replace(/\\/g, '/');
      if (!/^smartmonkey\/[\w.-]+\.json$/.test(rel)) throw new Error('only smartmonkey/*.json may be written');
      const abs = inside(rel); mkdirSync(join(root, 'smartmonkey'), { recursive: true });
      writeFileSync(abs, input.contents ?? ''); return `wrote ${rel} (${(input.contents ?? '').length} bytes)`;
    }
    throw new Error('unknown tool: ' + name);
  };
}

/** Terminal interview I/O for ask_user. */
export function makeAsk() {
  return (question, options) => new Promise(res => {
    const rl = createInterface({ input: process.stdin, output: process.stdout });
    const menu = Array.isArray(options) && options.length ? '\n' + options.map((o, i) => `  ${i + 1}) ${o}`).join('\n') + '\n' : '\n';
    rl.question(`\n${question}${menu}> `, ans => {
      rl.close(); const t = ans.trim();
      if (options && /^\d+$/.test(t) && +t >= 1 && +t <= options.length) return res(options[+t - 1]);
      res(t);
    });
  });
}

/** Anthropic Messages caller (normalized to {content, stop_reason}). */
export function makeAnthropicCaller(apiKey, model = 'claude-sonnet-5') {
  return async (messages, tools) => {
    const res = await fetch('https://api.anthropic.com/v1/messages', {
      method: 'POST',
      headers: { 'x-api-key': apiKey, 'anthropic-version': '2023-06-01', 'content-type': 'application/json' },
      body: JSON.stringify({ model, max_tokens: 8192, system: SYSTEM, messages, tools }),
    });
    if (!res.ok) throw new Error(`Anthropic ${res.status}: ${(await res.text()).slice(0, 400)}`);
    return res.json();   // Anthropic already returns {content:[blocks], stop_reason}
  };
}

// ── Other providers ──────────────────────────────────────────────────────────
// The loop speaks ONE dialect (Anthropic-shaped {content:[blocks], stop_reason}
// in, tool_result blocks back). Each other provider is a pair of PURE translators
// around a thin fetch — so the only risky part (the wire mapping) is unit-tested
// with fixtures, no live key needed.

/** Anthropic-shaped messages+tools → OpenAI Chat Completions request pieces. */
export function toOpenAI(system, messages, tools) {
  const out = [{ role: 'system', content: system }];
  for (const m of messages) {
    if (m.role === 'user') {
      if (typeof m.content === 'string') { out.push({ role: 'user', content: m.content }); continue; }
      const texts = [];
      for (const b of m.content || []) {
        if (b.type === 'tool_result') out.push({ role: 'tool', tool_call_id: b.tool_use_id, content: String(b.content) });
        else if (b.type === 'text') texts.push(b.text);
      }
      if (texts.length) out.push({ role: 'user', content: texts.join('\n') });
    } else if (m.role === 'assistant') {
      const content = Array.isArray(m.content) ? m.content : [{ type: 'text', text: String(m.content) }];
      const text = content.filter(b => b.type === 'text').map(b => b.text).join('');
      const toolCalls = content.filter(b => b.type === 'tool_use')
        .map(b => ({ id: b.id, type: 'function', function: { name: b.name, arguments: JSON.stringify(b.input || {}) } }));
      const msg = { role: 'assistant', content: text || (toolCalls.length ? null : '') };
      if (toolCalls.length) msg.tool_calls = toolCalls;
      out.push(msg);
    }
  }
  return { messages: out, tools: tools.map(t => ({ type: 'function', function: { name: t.name, description: t.description, parameters: t.input_schema || { type: 'object', properties: {} } } })) };
}

/** OpenAI Chat Completions response → Anthropic-shaped {content, stop_reason}. */
export function fromOpenAI(resp) {
  const msg = ((resp.choices || [])[0] || {}).message || {};
  const content = [];
  if (msg.content) content.push({ type: 'text', text: msg.content });
  for (const tc of msg.tool_calls || []) {
    let input = {}; try { input = JSON.parse(tc.function?.arguments || '{}'); } catch {}
    content.push({ type: 'tool_use', id: tc.id, name: tc.function?.name, input });
  }
  return { content, stop_reason: (msg.tool_calls && msg.tool_calls.length) ? 'tool_use' : 'end_turn' };
}

export function makeOpenAICaller(apiKey, model = 'gpt-5-mini') {
  return async (messages, tools) => {
    const req = toOpenAI(SYSTEM, messages, tools);
    const res = await fetch('https://api.openai.com/v1/chat/completions', {
      method: 'POST',
      headers: { authorization: `Bearer ${apiKey}`, 'content-type': 'application/json' },
      body: JSON.stringify({ model, max_completion_tokens: 8192, messages: req.messages, tools: req.tools, tool_choice: 'auto' }),
    });
    if (!res.ok) throw new Error(`OpenAI ${res.status}: ${(await res.text()).slice(0, 400)}`);
    return fromOpenAI(await res.json());
  };
}

// A synthetic id we mint for a Gemini functionCall that carried none (2.5). Kept
// out of the functionResponse we send back, so 2.5 matches by NAME while 3.x
// strict matching gets the real id we captured. Anything without this prefix is
// a real provider id and IS echoed.
const isGeminiId = id => typeof id === 'string' && !id.startsWith('sm_gem_');

/** Anthropic-shaped messages+tools → Gemini generateContent request. */
export function toGemini(system, messages, tools) {
  const nameById = new Map();
  for (const m of messages) if (m.role === 'assistant' && Array.isArray(m.content))
    for (const b of m.content) if (b.type === 'tool_use') nameById.set(b.id, b.name);
  const contents = [];
  for (const m of messages) {
    if (m.role === 'user') {
      if (typeof m.content === 'string') { contents.push({ role: 'user', parts: [{ text: m.content }] }); continue; }
      const parts = [];
      for (const b of m.content || []) {
        if (b.type === 'tool_result') {
          const fr = { name: nameById.get(b.tool_use_id) || 'tool', response: { result: String(b.content) } };
          if (isGeminiId(b.tool_use_id)) fr.id = b.tool_use_id;
          parts.push({ functionResponse: fr });
        } else if (b.type === 'text') parts.push({ text: b.text });
      }
      if (parts.length) contents.push({ role: 'user', parts });
    } else if (m.role === 'assistant') {
      const content = Array.isArray(m.content) ? m.content : [{ type: 'text', text: String(m.content) }];
      const parts = [];
      for (const b of content) {
        if (b.type === 'text' && b.text) parts.push({ text: b.text });
        else if (b.type === 'tool_use') { const fc = { name: b.name, args: b.input || {} }; if (isGeminiId(b.id)) fc.id = b.id; parts.push({ functionCall: fc }); }
      }
      if (parts.length) contents.push({ role: 'model', parts });
    }
  }
  return {
    system_instruction: { parts: [{ text: system }] },
    contents,
    tools: [{ functionDeclarations: tools.map(t => ({ name: t.name, description: t.description, parameters: t.input_schema || { type: 'object', properties: {} } })) }],
  };
}

/** Gemini generateContent response → Anthropic-shaped {content, stop_reason}. */
export function fromGemini(resp) {
  const parts = ((resp.candidates || [])[0] || {}).content?.parts || [];
  const content = []; let n = 0;
  for (const p of parts) {
    if (p.text) content.push({ type: 'text', text: p.text });
    else if (p.functionCall) content.push({ type: 'tool_use', id: p.functionCall.id || `sm_gem_${n++}`, name: p.functionCall.name, input: p.functionCall.args || {} });
  }
  return { content, stop_reason: content.some(b => b.type === 'tool_use') ? 'tool_use' : 'end_turn' };
}

export function makeGeminiCaller(apiKey, model = 'gemini-flash-latest') {
  return async (messages, tools) => {
    const body = toGemini(SYSTEM, messages, tools);
    const res = await fetch(`https://generativelanguage.googleapis.com/v1beta/models/${encodeURIComponent(model)}:generateContent`, {
      method: 'POST',
      headers: { 'x-goog-api-key': apiKey, 'content-type': 'application/json' },
      body: JSON.stringify({ ...body, generationConfig: { maxOutputTokens: 8192 } }),
    });
    if (!res.ok) throw new Error(`Gemini ${res.status}: ${(await res.text()).slice(0, 400)}`);
    return fromGemini(await res.json());
  };
}

// ── Provider registry + resolution ───────────────────────────────────────────
export const PROVIDERS = {
  anthropic: { label: 'Anthropic', defaultModel: 'claude-sonnet-5',    make: makeAnthropicCaller, envKeys: ['ANTHROPIC_API_KEY'],               keyLooksLike: k => k.startsWith('sk-ant') },
  openai:    { label: 'OpenAI',    defaultModel: 'gpt-5-mini',         make: makeOpenAICaller,    envKeys: ['OPENAI_API_KEY'],                  keyLooksLike: k => k.startsWith('sk-') && !k.startsWith('sk-ant') },
  gemini:    { label: 'Gemini',    defaultModel: 'gemini-flash-latest', make: makeGeminiCaller,   envKeys: ['GEMINI_API_KEY', 'GOOGLE_API_KEY'], keyLooksLike: k => k.startsWith('AIza') },
};
const firstEnv = (p, env) => { for (const k of p.envKeys) if (env[k]) return env[k]; return undefined; };

/**
 * Decide provider + key + default model. Explicit --provider wins (with --key or
 * a matching env key); else infer the provider from a --key's shape; else the
 * first env key found, in provider order. Returns {error} when nothing resolves.
 */
export function resolveProvider({ provider, key, env = process.env } = {}) {
  if (provider) {
    const p = PROVIDERS[provider];
    if (!p) return { error: `unknown provider "${provider}" (use anthropic | openai | gemini)` };
    const useKey = key || firstEnv(p, env);
    if (!useKey) return { error: `no ${provider} key — pass --key or set ${p.envKeys.join(' / ')}` };
    return { provider, key: useKey, model: p.defaultModel };
  }
  if (key) {
    const id = Object.keys(PROVIDERS).find(id => PROVIDERS[id].keyLooksLike(key)) || 'anthropic';
    return { provider: id, key, model: PROVIDERS[id].defaultModel };
  }
  for (const id of Object.keys(PROVIDERS)) { const k = firstEnv(PROVIDERS[id], env); if (k) return { provider: id, key: k, model: PROVIDERS[id].defaultModel }; }
  return { error: 'no API key found (pass --key, or set ANTHROPIC_API_KEY / OPENAI_API_KEY / GEMINI_API_KEY)' };
}

/**
 * The agent loop. `callModel(messages, tools)` returns {content:[blocks], stop_reason};
 * `runTool(name, input)` returns a string. Ends when the model stops calling tools.
 */
export async function runAgent({ prompt, callModel, runTool, onText = () => {}, maxTurns = 80 }) {
  const messages = [{ role: 'user', content: prompt }];
  for (let turn = 0; turn < maxTurns; turn++) {
    const resp = await callModel(messages, TOOLS);
    const content = resp.content || [];
    messages.push({ role: 'assistant', content });
    for (const b of content) if (b.type === 'text' && b.text) onText(b.text);
    const toolUses = content.filter(b => b.type === 'tool_use');
    if (!toolUses.length) return { done: true, turns: turn + 1 };
    const results = [];
    for (const tu of toolUses) {
      let out;
      try { out = await runTool(tu.name, tu.input || {}); }
      catch (e) { out = 'ERROR: ' + e.message; }
      results.push({ type: 'tool_result', tool_use_id: tu.id, content: String(out).slice(0, 60_000) });
    }
    messages.push({ role: 'user', content: results });
  }
  return { done: false, turns: maxTurns, reason: 'hit max turns' };
}

/** Convenience: does blueprint.json exist under cwd/smartmonkey? */
export function producedBlueprint(cwd) { return existsSync(join(resolve(cwd), 'smartmonkey', 'blueprint.json')); }
export { statSync, extname };
