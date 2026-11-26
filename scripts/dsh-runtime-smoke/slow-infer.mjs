import assert from 'node:assert/strict'
import { mkdir } from 'node:fs/promises'
import { join } from 'node:path'
import { setTimeout as delay } from 'node:timers/promises'
import { panelDOM } from './panel-dom.mjs'

// Neither display label shares even a character with the request. The paths
// are opaque and the default and the first configured project are both WRONG.
export const semanticRequest = '按今晚的流星雨概率，实现逐小时亮度曲线。'
const labels = ['古籍装帧', '天象观测']
const requestQuote = '流星雨概率'
const latency = 7300 // real wall-clock delay, intentionally beyond the old 6500 ms planner deadline

export async function semanticSettings(host, base, tiers) {
  const projects = []
  for (const [n, code] of ['u17', 'u42'].entries()) {
    const path = join(base, code), name = labels[n]
    assert.ok(!Array.from(name).some(c => semanticRequest.includes(c)))
    await mkdir(path, {recursive: true}); await host.workspaceRegistry.create(path, name)
    projects.push({path, name})
  }
  return {projects, defaultProject:projects[0].path, generalDir:projects[0].path, routingMode:'auto', modelMode:'manual', tiers}
}

// The (synthetic) inference can recommend only the pN handle actually offered
// for the semantic label. No host directory, session, generated task or tools.
export function semanticReply({messages, tools}) {
  assert.deepEqual(tools, [])
  const raw = messages[0]?.content?.[0]?.text
  assert.deepEqual(messages, [{role:'user', content:[{type:'text', text:raw}]}])
  const {items} = JSON.parse(raw)
  assert.equal(items.length, 1)
  const [i] = items
  assert.equal(i.text, semanticRequest); assert.deepEqual(i.candidates, [])
  assert.equal(i.projects?.length, 2); assert.doesNotMatch(raw, /\/private\/tmp|session-router-agent-/u)
  for (const name of labels) {
    const matches = i.projects.filter(p => p.labels.includes(name))
    assert.equal(matches.length, 1); assert.deepEqual(matches[0].evidence, [], 'no local lexical evidence may choose this directory')
  }
  const p = i.projects.find(p => p.labels.includes(labels[1]))
  assert.match(p.ref, /^p\d+$/); assert.ok(i.text.includes(requestQuote))
  return JSON.stringify({items:[{key:i.key, relation:'different', candidate:null, tier:'standard', requestQuote, candidateQuote:'', project:p.ref, projectQuote:labels[1]}]})
}

// An in-process Host Fetch handler returns a Response even on server errors.
// A browser fetch additionally rejects its *client* promise when the Request is
// aborted. Preserve that carrier behavior without manufacturing any RPC result,
// code or message. Typert itself creates the gateway/cancelled error for v0.2.1.
export async function inferFetch(handler, request, owner, trace) {
  const {signal} = request; signal.throwIfAborted()
  const entry = {start:performance.now()}, cancelled = Promise.withResolvers()
  trace.push(entry)
  const abort = () => {entry.aborted = performance.now(); cancelled.reject(signal.reason)}
  signal.addEventListener('abort', abort, {once:true})
  try {return await Promise.race([handler.fetch(request, owner), cancelled.promise])}
  finally {signal.removeEventListener('abort', abort)}
}

export async function checkSlowInfer({old, host, withPanel, plugin, routing, endpoints, provider, cwd}) {
  const {models} = routing
  const tiers = Object.fromEntries(Object.entries(models).map(([tier, model]) => [tier, {provider,model,effort:''}]))
  const settings = await semanticSettings(host, cwd, tiers), doc = panelDOM(settings)
  const expected = settings.projects[old ? 0 : 1].path
  const receipt = 'Synthetic slow comparison: ' + semanticRequest
  const calls = [], warnings = new Set(), defaults = host.agentDefaultModel.currentSelection()
  const stop = doc.onChange(() => {
    const warning = doc.root.find(n => doc.visible(n) && /意图模型不可用|(?:routerAgent\/infer.{0,60}aborted)/iu.test(n.data))
    if (warning) warnings.add(warning.data)
  })
  routing.active = true
  routing.autoResponder = async options => {
    const {model, system, signal, messages} = options
    if (typeof system === 'string' && system.startsWith('你是只读的中文任务分流分类器')) {
      const text = semanticReply(options)
      const call = {kind:'infer', model, start:performance.now()}; calls.push(call)
      try {
        await delay(latency, undefined, {signal}); call.returned = performance.now(); return text
      } catch (err) {if (signal.aborted) call.aborted = performance.now(); throw err}
    }
    // Time-context contributes other role=user notices; the human message
    // must reach the executing adapter intact, once, through the stock loop.
    const input = messages.filter(m => m.role === 'user').flatMap(m => m.content ?? []).filter(b => b.type === 'text').map(b => b.text)
    assert.deepEqual(input.filter(t => t === semanticRequest), [semanticRequest]); calls.push({kind:'execute', model})
    return receipt
  }
  const completed = Promise.withResolvers()
  const off = host.on('session/event', (s,e) => {
    if (e.type==='turn/end') completed.resolve({id:s.id, reason:e.data.reason.kind})
  })
  try {
    assert.deepEqual(await host.sessionPersistence.list(), [])
    await withPanel(plugin, doc, false, async reopen => {
      const from = endpoints.length
      await doc.submit(semanticRequest) // only submission; no choose/create/reuse/retry
      const first = await doc.until(() => {
        const i = doc.item(semanticRequest)
        return i && (i.accepted || ['failed','clarify','unknown','input-required','handoff'].includes(i.status)) && i
      }, 'semantic submission not accepted', 20_000)
      assert.ok(first.accepted, first.error || first.reason)
      assert.deepEqual(await completed.promise, {id:first.sessionId, reason:'completed'})
      // 0.2.1 can queue an obsolete UI tick during planning and read between
      // turn/start and user/message. Reopening *only the old panel* reads the
      // durable outcome; the candidate must reach done on the ORIGINAL mount.
      if (old) await reopen()
      const done = await doc.until(() => {const i = doc.item(semanticRequest); return i?.status==='done' && i}, 'no final receipt for completed native turn')
      assert.deepEqual([done.sessionId,done.requestId], [first.sessionId,first.requestId])
      assert.equal(done.status, 'done', done.error || done.reason)
      assert.equal(done.decision, 'create'); assert.ok(done.accepted); assert.equal(done.result, receipt)
      assert.deepEqual([done.text,done.project], [semanticRequest,expected], done.reason)
      assert.match(done.reason, old ? /默认项目/u : /模型.*核验/u)
      const stored = JSON.parse(doc.snapshot()).tasks
      assert.equal(stored.length, 1); assert.equal(stored[0].text, semanticRequest); assert.equal(stored[0].items.length, 1)
      assert.deepEqual(endpoints.slice(from).filter(s => s.startsWith('api/routerAgent/') || s==='api/session/prompt'),
        ['api/routerAgent/infer','api/routerAgent/create','api/routerAgent/configure','api/session/prompt'])
      assert.deepEqual(calls.map(c => [c.kind,c.model]), [['infer',models.fast],['execute',models.standard]])
      assert.equal(routing.inferTrace.length, 1)
      const [rpc] = routing.inferTrace, [modelCall] = calls
      let elapsed
      if (old) {
        elapsed = Math.round(rpc.aborted-rpc.start)
        assert.ok(elapsed >= 6000 && !modelCall.returned && modelCall.aborted, 'expected old client to abort pending inference, got '+JSON.stringify({rpc, modelCall}))
        assert.match([...warnings].join('\n'), /意图模型不可用.*Remote invocation "routerAgent\/infer" was aborted/iu)
      } else {
        elapsed = Math.round(modelCall.returned-modelCall.start)
        assert.ok(elapsed >= 7000 && !rpc.aborted && !modelCall.aborted, 'the actual delayed model reply was not received: '+JSON.stringify({rpc,modelCall}))
        assert.deepEqual([...warnings], [], 'false classification error surfaced on the production form')
      }
      const id = done.sessionId, agent = host.agents.get(id)
      assert.equal(agent.session.header.cwd, expected); assert.equal(agent.session.header.agentPreset,'standard')
      assert.deepEqual(agent.model.current(), {provider, model:models.standard}); assert.deepEqual(host.agentDefaultModel.currentSelection(), defaults)
      assert.equal(await host.sessions.flush(agent.session), true)
      assert.deepEqual((await host.sessionPersistence.list()).map(s => s.header.id), [id], 'orphaned/duplicate Session')
      await using reader = await host.sessionPersistence.open(id, 'read')
      assert.equal(reader.header.cwd, expected)
      const {events} = await reader.read()
      assert.deepEqual(events.filter(e => e.type==='model/selection').map(e => e.data.model), [models.standard])
      assert.deepEqual(events.filter(e => e.type==='user/message' && e.data.source?.kind==='user').map(e => [e.data.source.rpcId,e.data.content]),
        [[done.requestId,[{type:'text',text:semanticRequest}]]])
      assert.deepEqual(events.filter(e => e.type==='turn/end').map(e => e.data.reason.kind), ['completed'])
      console.log(old
        ? 'REPRO 0.2.1: '+elapsed+' ms → '+[...warnings][0]+'; fell back to u17; 1 infer / 1 create / 1 configure / 1 exact prompt / 1 JSONL turn'
        : 'PASS slow semantic intent: '+elapsed+' ms, verified project quote → u42 instead of default u17, no abort/warning; 1 infer / 1 create / 1 configure / 1 exact prompt / 1 JSONL turn')
    })
  } finally {await off(); stop(); delete routing.autoResponder; routing.active = false}
}
