import { isAbsolute } from 'node:path'
import { isDeepStrictEqual } from 'node:util'

// This plugin is pinned to DSH 0.2.2-rc.5 (current log format v4). No fallback
// to unknown backends, raw filesystem paths, migrations, or broad history reads.
const formatVersion = 4
const initialEventLimit = 4
const artifactByteLimit = 64 * 1024
const unsafe = Symbol('unsafe recovery')
const missing = Symbol('missing recovery target')
const ordinaryId = /^[A-Za-z0-9_-]{1,160}$/u
const seedMarker = 'session/end-seed'

function insist(condition) {
  if (!condition) throw unsafe
}

function token(value, limit = 256) {
  return typeof value === 'string' && value.length > 0 && value.length <= limit
    && value.trim() === value && !/[\u0000-\u001f\u007f]/u.test(value)
}

function exactFields(value, keys) {
  if (value === null || typeof value !== 'object') return false
  const prototype = Object.getPrototypeOf(value)
  if (prototype !== Object.prototype && prototype !== null) return false
  const own = Reflect.ownKeys(value)
  return own.length === keys.length && keys.every(key => {
    const property = Object.getOwnPropertyDescriptor(value, key)
    return property?.enumerable === true && 'value' in property
  })
}

function initializationData(type, data) {
  // Copy only the fields in the four known log-only event schemas. Never
  // inspect the data of a rejected (e.g. user/assistant) event envelope.
  switch (type) {
    case 'permission/preset':
      insist(exactFields(data, ['preset']) && token(data.preset))
      return { preset: data.preset }
    case 'sandbox/mode':
      insist(exactFields(data, ['mode']) && ['read-only', 'workspace-write', 'danger-full-access'].includes(data.mode))
      return { mode: data.mode }
    case 'approval/policy':
      insist(exactFields(data, ['policy']) && ['ask', 'never'].includes(data.policy))
      return { policy: data.policy }
    case 'subagent/model-selection-policy': {
      insist(exactFields(data, ['allowedModels']) && Array.isArray(data.allowedModels)
        && data.allowedModels.length >= 1 && data.allowedModels.length <= 512)
      const seen = new Set()
      const allowedModels = []
      for (const route of data.allowedModels) {
        insist(exactFields(route, ['provider', 'model']) && token(route.provider) && token(route.model))
        const key = JSON.stringify([route.provider, route.model])
        insist(!seen.has(key))
        seen.add(key)
        allowedModels.push({ provider: route.provider, model: route.model })
      }
      return { allowedModels }
    }
    default: throw unsafe
  }
}

function headerStamp(header, target, live = false) {
  insist(header?.version === formatVersion && header.id === target.id && header.cwd === target.cwd
    && header.agentPreset === target.preset && header.isSeeded === false && header.origin === undefined
    && header.parentSession === undefined
    // prepare() may omit depth on a fresh live Session; v4 persistence
    // normalizes that one omitted root default to 0.
    && (header.delegationDepth === 0 || (live && header.delegationDepth === undefined))
    && Number.isSafeInteger(header.createdAt) && header.createdAt >= 0)
  return header.createdAt
}

function readStamp(snapshot, target, includesMarker) {
  const limit = initialEventLimit + Number(includesMarker)
  insist(snapshot?.formatStatus === 'current' && token(snapshot.revision, 1024)
    && snapshot.location?.kind === 'jsonl' && typeof snapshot.location.path === 'string'
    && snapshot.location.path.length > 0 && Number.isSafeInteger(snapshot.sizeBytes)
    && snapshot.sizeBytes > 0 && snapshot.sizeBytes <= artifactByteLimit
    && (snapshot.eventCount === undefined || (Number.isSafeInteger(snapshot.eventCount)
      && snapshot.eventCount >= 0 && snapshot.eventCount <= limit)))
  return {
    createdAt: headerStamp(snapshot.header, target), revision: snapshot.revision,
    path: snapshot.location.path, size: snapshot.sizeBytes, count: snapshot.eventCount,
  }
}

function eventMetadata(source, count, includesMarker, freshSequence) {
  const initialCount = count - Number(includesMarker)
  insist(Number.isSafeInteger(initialCount) && initialCount >= 0 && initialCount <= initialEventLimit)
  const events = []
  for (let seq = 0; seq < count; seq++) {
    const event = source(seq)
    insist(exactFields(event, ['type', 'seq', 'time', 'data']) && event.seq === seq
      && Number.isSafeInteger(event.time) && event.time >= 0)
    const type = event.type
    events.push({ type, seq, time: event.time, event })
  }
  // Reuse the main host's allowlist + duplicate rule, without giving it bodies.
  const facade = { seq: initialCount, eventAt: seq => ({ type: events[seq]?.type }) }
  insist(freshSequence(facade, () => unsafe) === initialCount)
  return events.map(({ type, seq, time, event }) => {
    if (includesMarker && seq === initialCount) {
      insist(type === seedMarker && exactFields(event.data, []))
      return { type, seq, time, data: {} }
    }
    return { type, seq, time, data: initializationData(type, event.data) }
  })
}

/**
 * Prove an owner-confirmed legacy target is STILL the same, untouched v4
 * Session. This neither establishes ownership nor changes any model setting.
 * The authenticated caller must bind id/cwd/preset to a specific confirmation
 * and recheck the returned identity + seq immediately before granting reuse.
 */
export async function verifyRecoverableEmpty(ctx, request, { freshSequence, emptyAt, error }) {
  try {
    const { id, cwd, preset, signal } = request
    const target = { id, cwd, preset }
    insist(typeof id === 'string' && ordinaryId.test(id) && typeof cwd === 'string' && cwd.length <= 4096
      && isAbsolute(cwd) && !cwd.includes('\0') && token(preset))

    const persistence = ctx.sessionPersistence
    const persistenceIdentity = persistence.identity
    function baseCheck() {
      insist(!signal?.aborted && (persistenceIdentity === undefined ? ctx.sessionPersistence === persistence
        : ctx.sessionPersistence.identity === persistenceIdentity))
      const archived = ctx.workspaceRegistry.archivedSessionIds
      insist(Array.isArray(archived) && !archived.includes(id))
    }

    function livePair() {
      baseCheck()
      const session = ctx.sessions.get(id)
      const agent = ctx.agents.get(id)
      if (agent === undefined) insist(session === undefined)
      else insist(agent.id === id && agent.session === session && session.id === id)
      return { agent, session }
    }

    function verifyLive(pair, includesMarker, expected) {
      const observed = livePair()
      const { agent, session } = pair
      insist(agent !== undefined && observed.agent === agent && observed.session === session
        && session.inheritedEventCount === 0)
      const seq = session.seq
      const createdAt = headerStamp(session.header, target, true)
      insist(emptyAt(ctx, agent, seq))
      if (includesMarker) insist(session.firstLiveSeq === seq - 1)
      const events = eventMetadata(index => session.eventAt(index), seq, includesMarker, freshSequence)
      if (expected !== undefined) insist(createdAt === expected.createdAt && isDeepStrictEqual(events, expected.events))
      return { createdAt, events, seq }
    }

    async function verifyStored(includesMarker, permitMissing) {
      baseCheck()
      const first = await persistence.stat(id, { signal })
      baseCheck()
      if (first === undefined && permitMissing && livePair().agent === undefined) throw missing
      const stamp = readStamp(first, target, includesMarker)
      const limit = initialEventLimit + Number(includesMarker)
      const handle = await persistence.open(id, 'read', { signal })
      let events
      try {
        baseCheck()
        insist(handle.access === 'read' && handle.id === id && handle.inheritedEventCount === 0
          && headerStamp(handle.header, target) === stamp.createdAt)
        // Ask for one extra envelope so a longer log cannot masquerade as
        // the bounded metadata prefix. The backend itself performs decoding.
        const result = await handle.read(0, limit + 1, { signal })
        baseCheck()
        insist(Array.isArray(result.events) && (stamp.count === undefined || result.events.length === stamp.count))
        events = eventMetadata(index => result.events[index], result.events.length, includesMarker, freshSequence)
      } finally {
        await handle.close()
      }
      const latest = await persistence.stat(id, { signal })
      baseCheck()
      insist(isDeepStrictEqual(readStamp(latest, target, includesMarker), stamp))
      return { ...stamp, events }
    }

    const before = livePair()
    const initialLive = before.agent === undefined ? undefined : verifyLive(before, false)
    const initial = await verifyStored(false, initialLive === undefined)
    if (initialLive !== undefined) {
      insist(initialLive.createdAt === initial.createdAt && isDeepStrictEqual(initialLive.events, initial.events))
      const { seq } = verifyLive(before, false, initial)
      return { agent: before.agent, seq }
    }

    // SessionStore and AgentRegistry must BOTH stay cold before the official
    // resolver. The resolver may restore a writer but never creates a new id.
    insist(livePair().agent === undefined)
    const resolved = await ctx.sessionController.resolveAgent(id)
    insist(resolved !== null && typeof resolved === 'object' && !('error' in resolved) && resolved.agent !== undefined)
    const after = { agent: resolved.agent, session: resolved.agent.session }
    const verification = verifyLive(after, true)
    // A native resume commits one ordinary, log-only session/end-seed marker.
    // An older marker in the stored prefix was NOT allowed, nor is a subsequent
    // completion, input, policy change, or model selection accepted as a marker.
    insist(verification.createdAt === initial.createdAt && verification.seq === initial.events.length + 1
      && isDeepStrictEqual(verification.events.slice(0, -1), initial.events))
    const final = await verifyStored(true, false)
    insist(final.path === initial.path && final.revision !== initial.revision && final.size > initial.size
      && final.createdAt === verification.createdAt && isDeepStrictEqual(final.events, verification.events))
    const { seq } = verifyLive(after, true, final)
    return { agent: after.agent, seq }
  } catch (cause) {
    // Do not expose DSH-internal errors, paths, mismatching values, or event data.
    throw error(cause === missing ? 'recovery-not-found' : 'recovery-unsafe')
  }
}
