// Private child of run.sh. All packages come from the installed Electron ASAR;
// no default profile / catalog is booted. Deliberately not a node:test mock host.
import assert from 'node:assert/strict'
import { createRequire, registerHooks } from 'node:module'
import { fileURLToPath, pathToFileURL } from 'node:url'
import { dirname, join } from 'node:path'
import { readFile, stat } from 'node:fs/promises'
import { checkProductionPanel } from './panel.mjs'
import { routingModels } from './routing.mjs'
import { inferFetch, semanticReply } from './slow-infer.mjs'
import { installStockSessions } from './stock-session.mjs'
import { assertStartup, reproduceOldHost, checkRecovery, checkChangedLive, legacyRequest } from './startup.mjs'

const scratch = dirname(fileURLToPath(import.meta.url))
const home = process.env.DSH_HOME
const cwd = process.cwd()
assert.match(scratch, /^\/private\/tmp\/dsh-router-smoke\.[a-zA-Z0-9]{8}$/)
const phase = process.env.DSH_SMOKE_PHASE, oldSlow = phase === 'slow-infer-0.2.1', slow = oldSlow || phase === 'slow-infer'
const state = slow ? join(scratch, phase) : scratch
assert.equal(home, join(state, 'dsh'))
assert.equal(process.env.HOME, join(state, 'home'))
assert.equal(cwd, join(state, 'work'))
const req = createRequire(join(process.env.DSH_BUNDLE, 'package.json'))
const requireURL = name => pathToFileURL(req.resolve('@deepseek-ai/' + name)).href
const pkg = name => import(requireURL(name))
const version = req('@deepseek-ai/dsh/package.json').version
assert.equal(version, '0.2.2-rc.5')
// The production entry is staged in our empty temp home, not installed. Resolve
// only its DSH peers as they would resolve after installation in the ASAR tree.
const pluginDirs = ['./host/', './old-host/', './legacy-slow-host/'].map(dir => new URL(dir, import.meta.url).href)
registerHooks({resolve(spec, context, next) {
  if (pluginDirs.some(dir => context.parentURL?.startsWith(dir)) && spec.startsWith('@deepseek-ai/')) {
    return {shortCircuit: true, url: pathToFileURL(req.resolve(spec)).href}
  }
  return next(spec, context)
}})
const { Context, Service } = await pkg('cordis')
const { HostConnectionService } = await pkg('dsh-client-connection')
const { LlmAdapter } = await pkg('dsh-llm')
const { installConnection } = await pkg('dsh-client-connection/client')
const host = new Context(), client = new Context()
const provider = 'smoke-memory', defaultModel = 'default-local', targetModel = 'selected-local'
const calls = []
const replyText = 'synthetic queued answer'
const routing = routingModels()
if (slow) routing.inferTrace = []
// Keep one unrelated native turn in flight until the adapter observes its own
// request queued. A deterministic gate, not polling or a race against a timer.
const busy = Promise.withResolvers(), release = Promise.withResolvers()
class MemoryModel extends LlmAdapter {
  async listModels() { return (routing.active ? Object.values(routing.models) : [defaultModel, targetModel]).map(id => ({provider, id, name: id})) }
  async *stream(options) {
    const {model, messages, system, tools, signal} = options
    signal?.throwIfAborted()
    assert.equal(options.provider, provider)
    if (routing.active) {
      assert.ok(Object.values(routing.models).includes(model))
      yield* chunks(await routing.respond(options)); return
    }
    assert.ok([defaultModel, targetModel].includes(model))
    const firstTurn = model === targetModel && !calls.some(c => c.model === model)
    calls.push({model, system, messages, tools})
    if (firstTurn) { busy.resolve(); await release.promise }
    let text = system === 'synthetic system' ? 'synthetic classifier answer' : firstTurn ? 'unrelated prior answer' : replyText
    if (model === defaultModel && system?.startsWith('你是只读的中文任务分流分类器')) {
      // Give the actual panel planner a valid bounded classification; a silent
      // fallback after receiving a malformed infer response must not pass.
      text = semanticReply({messages,tools})
    }
    yield* chunks(text)
  }
}
function* chunks(text) {
  yield {type: 'block-start', index: 0, blockType: 'text'}
  yield {type: 'text-delta', index: 0, text}
  yield {type: 'block-end', index: 0, block: {type: 'text', text}}
  yield {type: 'finish', reason: {kind: 'stop'}}
}

let stage = 'assembly'
const deadline = setTimeout(() => { console.error('TIMEOUT: ' + stage); process.exit(1) }, 55_000)
const ok = message => console.log('PASS ' + message)
async function mount(ctx, name, config = {}) {
  stage = 'mount ' + name
  const mod = await pkg(name)
  await ctx.plugin(mod.default ?? mod, config)
}
async function main() {
  host.baseUrl = pathToFileURL(join(process.env.DSH_BUNDLE, 'package.json')).href
  await mount(host, 'cordis-plugin-loader', {baseUrl: host.baseUrl})
  // Use the installed standard preset row definitions, not guessed configs.
  // The full web/stdio profile demands network/tool providers; none are booted.
  const {entryListSchema} = await pkg('cordis-plugin-include')
  const ledger = process.env.DSH_SMOKE_PHASE==='ledger', automatic=process.env.DSH_SMOKE_PHASE==='automatic'
  const routePhase = slow || automatic || ledger || ['routing','routing-cold'].includes(process.env.DSH_SMOKE_PHASE)
  const {load} = req('js-yaml'), enabled = new Set(['persona','agent-instructions','time-context','tool-todo'])
  const presets = await Promise.all((routePhase ? ['standard','ptc'] : ['standard']).map(async id => {
    const filename = req.resolve('@deepseek-ai/dsh-web-app/presets/' + id + '.patch.yml')
    const [{insert: [{config}]}] = load(await readFile(filename, 'utf8'), {schema: entryListSchema})
    assert.equal(config.id,id)
    const plugins = config.plugins.filter(row => enabled.has(row.id))
    assert.equal(plugins.length,enabled.size)
    return {...config,plugins}
  }))
  // Real host plugins only, explicitly allowlisted. No webServer, filesystem
  // tools, account, credentials, settings, user profile, or network adapters.
  for (const [name, config] of [
    ['typert-registry'], ['api-remote-access'], ['api-gateway'], ['llm'], ['session'],
    ['session-projection'], ['session-persistence-jsonl', {root: join(home, 'sessions')}],
    ['system-prompt', {includeRuntimeContext: false, includeHarnessIdentity: false}],
    ['tools'], ['tool-executor-native'], ['agent'], ['agent-loop', {agents: []}],
    ['agent-default-model', {provider, model: automatic || slow ? routing.models.standard : defaultModel}], ['fs-local'], ['working-directory'],
    ['storage'], ['storage-json', {root: join(home, 'storage')}], ['storage-domain', {backend: 'json'}],
    ['workspace'], ['agent-preset-registry', {default:'standard', ...(routePhase ? {selectedDefault:'ptc'} : {})}], ...presets.map(preset => ['agent-preset',preset]),
    // Same sandbox policy, executor, approval and Agent creation listener as
    // the shipped dsh-base profile. Registering services runs NO tools.
    ['sandbox-local'], ['sandbox-policy', {mode: 'workspace-write', workspaceRoot: cwd}],
    ['subprocess-local'], ['bash-sandbox'], ['user-approval', {policy: 'ask'}], ['permission-presets'],
    ['commands'], ['attachment-local', {dshHome: home}], ['session-query-sqlite', {path: join(home, 'unused.sqlite'), openAt: 'never'}],
  ]) await mount(host, 'dsh-' + name, config)
  const info = await host.agentPresets.resolve('standard')
  assert.equal(info.broken, undefined, info.broken)
  assert.deepEqual(host.llm.listProviders(), [])
  host.llm.registerAdapter([provider], new MemoryModel())
  assert.deepEqual(host.llm.listProviders().map(p => p.id), [provider])
  // Only the registry and its in-process Peer are needed: no BrowserAuth,
  // credentials, socket listener, Cookie, or real browser connection exists.
  await host.plugin(ctx => { new HostConnectionService(ctx, [], undefined) })
  for (const name of ['client-file-upload', 'api-session-controller', 'api-workspace-controller']) {
    await mount(host, 'dsh-' + name)
  }
  const apiPackages = ['dsh-api-session-controller', 'dsh-api-workspace-controller', 'dsh-api-remote-access']
  for (const p of apiPackages) await host.typert.register((await pkg(p + '/typert')).TYPERT)
  assert.equal(host.get('webServer'), undefined)
  assert.equal(host.get('credentials'), undefined)

  // Real browser-facing codec/envelope paths. A Request is just data here:
  // the two carrier hooks are pure in-process dispatch; fetch() is never used.
  await mount(host,'dsh-api-remotes') // genuine connection generation and forwarded Session list/status events
  const participation = 'answer'
  const owner = host.connection.createPeer({principal: {kind: 'owner'}, interactions: participation})
  stage = '0.1.1 desktop initialization control'
  const {default: policy} = await pkg('dsh-tool-subagent/model-selection-settings')
  const coldSeed = process.env.DSH_SMOKE_PHASE === 'old-host-seed'
  if (coldSeed) {
    const off = host.plugin(policy, {enabled: false, allowedModels: [{provider, model: targetModel}]})
    await off
    try { await reproduceOldHost(host, owner, scratch, 'off') } finally { await off.dispose() }
  }
  await host.plugin(policy, {enabled: true, allowedModels: [{provider, model: targetModel}]})
  if (coldSeed) {
    assert.ok(await reproduceOldHost(host, owner, scratch, 'cold'))
    return // No current plugin loaded; close every service and exit the PID.
  }
  const hot = !routePhase && await reproduceOldHost(host, owner, scratch, 'reload')
  stage = 'register production Cordis plugin'
  if (oldSlow) {
    const {name,version} = JSON.parse(await readFile(new URL('./legacy-slow-host/package.json', import.meta.url), 'utf8'))
    assert.equal(name,'dsh-router-agent'); assert.equal(version,'0.2.1')
  }
  const routerHost = oldSlow ? await import('./legacy-slow-host/index.mjs') : await import('./host/index.mjs')
  await host.plugin(routerHost)
  assert.ok(host.typert.getPackage('dsh-router-agent', 'host'))
  const handler = host.connection.createSharedFetchHandler('/api')
  const endpoints = [], streams=[]
  await client.plugin(ctx => installConnection(ctx, {interactions: participation, transport: {
    fetch(route, init) {
      endpoints.push(route)
      const request = new Request(new URL(route, 'http://smoke.invalid/'), init)
      if (slow && route==='api/routerAgent/infer') return inferFetch(handler, request, owner, routing.inferTrace)
      return handler.fetch(request, owner)
    },
    async *openStream(endpoint, payload, signal, uplink) {
      if (ledger) streams.push({endpoint,payload})
      yield* await host.typertGateway.wireStream.open(endpoint, payload, uplink, owner, signal)
    },
  }}))
  await mount(client, 'dsh-typert-registry/client')
  await mount(client, 'dsh-api-gateway/client')
  for (const p of apiPackages) if (!ledger || p!=='dsh-api-remote-access') await client.remote.$mount((await pkg(p + '/remote')).default)
  stage='install stock Session / Workspace clients'
  const installDesktop=await installStockSessions({client,host,req,pkg})
  if (routePhase) {
    stage = slow ? phase + ' / slow semantic form submission' : automatic ? 'default automatic routing / accepted-context continuity / scope' : ledger ? 'single delivery / compact journal / original live Session pane' : 'three-tier production form / repeat-work session / independent presets'
    await checkProductionPanel({client, Service, host, endpoints, calls, provider, cwd, defaultModel, targetModel, replyText, routing, installDesktop, streams})
    return
  }
  const {routerAgentRemoteContribution} = await import('./host/contract.mjs')
  const {createDshAdapter} = await import('./dsh-client/adapter.mjs')
  const withdrawRootProbe = await client.remote.$mount(routerAgentRemoteContribution)
  ok('DSH ' + version + ': real Cordis + Typert Host and Client; only provider ' + provider)

  stage = 'tool-free infer via Remote'
  const remote = client.remote
  const input = {provider, model: defaultModel, system: 'synthetic system', user: 'synthetic input'}
  // Admit just this synthetic principal to the endpoint at Gateway level. The
  // router's own owner guard must still reject it before LLM dispatch.
  const guest = host.connection.createPeer({principal: {kind: 'smoke-guest'}, interactions: 'none'})
  host.remoteAccess.registerPolicy('smoke-guest', {bindings: () => [{resource: {kind: 'global'},
    role: {name: 'smoke-infer', resource: 'global', actions: ['routerAgent/infer']}}]})
  await assert.rejects(host.typertGateway.invoke({namespace: 'routerAgent', method: 'infer', args: {request: input}, peer: guest}),
    {code: 'remote-access/denied', details: {action: 'routerAgent/infer', reason: 'owner-required'}})
  assert.equal(calls.length, 0)
  const classifier = await remote.routerAgent.infer(input)
  assert.deepEqual(classifier, {ok: true, value: {text: 'synthetic classifier answer'}})
  assert.equal(calls.length, 1)
  assert.deepEqual(calls[0].tools, [])
  assert.equal(calls[0].system, 'synthetic system')
  assert.deepEqual(calls[0].messages, [{role: 'user', content: [{type: 'text', text: 'synthetic input'}]}])
  ok('non-owner denied with zero calls; owner infer → LlmRuntime.prepareCall → in-memory model (0 tools)')

  stage = 'workspace baseline and create'
  await host.workspaceRegistry.create(cwd, 'scratch workspace')
  const adapter = createDshAdapter(remote)
  assert.ok((await adapter.listWorkspaces()).some(w => w.path === cwd))
  assert.deepEqual(await adapter.listSessions([cwd]), [])
  const defaults = host.agentDefaultModel.currentSelection()
  assert.deepEqual(defaults, {provider, model: defaultModel})
  const createKey = 'ra-55555555-6666-4777-8888-000000000000'
  const id = await adapter.createSession(cwd, createKey)
  assert.equal(await adapter.createSession(cwd, createKey), id)
  const agent = host.agents.get(id)
  assert.ok(agent)
  assert.equal(agent.session.header.cwd, cwd)
  assertStartup(agent.session)
  assert.deepEqual(agent.model.current(), defaults)
  const stored = await host.sessionPersistence.stat(id)
  assert.equal(stored.header.id, id)
  assert.equal(stored.location.kind, 'jsonl')
  assert.ok(stored.location.path.startsWith(join(home, 'sessions') + '/'))
  assert.equal((await stat(stored.location.path)).size, stored.sizeBytes)
  assert.ok(stored.sizeBytes > 0)
  ok('adapter create + idempotent retry → live Agent + materialized JSONL')

  stage = 'session-only model selection'
  await adapter.configure(id, {provider, model: targetModel})
  assert.deepEqual(agent.model.current(), {provider, model: targetModel})
  assert.deepEqual(host.agentDefaultModel.currentSelection(), defaults)
  const other = await remote.session.create({cwd})
  assert.equal(other.ok, true)
  assert.notEqual(other.value.sessionId, id)
  assert.deepEqual(host.agents.get(other.value.sessionId).model.current(), defaults)
  assert.equal((await remote.routerAgent.configure({sessionId: other.value.sessionId, provider, model: targetModel})).error?.code, 'router-agent/not-owned')
  ok('new router session selected-local; default and independent native session remain default-local')

  stage = 'queue → real agent loop → event attribution'
  const requestId = 'smoke-delivery'
  const prior = await remote.session.prompt({sessionId: id, requestId: 'prior-task', mode: 'queue',
    content: [{type: 'text', text: 'unrelated prior prompt'}]})
  assert.deepEqual(prior, {ok: true, value: {accepted: true}})
  await busy.promise
  const cursor = await adapter.cursor(id) // deliberately mid-way through the unrelated turn
  const end = Promise.withResolvers()
  const off = host.on('session/event', (session, e) => {
    if (session.id === id && e.type === 'turn/end' && e.data.turn === 2) end.resolve(e.data)
  })
  await adapter.deliver(id, requestId, 'synthetic queued prompt')
  assert.deepEqual(await adapter.observe(id, requestId, cursor), {status: 'queued'})
  const denied = await remote.routerAgent.recoverEmpty({requestId: createKey, sessionId: id, cwd})
  assert.equal(denied.ok, false, 'must not claim a live target with a pending delivery')
  assert.ok(denied.error.code.startsWith('router-agent/'))
  release.resolve()
  const turn = await end.promise
  await off()
  assert.equal(turn.reason.kind, 'completed', JSON.stringify(turn.reason))
  await adapter.deliver(id, requestId, 'synthetic queued prompt')
  assert.deepEqual(await adapter.observe(id, requestId, cursor), {status: 'done', result: replyText})
  assert.equal((await adapter.observe(id, 'different-request', cursor)).status, 'unknown')
  assert.equal((await remote.routerAgent.configure({sessionId: id, provider, model: targetModel})).error?.code, 'router-agent/not-blank')
  assert.equal(await host.sessions.flush(agent.session), true)
  await using reader = await host.sessionPersistence.open(id, 'read')
  const {events} = await reader.read()
  assert.equal(events.filter(e => e.type === 'user/message' && e.data.source.rpcId === requestId).length, 1)
  assert.equal(events.filter(e => e.type === 'turn/end').length, 2) // the unrelated native turn plus ours
  assert.ok((await adapter.listSessions([cwd])).some(row => row.id === id))
  assert.deepEqual(await adapter.recent(id), ['unrelated prior prompt', 'synthetic queued prompt'])
  assert.equal(events.filter(e => e.type === 'model/selection' && e.data.model === targetModel).length, 1)
  assert.deepEqual(calls.map(c => c.model), [defaultModel, targetModel, targetModel])
  assert.deepEqual(host.agentDefaultModel.currentSelection(), defaults)
  assert.ok(!endpoints.includes('api/session/selectModel'))
  ok('busy native turn → queued → done; retry added no turn or message. Only matching request gets its final text; candidates/recent verified.')

  stage = 'revoked workspace access'
  const archive = await remote.workspace.archiveSession({sessionId: id})
  assert.equal(archive.ok, true)
  assert.ok(archive.value.archivedSessionIds.includes(id))
  await assert.rejects(adapter.deliver(id, 'post-archive', 'must not be sent'))
  assert.equal(endpoints.filter(e => e === 'api/session/prompt').length, 3)
  assert.ok(!(await adapter.listSessions([cwd])).some(row => row.id === id))
  ok('fresh archive baseline blocks repeat access before any further prompt RPC')

  stage = 'live recovery receipt stale before dispatch'
  await checkChangedLive({host, remote, cwd, endpoints, calls, provider, defaultModel, targetModel, createDshAdapter})
  if (hot) {
    stage = 'explicit owner recovery of legacy JSONL (reload and cold restart)'
    for (const [fixture, mode] of [[hot, 'plugin-reload'], [legacyRequest(scratch, 'cold'), 'cold-PID']]) {
      await checkRecovery({host, remote, fixture, mode, calls, endpoints, provider, defaultModel, targetModel, replyText, createDshAdapter})
    }
  }

  // The preceding library checks use the unrestricted diagnostic root. Drop
  // that contribution before loading the production client (which owns it).
  stage = 'non-root production client mount, form submit and remount'
  await withdrawRootProbe()
  await checkProductionPanel({client, Service, host, endpoints, calls, provider, cwd, defaultModel, targetModel, replyText})
}
try { await main() } catch (error) {
  console.error('FAIL ' + stage)
  throw error
} finally {
  release.resolve()
  try { await client.fiber.dispose(); await host.fiber.dispose() }
  finally { clearTimeout(deadline) }
}
