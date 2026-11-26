import test from 'node:test';
import assert from 'node:assert/strict';
import {createRouter} from '../src/core/controller.mjs';
import {memoryJournal} from '../src/core/journal.mjs';
import {bindPanelTransport} from '../src/client-transport.mjs';
import {LIMITS} from '../src/planner/inference.mjs';
import {limits as host} from '../src/host/contract.mjs';

const text='实现按末班时刻调整晚班接驳间隔的功能';
const tiers={provider:'qa-local',model:'qa',effort:''};
const settings={projects:[{name:'Print Studio',path:'/demo/one'},{name:'Transit Ops',path:'/demo/two'}],generalDir:'/demo/general',defaultProject:'/demo/one',modelMode:'manual',tiers:{fast:tiers,standard:tiers,deep:tiers}};
const reply=input=>{
  const [i]=JSON.parse(input.user).items,p=i.projects.find(p=>p.labels.includes('Transit Ops'));
  assert.ok(p);return JSON.stringify({items:[{key:i.key,relation:'different',candidate:null,tier:'standard',requestQuote:'末班时刻',candidateQuote:'',project:p.ref,projectQuote:'Transit Ops'}]});
};
function fixture(classify,extra={}) {
  let n=0;const journal=memoryJournal(), doc=journal.read(), creates=[], writes=[], entered=Promise.withResolvers();
  doc.settings=structuredClone(settings);journal.write(doc);
  const adapter={listWorkspaces:async()=>[],listSessions:async()=>[],catalog:async()=>[{...tiers,efforts:[]}],cursor:async()=>0,
    createSession:async(cwd,key)=>{creates.push({cwd,key});return 's'+creates.length;},configure:async()=>{},deliver:async(...args)=>writes.push(args),...extra};
  let calls=0;const api=createRouter({adapter,journal,id:()=>String(++n),infer:input=>{calls++;entered.resolve(input);return classify(input);}});
  return {api,journal,entered,creates,writes,count:()=>calls,item:()=>api.getState().tasks[0]?.items[0]};
}
const transport=invoke=>bindPanelTransport({remote:{routerAgent:{infer:invoke}}}).infer;

test('a real need for semantic advice: a valid 7.3s reply beats the wrong default, one classifier call / one exact admission',async t=>{
  t.mock.timers.enable({apis:['setTimeout']});
  const r=fixture(input=>new Promise(resolve=>setTimeout(()=>resolve(reply(input)),7300)));
  const pending=r.api.submit(text),{signal}=await r.entered.promise;
  t.mock.timers.tick(6501);await r.api.tick(); // stale background poll must not queue behind the active submit
  assert.equal(signal.aborted,false);assert.deepEqual(r.writes,[]);
  t.mock.timers.tick(799);await pending;assert.equal(r.count(),1);assert.equal(r.creates.length,1);assert.equal(r.writes.length,1);
  const item=r.item();assert.equal(item.status,'queued');assert.equal(item.project,'/demo/two',item.reason);assert.equal(r.writes[0][2],text);
  assert.match(item.reason,/模型建议经本地校验/);assert.equal(r.api.getState().notice,'');r.api.dispose();
});

test('real host failure categories or invalid data fall back once; visible on the task, never copied verbatim into a banner',async()=>{
  const original='client api: Remote invocation "routerAgent/infer" was aborted; PRIVATE_DIAGNOSTIC';
  for(const [code,why] of [['router-agent/timeout',/超时/],['router-agent/busy',/正忙/],['router-agent/model-unavailable',/快速档不可用/],['router-agent/inference-failed',/意图模型请求失败/],['gateway/internal',/远端结果/],['router-agent/output-invalid',/未通过校验/],['invalid-json',/未通过校验/]]) {
    const r=fixture(transport(async()=>code==='invalid-json'?{ok:true,value:{text:original}}:{ok:false,error:{code,message:original}}));
    await r.api.submit(text);const i=r.item();assert.equal(i.status,'queued');assert.equal(i.project,'/demo/one');assert.match(i.reason,why);
    assert.match(i.reason,/本地判断/);assert.doesNotMatch(i.reason,/PRIVATE|Remote invocation/);assert.equal(r.api.getState().notice,'');
    assert.equal(r.count(),1);assert.equal(r.creates.length,1);assert.equal(r.writes.length,1);r.api.dispose();
  }
});

test('client backstop outlives the host budget, aborts an unresponsive call and cannot overwrite the next notice or issue a second delivery',async t=>{
  t.mock.timers.enable({apis:['setTimeout']});assert.ok(LIMITS.inferMs>host.timeoutMs && LIMITS.inferMs<=host.timeoutMs+10000);
  const late=Promise.withResolvers(), r=fixture(()=>late.promise);const pending=r.api.submit(text),{signal}=await r.entered.promise;
  t.mock.timers.tick(host.timeoutMs);assert.equal(signal.aborted,false);assert.equal(r.writes.length,0);
  t.mock.timers.tick(LIMITS.inferMs-host.timeoutMs);await pending;assert.equal(signal.aborted,true);assert.match(r.item().reason,/超时/);
  await r.api.saveSettings(settings);const notice=r.api.getState().notice;assert.match(notice,/设置已保存/);
  late.reject(Error('late PRIVATE_TRANSPORT_ERROR'));await new Promise(setImmediate);
  assert.equal(r.count(),1);assert.equal(r.writes.length,1);assert.equal(r.api.getState().notice,notice);r.api.dispose();
});

test('a closed panel releases an in-flight preview, even when the transport ignores abort; its late result never dispatches',async()=>{
  const late=Promise.withResolvers(),r=fixture(()=>late.promise);
  const task=r.api.submit(text),closed=assert.rejects(task,/入口已关闭|路由请求已取消/),{signal}=await r.entered.promise;r.api.dispose();
  await closed;assert.equal(signal.aborted,true);assert.equal(r.journal.read().tasks.length,0);
  await r.journal.exclusive(()=>assert.equal(r.writes.length,0)); // another tab can get the lock before the late provider settles
  late.resolve('invalid');await new Promise(setImmediate);assert.equal(r.count(),1);assert.deepEqual(r.creates,[]);assert.deepEqual(r.writes,[]);
});

test('lost owner/mount or a failed fresh roster are not optional model advice: zero allocations and zero prompts',async()=>{
  for(const [code,reason] of [['remote-access/denied',/没有个人路由授权/],['gateway/cancelled',/路由请求已取消/],['router-agent/cancelled',/路由请求已取消/]]) {
    const r=fixture(transport(async()=>({ok:false,error:{code,message:'SECRET'}})));
    await assert.rejects(r.api.submit(text),reason);assert.deepEqual(r.creates,[]);assert.deepEqual(r.writes,[]);assert.equal(r.journal.read().tasks.length,0);r.api.dispose();
  }
  let rosters=0;const r=fixture(async()=>{throw Error('provider offline');},{listSessions:async()=>{if(++rosters>1)throw Error('连接已断开');return [];}});
  await assert.rejects(r.api.submit(text),/连接已断开/);assert.deepEqual(r.creates,[]);assert.deepEqual(r.writes,[]);r.api.dispose();
});

test('missing model catalog keeps its independent actionable notice and does not dispatch a new execution',async()=>{
  const r=fixture(()=>{throw Error('must not invoke a missing fast model');},{catalog:async()=>{throw Error('目录离线');}});
  await r.api.submit(text);assert.match(r.api.getState().notice,/模型目录不可用/);assert.equal(r.count(),0);
  assert.equal(r.item().status,'failed');assert.deepEqual(r.creates,[]);assert.deepEqual(r.writes,[]);r.api.dispose();
});
