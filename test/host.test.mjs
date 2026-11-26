import test from 'node:test'
import assert from 'node:assert/strict'
import { installRouterHost, inject } from '../src/host/index.mjs'
import { limits, routerAgentRemoteContribution } from '../src/host/contract.mjs'

const route = { provider: 'deepseek', model: 'model-a' }
const otherRoute = { provider: 'deepseek', model: 'model-b' }
const cwd = process.platform === 'win32' ? 'C:\project' : '/project'
const nextCwd = process.platform === 'win32' ? 'C:\other' : '/other'
const textRequest = () => ({ ...route, system: 'Triage', user: 'private task' })
const creation = (requestId = 'ra-task-1') => ({ requestId, cwd })

function deferred() {
  let resolve, reject
  const promise = new Promise((yes, no) => { resolve = yes; reject = no })
  return { resolve, reject, promise }
}

function code(expected) {
  return error => {
    assert.equal(error.code, expected)
    assert.ok(error.isDSHRemoteError)
    return true
  }
}

async function* successfulStream() {
  yield { type: 'block-start', index: 0, blockType: 'reasoning' }
  yield { type: 'reasoning-delta', index: 0, text: 'not client visible' }
  yield { type: 'block-end', index: 0, block: { type: 'reasoning', text: 'not client visible' } }
  yield { type: 'block-start', index: 1, blockType: 'text' }
  yield { type: 'text-delta', index: 1, text: 'routed' }
  yield { type: 'block-end', index: 1, block: { type: 'text', text: 'routed' } }
  yield { type: 'finish', reason: { kind: 'stop' } }
}

class RemoteError extends Error {
  isDSHRemoteError = true
  constructor(code, message, details) {
    super(message)
    this.code = code
    this.details = details
  }
}

function agentFor(id, cwd, preset) {
  const events = []
  const session = {
    id, header: { id, isSeeded: false, cwd, agentPreset: preset }, seq: 0,
    eventAt(offset) { return events[offset] },
    append(type) { events[this.seq++] = { type } },
  }
  const agent = {
    id,
    session,
    status: 'idle',
    inbox: { nextTurn: [], nextStep: [] },
    turn: 0,
    inMaintenance: false,
    selections: [],
    model: {
      select(selection) {
        assert.ok(agent.inMaintenance)
        agent.selections.push({ ...selection })
        session.seq++
      },
    },
    async runMaintenance(operation) {
      if (agent.status !== 'idle' || agent.inMaintenance) throw Error('busy')
      agent.inMaintenance = true
      try { return await operation(new AbortController().signal) }
      finally { agent.inMaintenance = false }
    },
  }
  return agent
}

async function mount(options = {}) {
  const agents = new Map()
  const stored = options.stored ?? new Map()
  const known = new Map()
  const calls = {
    prepared: [], modelInfo: [], streams: [], create: [], flush: [], attached: [], defaults: [],
    presetMount: [], presetResolve: [], registered: [], disposed: [], installs: [],
  }
  const workspace = {
    path: cwd,
    async attachSession(id) {
      assert.ok(stored.get(id)?.location)
      if (options.attach) await options.attach(id)
      calls.attached.push(id)
    },
  }
  const ctx = {
    typert: { register(c) { calls.registered.push(c) } },
    effect(operation) { calls.disposed.push(operation()) },
    llm: {
      listProviders() { return [{ id: route.provider }] },
      async listModels(provider) {
        return [route.model, otherRoute.model].map(id => ({ id, provider }))
      },
      async resolveCallConfig(config, signal) {
        calls.modelInfo.push({ config, signal })
        if (options.validate) await options.validate(config, signal)
        if (config.reasoningEffort !== undefined && config.reasoningEffort !== 'high') {
          throw Error('secret API detail')
        }
        return { ...config, reasoningEffort: config.reasoningEffort ?? 'adapter-default' }
      },
      async prepareCall(config, signal) {
        calls.prepared.push(config)
        const valid = await this.resolveCallConfig(config, signal)
        return {
          config: valid,
          stream(request) {
            calls.streams.push(request)
            return (options.stream ?? successfulStream)(request)
          },
        }
      },
    },
    sessions: {
      get: id => known.get(id),
      async flush(session) {
        calls.flush.push(session.id)
        if (options.flush) await options.flush(session)
        stored.set(session.id, { header: session.header, location: { kind: 'test' } })
        return true
      },
    },
    sessionPersistence: { async stat(id) { return stored.get(id) } },
    agents: {
      get: id => agents.get(id),
      turnBoundaryOf: session => ({ lastTurn: agents.get(session.id)?.turn ?? 0, openTurnStartSeq: null }),
      async create(spec) {
        calls.create.push(spec)
        if (agents.has(spec.sessionId) || stored.has(spec.sessionId)) throw new Error('already exists')
        if (options.createBarrier) await options.createBarrier.promise
        const agent = agentFor(spec.sessionId, spec.meta.cwd, spec.meta.agentPreset)
        known.set(agent.id, agent.session)
        await spec.setup({ name: 'pending agent ctx' }, agent)
        // AgentLoop announces agent/created after setup, before returning.
        for (const type of options.initialEvents ?? ['permission/preset', 'sandbox/mode', 'approval/policy','subagent/model-selection-policy']) {
          agent.session.append(type)
        }
        agents.set(agent.id, agent)
        return { agent }
      },
    },
    agentDefaultModel: {
      currentSelection() { return { provider: 'global', model: 'default' } },
      saveSelection(selection) { calls.defaults.push(selection); throw Error('No global writes allowed') },
    },
    workingDirectory: { defaultDirectory: nextCwd },
    workspaceRegistry: {
      archivedSessionIds: [],
      get(id) { return id === 'workspace' ? workspace : undefined },
      async resolveByPath(path) { return options.workspace || path === cwd ? workspace : undefined },
    },
    get logger() { throw Error('No logger should be used') },
  }
  let service
  class TypertRemoteService {
    constructor(appCtx, key) {
      assert.equal(appCtx, ctx)
      assert.equal(key, 'routerAgent')
      service = this
    }
  }
  ctx.agentPresets = {
    async resolve(id) {
      calls.presetResolve.push(id)
      const wanted = id ?? options.defaultPreset ?? 'standard'
      if (!(options.availablePresets ?? ['standard', 'ptc']).includes(wanted)) throw Error('unavailable preset details')
      return { id: wanted }
    },
    async mount(agentCtx, id) { calls.presetMount.push([agentCtx, id]); return { id } },
  }
  await installRouterHost(ctx, {
    TypertRemoteService,
    RemoteError,
    installModelSelection(agentCtx) { calls.installs.push(agentCtx) },
    async statDirectory() { return { isDirectory: () => true } },
    testTimeoutMs: options.timeoutMs,
  }, options.config)

  function call(method, request, opts = {}) {
    const scoped = Object.create(service)
    const signal = opts.signal ?? new AbortController().signal
    scoped.ctx = {
      invocation: opts.direct ? undefined : {
        service: 'routerAgent',
        request: { namespace: 'routerAgent', method },
        peer: { principal: { kind: opts.principal ?? 'owner' }, signal: opts.peerSignal },
        signal,
      },
    }
    return scoped[method](request, signal)
  }
  return { ctx, call, known, agents, stored, calls }
}

test('registers the same complete strict Typert descriptors on Host and Client', async () => {
  const { calls } = await mount()
  assert.ok(inject.includes('typert'))
  assert.equal(calls.registered.length, 1)
  assert.equal(calls.registered[0].face, 'host')
  assert.equal(calls.registered[0].invocations, routerAgentRemoteContribution.descriptors)
  const [infer, create, configure, recover] = routerAgentRemoteContribution.descriptors
  assert.deepEqual([infer.method, create.method, configure.method, recover.method], ['infer', 'create', 'configure', 'recoverEmpty'])
  assert.throws(()=>recover.parameters[0].codec.create().parse({requestId:'made-up',sessionId:'session-router-agent-made-up',cwd}))
  assert.throws(()=>recover.result.decode({sessionId:'session-test',cursor:-2}))
  assert.equal(infer.parameters[0].wire, 'request')
  assert.equal(infer.parameters[0].codec.mode, 'strict')
  assert.deepEqual(infer.parameters[0].codec.create().parse(textRequest()), textRequest())
  assert.throws(() => infer.parameters[0].codec.create().parse({ request: textRequest() }))
  assert.throws(() => configure.result.decode({ ok: false }))
  assert.deepEqual(create.result.decode({ sessionId: 'session-example' }), { sessionId: 'session-example' })
})

test('all methods require a real owner invocation, not a request field or in-process bypass', async () => {
  const { call, calls } = await mount()
  for (const [method, request] of [['infer', textRequest()], ['create', creation()], ['configure', { sessionId: 'forged', ...route }], ['recoverEmpty',{requestId:'x',sessionId:'x',cwd}]]) {
    await assert.rejects(call(method, { ...request, principal: 'owner' }, { principal: 'share-link' }), code('remote-access/denied'))
    await assert.rejects(call(method, request, { direct: true }), code('remote-access/denied'))
    await assert.rejects(call(method, request, { peerSignal: AbortSignal.abort() }), code('remote-access/denied'))
  }
  assert.deepEqual(calls.streams, [])
  assert.deepEqual(calls.create, [])
  assert.deepEqual(calls.modelInfo, [])
})

test('inference dispatches once with bounded pure text, no caller context or tools', async () => {
  const { call, calls } = await mount()
  const input = { ...textRequest(), effort: 'high' }
  assert.deepEqual(await call('infer', input), { text: 'routed' })
  assert.equal(calls.streams.length, 1)
  assert.deepEqual(calls.prepared, [{ ...route, maxTokens: limits.outputTokens, reasoningEffort: 'high' }])
  const { signal, ...actual } = calls.streams[0]
  assert.ok(signal instanceof AbortSignal)
  assert.deepEqual(actual, {
    ...route, system: input.system, maxTokens: limits.outputTokens, reasoningEffort: 'high', tools: [],
    messages: [{ role: 'user', content: [{ type: 'text', text: input.user }] }],
  })
  assert.deepEqual(calls.create, [])
  assert.deepEqual(calls.flush, [])
})

test('denies wrong routes, disallowed routes, unsupported efforts and non-text inputs before dispatch', async () => {
  const { call, calls } = await mount({ config: { allowedModels: [route] } })
  for (const patch of [{ model: 'unlisted' }, { provider: 'not-mounted' }, otherRoute, { effort: 'very-high' }]) {
    await assert.rejects(call('infer', { ...textRequest(), ...patch }), error => {
      assert.ok(code('router-agent/model-unavailable')(error))
      assert.doesNotMatch(error.message, /secret|very-high|private/)
      return true
    })
  }
  for (const patch of [
    { tools: [] }, { sessionId: 'old' }, { user: ['not text'] }, { system: '测'.repeat(limits.systemBytes / 2) },
    { user: 'x'.repeat(limits.userBytes + 1) },
  ]) await assert.rejects(call('infer', { ...textRequest(), ...patch }), code('router-agent/invalid-request'))
  assert.equal(calls.streams.length, 0)
})

test('fails closed for tools, overlong output, truncated output and adapter errors', async () => {
  const cases = [
    [async function* () { yield { type: 'tool-call-delta', name: 'shell' } }, 'output-invalid'],
    [async function* () { yield { type: 'text-delta', text: '测'.repeat(limits.outputBytes) } }, 'output-invalid'],
    [async function* () { yield { type: 'finish', reason: { kind: 'max-tokens' } } }, 'output-invalid'],
    [async function* () { yield { type: 'block-end', block: { type: 'text', text: 'partial' } } }, 'output-invalid'],
    [async function* () { throw new Error('prompt or credential') }, 'inference-failed'],
  ]
  for (const [stream, expected] of cases) {
    const { call, calls } = await mount({ stream })
    await assert.rejects(call('infer', textRequest()), error => {
      assert.ok(code('router-agent/' + expected)(error))
      assert.doesNotMatch(error.message, /prompt|credential|private/)
      return true
    })
    assert.equal(calls.streams.length, 1)
  }
})

test('timeouts and disconnects abort, retain the two real-work slots until settled and never retry', async () => {
  const barrier = deferred()
  const ready = deferred()
  let streams = 0
  const { call, calls } = await mount({ timeoutMs: 70, async *stream() {
    if (++streams === 2) ready.resolve()
    await barrier.promise // Simulate a provider that ignores cancellation for a while.
    yield* successfulStream()
  } })
  const cancel = new AbortController()
  const one = assert.rejects(call('infer', textRequest(), { signal: cancel.signal }), code('router-agent/cancelled'))
  const two = assert.rejects(call('infer', textRequest()), code('router-agent/timeout'))
  await ready.promise
  await assert.rejects(call('infer', textRequest()), code('router-agent/busy'))
  cancel.abort()
  await Promise.all([one, two])
  assert.ok(calls.streams.every(({ signal }) => signal.aborted))
  await assert.rejects(call('infer', textRequest()), code('router-agent/busy'))
  barrier.resolve()
  await new Promise(resolve => setImmediate(resolve))
  assert.deepEqual(await call('infer', textRequest()), { text: 'routed' })
  assert.equal(calls.streams.length, 3)
})

test('creation is durable, create-only and coalesces identical keys including a disconnected client', async () => {
  const barrier = deferred()
  const { call, calls, agents, stored } = await mount({ createBarrier: barrier })
  const cancel = new AbortController()
  const one = call('create', creation(), { signal: cancel.signal })
  const two = call('create', creation())
  cancel.abort()
  await assert.rejects(call('create', { ...creation(), cwd: nextCwd }), code('router-agent/creation-conflict'))
  barrier.resolve()
  const result = await one
  assert.deepEqual(await two, result)
  assert.deepEqual(await call('create', creation()), result)
  assert.equal(calls.create.length, 1)
  assert.equal(agents.size, 1)
  assert.ok(stored.get(result.sessionId)?.location)
  assert.equal(calls.installs.length, 1)
  assert.equal(calls.presetMount[0][1], 'standard')
  assert.deepEqual(calls.attached, [result.sessionId])
  assert.deepEqual(calls.defaults, [])
  assert.deepEqual(calls.streams, [])
  assert.equal(calls.create[0].agentOptions.provider, 'global')
})

test('under a PTC desktop default, pin only explicit new tasks; inherit, duplicates and the global default stay unchanged', async () => {
  const { ctx, call, calls, agents, stored } = await mount({ defaultPreset: 'ptc' })
  for (const [key, asked, expected] of [['regular', 'standard', 'standard'], ['follow', undefined, 'ptc'], ['ptc', 'ptc', 'ptc']]) {
    const request = { ...creation('ra-' + key), ...(asked === undefined ? {} : { agentPreset: asked }) }
    const receipt = await call('create', request)
    assert.deepEqual(await call('create', request), receipt)
    assert.equal(agents.get(receipt.sessionId).session.header.agentPreset, expected)
    assert.equal(stored.get(receipt.sessionId).header.agentPreset, expected)
  }
  assert.deepEqual(calls.presetResolve, ['standard', undefined, 'ptc'])
  assert.deepEqual(calls.presetMount.map(([, id]) => id), ['standard', 'ptc', 'ptc'])
  await assert.rejects(call('create', { ...creation('ra-regular'), agentPreset: 'ptc' }), code('router-agent/creation-conflict'))
  assert.equal((await ctx.agentPresets.resolve()).id, 'ptc')
  assert.deepEqual(calls.defaults, [])
  // Following the Host may also mean a healthy, user-installed non-built-in id.
  const custom = await mount({ defaultPreset: 'local-mode', availablePresets: ['local-mode'] })
  const followed = await custom.call('create', creation('ra-follow-custom'))
  assert.equal(custom.stored.get(followed.sessionId).header.agentPreset, 'local-mode')
})

test('missing, broken, invalid or substituted explicit preset never falls back to PTC', async () => {
  for (const [kind, phase] of [['missing', 'resolve'], ['broken', 'resolve'], ['another-id', 'resolve'],
    ['empty-id', 'resolve'], ['another-id', 'mount'], ['exception', 'mount']]) {
    const { ctx, call, calls } = await mount({ defaultPreset: 'ptc', availablePresets: kind === 'missing' ? ['ptc'] : ['standard', 'ptc'] })
    if (kind !== 'missing') ctx.agentPresets[phase] = async (...args) => {
      assert.equal(args.at(-1), 'standard')
      if (kind === 'exception') throw Error('private details')
      if (kind === 'broken') return { id: 'standard', broken: 'private details' }
      return { id: kind === 'empty-id' ? '' : 'ptc' }
    }
    const request = { ...creation(), agentPreset: 'standard' }
    await assert.rejects(call('create', request), e => {
      assert.doesNotMatch(e.message, /private details|unavailable preset details/)
      return code('router-agent/preset-unavailable')(e)
    })
    if (phase === 'resolve') assert.deepEqual(calls.create, [])
    await assert.rejects(call('configure', { sessionId: 'session-router-agent-' + request.requestId, ...route }), code('router-agent/not-owned'))
    assert.deepEqual(calls.flush, []); assert.deepEqual(calls.defaults, []); assert.deepEqual(calls.streams, [])
  }
})

test('a contradictory live or durable preset header is never a create/configure receipt', async () => {
  for (const phase of ['live', 'persisted']) {
    const { ctx, call, calls, agents } = await mount({ defaultPreset: 'ptc' })
    if (phase === 'live') {
      const nativeCreate = ctx.agents.create.bind(ctx.agents)
      ctx.agents.create = async spec => {
        const result = await nativeCreate(spec)
        result.agent.session.header.agentPreset = 'ptc'
        return result
      }
    } else {
      const nativeStat = ctx.sessionPersistence.stat.bind(ctx.sessionPersistence)
      ctx.sessionPersistence.stat = async (...args) => {
        const recorded = await nativeStat(...args)
        return recorded && { ...recorded, header: { ...recorded.header, agentPreset: 'ptc' } }
      }
    }
    await assert.rejects(call('create', { ...creation(), agentPreset: 'standard' }),
      code('router-agent/' + (phase === 'live' ? 'create-state-changed' : 'persistence-unconfirmed')))
    const [agent] = agents.values()
    await assert.rejects(call('configure', { sessionId: agent.id, ...route }), code('router-agent/not-owned'))
    assert.deepEqual(agent.selections, []); assert.deepEqual(calls.attached, [])
  }
})

test('initial permission metadata is compatible but no unknown, duplicated or work event can become the baseline', async () => {
  for (const initialEvents of [[], ['permission/preset', 'sandbox/mode', 'approval/policy'], ['permission/preset', 'sandbox/mode', 'approval/policy','subagent/model-selection-policy']]) {
    const { call } = await mount({ initialEvents })
    const result = await call('create', creation())
    assert.deepEqual(await call('configure', { ...result, ...route }), { ok: true })
  }
  for (const initialEvents of [['agent/inbox/spliced'], ['user/message'], ['goal/change'], ['permission/preset', 'permission/preset'], ['subagent/model-selection-policy','subagent/model-selection-policy'], ['permission/preset','sandbox/mode','approval/policy','subagent/model-selection-policy','user/message']]) {
    const { call } = await mount({ initialEvents })
    await assert.rejects(call('create', creation()), code('router-agent/initial-state-unsupported'))
  }
})

test('temporary flush or workspace attach failure keeps the exact unpublished receipt; retries never allocate again', async () => {
  for (const [phase,expected] of [['flush','persistence-unconfirmed'],['attach','workspace-attach-failed']]) {
    let callsToPhase=0
    const {call,calls,agents}=await mount({[phase]:async()=>{if(!callsToPhase++) throw Error('private path and cause')}})
    await assert.rejects(call('create',creation()),code('router-agent/'+expected))
    const [id]=agents.keys()
    await assert.rejects(call('configure',{sessionId:id,...route}),code('router-agent/not-owned'))
    const recovered=await call('create',creation()); assert.equal(recovered.sessionId,id)
    assert.equal(calls.create.length,1); assert.equal(calls.attached.length,1); assert.deepEqual(calls.defaults,[])
  }
})
test('pending persistence cannot be finalized on an agent that acquired work',async()=>{
  const {call,calls,agents}=await mount({flush:async()=>{throw Error('unavailable')}})
  await assert.rejects(call('create',creation()),code('router-agent/persistence-unconfirmed'))
  const [agent]=agents.values();agent.session.append('user/message')
  await assert.rejects(call('create',creation()),code('router-agent/create-state-changed'))
  await assert.rejects(call('configure',{sessionId:agent.id,...route}),code('router-agent/not-owned'));assert.equal(calls.create.length,1)
})

test('negative-only probe checks both registries and persistence; never opens, allocates or claims even on a race',async()=>{
  const {ctx,call,calls,stored}=await mount();const requestId='ra-12345678-1234-4abc-8abc-123456789abc',id='session-router-agent-'+requestId;
  const req={requestId,cwd,sessionId:id,checkMissingOnly:true};let opens=0;ctx.sessionPersistence.open=ctx.sessionController=()=>{opens++;throw Error()};
  await assert.rejects(call('recoverEmpty',req),code('router-agent/recovery-not-found'));
  stored.set(id,{header:{id,cwd},location:{kind:'test'}});await assert.rejects(call('recoverEmpty',req),code('router-agent/recovery-unsafe'));
  stored.clear();ctx.workspaceRegistry.archivedSessionIds.push(id);await assert.rejects(call('recoverEmpty',req),code('router-agent/recovery-unsafe'));
  await assert.rejects(call('recoverEmpty',req,{principal:'share-link'}),code('remote-access/denied'));
  assert.equal(opens,0);assert.equal(calls.create.length,0);assert.deepEqual(calls.presetMount,[]);
});
// Only a synthetic empty v4 artifact. Recovery must not use a new-session
// preference or obtain model/configuration rights even if the Host default changed.
async function legacyModeFixture(original, { live = false, bound = original, availablePresets } = {}) {
  const defaultPreset = original === 'standard' ? 'ptc' : 'standard'
  const host = await mount({ defaultPreset, availablePresets })
  const { ctx, known, agents } = host
  const requestId = 'ra-12345678-1234-4abc-8abc-123456789abc'
  const id = 'session-router-agent-' + requestId
  const request = { requestId, sessionId: id, cwd }
  const agent = agentFor(id, cwd, original)
  Object.assign(agent.session.header, { version: 4, createdAt: 1, delegationDepth: 0 })
  const rows = [], counts = { opens: 0, resumes: 0 }
  agent.ctx = {}; agent.session.inheritedEventCount = 0; agent.session.firstLiveSeq = 0
  agent.session.eventAt = index => rows[index]
  const publish = () => { agents.set(id, agent); known.set(id, agent.session) }
  if (live) publish()
  ctx.sessionPersistence = {
    stat: async () => ({ header: { ...agent.session.header }, formatStatus: 'current', revision: 'r' + rows.length,
      location: { kind: 'jsonl', path: '/synthetic/empty' }, eventCount: rows.length, sizeBytes: 100 + 30 * rows.length }),
    async open(key, access) {
      assert.equal(key, id); assert.equal(access, 'read'); counts.opens++
      return { id, access, header: { ...agent.session.header }, inheritedEventCount: 0,
        read: async (offset, limit) => ({ events: rows.slice(offset, offset + limit) }), close() {} }
    },
  }
  ctx.sessionController = { async resolveAgent(key) {
    assert.equal(key, id); assert.equal(agents.has(id), false); counts.resumes++
    rows.push({ type: 'session/end-seed', seq: 0, time: 2, data: {} }); agent.session.seq = rows.length
    publish(); return { agent }
  } }
  ctx.agentPresets.composedPreset = agentCtx => { assert.equal(agentCtx, agent.ctx); return bound }
  return { ...host, agent, request, rows, counts, defaultPreset }
}

test('legacy live and cold recovery pin the original recorded preset despite a different current default', async () => {
  for (const [original, live] of [['ptc', false], ['standard', true]]) {
    const { ctx, call, calls, agent, request, counts, rows, defaultPreset } = await legacyModeFixture(original, { live })
    const receipt = { sessionId: request.sessionId, cursor: live ? -1 : 0 }
    assert.deepEqual(await call('recoverEmpty', request), receipt)
    assert.deepEqual(await call('recoverEmpty', request), receipt)
    assert.deepEqual(calls.presetResolve, [original, original])
    assert.equal((await ctx.agentPresets.resolve()).id, defaultPreset)
    assert.equal(agent.session.header.agentPreset, original)
    assert.deepEqual(rows.map(e => e.type), live ? [] : ['session/end-seed'])
    assert.equal(counts.resumes, live ? 0 : 1)
    await assert.rejects(call('configure', { sessionId: request.sessionId, ...route }), code('router-agent/not-owned'))
    assert.deepEqual(agent.selections, []); assert.deepEqual(calls.presetMount, []); assert.deepEqual(calls.create, [])
  }
})

test('legacy recovery never substitutes a default for a missing, unavailable, or contradictory original mode', async () => {
  for (const [original, opts, expected, opened] of [
    [undefined, {}, 'recovery-unsafe', 0], ['ptc', { availablePresets: ['standard'] }, 'preset-unavailable', 0],
    ['standard', { live: true, bound: 'ptc' }, 'recovery-unsafe', 1],
  ]) {
    const { call, calls, agent, request, counts } = await legacyModeFixture(original, opts)
    await assert.rejects(call('recoverEmpty', request), code('router-agent/' + expected))
    assert.equal(counts.opens, opened); assert.equal(counts.resumes, 0)
    assert.equal(calls.presetResolve.includes(undefined), false)
    assert.deepEqual(calls.presetMount, []); assert.deepEqual(agent.selections, []); assert.deepEqual(calls.create, [])
  }
})

test('rejects pre-existing collision and restart without modifying or claiming another session', async () => {
  const first = await mount()
  const result = await first.call('create', creation())
  const restarted = await mount({ stored: first.stored })
  await assert.rejects(restarted.call('create', creation()), code('router-agent/creation-uncertain'))
  await assert.rejects(restarted.call('configure', { ...result, ...route }), code('router-agent/not-owned'))
  assert.equal(restarted.calls.create.length, 0)
  const old = agentFor('historical-session', cwd, 'standard')
  first.agents.set(old.id, old)
  first.known.set(old.id, old.session)
  await assert.rejects(first.call('configure', { sessionId: old.id, ...route }), code('router-agent/not-owned'))
  assert.deepEqual(old.selections, [])
})

test('configures exactly one route with local persistence but no global setting changes', async () => {
  const { call, calls, agents } = await mount()
  const result = await call('create', { requestId: 'ra-explicit', workspaceId: 'workspace', agentPreset: 'ptc' })
  const configure = { ...result, ...otherRoute, effort: 'high' }
  assert.deepEqual(await call('configure', configure), { ok: true })
  assert.deepEqual(await call('configure', configure), { ok: true })
  await assert.rejects(call('configure', { ...result, ...route }), code('router-agent/configuration-conflict'))
  assert.deepEqual(calls.defaults, [])
  assert.equal(calls.streams.length, 0)
  const agent = agents.get(result.sessionId)
  assert.deepEqual(agent.selections, [{ ...otherRoute, reasoningEffort: 'high' }])
  assert.ok(calls.flush.length >= 2)
  const omitted = await call('create', creation('ra-implicit'))
  assert.deepEqual(await call('configure', { ...omitted, ...route }), { ok: true })
  assert.deepEqual(agents.get(omitted.sessionId).selections, [route])
})

test('refuses configuration for historical activity, queued input, replaced or archived agents', async () => {
  const { call, ctx, known, agents } = await mount()
  const cases = [
    [agent => { agent.status = 'running' }, 'not-blank'],
    [agent => { agent.inbox.nextTurn.push('queued') }, 'not-blank'],
    [agent => { agent.inbox.nextStep.push('steered') }, 'not-blank'],
    [agent => { agent.turn = 1 }, 'not-blank'],
    [agent => { agent.session.seq += 2 }, 'not-blank'],
    [agent => { agent.session.header.agentPreset = 'ptc' }, 'not-blank'],
    [agent => { ctx.workspaceRegistry.archivedSessionIds.push(agent.id) }, 'not-blank'],
    [agent => { const replacement = agentFor(agent.id, cwd, 'standard'); agents.set(agent.id, replacement); known.set(agent.id, replacement.session) }, 'not-owned'],
  ]
  for (let index = 0; index < cases.length; ++index) {
    const [change, expected] = cases[index]
    const result = await call('create', creation('ra-ineligible-' + index))
    const target = agents.get(result.sessionId)
    change(target)
    await assert.rejects(call('configure', { ...result, ...route }), code('router-agent/' + expected))
    assert.deepEqual(target.selections, [])
  }
})

test('rechecks blankness after async model validation; failed or raced validations never select', async () => {
  const validating = deferred()
  const barrier = deferred()
  const { call, agents } = await mount({ async validate(config) {
    if (config.reasoningEffort === 'high') {
      validating.resolve()
      await barrier.promise
    }
  } })
  const result = await call('create', creation())
  await assert.rejects(call('configure', { ...result, ...route, effort: 'bad' }), code('router-agent/model-unavailable'))
  const raced = assert.rejects(call('configure', { ...result, ...route, effort: 'high' }), code('router-agent/not-blank'))
  await validating.promise
  const target = agents.get(result.sessionId)
  target.session.seq++ // Inbox admission even if the owner discards it before the check.
  barrier.resolve()
  await raced
  assert.deepEqual(target.selections, [])
})
