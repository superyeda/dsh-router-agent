import test from 'node:test';
import assert from 'node:assert/strict';
import {createRouter} from '../src/core/controller.mjs';
import {memoryJournal} from '../src/core/journal.mjs';
import {acceptedWork} from '../src/core/routing-context.mjs';
import {validateSettings} from '../src/core/validation.mjs';

const provider='test-local', models=['claude-haiku-4','claude-sonnet-4','claude-opus-4'];
const catalog=models.map(model=>({provider,model,efforts:['low','medium','high']}));
const high={provider,model:models[2],effort:'high'};
const legacy={generalDir:'/general',projects:[{name:'北岸',path:'/north'}],tiers:{fast:high,standard:high,deep:high}};
const input1='修正 docs/install.md 里 Linux 安装步骤的一处错别字';
const input2='帮我修正 docs/install.md 中 Linux 安装步骤的错别字';
const complex='设计跨服务订单一致性架构，评估并发重试的幂等性与迁移方案';
function rig(saved={...legacy},inject={},seed={}) {
  let n=0;const journal=memoryJournal(),d=journal.read();d.settings=structuredClone(saved);if(seed.tasks)d.tasks=structuredClone(seed.tasks);journal.write(d);
  const creates=[],configured=[],delivered=[],catalogCalls=[],rows=new Map((seed.rows??[]).map(r=>[r.id,r])),receipts=new Map();
  const adapter={listWorkspaces:async()=>[],catalog:async()=>{catalogCalls.push(1);return catalog;},
    async listSessions(paths,bindings=[]) {return [...rows.values()].filter(r=>paths.includes(r.cwd)&&
      (r.nonblank||bindings.some(b=>b.id===r.id && b.cwd===r.cwd && receipts.get(b.requestId)===r.id))).map(r=>({id:r.id,cwd:r.cwd,title:'新会话',busy:!r.nonblank}));},
    async createSession(cwd,key,options){const prior=creates.find(c=>c.key===key);if(prior){assert.deepEqual(options,prior.options);return prior.id;}
      const id='session_'+ ++n;creates.push({key,cwd,options,id});rows.set(id,{id,cwd});return id;},
    async configure(id,selection){configured.push({id,...selection});},
    async deliver(id,key,text){assert.ok(rows.has(id));receipts.set(key,id);delivered.push({id,key,text});},
    cursor:async()=>3,observe:async()=>({status:'queued'}),recent:async()=>[],...inject};
  const options={adapter,journal,id:()=>String(++n),navigate:()=>{}};
  return {api:createRouter(options),options,rows,creates,configured,delivered,catalogCalls,journal};
}

test('0.1.2 saved strongest-only setup: no project prompt, select fast, reopen and reuse in-flight task, new complex task runs deep',async()=>{
  const r=rig(),id=await r.api.submit(input1);const a=r.api.getState().tasks.find(t=>t.id===id).items[0];
  assert.equal(a.status,'queued',a.reason);assert.equal(a.project,'/north');assert.equal(a.decision,'create');assert.equal(a.tier,'fast',a.reason);assert.equal(a.appliedSelection.model,models[0]);assert.equal(r.configured[0].model,models[0]);assert.deepEqual(r.creates[0].options,{agentPreset:'standard'});
  r.api.dispose();const b=createRouter(r.options);await b.refresh();const id2=await b.submit(input2);const next=b.getState().tasks.find(t=>t.id===id2).items[0];assert.equal(next.status,'queued',next.reason);assert.equal(next.decision,'reuse',next.reason);assert.equal(next.sessionId,a.sessionId);assert.notEqual(next.requestId,a.requestId);assert.deepEqual(r.delivered.map(d=>d.id),[a.sessionId,a.sessionId]);assert.equal(r.configured.length,1);
  const id3=await b.submit(complex);const third=b.getState().tasks.find(t=>t.id===id3).items[0];assert.equal(third.status,'queued',third.reason);assert.equal(third.tier,'deep');assert.notEqual(third.sessionId,a.sessionId);assert.equal(third.appliedSelection.model,models[2]);assert.equal(r.creates.length,2);
  assert.deepEqual(r.journal.read().settings,legacy,'no automatic rewrite or silent global defaults');
});
test('manual strongest setting and selected PTC/follow modes apply only when creating; no mutating older jobs',async()=>{
  for(const mode of ['ptc','inherit']){const r=rig({...legacy,modelMode:'manual',sessionMode:mode});await r.api.submit(input1);assert.equal(r.creates.length,1);assert.deepEqual(r.creates[0].options,mode==='inherit'?undefined:{agentPreset:'ptc'});assert.equal(r.configured[0].model,high.model);assert.equal(r.configured[0].effort,'high');}
  const r=rig();const d=r.journal.read();d.tasks=[{id:'old',items:[{id:'one',decision:'create',project:'/north',tier:'fast',text:input1,status:'failed',error:'interrupted',retryable:true,selection:high,requestId:'old-rpc',createKey:'old-key',dependsOn:[]}]}];r.journal.write(d);await r.api.retry('old','one');assert.equal(r.creates[0].key,'old-key');assert.equal(r.creates[0].options,undefined,'0.1.2 create intent still follows host; no retroactive preset override');
});
test('re-evaluate an old undelivered clarify item in place: preview only, no re-planning siblings and no allocation',async()=>{
  const r=rig();const t1=await r.api.submit(input1),first=r.api.getState().tasks.find(t=>t.id===t1).items[0];
  // The old planner had not offered the existing target and never sent this item.
  const d=r.journal.read(),old={id:'old-clarify',decision:'clarify',project:null,tier:'standard',text:input2,status:'clarify',requestId:'legacy-rpc',createKey:'legacy-create',dependsOn:[],sessionId:null,candidates:[]};d.tasks.unshift({id:'t-old',text:input2,items:[old]});r.journal.write(d);
  const c=await r.api.reviewRoute('t-old',old.id);assert.deepEqual(c,{kind:'reuse',sessionId:first.sessionId});
  const snapshot=r.api.getState().tasks[0].items[0];assert.equal(snapshot.status,'clarify');assert.equal(snapshot.sessionId,null);assert.deepEqual(snapshot.candidates,[first.sessionId]);assert.equal(snapshot.createKey,'legacy-create');assert.equal(r.delivered.length,1);
  await assert.rejects(r.api.resolve('t-old',old.id,{kind:'reuse',sessionId:'different-id'}));assert.equal(r.delivered.length,1);
  await r.api.resolve('t-old',old.id,c);assert.deepEqual(r.delivered.map(x=>x.id),[first.sessionId,first.sessionId]);assert.equal(r.delivered[1].key,'legacy-rpc');assert.equal(r.creates.length,1);assert.equal(r.configured.length,1);
  await assert.rejects(r.api.reviewRoute('t-old',old.id));await assert.rejects(r.api.resolve('t-old',old.id,c));assert.equal(r.delivered.length,2);
});
test('an old clarify item first authorized for NEW work uses the selected preset, but preview itself creates nothing',async()=>{
  const r=rig();const d=r.journal.read();d.tasks=[{id:'old',items:[{id:'x',status:'clarify',decision:'clarify',text:complex,dependsOn:[],requestId:'stable-x',createKey:'stable-new',project:null,candidates:[]}]}];r.journal.write(d);
  const s=await r.api.reviewRoute('old','x');assert.deepEqual(s,{kind:'create',project:'/north'});assert.equal(r.creates.length,0);assert.equal(r.delivered.length,0);
  await r.api.resolve('old','x',s);assert.deepEqual(r.creates[0].options,{agentPreset:'standard'});assert.equal(r.creates[0].key,'stable-new');assert.equal(r.configured[0].model,models[2]);assert.equal(r.delivered.length,1);
});
test('choosing an available auto provider preserves inactive manual anchors but cannot run them without validation',()=>{
  const old={provider:'disconnected',model:'former',effort:'original'};
  const preferences={...legacy,modelMode:'auto',autoProvider:provider,tiers:{fast:old,standard:old,deep:old}};
  const saved=validateSettings(preferences,catalog);assert.deepEqual(saved.tiers,preferences.tiers);assert.equal(saved.autoProvider,provider);
  assert.throws(()=>validateSettings({...saved,modelMode:'manual'},catalog));
});
test('a bare 投递 link needs no manual project: different link opens in that project, the same link reuses the session',async()=>{
  const job='/work/job/auto-fill',web='/work/web';
  const saved={generalDir:'/general',projects:[{name:'auto-fill',path:job},{name:'web',path:web}],tiers:{...legacy.tiers}};
  const prior='帮我投递简历 https://employer-a.example/campus/detail?jobAdId=role-A01';
  const priorTask={id:'t0',text:prior,createdAt:1,items:[{id:'i0',text:prior,payload:prior,project:job,sessionId:'job-session',requestId:'r0',createKey:'c0',afterSeq:2,attempted:true,accepted:true,decision:'create',status:'done',dependsOn:[]}]};
  const r=rig(saved,{},{rows:[{id:'job-session',cwd:job,title:'协助投递校招岗位简历',nonblank:true}],tasks:[priorTask]});
  const other='帮我投递 https://employer-b.example/jobs/posDetail.html?postId=role-B02&postType=campus';
  const t=await r.api.submit(other);const a=r.api.getState().tasks.find(x=>x.id===t).items[0];
  assert.equal(a.status,'queued',a.reason);assert.equal(a.project,job);assert.equal(a.decision,'create');assert.notEqual(a.sessionId,'job-session');
  const t2=await r.api.submit(other);const b=r.api.getState().tasks.find(x=>x.id===t2).items[0];
  assert.equal(b.status,'queued',b.reason);assert.equal(b.decision,'reuse',b.reason);assert.equal(b.sessionId,a.sessionId);
  assert.deepEqual(r.configured.map(x=>x.id),[a.sessionId],'只有新建那次选模，复用不改模型');
  assert.deepEqual(r.delivered.map(d=>d.id),[a.sessionId,a.sessionId]);assert.equal(r.creates.length,1,'复用从未另建会话');
});
test('link identity is case-sensitive and a question is never routed into a workflow project',async()=>{
  const {planRequest}=await import('../src/planner/index.mjs');
  const settings={generalDir:'/general',projects:[{name:'auto-fill',path:'/job'},{name:'infra',path:'/infra'}]};
  const prior='帮我投递简历 https://jobs.example/apply/abcd';
  const call=async(text,hints=[prior])=> (await planRequest({text,settings,sessions:[{id:'s1',cwd:'/job',title:'协助投递校招岗位简历',busy:false,workHints:hints}]}))[0];
  assert.equal((await call('帮我投递 https://jobs.example/apply/abcd')).decision,'reuse');
  assert.equal((await call('向这个岗位投递简历 https://jobs.example/apply/abcd')).decision,'reuse');
  assert.equal((await call('帮我投递 https://jobs.example/apply/AbcD')).decision,'create','path 大小写不同是另一个目标');
  assert.equal((await call('帮我投递 https://jobs.example/apply/abcd?id=aBc',['帮我投递 https://jobs.example/apply/abcd?id=AbC'])).decision,'create');
  assert.equal((await call('查询 https://jobs.example/apply/abcd 的投递进度')).decision,'create','查询不是又一次投递');
  const question=await planRequest({text:'如何申请病假？',settings,sessions:[{id:'s2',cwd:'/infra',title:'申请上云配额',busy:false,workHints:['申请上云配额']}]});
  assert.equal(question[0].decision,'clarify','泛动词咨询不能被当作该项目的工作');
});
test('default project can only designate an approved project; raw external paths are never routable',()=>{
  assert.throws(()=>validateSettings({...legacy,defaultProject:'/not-allowed'},catalog));assert.throws(()=>validateSettings({...legacy,sessionMode:'unknown'},catalog));
  assert.equal(validateSettings({...legacy,defaultProject:'/north'},catalog).defaultProject,'/north');
  assert.equal(validateSettings({...legacy,projects:[{name:'北岸',path:'/north/'}],defaultProject:'/north/'},catalog).defaultProject,'/north');
});
test('only the original, allowlisted, actually admitted user text becomes planner evidence; journal never creates a candidate',()=>{
  const base={sessionId:'A',requestId:'q',project:'/north',text:'user original',payload:'user original',afterSeq:4,attempted:true,accepted:true,decision:'create',result:'private assistant output'};
  const make=(id,more)=>({...base,sessionId:id,...more});
  const work=acceptedWork([{items:[base,make('B',{project:'/other'}),make('C',{attempted:false}),make('D',{accepted:false}),make('E',{payload:'replacement/handoff bundle with private data'}),make('F',{text:'brief',approved:true,payload:'brief\n\nPRIVATE upstream result'}),make('G',{}),make('G',{project:'/also'})]}],new Set(['/north','/also']));
  assert.deepEqual(new Set(work.bindings.map(x=>x.id)),new Set(['A','E','F']));assert.equal(work.forPlan([]).length,0);
  const rows=['A','B','C','D','E','F','G'].map(id=>({id,cwd:'/north'}));const hinted=work.forPlan(rows);assert.deepEqual(hinted.map(r=>r.workHints),[['user original'],[],[],[],[],['brief'],[]]);assert.deepEqual(work.forPlan([{id:'A',cwd:'/also'}])[0].workHints,[]);assert.ok(!JSON.stringify(hinted).includes('private'));assert.equal(rows[0].workHints,undefined);
  const differentSuffix='a'.repeat(4200)+'do not replace';const large=acceptedWork([{items:[make('long',{text:differentSuffix,payload:differentSuffix})]}],new Set(['/north']));
  assert.deepEqual(large.forPlan([{id:'long',cwd:'/north'}])[0].workHints,[],'never auto-reuse from a truncated hint');
});
