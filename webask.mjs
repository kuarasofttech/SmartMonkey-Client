/**
 * The interview-over-web bridge. The agent's ask_user tool calls `ask`, which
 * parks a promise on the session and emits an SSE `ask` event; the browser POSTs
 * the answer to /api/answer, which calls `answerAsk` to resolve it. Because the
 * pending question lives on the session (and is exposed by /api/status), a
 * reloaded page can still see and answer it.
 */
export function makeWebAsk(session, emit) {
  let n = 0;
  return (question, options) => new Promise((resolve) => {
    const opts = Array.isArray(options) && options.length ? options : undefined;
    const id = 'ask_' + (++n);
    session.pendingAsk = { id, question: question || '', options: opts, resolve };
    emit('ask', { id, question: question || '', options: opts });
  });
}

export function answerAsk(session, id, answer) {
  const p = session.pendingAsk;
  if (!p || p.id !== id) return false;
  session.pendingAsk = null;
  p.resolve(typeof answer === 'string' ? answer : String(answer ?? ''));
  return true;
}

/**
 * The connect-gate bridge. The agent's `request_connections` tool calls this after
 * the interview with the external tools the blueprint will draw on; it parks a
 * promise and emits an SSE `connections` event. The browser connects or skips each
 * (POST /api/connect) and then starts (POST /api/connections/start), which resolves
 * the promise — but ONLY once every service is connected or skipped.
 */
export function makeWebConnections(session, emit) {
  let n = 0;
  return (services) => new Promise((resolve) => {
    const list = (Array.isArray(services) ? services : [])
      .map(s => (typeof s === 'string' ? s : (s && (s.label || s.id)) || ''))
      .map(s => String(s).trim())
      .filter(Boolean);
    const seen = new Set();
    const uniq = list.filter(s => { const k = s.toLowerCase(); return seen.has(k) ? false : (seen.add(k), true); });
    const id = 'conn_' + (++n);
    const status = {};
    for (const s of uniq) status[s] = 'pending';
    session.pendingConnections = { id, services: uniq, status, resolve };
    emit('connections', { id, services: uniq, status });
  });
}

export function setConnection(session, id, service, action) {
  const p = session.pendingConnections;
  if (!p || p.id !== id || !(service in p.status)) return false;
  if (action === 'connect') p.status[service] = 'connected';
  else if (action === 'skip') p.status[service] = 'skipped';
  else return false;
  return true;
}

export const allResolved = pc => !!pc && Object.values(pc.status).every(v => v === 'connected' || v === 'skipped');

export function startConnections(session, id) {
  const p = session.pendingConnections;
  if (!p || p.id !== id || !allResolved(p)) return false;
  session.pendingConnections = null;
  const of = want => Object.keys(p.status).filter(k => p.status[k] === want);
  const connected = of('connected'), skipped = of('skipped');
  p.resolve(`The user finished the connect step. Connected: ${connected.join(', ') || 'none'}. Skipped: ${skipped.join(', ') || 'none'}. Now build the blueprint.`);
  return true;
}
