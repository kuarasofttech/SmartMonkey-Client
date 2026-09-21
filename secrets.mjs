/**
 * Secret storage for the persistent app: the OS keychain when available
 * (macOS `security`, Linux `secret-tool`), else an in-memory fallback for this
 * process. NEVER writes a plaintext file. Service name: "smartmonkey".
 * `exec` is injectable so this is testable without touching the real keychain.
 */
import { spawnSync } from 'node:child_process';

const SERVICE = 'smartmonkey';

export function defaultExec(cmd, args, { input } = {}) {
  const r = spawnSync(cmd, args, { input, encoding: 'utf8' });
  return { status: r.status, stdout: r.stdout || '', stderr: r.stderr || '' };
}

export function makeSecrets({ exec = defaultExec, platform = process.platform } = {}) {
  const probe = platform === 'darwin' ? () => exec('security', ['help']).status === 0
    : platform === 'linux' ? () => exec('secret-tool', ['--version']).status === 0
    : () => false;
  const mode = probe() ? platform : 'memory';
  const mem = new Map();

  if (mode === 'darwin') {
    return {
      available: () => true,
      get(name) { const r = exec('security', ['find-generic-password', '-s', SERVICE, '-a', name, '-w']); return r.status === 0 ? r.stdout.replace(/\n$/, '') : null; },
      set(name, value) { return exec('security', ['add-generic-password', '-U', '-s', SERVICE, '-a', name, '-w', value]).status === 0; },
      delete(name) { return exec('security', ['delete-generic-password', '-s', SERVICE, '-a', name]).status === 0; },
    };
  }
  if (mode === 'linux') {
    return {
      available: () => true,
      get(name) { const r = exec('secret-tool', ['lookup', 'service', SERVICE, 'account', name]); return r.status === 0 && r.stdout ? r.stdout.replace(/\n$/, '') : null; },
      set(name, value) { return exec('secret-tool', ['store', '--label=smartmonkey', 'service', SERVICE, 'account', name], { input: value }).status === 0; },
      delete(name) { return exec('secret-tool', ['clear', 'service', SERVICE, 'account', name]).status === 0; },
    };
  }
  return {
    available: () => false,
    get(name) { return mem.has(name) ? mem.get(name) : null; },
    set(name, value) { mem.set(name, value); return true; },
    delete(name) { mem.delete(name); return true; },
  };
}
