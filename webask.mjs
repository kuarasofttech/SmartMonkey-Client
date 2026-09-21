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
