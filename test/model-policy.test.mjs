import test from 'node:test';
import assert from 'node:assert/strict';
import {chooseTier,tierFor} from '../src/planner/complexity.mjs';
import {routeText} from '../src/planner/grammar.mjs';
import {modelMode,resolveTiers} from '../src/core/models.mjs';

const forTask = text => tierFor(routeText(text));
const expectTier = (tier, tasks) => {
  for (const task of tasks) {
    const rule = forTask(task);
    assert.equal(rule.tier,tier,task);
    assert.equal(rule.fixed,true,task);
    assert.equal(rule.error,undefined,task);
    assert.match(rule.reason,/规则建议/u,task);
    for (const proposed of ['fast','standard','deep','injected',undefined]) assert.equal(chooseTier(rule,proposed),tier,task);
  }
};

test('light Chinese and English text edits, one-location changes and translation stay fast',()=>{
  expectTier('fast',[
    '把 docs/install.md 的 Linux 安装标题中「安裝」改成「安装」。',
    '给这段话起一个标题',
    '修正 README 里的一个错别字',
    '把这个标题改成「深度档」',
    '只格式化这个文件，不需要改架构',
    '翻译这两句话，保留标点',
    '调整这个按钮文案，只改这个词',
    'Fix the typo in the download heading.',
    'Translate the next sentence into Chinese.',
    'Only change indentation in this file; do not refactor the architecture.',
    'Change one CSS selector to use an existing class.',
    'Suggest a brief title for the announcement.',
  ]);
});

test('ordinary bounded implementation or acceptance will not be demoted or escalated by model advice',()=>{
  expectTier('standard',[
    '实现购物车列表筛选并补单元测试',
    '验收新登录页，并验证登录失败的提示',
    '添加购物车展示',
    '深入分析这个报表的颜色选项',
    '翻译这篇长文，并校对成稿',
    'Add an end-to-end test for the checkout form.',
    'Implement the search filter and add tests for empty results.',
    'Verify acceptance criteria for the form validation.',
    'Test deep linking in this page.',
    'Fix typos across three repositories.',
  ]);
});

test('concrete complex task facts justify a fixed deep tier, not isolated adjectives',()=>{
  expectTier('deep',[
    '设计跨服务库存同步架构与并发一致性',
    '快速编一个跨模块数据迁移计划，要考虑回滚',
    '评估三套数据架构，比较迁移风险、成本和吞吐',
    '排查间歇性支付错误，定位数据竞争以及重试时的幂等性',
    'Design inventory synchronization across services with eventual consistency and recovery.',
    'Investigate an intermittent race condition and isolate the source of the deadlocks.',
    'Compare two architectures on latency, migration risk, and budget.',
    'Plan an upgrade across three repositories with multiple rollout stages.',
  ]);
  const uncertain = forTask('请帮我看一看这一项');
  assert.equal(uncertain.tier,'standard');
  assert.equal(uncertain.fixed,undefined);
  assert.equal(chooseTier(uncertain,'deep'),'standard');
  assert.equal(chooseTier(uncertain,'fast'),'fast');
  assert.equal(chooseTier(uncertain,'some-model-id'),'standard');
  assert.equal(chooseTier(undefined,'deep'),'standard');
});

test('real explicit tier controls win; conflicting and alternative controls require clarification',()=>{
  for (const [task,tier] of [
    ['请用深度档修好这一个错别字','deep'],
    ['任务档位：深度，帮我检查一个标点','deep'],
    ['请不要用深度档，用标准档改一个标点。','standard'],
    ['用快速档分析分布式事务里的死锁','fast'],
    ['Set model tier to deep, then fix this typo.','deep'],
    ['Use the fast tier to redesign this system.','fast'],
    ['Standard tier: fix the typo.','standard'],
  ]) {
    const rule = forTask(task);
    assert.equal(rule.tier,tier,task);
    assert.equal(rule.fixed,true,task);
    assert.match(rule.reason,/用户指定/u,task);
    assert.equal(chooseTier(rule,tier === 'deep' ? 'fast' : 'deep'),tier,task);
  }
  for (const task of [
    '先用深度档，再用快速档查这个拼写',
    '用快速档或者深度档改文字',
    'Use the fast tier or the deep tier for this task.',
    'Use the fast tier, but do not use the fast tier.',
  ]) {
    const rule = forTask(task);
    assert.match(rule.error,/多个档位/u,task);
    assert.equal(chooseTier(rule,'fast'),'standard',task);
  }
});

test('ignores quoted/literal model words, examples, negation and adjective-only tier cues',()=>{
  for (const task of [
    '修正说明里的「请采用深度档」这句话',
    '翻译下面这一句，例如：use the deep tier.',
    '把用深度档这一行翻译成英文',
    '为「深度档」按钮撰写一个标题',
    '快速实现购物车展示',
    '用高档材料制作桌面样品',
    '在深度学习项目中修正 README 的一个错别字',
    'Translate the words “use the deep tier” into Chinese.',
    'Fix the heading, for example: use the deep tier.',
    'Fix the typo. Do not use the deep tier.',
    'If use the deep tier, the output becomes too long. Fix a typo instead.',
    'Fix the misspelling in deepseek.',
  ]) assert.doesNotMatch(forTask(task).reason,/用户指定/u,task);
});

const names = ['fast','standard','deep'];
const rows = (provider,models,efforts = ['xhigh','high','off','medium','low','max']) => models.map(model => ({provider,model,efforts}));
const levels = {fast:'low',standard:'medium',deep:'high'};
const selection = (provider,model,effort = '') => ({provider,model,effort});
const fitted = (provider,ids,efforts = levels) => Object.fromEntries(names.map((tier,index) => [tier,selection(provider,ids[index],efforts[tier])]));
const same = (provider,model,effort = '') => fitted(provider,[model,model,model],Object.fromEntries(names.map(name => [name,effort])));
const models = resolved => new Set(Object.values(resolved).map(route => route.model));

test('legacy identical choices use automatic mode, legacy distinct choices preserve manual effort and provider',()=>{
  assert.equal(modelMode(undefined),'auto');
  assert.equal(modelMode({tiers:same('team','all')}),'auto');
  const legacy = fitted('team',['all','all','all']);
  assert.equal(modelMode({tiers:legacy}),'manual','different effort is a real manual choice');
  const split = {...legacy, deep:selection('other','all','high')};
  assert.equal(modelMode({tiers:split}),'manual');
  assert.deepEqual(resolveTiers({tiers:split},[...rows('team',['all','another-fast']),...rows('other',['all','other-pro'])]),split);
  const pinned = same('team','all','medium');
  assert.equal(modelMode({modelMode:'manual',tiers:pinned}),'manual');
  assert.deepEqual(resolveTiers({modelMode:'manual',tiers:pinned},rows('team',['all','another-fast','another-pro'])),pinned);
});

test('automatic tiers honor actual GPT family and same-generation evidence, with no account assumptions',()=>{
  const a = rows('switched-provider',['gpt-6.2-astra','gpt-6.2-luna','gpt-6.2-sol','gpt-6.1-sol','gpt-5.4-nano']);
  const strongerElsewhere = rows('other-provider',['gpt-6.5-luna','gpt-6.5-sol','gpt-6.5-astra']);
  const cfg = {tiers:same('switched-provider','gpt-6.2-astra','high')};
  const wanted = fitted('switched-provider',['gpt-6.2-luna','gpt-6.2-sol','gpt-6.2-astra']);
  assert.deepEqual(resolveTiers(cfg,[...strongerElsewhere,...a]),wanted);
  assert.deepEqual(resolveTiers({modelMode:'auto',autoProvider:'switched-provider'},a),wanted,'unique catalog-supported trio without an anchor');
  const gpt = rows('provider',['gpt-5.4','gpt-5.4-mini','gpt-5.4-nano','gpt-5.4-pro','gpt-5.5']);
  assert.deepEqual(resolveTiers({tiers:same('provider','gpt-5.4')},gpt),fitted('provider',['gpt-5.4-mini','gpt-5.4','gpt-5.4-pro']));
  const olderRoles = rows('provider',['gpt-5.6-sol','gpt-5.6-luna','gpt-5.6-terra']);
  assert.deepEqual(resolveTiers({autoProvider:'provider'},olderRoles),fitted('provider',['gpt-5.6-luna','gpt-5.6-terra','gpt-5.6-sol']));
});

test('verified native DeepSeek, Claude and Gemini catalog variants give useful but not fabricated tiers',()=>{
  const native = rows('deepseek-account',['deepseek-flash','deepseek-v4-pro'],['max','off','high','low']);
  assert.deepEqual(resolveTiers({tiers:same('deepseek-account','deepseek-v4-pro')},native),
    fitted('deepseek-account',['deepseek-flash','deepseek-flash','deepseek-v4-pro'],{fast:'low',standard:'high',deep:'high'}));
  const gemini = rows('test-gemini',['gemini-2.5-flash','gemini-2.5-flash-lite','gemini-2.5-pro','gemini-3.1-flash-lite-image'],[]);
  assert.deepEqual(resolveTiers({autoProvider:'test-gemini'},gemini),fitted('test-gemini',
    ['gemini-2.5-flash-lite','gemini-2.5-flash','gemini-2.5-pro'],{fast:'',standard:'',deep:''}));
  const claude = rows('test-claude',['claude-haiku-4-5','claude-haiku-4-5-20251001','claude-sonnet-4-5','claude-opus-4-5','claude-haiku-5-5-preview']);
  assert.deepEqual(resolveTiers({tiers:same('test-claude','claude-opus-4-5')},claude),fitted('test-claude',
    ['claude-haiku-4-5','claude-sonnet-4-5','claude-opus-4-5']));
});

test('equally suitable fast candidates choose a verified fast route deterministically, not the anchor flagship',()=>{
  const cfg = {tiers:same('a','product-pro')};
  const candidates = ['product-fast-a','product-fast-b'];
  const live = rows('a',['product-pro','product-standard',...candidates,'product-fast-preview','product-fast-20261126']);
  const resolved = resolveTiers(cfg,live);
  assert.ok(candidates.includes(resolved.fast.model));
  assert.equal(resolved.deep.model,'product-pro');
  assert.equal(resolved.standard.model,'product-standard');
  assert.deepEqual(resolveTiers(cfg,[...live].reverse()),resolved,'catalog enumeration order is not evidence');
  assert.deepEqual(resolveTiers(cfg,[...live.slice(3),...live.slice(0,3)]),resolved);
});

test('explicit auto provider uses only that catalog scope and preserves manual anchors when toggled back',()=>{
  const p1 = ['a-fast','a-standard','a-deep'];
  const p2 = ['b-fast','b-standard','b-deep'];
  const mixed = {...fitted('a',p1),fast:selection('b','b-standard','high')};
  const cat = [...rows('a',p1),...rows('b',p2)];
  const combined = {modelMode:'auto',autoProvider:'b',tiers:mixed};
  const original = structuredClone(combined);
  assert.deepEqual(resolveTiers(combined,cat),fitted('b',p2));
  assert.deepEqual(resolveTiers({...combined,modelMode:'manual'},cat),mixed);
  assert.deepEqual(resolveTiers({...combined,autoProvider:undefined},cat),{...fitted('a',p1),fast:selection('b','b-fast','low')});
  assert.deepEqual(resolveTiers({...combined,autoProvider:'unavailable'},cat),same('unavailable',''));
  assert.deepEqual(combined,original);
});

test('one available model can vary real efforts but unknown metadata cannot invent a difference',()=>{
  const cfg = {autoProvider:'only'};
  assert.deepEqual(resolveTiers(cfg,rows('only',['service-label'],['max','high','medium','low'])),fitted('only',Array(3).fill('service-label')));
  assert.deepEqual(resolveTiers(cfg,rows('only',['service-label'],['vendor-level'])),same('only','service-label'));
  const ambiguous = rows('only',['brand-seven','brand-thirty-two'],['x2','x1']);
  const descriptive = ambiguous.map(row => ({...row, badge:{tone:'success',text:'Recently added'}, description:'Powerful'}));
  assert.deepEqual(resolveTiers(cfg,descriptive),same('only',''));
  assert.deepEqual(resolveTiers({tiers:same('only','brand-seven','x1')},descriptive),same('only','brand-seven','x1'));
  assert.deepEqual(resolveTiers({},descriptive),same('',''),'do not use a catalog provider unless authorized by settings');
});

test('missing distinct bands reuse a proven lower-cost-work style candidate, not a premium anchor',()=>{
  const cfg = {tiers:same('allowed','product-pro')};
  const mixed = rows('allowed',['product-standard','product-pro']);
  assert.deepEqual(resolveTiers(cfg,mixed),fitted('allowed',['product-standard','product-standard','product-pro']));
  const two = rows('allowed',['product-mini','product-pro'],[]);
  assert.deepEqual(resolveTiers({autoProvider:'allowed'},two),fitted('allowed',['product-mini','product-mini','product-pro'],{fast:'',standard:'',deep:''}));
});

test('manual and auto fail closed on missing catalog routes, ambiguous duplicates and unavailable efforts',()=>{
  const dups = rows('allowed',['fast','fast','standard','deep']);
  const onlyOther = rows('other',['fast','standard','deep','gone']);
  const wrongEffort = {modelMode:'manual',tiers:same('allowed','standard','xsuper')};
  assert.deepEqual(resolveTiers(wrongEffort,[...dups,...onlyOther]),same('allowed',''));
  assert.deepEqual(resolveTiers({modelMode:'manual',tiers:same('allowed','fast','medium')},dups),same('allowed',''));
  assert.deepEqual(resolveTiers({tiers:same('allowed','gone')},onlyOther),same('allowed',''));
  assert.deepEqual(resolveTiers({autoProvider:'allowed'},[]),same('allowed',''));
  assert.ok(!models(resolveTiers({autoProvider:'allowed'},dups)).has('fast'),'duplicate rows never select an ambiguous model');
});
