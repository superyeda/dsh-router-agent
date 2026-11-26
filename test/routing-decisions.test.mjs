import test from 'node:test';
import assert from 'node:assert/strict';
import {planRequest} from '../src/planner/index.mjs';

const north='/allowed/north', south='/allowed/south', general='/allowed/general';
const config={projects:[{name:'北岸',path:north},{name:'南港',path:south}],generalDir:general};
const row=(id,cwd,title,more={})=>({id,cwd,title,...more});
async function one(text,options={}) {
  const plan=await planRequest({text,settings:config,sessions:[],...options});
  assert.equal(plan.length,1);const [item]=plan;assert.deepEqual(item.dependsOn,[]);assert.equal(item.text,text.trim());return item;
}
const reply=(message,patch)=>{
  const [i]=JSON.parse(message.user).items;
  return JSON.stringify({items:[{key:i.key,relation:'different',candidate:null,tier:'standard',requestQuote:i.text.slice(0,60),candidateQuote:'',...patch?.(i)}]});
};
const unsure=m=>reply(m,()=>({relation:'unsure'}));

test('未设和显式 auto：中性消息无需白名单；不同任务类别选通用、默认或首个真实授权项目',async()=>{
  for(const marker of [{},{routingMode:'auto'}]) for(const infer of [undefined,()=>null,()=>{throw Error('offline');},unsure]) {
    const settings={...config,...marker,defaultProject:south};
    for(const text of ['你好','晚一点天凉，我想带件外套。','帮我想想','怎么准备面试？','如何申请病假？','帮我设计一个生日派对']) {
      const x=await one(text,{settings,infer});assert.deepEqual([x.decision,x.project],['create',null],text);
    }
    const text='实现在线预览组件';let x=await one(text,{settings,infer});assert.deepEqual([x.decision,x.project],['create',south]);assert.match(x.reason,/默认项目/u);
    x=await one(text,{settings:{...settings,defaultProject:'/not/authorized'},infer});assert.deepEqual([x.decision,x.project],['create',north]);assert.match(x.reason,/第一个|首个/u);
    x=await one('给我写封信',{settings:{...settings,generalDir:null},infer});assert.deepEqual([x.decision,x.project],['create',south]);
    x=await one(text,{settings:{projects:[],generalDir:general},infer});assert.deepEqual([x.decision,x.project],['create',null]);
  }
  assert.equal((await one('你好',{settings:{projects:[]}})).decision,'clarify');
});

test('纯承前表达仅采用本路由台唯一最新接纳，不读取原文、不问模型、不让原生最新或忙闲胜出',async()=>{
  const local=row('admitted',south,'', {lastRoutedAt:17,updatedAt:2,busy:true});
  const other=row('native',north,'曾讨论过其他事情',{lastRoutedAt:2,updatedAt:999999});
  const counters={reads:0,calls:0};const noIO={getRecent:()=>{counters.reads++;return [];},infer:()=>{counters.calls++;return null;}};
  for(const text of ['继续','接着呢？','把刚才那版再短一点','刚才那个，再展开一点。','再给一版','换个说法','改成表格','再详细一些']) {
    const x=await one(text,{sessions:[other,local],...noIO});assert.equal(x.sessionId,local.id,text);assert.equal(x.project,south);
  }
  for(const sessions of [[row('native',north,'决不能因为只有它而选中',{updatedAt:9999})],[local,{...other,lastRoutedAt:17}],[]]) {
    const x=await one('继续',{sessions,...noIO});assert.equal(x.decision,'clarify');assert.equal(x.sessionId,undefined);
  }
  assert.deepEqual(counters,{reads:0,calls:0});
  assert.equal((await one('在北岸项目继续',{sessions:[row('sole',north,'普通工作笔记')]})).sessionId,'sole','点名范围并明确要求继续时，该范围唯一候选可独立定位');
  for(const text of ['写一封请假邮件','别管刚才的，聊一件新事','潮位读数里那个尖峰，不太对劲。']) assert.equal((await one(text,{sessions:[local,other]})).decision,'create',text);
});

test('这个项目是目录指示不是会话身份证明：本地/默认只选目录，明示对象强证据仍有优先权',async()=>{
  const settings={...config,defaultProject:north}, sessions=[row('here',south,'日常笔记',{lastRoutedAt:5}),row('there',north,'修复 ERR-14 登录失败')];
  const fresh=await one('在这个项目添加回归测试',{settings,sessions});assert.deepEqual([fresh.decision,fresh.project],['create',south]);
  const known=await one('在这个项目修复 ERR-14 登录失败',{settings,sessions});assert.equal(known.sessionId,'there');
  const fallback=await one('在这个项目写文档',{settings});assert.deepEqual([fallback.decision,fallback.project],['create',north]);
  assert.equal((await one('在这个项目写文档')).decision,'clarify','没有可指代的目录，不能将首项说成“这个”');
});

test('不按原生顺序解决有力候选：有唯一相关本地赢家续接；否则只有明确跟进才问',async()=>{
  const text='修复 PAN-36 的导出死锁',a=row('a',north,text,{updatedAt:99}),b=row('b',south,text,{updatedAt:7,lastRoutedAt:4});
  assert.equal((await one(text,{sessions:[a,b],infer:unsure})).sessionId,'b');
  const tied=[{...a,lastRoutedAt:4},b];assert.equal((await one(text,{sessions:tied})).decision,'create');
  const ask=await one('继续'+text,{sessions:tied});assert.equal(ask.decision,'clarify');assert.deepEqual(new Set(ask.candidates),new Set(['a','b']));
  const unrelated=row('latest',north,'其他事项',{lastRoutedAt:7});
  assert.notEqual((await one(text,{sessions:[a,b,unrelated]})).sessionId,'b','不能先滤掉最近的不相关记录，再当第二新是“刚才”');
});

test('较新的具体已接纳原句可以取代过期标题，较新的对象冲突不能被旧匹配、时间或模型推翻',async()=>{
  const old='修复 SEC-28 的登录 401',current='修复 SEC-29 的登录 403';
  const at=(title,hints)=>row('r',south,title,{lastRoutedAt:12,workHints:hints});
  const match=await one(current,{sessions:[at(old,[old,current])]});assert.equal(match.sessionId,'r');
  const changed=await one(current,{sessions:[at(current,[current,old])],infer:m=>reply(m,i=>i.candidates[0]?{relation:'same',candidate:i.candidates[0].ref,candidateQuote:i.candidates[0].title}:{})});assert.equal(changed.decision,'create');
});

test('可信 same + 独立具体对象及症状可跨阈值；仅相似、unsure、伪造摘录或相反对象不续',async()=>{
  const title='RasterGauge 的舍入偏差，周期末偶尔多一分',text='核对 RasterGauge 精度，定位跨币换算最后一位';
  const sessions=[row('lens',south,title)], same=m=>reply(m,i=>({relation:'same',candidate:i.candidates[0].ref,requestQuote:'RasterGauge 精度',candidateQuote:'RasterGauge 的舍入偏差'}));
  assert.equal((await one(text,{sessions})).decision,'create','单靠弱对象不是同项证明');
  assert.equal((await one(text,{sessions,infer:same})).sessionId,'lens');
  assert.equal((await one(text,{sessions,infer:m=>reply(m,i=>({relation:'unsure',candidate:i.candidates[0].ref,candidateQuote:i.candidates[0].title}))})).decision,'create');
  for(const bad of ['捏造的证词','的']) {
    const x=await one(text,{sessions,infer:m=>reply(m,i=>({relation:'same',candidate:i.candidates[0].ref,candidateQuote:bad}))});assert.equal(x.decision,'create');
  }
  assert.equal((await one('RasterGauge 超时，慢请求不太对劲',{sessions:[{...sessions[0],lastRoutedAt:9}],infer:same})).decision,'create');
  const conf=await one(text,{settings:{...config,routingMode:'confirm'},sessions,infer:same});assert.equal(conf.decision,'clarify','保守策略仍只提议这个弱候选');
});

test('无共享 literal 的语义选址：≤4 个授权短标签、双向原文引用；不得传无关会话/隐私或接受任意路径',async()=>{
  const projects=[{name:'图书典藏',path:north},{name:'天象观测',path:south},{name:'海岛游记',path:'/allowed/island'},{name:'铜版印制',path:'/allowed/print'},{name:'第五个未展示',path:'/allowed/others'}];
  const settings={projects,generalDir:general,defaultProject:north}, text='按今晚可见的流星雨概率，实现一张时段预估图';
  const sessions=[row('private-id',north,'UNRELATED-PRIVATE-TITLE',{workHints:['LOCAL-ONLY-HINT somebody@private.invalid']}),row('intruder','/foreign','天象观测 SECRET-FOREIGN')];
  const select=patch=>m=>{const i=JSON.parse(m.user).items[0],p=i.projects.find(p=>p.labels.includes('天象观测'));
    assert.equal(i.projects.length,4);assert.deepEqual(i.candidates,[]);assert.doesNotMatch(m.user,/\/allowed|\/foreign|PRIVATE|LOCAL-ONLY|SECRET-FOREIGN|private-id|private\.invalid|第五个未展示/u);
    return reply(m,()=>({requestQuote:'流星雨',project:p.ref,projectQuote:'天象观测',...patch}));};
  const x=await one(text,{settings,sessions,infer:select({})});assert.deepEqual([x.decision,x.project],['create',south]);assert.match(x.reason,/核验/u);
  for(const patch of [{project:'/foreign'},{project:'p5'},{project:'p1'},{projectQuote:'凭空生成的证据'},{requestQuote:'伪造的报告'}]) {
    const safe=await one(text,{settings,sessions,infer:select(patch)});assert.deepEqual([safe.decision,safe.project],['create',north]);assert.match(safe.reason,/未通过校验/u);
  }
});

test('硬保护优先于默认目录、最佳会话和模型；业务审批原文不是路由授权或拆分指令',async()=>{
  const settings={...config,defaultProject:north},sessions=[row('good',north,'修复 BUG-4',{lastRoutedAt:1})];let calls=0;
  const io={settings,sessions,infer:()=>{calls++;return null;},getRecent:()=>{calls++;return [];}};
  for(const t of ['给北岸和南港各做一版','在北岸项目做检查，另在通用目录写摘要','给未知的火星项目发版','不用北岸项目处理 BUG-4','在 /unknown/run 修改','就选第二个','先让我选目标目录再送出','请先问我，再决定用哪个会话','请发到会话 ID：','新建会话，同时沿用之前的会话','用低档和深度档处理同一问题']) {
    const x=await one(t,io);assert.equal(x.decision,'clarify',t);assert.equal(x.sessionId,undefined,t);
  }
  assert.equal(calls,0);
  const business=await one('在北岸项目准备发布，等法务审批通过后再上线',{settings});assert.equal(business.decision,'create');
});

test('多项目且无默认或独立选址证据，不仅凭列表首项指派大范围不可逆操作',async()=>{
  for(const text of ['把所有数据库表清空','删掉库里所有数据','清空数据库','强制覆盖生产环境']) {
    assert.equal((await one(text)).decision,'clarify',text);
    const explicit=await one('在北岸项目'+text);assert.deepEqual([explicit.decision,explicit.project],['create',north]);
    const configured=await one(text,{settings:{...config,defaultProject:south}});assert.deepEqual([configured.decision,configured.project],['create',south]);
  }
  assert.equal((await one('删掉一个重复标点')).decision,'create');assert.equal((await one('解释一下清空数据库是什么意思')).decision,'create');
});
