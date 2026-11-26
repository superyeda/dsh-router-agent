import test from 'node:test';
import assert from 'node:assert/strict';
import {planRequest} from '../src/planner/index.mjs';
import {LIMITS} from '../src/planner/inference.mjs';

const settings={projects:[{name:'商城',path:'/work/shop'},{name:'Atlas',path:'/work/atlas'}],generalDir:'/work/general',tiers:{fast:'unused-fast',standard:'unused-standard',deep:'unused-deep'}};
const row=(id,cwd,title,time=20,extras={})=>({id,cwd,title,updatedAt:time,busy:false,...extras});
const make=(text,o={})=>planRequest({text,settings,sessions:[],...o});
const one=async(text,o)=>{
  const items=await make(text,o);assert.equal(items.length,1,JSON.stringify(items));
  const [item]=items;assert.equal(item.key,'t1');assert.equal(item.text,text.trim());assert.deepEqual(item.dependsOn,[]);
  return item;
};
const answer=(message,patch=()=>({}))=>JSON.stringify({items:JSON.parse(message.user).items.map(i=>({key:i.key,relation:'different',candidate:null,tier:'standard',requestQuote:i.text.slice(0,40),candidateQuote:'',...patch(i)}))});

test('真实入口：发版检查与另一个项目的清单在同一句时，只问一个目标，不读历史',async()=>{
  const conf={...settings,projects:[{name:'A',path:'/demo/A'},{name:'B',path:'/demo/B'}]};
  let reads=0;const opts={settings:conf,sessions:[row('old','/demo/A','A 项目发版检查')],getRecent:async()=>{reads++;return ['继续发版检查'];}};
  const item=await one('继续 A 项目昨天的发版检查；另外给 B 项目做一份新的导出验收清单。',opts);
  assert.equal(item.decision,'clarify');assert.equal(item.project,null);assert.equal(item.sessionId,undefined);
  assert.equal((await one('继续 A 项目昨天的发版检查',opts)).sessionId,'old');
  assert.equal((await one('给 B 项目做一份新的导出验收清单。',opts)).decision,'create');assert.equal(reads,0);
});

test('同一工作而非最近会话；忙会话可排队；相邻目录不参与，明确新开优先',async()=>{
  const sessions=[row('exact','/work/shop','修复登录 401',1,{busy:true}),row('newer','/work/shop','新增登录动画',900),row('sub','/work/shop/test','修复登录 401'),row('unknown','/work/shop-tools','修复登录 401')];
  let reads=0;const o={sessions,getRecent:async()=>{reads++;return [];}};
  const x=await one('在商城项目继续修复登录 401',o);
  assert.equal(x.decision,'reuse');assert.equal(x.sessionId,'exact');assert.deepEqual(x.candidates,['exact']);assert.match(x.reason,/正忙|排队/u);assert.equal(reads,0);
  const y=await one('在商城项目另开会话修复登录 401',o);assert.equal(y.decision,'create');assert.ok(!('sessionId' in y));
});

test('同一主题、相同文件或不同错误码不能把新工作发给旧会话',async()=>{
  for(const [prior,next] of [['修复登录 401','修复登录 403'],['修复登录失败','新增登录动画'],['修复 auth.js 登录超时','修复 auth.js 退出死锁'],['修复导出金额小数点错误','编写导出金额小数点错误测试'],['修复导出金额小数点错误','修复导入金额小数点错误']]) {
    const x=await one('给商城项目'+next,{sessions:[row('near','/work/shop',prior)]});assert.equal(x.decision,'create',prior+' / '+next);
  }
});

test('模糊延续 / 多个同工作候选：给 ID 但不能用一个由时间胜出',async()=>{
  const sessions=[row('old','/work/shop','修复登录 401',1),row('busy-new','/work/shop','修复登录 401',2,{busy:true}),row('outside','/private','修复登录 401',7)];
  const a=await one('商城项目继续刚才那个',{sessions});assert.equal(a.decision,'clarify');assert.deepEqual(new Set(a.candidates),new Set(['old','busy-new']));
  const b=await one('继续修复商城的登录 401',{sessions});assert.equal(b.decision,'clarify');assert.deepEqual(new Set(b.candidates),new Set(['old','busy-new']));assert.ok(!('sessionId' in b));
  const c=await one('继续刚才那个',{sessions:[sessions[0]]});assert.equal(c.decision,'clarify');assert.deepEqual(c.candidates,['old']);
});

test('没有裸项目名也能延续唯一、具体的已知事项；无明确目录的代码新任务先问',async()=>{
  const sessions=[row('same','/work/shop','修复登录 401'),row('other','/work/atlas','登录文档')];
  assert.equal((await one('继续修复刚才的登录 401',{sessions})).sessionId,'same');
  assert.equal((await one('对订单模块进行重构',{sessions})).decision,'clarify');
  const only=await one('修复登录模块的 bug',{settings:{...settings,projects:[settings.projects[0]]},sessions});assert.equal(only.decision,'create');assert.equal(only.project,'/work/shop');
});

test('精确目录和项目名，包括带空格或正则特殊字符的名字；重名先问',async()=>{
  const conf={...settings,projects:[...settings.projects,{path:'/work/Atlas tools [2]',name:'Atlas[tools].v2'}]};
  for(const text of ['在目录“/work/Atlas tools [2]”写邮件','在 Atlas[tools].v2 项目写邮件']){const x=await one(text,{settings:conf});assert.equal(x.project,'/work/Atlas tools [2]');assert.equal(x.decision,'create');}
  for(const text of ['在 /work/shop-old 写邮件','在 /work/shop/sub 写邮件','在 /work/shop/../atlas 写邮件','在 ~/shop 写邮件','在 C:\\Unknown 写邮件','在 AtlasPlus 项目写邮件','在 飞船 项目写邮件','在 飞船和商城项目写邮件','给 Ghost 和 Atlas 项目写邮件','在这个项目写邮件','不用商城项目写邮件','在 @target@ 项目写邮件'])assert.equal((await one(text)).decision,'clarify',text);
  assert.equal((await one('在商城和 Atlas 项目写邮件')).decision,'clarify');
  assert.equal((await one('在商城项目写邮件',{settings:{...settings,projects:[...settings.projects,{name:'商城',path:'/else/shop'}]}})).decision,'clarify');
});

test('通用写作与问答只能用已配置通用目录；未知项目不降级到通用',async()=>{
  for(const text of ['写一首短诗','请解释 HTTP 缓存是什么','在通用目录写封邮件','不涉及项目，写一篇文章']){const x=await one(text);assert.equal(x.decision,'create',text);assert.equal(x.project,null);}
  assert.equal((await one('给陌生项目写一封邮件')).decision,'clarify');
  for(const dir of ['',undefined,'relative','/a/../b'])assert.equal((await one('写一首短诗',{settings:{...settings,generalDir:dir}})).decision,'clarify');
});

test('会话 ID 只能明确点名且在当前精确目录；重复/未知/越界/前缀拒绝',async()=>{
  const sessions=[row('s1','/work/atlas','随笔'),row('s2','/work/shop','打包'),row('s3','/work/atlas/sub','编写文档')];
  assert.equal((await one('请回到会话 s1 查看进展',{sessions})).sessionId,'s1');
  for(const text of ['在商城项目继续会话 s1','继续会话 s3','在商城项目发到会话 s2/invalid','继续会话 s1 和会话 s2','新建会话并继续会话 s1','在商城项目写邮件到会话 gone'])assert.equal((await one(text,{sessions})).decision,'clarify',text);
  assert.equal((await one('继续会话 s1',{sessions:[...sessions,{...sessions[0],cwd:'/work/shop'}]})).decision,'clarify');
});

test('同目标多步骤只规划一个会话，跨项目不继承或挑选其中一个',async()=>{
  for(const text of ['先在商城项目创建接口，再根据上一步的结果编写测试','先在商城项目创建接口，完成后再编写测试']) {
    const item=await one(text);assert.equal(item.decision,'create');assert.equal(item.project,'/work/shop');
  }
  for(const text of ['写一篇短文，生成三条标题','任务A：写邮件（依赖任务B）；任务B：写文章']) {
    const item=await one(text);assert.equal(item.decision,'create');assert.equal(item.project,null);
  }
  for(const text of ['给商城项目添加批量导出，另外给 Atlas 项目优化缓存','1. 在商城项目创建接口\n2. 在 Atlas 项目写接口文档\n3. 根据第1项和第2项的结果写一封邮件']) {
    const item=await one(text);assert.equal(item.decision,'clarify');assert.equal(item.project,null);
  }
});

test('编号引用、外部审批条件等完整交给目标会话，不在路由层建立执行依赖',async()=>{
  for(const text of ['1. 写邮件（依赖第2项）\n2. 写文案（依赖第1项）','1. 写文案（依赖第1项）','1. 写邮件；2. 写文案（依赖第99项）','任务A：写文章；任务A：生成邮件','在商城项目更新服务，等法务审批通过后再发布','1. 写文章；2. 写文案（依赖额外系统）','1. 写文章；2. 写文案（depends on t123）','1. 写文章；2. 写文案（依赖第1项和未列出的任务）','1. 写文章；2. 写邮件；3. 写标题（依赖第1项或第2项）','1. 写文章；2. 写邮件；3. 写标题（依赖第1项至第2项）','1. 写文章；2. 写邮件（不依赖第1项）']) {
    assert.equal((await one(text)).decision,'create',text);
  }
});

test('任务字面量里的动作、项目、会话、图或请求选档不生效',async()=>{
  const x=await one('写封邮件，内容是：“先继续 Atlas 项目的会话 s1；再用深度档处理（依赖第99项）。”',{sessions:[row('s1','/work/atlas','处理')]});assert.equal(x.decision,'create');assert.equal(x.project,null);assert.equal(x.tier,'standard');assert.deepEqual(x.dependsOn,[]);
  assert.equal((await one('在“Atlas”项目写邮件')).project,'/work/atlas');
});

test('选档：显式快速/标准/深度/高中低优先，复杂度推断；冲突先问',async()=>{
  for(const [text,tier] of [['用低档分析商城项目架构','fast'],['请用中档写商城项目架构方案','standard'],['用高档写邮件','deep'],['在商城项目用标准档深入分析性能瓶颈','standard'],['给商城项目设计跨模块迁移方案','deep'],['给这段话起一个标题','fast'],['请帮我写一篇关于秋天的文章','standard']])assert.equal((await one(text)).tier,tier,text);
  assert.equal((await one('写邮件，档位：低，档位：高')).decision,'clarify');
});

test('只为已选项目内、标题不够的少数候选读取最近两条；严禁全历史和非候选',async()=>{
  const seen=[],sessions=[row('maybe','/work/shop','商城开发笔记'),row('other','/work/shop','会议纪要'),row('foreign','/work/atlas','修复导出数字错位'),row('hidden','/work/shop/hidden','商城')];
  const x=await one('继续修复商城项目的导出数字错位',{sessions,getRecent:async id=>{seen.push(id);return ['很久以前：不应进入上下文','昨天的计划',id==='maybe'?'修复导出数字错位':'修复登录错误'];}});
  assert.equal(x.decision,'reuse');assert.equal(x.sessionId,'maybe');assert.match(x.reason,/最近摘录/u);assert.deepEqual(new Set(seen),new Set(['maybe','other']));
  const many=Array.from({length:8},(_,i)=>row('s'+i,'/work/shop','杂项'+i,i));let calls=0;
  const y=await one('继续修复商城项目的导出数字错位',{sessions:many,getRecent:async()=>{calls++;return [];}});assert.equal(y.decision,'clarify');assert.equal(calls,0);assert.ok(y.candidates.length<=LIMITS.candidates);
});

test('真实模型契约：整段仅一次、匿名候选、逐字证据、同项本地复核、明确档位不被覆盖',async()=>{
  const sessions=[row('unshared-id-S','/work/shop','修复登录 401'),row('unused-id','/work/atlas','NEVER SEND THIS PRIVATE TITLE'),row('hidden-id','/else','NEVER SEND THIS PRIVATE TITLE')];let calls=0,recent=0,wire;
  const x=await one('继续修复商城项目的登录 401；请用低档。',{sessions,getRecent:async()=>{recent++;return [];},infer:async m=>{
    calls++;wire=m;
    return answer(m,i=>({relation:'same',candidate:i.candidates[0].ref,candidateQuote:'登录 401',tier:'deep'}));
  }});
  assert.equal(calls,1);assert.equal(recent,0);assert.ok(wire.signal instanceof AbortSignal);assert.ok(wire.system.length>10);
  assert.doesNotMatch(wire.user,/\/work\/|unshared-id-S|PRIVATE TITLE|unused-fast/u);assert.equal(JSON.parse(wire.user).items.length,1);
  assert.equal(x.sessionId,'unshared-id-S');assert.match(x.reason,/模型建议经本地校验/u);assert.equal(x.tier,'fast');
  const fresh=await one('在商城项目添加购物车展示',{infer:async m=>answer(m,()=>({tier:'deep'}))});assert.equal(fresh.decision,'create');assert.equal(fresh.tier,'standard','模型不能把常规实现一律抬到 deep');
});

test('模型语义候选只作建议：不存在同事项独立证据不能复用，模型也不能解除硬澄清',async()=>{
  const sessions=[row('cand','/work/shop','商城登录设计')];let modelCalls=0;
  const infer=async m=>{modelCalls++;return answer(m,i=>({relation:'same',candidate:i.candidates[0].ref,candidateQuote:i.candidates[0].title}));};
  const x=await one('在商城项目跟进登录文档',{sessions,infer});assert.equal(x.decision,'clarify');assert.deepEqual(x.candidates,['cand']);assert.match(x.reason,/模型提出/u);
  for(const t of ['在未知项目写邮件','在商城和 Atlas 项目继续上次的工作','继续会话 unauthorized'])assert.equal((await one(t,{sessions,infer})).decision,'clarify');assert.equal(modelCalls,1);
});

test('分类回复严格校验：拒绝围栏、额外字段、未知 id/key/tier、伪造摘录、遗漏/重复和超限；整体回退',async()=>{
  const sessions=[row('real','/work/shop','修复登录 401')];
  const patch=p=>s=>{const data=JSON.parse(s);Object.assign(data.items[0],p);return JSON.stringify(data);};
  const cases=[()=>'{', s=>'~~~json\n'+s+'\n~~~',()=> 'x'.repeat(LIMITS.replyBytes+1),patch({tier:'vendor-model'}),patch({relation:'dispatch'}),patch({key:'t0'}),patch({requestQuote:'伪造证据'}),patch({relation:'same',candidate:'real',candidateQuote:'登录 401'}),()=>' {"items":[]}',s=>{const d=JSON.parse(s);d.items.push({...d.items[0]});return JSON.stringify(d);},patch({project:'/etc'}),patch({dependsOn:[]}),patch({relation:'same',candidate:'c1',candidateQuote:'没有这个摘录'})];
  for(const corrupt of cases){let produced=false;const x=await one('继续修复商城的登录 401',{sessions,infer:async m=>{const raw=corrupt(answer(m));produced=true;return raw;}});assert.ok(produced);assert.equal(x.sessionId,'real');assert.match(x.reason,/未通过校验/u);}
  const fail=await one('在商城项目跟进刚才的事情',{sessions,infer:async()=>{throw Error('untrusted secret');}});assert.equal(fail.decision,'clarify');assert.doesNotMatch(fail.reason,/untrusted secret/u);
});

test('请求和上下文预算：仅尾部有界摘录，长列表不静默丢项/截断，离线不需要模型',async()=>{
  const messages=['NEVER TRANSMIT OLD','NEVER TRANSMIT PREFIX'+ 'x'.repeat(800),'这次要修复商城导出数字错位'];let sent;
  const x=await one('继续修复商城的导出数字错位',{sessions:[row('can','/work/shop','杂项')],getRecent:async()=>messages,infer:async m=>{sent=m;const c=JSON.parse(m.user).items[0].candidates[0];return answer(m,()=>({relation:'same',candidate:c.ref,candidateQuote:c.recent.at(-1)}));}});
  assert.equal(x.decision,'reuse');assert.doesNotMatch(sent.user,/NEVER TRANSMIT/u);assert.ok(Buffer.byteLength(sent.user+sent.system)<=LIMITS.requestBytes);
  const snippets=JSON.parse(sent.user).items[0].candidates[0].recent;assert.ok(snippets.length<=2 && snippets.every(s=>s.length<=LIMITS.snippetChars));
  const raw='写文章'+'长'.repeat(LIMITS.textChars);let calls=0;const y=await one(raw,{infer:async()=>{calls++;return '';}});assert.equal(y.decision,'clarify');assert.equal(calls,0);
  const list=Array.from({length:16},(_,i)=>(i+1)+'. 写文章').join('\n');assert.equal((await one(list)).decision,'create');
  let budgetCalls=0;const full=await one('写一篇文章'+ '长'.repeat(4000),{infer:async()=>{budgetCalls++;return ''}});assert.equal(budgetCalls,0);assert.match(full.reason,/超出预算/u);
});

const install1='把 docs/install.md 的 Linux 安装标题中「安裝」改成「安装」。';
const install2='docs/install.md 里 Linux 安装那一行标题，请把「安裝」写成「安装」，保留标题格式。';
const design='设计跨区域订单事件系统的容灾架构，比较一致性和可用性的取舍，给出幂等、故障切换与分阶段迁移方案。';
const onlyProject={...settings,projects:[{name:'北岸文档',path:'/demo/north'}]};
const unsure=async m=>answer(m,()=>({relation:'unsure',tier:'deep'}));

test('桌面原句：不点名的首项自动选择唯一项目；在途空标题由已接纳原句续接，无关深度工作另开',async()=>{
  const first=await one(install1,{settings:onlyProject,infer:unsure});assert.equal(first.decision,'create');assert.equal(first.project,'/demo/north');assert.equal(first.tier,'fast');
  let reads=0,wire='';const existing=row('active','/demo/north','',3,{busy:true,workHints:[install1,'仅本地保存的已接纳原句-DO-NOT-SEND']});
  const second=await one(install2,{settings,sessions:[{...existing,cwd:'/work/atlas'},row('outside','/private','',20,{workHints:[install1]})],getRecent:async()=>{reads++;return [];},infer:async m=>{wire=m.user;return unsure(m);}});
  assert.equal(second.sessionId,'active');assert.equal(second.project,'/work/atlas');assert.match(second.reason,/本地已接纳/u);assert.match(second.reason,/正忙/u);assert.equal(reads,0);assert.doesNotMatch(wire,/DO-NOT-SEND|\/work\/|active/u);
  const third=await one(design,{settings:onlyProject,sessions:[existing],infer:unsure});assert.equal(third.decision,'create');assert.equal(third.project,'/demo/north');assert.equal(third.tier,'deep');
});

test('通用问答与写作不挤占项目；单通用目录也可承担实际编程工作；无目录不空投',async()=>{
  for(const text of ['解释一下 HTTP 缓存是如何工作的','What is a JavaScript promise?','How does HTTP caching work?','写一篇秋天的文章','如何实现一个简单的排序算法？']) {
    const y=await one(text,{settings:onlyProject,infer:unsure});assert.equal(y.decision,'create',text);assert.equal(y.project,null,text);
  }
  const x=await one(install1,{settings:{...settings,projects:[]},infer:unsure});assert.equal(x.decision,'create');assert.equal(x.project,null);assert.match(x.reason,/唯一|只有一个/u);
  assert.equal((await one(install1,{settings:{projects:[],generalDir:''}})).decision,'clarify');
  assert.equal((await one('在 /outside 写邮件',{settings:{...settings,projects:[]}})).decision,'clarify');
});

test('无继续词/无项目名：证实的标题或本地任务确定具体会话；两个同样强不猜',async()=>{
  const oneExact=row('s','/work/atlas','修复登录 401');const conf={...settings,defaultProject:'/work/shop'};
  for(const reply of ['different','unsure']) {
    const x=await one('修复登录 401',{settings:conf,sessions:[oneExact],infer:m=>answer(m,()=>({relation:reply}))});assert.equal(x.sessionId,'s');assert.equal(x.project,'/work/atlas');
  }
  const two=[row('a','/work/shop','一般笔记',999,{workHints:[install1]}),row('b','/work/atlas','空会话',1,{workHints:[install1]})];
  const both=await one(install2,{settings:conf,sessions:two,infer:unsure});assert.equal(both.decision,'clarify');assert.deepEqual(new Set(both.candidates),new Set(['a','b']));
  const explicit=await one('在 Atlas 项目另开会话：'+install2,{settings:conf,sessions:two});assert.equal(explicit.decision,'create');assert.equal(explicit.project,'/work/atlas');
  const notAllowed=await one(install2,{settings:conf,sessions:[row('bad','/work/atlas/sub','',1,{workHints:[install1]})]});assert.notEqual(notAllowed.sessionId,'bad');
});

test('工作历史不把不同日期、工单、文件、受众、同词反向替换或相反操作当同一件事',async()=>{
 const pairs=[['编写 2026-05-01 的库存周报','编写 2026-05-02 的库存周报'],['起草上周的销售周报','起草本周的销售周报'],['修复 P-17 的登录 401','修复 P-18 的登录 401'],['修复 docs/a.md 的标题','修复 docs/b.md 的标题'],[install1,install1.replace('Linux','Windows')],[install1,install1.replace('标题','页脚')],[install1,install1.replace('「安裝」改成「安装」','「安装」改成「安裝」')],['修复订单导出金额的小数点错误','修复库存导出金额的小数点错误'],['启用账单对账的定时任务','停用账单对账的定时任务'],['修复发票导出金额的小数点错误','给发票导出金额的小数点错误编写回归测试']];
 for(const [hint,text] of pairs){const x=await one('在商城项目'+text,{sessions:[row('wrong','/work/shop','',1,{workHints:[hint]})]});assert.equal(x.decision,'create',hint+' != '+text);}
});

test('默认是用户明确的最后选项：唯一证据和手工选择优先；否定/同项冲突/外部目录/续接保持边界',async()=>{
  const conf={...settings,defaultProject:'/work/shop'};
  const bare=await one('实现光栅化预览组件',{settings:conf});assert.equal(bare.decision,'create');assert.equal(bare.project,'/work/shop');assert.match(bare.reason,/默认项目/u);
  const explicit=await one('在 Atlas 项目实现光栅化预览组件',{settings:conf});assert.equal(explicit.project,'/work/atlas');
  const named=row('s','/work/atlas','',1,{workHints:[install1]});assert.equal((await one(install2,{settings:conf,sessions:[named]})).sessionId,'s');
  for(const text of ['在外星项目实现预览组件','不用商城项目实现预览组件','在 /work/atlas/sub 实现预览组件','Edit /private/code/test.js','替我编译 /opt/foreign-tree','在商城和 Atlas 项目实现预览组件','继续上次的实现']) assert.equal((await one(text,{settings:conf})).decision,'clarify',text);
  assert.equal((await one('给我写一篇关于旅行的文章',{settings:conf})).project,null);
  assert.equal((await one('实现光栅化预览组件',{settings:{...settings,defaultProject:'/work/shop/other'}})).decision,'clarify');
});

test('项目展示名、目录 basename 与真实标题可以定位新工作；证据不够或多个时不按默认排除',async()=>{
 const conf={...settings,defaultProject:'/work/shop',projects:[...settings.projects,{name:'发票账务平台',path:'/work/recon-kit'}]};
 const byBase=await one('在 recon-kit 项目增加新的检查组件',{settings:conf});assert.equal(byBase.project,'/work/recon-kit');
 const byDomain=await one('重构发票签发流程',{settings:conf});assert.equal(byDomain.project,'/work/recon-kit');assert.equal(byDomain.decision,'create');
 const ses=[row('a','/work/atlas','工具 Rasterizer 配置'),row('b','/work/shop','不公开的会话名称 PRIVATE_SECRET_TITLE')];let raw;
 const usingModel=await one('实现 Rasterizer 预览组件',{settings:conf,sessions:ses,infer:m=>{raw=m.user;return answer(m,i=>({project:i.projects[0].ref,projectQuote:'rasterizer'}));}});
 assert.equal(usingModel.project,'/work/atlas');assert.equal(usingModel.decision,'create');assert.match(usingModel.reason,/可核验/u);assert.doesNotMatch(raw,/\/work\/|PRIVATE_SECRET_TITLE/u);
 const malicious=await one('实现 Rasterizer 预览组件',{settings:conf,sessions:ses,infer:m=>answer(m,()=>({project:'p200',projectQuote:'rasterizer'}))});assert.equal(malicious.decision,'clarify');
 const ambiguous=await one('重构发票签发流程',{settings:{...conf,projects:[...conf.projects,{name:'发票云服务',path:'/other'}]}});assert.equal(ambiguous.decision,'clarify');
});

test('无继续/无项目也只读取已经筛选的少量具体候选；外部目录阻止整段投递，澄清保留完整复杂度',async()=>{
 let seen=[];const sessions=[row('near','/work/atlas','Redis 整理记录'),row('away','/work/shop','昨天的会议摘要')];
 const x=await one('排查 Redis 哨兵切换故障',{sessions,getRecent:async id=>{seen.push(id);return ['排查 Redis 哨兵切换故障'];}});assert.equal(x.decision,'reuse');assert.equal(x.sessionId,'near');assert.deepEqual(seen,['near']);
 const item=await one('在 /invalid 设计跨服务的容灾架构；另外写一篇周末短文',{settings:onlyProject,infer:unsure});assert.equal(item.decision,'clarify');assert.equal(item.tier,'deep');assert.equal(item.project,null);
});


test('“当前/这个项目”仅在唯一授权工作项目中可执行；仍拒绝外部或多项目，不按默认猜',async()=>{
 for(const t of ['在当前项目修复锁竞争','给这个项目新增导出接口']){
   const a=await one(t,{settings:onlyProject});assert.equal(a.decision,'create',t);assert.equal(a.project,'/demo/north');assert.match(a.reason,/一个已授权/u);
   const b=await one(t,{settings:{...settings,defaultProject:'/work/shop'}});assert.equal(b.decision,'clarify');
 }
 for(const t of ['在这个项目及 /outside 修改组件','在陌生项目修复锁竞争'])assert.equal((await one(t,{settings:onlyProject})).decision,'clarify',t);
});

test('一般写作优先通用，已派给项目的独特邀请函则沿用原绑定；不靠外部标题或相关主题猜',async()=>{
 const before='请在 Atlas 项目起草《北岸周年邀请函》，供活动主办方发送。',after='帮我重新拟一版北岸周年邀请函，语气正式一些。';
 const bound=row('invite','/work/atlas','临时会话',1,{workHints:[before]});const sim=row('title','/work/shop','起草《北岸周年邀请函》');
 const x=await one(after,{sessions:[bound,sim],infer:unsure});assert.equal(x.decision,'reuse');assert.equal(x.sessionId,'invite');assert.equal(x.project,'/work/atlas');
 for(const sessions of [[sim],[row('unrelated','/work/shop','',10,{workHints:['给活动主办方写一封邀请函']})],[row('sub','/work/atlas/tmp','',1,{workHints:[before]})]]) {
   const y=await one(after,{sessions});assert.equal(y.decision,'create');assert.equal(y.project,null);
 }
 const other=row('second','/work/shop','',100,{workHints:[before]});assert.equal((await one(after,{sessions:[bound,other]})).decision,'clarify');
 const gen=await one('在通用目录'+after,{sessions:[bound]});assert.equal(gen.decision,'create');assert.equal(gen.project,null);
});
