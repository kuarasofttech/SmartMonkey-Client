/**
 * secrets.mjs — keychain backend (mock exec) + in-memory fallback.
 *   node test/secrets.mjs
 */
import { strict as assert } from 'node:assert';
const { makeSecrets } = await import('../secrets.mjs');

let failures = 0;
function check(name, fn) { try { fn(); console.log(`  ok  ${name}`); } catch (e) { failures++; console.error(`FAIL  ${name}: ${e.message}`); } }

// A mock exec that records calls and answers the availability probe + a lookup.
function mockExec(script) {
  const calls = [];
  const exec = (cmd, args, opts = {}) => { calls.push({ cmd, args, input: opts.input }); return script(cmd, args, opts) || { status: 0, stdout: '', stderr: '' }; };
  return { exec, calls };
}

check('darwin: set/get/delete use `security` with the right argv', () => {
  const { exec, calls } = mockExec((cmd, args) => {
    if (args[0] === 'help') return { status: 0, stdout: '' };            // probe
    if (args[0] === 'find-generic-password') return { status: 0, stdout: 'SEKRET\n' };
    return { status: 0, stdout: '' };
  });
  const s = makeSecrets({ exec, platform: 'darwin' });
  assert.equal(s.available(), true);
  assert.equal(s.set('anthropic', 'SEKRET'), true);
  const setCall = calls.find(c => c.args[0] === 'add-generic-password');
  assert.deepEqual(setCall.args, ['add-generic-password', '-U', '-s', 'smartmonkey', '-a', 'anthropic', '-w', 'SEKRET']);
  assert.equal(s.get('anthropic'), 'SEKRET');
  assert.ok(calls.some(c => c.args[0] === 'find-generic-password' && c.args.includes('anthropic')));
  assert.equal(s.delete('anthropic'), true);
  assert.ok(calls.some(c => c.args[0] === 'delete-generic-password'));
});

check('linux: value goes on stdin, not argv (secret-tool)', () => {
  const { exec, calls } = mockExec((cmd, args) => {
    if (args[0] === '--version') return { status: 0, stdout: '0.20' };   // probe
    if (args[0] === 'lookup') return { status: 0, stdout: 'V' };
    return { status: 0, stdout: '' };
  });
  const s = makeSecrets({ exec, platform: 'linux' });
  assert.equal(s.available(), true);
  s.set('openai', 'topsecret');
  const store = calls.find(c => c.args[0] === 'store');
  assert.equal(store.input, 'topsecret', 'value passed via stdin');
  assert.ok(!store.args.includes('topsecret'), 'value NOT on argv');
  assert.equal(s.get('openai'), 'V');
});

check('unavailable (win32 / failing probe) → in-memory fallback round-trips', () => {
  const s = makeSecrets({ exec: () => ({ status: null, stdout: '', stderr: '' }), platform: 'win32' });
  assert.equal(s.available(), false);
  assert.equal(s.get('x'), null);
  s.set('x', 'v');
  assert.equal(s.get('x'), 'v');
  s.delete('x');
  assert.equal(s.get('x'), null);
});

if (failures) { console.error(`\n${failures} failure(s)`); process.exit(1); }
console.log('\nsecrets: all passed');
