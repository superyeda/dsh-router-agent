// rc.5: a user/message has NO turn field. Its containing turn is defined by the
// contiguous journal, not by the session's current running/idle status.
export const validCursor = n => Number.isSafeInteger(n) && n >= -1 && !Object.is(n, -0);
export const unknown = error => ({ status: 'unknown', error });
const turnNumber = n => Number.isSafeInteger(n) && n > 0;

// Return only public text blocks, never reasoning, tool arguments, images, raw
// streams or logs. Bound before concatenation; do not cut a surrogate pair.
export function visibleText(content, limit, suffix = '…') {
  if (!Array.isArray(content)) return '';
  let text = '';
  for (const part of content) {
    if (part?.type !== 'text' || typeof part.text !== 'string') continue;
    text += part.text.slice(0, limit + 1 - text.length);
    if (text.length > limit) {
      const prefix = text.slice(0, limit).replace(/[\uD800-\uDBFF]$/, '').trim();
      return prefix ? prefix + suffix : '';
    }
  }
  return text.trim();
}

const endFailures = new Map([
  ['error', '本轮执行出错'], ['aborted', '本轮已取消'], ['blocked', '本轮被宿主阻止'],
  ['max-tokens', '本轮达到输出长度上限，并非完整结果'], ['interrupted', '本轮被中断'],
  ['forked', '本轮仅为分支上补记的结束边界'],
]);

/** Fold only the verified contiguous interval (afterSeq, state.cursor]. */
export function classify(events, requestId, state) {
  let open = null, mine = null, last = 0;
  const ambiguous = () => unknown('不能唯一确定请求和轮次的对应关系；请打开原会话核对。');
  for (const event of events) {
    const { type, data } = event;
    if (type === 'turn/start') {
      if (open || !turnNumber(data?.turn) || data.turn <= last) return ambiguous();
      last = data.turn;
      open = { turn: last, humans: 0, step: null, assistant: null, end: null };
    } else if (type === 'turn/end') {
      // The captured cursor may be in the middle of someone else's old turn.
      if (!open) continue;
      if (data?.turn !== open.turn || !data?.reason?.kind) return ambiguous();
      open.end = data.reason;
      open = null;
    } else if (type === 'user/message' && event.surfaceOp === 'append') {
      const source = data?.source;
      if (source?.kind !== 'user' && source?.kind !== 'retry') continue;
      if (open) { open.humans++; open.assistant = null; }
      if (source.kind === 'user' && source.rpcId === requestId) {
        if (!open || mine) return ambiguous();
        mine = open;
      }
    } else if (open && type === 'step/start') {
      if (data?.turn !== open.turn || !turnNumber(data?.step)) return ambiguous();
      open.step = data.step;
      open.assistant = null;
    } else if (open && type === 'assistant/message' && event.surfaceOp === 'append') {
      if (data?.turn !== open.turn || !turnNumber(data?.step) || (open.step !== null && data.step !== open.step)) return ambiguous();
      // A tool-call-only final step can conclude the turn. Do not substitute its
      // progress text or reach back to a prior step for a dependency result.
      open.assistant = open === mine && !data.interrupted && data.message?.role === 'assistant'
        && Array.isArray(data.message.content) && !data.message.content.some(b => b?.type === 'tool-call')
        ? data.message.content : null;
    } else if (open && (type === 'assistant/attempt' || type === 'assistant/message' || type === 'tool/call')) {
      open.assistant = null;
    }
  }
  if (!mine) return unknown('尚未在本次游标后看到该请求进入某一轮；不会依据空闲或他人的输出判断完成。');
  if (mine.humans !== 1) return unknown('同一轮包含另一条人工输入，无法可靠分辨结果归属；请查看原会话。');
  if (!mine.end) {
    if (open !== mine || !state.running || !state.active) return unknown('已找到请求，但本轮尚无可信的结束记录。');
    // pendingInput is session-wide. It only describes this request when its
    // uniquely attributed turn is STILL open at this exact live-state cut.
    return { status: state.pendingInput.some(kind => kind === 'approval' || kind === 'question') ? 'input-required' : 'running' };
  }
  if (mine.end.kind === 'completed') {
    const result = visibleText(mine.assistant, 16000, '\n…（结果已截短，请在原会话查看全文）');
    return result ? { status: 'done', result } : unknown('本轮已结束，但没有可确认的最终文本；不会把工具调用、推理或中间输出当作结果。');
  }
  const reason = endFailures.get(mine.end.kind);
  if (!reason) return unknown('宿主报告了未识别的轮末原因；请打开原会话核对。');
  const detail = typeof mine.end.error?.message === 'string' ? mine.end.error.message.trim().slice(0, 400) : '';
  return { status: 'failed', error: detail ? reason + '：' + detail : reason };
}

// A page counts user/assistant messages, not raw events. Fix the inclusive cut
// for every backwards request; beforeSeq is exclusive and never a page number.
// Return unknown (via caller) rather than guessing across a gap or copying a
// whole unbounded session to the client on every poll.
export async function readInterval(events, sessionId, afterSeq, throughSeq) {
  if (afterSeq === throughSeq) return [];
  if (throughSeq - afterSeq > 8192) throw Error('请求后的日志超出安全核对窗口；请查看原会话。');
  const chunks = [];
  let upper = throughSeq;
  for (let i = 0; i < 12; i++) {
    const page = await events({ address: {kind: 'session', sessionId}, throughSeq, maxMessages: 16,
      ...(i === 0 ? {} : {beforeSeq: upper + 1}) });
    const records = page?.records;
    if (page?.cursor !== throughSeq || !Array.isArray(records) || !records.length || typeof page.hasMore !== 'boolean') break;
    const first = upper - records.length + 1;
    if (first < 0) break;
    const chunk = [];
    for (let index = Math.max(0, afterSeq + 1 - first); index < records.length; index++) {
      const record = records[index];
      if (record?.type !== 'event' || record.event?.seq !== first + index || typeof record.event.type !== 'string') {
        throw Error('会话日志不连续，不能确认结果归属。');
      }
      chunk.push(record.event);
    }
    chunks.push(chunk);
    if (first <= afterSeq + 1) return chunks.reverse().flat();
    if (!page.hasMore) break;
    upper = first - 1;
  }
  throw Error('未取得覆盖本次请求的连续日志；请打开原会话核对。');
}
