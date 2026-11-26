import test from 'node:test'
import assert from 'node:assert/strict'
import { verifyRecoverableEmpty } from '../src/host/recover-empty.mjs'

const id = 'session-router-agent-ra-916e781b-7f08-442e-b774-5b108c6fea52'
const cwd = process.platform === 'win32' ? 'C:\project' : '/project'
const other = process.platform === 'win32' ? 'C:\other' : '/other'
const preset = 'standard'
const allowed = new Set(['permission/preset', 'sandbox/mode', 'approval/policy', 'subagent/model-selection-policy'])
const initialData = [
  { preset: 'default' }, { mode: 'workspace-write' }, { policy: 'ask' },
  { allowedModels: [{ provider: 'provider-local', model: 'model-1' }] },
]
const error = code => Object.assign(new Error('clean ' + code), { code: 'router-agent/' + code })
const policy = {
  freshSequence(session, makeError) {
    assert.ok(session.seq <= 4)
    const seen = new Set()
    for (let index = 0; index < session.seq; index++) {
      const type = session.eventAt(index)?.type
      assert.equal('data' in session.eventAt(index), false)
      if (!allowed.has(type) || seen.has(type)) throw makeError('not-blank')
      seen.add(type)
    }
    return session.seq
  },
  emptyAt(ctx, agent, seq) {
    return agent.status === 'idle' && agent.inbox.nextStep.length === 0 && agent.inbox.nextTurn.length === 0
      && agent.turn === 0 && agent.session.seq === seq
  },
  error,
}

const failure = (reason = 'recovery-unsafe') => cause => {
  assert.equal(cause.code, 'router-agent/' + reason)
  assert.equal(cause.message, 'clean ' + reason)
  assert.equal(cause.cause, undefined)
  return true
}

function logRecord(type, data, seq) { return { type, seq, data, time: 1700000000000 + seq } }

function fixture(options = {}) {
  const header = {
    id, cwd, version: 4, agentPreset: preset, delegationDepth: 0,
    isSeeded: false, createdAt: 1699999999990, ...options.header,
  }
  const stored = options.initial ?? Array.from(allowed, (type, index) => logRecord(type, initialData[index], index))
  const identity = Symbol('backend')
  let revision = 1
  let live
  const counters = { stat: 0, opens: 0, closes: 0, reads: [], resolve: 0 }
  const marker = seq => logRecord('session/end-seed', {}, seq)
  const cancel = new AbortController()

  function attachLive(events, { firstLiveSeq = 0, liveHeader = header } = {}) {
    const session = {
      id, header: liveHeader, inheritedEventCount: 0, firstLiveSeq,
      get seq() { return events.length },
      eventAt(index) { return events[index] },
    }
    live = {
      id, session, status: 'idle', turn: 0,
      inbox: { nextStep: [], nextTurn: [] },
      model: { select() { assert.fail('recovery never selects a model') } },
    }
    return live
  }
  const api = {
    stat: async (sessionId, { signal }) => {
      assert.equal(sessionId, id)
      assert.equal(signal, cancel.signal)
      counters.stat++
      await options.onStat?.(f)
      return options.missing ? undefined : {
        header: { ...header }, formatStatus: 'current', revision: 'rev' + revision,
        sizeBytes: 100 + stored.length * 15, location: { kind: 'jsonl', path: '/opaque/v4.jsonl.zstd' },
        ...options.snapshot,
      }
    },
    open: async (sessionId, access, { signal }) => {
      assert.equal(sessionId, id)
      assert.equal(access, 'read')
      assert.equal(signal, cancel.signal)
      counters.opens++
      await options.onOpen?.(f)
      return {
        id, header: { ...header }, access: 'read', inheritedEventCount: 0, ...options.handle,
        async read(offset, limit, { signal }) {
          assert.equal(signal, cancel.signal)
          counters.reads.push([offset, limit])
          await options.onRead?.(f)
          return { events: stored.slice(offset, offset + limit), eventState: 'shared-frozen' }
        },
        async close() { counters.closes++; await options.onClose?.(f) },
        async append() { assert.fail('the recovery helper never writes history') },
        async flush() { assert.fail('the recovery helper never flushes history') },
      }
    },
    identity,
  }
  const ctx = {
    sessionPersistence: api,
    agents: {
      get: key => key === id ? live : undefined,
      async create() { assert.fail('the recovery helper never creates a session') },
    },
    sessions: { get: key => key === id ? live?.session : undefined },
    workspaceRegistry: { archivedSessionIds: [] },
    sessionController: {
      async resolveAgent(sessionId) {
        assert.equal(sessionId, id)
        counters.resolve++
        assert.equal(counters.opens, counters.closes, 'release cold handle before taking native writer')
        if (options.resolve) return await options.resolve(f)
        const firstLiveSeq = stored.length
        stored.push(marker(firstLiveSeq))
        revision++
        return { agent: attachLive([...stored], { firstLiveSeq }) }
      },
      async create() { assert.fail('the recovery helper never calls create-or-claim') },
      async selectModel() { assert.fail('the recovery helper never selects a model') },
    },
  }
  const f = {
    attached: () => live, attach: attachLive, stored, header, ctx, counters, cancel,
    bumpRevision: () => { revision++ }, marker,
    verify: patch => verifyRecoverableEmpty(ctx, { id, cwd, preset, signal: cancel.signal, ...patch }, policy),
  }
  return f
}

test('cold proof accepts four exact initial events and the one native restoration marker, never model changes', async () => {
  const f = fixture()
  assert.deepEqual(await f.verify(), { agent: f.attached(), seq: 5 })
  assert.equal(f.counters.resolve, 1)
  assert.deepEqual(f.counters.reads, [[0, 5], [0, 6]])
  assert.equal(f.counters.opens, 2)
  assert.equal(f.counters.closes, 2)
  assert.equal(f.counters.stat, 4)
})

test('a matching live target uses exact durable checkpoint and permits only the native omitted root depth', async () => {
  const f = fixture()
  const liveHeader = { ...f.header }
  delete liveHeader.delegationDepth
  const agent = f.attach([...f.stored], { liveHeader })
  assert.deepEqual(await f.verify(), { agent, seq: 4 })
  assert.equal(f.counters.resolve, 0)
  assert.deepEqual(f.counters.reads, [[0, 5]])
})

test('rejects mismatching identity, cwd, preset, lineage or invalid header before opening', async () => {
  for (const patch of [
    { cwd: other }, { agentPreset: 'unrelated' }, { id: 'wrong' }, { version: 3 }, { isSeeded: true },
    { origin: 'subagent' }, { parentSession: 'other-id' }, { delegationDepth: 1 }, { createdAt: -1 },
  ]) {
    const f = fixture({ header: patch })
    await assert.rejects(f.verify(), failure())
    assert.equal(f.counters.opens, 0)
    assert.equal(f.counters.resolve, 0)
  }
  for (const patch of [{ id: '../escape' }, { cwd: 'relative' }, { preset: undefined }]) {
    const f = fixture()
    await assert.rejects(f.verify(patch), failure())
    assert.equal(f.counters.stat, 0)
  }
})

test('requires materialized current-format official JSONL with bounded physical size before open', async () => {
  for (const snapshot of [
    { formatStatus: 'migration-required' }, { formatStatus: undefined }, { location: undefined },
    { location: { kind: 'other', path: '/opaque' } }, { revision: '' }, { sizeBytes: 65 * 1024 },
    { sizeBytes: undefined }, { sizeBytes: 0 }, { eventCount: 5 },
  ]) {
    const f = fixture({ snapshot })
    await assert.rejects(f.verify(), failure())
    assert.equal(f.counters.opens, 0)
    assert.equal(f.counters.resolve, 0)
  }
  const absent = fixture({ missing: true })
  await assert.rejects(absent.verify(), failure('recovery-not-found'))
  assert.equal(absent.counters.opens, 0)
})

test('rejects earlier resume markers, turns, inboxes, own-model selections, duplicates and unknown data safely', async () => {
  for (const initial of [
    ['turn/start'], ['agent/inbox/spliced'], ['user/message'], ['assistant/message'], ['model/selection'],
    ['session/end-seed'], ['session/title'], ['permission/preset', 'permission/preset'],
    [...allowed, 'model/selection'],
  ]) {
    const f = fixture({ initial: initial.map((type, seq) => logRecord(type, initialData[0], seq)) })
    await assert.rejects(f.verify(), failure())
    assert.equal(f.counters.opens, 1)
    assert.equal(f.counters.closes, 1)
    assert.equal(f.counters.resolve, 0)
  }
  const event = logRecord('user/message', {}, 0)
  Object.defineProperty(event, 'data', { get() { assert.fail('private body must never be accessed') } })
  let bodyReads = 0
  const body = { ...logRecord('assistant/message', {}, 0), get data() { bodyReads++; return 'private body' } }
  await assert.rejects(fixture({ initial: [event] }).verify(), failure())
  await assert.rejects(fixture({ initial: [body] }).verify(), failure())
  assert.equal(bodyReads, 0)
  for (const data of [{ preset: 'default', text: 'not native metadata' }, { preset: ['not text'] }]) {
    await assert.rejects(fixture({ initial: [logRecord('permission/preset', data, 0)] }).verify(), failure())
  }
})

test('rejects if cold handle disagrees or race changes the artifact before resolving; seals provider errors', async () => {
  for (const handle of [{ id: 'wrong' }, { access: 'write' }, { inheritedEventCount: 1 }, { header: { cwd: other } }]) {
    const f = fixture({ handle })
    await assert.rejects(f.verify(), failure())
    assert.equal(f.counters.closes, 1)
    assert.equal(f.counters.resolve, 0)
  }
  for (const onRead of [
    f => f.bumpRevision(), f => f.attach([...f.stored]),
    f => f.ctx.workspaceRegistry.archivedSessionIds.push(id), f => f.cancel.abort('private cancel detail'),
    () => { throw new Error('secret provider error from body') },
  ]) {
    const f = fixture({ onRead })
    await assert.rejects(f.verify(), failure())
    assert.equal(f.counters.closes, 1)
    assert.equal(f.counters.resolve, 0)
  }
})

test('never activates an already busy, archived, changed or live-only target', async () => {
  for (const change of [
    agent => { agent.status = 'running' }, agent => { agent.turn = 1 },
    agent => { agent.inbox.nextStep.push('queued') },
    (agent, f) => { f.ctx.workspaceRegistry.archivedSessionIds.push(id) },
  ]) {
    const f = fixture()
    change(f.attach([...f.stored]), f)
    await assert.rejects(f.verify(), failure())
    assert.equal(f.counters.stat, 0)
    assert.equal(f.counters.resolve, 0)
  }
  const missingLive = fixture({ missing: true })
  missingLive.attach([...missingLive.stored])
  await assert.rejects(missingLive.verify(), failure())
  const staleLive = fixture()
  const events = [...staleLive.stored]
  events[0] = { ...events[0], data: { preset: 'different-local-policy' } }
  staleLive.attach(events)
  await assert.rejects(staleLive.verify(), failure())
  const replaced = fixture({ onRead(f) { f.attach([...f.stored]) } })
  replaced.attach([...replaced.stored])
  await assert.rejects(replaced.verify(), failure())
  assert.equal(replaced.counters.resolve, 0)
})

test('rejects native refusal, wrong marker, replaced registry, or changed live sequence after resume', async () => {
  for (const resolve of [
    () => ({ error: new Error('private model or title') }),
    f => ({ agent: f.attach([...f.stored], { firstLiveSeq: 4 }) }),
    f => {
      const { stored } = f
      f.bumpRevision()
      const marker = logRecord('session/end-seed', { inherited: true }, stored.length)
      stored.push(marker)
      return { agent: f.attach([...stored], { firstLiveSeq: 4 }) }
    },
    f => ({ agent: { ...f.attach([...f.stored, f.marker(4)], { firstLiveSeq: 4 }) } }),
    f => ({ agent: f.attach([...f.stored, f.marker(4)], { firstLiveSeq: 4 }) }), // marker not durable
  ]) {
    const f = fixture({ resolve })
    await assert.rejects(f.verify(), failure())
    assert.equal(f.counters.resolve, 1)
  }
  const f = fixture({ onStat(race) {
    if (race.counters.stat === 4) race.attached().inbox.nextTurn.push('raced input')
  } })
  await assert.rejects(f.verify(), failure())
  assert.equal(f.counters.resolve, 1)
})
