import assert from 'node:assert/strict'
import { mkdir } from 'node:fs/promises'
import { join } from 'node:path'
import { panelDOM } from './panel-dom.mjs'

export const multiStep = `在北岸文档，先给 docs/guide.md 的入门标题加上版本号。
然后给同一文档末尾补一个示例。
最后检查两处格式，并一起汇总结果。`

const attr = (el,k) => el.getAttribute(k)
const all = (node,test) => [...(test(node)?[node]:[]), ...node.children.flatMap(child=>all(child,test))]
const level = name => n=>attr(n,'data-ledger-level')===name
const toggle = name => n=>n.tag==='button' && attr(n,'data-ledger-toggle')===name
const isDemand = n => attr(n,'data-task-id')!==null
const normalized = s => s.replace(/\s+/gu,' ').trim()
const ctrl = e => e.startsWith('api/routerAgent/') || e==='api/session/prompt'
// Allow ordinary background reads. Any new mutation (including archive, stop,
// prompt or configure) must fail this check, even if it leaves no local card.
const readonly = trace => {for (const endpoint of trace) assert.match(endpoint, /^api\/session\/(?:state|list|projections|events|page)$/, 'unexpected RPC while viewing/clearing: '+endpoint)}
const textOf = m => m?.content?.filter(b=>b.type==='text').map(b=>b.text).join('')
const human = rows => rows.filter(e=>e.type==='user/message' && e.data?.source?.kind==='user')
async function rows(host,id) {
  assert.equal(await host.sessions.flush(host.agents.get(id).session), true)
  await using handle=await host.sessionPersistence.open(id,'read')
  return (await handle.read()).events
}

// No React renderer in this process. The production page still authenticates,
// elects its own side-panel target, checks native scope and retains it. Observe
// the reference at the exact boundary where RouterPage would create a portal;
// never fake Conversation DOM or report that a click answered any interaction.
export async function checkLedger({host,client,production,withPanel,endpoints,streams,navigations,routing,provider,cwd}) {
  const project=join(cwd,'single-record-project')
  await mkdir(project); await host.workspaceRegistry.create(project,'北岸文档')
  const tiers=Object.fromEntries(Object.keys(routing.models).map(k=>[k,{provider,model:routing.models[k],effort:''}]))
  const doc=panelDOM({generalDir:cwd,projects:[{name:'北岸文档',path:project}],modelMode:'auto',autoProvider:provider,tiers})
  const pause={entered:Promise.withResolvers(),release:Promise.withResolvers()}, mounts=[], closes=[]
  const ids=async()=>(await host.sessionPersistence.list()).filter(s=>s.header.cwd===project).map(s=>s.header.id)
  const display=(target,reference)=>{
    assert.ok(doc.root.contains(target),'session target must be inside the existing task board')
    mounts.push({target,reference}); doc.changed()
    return ()=>{closes.push(reference.sessionId);doc.changed()}
  }
  const initialTrace=endpoints.length, firstObservation=routing.observations.length
  routing.active=true; routing.pause=pause
  try {
    assert.deepEqual(await ids(),[])
    await withPanel(production,doc,false,async()=>{
      await doc.submit(multiStep)
      const task=await doc.until(()=>{const t=doc.task(multiStep);return t?.items.some(i=>i.accepted || ['clarify','failed','unknown'].includes(i.status)) && t},'no initial receipt for whole message')
      assert.equal(task.items.length,1,'one submission must create one item, not a fan-out plan')
      const [item]=task.items; assert.ok(item.accepted,item.error || item.reason)
      const id=item.sessionId
      assert.deepEqual(item.dependsOn??[],[]); assert.equal(item.text,multiStep)
      assert.equal(await pause.entered.promise,multiStep,'every line and punctuation mark reaches the executing model')
      // Explicit sole project + fixed edit tier + no prior Session: advisory
      // inference cannot change this decision. Keep every write RPC exact.
      assert.deepEqual(await ids(),[id]); assert.deepEqual(endpoints.slice(initialTrace).filter(ctrl),['api/routerAgent/create','api/routerAgent/configure','api/session/prompt'])
      const originals=await rows(host,id), input=human(originals)
      assert.deepEqual(input.map(e=>[e.data.source.rpcId,textOf(e.data)]),[[item.requestId,multiStep]])
      const trace=endpoints.length, streamStart=streams.length, nav=navigations.length
      const history=await doc.until(()=>doc.root.find(n=>attr(n,'aria-label')==='任务历史' && doc.visible(n) && n.find(level('project'))),'missing project history')
      function only(scope,predicate,label) {
        const matches=all(scope,predicate);assert.equal(matches.length,1,label);assert.ok(doc.visible(matches[0]),label+' is hidden');return matches[0]
      }
      const p=only(history,level('project'),'one visible project'), projectKey=attr(p,'data-ledger-project')
      assert.ok(projectKey);assert.ok(p.textContent.includes(project),'project must show the saved cwd')
      // Observe A before any disclosure, B after *project only*, C after
      // *session also*. Same production task, exact ID; no injected journal.
      function noDemand() {
        assert.equal(all(history,isDemand).length,0,'collapsed history must have no demand nodes, even hidden ones')
        assert.ok(!normalized(history.textContent).includes(normalized(multiStep)),'collapsed history leaked the demand text')
      }
      function noHostAction() {
        assert.deepEqual(mounts,[]);assert.equal(navigations.length,nav)
        assert.deepEqual(streams.slice(streamStart),[],'a disclosure must never start a remote stream')
        readonly(endpoints.slice(trace)) // ongoing receipt observation may read, never write
        assert.equal(client.sessions.retainInfo(id).getSnapshot().referenceCount,0,'browsing is not a retain')
      }
      assert.equal(attr(only(p,toggle('project'),'native project toggle'),'aria-expanded'),'false')
      assert.equal(all(history,level('session')).length,0);noDemand();noHostAction()
      await doc.click(toggle('project'),p,'expand only the project')
      assert.equal(attr(only(p,toggle('project'),'expanded project toggle'),'aria-expanded'),'true')
      const session=only(p,level('session'),'one visible session in the project'), sessionKey=attr(session,'data-ledger-session')
      assert.ok(sessionKey);assert.ok(session.textContent.includes(id),'session must show the exact original id')
      assert.equal(attr(only(session,toggle('session'),'native session toggle'),'aria-expanded'),'false');noDemand();noHostAction()
      await doc.click(toggle('session'),session,'expand only the session')
      assert.equal(attr(only(session,toggle('session'),'expanded session toggle'),'aria-expanded'),'true')
      const card=only(history,isDemand,'one visible demand after both disclosures');assert.ok(session.contains(card));assert.equal(attr(card,'data-task-id'),task.id)
      only(card,n=>normalized(n.data)===normalized(multiStep) && doc.visible(n),'the compact demand shows the complete three-line summary')
      assert.equal(doc.root.find(n=>n.tag==='button' && n.textContent==='清理已完成').disabled,true,'live receipt is not cleanable')
      const details=only(card,n=>n.tag==='button' && n.textContent==='展开详情','compact demand details toggle')
      assert.equal(attr(details,'aria-expanded'),'false','live record must remain collapsed by default')
      await doc.click(n=>n===details,card,'inspect the exact multi-line original')
      only(card,n=>n.data===multiStep && doc.visible(n),'one verbatim original, with newlines and punctuation')
      assert.equal(only(card,n=>n.tag==='button' && n.textContent==='删除记录','live record removal').disabled,true)
      await doc.click(n=>n.textContent==='收起详情',card,'collapse the demand details')
      await doc.click(toggle('session'),session,'collapse to the session only');noDemand()
      assert.equal(attr(only(session,toggle('session'),'closed session toggle'),'aria-expanded'),'false')
      assert.deepEqual(await rows(host,id),originals,'browsing the hierarchy must append no native events');noHostAction()
      const open=n=>attr(n,'data-ledger-open')==='session'
      await doc.click(open,session,'explicitly open the verified original session')
      const pane=await doc.until(()=>doc.root.find(n=>n.tag==='aside' && attr(n,'aria-label')==='原会话侧栏' && doc.visible(n)),'no inline aside')
      const {target,reference}=await doc.until(()=>mounts[0],'native conversation portal received no retained reference')
      assert.ok(pane.contains(target)); assert.equal(reference.sessionId,id)
      assert.equal(attr(target,'data-router-native-session'),id)
      assert.equal(client.sessions.retainInfo(id).getSnapshot().retainedBy.routerPane,1)
      const binding=await reference.ready; assert.equal(binding.sessionId,id)
      const events=binding.eventSource.getSnapshot().entries.filter(x=>x.type==='event').map(x=>x.event)
      assert.deepEqual(human(events).map(e=>[e.data.source.rpcId,textOf(e.data)]),[[item.requestId,multiStep]])
      assert.equal(binding.session.getSnapshot().running,true)
      // The original compact record shortcut still works. Choosing the same
      // source from the already-mounted group must reuse its one native lease.
      await doc.click(toggle('session'),session,'reopen the session demand list')
      const liveCard=only(session,n=>attr(n,'data-task-id')===task.id,'same demand after reopening')
      assert.equal(attr(only(liveCard,n=>n.tag==='button' && n.textContent==='展开详情','still compact'),'aria-expanded'),'false')
      await doc.click(n=>attr(n,'data-action')==='view-session',liveCard,'view the same original from its demand')
      assert.equal(mounts.length,1);assert.equal(closes.length,0);assert.equal(client.sessions.retainInfo(id).getSnapshot().retainedBy.routerPane,1)
      const follow=streams.slice(streamStart).filter(s=>s.endpoint.endsWith('session/follow'))
      assert.equal(follow.length,1,JSON.stringify(streams.slice(streamStart)))
      const req=follow[0].payload.args.request
      assert.deepEqual(req.address,{kind:'session',sessionId:id}); assert.equal(req.activate,true); assert.equal(req.assistantStream,true)
      assert.deepEqual(await rows(host,id),originals,'opening and reading must not append any native event')
      await doc.click(n=>n.textContent==='关闭侧栏',pane,'close session pane without navigating')
      await doc.until(()=>closes.length===1,'portal remained mounted after closing')
      assert.deepEqual(closes,[id]); assert.equal(client.sessions.retainInfo(id).getSnapshot().referenceCount,0)
      assert.equal(navigations.length,nav); readonly(endpoints.slice(trace))
      assert.deepEqual(await rows(host,id),originals,'closing must be read-only')
      pause.release.resolve()
      const done=await doc.until(()=>{const i=doc.item(multiStep);return i && ['done','failed','unknown'].includes(i.status) && i},'multi-step result did not settle')
      assert.equal(done.status,'done',done.error || done.reason); assert.equal(done.result,'Synthetic execution: '+multiStep)
      const final=await rows(host,id), beforeClear=endpoints.length
      await doc.click(n=>n.textContent==='清理已完成',doc.root,'clean completed records')
      assert.equal(doc.task(multiStep).id,task.id,'initial click alone cannot delete')
      await doc.click(n=>n.textContent==='确认清理已完成记录',doc.root,'confirm local cleanup')
      await doc.until(()=>!doc.task(multiStep),'completed record survived explicit cleanup')
      await doc.until(()=>!all(doc.root,level('project')).length,'empty project survived deletion of its sole demand')
      assert.equal(all(doc.root,level('session')).length,0);assert.equal(all(doc.root,isDemand).length,0)
      assert.deepEqual(await ids(),[id]); assert.deepEqual(await rows(host,id),final)
      assert.equal(mounts.length,1);assert.equal(streams.slice(streamStart).filter(s=>s.endpoint.endsWith('session/follow')).length,1)
      readonly(endpoints.slice(beforeClear)); assert.equal(navigations.length,nav)
      assert.equal(endpoints.slice(initialTrace).filter(p=>p==='api/session/prompt').length,1)
      assert.deepEqual(routing.observations.slice(firstObservation).filter(x=>x.kind==='execute').map(x=>x.text),[multiStep])
      console.log('PASS production ledger: project only (0 sessions / 0 demands) → project open (1 session / 0 demands) → session open (1 demand, same task id and original); disclosures: 0 mounts / 0 streams / 0 writes / 0 navigation. 1 native Agent / 1 exact prompt; explicit live pane kept same id and readonly log; confirmed cleanup removed the empty local groups only')
    },display)
  } finally {pause.release.resolve();delete routing.pause;routing.active=false}
}
