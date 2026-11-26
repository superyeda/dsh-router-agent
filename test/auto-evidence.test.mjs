import test from 'node:test';
import assert from 'node:assert/strict';
import {catalog,autoProjectLabels,autoProjectHints,scopeFor,similarity,projectWork} from '../src/planner/routing.mjs';
import {routingControl} from '../src/planner/grammar.mjs';

const conf={projects:[{name:'无关甲',path:'/private/client/auto-fill'},{name:'业务乙',path:'/private/client/billing'},{name:'外观丙',path:'/private/client/web'}],generalDir:'/ordinary'};
const roster=(id,cwd,title,extra={})=>({id,cwd,title,...extra});
const certain=(s,c)=>autoProjectHints(routingControl(s).control,c,s).filter(h=>h.credible).map(h=>h.path);

test('项目短别名的领域支持（不是动词名单）；重合标签不能凭配置顺序定胜负',()=>{
  const c=catalog(conf),[fill,bill,web]=conf.projects.map(p=>p.path);
  for(const [s,p] of [['这次网申里学历字段没自动回填',fill],['本月发票上的税率似乎不对',bill],['这批费用报销的对账差了一笔',bill],['小屏幕布局挤成一团了',web],['Responsive navbar wraps twice.',web]]) assert.deepEqual(certain(s,c),[p],s);
  const other={name:'第二账本',path:'/somewhere/invoice'};
  assert.deepEqual(new Set(certain('发票的税额不对',catalog({...conf,projects:[other,...conf.projects]}))),new Set([bill,other.path]));
  assert.deepEqual(autoProjectLabels(new Set(['/Users/private/secret','C:\\private\\x','https://invalid/x','a\nb','billing','Billing','Short + Test'])),['billing','Short + Test']);
});

test('开放词表专名片段：同一工作区的两样工作不需要共有动词，也不等于同一会话',()=>{
  const c=catalog({projects:[{name:'潮汐浮标观测站',path:'/n'},{name:'窑火釉色工坊',path:'/m'}]});
  const a='潮汐浮标读数里那个凌晨尖峰，不太对劲。', b='潮汐浮标的锚链编号清册，缺一行备用浮标的出厂标记。';
  assert.deepEqual(certain(a,c),['/n']);assert.deepEqual(certain(b,c),['/n']);
  assert.deepEqual(certain('窑火釉色的试烧温度曲线，第三段还差一个对照。',c),['/m']);
  const m=similarity(a,b,c);assert.equal(m.strong,false);assert.equal(m.supported,false);
});

test('以原生标题与实际接纳原句的专属对象解释工作区，仅输出有限的请求词和配置标签',()=>{
  const dir='/vault/owned/one',other='/vault/owned/two';
  const c=catalog({projects:[{name:'/vault/secret-name',path:dir},{name:'乙组',path:other}]},[
    roster('x',dir,'桥接 FjordMeter 的历史图表'),roster('y',other,'日常记录',{workHints:['PRIVATE_LEDGER：给 QuasarLedger 装入样本；还有不公开的客户地址 https://secret.invalid/private/address。']}),
    roster('outside',dir+'/out','QuasarLedger')]);
  const a='FjordMeter 的样点全都叠到一天了',b='QuasarLedger 上的单据还差一批';
  assert.deepEqual(certain(a,c),[dir]);assert.deepEqual(certain(b,c),[other]);
  const hints=autoProjectHints(b,c);assert.ok(hints.every(h=>h.evidence.length<=4 && h.evidence.every(e=>b.includes(e))));
  const exposed=hints.map(({labels,evidence})=>({labels,evidence}));
  assert.doesNotMatch(JSON.stringify(exposed),/\/vault|PRIVATE_LEDGER|secret\.invalid|客户地址|装入样本/u);
  assert.deepEqual(certain('示例：“QuasarLedger 全部失败了”',c),[],'示例里的工作名不是目的地');
  assert.deepEqual(certain('https://QuasarLedger.invalid/login',c),[],'URL 宿主不是专属词');
});

test('通用产品词、代码名和物流/邮件投递不冒充归属；真实申请对象仍可定位招聘工作流',()=>{
  const c=catalog(conf,[roster('x',conf.projects[0].path,'求职招聘网申',{workHints:['帮我投递简历 https://jobs.invalid/r/1','工作状态页面：show the userId and report data in index.js']})]);
  for(const s of ['帮我处理工作状态页面','show the userId and report data in index.js','帮我投递快递包裹','给客户投递邮件','怎么准备面试','如何申请病假？']) assert.deepEqual(certain(s,c),[],s);
  assert.equal(projectWork('给客户投递邮件',{auto:true}),false);assert.equal(projectWork('帮我投递快递包裹',{auto:true}),false);
  assert.deepEqual(certain('帮我投递 https://jobs.invalid/r/2',c),[conf.projects[0].path]);
  assert.deepEqual(certain('投递快递包裹 https://parcels.invalid/2',c),[]);
  assert.deepEqual(certain('那封邮件请投递到 https://post.invalid/2',c),[]);
  const h=catalog({projects:[{name:'星组',path:'/first'},{name:'月组',path:'/second'}]},[roster('local','/second','接收任务',{workHints:['帮我投递 https://one.invalid/a']})]);
  assert.deepEqual(certain('帮我投递 https://two.invalid/b',h),['/second'],'两次实际的动作+链接形状可以指向目录，不暗示同会话');
});

test('原生目录和时间不是接纳事实；只保留同精确目录、唯一标识和可验证的正整毫秒',()=>{
  const cwd=conf.projects[0].path;
  const rows=[roster('ok',cwd,'',{updatedAt:999,lastRoutedAt:14}),...['14',NaN,Infinity,-1,0,0.8,Number.MAX_SAFE_INTEGER+1,undefined].map((n,i)=>roster('bad'+i,cwd,'',{updatedAt:9999,lastRoutedAt:n})),roster('dup',cwd,'',{lastRoutedAt:100}),roster('dup','/not-selected',''),roster('foreign',cwd+'/nested','',{lastRoutedAt:200})];
  const c=catalog(conf,rows);assert.deepEqual(c.rows.filter(r=>'lastRoutedAt' in r).map(r=>[r.id,r.lastRoutedAt]),[['ok',14]]);
  assert.ok(c.rows.every(r=>r.id!=='dup' && r.id!=='foreign'));assert.equal(c.rows.find(r=>r.id==='bad0').time,9999);
  const long='请修复标题，'+ 'A'.repeat(245)+'不同目标';assert.equal(catalog(conf,[roster('long',cwd,long)]).rows[0].title,'','不能以截断后丢失限定条件的标题作身份证据');
});

test('会话同一性分出硬冲突、无证据以及可复核的独立对象 + 症状，不把主题当证据',()=>{
  const c=catalog(conf),sim=(a,b)=>similarity(a,b,c);
  assert.equal(sim('fix TaxTotal rounding error','修复 TaxTotal 金额舍入错误').strong,true);
  const partial=sim('TaxTotal 舍入不对劲','TaxTotal rounding at midnight');assert.equal(partial.strong,false);assert.equal(partial.supported,true);
  for(const [a,b] of [['TaxTotal 的标题再看看','TaxTotal 的接入方式'],['账单导出的字段标题','账单导出的日期范围'],['校招报名材料','校招岗位测评题']]) assert.equal(sim(a,b).supported,false,a);
  for(const [a,b] of [['修复 BILL-41 的金额舍入错误','修复 BILL-42 的金额舍入错误'],['核对 2026-04-02 周报','核对 2026-04-03 周报'],['核对发票号 8024 的税率','核对发票号 8026 的税率'],['修复用户 A 的金额舍入错误','修复用户 B 的金额舍入错误'],['给辰星公司修复对账单导出错误','给云港公司修复对账单导出错误'],['修复 Ledger.ts 的拼写','修复 ledger.ts 的拼写'],['修复 TaxTotal 舍入错误','修复 VatTotal 舍入错误'],['为账单导出金额舍入错误写回归测试','修复账单导出金额舍入错误'],['新需求：TaxTotal 的舍入','TaxTotal 的舍入']]) {
    const v=sim(a,b);assert.equal(v.conflict,true,a+' / '+b);assert.equal(v.strong,false);assert.equal(v.supported,false);
  }
  assert.equal(sim('继续修复导出数字错位','开发笔记').conflict,false,'泛标题不是同一工作的反证');
});

test('相同投递动作须有相同完整目标，票号/URL 缺失也不能仅靠重复模板自动续接',()=>{
  const c=catalog(conf), apply=url=>'帮我完成校招岗位的网申并投递简历 '+url;
  const target='https://Employer.Test/apply/Ab?role=CaSe#Here';
  assert.equal(similarity(apply(target),'网申 '+target.replace('Employer.Test','employer.test'),c).strong,true);
  for(const url of [target.replace('/Ab','/ab'),target.replace('CaSe','case'),target.replace('#Here','#Then'),target+';']) {
    const v=similarity(apply(url),apply(target),c);assert.equal(v.conflict,true,url);assert.equal(v.supported,false);
  }
  for(const s of [apply(''),'帮我完成校招岗位的网申并投递简历，见工单 R-2']) assert.equal(similarity(apply(target),s,c).supported,false);
  assert.equal(similarity('查询 '+target+' 的投递状态',apply(target),c).conflict,true);
  const url='https://app.invalid/data/DEMO-42?object=TaxTotal';
  assert.equal(similarity('记录在这里 '+url,'样本在这里 '+url,c).supported,false,'不能把 URL 中的票号和符号另算独立身份');
});

test('自动语句的目录内容名词与真实地址分开：允许通用计划；绝不误吞越界/否定/复数目的地',()=>{
  const c=catalog({projects:[{name:'Atlas',path:'/work/atlas'},{name:'代码',path:'/work/dev'}],generalDir:'/work/general'}),scope=s=>scopeFor(s,c,{auto:true});
  for(const t of ['做个项目计划模板','搭一个新项目','项目排期通常怎么做','给我一个项目计划模板','怎么改善代码质量','Write a project plan template.','当作示例，讨论 API 路径是什么','解释 /etc/hosts 是什么']) assert.deepEqual(scope(t),{paths:[]},t);
  for(const t of ['在 AtlasPlus 项目写邮件','Ghost 项目写邮件','use workspace other/folder','在 飞船 项目写邮件','在 @target@ 项目写邮件','进入陌生项目看看','去火星工作区','在 未知 目录','使用项目 Ghost','工作区：Ghost','in Ghost workspace do the audit','use workspace Ghost for the notes','不要选 Atlas 工作区','不要使用通用目录','给 Atlas 和 Ghost 工作区发消息','核对 /denied 数据','把 /denied/客群 的结果重算一遍','把 /private/clients 生成清单' ,'在 Atlas 和代码项目写草稿']) assert.ok(scope(t).error,t);
  assert.deepEqual(scope('在 Atlas 项目继续'),{paths:['/work/atlas']});assert.deepEqual(scope('在这个项目梳理目标'),{paths:[],deictic:true});
});
