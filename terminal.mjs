/**
 * Pop a NEW terminal window to host an interactive logged-in-CLI interview, so a
 * QA person who launched `smartmonkey app` by double-click (no controlling
 * terminal) still gets a real TTY for the driver's questions. Zero dependencies —
 * it shells the OS's own terminal via child_process, exactly like openBrowser.
 *
 * The app can't observe a detached window's exit, so the wrapper script writes the
 * driver's exit code to a sentinel file; we poll for it, then report done/error.
 * When the platform's terminal can't be launched (unknown emulator, Windows), the
 * pop throws UNSUPPORTED and the caller falls back to inline stdio.
 */
import { spawn as _spawn } from 'node:child_process';
import { mkdtempSync, writeFileSync, chmodSync, existsSync, readFileSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join, delimiter } from 'node:path';

const shq = s => `'${String(s).replace(/'/g, `'\\''`)}'`;   // POSIX single-quote

// The argv that opens a new terminal window running `scriptPath`. null ⇒ we don't
// know how on this platform (caller falls back). `has(bin)` reports PATH presence.
export function terminalCommand(platform, scriptPath, has = () => false) {
  if (platform === 'darwin') return { cmd: 'open', args: ['-a', 'Terminal', scriptPath] };
  if (platform === 'linux') {
    const t = ['x-terminal-emulator', 'gnome-terminal', 'konsole', 'xfce4-terminal', 'xterm'].find(has);
    if (!t) return null;
    return { cmd: t, args: t === 'gnome-terminal' ? ['--', scriptPath] : ['-e', scriptPath] };
  }
  return null;   // win32 and anything else → inline-stdio fallback
}

// The bash wrapper the terminal runs: cd, run the driver with the prompt read from
// a file (no giant argv/escaping), record the exit code, and leave a friendly line.
export function runScript({ cwd, bin, promptPath, donePath }) {
  return [
    '#!/bin/bash',
    `cd ${shq(cwd)}`,
    `${shq(bin)} "$(cat ${shq(promptPath)})"`,
    'code=$?',
    `printf '%s' "$code" > ${shq(donePath)}`,
    'echo',
    'echo "[SmartMonkey] Interview finished (exit $code). You can close this window."',
    '',
  ].join('\n');
}

export function onPath(bin, env = process.env) {
  for (const dir of (env.PATH || '').split(delimiter)) if (dir && existsSync(join(dir, bin))) return true;
  return false;
}

/**
 * A runCli that pops a terminal. All effects are injected for tests. Returns
 * { launched, cancel } on success; throws an error with code 'UNSUPPORTED' when it
 * cannot launch a terminal, so the caller can fall back to inline stdio.
 */
export function makePopTerminalRunCli({
  platform = process.platform,
  has = onPath,
  spawn = _spawn,
  mkdtemp = () => mkdtempSync(join(tmpdir(), 'sm-cli-')),
  writeFile = writeFileSync,
  chmod = chmodSync,
  fileExists = existsSync,
  readFile = p => readFileSync(p, 'utf8'),
  cleanup = p => { try { rmSync(p, { recursive: true, force: true }); } catch {} },
  pollMs = 1000,
  setTimer = (fn, ms) => setInterval(fn, ms),
  clearTimer = clearInterval,
} = {}) {
  return ({ driver, prompt, cwd, onDone, onError }) => {
    const dir = mkdtemp();
    const promptPath = join(dir, 'prompt.txt');
    const donePath = join(dir, 'done');
    const scriptPath = join(dir, 'run.sh');
    writeFile(promptPath, prompt);
    writeFile(scriptPath, runScript({ cwd, bin: driver.bin, promptPath, donePath }));
    chmod(scriptPath, 0o755);

    const cmd = terminalCommand(platform, scriptPath, has);
    const unsupported = msg => { cleanup(dir); const e = new Error(msg); e.code = 'UNSUPPORTED'; return e; };
    if (!cmd) throw unsupported('no terminal launcher for this platform');

    let child;
    try { child = spawn(cmd.cmd, cmd.args, { stdio: 'ignore', detached: true }); child.unref?.(); }
    catch (err) { throw unsupported(`could not open a terminal: ${err.message}`); }
    child.on?.('error', () => {});   // a launcher error after spawn is non-fatal; the poll/user handles it

    let finished = false;
    const timer = setTimer(() => {
      if (finished || !fileExists(donePath)) return;
      let code = 0; try { code = parseInt(readFile(donePath), 10) || 0; } catch {}
      finished = true; clearTimer(timer); cleanup(dir);
      code === 0 ? onDone() : onError(new Error(`the CLI exited with code ${code}`));
    }, pollMs);

    return { launched: true, cancel: () => { if (finished) return; finished = true; clearTimer(timer); cleanup(dir); } };
  };
}
