// Browser ESM only. All calls use the injected, already-authenticated DSH
// client Remote; no filesystem, host credentials, endpoint or new service.
import { expectedRecoveryId } from '../host/contract.mjs';
import { classify, readInterval, unknown, validCursor, visibleText } from './observation.mjs';

const identifier = value => typeof value === 'string' && value.trim().length > 0;
const directory = p => typeof p === 'string' && (p.startsWith('/') || /^[a-z]:[\\/]/i.test(p))
  && !/[\u0000-\u001f]/.test(p) && !p.split(/[\\/]/).some(part => part === '..' || part === '.');
const same = (a, b) => a.size === b.size && [...a].every(i => b.has(i));

// Keep stable host codes on the thrown error (the controller uses them); do
// not dump private session diagnostics when explaining known recovery errors.
const recoveryMessages = new Map([
  ['router-agent/creation-conflict', '该创建键已用于不同的参数，请核对原分项。'],
  ['router-agent/creation-uncertain', '会话已存在，但没有当前宿主的创建收据；请核对原分项，不要重新提交。'],
  ['router-agent/recovery-unsafe', '不能证明这是指定目录中未被使用的普通空会话；未接回，也不会改模型或发消息。'],
  ['router-agent/recovery-not-found', '未找到原分项指定的持久空会话；没有新建或投递。'],
  ['router-agent/not-owned', '此会话不具备本次宿主的创建证明，不能修改模型。'],
]);
function unpack(reply, operation) {
  // Generated unary methods do NOT directly return the business value.
  if (reply?.ok === true) return reply.value;
  const message = recoveryMessages.get(reply?.error?.code) ?? (reply?.ok === false && identifier(reply.error?.message)
    ? reply.error.message.slice(0, 500) : '响应无效或功能尚未就绪');
  const error = Error(operation + '失败：' + message);
  if (identifier(reply?.error?.code)) error.code = reply.error.code;
  throw error;
}

// workspace.follow is a stream of RAW frames (not RemoteResult). Its first
// baseline contains the authoritative global archive set. Never keep using an
// old baseline after a disconnection. Breaking iteration disposes the rc.5
// ClientStreamHandle, releasing this one-shot subscription even on errors.
async function baseline(remote, cancel) {
  const deadline = AbortSignal.timeout(10000);
  const signal = cancel ? AbortSignal.any([cancel, deadline]) : deadline;
  for await (const frame of remote.workspace.follow(signal)) {
    signal.throwIfAborted();
    const value = frame?.value;
    if (frame?.type !== 'baseline' || !Array.isArray(value?.items) || !Array.isArray(value.archivedSessionIds)
      || !value.archivedSessionIds.every(identifier)) break;
    return {items: value.items, archived: new Set(value.archivedSessionIds)};
  }
  throw Error('未取得实时工作区/归档基线，已停止访问。');
}

// Journal entries are search hints, never capabilities. Consider only the
// latest few exact bindings per session; no path expansion, ID prefix or
// task text is consulted. Bounds apply before issuing any event reads.
function bindingIndex(bindings, paths) {
  const result = new Map(), keys = [];
  if (Array.isArray(bindings)) for (const b of bindings.slice(0, 256)) {
    if (!paths.has(b?.cwd) || !identifier(b.id) || !identifier(b.requestId) || !validCursor(b.afterSeq)) continue;
    const items = result.get(b.id) ?? [];
    if (items.length >= 4 || items.some(x => x.cwd === b.cwd && x.requestId === b.requestId && x.afterSeq === b.afterSeq)) continue;
    const hint = {cwd: b.cwd, requestId: b.requestId, afterSeq: b.afterSeq};
    items.push(hint); result.set(b.id, items); keys.push(JSON.stringify([b.id, hint.cwd, hint.requestId, hint.afterSeq]));
  }
  return {byId: result, key: JSON.stringify(keys.sort())};
}
const makeScope = (paths, bindingKey = '[]') => ({ paths, bindingKey, candidates: new Map(), recoveryHeaders: new Map(), listedRouterIds: new Set(), ready: false, lookup: null, abort: new AbortController() });
// rc.5 ordinary historical forks can have a parentSessionId; origin, not
// that parent field, marks a subagent. Unknown future origins fail closed.
const ordinary = row => row?.formatStatus === 'current' && row.origin === undefined && identifier(row.sessionId);
// session.list's cwd is immutable header metadata. dsh-working-directory's
// workingDirectory projection starts at header.cwd and folds every change. A
// cached/missing value, null (deployment fallback), or a different path is
// NOT evidence that the agent is currently working in the authorized project.
const sequenced = projection => projection?.kind === 'sequenced' && validCursor(projection.asOfSeq);
const sameDirectory = (projection, cwd) => sequenced(projection) && projection.values?.workingDirectory === cwd;
const pendingRpc = (inbox, keys) => Array.isArray(inbox?.['next-turn']) && inbox['next-turn'].some(m =>
  m?.role === 'user' && m.source?.kind === 'user' && keys.has(m.source.rpcId));
function nonblank(row, projection) {
  if (row.blank !== false) return false;
  // A cold cache miss is intentionally labeled blank:false by the native list.
  const metadata = projection.values?.sessionListMetadata;
  if (typeof metadata?.blank === 'boolean') return !metadata.blank;
  return row.agentAvailable === true || row.projections?.kind === 'sequenced';
}

export function createDshAdapter(remote) {
  let scope = makeScope(new Set());
  // Distinct capabilities. Only the create RPC grants configure; explicit
  // recoverEmpty grants ordinary enqueue without configure; the saved key
  // and a roster-verified header can grant observation, NEVER delivery.
  const owned = new Map(), reusedEmpty = new Map(), observationOnly = new Map();
  const receipts = [owned, reusedEmpty, observationOnly];
  function prune(map, keep) {
    for (const [id, receipt] of map) {
      const cwd = map === reusedEmpty ? receipt.cwd : receipt;
      if (!keep(id, cwd)) map.delete(id);
    }
  }

  function install(paths, bindingKey = '[]') {
    if (!same(scope.paths, paths) || scope.bindingKey !== bindingKey) {
      scope.abort.abort();
      scope = makeScope(paths, bindingKey);
      for (const map of receipts) prune(map, (_, cwd) => paths.has(cwd));
    }
    return scope;
  }
  function checked(s, cwd) {
    if (s !== scope || !s.ready || !s.paths.has(cwd)) throw Error('当前目录未获授权或授权已刷新，请重新选择会话。');
  }
  function grant(s, id, use) {
    let cwd;
    switch (use) {
      case 'recent': cwd = s.candidates.get(id); break;
      case 'configure': cwd = owned.get(id); break;
      case 'cursor': case 'deliver': cwd = reusedEmpty.get(id)?.cwd ?? s.candidates.get(id) ?? owned.get(id); break;
      case 'observe': cwd = s.candidates.get(id) ?? owned.get(id) ?? reusedEmpty.get(id)?.cwd ?? observationOnly.get(id); break;
      default: throw Error('没有授权此项会话操作。');
    }
    if (cwd === undefined) throw Error(use === 'configure' ? '只允许配置由本入口新建的会话。' : '会话不在最近一次授权的可操作列表内。');
    checked(s, cwd);
    return cwd;
  }
  async function currentProjection(s, id) {
    return unpack(await remote.session.projections({sessionId: id}, s.abort.signal), '核对会话当前工作目录');
  }
  function forget(s, id) {
    if (s !== scope) return;
    s.candidates.delete(id);
    s.recoveryHeaders.delete(id);
    for (const map of receipts) map.delete(id);
  }
  function recoveryTarget(s, cwd, key, id) {
    const expected = expectedRecoveryId(key);
    if (!expected || id !== expected) throw Error('原创建键与完整会话 ID 不匹配，不能恢复。');
    checked(s, cwd);
    // A journal entry or deterministic ID alone is not a session. Use a real
    // rc.5 SessionSummary from the last authorized roster, never a placeholder.
    if (s.recoveryHeaders.get(id) !== cwd) throw Error('最近一次授权的会话列表中无此目录的普通恢复目标。');
  }
  async function verifyLiveDirectory(s, id, cwd) {
    checked(s, cwd);
    const {archived} = await baseline(remote, s.abort.signal);
    checked(s, cwd);
    if (archived.has(id)) {
      forget(s, id);
      throw Error('该会话现已归档；不会读取、配置或投递。');
    }
    const projection = await currentProjection(s, id);
    checked(s, cwd);
    if (!sameDirectory(projection, cwd)) {
      forget(s, id);
      throw Error('会话实际工作目录已改变，或无法核实；不会读取、配置或投递。');
    }
    return projection.asOfSeq;
  }
  async function liveGrant(s, id, use) {
    const cwd = grant(s, id, use);
    const throughSeq = await verifyLiveDirectory(s, id, cwd);
    if (grant(s, id, use) !== cwd) throw Error('会话授权发生变化。');
    return throughSeq;
  }
  function router() {
    if (!remote.routerAgent) throw Error('路由器宿主插件未加载；不会回退至会修改宿主默认模型的接口。');
    return remote.routerAgent;
  }
  const readState = async (s, id) => {
    const state = unpack(await remote.session.state({sessionId: id}, s.abort.signal), '读取会话状态');
    if (!validCursor(state?.cursor)) throw Error('宿主未返回有效会话游标。');
    return state;
  };
  // A confirmed create/deliver stored by the router does not itself authorize
  // ordinary reuse. The caller has already verified the native header, archive
  // set and exact workingDirectory before this passive evidence-only read.
  async function bindingEvidence(s, row, projection, hints) {
    const effective = hints.filter(h => h.cwd === row.cwd && projection.asOfSeq > h.afterSeq);
    if (!effective.length) return null;
    const nowNonblank = projection.values.sessionListMetadata?.blank === false;
    const keys = new Set(effective.map(h => h.requestId));
    const inbox = projection.values.inbox;
    const sourceMatches = (h, item) => item?.role === 'user' && item.source?.kind === 'user' && item.source.rpcId === h.requestId;
    // Includes COLD pending input: session.state.queue is null without a live
    // Agent, while the sequenced inbox projection folds the native journal.
    if (pendingRpc(inbox, keys)) return {busy: true, cut: projection.asOfSeq, keys};
    const state = await readState(s, row.sessionId);
    s.abort.signal.throwIfAborted();
    const eligible = effective.filter(h => state.cursor > h.afterSeq);
    if (!eligible.length || typeof state.running !== 'boolean' || typeof state.active !== 'boolean') return null;
    const busy = state.running || (Array.isArray(state.queue) && state.queue.length > 0);
    if (nowNonblank) return {busy, cut: Math.max(projection.asOfSeq, state.cursor), durable: true};
    if (state.active && Array.isArray(state.queue) && eligible.some(h => state.queue.some(m => m?.rpcId === h.requestId && m.placement === 'queued'))) {
      return {busy: true, cut: state.cursor, keys: new Set(eligible.map(h => h.requestId))};
    }
    // A consumed message is no longer in the inbox. Read a small, pinned
    // interval; require an actual appended user-role RPC inside a turn, not
    // unrelated activity, a replacement, a tool result or a removed splice.
    const start = Math.max(Math.min(...eligible.map(h => h.afterSeq)), state.cursor - 512);
    const events = await readInterval(async request => {
      s.abort.signal.throwIfAborted();
      return unpack(await remote.session.events(request, s.abort.signal), '核实已接纳的请求');
    }, row.sessionId, start, state.cursor);
    if (events.some(e => e.type === 'working-directory/change' && e.data?.cwd !== row.cwd)) return null;
    let activeTurn = null, matched = false;
    for (const e of events) {
      if (e.type === 'turn/start') {
        if (activeTurn !== null || !Number.isSafeInteger(e.data?.turn) || e.data.turn <= 0) return null;
        activeTurn = e.data.turn;
      } else if (e.type === 'turn/end') {
        if (activeTurn !== null && e.data?.turn !== activeTurn) return null;
        activeTurn = null;
      } else if (activeTurn !== null && e.type === 'user/message' && e.surfaceOp === 'append' &&
        eligible.some(h => e.seq > h.afterSeq && sourceMatches(h, e.data))) matched = true;
    }
    return matched ? {busy, cut: state.cursor, durable: true} : null;
  }
  // The owner accepted one *specific empty cut*, not a reusable name. Check
  // this same receipt (object identity as well as seq) before every first
  // write. Never let an overlapping list refresh or ordinary candidate turn
  // the in-flight operation into an unchecked send.
  function recoveredCut(s, id, use, receipt, cursor, state) {
    grant(s, id, use);
    if (reusedEmpty.get(id) !== receipt) throw Error('原空会话的恢复许可已被使用或更新；未继续此操作。');
    if (!receipt) return;
    const idle = state === undefined || (state.running === false && Array.isArray(state.pendingInput) && state.pendingInput.length === 0
      && (state.active === false && state.queue === null || state.active === true && Array.isArray(state.queue) && state.queue.length === 0));
    if (receipt.cursor !== cursor || !idle) {
      reusedEmpty.delete(id); // observationOnly remains; another send needs independent authority
      throw Error('确认后原空会话已出现新事件或待处理工作，未投递。请核对原会话后再决定。');
    }
  }
  async function catalog() {
    const value = unpack(await remote.session.modelCatalog(), '获取模型目录');
    if (!Array.isArray(value?.groups) || !Array.isArray(value.routableProviders)) throw Error('模型目录格式无效。');
    const routes = new Set(value.routableProviders);
    const rows = [];
    for (const group of value.groups) {
      if (!identifier(group?.id) || !routes.has(group.id) || !Array.isArray(group.models)) continue;
      for (const m of group.models) if (identifier(m?.id)) {
        const advertised = m.reasoning?.efforts ?? [];
        if (!Array.isArray(advertised)) continue;
        const efforts = [...new Set(advertised.map(e => e?.id).filter(identifier))];
        // rc.5 exposes display labels, not benchmark/latency/cost scores.
        const badge = m.badge;
        const label = identifier(badge?.text) || (badge?.text && typeof badge.text === 'object'
          && identifier(badge.text.en) && Object.values(badge.text).every(identifier));
        rows.push({provider: group.id, model: m.id, efforts,
          ...(identifier(m.name) ? {name: m.name} : {}), ...(identifier(m.description) ? {description: m.description} : {}),
          ...(label && ['neutral','info','success','warning'].includes(badge.tone) ? {badge: {text: badge.text, tone: badge.tone}} : {}),
          ...(efforts.includes(m.reasoning?.defaultEffort) ? {defaultEffort: m.reasoning.defaultEffort} : {})});
      }
    }
    return rows;
  }

  return {
    async listWorkspaces() {
      const {items} = await baseline(remote);
      return items.filter(item => directory(item?.path)).map(({title, path}) => ({name: identifier(title) ? title : path, path}));
    },

    async listSessions(paths, routeBindings = []) {
      if (!(Array.isArray(paths) || paths instanceof Set) || ![...paths].every(directory)) {
        install(new Set()); // malformed replacement also revokes the old scope
        throw Error('请提供明确授权的绝对工作目录列表。');
      }
      const dirs = new Set(paths), bindings = bindingIndex(routeBindings, dirs);
      const s = install(dirs, bindings.key);
      if (!s.paths.size) return []; // do not enumerate sessions for an empty allowlist
      if (s.lookup) return s.lookup;
      s.ready = false;
      s.candidates.clear();
      s.recoveryHeaders.clear();
      s.listedRouterIds.clear();
      s.lookup = (async () => {
        const value = unpack(await remote.session.list({}, s.abort.signal), '获取会话候选');
        s.abort.signal.throwIfAborted();
        if (!Array.isArray(value?.items)) throw Error('会话列表格式无效。');
        // Sample the mutable archive set AFTER the (possibly slow) cold list.
        const {archived} = await baseline(remote, s.abort.signal);
        s.abort.signal.throwIfAborted();
        // Inspect no out-of-scope history or projection: session.list is the
        // native metadata index; history RPCs are always individually guarded.
        // Indices sometimes omit cold or just-created rows. Remember only
        // these opaque router IDs, no extra paths, names or projection data.
        for (const row of value.items) if (typeof row?.sessionId==='string' && row.sessionId.startsWith('session-router-agent-ra-')) s.listedRouterIds.add(row.sessionId);
        const rows = value.items.filter(row => s.paths.has(row?.cwd) && ordinary(row) && !archived.has(row.sessionId));
        const directoryById = new Map(rows.map(row => [row.sessionId, row.cwd]));
        prune(owned, (id, cwd) => directoryById.get(id) === cwd);
        // Recovery never binds a fork, child, list placeholder, or row with an
        // uncertain header. Cold, materialized ordinary sessions may have no
        // live Agent. The host separately checks persistence for writable reuse.
        for (const row of rows) if (row.parentSessionId === undefined && typeof row.blank === 'boolean'
          && typeof row.agentAvailable === 'boolean' && typeof row.running === 'boolean' && Number.isFinite(row.updatedAt)) {
          s.recoveryHeaders.set(row.sessionId, row.cwd);
        }
        for (const map of [reusedEmpty, observationOnly]) prune(map, (id, cwd) => s.recoveryHeaders.get(id) === cwd);
        const candidates = [];
        let verifiedBinding = false;
        for (const row of rows) {
          if (typeof row.blank !== 'boolean' || !Number.isFinite(row.updatedAt) || typeof row.running !== 'boolean') continue;
          const hints = (bindings.byId.get(row.sessionId) ?? []).filter(h => h.cwd === row.cwd);
          if (row.blank && !hints.length) continue;
          let projection = row.projections;
          const proofRequired = hints.length > 0 && (row.blank || !sequenced(projection) || !nonblank(row, projection));
          // Even targeted proofs require the native current address: no calls
          // to sessions missing from the index, children or another directory.
          if (proofRequired || !sequenced(projection) || projection.values?.workingDirectory === undefined) {
            try { projection = await currentProjection(s, row.sessionId); }
            catch { s.abort.signal.throwIfAborted(); continue; }
            s.abort.signal.throwIfAborted();
          }
          if (!sameDirectory(projection, row.cwd)) { forget(s, row.sessionId); continue; }
          let bindingBusy = false;
          if (!nonblank(row, projection)) {
            if (!hints.length) continue;
            let evidence;
            try { evidence = await bindingEvidence(s, row, projection, hints); }
            catch { s.abort.signal.throwIfAborted(); continue; }
            s.abort.signal.throwIfAborted();
            if (!evidence) continue;
            // Do not publish a per-session proof that crossed a directory
            // change (even while a bounded history read was in flight).
            let latest;
            try { latest = await currentProjection(s, row.sessionId); }
            catch { s.abort.signal.throwIfAborted(); continue; }
            s.abort.signal.throwIfAborted();
            if (!sameDirectory(latest, row.cwd) || latest.asOfSeq < evidence.cut) { forget(s, row.sessionId); continue; }
            // If the old queue proof has moved on, verify it is still pending
            // or the session has become an ordinary nonblank conversation. A
            // retracted item is not evidence to keep an otherwise blank row.
            if (!evidence.durable && latest.asOfSeq !== evidence.cut && latest.values.sessionListMetadata?.blank !== false
              && !pendingRpc(latest.values.inbox, evidence.keys)) continue;
            projection = latest; bindingBusy = evidence.busy; verifiedBinding = true;
          }
          const title = projection.values.title;
          const inbox = projection.values.inbox;
          const pending = ['next-turn', 'next-step'].some(k => Array.isArray(inbox?.[k]) && inbox[k].length > 0);
          candidates.push({id: row.sessionId, cwd: row.cwd, title: identifier(title) ? title : row.sessionId,
            updatedAt: row.updatedAt, busy: row.running || pending || bindingBusy});
        }
        const hidden = verifiedBinding ? (await baseline(remote, s.abort.signal)).archived : archived;
        s.abort.signal.throwIfAborted();
        const visible = candidates.filter(c => !hidden.has(c.id));
        for (const c of visible) s.candidates.set(c.id, c.cwd);
        s.ready = true;
        return visible;
      })();
      try { return await s.lookup; } finally { s.lookup = null; }
    },

    async recent(id) {
      const s = scope;
      // Pin the history to the exact cursor at which the directory was verified:
      // a fast switch away and back must not leak intervening prompts.
      const throughSeq = await liveGrant(s, id, 'recent');
      grant(s, id, 'recent');
      const page = unpack(await remote.session.events({address: {kind: 'session', sessionId: id}, throughSeq, maxMessages: 8}, s.abort.signal), '读取近期任务');
      if (page?.cursor !== throughSeq || !Array.isArray(page.records)) throw Error('近期消息页游标或格式无效。');
      // Only actual human prompts, never system/developer messages, tools,
      // reasoning, context injection, retry markers, or serialized attachments.
      const texts = [];
      // Even if the session is back home now, do not include prompts from a
      // prior working-directory epoch in the snippets offered to the planner.
      const boundary = page.records.findLastIndex(r => r?.event?.type === 'working-directory/change');
      for (let i = page.records.length - 1; i > boundary && texts.length < 3; i--) {
        const entry = page.records[i], event = entry?.event;
        if (entry?.type !== 'event' || event?.type !== 'user/message' || event.surfaceOp !== 'append'
          || event.data?.source?.kind !== 'user') continue;
        const text = visibleText(event.data.content, 320);
        if (text) texts.unshift(text);
      }
      await liveGrant(s, id, 'recent'); // revoke even a read that was in flight
      grant(s, id, 'recent');
      return texts;
    },

    catalog,

    async createSession(cwd, requestId, {agentPreset} = {}) {
      const s = scope;
      checked(s, cwd);
      if (typeof requestId !== 'string' || !/^[a-zA-Z0-9_-]{1,128}$/.test(requestId)) throw Error('新建会话需要稳定的创建请求标识。');
      // The owner-only RPC is create-only and idempotent by key. Native
      // session.create can silently mint an unrelated id instead of reusing
      // the requested id. Never substitute it, or adopt a session by its name.
      // With no explicit choice, omit agentPreset so the DSH preset registry
      // selects its deployment default. A preset is not a model route.
      if (agentPreset !== undefined && (!identifier(agentPreset) || agentPreset.trim() !== agentPreset
        || /[\u0000-\u001f\u007f]/u.test(agentPreset) || agentPreset.length > 256)) throw Error('新会话预设标识无效。');
      const value = unpack(await router().create({requestId, cwd, ...(agentPreset === undefined ? {} : {agentPreset})}), '安全创建会话');
      if (!identifier(value?.sessionId)) throw Error('未取得新会话标识；重试时必须保留同一创建标识。');
      // A repeated receipt can name a once-blank session whose agent has since
      // switched directories. Ownership never grants a directory exception.
      await verifyLiveDirectory(s, value.sessionId, cwd);
      checked(s, cwd);
      owned.set(value.sessionId, cwd);
      return value.sessionId;
    },

    // Called only after the owner's explicit confirmation for the persisted
    // item. The host rechecks durability, preset, emptiness and absence of work;
    // this is NOT a new-session receipt and MUST NOT select a model.
    async recoverEmpty(cwd, createKey, sessionId) {
      const s = scope;
      checked(s,cwd);
      if (expectedRecoveryId(createKey)===sessionId && sessionId && !s.listedRouterIds.has(sessionId)) {
        const {archived}=await baseline(remote,s.abort.signal);checked(s,cwd);
        if (archived.has(sessionId)) throw Error('该会话已归档；不会接回或投递。');
        if (typeof router().recoverEmpty!=='function') throw Error('宿主尚未提供空会话恢复；请更新插件。');
        // A stale/missing row never grants access, including if the host returns
        // success. Only a positive not-found permits a later same-key create.
        const probe=await router().recoverEmpty({requestId:createKey,sessionId,cwd,checkMissingOnly:true},s.abort.signal);
        checked(s,cwd);unpack(probe,'核对原会话是否存在');throw Error('无法确认该 ID 不存在，未恢复或投递。');
      }
      recoveryTarget(s, cwd, createKey, sessionId);
      // A failed second verification cannot extend an older write receipt.
      reusedEmpty.delete(sessionId);
      await verifyLiveDirectory(s, sessionId, cwd);
      recoveryTarget(s, cwd, createKey, sessionId);
      const service = router();
      if (typeof service.recoverEmpty !== 'function') throw Error('宿主尚未提供空会话恢复；请更新插件，不会改用新建或投递。');
      const value = unpack(await service.recoverEmpty({requestId: createKey, sessionId, cwd}, s.abort.signal), '核实并接回原空会话');
      if (value?.sessionId !== sessionId || !validCursor(value.cursor) || value.cursor < 0) {
        throw Error('宿主未确认原分项的会话 ID 和持久事件水位，未接回。');
      }
      recoveryTarget(s, cwd, createKey, sessionId);
      const throughSeq = await verifyLiveDirectory(s, sessionId, cwd);
      recoveryTarget(s, cwd, createKey, sessionId);
      if (throughSeq !== value.cursor) throw Error('恢复核验期间会话已经改变，未接回或投递。');
      observationOnly.set(sessionId, cwd);
      reusedEmpty.set(sessionId, {cwd, cursor: value.cursor});
      return sessionId;
    },

    // A reloaded page can observe an already-attempted rpcId while a still
    // pending prompt leaves the host's blank flag true. No owner RPC, create,
    // navigation, cursor or send capability is involved in this operation.
    async bindRecoveryObservation(cwd, createKey, sessionId) {
      const s = scope;
      recoveryTarget(s, cwd, createKey, sessionId);
      observationOnly.delete(sessionId);
      const throughSeq = await verifyLiveDirectory(s, sessionId, cwd);
      recoveryTarget(s, cwd, createKey, sessionId);
      if (throughSeq < 0) throw Error('尚无可核验的已落地会话事件，不能绑定原投递观察。');
      observationOnly.set(sessionId, cwd);
      return sessionId;
    },

    async configure(id, {provider, model, effort} = {}) {
      const s = scope;
      grant(s, id, 'configure');
      const rows = await catalog();
      const row = rows.find(r => r.provider === provider && r.model === model);
      if (!row || (effort != null && effort !== '' && !row.efforts.includes(effort))) throw Error('模型或思考强度并非宿主当前可选项。');
      await liveGrant(s, id, 'configure');
      grant(s, id, 'configure');
      // Native session.selectModel also persists the new host default. The
      // router RPC verifies blank/ownership and changes ONLY this session.
      const value = unpack(await router().configure({sessionId: id, provider, model, ...(effort ? {effort} : {})}), '配置新会话模型');
      if (value?.ok !== true) throw Error('宿主未确认安全的会话级选模。');
    },

    async cursor(id) {
      const s = scope, receipt = reusedEmpty.get(id);
      const projectionCut = await liveGrant(s, id, 'cursor');
      recoveredCut(s, id, 'cursor', receipt, projectionCut);
      const state = await readState(s, id);
      recoveredCut(s, id, 'cursor', receipt, state.cursor, state);
      return state.cursor;
    },

    async deliver(id, requestId, text) {
      if (!identifier(requestId) || !identifier(text)) throw Error('排队投递需要非空文本和稳定的请求标识。');
      const s = scope, receipt = reusedEmpty.get(id);
      const projectionCut = await liveGrant(s, id, 'deliver');
      recoveredCut(s, id, 'deliver', receipt, projectionCut);
      if (receipt) {
        const state = await readState(s, id);
        recoveredCut(s, id, 'deliver', receipt, state.cursor, state);
        // Consume synchronously before admission, even on lost/uncertain ack.
        // Concurrent calls holding the same receipt fail the identity check.
        reusedEmpty.delete(id);
      }
      // rc.5 persists source.rpcId on inbox insertion. Retrying this EXACT
      // requestId is idempotent even after the queue item has been consumed.
      const value = unpack(await remote.session.prompt({sessionId: id, requestId, mode: 'queue',
        content: [{type: 'text', text}]}, s.abort.signal), '排队投递');
      if (value?.accepted !== true) throw Error('未确认入队；请保留原请求标识，不要另发。');
    },

    async observe(id, requestId, afterSeq) {
      if (!identifier(requestId) || !validCursor(afterSeq)) return unknown('缺少原始请求标识或有效的投递前游标。');
      try {
        const s = scope;
        await liveGrant(s, id, 'observe'); grant(s, id, 'observe');
        const state = await readState(s, id);
        grant(s, id, 'observe');
        if (state.cursor < afterSeq || typeof state.running !== 'boolean' || typeof state.active !== 'boolean'
          || !(Array.isArray(state.queue) || state.queue === null) || !Array.isArray(state.pendingInput)) {
          return unknown('宿主状态或游标发生变化，无法核实本次投递。');
        }
        const pending = state.queue?.filter(q => q?.rpcId === requestId) ?? [];
        if (pending.length) return pending.length === 1 && pending[0].placement === 'queued' ? {status: 'queued'}
          : unknown('该请求的排队位置已被更改，无法确认轮次。');
        const events = await readInterval(async request => {
          grant(s, id, 'observe');
          return unpack(await remote.session.events(request, s.abort.signal), '读取会话事件');
        }, id, afterSeq, state.cursor);
        const cwd = grant(s, id, 'observe');
        if (events.some(e => e.type === 'working-directory/change' && e.data?.cwd !== cwd)) {
          return unknown('请求期间的工作目录发生过改变；不会把跨目录输出作为本项目结果。');
        }
        const outcome = classify(events, requestId, state);
        if (outcome.status === 'done' || outcome.status === 'failed') await liveGrant(s, id, 'observe');
        grant(s, id, 'observe');
        return outcome;
      } catch (error) {
        // Transport loss, archive/removal, unsupported events and an exhausted
        // history window are NOT execution failure, much less task completion.
        return unknown('无法核实该请求：' + (error?.message || '宿主不可用'));
      }
    },
  };
}
