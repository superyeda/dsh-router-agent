import assert from 'node:assert/strict'
import { mkdir, readFile, writeFile } from 'node:fs/promises'
import { join } from 'node:path'
import { panelDOM } from './panel-dom.mjs'
import { multiStep } from './ledger.mjs'

const light = '把 docs/install.md 的 Linux 安装标题中「安裝」改成「安装」。'
const same = 'docs/install.md 里 Linux 安装那一行标题，请把「安裝」写成「安装」，保留标题格式。'
const cold = '在 docs/install.md 的 Linux 安装标题，把「安裝」改成「安装」，不要改其它行。'
const deep = '设计跨区域订单事件系统的容灾架构，比较一致性和可用性的取舍，给出幂等、故障切换与分阶段迁移方案。'
const normal = '实现购物车列表筛选并补单元测试，覆盖成功和错误两种返回。'
const projectName = '北岸文档'
const named = '在' + projectName + '新建会话，' + light
const expectedOutput = text => 'Synthetic execution: ' + text
const contains = (s, part) => typeof s === 'string' && s.includes(part)
const isTitle = s => contains(s, 'docs/install.md') && contains(s, 'Linux') && contains(s, '安裝')
const sameMessage = (a,b) => a?.replace(/[。.!！]+$/u,'') === b.replace(/[。.!！]+$/u,'')

// A deterministic LlmAdapter responder, not a planner: candidate ids/routes
// come solely from the real planner request, never from a host-side Session.
// Deliberately recommends deep for everything to test local tier safeguards.
export function routingModels() {
  const models = {fast:'synthetic-fast', standard:'synthetic-standard', deep:'synthetic-deep'}
  const observations = []
  const gate = Promise.withResolvers(), entered = Promise.withResolvers()
  return {models, observations, gate, entered, active:false, holdFirst:false,
    async respond({model, messages, tools}) {
      if (this.autoResponder) return this.autoResponder({model,messages,tools})
      // DSH appends time-context and other notice messages with role=user.
      // Inspect only the latest synthetic task; never mistake a notice for it.
      const human = messages.filter(m => m.role === 'user').flatMap(m => m.content ?? []).filter(b=>b.type==='text').map(b=>b.text)
      const text = human.findLast(t => [light,same,deep,normal,named,cold,multiStep].some(task=>sameMessage(t,task))) ?? human.at(-1)
      let classify
      try { classify = JSON.parse(text) } catch { /* plain execution message */ }
      if (Array.isArray(classify?.items)) {
        assert.deepEqual(tools, [])
        observations.push({kind:'infer', model})
        return JSON.stringify({items: classify.items.map(i => {
          // Can only quote an actually supplied candidate title or snippet.
          const match = i.candidates?.map(c => ({c, quote: [c.title, ...(c.recent || []), ...(c.workHints || [])].find(isTitle)})).find(c => c.quote && isTitle(i.text))
          return {key:i.key, relation:match?'same':'different', candidate:match?.c.ref ?? null, tier:'deep',
            requestQuote:i.text.slice(0, 32), candidateQuote:match?.quote.slice(0, 60) || ''}
        })})
      }
      assert.equal(typeof text, 'string', 'expected a routed synthetic user message')
      observations.push({kind:'execute', model, text})
      if (this.pause) { this.pause.entered.resolve(text); await this.pause.release.promise }
      if (this.holdFirst) { this.holdFirst=false; entered.resolve(text); await gate.promise }
      return expectedOutput(text)
    },
  }
}

const terminal = new Set(['done','failed','unknown','clarify','input-required'])
function itemAt(doc, text, accepted = false) {
  return doc.until(() => {
    const i = doc.item(text)
    return i && (terminal.has(i.status) || (accepted && i.accepted)) && i
  }, 'unsettled item: ' + text)
}
function status(item, expected) { assert.equal(item.status, expected, (item.error || item.reason) + ' — ' + item.text) }
async function history(host, id) {
  assert.equal(await host.sessions.flush(host.agents.get(id).session), true)
  await using r = await host.sessionPersistence.open(id, 'read')
  return {header:r.header, events:(await r.read()).events}
}

export async function checkRouting({host, native:nativeAPI, cwd, provider, production, legacyRouting, withPanel, endpoints, routing}) {
  const {models} = routing
  const hostDefault = host.agentDefaultModel.currentSelection()
  const localJournal = join(cwd,'synthetic-auto-journal.json')
  async function scenario(plugin, old, label, sessionMode) {
    const gen = join(cwd, label + '-general'), prj = join(cwd, label + '-project')
    for (const path of [gen,prj]) { await mkdir(path); await host.workspaceRegistry.create(path) }
    // A migrated real configuration: the three tiers used to point to the
    // same strongest choice, although this exact provider has distinct models.
    const tiers = Object.fromEntries(Object.keys(models).map(k => [k,{provider,model:models.deep,effort:''}]))
    const doc = panelDOM({generalDir:gen, projects:[{name:projectName,path:prj}], tiers, modelMode:'auto',autoProvider:provider,...(sessionMode?{sessionMode}:{})})
    const start = routing.observations.length
    await withPanel(plugin, doc, false, async reopen => {
      if (old) {
        await doc.submit(light)
        status(await itemAt(doc, light), 'clarify')
        assert.equal(routing.observations.slice(start).some(x => x.kind === 'execute'), false)
        await doc.submit(named)
        const made = await itemAt(doc, named); status(made, 'done')
        const agent = host.agents.get(made.sessionId)
        assert.equal(agent.model.current().model, models.deep)
        assert.equal(agent.session.header.cwd, prj); assert.equal(agent.session.header.agentPreset, 'ptc')
        assert.deepEqual(routing.observations.slice(start).filter(x=>x.kind==='execute').map(x=>x.model),[models.deep])
        await doc.submit(same)
        const duplicate = await itemAt(doc, same)
        status(duplicate,'done'); assert.equal(duplicate.decision,'create'); assert.equal(duplicate.project,gen)
        assert.notEqual(duplicate.sessionId,made.sessionId)
        console.log('REPRO 0.1.2 panel: unnamed single project → clarify; named typo executed via deep in host-default ptc; unnamed paraphrase → NEW session in general directory')
        return
      }
      if (sessionMode) {
        // A separate clean panel proves an explicit override as well as the
        // absence of migration residue from the first page's browser journal.
        await doc.submit(normal)
        const i = await itemAt(doc, normal); status(i,'done')
        assert.equal(i.project,prj); assert.equal(i.tier,'standard')
        assert.equal(i.agentPreset, sessionMode === 'inherit' ? undefined : sessionMode, 'explicit mode and inheritance must differ in the persisted creation intent')
        assert.equal(host.agents.get(i.sessionId).session.header.agentPreset, sessionMode === 'inherit' ? 'ptc' : sessionMode)
        assert.deepEqual(routing.observations.slice(start).filter(x => x.kind === 'execute').map(x => x.model), [models.standard])
        console.log('PASS panel ' + sessionMode + ': medium work ran on real standard model, preset=' + host.agents.get(i.sessionId).session.header.agentPreset)
        return
      }
      routing.holdFirst = true
      await doc.submit(light)
      const first = await itemAt(doc, light, true)
      assert.ok(first.accepted, (first.error || first.reason) + ' — ' + light)
      assert.equal(first.decision,'create'); assert.equal(first.project, prj)
      const activeText = await routing.entered.promise // synthetic provider holds the REAL first Agent turn open
      assert.ok(sameMessage(activeText, first.text), 'unexpected execution input: ' + activeText)
      const id = first.sessionId
      const target = host.agents.get(id)
      const initialModel = target.model.current().model
      assert.equal(target.session.header.agentPreset,'standard', 'new sessions default to ordinary, even when Host defaults to PTC')
      const projection = await nativeAPI.session.projections({sessionId:id})
      assert.ok(projection.ok); assert.ok(!projection.value.values.title, 'no useful title should be available for this fresh live target')
      assert.notEqual(target.status,'idle')
      const before = endpoints.length
      // Unmount the actual board and create a new controller/adapter. Only its
      // persisted browser journal and the same live Host survive this step.
      await reopen(); await doc.submit(same)
      const second = await itemAt(doc, same, true)
      assert.ok(second.accepted, (second.error || second.reason) + ' — ' + same)
      assert.equal(second.decision, 'reuse'); assert.equal(second.sessionId, id); assert.equal(second.project, prj)
      assert.deepEqual(endpoints.slice(before).filter(e=>['api/routerAgent/create','api/routerAgent/configure','api/session/prompt'].includes(e)), ['api/session/prompt'])
      assert.equal(routing.observations.slice(start).filter(x=>x.kind==='execute').length,1,'second user input did not queue behind first')
      routing.gate.resolve()
      status(await itemAt(doc, light),'done'); status(await itemAt(doc, same),'done')
      await doc.submit(deep)
      const third = await itemAt(doc,deep); status(third,'done')
      assert.equal(third.decision,'create'); assert.equal(third.project,prj); assert.equal(third.tier,'deep'); assert.notEqual(third.sessionId, id)
      const inProject = (await host.sessionPersistence.list()).filter(s=>s.header.cwd===prj).map(s=>s.header.id).sort()
      assert.deepEqual(inProject, [id,third.sessionId].sort(), 'no spare/duplicate Sessions')
      const a = await history(host,id), b = await history(host,third.sessionId)
      assert.equal(a.header.cwd,prj); assert.equal(b.header.cwd,prj)
      assert.equal(a.header.agentPreset,'standard'); assert.equal(b.header.agentPreset,'standard')
      assert.deepEqual(a.events.filter(e=>e.type==='user/message' && e.data.source?.kind==='user').map(e=>e.data.source.rpcId),[first.requestId,second.requestId])
      assert.deepEqual(b.events.filter(e=>e.type==='user/message' && e.data.source?.kind==='user').map(e=>e.data.source.rpcId),[third.requestId])
      assert.deepEqual([first.tier,initialModel],['fast',models.fast], 'actual first work and execution tier')
      assert.deepEqual(a.events.filter(e=>e.type==='model/selection').map(e=>e.data.model),[models.fast])
      assert.deepEqual(b.events.filter(e=>e.type==='model/selection').map(e=>e.data.model),[models.deep])
      assert.deepEqual(routing.observations.slice(start).filter(x=>x.kind==='execute').map(x=>[x.model,x.text]),[[models.fast,first.text],[models.fast,second.text],[models.deep,third.text]])
      const inferences = routing.observations.slice(start).filter(x=>x.kind==='infer')
      assert.ok(inferences.length && inferences.every(x=>x.model===models.fast),'classification must actually execute, only on fast')
      await writeFile(localJournal,doc.snapshot(),{flag:'wx',mode:0o600}) // private, disposable browser fixture
      console.log('PASS one unnamed project: fast typo → busy/page-reentry paraphrase reuses SAME session without create/configure → unrelated architecture uses distinct deep Agent; confirmed by JSONL and model calls')
    })
  }
  routing.active = true
  try {
    assert.equal((await host.agentPresets.resolve()).id, 'ptc')
    if (process.env.DSH_SMOKE_PHASE === 'routing-cold') {
      const doc = panelDOM(undefined, await readFile(localJournal,'utf8')), original = doc.item(light)
      const id = original.sessionId, project = original.project
      const ids = async () => (await host.sessionPersistence.list()).filter(s=>s.header.cwd===project).map(s=>s.header.id).sort()
      const before = await ids()
      assert.equal(host.agents.get(id),undefined, 'target is genuinely cold after full process restart')
      const cut = await nativeAPI.session.projections({sessionId:id})
      assert.ok(cut.ok); assert.ok(!cut.value.values.title); assert.equal(host.agents.get(id),undefined)
      await withPanel(production,doc,false,async()=>{
        const start = endpoints.length
        await doc.submit(cold)
        const i = await itemAt(doc,cold); status(i,'done')
        assert.equal(i.decision,'reuse'); assert.equal(i.sessionId,id); assert.equal(i.agentPreset,undefined)
        assert.deepEqual(endpoints.slice(start).filter(e=>['api/routerAgent/create','api/routerAgent/configure','api/session/prompt'].includes(e)),['api/session/prompt'])
        assert.deepEqual(await ids(),before)
        const {header,events}=await history(host,id)
        assert.equal(header.agentPreset,'standard'); assert.equal(header.cwd,project)
        assert.deepEqual(events.filter(e=>e.type==='model/selection').map(e=>e.data.model),[models.fast])
        assert.deepEqual(events.filter(e=>e.type==='user/message' && e.data.source?.kind==='user').map(e=>e.data.source.rpcId),[original.requestId,doc.item(same).requestId,i.requestId])
        assert.deepEqual(routing.observations.filter(x=>x.kind==='execute').map(x=>x.model),[models.fast])
        assert.deepEqual(host.agentDefaultModel.currentSelection(),hostDefault); assert.equal((await host.agentPresets.resolve()).id, 'ptc')
        console.log('PASS fresh PID + restored browser journal: untitled completed session resumed on same fast Agent ID, with no create/configure')
      })
      return
    }
    if (legacyRouting) await scenario(legacyRouting, true, 'legacy')
    await scenario(production, false, 'explicit-standard', 'standard')
    await scenario(production, false, 'explicit-ptc', 'ptc')
    await scenario(production, false, 'inherit', 'inherit')
    await scenario(production, false, 'auto')
    assert.equal((await host.agentPresets.resolve()).id, 'ptc')
    assert.deepEqual(host.agentDefaultModel.currentSelection(),hostDefault)
  } finally { routing.gate.resolve(); routing.active = false }
}
