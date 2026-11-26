// Public, fictional scenarios independent of the old fixture names. Exercise
// the planner API as the shipped controller would; no browser history or network.
import assert from 'node:assert/strict';
import test from 'node:test';
import {planRequest} from '../src/planner/index.mjs';

const projects=[{name:'石桥',path:'/work/bridge'},{name:'青禾',path:'/work/grain'}];
const base={projects,generalDir:'/work/inbox'};
const run=async(text,extra={})=>{
  const plan=await planRequest({settings:base,sessions:[],...extra,text});
  assert.equal(plan.length,1);assert.equal(plan[0].text,text);assert.deepEqual(plan[0].dependsOn,[]);return plan[0];
};
test('field: ordinary standalone text does not require a route or a classifier',async()=>{
  for(const text of ['你好','来个冷笑话','如何申请病假？','帮我设计一个生日派对']) {
    const one=await run(text,{infer:async()=>{throw Error('offline')}});
    assert.equal(one.decision,'create',one.reason);assert.equal(one.project,null,one.reason);
  }
  const independent='给本地构建脚本加上运行时长的统计';
  const selected=await run(independent,{settings:{...base,defaultProject:projects[1].path}});
  assert.equal(selected.decision,'create');assert.equal(selected.project,projects[1].path,selected.reason);
  const first=await run(independent);assert.equal(first.decision,'create',first.reason);assert.equal(first.project,projects[0].path);
  const ask=await run(independent,{settings:{...base,routingMode:'confirm'}});assert.equal(ask.decision,'clarify');
});
test('field: only allowed project labels can win; an unrelated recent native title cannot become a destination',async()=>{
  const text='展馆灯光的导览回路要分两路供电';
  const lighting={name:'展馆灯光排程',path:'/rooms/lighting'};
  const s=[{id:'ignored',cwd:'/private',title:text,updatedAt:99999,busy:true,workHints:[text]},
    {id:'other',cwd:projects[0].path,title:'出差报销规范',updatedAt:99998,busy:true}];
  for(const sessions of [s,[...s].reverse()]) {
    const one=await run(text,{settings:{...base,projects:[...projects,lighting],defaultProject:projects[1].path},sessions});
    assert.equal(one.decision,'create',one.reason);assert.equal(one.project,lighting.path,one.reason);assert.equal(one.sessionId,undefined);
  }
});
test('field: conflicting selectors, unknown routes, empty scope or destructive unscoped requests do not get a silent fallback',async()=>{
  const sessions=[{id:'bridge-1',cwd:projects[0].path,title:'迭代文档'},{id:'grain-1',cwd:projects[1].path,title:'上季度统计'}];
  for(const text of ['分别给石桥和青禾两个项目更新说明','核对 /work/unapproved 的数据','发到会话 bridge-1 和 grain-1','把所有数据库表清空']) {
    const one=await run(text,{sessions});assert.equal(one.decision,'clarify',text+': '+one.reason);assert.equal(one.sessionId,undefined);
  }
  const none=await run('来个冷笑话',{settings:{projects:[],generalDir:''},sessions});assert.equal(none.decision,'clarify');
});
