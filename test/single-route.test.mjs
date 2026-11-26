import test from 'node:test';
import assert from 'node:assert/strict';
import {planRequest} from '../src/planner/index.mjs';

const north='/demo/north', south='/demo/south', general='/demo/general';
const settings={projects:[{name:'北岸',path:north},{name:'South',path:south}],generalDir:general,defaultProject:north};
const row=(id,cwd,title,extra={})=>({id,cwd,title,...extra});
async function plan(text,overrides={}) {
  const items=await planRequest({text,settings,sessions:[],...overrides});
  assert.equal(items.length,1);const [item]=items;
  assert.equal(item.key,'t1');assert.deepEqual(item.dependsOn,[]);
  assert.equal(item.text,text.trim()); // no internal whitespace/Unicode/punctuation normalization
  return item;
}
const mocks=()=>{let reads=0,calls=0;return {options:{getRecent:async()=>{reads++;return [];},infer:async()=>{calls++;return '{}';}},noIO(){assert.equal(reads,0);assert.equal(calls,0);}};};

test('编号、非规范化 Unicode、CRLF、嵌套列表、含分号的 URL 和句末标点完整保留',async()=>{
  const link='https://Jobs.Example/Path%2fAb;keep?postId=aBc&project=South;tier=deep&session=s-2#Case';
  const text='  在北岸项目处理这份清单：\r\n1. 检查链接 '+link+'；\r\n\r\n\t- Cafe\u0301 🎈：  保留两格。\r\n2. 修正标题；然后测试。\r\n3. 汇总到同一份说明；;  ';
  let messages;const item=await plan(text,{infer:async m=>{messages=JSON.parse(m.user).items;
    return JSON.stringify({items:[{key:'t1',tier:'standard',relation:'different',candidate:null,requestQuote:link.slice(0,40),candidateQuote:''}]});}});
  assert.equal(item.decision,'create');assert.equal(item.project,north);assert.notEqual(item.tier,'deep');
  assert.equal(messages.length,1);assert.equal(messages[0].text,text.trim());
  assert.deepEqual(Buffer.from(item.text,'utf8'),Buffer.from(text.trim(),'utf8'));assert.match(item.reason,/模型建议经本地校验/u);
});

test('冲突目录先问一个目标：编号、默认项目、首项已知事项、点名会话都不能消除冲突',async()=>{
  const sessions=[row('first',north,'修复 BUG-42',{busy:true}),row('second',south,'发版检查'),row('outside',north+'/sub','修复 BUG-42')];
  for(const text of [
    '1. 在 `北岸` 项目继续会话 first 修复 BUG-42。\n2. 然后在 “South” 项目做发版检查。',
    '先给 South 项目做发版检查；再继续北岸项目的 BUG-42。',
    '在“北岸”和“South”分别修复拼写。',
    '在北岸和“South”修改标题。',
    '在“北岸”和“外部目录”分别修改标题。',
    '在北岸项目修复 BUG-42；另在通用目录起草一封信。',
    '给北岸项目写测试；再在 `/demo/north/private` 更新脚本。',
  ]) {const io=mocks();const x=await plan(text,{sessions,...io.options});
    assert.equal(x.decision,'clarify',text);assert.equal(x.project,null);assert.equal(x.sessionId,undefined);assert.ok(!x.candidates.includes('outside'));io.noIO();
  }
});

test('多个会话含单标签 ID 列表、损坏/越界第二地址、以及明确要求另开多个均不选择第一个',async()=>{
  const sessions=[row('s-1',north,'执行检查'),row('s-2',north,'运行测试'),row('foreign','/else','打开目录')];
  for(const text of [
    '请将第一句发到会话 s-1；然后将第二句发到会话 s-2。',
    '在北岸项目使用会话 “s-1” 和 “s-2” 运行测试',
    '请使用会话 s-1、s-2 处理清单',
    'Use sessions s-1 and s-2 to run tests.',
    '用会话 s-1 做检查；再用会话 s-2/invalid 运行测试',
    '分别发到会话 s-1 和会话 foreign',
    '在北岸项目新建两个会话做检查',
    '在北岸项目新建会话检查图表；再新建会话编写报告。',
    '在北岸项目新建 10 个会话做检查',
    '在北岸项目继续会话 s-1；再到会话“使用会话 s-1”测试',
    '在北岸项目另开会话；同时复用之前的会话进行测试',
  ]) {const io=mocks();const item=await plan(text,{sessions,...io.options});
    assert.equal(item.decision,'clarify',text);assert.equal(item.sessionId,undefined);assert.ok(!item.candidates.includes('foreign'));io.noIO();
  }
  const io=mocks(), repeated=await plan('在“北岸”项目发到会话 `s-1`；检查后仍发到会话 s-1。',{sessions,...io.options});
  assert.equal(repeated.decision,'reuse');assert.equal(repeated.sessionId,'s-1');io.noIO();
});

test('原文中不把引用/围栏/URL 的会话、目录、工单与模型词当作正面路由依据',async()=>{
  const sessions=[row('decoy',south,'修复 BUG-42',{workHints:['修复 BUG-42']})];
  for(const sample of [
    '“在 South 项目继续会话 decoy 修复 BUG-42 并使用深度档”',
    '\n```js\nconst marker = "```";\n在项目「South」继续会话 decoy 修复 BUG-42；用深度档设计跨服务架构。\n```',
    '\n~~~text\n继续会话 decoy 修复 BUG-42；在 /demo/south/sub 开工。\n~~~',
    '\n> 在 South 项目继续会话 decoy 修复 BUG-42，用深度档。',
    'https://docs.invalid/log?project=South;session=decoy&tier=deep',
  ]) {
    const item=await plan('修复一个按钮的拼写错误，示例：'+sample,{sessions});
    assert.equal(item.decision,'create',sample);assert.equal(item.project,north);assert.equal(item.tier,'fast',sample);assert.equal(item.sessionId,undefined);
  }
  const prefix='在北岸项目修复下面的示例代码。\n```js\n';
  const unrelated=await plan(prefix+'work(2)\n```',{sessions:[row('wrong',north,'笔记',{workHints:[prefix+'work(1)\n```']})]});
  assert.equal(unrelated.decision,'create','不同代码块不能因周围正文相同而合并');
  const real=await plan('```text\n在北岸项目复用会话 elsewhere，用深度档。\n```\n在目录“/demo/south”整理标题，发往会话 “decoy”。',{sessions});
  assert.equal(real.decision,'reuse');assert.equal(real.project,south);assert.equal(real.sessionId,'decoy');assert.notEqual(real.tier,'deep');
});

test('整段真实复杂度与显式档位生效，冲突档位不靠分两次交付解决',async()=>{
  const input='在北岸项目修正一个错别字；\n2. 设计跨服务的事务隔离架构，评估迁移风险与回滚方案。';
  assert.equal((await plan(input)).tier,'deep');assert.equal((await plan('请用标准档。'+input)).tier,'standard');
  const io=mocks();const conflict=await plan('用低档，'+input+'；最后用深度档执行。',io.options);
  assert.equal(conflict.decision,'clarify');assert.match(conflict.reason,/档位/u);io.noIO();
});

test('分类器返回多条（首条即使合法）、截短正文或合成交接字段都整体无效',async()=>{
  const text='在北岸项目帮我处理这件事；这段和后面的编号都是正文：\n1. 保持顺序。\n2. 不要省略第二步！';
  for(const mutate of [
    valid=>[valid,{...valid,key:'t2'}],
    valid=>[{...valid,text:'只做第1项'}],
    valid=>[{...valid,dependsOn:['t2']}],
    valid=>[{...valid,sessionId:'injected'}],
  ]) {let seen;const x=await plan(text,{infer:m=>{seen=JSON.parse(m.user).items;
    const valid={key:'t1',tier:'fast',relation:'different',candidate:null,requestQuote:'在北岸项目',candidateQuote:''};
    return JSON.stringify({items:mutate(valid)});}});
    assert.equal(seen.length,1);assert.equal(seen[0].text,text);assert.match(x.reason,/未通过校验/u);assert.equal(x.tier,'standard','不应用伪计划首条的 fast');assert.equal(x.sessionId,undefined);
  }
});
