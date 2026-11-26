import test from 'node:test';
import assert from 'node:assert/strict';
import {planRequest} from '../src/planner/index.mjs';

const stage='/work/amber',sky='/work/blue',general='/work/common';
const slot=(model,effort='',provider='local')=>({provider,model,effort});
const settings={generalDir:general,defaultProject:stage,projects:[{name:'剧场灯光排练',path:stage},{name:'天象观测',path:sky}],
  tiers:{fast:slot('light'),standard:slot('normal'),deep:slot('heavy')}};
const row=(id,cwd,title,extra={})=>({id,cwd,title,...extra});
async function probe(text,opts={},answer=()=>({tier:'fast'})) {
  let calls=0;const [item]=await planRequest({text,settings,sessions:[],...opts,infer:m=>{
    calls++;const [i]=JSON.parse(m.user).items;
    return JSON.stringify({items:[{key:i.key,relation:'different',candidate:null,tier:'standard',requestQuote:i.text.slice(0,32),candidateQuote:'',...answer(i)}]});
  }});
  assert.equal(item.text,text);assert.deepEqual(item.dependsOn,[]);return {item,calls};
}

test('unique same work, including a recent excerpt or a verified local tie break: no tier-only consultation on reuse',async()=>{
  const work='核对 BV-42 的光谱读数', other=row('other',stage,work), live=row('admitted',sky,'',{workHints:[work],busy:true,lastRoutedAt:17});
  for(const sessions of [[live],[other,live]]) {
    let reads=0;const {item,calls}=await probe(work,{sessions,getRecent:()=>{reads++;return [];}});
    assert.equal(calls,0);assert.equal(reads,0);assert.equal(item.decision,'reuse');assert.equal(item.sessionId,'admitted');
    assert.equal(item.project,sky);assert.match(item.reason,/正忙/u);
  }
  const reads=[];const {item,calls}=await probe('在天象观测项目继续'+work,{sessions:[other,row('in-range',sky,'工作笔记')],getRecent:id=>{reads.push(id);return [work];}});
  assert.deepEqual(reads,['in-range']);assert.equal(calls,0);assert.equal(item.sessionId,'in-range');assert.match(item.reason,/最近摘录/u);
});

test('settled creates: explicit selectors, unique domain, sole work directory, ordinary general question',async()=>{
  const work='核对 BV-42 的光谱读数',same=row('old',sky,work),only={...settings,projects:[settings.projects[1]],defaultProject:null};
  for(const [text,project,tier,opts] of [
    ['在天象观测项目另开会话，用深度档'+work,sky,'deep',{sessions:[same]}],
    ['在 /work/blue 实现亮度检查组件',sky,'standard'],
    ['在通用目录新建会话，用标准档写诗',null,'standard'],
    ['实现剧场灯光的色温登记组件',stage,'standard',{settings:{...settings,defaultProject:sky}}],
    ['实现亮度检查组件',sky,'standard',{settings:only}],
    ['如何申请病假？',null,'standard'],['解释一下 HTTP 缓存是什么',null,'standard'],['What is a JS promise?',null,'standard'],['你好！',null,'standard'],
  ]) {
    const {item,calls}=await probe(text,opts);assert.equal(calls,0,text);
    assert.deepEqual([item.decision,item.project,item.tier],['create',project,tier],text);assert.equal(item.sessionId,undefined);
  }
});

test('tier-only advice: compare reachable effective provider, model AND effort, not symbolic names or unrelated deep tier',async()=>{
  const text='在天象观测项目给冬季观测草稿补个开头',standard=slot('work');
  for(const [fast,same] of [[{provider:'local',model:'work'},true],[slot('work','low'),false],[slot('work','','other'),false],[slot('small'),false]]) {
    const config={...settings,tiers:{standard,fast,deep:slot('another','high')}};
    const {item,calls}=await probe(text,{settings:config});assert.equal(calls,same?0:1);
    assert.equal(item.tier,same?'standard':'fast');assert.equal(item.project,sky);assert.equal(item.decision,'create');
    if(!same) assert.match(item.reason,/模型建议经本地校验/u);
  }
});

test('a pinned project and tier do not suppress a partially supported session match',async()=>{
  const text='在天象观测项目用标准档核对 RasterGauge 精度，定位跨币换算最后一位', sessions=[row('lens',sky,'RasterGauge 的舍入偏差，周期末偶尔多一分')];
  const [base]=await planRequest({text,settings,sessions});assert.equal(base.decision,'create');
  const {item,calls}=await probe(text,{sessions},i=>({tier:'deep',relation:'same',candidate:i.candidates[0].ref,requestQuote:'RasterGauge 精度',candidateQuote:'RasterGauge 的舍入偏差'}));
  assert.equal(calls,1);assert.deepEqual([item.decision,item.sessionId,item.project,item.tier],['reuse','lens',sky,'standard']);assert.match(item.reason,/模型引用经核验/u);
});

test('new session and fixed tier are not a destination; a quoted project label can change even a sole-project/general fallback',async()=>{
  const propose=i=>({project:i.projects.find(p=>p.labels.includes('天象观测')).ref,projectQuote:'天象观测',requestQuote:'流星雨概率'});
  const only={...settings,projects:[settings.projects[1]],defaultProject:null};
  for(const [text,config,fallback] of [
    ['新建会话，用标准档实现一张今晚流星雨概率的时段图',settings,stage],
    ['今晚的流星雨概率，不太对劲。',only,null],
  ]) {
    const [base]=await planRequest({text,settings:config,sessions:[]});assert.equal(base.decision,'create');assert.equal(base.project,fallback);
    const {item,calls}=await probe(text,{settings:config},propose);assert.equal(calls,1);assert.equal(item.decision,'create');assert.equal(item.project,sky);assert.match(item.reason,/模型建议经本地校验/u);
  }
});
