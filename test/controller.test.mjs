import test from 'node:test';
import assert from 'node:assert/strict';
import {createRouter} from '../src/core/controller.mjs';
import {memoryJournal} from '../src/core/journal.mjs';
import {materialize,validateSettings} from '../src/core/validation.mjs';

const tier={provider:'local',model:'model',effort:'low'};
const settings={projects:[{name:'A',path:'/a'},{name:'B',path:'/b'}],generalDir:'/general',tiers:{fast:tier,standard:tier,deep:tier}};
const item=(key,decision,extra={})=>({key,text:key+' 工作内容',project:'/a',tier:'standard',dependsOn:[],decision,candidates:[],reason:'符合测试条件',...extra});
async function fixture(plan) {
  const journal=memoryJournal(), delivered=[], configured=[], created=new Map(), observations=new Map(), cursors=[];
  const rows=[{id:'old',cwd:'/a',title:'上次发布验收',busy:true},{id:'other',cwd:'/b',title:'上次修正文档'}];
  const adapter={async listWorkspaces(){return settings.projects;},async catalog(){return [{provider:'local',model:'model',efforts:['low','high']}];},async listSessions(paths){return rows.filter(s=>paths.includes(s.cwd));},
    async createSession(cwd,key){if(!created.has(key)){const id='s-'+key;created.set(key,id);rows.push({id,cwd,title:'新会话'});}return created.get(key);},
    async configure(id,tier){configured.push([id,tier]);},async deliver(id,key,text){if(!delivered.some(d=>d.key===key)){delivered.push({id,key,text});observations.set(key,{status:'queued'});}},async cursor(id){cursors.push(id);return 33;},async observe(_id,key,base){assert.equal(base,33);return observations.get(key) || {status:'unknown'};},async recent(){return [];}};
  let planned=0,n=0;const options={adapter,journal,plan:async input=>{planned++;return typeof plan==='function'?plan(input):plan.map(p=>({...p,text:input.text}));},id:()=>String(++n),now:()=>17};
  const api=createRouter(options);await api.saveSettings(settings);
  // Old graphs are persisted v1 data, NEVER results of the new submit path.
  async function seedLegacy(text) {
    const d=journal.read(),t='legacy';d.tasks=[{id:t,text,createdAt:1,items:plan.map(p=>({id:p.key,text:p.text,dependsOn:p.dependsOn,
      decision:p.decision,project:p.project,tier:p.tier,sessionId:p.sessionId||null,candidates:p.candidates,status:'new',selection:tier,
      requestId:'ra-legacy-'+p.key,createKey:'ra-key-'+p.key}))}];journal.write(d);await api.refresh();return t;
  }
  return {api,adapter,options,journal,rows,created,delivered,configured,observations,seedLegacy,cursors,nplans:()=>planned,items:()=>api.getState().tasks[0].items};
}

test('legacy graph remains resumable: clear siblings dispatch, ambiguous sibling waits, admission is not completion',async()=>{
  const f=await fixture([item('a','reuse',{sessionId:'old'}),item('b','create',{project:'/b',tier:'deep'}),item('c','clarify',{project:null,candidates:['other']})]);
  const t=await f.seedLegacy('三项');let [a,b,c]=f.items();assert.deepEqual(f.items().map(i=>i.status),['queued','queued','clarify']);assert.equal(f.created.size,1);assert.deepEqual(f.configured.map(x=>x[0]),[b.sessionId]);assert.equal(a.sessionId,'old');
  f.observations.set(b.requestId,{status:'done',result:'B only'});await f.api.tick();assert.equal(f.items()[1].result,'B only');assert.equal(f.items()[0].status,'queued');
  await f.api.resolve(t,c.id,{kind:'reuse',sessionId:'other'});assert.equal(f.delivered[2].id,'other');
  await f.api.followUp(t,b.id,'修改第二条');assert.equal(f.delivered[3].id,b.sessionId);assert.equal(f.nplans(),0);assert.equal(f.items()[3].parentItemId,b.id);assert.equal(f.configured.length,1);
  assert.equal(f.api.sessionPaneTarget(b.sessionId),'/b');
});
test('dependent work never receives context before explicit approval of the exact outgoing text',async()=>{
  const f=await fixture([item('first','reuse',{sessionId:'old'}),item('then','create',{project:'/b',dependsOn:['first']})]);const t=await f.seedLegacy('接力');let [a,b]=f.items();assert.equal(b.status,'waiting');assert.equal(f.created.size,0);
  await assert.rejects(f.api.approve(t,b.id,'过早确认'));f.observations.set(a.requestId,{status:'done',result:'只应展示，不自动转发'});await f.api.tick();[a,b]=f.items();assert.equal(b.status,'handoff');assert.ok(b.handoff.includes(a.result));assert.equal(f.delivered.length,1);
  await f.api.refresh();assert.equal(f.delivered.length,1);await f.api.approve(t,b.id,'请只使用字段 orderId');assert.equal(f.delivered[1].text,'请只使用字段 orderId');await assert.rejects(f.api.approve(t,b.id,'再发'));assert.equal(f.delivered.length,2);
});
test('failed predecessor and original-session approval do not unblock a dependent',async()=>{
  const f=await fixture([item('a','reuse',{sessionId:'old'}),item('b','create',{dependsOn:['a']})]);const t=await f.seedLegacy('两步');const [a,b]=f.items();
  f.observations.set(a.requestId,{status:'input-required'});await f.api.tick();await assert.rejects(f.api.followUp(t,a.id,'批准'));assert.equal(f.items()[1].status,'waiting');
  f.observations.set(a.requestId,{status:'failed',error:'原执行失败'});await f.api.tick();assert.equal(f.items()[1].status,'waiting');await assert.rejects(f.api.approve(t,b.id,'强制发送'));await assert.rejects(f.api.retry(t,a.id));assert.equal(f.delivered.length,1);
});
test('lost admission receipt is reconciled on reopen; no duplicate send or create',async()=>{
  const f=await fixture([item('a','create')]);const send=f.adapter.deliver;f.adapter.deliver=async(...args)=>{await send(...args);throw Error('connection lost after enqueue');};const t=await f.api.submit('甲');const [a]=f.items();assert.equal(a.status,'unknown');assert.ok(a.retryable);assert.equal(f.delivered.length,1);f.api.dispose();
  const reopened=createRouter(f.options);f.observations.set(a.requestId,{status:'done',result:'可信回复'});await reopened.refresh();const result=reopened.getState().tasks[0].items[0];assert.equal(result.status,'done');assert.equal(result.result,'可信回复');assert.equal(f.created.size,1);assert.equal(f.delivered.length,1);await assert.rejects(reopened.retry(t,a.id));
});
async function legacyFailure() {
  const f=await fixture([item('a','reuse',{sessionId:'old'}),item('b','create',{project:'/b'})]);
  f.adapter.createSession=async()=>{throw Error('安全创建会话失败：The router could not confirm a newly created persistent session. Check it manually before starting a new task.');};
  const t=await f.seedLegacy('两项独立工作'),[a,b]=f.items();
  const doc=f.journal.read(),key='ra-4a5c95ff-fb56-4eaa-961c-cf83d44aa119';doc.tasks[0].items[1].createKey=key;f.journal.write(doc);f.api.dispose();
  const api=createRouter(f.options);f.observations.set(a.requestId,{status:'done',result:'无关项已完成'});await api.refresh();
  return {f,t,a,b,api,key,sid:'session-router-agent-'+key};
}
test('older create failure only offers explicit handoff; no config, allocation, duplicate, or sibling replay',async()=>{
  const {f,t,a,b,api,key,sid}=await legacyFailure();const entry=()=>api.getState().tasks[0].items[1];
  assert.equal(entry().recoverableEmpty,true);assert.equal(entry().expectedSessionId,sid);assert.equal(f.delivered.length,1);
  const recoveries=[];f.adapter.recoverEmpty=async(...args)=>{recoveries.push(args);return sid;};
  await assert.rejects(api.retry(t,b.id),/确认/);await assert.rejects(api.recoverEmpty(t,b.id,'wrong'));assert.equal(recoveries.length,0);
  await api.recoverEmpty(t,b.id,sid);assert.deepEqual(recoveries,[['/b',key,sid]]);assert.deepEqual(f.configured,[]);assert.equal(f.created.size,0);
  assert.equal(entry().decision,'reuse');assert.equal(entry().requestId,b.requestId);assert.equal(entry().status,'queued');assert.equal(entry().recoverableEmpty,false);assert.equal(api.getState().tasks[0].items[0].result,'无关项已完成');
  assert.deepEqual(f.delivered.map(x=>[x.id,x.key]),[['old',a.requestId],[sid,b.requestId]]);await assert.rejects(api.recoverEmpty(t,b.id,sid));
  // Reopening during an empty queue uses only a read scope, never re-authorizes sends or opens the target.
  api.dispose();let bound=0;f.adapter.bindRecoveryObservation=async (p,k,id)=>{assert.deepEqual([p,k,id],['/b',key,sid]);bound++;};
  const reopened=createRouter(f.options);await reopened.refresh();assert.equal(bound,1);assert.equal(reopened.sessionPaneTarget(sid),null);
  f.observations.set(b.requestId,{status:'done',result:'返还原项'});await reopened.tick();assert.equal(reopened.getState().tasks[0].items[1].result,'返还原项');assert.equal(f.delivered.length,2);assert.equal(recoveries.length,1);
});
test('revoked directory, changed handoff identity, or work in the target blocks recovery before enqueue',async()=>{
  const {f,t,b,api,sid}=await legacyFailure();const deny=Object.assign(Error('已出现活动'),{code:'router-agent/recovery-unsafe'});
  f.adapter.recoverEmpty=async()=>{throw deny;};await assert.rejects(api.recoverEmpty(t,b.id,sid),/已出现活动/);assert.equal(f.delivered.length,1);assert.equal(api.getState().tasks[0].items[1].retryable,false);assert.deepEqual(f.configured,[]);await assert.rejects(api.retry(t,b.id));
  await api.saveSettings({...settings,projects:[settings.projects[0]]});await assert.rejects(api.recoverEmpty(t,b.id,sid));assert.equal(f.delivered.length,1);
});
test('the old generic error can unlock normal same-key retry only after host positively reports that nothing exists',async()=>{
  const {f,t,b,api,sid}=await legacyFailure();f.adapter.recoverEmpty=async()=>{throw Object.assign(Error('未找到'),{code:'router-agent/recovery-not-found'});};await assert.rejects(api.recoverEmpty(t,b.id,sid));
  let creates=0;f.adapter.createSession=async()=>{creates++;return sid;};let i=api.getState().tasks[0].items[1];assert.equal(i.recoverableEmpty,false);assert.equal(i.retryable,true);await api.retry(t,b.id);assert.equal(creates,1);assert.equal(f.delivered[1].key,b.requestId);assert.equal(f.configured.length,1);
});
test('manual retry after lost transport uses the original outbox id, cursor and payload',async()=>{
  const f=await fixture([item('a','reuse',{sessionId:'old'})]);const send=f.adapter.deliver, attempts=[];f.adapter.deliver=async(...args)=>{attempts.push(args);if(attempts.length===1)throw Error('网络断开');return send(...args);};const t=await f.api.submit('试一项');await f.api.retry(t,f.items()[0].id);assert.deepEqual(attempts[0],attempts[1]);assert.deepEqual(f.cursors,['old']);assert.equal(f.items()[0].status,'queued');
});
test('two tabs resolving the same item cannot both post it',async()=>{
  const f=await fixture([item('a','clarify')]);const t=await f.api.submit('选择目标'), [a]=f.items(),tab2=createRouter(f.options);await tab2.refresh();const results=await Promise.allSettled([f.api.resolve(t,a.id,{kind:'reuse',sessionId:'old'}),tab2.resolve(t,a.id,{kind:'create',project:'/a'})]);assert.deepEqual(results.map(r=>r.status).sort(),['fulfilled','rejected']);assert.equal(f.delivered.length,1);
});
test('revoked folder or drifted cwd prevents reads, follow-ups and redirects',async()=>{
  const f=await fixture([item('a','reuse',{sessionId:'old'})]);const t=await f.api.submit('任务'),[a]=f.items();f.rows[0].cwd='/b';await f.api.tick();assert.equal(f.items()[0].status,'unknown');await assert.rejects(f.api.followUp(t,a.id,'不要错发'));assert.equal(f.api.sessionPaneTarget(a.sessionId),null);assert.equal(f.delivered.length,1);
  await f.api.saveSettings({...settings,projects:[settings.projects[1]]});await f.api.refresh();assert.ok(!f.api.getState().sessions.some(s=>s.cwd==='/a'));
});
test('a failed 0.1.0 namespace lookup can be retried after upgrade without replaying the sibling or re-planning',async()=>{
  const f=await fixture([item('old-work','reuse',{sessionId:'old'}),item('new-work','create',{project:'/b'})]);
  const create=f.adapter.createSession;
  f.adapter.createSession=async()=>{throw Error('cannot get property "remote.routerAgent" without inject');};
  const taskId=await f.seedLegacy('原任务'); const [old,failed]=f.items();
  assert.equal(failed.status,'failed');assert.equal(failed.retryable,true);assert.equal(failed.attempted,undefined);assert.equal(f.created.size,0);assert.equal(f.delivered.length,1);
  f.observations.set(old.requestId,{status:'done',result:'已有结果'});f.api.dispose();
  f.adapter.createSession=create;const restored=createRouter(f.options);await restored.refresh();await restored.retry(taskId,failed.id);
  const snapshot=restored.getState();const [sibling,recovered]=snapshot.tasks[0].items;
  assert.equal(snapshot.tasks.length,1);assert.equal(sibling.result,'已有结果');assert.equal(recovered.status,'queued');assert.equal(recovered.requestId,failed.requestId);assert.equal(recovered.createKey,failed.createKey);assert.deepEqual(f.delivered.map(d=>d.key),[old.requestId,failed.requestId]);assert.equal(f.nplans(),0);
});
test('crash before first prompt requires an explicit retry using the same create key',async()=>{
  const f=await fixture([item('a','create')]);const t=await f.api.submit('建一个');const doc=f.journal.read(),draft=doc.tasks[0].items[0];draft.status='dispatching';delete draft.attempted;delete draft.accepted;f.journal.write(doc);f.delivered.length=0;f.observations.clear();const fresh=createRouter(f.options);await fresh.refresh();assert.equal(fresh.getState().tasks[0].items[0].retryable,true);assert.equal(f.delivered.length,0);await fresh.retry(t,draft.id);assert.equal(f.created.size,1);assert.equal(f.delivered.length,1);assert.equal(f.configured.length,1);
});
test('scope validation rejects path escapes, graph cycles and invented targets',()=>{
  const catalog=[{provider:'local',model:'model',efforts:['low']}];assert.throws(()=>validateSettings({...settings,generalDir:'/a/../private'},catalog));assert.throws(()=>validateSettings({...settings,tiers:{standard:tier}},catalog));
  assert.throws(()=>materialize([item('x','create',{dependsOn:['y']}),item('y','create',{dependsOn:['x']})],settings,[],()=>''));assert.throws(()=>materialize([item('x','create',{dependsOn:['no']})],settings,[],()=>''));
  assert.equal(materialize([item('x','reuse',{sessionId:'foreign'})],settings,[],()=>1,'x 工作内容')[0].decision,'clarify');assert.equal(materialize([item('y','create',{project:'/private'})],settings,[],()=>1,'y 工作内容')[0].decision,'clarify');
  assert.equal(materialize([item('w','create',{project:null})],settings,[],()=>1,'w 工作内容')[0].project,'/general');
});
test('a temporary model catalog failure does not block a clear reuse sibling',async()=>{
  const f=await fixture([item('a','reuse',{sessionId:'old'}),item('b','create',{project:'/b'})]);f.adapter.catalog=async()=>{throw Error('目录不可用');};await assert.rejects(f.seedLegacy('一个旧项、一个新项'),/目录不可用/);const [a,b]=f.items();assert.equal(a.status,'queued');assert.equal(b.status,'failed');assert.ok(b.retryable);assert.equal(f.created.size,0);assert.equal(f.delivered.length,1);
});
test('eight frozen legacy records still resume within host admission capacity',async()=>{
  const f=await fixture(Array.from({length:8},(_,i)=>item(String(i),'create')));const create=f.adapter.createSession;let pending=0,peak=0;
  f.adapter.createSession=async(...args)=>{pending++;peak=Math.max(peak,pending);await new Promise(resolve=>setImmediate(resolve));pending--;return create(...args);};await f.seedLegacy('八项');assert.equal(f.delivered.length,8);assert.ok(peak<=4 && peak>1);
});
test('durability is mandatory: no successful write of intent means no host side-effect',async()=>{
  const f=await fixture([item('a','create')]);f.journal.write=()=>{throw Error('storage full');};await assert.rejects(f.api.submit('测试'),/storage full/);assert.equal(f.created.size,0);assert.equal(f.delivered.length,0);await assert.rejects(f.api.submit('再试'),/storage full/);
});
test('submit enforces one unchanged message even if a planner tries a split, rewrite or dependency',async()=>{
  const body='检查 A 项目：\n1. 读取样本；\n2. 校验后给出摘要。 https://jobs.example/Aa?id=bC';
  for(const proposal of [[item('a','reuse',{sessionId:'old',text:body}),item('b','create',{text:body})],
    [item('a','create',{text:'只执行第一步'})],[item('a','create',{text:body,dependsOn:['b']})]]) {
    const f=await fixture(()=>proposal);await assert.rejects(f.api.submit(body),/一个会话|单会话|原始消息/);
    assert.equal(f.journal.read().tasks.length,0);assert.equal(f.delivered.length,0);assert.equal(f.created.size,0);
  }
  const f=await fixture([item('only','reuse',{sessionId:'old'})]);const t=await f.api.submit(body),[i]=f.items();
  assert.equal(f.journal.read().tasks[0].kind,'conversation');assert.equal(f.items().length,1);assert.deepEqual(i.dependsOn,[]);assert.equal(f.delivered[0].text,body);
  await f.api.followUp(t,i.id,'继续第二步');assert.equal(f.nplans(),1);assert.deepEqual(f.delivered.map(x=>x.id),['old','old']);
  assert.equal(f.journal.read().tasks.length,1);assert.equal(f.created.size,0);assert.equal(f.configured.length,0);
});
test('local record cleanup is atomic, freezes confirmed IDs and never calls a session endpoint',async()=>{
  const f=await fixture([item('only','reuse',{sessionId:'old'})]);const a=await f.api.submit('第一条'), first=f.items()[0];
  await assert.rejects(f.api.removeTask(a),/未清理/);assert.equal(await f.api.clearCompleted([a]),0);
  f.observations.set(first.requestId,{status:'done',result:'已完成'});await f.api.tick();
  const b=await f.api.submit('后来完成，不在确认范围'),second=f.items()[0];f.observations.set(second.requestId,{status:'done',result:'完成二'});await f.api.tick();
  assert.equal(f.api.sessionPaneTarget('old'),'/a');
  const tab=createRouter(f.options);let calls=0;
  for(const k of Object.keys(f.adapter)) f.adapter[k]=()=>{calls++;throw Error('禁止原生操作');};
  assert.equal(await f.api.clearCompleted([a]),1);assert.deepEqual(f.journal.read().tasks.map(t=>t.id),[b]);
  assert.equal(await tab.removeTask(a),0);assert.equal(await tab.removeTask(b),1);assert.deepEqual(f.journal.read().tasks,[]);
  assert.equal(await f.api.clearCompleted([a,b]),0);assert.equal(f.api.sessionPaneTarget('old'),null);assert.deepEqual(f.rows.map(s=>s.id),['old','other']);assert.equal(calls,0);
});
test('delete refuses live, partially finished, uncertain and recoverable entries; only confirmed snapshots disappear',async()=>{
  const f=await fixture([item('only','clarify')]);const t=await f.api.submit('未发送的请求');const d=f.journal.read(),cached=structuredClone(d.tasks[0]);
  assert.equal(await f.api.removeTask(t),1);assert.equal(f.delivered.length,0);
  for(const status of ['new','waiting','handoff','queued','dispatching','running','input-required','unknown']) {
    const mixed=structuredClone(cached);mixed.items=[{...mixed.items[0],status:'done'},{...mixed.items[0],id:'b',status}];d.tasks=[mixed];f.journal.write(d);
    assert.equal(await f.api.clearCompleted([t]),0);await assert.rejects(f.api.removeTask(t),/未清理/);assert.equal(f.journal.read().tasks.length,1);
  }
  const {api,t:key}=await legacyFailure();await assert.rejects(api.removeTask(key),/未清理/);
  d.tasks=[cached];f.journal.write(d);const write=f.journal.write;f.journal.write=()=>{throw Error('storage unavailable');};
  await assert.rejects(f.api.removeTask(t),/storage unavailable/);assert.equal(f.api.getState().tasks.length,1);f.journal.write=write;
});
test('a pane target requires a live exact binding or an outstanding, authorized candidate',async()=>{
  const f=await fixture([item('only','clarify',{project:null,candidates:['old','foreign']})]);assert.equal(f.api.sessionPaneTarget('old'),null);
  const task=await f.api.submit('选一个');assert.equal(f.api.sessionPaneTarget('old'),'/a');assert.equal(f.api.sessionPaneTarget('other'),null);assert.equal(f.api.sessionPaneTarget('foreign'),null);
  const i=f.items()[0];f.rows[0].cwd='/b';await f.api.refresh();assert.equal(f.api.sessionPaneTarget('old'),null);
  await assert.rejects(f.api.resolve(task,i.id,{kind:'reuse',sessionId:'old'}));
  f.rows[0].cwd='/a';await f.api.resolve(task,i.id,{kind:'reuse',sessionId:'old'});assert.equal(f.api.sessionPaneTarget('old'),'/a');
  f.rows[0].cwd='/b';await f.api.tick();assert.equal(f.api.sessionPaneTarget('old'),null);
  f.api.dispose();assert.equal(f.api.sessionPaneTarget('old'),null);
});
