// Browser-safe, dependency-free Typert contract shared by both plugin halves.
export const packageName = 'dsh-router-agent'
export const namespace = 'routerAgent'
export const limits = Object.freeze({
  systemBytes: 16 * 1024,
  userBytes: 48 * 1024,
  outputBytes: 24 * 1024,
  outputTokens: 4096,
  timeoutMs: 30_000,
  concurrency: 2,
})

const encoder = new TextEncoder()
export const byteLength = value => encoder.encode(value).length

function invalid() {
  // This may become a Gateway error. Never copy untrusted field names or values into it.
  throw new TypeError('Invalid router-agent request or result')
}

function fields(value, required, optional = []) {
  if (value === null || typeof value !== 'object') invalid()
  const proto = Object.getPrototypeOf(value)
  if (proto !== Object.prototype && proto !== null) invalid()
  const allowed = new Set([...required, ...optional])
  const clean = {}
  for (const key of Reflect.ownKeys(value)) {
    if (!allowed.has(key)) invalid()
    const property = Object.getOwnPropertyDescriptor(value, key)
    if (!property?.enumerable || !('value' in property)) invalid()
    if (property.value === undefined && optional.includes(key)) continue
    clean[key] = property.value
  }
  if (!required.every(key => Object.hasOwn(clean, key))) invalid()
  return clean
}

function nonblank(value, max) {
  if (typeof value !== 'string' || value.length === 0 || value.length > max
    || byteLength(value) > max || value.trim().length === 0 || value.includes('\0')) invalid()
  return value
}

function identifier(value, max = 256) {
  nonblank(value, max)
  if (value.trim() !== value || /[\u0000-\u001f\u007f]/u.test(value)) invalid()
  return value
}

function creationToken(value, max = 128) {
  identifier(value, max)
  if (!/^[A-Za-z0-9_-]+$/u.test(value)) invalid()
  return value
}

function route(value) {
  identifier(value.provider)
  identifier(value.model)
  if (value.effort !== undefined) identifier(value.effort)
  return value
}

export function parseInfer(input) {
  const value = route(fields(input, ['system', 'user', 'provider', 'model'], ['effort']))
  nonblank(value.system, limits.systemBytes)
  nonblank(value.user, limits.userBytes)
  return value
}

// The same bounded identifier is required on request, registry and persisted headers.
export function parseAgentPresetId(value) { return identifier(value) }

export function parseCreate(input) {
  const value = fields(input, ['requestId'], ['cwd', 'workspaceId', 'agentPreset'])
  creationToken(value.requestId)
  if (value.cwd !== undefined) nonblank(value.cwd, 4096)
  if (value.workspaceId !== undefined) identifier(value.workspaceId)
  if (value.agentPreset !== undefined) parseAgentPresetId(value.agentPreset)
  if (value.cwd !== undefined && value.workspaceId !== undefined) invalid()
  return value
}

// Zero authority on its own: this deterministic ID only addresses the target
// of an owner-confirmed legacy handoff, never automatic create/configure.
export function expectedRecoveryId(key) {
  return typeof key === 'string' && /^ra-[0-9a-f]{8}-[0-9a-f]{4}-4[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/.test(key)
    ? 'session-router-agent-' + key : null
}

export function parseRecoverEmpty(input) {
  const value = fields(input, ['requestId', 'sessionId', 'cwd'], ['checkMissingOnly'])
  if (value.checkMissingOnly !== undefined && value.checkMissingOnly !== true) invalid()
  const expected = expectedRecoveryId(value.requestId)
  if (!expected || value.sessionId !== expected) invalid()
  nonblank(value.cwd, 4096)
  return value
}

export function parseConfigure(input) {
  const value = route(fields(input, ['sessionId', 'provider', 'model'], ['effort']))
  creationToken(value.sessionId, 160)
  return value
}

function parseTextResult(input) {
  const value = fields(input, ['text'])
  nonblank(value.text, limits.outputBytes)
  return value
}

function parseCreateResult(input) {
  const value = fields(input, ['sessionId'])
  creationToken(value.sessionId, 160)
  return value
}

function parseConfigureResult(input) {
  const value = fields(input, ['ok'])
  if (value.ok !== true) invalid()
  return value
}

function codec(symbol, parse, result = false) {
  const schema = Object.freeze({ parse })
  return Object.freeze({
    mode: 'strict',
    typeSymbol: packageName + '#' + symbol,
    create: () => schema,
    ...(result ? { decode: parse } : {}),
  })
}

function descriptor(method, parse, result) {
  const id = packageName + '#' + namespace + '/' + method
  return Object.freeze({
    id,
    service: namespace,
    namespace,
    method,
    invocation: Object.freeze({ kind: 'direct' }),
    parameters: Object.freeze([Object.freeze({
      name: 'request',
      wire: 'request',
      source: 'json',
      codec: codec(method + ':request', parse),
    })]),
    cancellation: Object.freeze({ parameter: 'signal' }),
    result: codec(method + ':result', result, true),
  })
}

const descriptors = Object.freeze([
  descriptor('infer', parseInfer, parseTextResult),
  descriptor('create', parseCreate, parseCreateResult),
  descriptor('configure', parseConfigure, parseConfigureResult),
  descriptor('recoverEmpty', parseRecoverEmpty, value => {
    const r = fields(value, ['sessionId', 'cursor'])
    identifier(r.sessionId)
    if (!Number.isSafeInteger(r.cursor) || r.cursor < -1) invalid()
    return r
  }),
])

/** Browser plugin: await ctx.remote.$mount(routerAgentRemoteContribution). */
export const routerAgentRemoteContribution = Object.freeze({ package: packageName, descriptors })

/** Host plugin registers this directly; no generated artifact or loader export is needed. */
export const routerAgentHostContribution = Object.freeze({
  package: packageName,
  face: 'host',
  schemas: Object.freeze([]),
  model: Object.freeze({ services: Object.freeze([]), events: Object.freeze([]), objects: Object.freeze([]) }),
  invocations: descriptors,
})
