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
    async listSessions(paths,bindings=[]) {return [...rows.values()].filter(r=>!r.archived && paths.includes(r.cwd)&&
      (r.nonblank||bindings.some(b=>b.id===r.id && b.cwd===r.cwd && receipts.get(b.requestId)===r.id))).map(r=>({id:r.id,cwd:r.cwd,title:r.title??'新会话',updatedAt:r.updatedAt??0,busy:!r.nonblank}));},
    async createSession(cwd,key,options){const prior=creates.find(c=>c.key===key);if(prior){assert.deepEqual(options,prior.options);return prior.id;}
      const id='session_'+ ++n;creates.push({key,cwd,options,id});rows.set(id,{id,cwd});return id;},
    async configure(id,selection){configured.push({id,...selection});},
    async deliver(id,key,text){assert.ok(rows.has(id));if(receipts.has(key)){assert.equal(receipts.get(key),id);return;}receipts.set(key,id);delivered.push({id,key,text});},
    cursor:async()=>3,observe:async(id,key)=>({status:receipts.get(key)===id?'queued':'unknown'}),recent:async()=>[],...inject};
  const options={adapter,journal,id:()=>String(++n),now:seed.now,infer:seed.infer};
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
  assert.equal(question[0].decision,'create','普通咨询不是项目中的旧事');assert.equal(question[0].project,null,'通用提问不因“申请”二字流到上云配额工作区');
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

// Saved by v0.2.0: multiple fixed projects, no routingMode and no default cwd.
// Synthetic local adapter only; submits below use the real controller + planner.
const light='/rooms/amber',paper='/rooms/teal';
const v020={...legacy,generalDir:'/neutral',defaultProject:'',projects:[{name:'剧场灯光排练',path:light},{name:'纸本文献修复室',path:paper}],
  modelMode:'auto',autoProvider:provider,sessionMode:'standard'};
const book='纸本文献的装帧检查单 BK-237 缺了护页记录。\n1. 核对原始登记。\n2. 补上护页记录并标明依据。';
const sameBook='纸本文献的装帧检查单 BK-237 缺了护页记录，需要核对原始登记并补上。';
const newBook='纸本文献的霉斑照片 BK-544 缺了一张编号标签。';
const lamp='剧场灯光的侧幕色温 LUX-321 偏冷。';
const pending={id:'old-wait',kind:'conversation',text:book,createdAt:1,items:[{id:'old-item',text:book,project:null,sessionId:null,status:'clarify',
  decision:'clarify',tier:'standard',requestId:'never-replay-this',createKey:'old-not-created',candidates:[],dependsOn:[]}]};
const noManual=(t,api)=>t.mock.method(api,'resolve',()=>assert.fail('automatic routing called the manual resolve path'));
async function submitOne(api,text) {
  const taskId=await api.submit(text),task=api.getState().tasks.find(t=>t.id===taskId);
  assert.equal(task.items.length,1);const [item]=task.items;assert.equal(item.text,text);assert.deepEqual(item.dependsOn,[]);return {taskId,item};
}
function queued(item,decision,project,sessionId) {
  assert.equal(item.status,'queued',item.reason+' '+(item.error||''));assert.equal(item.decision,decision,item.reason);
  assert.equal(item.project,project,item.reason);if(sessionId) assert.equal(item.sessionId,sessionId,item.reason);assert.equal(item.accepted,true);
}

test('ordinary input on v0.2.0 settings: choose the right project, send the WHOLE message once, reuse same work; no manual resolution',async t=>{
  let modelCalls=0,wall=100;
  const r=rig(v020,{},{tasks:[pending],now:()=>wall,infer:async()=>{modelCalls++;throw Error('intent service offline');}});
  const tab=createRouter(r.options),spies=[noManual(t,r.api),noManual(t,tab)]; // opened *before* any new work
  const {taskId,item:a}=await submitOne(r.api,book);queued(a,'create',paper);
  assert.deepEqual(r.delivered,[{id:a.sessionId,key:a.requestId,text:book}]);
  const {item:b}=await submitOne(tab,sameBook);queued(b,'reuse',paper,a.sessionId);
  wall=700;const {item:c}=await submitOne(tab,newBook);queued(c,'create',paper);assert.notEqual(c.sessionId,a.sessionId,'same project, different concrete work');
  const {item:d}=await submitOne(tab,lamp);queued(d,'create',light);
  r.rows.set('unrelated-global-latest',{id:'unrelated-global-latest',cwd:light,title:'完全无关的私事',nonblank:true,updatedAt:99999999999});
  wall=70;const follow='把核对结果列一下';await r.api.followUp(taskId,a.id,follow); // old task, later admission; clock moved backwards
  await tab.refresh();await r.api.tick();
  const {item:e}=await submitOne(tab,'继续');queued(e,'reuse',paper,a.sessionId);
  const {item:g}=await submitOne(r.api,'刚才那版再短一点');queued(g,'reuse',paper,a.sessionId);
  assert.deepEqual(r.delivered.map(({id,text})=>[id,text]),[[a.sessionId,book],[a.sessionId,sameBook],[c.sessionId,newBook],[d.sessionId,lamp],
    [a.sessionId,follow],[a.sessionId,'继续'],[a.sessionId,'刚才那版再短一点']]);
  assert.deepEqual(r.configured.map(x=>x.id),[a.sessionId,c.sessionId,d.sessionId]);assert.equal(r.creates.length,3);
  assert.ok(modelCalls>0,'exercised the failed classifier, not a plan stub');
  assert.deepEqual(r.journal.read().settings,v020,'old settings did not require opening or resaving the form');
  assert.deepEqual(r.journal.read().tasks.find(t=>t.id===pending.id),pending,'refresh and new auto submissions never reevaluate or send an old waiting row');
  for(const s of spies) assert.equal(s.mock.callCount(),0);
});

test('lost acknowledgment is not continuity until the exact request is observed; reopen and later ticks never redeliver or reorder it',async t=>{
  for(const newer of [false,true]) {
    let wall=30;const r=rig(v020,{},{now:()=>wall});const deliver=r.options.adapter.deliver;
    r.options.adapter.deliver=async(...args)=>{await deliver(...args);r.options.adapter.deliver=deliver;throw Error('reply lost after successful native admission');};
    const manual=noManual(t,r.api);const {taskId,item:lost}=await submitOne(r.api,book);assert.equal(lost.status,'unknown');assert.equal(lost.accepted,undefined);
    const {item:unsure}=await submitOne(r.api,'继续');assert.equal(unsure.status,'clarify',unsure.reason);assert.equal(r.delivered.length,1);
    let last=lost;if(newer) {wall=75;({item:last}=await submitOne(r.api,lamp));queued(last,'create',light);}
    r.api.dispose();wall=8000;const reopened=createRouter(r.options),otherManual=noManual(t,reopened);
    await reopened.refresh();await reopened.tick();const recovered=reopened.getState().tasks.find(t=>t.id===taskId).items[0];
    assert.equal(recovered.accepted,true);assert.equal(recovered.requestId,lost.requestId);assert.equal(recovered.routeOrder,lost.routeOrder);
    const {item:next}=await submitOne(reopened,'继续');queued(next,'reuse',newer?light:paper,last.sessionId);
    assert.deepEqual(r.delivered.map(d=>d.text),[book,...(newer?[lamp]:[]),'继续']);assert.equal(r.creates.length,newer?2:1);
    assert.equal(manual.mock.callCount()+otherManual.mock.callCount(),0);
  }
});

test('unavailable execution model does not change an existing conversation and never allocates/sends a new one',async t=>{
  const r=rig(v020),manual=noManual(t,r.api),{item:a}=await submitOne(r.api,book);queued(a,'create',paper);
  r.options.adapter.catalog=async()=>[];
  const {item:b}=await submitOne(r.api,'继续');queued(b,'reuse',paper,a.sessionId);
  const {item:other}=await submitOne(r.api,lamp);assert.equal(other.status,'failed',other.reason);assert.equal(other.attempted,undefined);assert.match(other.error,/模型/);
  const {item:outside}=await submitOne(r.api,'在 /not-authorized/src 修改 BK-237');assert.equal(outside.status,'clarify');
  assert.deepEqual(r.delivered.map(d=>d.text),[book,'继续']);assert.equal(r.creates.length,1);assert.equal(r.configured.length,1);assert.equal(manual.mock.callCount(),0);
});

const doneTask=(id,cwd,ord)=>({id,text:'record-'+id,createdAt:8,kind:'conversation',items:[{id:'item-'+id,text:'record-'+id,payload:'record-'+id,requestId:'rpc-'+id,afterSeq:2,
  decision:'reuse',sessionId:'sid-'+id,project:cwd,status:'done',attempted:true,accepted:true,dependsOn:[],...(ord?{routeOrder:ord}:{})}]});
test('cleanup, revoked grant, archive or wrong actual cwd cannot promote an older or a native-only session to “刚才”',async t=>{
  for(const fail of ['clear','legacy clear','revoke','archive','move']) {
    const legacy=fail==='legacy clear',a=doneTask('older',light,legacy?0:1),b=doneTask('newest',paper,legacy?0:2);
    const r=rig(v020,{},{tasks:[b,a],rows:[{id:'sid-older',cwd:light,nonblank:true},{id:'sid-newest',cwd:paper,nonblank:true}]});
    if(!legacy) {const d=r.journal.read();d.routeClock=2;r.journal.write(d);}
    const tab=createRouter(r.options),manual=noManual(t,tab);
    if(fail.endsWith('clear')) {assert.equal(await r.api.removeTask(b.id),1);assert.ok(!JSON.stringify(r.journal.read()).includes('sid-newest'),'no persistence of a deleted session ID');}
    if(fail==='revoke') await r.api.saveSettings({...v020,projects:[v020.projects[0]]});
    if(fail==='archive') r.rows.get('sid-newest').archived=true;
    if(fail==='move') r.rows.get('sid-newest').cwd=light;
    const {item:i}=await submitOne(tab,'继续');assert.equal(i.status,'clarify',fail+': '+i.reason);assert.equal(i.sessionId,null);
    assert.equal(r.creates.length,0);assert.deepEqual(r.delivered,[]);assert.equal(manual.mock.callCount(),0);
  }
});

test('a real plan selected for the right cwd cannot dispatch if the native destination moves during preview',async t=>{
  const r=rig(v020),manual=noManual(t,r.api);const {item:a}=await submitOne(r.api,book);queued(a,'create',paper);
  const list=r.options.adapter.listSessions;let calls=0;
  r.options.adapter.listSessions=async(...args)=>{if(++calls===2) {r.rows.get(a.sessionId).cwd=light;r.rows.get(a.sessionId).nonblank=true;}return list(...args);};
  const {item:next}=await submitOne(r.api,'继续');assert.equal(next.status,'failed',next.reason);assert.match(next.error,/原会话|移出目录/);assert.equal(next.attempted,undefined);
  assert.deepEqual(r.delivered.map(d=>d.text),[book]);assert.equal(r.creates.length,1);assert.equal(r.configured.length,1);assert.equal(manual.mock.callCount(),0);
});

test('on the first v0.2.0 upgrade “继续” can recover one actual historical target but not choose between ambiguous receipts',async t=>{
  for(const shared of [true,false]) {
    const a=doneTask('first',light),b=doneTask('last-created',shared?light:paper);a.createdAt=1;b.createdAt=999;
    if(shared) b.items[0].sessionId=a.items[0].sessionId;
    const r=rig(v020,{},{tasks:[b,a],rows:[{id:a.items[0].sessionId,cwd:light,nonblank:true},
      ...(!shared?[{id:b.items[0].sessionId,cwd:paper,nonblank:true,updatedAt:9999}]:[])]});
    const manual=noManual(t,r.api);await r.api.refresh();const {item:i}=await submitOne(r.api,'继续');
    if(shared) queued(i,'reuse',light,a.items[0].sessionId);else assert.equal(i.status,'clarify',i.reason);
    assert.equal(r.delivered.length,shared?1:0);assert.equal(r.creates.length,0);assert.equal(r.configured.length,0);assert.equal(manual.mock.callCount(),0);
  }
});

test('legacy parallel destinations have no unique last turn, regardless of which Promise finished last',async t=>{
  const rows=[{id:'old-a',cwd:paper,nonblank:true},{id:'old-b',cwd:light,nonblank:true}];
  const graph={id:'old-graph',items:rows.map(r=>({id:r.id,sessionId:r.id,project:r.cwd,text:'用户已批准的各自事项',
    requestId:'rpc-'+r.id,decision:'reuse',status:'new',dependsOn:[]}))};
  const r=rig(v020,{},{tasks:[graph],rows}),manual=noManual(t,r.api);await r.api.refresh();
  const items=r.journal.read().tasks[0].items;assert.ok(items.every(i=>i.accepted));assert.equal(items[0].routeOrder,items[1].routeOrder);
  assert.equal((await submitOne(r.api,'继续')).item.status,'clarify');assert.equal(r.delivered.length,2);assert.equal(r.creates.length,0);assert.equal(manual.mock.callCount(),0);
});
