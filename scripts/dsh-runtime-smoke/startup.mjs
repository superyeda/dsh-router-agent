import assert from 'node:assert/strict'
import { existsSync } from 'node:fs'
import { mkdir, readFile } from 'node:fs/promises'
import { join } from 'node:path'

const startupTypes = ['permission/preset', 'sandbox/mode', 'approval/policy', 'subagent/model-selection-policy']
export function assertStartup(session, policy = true) {
  assert.equal(session.header.agentPreset, 'standard')
  const rows = Array.from({length: session.seq}, (_, i) => session.eventAt(i))
  const count = policy ? 4 : 3
  assert.deepEqual(rows.map(e => e.type), startupTypes.slice(0, count))
  assert.deepEqual(rows.map(e => e.data), [{preset: 'workspace-write'}, {mode: 'workspace-write'}, {policy: 'ask'},
    {allowedModels: [{provider: 'smoke-memory', model: 'selected-local'}]}].slice(0, count))
  return rows.map(e => e.type)
}

export function legacyRequest(scratch, mode) {
  const requestId = 'ra-' + ({cold: '11111111', reload: '99999999', off: '00000000'})[mode] + '-2222-4333-8444-555555555555'
  return {id: 'session-router-agent-' + requestId, request: {requestId, cwd: join(scratch, 'old-' + mode)}}
}

// A negative control from the unmodified 0.1.1 package, in the same real host
// as its successor. No plugin.configure call or invented event makes it fail.
export async function reproduceOldHost(host, owner, scratch, mode) {
  const manifest = new URL('./old-host/package.json', import.meta.url)
  if (!existsSync(manifest)) return
  const {name, version} = JSON.parse(await readFile(manifest, 'utf8'))
  assert.equal(name, 'dsh-router-agent'); assert.equal(version, '0.1.1')
  const legacy = host.plugin(await import('./old-host/index.mjs'))
  const {request, id} = legacyRequest(scratch, mode)
  await mkdir(request.cwd)
  try {
    await legacy
    const invoke = () => host.typertGateway.invoke({namespace: 'routerAgent', method: 'create', args: {request}, peer: owner})
    if (mode === 'off') {
      assert.equal((await invoke()).sessionId, id)
      assertStartup(host.agents.get(id).session, false)
      console.log('CONTROL host 0.1.1: same preset and official policy plugin disabled → 3 init events, create succeeds')
      return {id, request}
    }
    await assert.rejects(invoke, {code: 'router-agent/create-failed'})
    const agent = host.agents.get(id)
    assert.ok(agent, 'old host failed before the genuine initialization path')
    const types = assertStartup(agent.session)
    console.log('REPRO host 0.1.1: create-failed AFTER live Agent; actual startup log = ' + types.join(' → '))
  } finally { await legacy.dispose() }
  await using reader = await host.sessionPersistence.open(id, 'read')
  assert.equal(reader.header.id, id); assert.equal(reader.header.cwd, request.cwd)
  assert.equal(reader.inheritedEventCount, 0)
  const {events} = await reader.read()
  assert.deepEqual(events.map(e => e.type), startupTypes)
  const live = host.agents.get(id) !== undefined
  console.log('REPRO host 0.1.1 (' + mode + '): original plugin unmounted; four init-only events persisted; live Agent = ' + live)
  assert.equal(live, false)
  return {id, request}
}

async function persisted(host, id) {
  await using reader = await host.sessionPersistence.open(id, 'read')
  return (await reader.read()).events
}

// Recovery is an explicit owner decision to reuse a particular existing blank
// target; neither a familiar prefix nor a valid UUID proves router ownership.
export async function checkRecovery({host, remote, fixture, mode, calls, endpoints, provider, defaultModel, targetModel, replyText, createDshAdapter}) {
  const {id, request} = fixture
  const {requestId, cwd} = request
  const answer = {provider, model: defaultModel}
  const ids = async () => (await host.sessionPersistence.list()).map(s => s.header.id).sort()
  const original = await ids(), pos = endpoints.length, count = calls.length
  const before = await persisted(host, id)
  assert.equal(before.length, 4)
  const existing = host.agents.get(id)
  assert.equal(existing, undefined, 'cold/writer-released scenario must not reuse a live Agent')
  const args = {...request, sessionId: id}
  const select = () => remote.routerAgent.configure({sessionId: id, provider, model: targetModel})
  assert.equal((await remote.routerAgent.create(request)).error?.code, 'router-agent/creation-uncertain')
  assert.equal((await select()).error?.code, 'router-agent/not-owned')
  const wrongDir = await remote.routerAgent.recoverEmpty({...args, cwd: process.cwd()})
  assert.equal(wrongDir.ok, false)
  assert.ok(wrongDir.error.code.startsWith('router-agent/'))
  const wrongKey = await remote.routerAgent.recoverEmpty({...args, requestId: 'ra-00000000-0000-4000-8000-000000000000'})
  // The strict client descriptor can reject the mismatched pair before RPC.
  assert.equal(wrongKey.ok, false); assert.ok(wrongKey.error.code, 'mismatched key was not rejected')
  assert.deepEqual(await persisted(host, id), before, 'a refusal must not append, resume, or prompt')
  assert.equal(host.agents.get(id), undefined)
  assert.deepEqual(await ids(), original)
  assert.equal(calls.length, count)
  assert.equal(endpoints.slice(pos).includes('api/session/prompt'), false)

  const page = createDshAdapter(remote)
  await page.listSessions([cwd])
  assert.equal(await page.recoverEmpty(cwd, requestId, id), id)
  const agent = host.agents.get(id)
  assert.ok(agent); assert.deepEqual(agent.model.current(), answer)
  assert.equal((await select()).error?.code, 'router-agent/not-owned', 'recovery is NOT a create receipt')
  const cursor = await page.cursor(id), done = Promise.withResolvers()
  assert.equal(cursor, 4) // four untouched records + the rc.5 cold-resume boundary
  const cut = await persisted(host, id)
  assert.deepEqual(cut.map(e => e.type), [...startupTypes, 'session/end-seed'])
  assert.deepEqual(cut.at(-1).data, {})
  assert.deepEqual(await remote.routerAgent.recoverEmpty(args), {ok:true, value:{sessionId:id, cursor}})
  assert.deepEqual(await persisted(host, id), cut, 'reconfirm must not add a second resume marker')
  const off = host.on('session/event', (s,e) => { if (s.id === id && e.type === 'turn/end') done.resolve(e.data) })
  const delivery = 'resume-' + mode
  try {
    await page.deliver(id, delivery, 'synthetic recovery delivery')
    assert.equal((await done.promise).reason.kind, 'completed')
    await assert.rejects(page.deliver(id, delivery, 'synthetic recovery delivery'), 'recovery permits one send only')
    assert.equal(endpoints.slice(pos).filter(e => e === 'api/session/prompt').length, 1)
    assert.deepEqual(await page.observe(id, delivery, cursor), {status: 'done', result: replyText})
  } finally { await off() }
  assert.equal((await remote.routerAgent.recoverEmpty(args)).ok, false, 'an executed session is no longer a blank target')
  await host.sessions.flush(agent.session)
  const after = await persisted(host, id)
  assert.deepEqual(after.slice(0, 4), before)
  assert.equal(after.filter(e => e.type === 'user/message' && e.data.source.rpcId === delivery).length, 1)
  assert.equal(after.filter(e => e.type === 'turn/end').length, 1)
  assert.equal(after.filter(e => e.type === 'model/selection').length, 0)
  assert.deepEqual(calls.slice(count).map(c => c.model), [defaultModel])
  assert.deepEqual(await ids(), original)
  assert.deepEqual(host.agentDefaultModel.currentSelection(), answer)
  console.log('PASS ' + mode + ': implicit adoption denied, explicit recovery only, same original JSONL/default model, one executed delivery')
}

// An unrelated native Session with a router-looking UUID is not router-owned.
// After an explicit owner grant, invalidate its receipt through a REAL native
// turn before the router submits. No second prompt RPC should be emitted.
export async function checkChangedLive({host, remote, cwd, endpoints, calls, provider, defaultModel, targetModel, createDshAdapter}) {
  const requestId = 'ra-ffffff00-8888-4444-9999-111111111111'
  const id = 'session-router-agent-' + requestId, request = {requestId, cwd, sessionId: id}
  const created = await remote.session.create({sessionId: id, cwd})
  assert.equal(created.ok, true); assert.equal(created.value.sessionId, id)
  const agent = host.agents.get(id)
  assertStartup(agent.session)
  assert.equal(await host.sessions.flush(agent.session), true)
  const page = createDshAdapter(remote)
  await page.listSessions([cwd])
  assert.equal((await remote.routerAgent.create({requestId, cwd})).error?.code, 'router-agent/creation-uncertain')
  const guest = host.connection.createPeer({principal: {kind: 'smoke-reader'}, interactions: 'none'})
  host.remoteAccess.registerPolicy('smoke-reader', {bindings: () => [{resource: {kind: 'session', id},
    role: {name: 'fixture', resource: 'session', actions: ['routerAgent/recoverEmpty']}}]})
  await assert.rejects(host.typertGateway.invoke({namespace: 'routerAgent', method: 'recoverEmpty', args: {request}, peer: guest}),
    {code: 'remote-access/denied', details: {action: 'routerAgent/recoverEmpty', reason: 'owner-required'}})
  assert.equal(await page.recoverEmpty(cwd, requestId, id), id)
  assert.deepEqual(agent.model.current(), {provider, model: defaultModel})
  const denied = await remote.routerAgent.configure({sessionId: id, provider, model: targetModel})
  assert.equal(denied.error?.code, 'router-agent/not-owned')
  const initialCursor = await page.cursor(id)
  assert.equal(initialCursor, agent.session.seq - 1)
  const done = Promise.withResolvers(), pos = endpoints.length, count = calls.length
  const off = host.on('session/event', (s,e) => { if (s.id === id && e.type === 'turn/end') done.resolve(e.data) })
  try {
    const reply = await remote.session.prompt({sessionId: id, requestId: 'unrelated-write', mode: 'queue', content: [{type: 'text', text: 'unrelated native input'}]})
    assert.equal(reply.ok, true); assert.equal((await done.promise).reason.kind, 'completed')
  } finally { await off() }
  await assert.rejects(page.deliver(id, 'must-not-send', 'stale grant'))
  assert.equal(endpoints.slice(pos).filter(e => e === 'api/session/prompt').length, 1)
  assert.deepEqual(calls.slice(count).map(c => c.model), [defaultModel])
  assert.equal((await remote.routerAgent.recoverEmpty(request)).ok, false)
  console.log('PASS native live blank: owner can explicitly reuse, not configure; a later native turn invalidates the next router send')
}
