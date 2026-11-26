import test from 'node:test';
import assert from 'node:assert/strict';
import {acceptedWork,reserveRouteOrder} from '../src/core/routing-context.mjs';

const allowed=new Set(['/north','/south']);
const item=(sessionId,project,extra={})=>({sessionId,project,text:'用户原句',payload:'用户原句',requestId:'rq-'+sessionId,
  afterSeq:1,decision:'reuse',attempted:true,accepted:true,...extra});
const row=(id,cwd,extra={})=>({id,cwd,title:'native',...extra});
const a=item('A','/north',{routeOrder:10}), b=item('B','/south',{routeOrder:20});
const rows=[row('A','/north',{updatedAt:999}),row('B','/south'),row('native-newest','/south',{updatedAt:9999,lastRoutedAt:9999})];
const marked=(tasks,clock,roster=rows,scope=allowed)=>acceptedWork(tasks,scope,clock).forPlan(roster).filter(r=>Object.hasOwn(r,'lastRoutedAt')).map(r=>[r.id,r.lastRoutedAt]);

test('only one real roster row gets the verified local watermark; bogus native fields and lower ranks never leak through',()=>{
  const tasks=[{createdAt:200,items:[a]},{createdAt:1,items:[b]}];
  assert.deepEqual(marked(tasks,20),[['B',20]]);assert.equal(rows[2].lastRoutedAt,9999,'native input is not mutated');
  for(const roster of [rows.filter(r=>r.id!=='B'),[rows[0],row('B','/north')],[...rows,row('B','/south')]])
    assert.deepEqual(marked(tasks,20,roster),[],'missing, moved or ambiguous head cannot promote A');
  assert.deepEqual(marked(tasks,20,rows,new Set(['/north'])),[],'revoking B cannot promote A');
  assert.deepEqual(marked([{items:[a]}],20),[],'even if B was cleared in a different tab');
});

test('first durable outbox order is stable across wall-clock ties/rollback, retries and delayed receipt recovery',()=>{
  const doc={},first={},second={};reserveRouteOrder(doc,first,80);first.attempted=true;
  reserveRouteOrder(doc,second,70);reserveRouteOrder(doc,first,9000);
  assert.deepEqual([first.routeOrder,second.routeOrder,doc.routeClock],[80,81,81]);
  const lost={...b,routeOrder:81,accepted:false},earlier={...a,routeOrder:80};
  assert.deepEqual(marked([{items:[earlier,lost]}],81),[],'unknown admission is not a receipt');
  lost.accepted=true;assert.deepEqual(marked([{items:[lost,earlier]}],81),[['B',81]]);
  for(const invalid of [{attempted:false},{accepted:false},{decision:'clarify'},{requestId:''},{afterSeq:-5},{payload:'not sent as the original'}])
    assert.deepEqual(marked([{items:[earlier,{...lost,...invalid}]}],81),[]);
  assert.deepEqual(marked([{items:[lost,{...earlier,routeOrder:81}]}],81),[],'two claimants to one ordinal');
});

test('legacy absence of per-admission clocks permits only agreement on the same proven target, never array order or task.createdAt',()=>{
  const first=item('A','/north'),follow=item('A','/north',{requestId:'later'}),other=item('B','/south');
  assert.deepEqual(marked([{items:[first,follow]}]),[['A',1]]);
  for(const tasks of [[{createdAt:77,items:[other]},{createdAt:1,items:[first,follow]}],
    [{createdAt:1,items:[first,follow]},{createdAt:77,items:[other]}],[{items:[first,{...other,attempted:true,accepted:false}]}]])
    assert.deepEqual(marked(tasks),[]);
  assert.deepEqual(marked([{items:[first]}],0),[],'persisted cleanup barrier');
  assert.deepEqual(marked([{items:[first]}],undefined,[]),[],'history is not a roster');
});

test('a follow-up on the oldest task gets current binding proof beyond the bounded hint window, unless another directory disputes it',()=>{
  const padding=Array.from({length:200},()=>({items:[]}));
  const newest={...b,requestId:'newest-rpc'}, oldest={items:[item('B','/south',{requestId:'first-rpc'}),newest]};
  const tasks=[{items:[a]},...padding,oldest];const work=acceptedWork(tasks,allowed,20);
  assert.deepEqual(work.bindings[0],{id:'B',cwd:'/south',requestId:'newest-rpc',afterSeq:1});assert.deepEqual(marked(tasks,20),[['B',20]]);
  assert.deepEqual(work.forPlan(rows).find(r=>r.id==='B').workHints,[newest.text],'do not lose the actual latest authored work beyond hint budgets');
  tasks.push({items:[item('B','/now-revoked',{requestId:'different-rpc'})]});
  assert.deepEqual(marked(tasks,20),[]);assert.ok(!acceptedWork(tasks,allowed,20).bindings.some(r=>r.id==='B'));
});

test('an edited legacy handoff can prove its actual destination but its replacement and assistant results never become work hints',()=>{
  const actual='人工确认的整份交接（含助手结果）',i={...a,approved:true,handoff:actual,payload:actual,result:'private'};
  const [r]=acceptedWork([{items:[i]}],allowed,10).forPlan(rows);
  assert.equal(r.lastRoutedAt,10);assert.deepEqual(r.workHints,[]);assert.ok(!JSON.stringify(r).includes('交接'));assert.ok(!JSON.stringify(r).includes('private'));
  assert.deepEqual(marked([{items:[{...i,handoff:'not the admitted text'}]}],10),[]);
});
