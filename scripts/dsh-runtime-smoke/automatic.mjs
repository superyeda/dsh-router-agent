import assert from 'node:assert/strict'
import {mkdir} from 'node:fs/promises'
import {join} from 'node:path'
import {panelDOM} from './panel-dom.mjs'

// Fictional owner-approved workspaces, not production profile data. Candidate
// order puts the correct first destination LAST and neither path contains any
// domain word. The messages name no workspace, model, directory or session.
const tide='潮汐浮标读数里那个凌晨尖峰，不太对劲。'
const pronoun='刚才那个，再展开一点。'
const other='潮汐浮标的锚链编号清册，缺一行备用浮标的出厂标记。'
const kiln='窑火釉色的试烧温度曲线，第三段还差一个对照。'
const again='继续。'
const everyday='午休能吃的小点心，咸味就好。'
const distractor='旧海报里的红色页码和展台标签。'
const routeWrite=s=>['api/routerAgent/create','api/routerAgent/configure','api/session/prompt'].includes(s)
const human=e=>e.type==='user/message' && e.data?.source?.kind==='user'
const texts=e=>e.data.content.filter(b=>b.type==='text').map(b=>b.text).join('')
const completed=new Set(['clarify','done','failed','unknown','input-required','waiting','handoff'])
const reply=text=>'Synthetic automatic execution: '+text

// An explicit, model-independent negative control: the classifier can quote an
// incoming item but NEVER recommends any project, session or continuation.
// Even if the frozen classifier is unavailable, the executor must see only the
// original human message, never a re-planned rewrite or a hidden handoff.
function frozen(known,calls) {
  return ({model,messages,tools})=>{
    const input=messages.filter(m=>m.role==='user').flatMap(m=>m.content??[]).filter(b=>b.type==='text').map(b=>b.text)
    for (const t of input) {
      let json;try {json=JSON.parse(t)} catch {continue}
      if (!Array.isArray(json?.items)) continue
      assert.deepEqual(tools,[]); calls.push({kind:'infer',model})
      return JSON.stringify({items:json.items.map(i=>({key:i.key,relation:'different',candidate:null,tier:'standard',requestQuote:i.text.slice(0,32),candidateQuote:''}))})
    }
    // DSH time-context contributes additional role=user messages.
    const text=input.findLast(t=>known.includes(t)); assert.ok(text,'unrecognized routed user text')
    calls.push({kind:'execute',model,text}); return reply(text)
  }
}
async function messages(host,id) {
  assert.equal(await host.sessions.flush(host.agents.get(id).session),true)
  await using r=await host.sessionPersistence.open(id,'read')
  return (await r.read()).events.filter(human).map(e=>[e.data.source.rpcId,texts(e)])
}
async function conflictingNative({host,remote,where}) {
  const id='session-smoke-native-decoy', result=await remote.session.create({sessionId:id,cwd:where})
  assert.ok(result.ok); assert.equal(result.value.sessionId,id)
  const done=Promise.withResolvers(), off=host.on('session/event',(s,e)=>{if(s.id===id && e.type==='turn/end') done.resolve(e.data)})
  try {
    const r=await remote.session.prompt({sessionId:id,requestId:'native-decoy-receipt',mode:'queue',content:[{type:'text',text:distractor}]})
    assert.ok(r.ok);assert.equal((await done.promise).reason.kind,'completed')
  } finally {await off()}
  return id
}

export async function checkAutomatic({host,native,production,old,withPanel,routing,endpoints,cwd,provider}) {
  const calls=[]
  const defaults=host.agentDefaultModel.currentSelection(), permissions=[]
  for(const [part,name] of Object.entries({amber:'潮汐浮标观测站',blue:'窑火釉色工坊',general:'通用目录',excluded:'未授权目录'})) {
    // routing.mjs also uses auto-general in the shared full-suite scratch.
    const path=join(cwd,'decision-fixture-'+part);await mkdir(path);await host.workspaceRegistry.create(path,name);permissions.push({name,path})
  }
  const [a,b,g,x]=permissions, denied='这次只在 '+x.path+' 修改记录。'
  const known=[tide,pronoun,other,kiln,again,everyday,distractor,denied]
  const settings={generalDir:g.path,projects:[b,a],modelMode:'manual',tiers:Object.fromEntries(Object.entries(routing.models).map(([t,model])=>[t,{provider,model,effort:''}]))}
  // Deliberately absent routingMode/defaultProject: upgrade defaults matter.
  const entries=async()=>(await host.sessionPersistence.list()).filter(s=>permissions.some(w=>w.path===s.header.cwd)).map(s=>s.header.id).sort()
  async function submit(doc,text,expected,directory) {
    const rpc=endpoints.length, call=calls.length
    await doc.submit(text) // only interaction; never choose/resolve/create manually
    const t=await doc.until(()=>{const v=doc.task(text);return v && (v.items.length!==1 || completed.has(v.items[0].status)) && v},'unsettled automatic message: '+text)
    assert.equal(t.text,text);assert.equal(t.items.length,1);const [i]=t.items
    const info=JSON.stringify({status:i.status,decision:i.decision,project:i.project,reason:i.reason,error:i.error})
    assert.equal(i.text,text,info);assert.equal(i.decision,expected,info)
    const write=endpoints.slice(rpc).filter(routeWrite), ran=calls.slice(call).filter(x=>x.kind==='execute')
    if(expected==='clarify') {
      assert.equal(i.status,'clarify',info);assert.ok(!i.attempted && !i.accepted,info)
      assert.deepEqual(write,[]);assert.deepEqual(ran,[])
    } else {
      assert.equal(i.status,'done',info);assert.equal(i.project,directory,info);assert.equal(i.result,reply(text),info)
      assert.equal(host.agents.get(i.sessionId).session.header.cwd,directory)
      assert.deepEqual(write,expected==='create'?['api/routerAgent/create','api/routerAgent/configure','api/session/prompt']:['api/session/prompt'])
      assert.deepEqual(ran.map(x=>x.text),[text]);assert.deepEqual((await messages(host,i.sessionId)).at(-1),[i.requestId,text])
    }
    return i
  }
  routing.active=true;routing.autoResponder=frozen(known,calls)
  try {
    if(old) {
      const doc=panelDOM(settings)
      await withPanel(old,doc,false,async()=>{
        for(const t of [tide,pronoun,other,kiln]) await submit(doc,t,'clarify')
        assert.deepEqual(await entries(),[])
      })
      console.log('REPRO 0.2.0 production form: zero executions; two authorized projects and no default, ordinary domain messages and deictic request stop at clarify')
    }
    const doc=panelDOM(settings)
    await withPanel(production,doc,false,async reopen=>{
      const first=await submit(doc,tide,'create',a.path); const sid=first.sessionId
      const nativeId=await conflictingNative({host,remote:native,where:b.path})
      const roster=await native.session.list({});assert.ok(roster.ok)
      const rows=roster.value.items;assert.ok(Array.isArray(rows)); const recent=id=>rows.find(r=>r.sessionId===id)?.updatedAt
      assert.ok(typeof recent(sid)==='number' && recent(nativeId)>recent(sid),'the native distractor must be strictly newer than the first accepted routed Session')
      await reopen() // replace adapter/controller; only this owner-approved journal persists
      const before=await entries(), carried=await submit(doc,pronoun,'reuse',a.path)
      assert.equal(carried.sessionId,sid);assert.notEqual(carried.sessionId,nativeId);assert.deepEqual(await entries(),before)
      const independent=await submit(doc,other,'create',a.path);assert.notEqual(independent.sessionId,sid)
      const cross=await submit(doc,kiln,'create',b.path);assert.ok(![sid,independent.sessionId,nativeId].includes(cross.sessionId))
      const follow=await submit(doc,again,'reuse',b.path);assert.equal(follow.sessionId,cross.sessionId)
      const casual=await submit(doc,everyday,'create',g.path);assert.ok(![sid,independent.sessionId,cross.sessionId,nativeId].includes(casual.sessionId))
      const final=await entries();assert.deepEqual(final,[sid,independent.sessionId,cross.sessionId,nativeId,casual.sessionId].sort())
      await submit(doc,denied,'clarify');assert.deepEqual(await entries(),final)
      assert.deepEqual(await messages(host,nativeId),[['native-decoy-receipt',distractor]])
      assert.deepEqual(await messages(host,sid),[[first.requestId,tide],[carried.requestId,pronoun]])
      assert.deepEqual(await messages(host,independent.sessionId),[[independent.requestId,other]])
      assert.deepEqual(await messages(host,casual.sessionId),[[casual.requestId,everyday]])
      assert.deepEqual(await messages(host,cross.sessionId),[[cross.requestId,kiln],[follow.requestId,again]])
      assert.deepEqual(host.agentDefaultModel.currentSelection(),defaults)
      console.log('PASS automatic: no manual resolution or default project; opaque paths, two fictional domains → correct workspaces; page reentry + newer native decoy → exact accepted original; new object → new ID; continuation follows newest routed result; unrelated everyday request → general/new; excluded path → zero writes')
    })
  } finally {delete routing.autoResponder;routing.active=false}
}
