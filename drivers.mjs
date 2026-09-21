/**
 * The AI-driver CLIs the tool can orchestrate, + PATH detection. Shared by the
 * `run` command (cli.mjs) and the persistent app server (server.mjs) so both
 * agree on what's available.
 */
import { existsSync } from 'node:fs';
import { join, delimiter } from 'node:path';

export const DRIVERS = [
  { id: 'claude', bin: 'claude', label: 'Claude Code' },
  { id: 'codex', bin: 'codex', label: 'OpenAI Codex CLI' },
  { id: 'cursor', bin: 'cursor-agent', label: 'Cursor Agent' },
  { id: 'gemini', bin: 'gemini', label: 'Gemini CLI' },
];

export function onPath(bin) {
  const exts = process.platform === 'win32' ? ['.cmd', '.exe', '.bat', ''] : [''];
  for (const dir of (process.env.PATH || '').split(delimiter)) {
    if (!dir) continue;
    for (const ext of exts) { try { if (existsSync(join(dir, bin + ext))) return true; } catch {} }
  }
  return false;
}

export const detectDrivers = () => DRIVERS.filter(d => onPath(d.bin));
