import { isAbsolute, normalize, parse as parsePath } from 'node:path'
import { stat } from 'node:fs/promises'
import { verifyRecoverableEmpty } from './recover-empty.mjs'
import {
  byteLength, limits, namespace, parseAgentPresetId, parseConfigure, parseCreate, parseInfer, parseRecoverEmpty, routerAgentHostContribution,
} from './contract.mjs'

export const name = 'router-agent-host'
export const inject = Object.freeze([
  'typert', 'llm', 'agents', 'sessions', 'sessionPersistence',
  'agentDefaultModel', 'agentPresets', 'workingDirectory', 'workspaceRegistry', 'sessionController',
])

const creationPrefix = 'session-router-agent-'
const maxStreamEvents = 32768
const maxCreationsInFlight = 4
const errorMessages = Object.freeze({
  'invalid-request': 'Invalid router-agent request.',
  'model-unavailable': 'The requested model or reasoning effort is not available to this router.',
  'inference-failed': 'The router model request failed.',
  'output-invalid': 'The router model did not return complete, bounded text.',
  'timeout': 'The router operation timed out.',
  'cancelled': 'The router operation was cancelled.',
  'busy': 'The router is at capacity. Try again later.',
  'creation-conflict': 'This creation key was already used with different settings.',
  'creation-uncertain': 'This session identity already exists without a current router creation receipt. Check it manually.',
  'create-failed': '宿主未能完成会话分配，尚未投递；请保留本项的原创建键。',
  'initial-state-unsupported': '新会话含有无法确认为初始化的活动。已停止，未选模或投递。',
  'create-state-changed': '新会话的身份、目录或空白状态发生了变化，未投递。',
  'persistence-unconfirmed': '新会话的持久化回执尚未确认。未投递，请保留原分项。',
  'workspace-attach-failed': '会话已经落盘，但尚未完成工作区绑定。请只重试本项，不要重新提交。',
  'recovery-unsafe': '未能证明这是指定目录中保持原预设、未经使用的空会话。不会接回、改模型或发消息。',
  'recovery-not-found': '未找到这项指定的持久空会话；没有新建或投递。',
  'directory-unavailable': 'The router could not use the requested directory or workspace.',
  'preset-unavailable': '指定的 Agent 预设不存在、加载失败或无法核实；不会改用其他模式。',
  'not-owned': 'Only sessions created by this router in the current host instance can be configured.',
  'not-blank': 'The router session is no longer untouched and idle.',
  'configuration-conflict': 'This new session has already been configured with a different model.',
  'configure-failed': 'The router could not confirm the model selection on the new session.',
})

function errorFactory(RemoteError) {
  const safe = new WeakSet()
  function make(code) {
    const error = new RemoteError('router-agent/' + code, errorMessages[code], {})
    safe.add(error)
    return error
  }
  return {
    make,
    async guard(code, operation) {
      try { return await operation() }
      catch (error) {
        if (safe.has(error)) throw error
        // Adapter and storage exceptions can contain auth headers, prompts or paths.
        throw make(code)
      }
    },
  }
}

function requireOwner(callCtx, method, RemoteError) {
  const invocation = callCtx.invocation
  // Gateway-authenticated Peer, not the payload, a cookie value, or an HTTP header.
  if (invocation?.peer?.principal?.kind !== 'owner' || invocation.peer.signal?.aborted
    || invocation.service !== namespace || invocation.request?.namespace !== namespace
    || invocation.request?.method !== method) {
    const action = namespace + '/' + method
    throw new RemoteError('remote-access/denied', 'This router operation is owner-only.', { action, reason: 'owner-required' })
  }
  return invocation.signal
}

function parsed(parse, request, error) {
  try { return parse(request) } catch { throw error('invalid-request') }
}

function selectionOf({ provider, model, effort }) {
  return { provider, model, ...(effort === undefined ? {} : { reasoningEffort: effort }) }
}

function sameSelection(left, right) {
  return left?.provider === right.provider && left.model === right.model
    && left.reasoningEffort === right.reasoningEffort
}

function routeKey({ provider, model }) { return JSON.stringify([provider, model]) }

function allowedRoutes(config) {
  if (config?.allowedModels === undefined) return undefined
  if (!Array.isArray(config.allowedModels) || config.allowedModels.length > 512) {
    throw new TypeError('router-agent allowedModels must be an array of provider/model pairs')
  }
  const keys = new Set()
  for (const entry of config.allowedModels) {
    if (entry === null || typeof entry !== 'object' || Object.keys(entry).length !== 2) {
      throw new TypeError('router-agent allowedModels must contain only provider/model pairs')
    }
    const route = parseInfer({ system: 'x', user: 'x', provider: entry.provider, model: entry.model })
    keys.add(routeKey(route))
  }
  return keys
}

function checkSignal(signal, error) {
  if (signal?.aborted) throw error('cancelled')
}

// The caller can time out even if an adapter ignores abort, but the slot is
// retained until the real operation settles. No retry starts another model call.
async function bounded(error, ms, signals, operation, settled = () => {}) {
  const timeout = new AbortController()
  const timer = setTimeout(() => timeout.abort(), ms)
  const signal = AbortSignal.any([...signals.filter(Boolean), timeout.signal])
  const task = Promise.resolve().then(() => {
    checkSignal(signal, error)
    return operation(signal)
  }).finally(settled)
  let onAbort
  const cancelled = new Promise((_, reject) => {
    onAbort = () => reject(error(timeout.signal.aborted ? 'timeout' : 'cancelled'))
    if (signal.aborted) onAbort()
    else signal.addEventListener('abort', onAbort, { once: true })
  })
  try { return await Promise.race([cancelled, task]) }
  finally {
    clearTimeout(timer)
    signal.removeEventListener('abort', onAbort)
  }
}

async function checkCatalog(ctx, routes, selection, signal, error) {
  if (routes !== undefined && !routes.has(routeKey(selection))) throw error('model-unavailable')
  if (!ctx.llm.listProviders().some(provider => provider.id === selection.provider)) throw error('model-unavailable')
  checkSignal(signal, error)
  // The core LLM runtime can route to a model absent from the catalog; the router cannot.
  const models = await ctx.llm.listModels(selection.provider)
  checkSignal(signal, error)
  if (!models.some(model => model.id === selection.model && model.provider === selection.provider)) {
    throw error('model-unavailable')
  }
}

async function oneTextResponse(call, request, signal, error) {
  const selection = selectionOf(request)
  const exact = call.config
  if (exact.provider !== selection.provider || exact.model !== selection.model
    || (selection.reasoningEffort !== undefined && selection.reasoningEffort !== exact.reasoningEffort)
    || exact.maxTokens !== limits.outputTokens) throw error('model-unavailable')
  const stream = call.stream({
    ...exact,
    system: request.system,
    messages: [{ role: 'user', content: [{ type: 'text', text: request.user }] }],
    tools: [],
    signal,
  })
  const text = []
  let bytes = 0
  let textDeltas = 0
  let reasoningDeltas = 0
  let events = 0
  let finished = false
  const charge = (amount, value) => {
    if (typeof value !== 'string' || value.length > limits.outputBytes) throw error('output-invalid')
    const total = amount + byteLength(value)
    if (total > limits.outputBytes) throw error('output-invalid')
    return total
  }
  for await (const chunk of stream) {
    checkSignal(signal, error)
    if (++events > maxStreamEvents || finished || chunk === null || typeof chunk !== 'object') throw error('output-invalid')
    switch (chunk.type) {
      case 'block-start':
        if (chunk.blockType !== 'text' && chunk.blockType !== 'reasoning') throw error('output-invalid')
        break
      case 'text-delta':
        textDeltas = charge(textDeltas, chunk.text)
        break
      case 'reasoning-delta':
        reasoningDeltas = charge(reasoningDeltas, chunk.text)
        break
      case 'block-end':
        if (chunk.block?.type === 'text') {
          bytes = charge(bytes, chunk.block.text)
          text.push(chunk.block.text)
        } else if (chunk.block?.type === 'reasoning') {
          // Hidden reasoning is never returned. Cap also when no deltas were exposed.
          charge(0, chunk.block.text)
        } else throw error('output-invalid')
        break
      case 'usage': break
      case 'finish':
        if (chunk.reason?.kind === 'error' || chunk.reason?.kind === 'aborted') throw error('inference-failed')
        if (chunk.reason?.kind !== 'stop') throw error('output-invalid')
        finished = true
        break
      default: throw error('output-invalid')
    }
  }
  const output = text.join('')
  if (!finished || output.trim().length === 0 || output.includes('\0')) throw error('output-invalid')
  return { text: output }
}

function standardizedCwd(cwd, error) {
  if (typeof cwd !== 'string' || !isAbsolute(cwd)) throw error('directory-unavailable')
  const root = parsePath(cwd).root
  if (process.platform === 'win32' && (root === '/' || root === '\\')) throw error('directory-unavailable')
  return normalize(cwd)
}

// The installed permission-presets agent/created hook runs after setup and
// synchronously writes these defaults for a genuinely fresh Session. No user,
// inbox, goal, model, or other action counts as initialization.
// The desktop subagent settings service may also append one log-only policy
// on agent/created. It is not a selection of this Agent's own execution model.
const initialSessionEvents = new Set(['permission/preset', 'sandbox/mode', 'approval/policy', 'subagent/model-selection-policy'])

function freshSequence(session, error) {
  const seq = session.seq
  if (!Number.isSafeInteger(seq) || seq < 0 || seq > initialSessionEvents.size) throw error('initial-state-unsupported')
  const seen = new Set()
  for (let offset = 0; offset < seq; offset++) {
    const type = session.eventAt(offset)?.type
    if (!initialSessionEvents.has(type) || seen.has(type)) throw error('initial-state-unsupported')
    seen.add(type)
  }
  return seq
}

function emptyAt(ctx, agent, seq) {
  const { session, inbox } = agent
  if (agent.status !== 'idle' || inbox.nextTurn.length !== 0 || inbox.nextStep.length !== 0
    || session.seq !== seq || session.header.isSeeded || session.header.origin !== undefined) return false
  const boundary = ctx.agents.turnBoundaryOf(session)
  return boundary.lastTurn === 0 && boundary.openTurnStartSeq === null
}

/** Internal dependency injection for portable tests; production apply uses the bundled classes. */
export async function installRouterHost(ctx, runtime, config) {
  const { TypertRemoteService, RemoteError, installModelSelection } = runtime
  const checked = errorFactory(RemoteError)
  const error = checked.make
  const routes = allowedRoutes(config)
  const timeoutMs = runtime.testTimeoutMs ?? limits.timeoutMs
  const lifetime = new AbortController()
  const requests = new Map()
  const owned = new Map()
  // Not a creation receipt. This weak, process-local watermark only lets an
  // owner repeat the same explicit handoff if its reply was lost. Cold resume
  // may already have appended its structural end-seed marker. No config rights.
  const confirmedHandoffs = new WeakMap()
  let activeInferences = 0
  let activeCreations = 0

  ctx.effect(() => () => {
    lifetime.abort()
    owned.clear()
    requests.clear()
  }, 'router-agent host lifetime')

  function identityIsFree(id) {
    return ctx.sessions.get(id) === undefined && ctx.agents.get(id) === undefined
      && !ctx.workspaceRegistry.archivedSessionIds.includes(id)
  }

  // rc.5: only an omitted id means "use the Host default". A missing, broken
  // or mismatched explicit id must never silently compose some other preset.
  function resolvePreset(requested) {
    return checked.guard('preset-unavailable', async () => {
      const found = await ctx.agentPresets.resolve(requested)
      const id = parseAgentPresetId(found?.id)
      if (found.broken !== undefined || (requested !== undefined && id !== requested)) throw error('preset-unavailable')
      return id
    })
  }

  async function createFresh(id, request, transaction) {
    const signal = lifetime.signal
    checkSignal(signal, error)
    if (transaction.finish) return transaction.finish()
    if (!identityIsFree(id) || await ctx.sessionPersistence.stat(id, { signal }) !== undefined || !identityIsFree(id)) {
      throw error('creation-uncertain')
    }
    const { cwd, workspace } = await checked.guard('directory-unavailable', async () => {
      let workspace = request.workspaceId === undefined ? undefined : ctx.workspaceRegistry.get(request.workspaceId)
      if (request.workspaceId !== undefined && workspace === undefined) throw error('directory-unavailable')
      const cwd = standardizedCwd(workspace?.path ?? request.cwd ?? ctx.workingDirectory.defaultDirectory, error)
      if (!(await (runtime.statDirectory ?? stat)(cwd)).isDirectory()) throw error('directory-unavailable')
      workspace ??= await ctx.workspaceRegistry.resolveByPath(cwd)
      return { cwd, workspace }
    })
    const preset = await resolvePreset(request.agentPreset)
    checkSignal(signal, error)
    if (!identityIsFree(id)) throw error('creation-uncertain')
    const defaults = ctx.agentDefaultModel
    let prepared
    // Unlike session.create, the Agent factory acquires a NEW persistence writer
    // for this exact id and cannot claim/overwrite a pre-existing blank session.
    const { agent } = await ctx.agents.create({
      sessionId: id,
      signal,
      meta: { cwd, agentPreset: preset },
      agentOptions: {
        get provider() { return defaults.currentSelection().provider },
        get model() { return defaults.currentSelection().model },
        get reasoningEffort() { return defaults.currentSelection().reasoningEffort },
      },
      setup: async (agentCtx, pendingAgent) => {
        installModelSelection(agentCtx)
        await checked.guard('preset-unavailable', async () => {
          const bound = await ctx.agentPresets.mount(agentCtx, preset)
          if (bound?.id !== preset || bound.broken !== undefined) throw error('preset-unavailable')
        })
        prepared = pendingAgent
      },
    })
    const preparedSeq = freshSequence(agent.session, error)
    function assertFresh() {
      checkSignal(signal, error)
      if (agent !== prepared || agent.id !== id || agent.session.header.cwd !== cwd || agent.session.header.agentPreset !== preset
        || ctx.agents.get(id) !== agent || ctx.sessions.get(id) !== agent.session
        || ctx.workspaceRegistry.archivedSessionIds.includes(id)
        || !emptyAt(ctx, agent, preparedSeq)) throw error('create-state-changed')
    }
    assertFresh()
    // Keep the exact factory-produced Agent while confirming persistence. A
    // transient flush/attach failure can retry ONLY these steps under the same key.
    // Nothing is configurable until the acknowledgement can actually be returned.
    transaction.finish = async () => {
      assertFresh()
      await checked.guard('persistence-unconfirmed', async () => {
        if (!await ctx.sessions.flush(agent.session)) throw error('persistence-unconfirmed')
        const stored = await ctx.sessionPersistence.stat(id, { signal })
        if (!stored?.location || stored.header.id !== id || stored.header.cwd !== cwd
          || stored.header.agentPreset !== preset) throw error('persistence-unconfirmed')
      })
      assertFresh()
      if (workspace !== undefined) await checked.guard('workspace-attach-failed', () => workspace.attachSession(id))
      assertFresh()
      owned.set(id, { agent: new WeakRef(agent), seq: preparedSeq, preset })
      delete transaction.finish
      return { sessionId: id }
    }
    return transaction.finish()
  }

  function requireBlank(sessionId, record) {
    const agent = record?.agent.deref()
    if (agent === undefined || ctx.agents.get(sessionId) !== agent || ctx.sessions.get(sessionId) !== agent.session) {
      throw error('not-owned')
    }
    if (agent.session.header.agentPreset !== record.preset
      || ctx.workspaceRegistry.archivedSessionIds.includes(sessionId) || !emptyAt(ctx, agent, record.seq)) {
      throw error('not-blank')
    }
    return agent
  }

  class RouterAgentService extends TypertRemoteService {
    constructor() { super(ctx, namespace) }

    async infer(request, signal) {
      const caller = requireOwner(this.ctx, 'infer', RemoteError)
      const input = parsed(parseInfer, request, error)
      if (activeInferences >= limits.concurrency) throw error('busy')
      activeInferences++
      return bounded(error, timeoutMs, [caller, signal, lifetime.signal], async abort => {
        const selection = selectionOf(input)
        const call = await checked.guard('model-unavailable', async () => {
          await checkCatalog(ctx, routes, selection, abort, error)
          return ctx.llm.prepareCall({ ...selection, maxTokens: limits.outputTokens }, abort)
        })
        checkSignal(abort, error)
        return checked.guard('inference-failed', () => oneTextResponse(call, input, abort, error))
      }, () => { activeInferences-- })
    }

    async create(request, signal) {
      const caller = requireOwner(this.ctx, 'create', RemoteError)
      checkSignal(caller, error)
      checkSignal(signal, error)
      checkSignal(lifetime.signal, error)
      const input = parsed(parseCreate, request, error)
      if (input.cwd !== undefined) input.cwd = standardizedCwd(input.cwd, error)
      const id = creationPrefix + input.requestId
      const intent = JSON.stringify([input.cwd, input.workspaceId, input.agentPreset])
      const transaction = requests.get(id) ?? { intent }
      if (transaction.intent !== intent) throw error('creation-conflict')
      if (transaction.result) return transaction.result
      if (activeCreations >= maxCreationsInFlight) throw error('busy')
      activeCreations++
      // An admitted transaction continues through a client disconnect. Only
      // Host teardown aborts it; repeated requests join the same receipt.
      const result = Promise.resolve().then(() => checked.guard('create-failed', () => createFresh(id, input, transaction)))
        .catch(cause => { delete transaction.result; throw cause })
        .finally(() => { activeCreations-- })
      transaction.result = result
      requests.set(id, transaction)
      return result
    }

    // A legacy empty session has no cross-reload router ownership proof.
    // This owner-only, explicitly requested handoff never creates a Session,
    // registers it as owned, or selects a model. It authorizes ordinary reuse.
    async recoverEmpty(request, signal) {
      const caller = requireOwner(this.ctx, 'recoverEmpty', RemoteError)
      const input = parsed(parseRecoverEmpty, request, error)
      const cwd = standardizedCwd(input.cwd, error)
      if (activeCreations >= maxCreationsInFlight) throw error('busy')
      activeCreations++
      return bounded(error, timeoutMs, [caller, signal, lifetime.signal], async abort => {
        // A missing roster row is not proof of absence. This negative-only
        // check can NEVER open, resume, create or authorize a Session, even
        // if it has appeared in the meantime. Only a later create-only retry
        // may allocate the same key after testing all stores again.
        if (input.checkMissingOnly) {
          await checked.guard('recovery-unsafe',async()=>{
            const id=input.sessionId
            if (!identityIsFree(id) || ctx.workspaceRegistry.archivedSessionIds.includes(id)) throw error('recovery-unsafe')
            const stored=await ctx.sessionPersistence.stat(id,{signal:abort})
            checkSignal(abort,error)
            if (stored!==undefined || !identityIsFree(id) || ctx.workspaceRegistry.archivedSessionIds.includes(id)) throw error('recovery-unsafe')
            throw error('recovery-not-found')
          })
        }
        // Legacy 0.1.1 did not record the resolved preset in its task journal.
        // Bind to the original id in the owner's exact persisted target, NOT
        // today's router preference or Host default. This stat reads metadata;
        // the full empty proof below still cross-checks id/cwd/preset and log.
        const id = input.sessionId
        const recorded = await checked.guard('recovery-unsafe', async () => {
          if (ctx.workspaceRegistry.archivedSessionIds.includes(id)) throw error('recovery-unsafe')
          const stored = await ctx.sessionPersistence.stat(id, { signal: abort })
          checkSignal(abort, error)
          if (stored === undefined && identityIsFree(id)) throw error('recovery-not-found')
          const header = stored?.header
          if (header?.id !== id || header.cwd !== cwd) throw error('recovery-unsafe')
          return parseAgentPresetId(header.agentPreset)
        })
        const preset = await resolvePreset(recorded)
        const live = ctx.agents.get(id), prior = live && confirmedHandoffs.get(live)
        let agent,seq
        if (prior) {
          if (prior.id !== id || prior.cwd !== cwd || prior.preset !== preset ||
              !emptyAt(ctx,live,prior.seq)) throw error('recovery-unsafe')
          agent=live;seq=prior.seq
        } else {
          const proof = await checked.guard('recovery-unsafe', () => verifyRecoverableEmpty(ctx,
            {id,cwd,preset,signal:abort},{freshSequence,emptyAt,error}))
          agent=proof.agent;seq=proof.seq
        }
        return checked.guard('recovery-unsafe', () => {
          checkSignal(abort, error)
          if (ctx.agents.get(id) !== agent || ctx.sessions.get(id) !== agent.session
            || agent.session.header.agentPreset !== preset || ctx.agentPresets.composedPreset(agent.ctx) !== preset
            || ctx.workspaceRegistry.archivedSessionIds.includes(id) || !emptyAt(ctx, agent, seq)) throw error('recovery-unsafe')
          confirmedHandoffs.set(agent, { id, cwd, preset, seq })
          return { sessionId: id, cursor: seq - 1 }
        })
      }, () => { activeCreations-- })
    }

    async configure(request, signal) {
      const caller = requireOwner(this.ctx, 'configure', RemoteError)
      const input = parsed(parseConfigure, request, error)
      const { sessionId } = input
      const selection = selectionOf(input)
      const record = owned.get(sessionId)
      const agent = requireBlank(sessionId, record)
      return bounded(error, timeoutMs, [caller, signal, lifetime.signal], async abort => {
        if (record.selection !== undefined && !sameSelection(record.selection, selection)) throw error('configuration-conflict')
        await checked.guard('model-unavailable', async () => {
          await checkCatalog(ctx, routes, selection, abort, error)
          const config = await ctx.llm.resolveCallConfig(selection, abort)
          if (config.provider !== selection.provider || config.model !== selection.model
            || (selection.reasoningEffort !== undefined && config.reasoningEffort !== selection.reasoningEffort)) {
            throw error('model-unavailable')
          }
        })
        checkSignal(abort, error)
        requireBlank(sessionId, record)
        return checked.guard('configure-failed', () => agent.runMaintenance(async maintenance => {
          // No async gap between the final live/blank proof and selecting the model.
          checkSignal(abort, error)
          checkSignal(maintenance, error)
          requireBlank(sessionId, record)
          if (record.selection === undefined) {
            agent.model.select(selection)
            record.selection = selection
            record.seq = agent.session.seq
          } else if (!sameSelection(record.selection, selection)) throw error('configuration-conflict')
          if (!await ctx.sessions.flush(agent.session)) throw error('configure-failed')
          return { ok: true }
        }))
      })
    }
  }

  new RouterAgentService()
  await ctx.typert.register(routerAgentHostContribution)
}

/** DSH Cordis plugin entry; these two peers must resolve to the host runtime. */
export async function apply(ctx, config) {
  const [{ TypertRemoteService, RemoteError }, { installModelSelection }] = await Promise.all([
    import('@deepseek-ai/dsh-typert-protocol'),
    import('@deepseek-ai/dsh-agent'),
  ])
  await installRouterHost(ctx, { TypertRemoteService, RemoteError, installModelSelection }, config)
}
