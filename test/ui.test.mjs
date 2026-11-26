import test from 'node:test';
import assert from 'node:assert/strict';
import {mountRouter} from '../src/ui/main.mjs';
import {absoluteDir, catalogEntries, checkSettings, STATUS, modelLabel} from '../src/ui/shared.mjs';
import {resolveTiers} from '../src/core/models.mjs';
import {validateSettings} from '../src/core/validation.mjs';

// Only the standard DOM subset used by the view, not an HTML parser. The test runner needs
// neither an installed browser nor npm dependencies. Unsafe HTML sinks deliberately throw.
class Element extends EventTarget {
  constructor(doc,tag){super();this.ownerDocument=doc;this.tag=tag;this.children=[];this.attrs=new Map();this.value='';this.data='';this.hidden=false;}
  set textContent(v){this.replaceChildren();this.data=String(v);}
  get textContent(){return this.data+this.children.map(c=>c.textContent).join('');}
  set innerHTML(_){throw Error('HTML sink');} insertAdjacentHTML(){throw Error('HTML sink');}
  setAttribute(k,v){if(k.startsWith('on'))throw Error('handler sink');this.attrs.set(k,String(v));}
  getAttribute(k){return this.attrs.get(k);} removeAttribute(k){this.attrs.delete(k);}
  append(...nodes){for (const n of nodes)this.insertBefore(n,null);}
  replaceChildren(...nodes){for(const n of [...this.children])n.remove();this.data='';this.append(...nodes);}
  remove(){if(this.parent){const a=this.parent.children;a.splice(a.indexOf(this),1);this.parent=null;}}
  insertBefore(n,next){n.remove();const i=next?this.children.indexOf(next):this.children.length;assert.ok(i>=0);this.children.splice(i,0,n);n.parent=this;}
  get parentElement(){return this.parent || null;}
  get parentNode(){return this.parentElement;}
  contains(n){return this===n || this.children.some(c=>c.contains(n));}
  get isConnected(){return this===this.ownerDocument.root || !!this.parent?.isConnected;}
  focus(){this.ownerDocument.activeElement=this;}
  // A successful user interaction must start in attached, disclosed DOM. The
  // explicit stale/forged-event probes use dispatchEvent and expect no action.
  click(){assert.ok(visible(this),'cannot click a hidden/detached '+this.tag+': '+this.textContent.slice(0,55));if (this.disabled) return; this.dispatchEvent(new Event('click')); if(this.tag==='summary' && this.parent?.tag==='details') this.parent.open=!this.parent.open;}
}
const dom=()=>{const doc={defaultView:new EventTarget(),createElement(tag){return new Element(doc,tag);}};return doc.root=doc.createElement('main');};
const walk=n=>[n,...n.children.flatMap(walk)];
const visible=n=>!!n && n.isConnected && !n.hidden && (n.parent?.tag!=='details' || n.tag==='summary' || n.parent.open===true) && (!n.parent || visible(n.parent));
const find=(n,pred)=>{const result=walk(n).find(pred);assert.ok(result,'Missing node: '+pred);return result;};
const btn=(n,label)=>find(n,c=>c.tag==='button' && c.textContent===label);
const control=(n,label)=>find(n,c=>c.tag==='label' && c.children[0]?.textContent===label).children[1];
const alert=(n,pattern)=>walk(n).some(c=>c.getAttribute('role')==='alert' && visible(c) && pattern.test(c.textContent));
const fill=(el,value)=>{assert.ok(visible(el),'cannot edit a hidden/detached '+el.tag);el.value=value;el.dispatchEvent(new Event(el.tag==='select'?'change':'input'));};
const submit=el=>{assert.ok(visible(el),'cannot submit a hidden/detached form');for(let n=el;n;n=n.parent){if(n.tag==='form'){n.dispatchEvent(new Event('submit',{cancelable:true}));return;}}throw Error('No form');};
const uiState=()=>({settings:{generalDir:'/general',projects:[{path:'/web',name:'站点'}],tiers:Object.fromEntries(['fast','standard','deep'].map(k=>[k,{provider:'p',model:'m',effort:'low'}]))},
  workspaces:[{path:'/docs',name:'文档'}],catalog:[{provider:'p',model:'m',efforts:['low','high']}],sessions:[],tasks:[],connected:true});
function fixture(state=uiState(), extra={}){
  const root=dom(),listeners=new Set(),calls=[];let unsubs=0;
  const emit=(...args)=>listeners.forEach(f=>f(...args));
  const api={getState:()=>state,subscribe:f=>{listeners.add(f);return ()=>{listeners.delete(f);unsubs++;};},
    mountSessionPane:(_host,sid)=>{calls.push(['mountSessionPane',sid]);return ()=>{};},
    removeTask:id=>{calls.push(['removeTask',id]);const prev=state.tasks.length;state.tasks=state.tasks.filter(t=>t.id!==id);return prev-state.tasks.length;},
    clearCompleted:ids=>{calls.push(['clearCompleted',ids]);const prev=state.tasks.length;state.tasks=state.tasks.filter(t=>!ids.includes(t.id) || !t.items.every(i=>i.status==='done'));return prev-state.tasks.length;},...extra};
  for(const k of ['submit','resolve','approve','followUp','retry','refresh','openSession','saveSettings']) if (!api[k]) api[k]=async(...args)=>{calls.push([k,...args]);if(k==='saveSettings')state.settings=args[0];};
  return {root,api,state,calls,emit,get unsubs(){return unsubs;},dispose:mountRouter(root,api)};
}
const settle=()=>new Promise(r=>setImmediate(r));
const deferred=()=>{let resolve,reject;const promise=new Promise((yes,no)=>{resolve=yes;reject=no;});return {promise,resolve,reject};};
const addTask=(state,...items)=>state.tasks.push({id:'t:1',text:'跨项目任务',createdAt:'2026-01-01T00:00:00Z',items});
const item=(id,status,more={})=>({id,text:id+' 的内容',status,tier:'standard',project:'/web',reason:'按目录选择',candidates:[],dependsOn:[],...more});
const groups=(scope,level)=>walk(scope).filter(n=>n.getAttribute('data-ledger-level')===level && visible(n));
const keyOf=(node,level)=>node.getAttribute('data-ledger-'+level);
const toggleFor=(group,level)=>find(group,n=>n.tag==='button' && n.getAttribute('data-ledger-toggle')===level && visible(n));
function setGroup(group,level,open) {
  const toggle=toggleFor(group,level), expanded=toggle.getAttribute('aria-expanded');
  assert.ok(expanded==='true' || expanded==='false','disclosure must describe its state');
  if(expanded!==String(open)) {assert.ok(!toggle.disabled);toggle.click();}
  assert.equal(toggle.getAttribute('aria-expanded'),String(open));
}
const taskRows=scope=>walk(scope).filter(n=>n.getAttribute('data-task-id')!=null);
// Older cases exercise controls on particular demand leaves. Browse through
// the actual visible disclosures (including special/legacy buckets); do not
// assume a path is the project key, or reach into a collapsed/detached leaf.
function rowFor(root,id='t:1') {
  const row=scope=>taskRows(scope).find(n=>n.getAttribute('data-task-id')===id && visible(n));
  let found=row(root);if(found) return found;
  for(const p of groups(root,'project')) {
    setGroup(p,'project',true);
    for(const s of groups(p,'session')) {
      setGroup(s,'session',true); found=row(s);if(found) return found;
    }
  }
  assert.fail('No visible demand after browsing project and session groups: '+id);
}
const expand=(root,id)=>{const row=rowFor(root,id), b=walk(row).find(n=>n.tag==='button' && n.textContent==='展开详情');if(b) b.click();return row;};
const nodeFor=(root,id,taskId)=>find(expand(root,taskId),c=>c.tag==='article' && c.getAttribute('data-item-id')===id);
const disclose=(n,label)=>{const s=find(n,c=>c.tag==='summary' && c.textContent===label);if(!s.parent.open) s.click();};

test('目录与模型按已知能力校验；保留默认强度，不猜模型',()=>{
  const s=uiState(), models=catalogEntries(s.catalog.concat(s.catalog));assert.equal(models.length,1);
  for(const path of ['/','/Users/我/测试 1','D:/Work','C:\\Work\\One'])assert.ok(absoluteDir(path));
  for(const path of ['../foo','~','foo','/tmp/../etc','/tmp/./a','/tmp/\nfoo'])assert.equal(absoluteDir(path),false);
  const clean=checkSettings({...s.settings,projects:[{path:'/资料',name:''}]},models).data;assert.equal(clean.projects[0].name,'资料');
  assert.match(checkSettings({...s.settings,projects:[{path:'/foo'},{path:'/foo/'}]},models).error,/重复/);
  s.settings.tiers.fast.effort='';assert.ok(checkSettings(s.settings,models).data);
  s.settings.tiers.fast.effort='fictional';assert.match(checkSettings(s.settings,models).error,/思考强度/);
  assert.match(checkSettings(s.settings,[]).error,/授权/);
});

test('首次配置：无会话手填目录，添加工作区及项目，保存三个明确档位',async()=>{
  const s=uiState();s.settings={};const f=fixture(s),{root}=f;
  const general=control(root,'通用目录（必填）');assert.ok(visible(general));
  fill(general,'relative');submit(general);assert.equal(f.calls.length,0);assert.ok(alert(root,/绝对路径/));assert.equal(general.ownerDocument.activeElement,general);
  fill(general,'/自选 通用');btn(root,'＋ 手动添加项目目录').click();fill(control(root,'项目绝对目录'),'/manual');
  fill(control(root,'从已知工作区添加项目'),'/docs');
  fill(control(root,'新会话模型分配'),'manual');
  for(const band of ['快速','标准','深入']){fill(control(root,band+'档模型'),JSON.stringify(['p','m']));fill(control(root,band+'档思考强度'),'high');}
  f.emit();assert.equal(control(root,'通用目录（必填）'),general);assert.equal(general.value,'/自选 通用');
  submit(general);await settle();assert.deepEqual(f.calls.map(c=>c[0]),['saveSettings']);
  assert.deepEqual(s.settings.projects,[{path:'/manual',name:'manual'},{path:'/docs',name:'文档'}]);
  assert.deepEqual(Object.values(s.settings.tiers).map(t=>t.effort),['high','high','high']);assert.ok(visible(control(root,'任务内容')));f.dispose();
});

const bands=['fast','standard','deep'];
const labeledModels=p=>bands.map((band,n)=>({provider:p,model:p+'/id-'+(n+1),name:band,efforts:['low','medium','high']}));
const previewText=n=>find(n,c=>c.className==='rt-preview-models').children.map(row=>row.children[1].textContent);
const labelsOf=effective=>bands.map(b=>modelLabel(effective[b]));
const note=(n,words)=>walk(n).some(el=>el.tag==='p' && visible(el) && el.textContent.includes(words));
const settings=(root)=>btn(root,'路由设置').click();

test('首次自动设置只需明确选一个提供方：实时三档与核心策略相同，含真实型号/强度',async()=>{
  const s=uiState();s.settings={};s.catalog=[...labeledModels('foreign'),...labeledModels('mine')];const f=fixture(s),root=f.root, dir=control(root,'通用目录（必填）');
  const provider=control(root,'自动档位的提供方'),mode=control(root,'新会话模型分配'),preset=control(root,'新会话模式');
  assert.equal(mode.value,'auto');assert.equal(preset.value,'standard');assert.deepEqual(preset.children.map(o=>o.value),['standard','ptc','inherit']);assert.equal(provider.value,'');
  fill(dir,'/local');submit(dir);assert.deepEqual(f.calls,[]);assert.ok(alert(root,/先选择.*提供方/));assert.equal(dir.ownerDocument.activeElement,provider);
  fill(provider,'mine');fill(preset,'ptc');f.emit();const expected=resolveTiers({modelMode:'auto',autoProvider:'mine'},s.catalog);
  assert.equal(new Set(bands.map(b=>expected[b].model)).size,3);assert.deepEqual(previewText(root),labelsOf(expected));assert.deepEqual(f.calls,[]);
  submit(dir);await settle();assert.equal(f.calls.length,1);assert.equal(s.settings.sessionMode,'ptc');assert.equal(s.settings.autoProvider,'mine');assert.equal(s.settings.modelMode,'auto');assert.deepEqual(s.settings.tiers,expected);const saved=validateSettings(f.calls[0][1],s.catalog);assert.deepEqual(resolveTiers(saved,s.catalog),expected);assert.equal(saved.sessionMode,'ptc');f.dispose();
});

test('旧版不同的三档保持手动；显式跨提供方预览、切回及保存均保留原手选配置',async()=>{
  const s=uiState();s.catalog=[...labeledModels('A'),...labeledModels('B')];
  const original=Object.fromEntries(bands.map((k,i)=>[k,{provider:'A',model:'A/id-'+(i+1),effort:'medium'}]));
  s.settings.tiers=structuredClone(original);s.settings.sessionMode='inherit';const f=fixture(s);settings(f.root);
  const mode=control(f.root,'新会话模型分配'), provider=control(f.root,'自动档位的提供方');assert.equal(mode.value,'manual');
  fill(mode,'auto');assert.equal(provider.value,'');assert.ok(previewText(f.root).every(t=>t.startsWith('A / ')));
  fill(provider,'B');assert.deepEqual(previewText(f.root),labelsOf(resolveTiers({...s.settings,modelMode:'auto',autoProvider:'B'},s.catalog)));
  fill(mode,'manual');assert.equal(control(f.root,'快速档模型').value,JSON.stringify(['A','A/id-1']));assert.equal(control(f.root,'快速档思考强度').value,'medium');
  fill(mode,'auto');assert.equal(provider.value,'B');assert.deepEqual(f.calls,[]);submit(mode);await settle();assert.equal(s.settings.modelMode,'auto');
  assert.equal(s.settings.autoProvider,'B');assert.deepEqual(s.settings.tiers,original);assert.equal(s.settings.sessionMode,'inherit');f.dispose();
});

test('旧版三档相同与实际范围仅一模型分别说明；用户可固定手动或明确套用预览',async()=>{
  const s=uiState(),original=structuredClone(s.settings.tiers);const f=fixture(s);settings(f.root);
  const mode=control(f.root,'新会话模型分配');assert.equal(mode.value,'auto');assert.ok(note(f.root,'旧设置的三档原本完全相同'));assert.ok(note(f.root,'范围内只有一个可用模型'));
  fill(mode,'manual');assert.ok(note(f.root,'手动三档配置完全相同'));assert.deepEqual(s.settings.tiers,original);
  fill(mode,'auto');const effective=resolveTiers(s.settings,s.catalog);btn(f.root,'按此预览转为手动编辑').click();
  assert.equal(mode.value,'manual');assert.equal(control(f.root,'深入档思考强度').value,effective.deep.effort);submit(mode);await settle();
  assert.equal(s.settings.modelMode,'manual');assert.deepEqual(s.settings.tiers,effective);f.dispose();
});

test('自动提供方失去模型或冷数据中预设不存在，不回退到其他提供方或默认预设',async()=>{
  const s=uiState();s.catalog.push(...labeledModels('other'));s.settings.modelMode='auto';s.settings.autoProvider='p';s.settings.sessionMode='retired';const f=fixture(s);settings(f.root);
  const preset=control(f.root,'新会话模式'),p=control(f.root,'自动档位的提供方');assert.equal(preset.value,'retired');submit(preset);assert.ok(alert(f.root,/新会话模式不可用/));
  fill(preset,'inherit');s.catalog=labeledModels('other');f.emit();assert.equal(p.value,'p');assert.ok(previewText(f.root).every(t=>!t.includes('other')));
  submit(p);assert.ok(alert(f.root,/没有可用的模型/));assert.deepEqual(f.calls,[]);
  fill(p,'other');submit(p);await settle();assert.equal(s.settings.sessionMode,'inherit');assert.equal(s.settings.autoProvider,'other');f.dispose();
});

test('部分原提供方不可用时保留其余两档的真实预览；不完整映射不能保存',()=>{
  const s=uiState();s.settings.modelMode='auto';s.settings.tiers.standard={provider:'missing',model:'missing',effort:''};
  const f=fixture(s);settings(f.root);const p=previewText(f.root);assert.ok(p[0].includes('p / m'));assert.equal(p[1],'尚无可用预览');assert.ok(p[2].includes('p / m'));
  submit(control(f.root,'新会话模型分配'));assert.equal(f.calls.length,0);assert.ok(alert(f.root,/标准.*没有可用的模型/));f.dispose();
});

test('旧设置默认自动决定工作区与会话；可选谨慎模式且不改目录/模型/预设',async()=>{
  const s=uiState(),f=fixture(s),original=structuredClone(s.settings);assert.ok(note(f.root,'自动选工作区'));
  settings(f.root);const select=control(f.root,'工作区与会话路由');assert.equal(select.value,'auto');assert.deepEqual(f.calls,[]);
  fill(select,'confirm');assert.ok(note(f.root,'停在「待选择」'));submit(select);await settle();
  assert.equal(s.settings.routingMode,'confirm');assert.deepEqual(s.settings.tiers,original.tiers);assert.deepEqual(s.settings.projects,original.projects);
  assert.ok(note(f.root,'不确定时先请你选择'));settings(f.root);assert.equal(select.value,'confirm');
  fill(select,'auto');submit(select);await settle();assert.equal(validateSettings(s.settings,s.catalog).routingMode,'auto');
  for(const bad of ['manual','retired','__proto__']) {
    assert.throws(()=>validateSettings({...s.settings,routingMode:bad},s.catalog),/路由策略/);
    assert.equal(checkSettings({...s.settings,routingMode:bad},catalogEntries(s.catalog)).field,'routingMode');
  }
  f.dispose();
});
test('默认项目只列已添加且合法的项目，可留空；改动或移除对应路径后清空',async()=>{
  const f=fixture();settings(f.root);const select=control(f.root,'未指名项目时的默认项目');
  assert.deepEqual(select.children.map(o=>o.value),['','/web']);fill(select,'/docs');assert.equal(f.calls.length,0);
  fill(select,'/web');submit(select);await settle();assert.equal(f.state.settings.defaultProject,'/web');settings(f.root);
  fill(control(f.root,'项目绝对目录'),'/web-new');assert.equal(select.value,'');assert.ok(note(f.root,'原默认项目已不在项目目录中'));
  fill(select,'/web-new');find(f.root,n=>n.tag==='button' && n.getAttribute('aria-label')==='移除项目 站点').click();assert.equal(select.value,'');
  submit(select);await settle();assert.equal(f.state.settings.defaultProject,'');
  assert.match(checkSettings({...f.state.settings,defaultProject:'/general'},catalogEntries(f.state.catalog)).error,/默认项目不在/);f.dispose();
});

test('结果卡区分未确认的计划、宿主已确认的创建配置、旧历史证据和原会话复用',()=>{
  const s=uiState(),plan={provider:'planned',model:'x',effort:'low'},actual={provider:'actual',model:'y',effort:'high'};
  addTask(s,item('plan','dispatching',{decision:'create',selection:plan,sessionMode:'ptc',agentPreset:'ptc'}),
    item('applied','running',{decision:'create',configured:true,selection:plan,appliedSelection:actual,sessionMode:'inherit'}),
    item('old','done',{decision:'create',configured:true,selection:plan}),item('invalid','done',{decision:'create',configured:true,selection:{model:'only'}}),
    item('reuse','done',{decision:'reuse',configured:true,selection:plan,appliedSelection:actual,agentPreset:'ptc'}));
  const f=fixture(s),rt=id=>{const n=nodeFor(f.root,id);disclose(n,'路由详情');return find(n,x=>x.className==='rt-runtime');};
  assert.ok(rt('plan').textContent.includes('计划模型 · 尚无配置确认'));assert.ok(rt('plan').textContent.includes('请求的预设：PTC 模式'));
  assert.ok(rt('applied').textContent.includes('创建时已配置 · 宿主已确认'));assert.ok(rt('applied').textContent.includes('actual / y · 思考：high'));assert.ok(!rt('applied').textContent.includes('planned'));assert.ok(rt('applied').textContent.includes('跟随 DSH 默认'));
  assert.ok(rt('old').textContent.includes('创建时已配置'));assert.ok(rt('old').textContent.includes('未记录创建预设'));assert.ok(!rt('invalid').textContent.includes('宿主已确认'));
  assert.ok(!visible(rt('reuse')));assert.ok(nodeFor(f.root,'reuse').textContent.includes('沿用原会话模型与模式'));f.dispose();
});

test('正在编辑或等待提交：订阅更新、断线、403 与重复点击均不丢新文字',async()=>{
  const f=fixture(), pending=deferred();const input=control(f.root,'任务内容');
  f.api.submit=v=>{f.calls.push(v); return pending.promise;};fill(input,'第一版');input.focus();submit(input);submit(input);
  assert.deepEqual(f.calls,['第一版']);fill(input,'第一版（仍在输入）');f.state.connected=false;f.emit();
  assert.equal(control(f.root,'任务内容'),input);assert.equal(input.ownerDocument.activeElement,input);assert.ok(btn(f.root,'正在提交…').disabled);
  pending.resolve();await settle();assert.equal(input.value,'第一版（仍在输入）');assert.ok(btn(f.root,'提交任务').disabled);
  f.state.connected=true;f.emit();f.api.submit=async()=>{throw Object.assign(new Error('forbidden'),{status:403});};submit(input);await settle();
  assert.ok(alert(f.root,/未获授权.*forbidden/));assert.equal(input.value,'第一版（仍在输入）');
  f.dispose();f.dispose();assert.equal(f.unsubs,1);assert.equal(f.root.children.length,0);
});

test('旧多项按记录计数，展开后每种状态及筛选仍可辨认',()=>{
  const s=uiState(), ids=[...STATUS.keys()];addTask(s,...ids.map(v=>item(v,v)));const f=fixture(s);
  for(const [id,[label]] of STATUS){const el=nodeFor(f.root,id);assert.equal(el.getAttribute('data-status'),id);assert.ok(visible(find(el,c=>c.textContent===label)));}
  assert.ok(note(f.root,'共 1 条 · 待处理 1 · 进行中 1 · 已完成 0'));const filter=control(f.root,'按状态筛选');assert.equal(filter.children[0].textContent,'全部状态（1）');
  fill(control(f.root,'按状态筛选'),'queued');assert.ok(visible(nodeFor(f.root,'queued')));assert.ok(!visible(nodeFor(f.root,'running')));
  fill(control(f.root,'按状态筛选'),'');assert.ok(visible(nodeFor(f.root,'input-required')));f.dispose();
});

test('候选复用、目录新建：明确点击后仅针对本项，过时选择可见但不能提交',async()=>{
  const s=uiState();s.sessions=[{id:'s:1',cwd:'/web',title:'站点',busy:true}];addTask(s,item('a','clarify',{candidates:['s:1']}),item('b','running',{sessionId:'s:2'}));
  const f=fixture(s), a=nodeFor(f.root,'a'), b=nodeFor(f.root,'b');assert.ok(visible(b));
  const reuse=control(a,'复用候选会话');fill(reuse,'s:1');s.tasks[0].items[0].candidates=[];f.emit();
  assert.equal(reuse.value,'s:1');assert.ok(btn(a,'使用此会话').disabled);assert.ok(walk(reuse).some(o=>o.textContent.includes('不再可选')));
  s.tasks[0].items[0].candidates=['s:1'];f.emit();assert.deepEqual(f.calls,[]);
  btn(a,'在侧栏查看候选会话').click();await settle();assert.ok(visible(find(f.root,n=>n.getAttribute('aria-label')==='原会话侧栏')));btn(a,'使用此会话').click();await settle();assert.deepEqual(f.calls[0],['mountSessionPane','s:1']);
  assert.deepEqual(f.calls[1],['resolve','t:1','a',{kind:'reuse',sessionId:'s:1'}]);
  fill(control(a,'在项目或通用目录新建会话'),'/general');btn(a,'在此新建').click();await settle();
  assert.deepEqual(f.calls[2],['resolve','t:1','a',{kind:'create',project:'/general'}]);f.dispose();
});

test('旧待选项可无发送地重新匹配精确会话或目录；保留在途手选，确认时剔除过期推荐',async()=>{
  const s=uiState();const a=item('a','clarify',{decision:'clarify',project:null});
  const blocked=[{sessionId:'other'},{attempted:true},{accepted:true},{configured:true},{dependsOn:['a']}];
  addTask(s,a,...blocked.map((flag,n)=>item('blocked-'+n,'clarify',flag)),item('running','running'));
  s.sessions=[{id:'target',cwd:'/web'},{id:'alternate',cwd:'/web'}];let answer=null, reviews=0;
  const f=fixture(s,{reviewRoute:async(t,k)=>{assert.deepEqual([t,k],['t:1','a']);reviews++;return answer;}}),n=nodeFor(f.root,'a');
  const label='重新匹配此项（不发送）',button=btn(n,label),reuse=control(n,'复用候选会话'),dir=control(n,'在项目或通用目录新建会话');
  for(const id of [...blocked.map((_,n)=>'blocked-'+n),'running']){const b=btn(nodeFor(f.root,id),label);assert.ok(!visible(b));b.dispatchEvent(new Event('click'));}
  assert.equal(reviews,0);button.click();await settle();assert.equal(reuse.value,'');assert.equal(dir.value,'');assert.ok(note(n,'仍没有唯一推荐'));assert.deepEqual(f.calls,[]);
  const gate=deferred();answer=gate.promise;button.click();button.dispatchEvent(new Event('click'));assert.equal(reviews,2);
  a.candidates=['alternate','target'];a.project='/web';a.reason='同项证据';f.emit();gate.resolve({kind:'reuse',sessionId:'target'});await settle();
  assert.equal(reuse.value,'target');assert.ok(note(n,'请核对后点「使用此会话」'));assert.equal(a.status,'clarify');assert.deepEqual(f.calls,[]);
  const stale=structuredClone(s);stale.sessions.find(x=>x.id==='target').cwd='/别的目录';f.api.getState=()=>stale;btn(n,'使用此会话').click();await settle();
  assert.ok(alert(n,/推荐目标已变化，未发送/));assert.deepEqual(f.calls,[]);f.api.getState=()=>s;
  const again=deferred();answer=again.promise;button.click();fill(reuse,'alternate');fill(dir,'/web');a.project='/general';f.emit();again.resolve({kind:'create',project:'/general'});await settle();
  assert.equal(reuse.value,'alternate');assert.equal(dir.value,'/web');assert.ok(note(n,'保留了你刚刚手选'));assert.deepEqual(f.calls,[]);
  answer={kind:'create',project:'/general'};button.click();await settle();assert.equal(dir.value,'/general');assert.equal(reuse.value,'alternate');
  assert.ok(note(n,'请核对后点「在此新建」'));assert.deepEqual(f.calls,[]);btn(n,'在此新建').click();await settle();assert.deepEqual(f.calls,[['resolve','t:1','a',{kind:'create',project:'/general'}]]);
  a.project='/web';answer={kind:'reuse',sessionId:'target'};f.emit();button.click();await settle();assert.equal(f.calls.length,1);btn(n,'使用此会话').click();await settle();assert.deepEqual(f.calls[1],['resolve','t:1','a',answer]);
  f.dispose();
});

test('交接预览保留手改，即使远端更新；需输入在原生侧栏处理，追问仍绑定来源',async()=>{
  const s=uiState();const a=item('a','handoff',{handoff:'上游结果',dependsOn:['b']}),b=item('b','input-required',{sessionId:'s-b'}),c=item('c','done',{decision:'reuse',sessionId:'s-c'});
  s.sessions=[{id:'s-b',cwd:'/web'},{id:'s-c',cwd:'/web'}];addTask(s,a,b,c);const f=fixture(s), ra=nodeFor(f.root,'a'),rb=nodeFor(f.root,'b'),rc=nodeFor(f.root,'c');
  const transfer=control(ra,'将发往目标会话的内容（可编辑）');assert.equal(transfer.value,'上游结果');
  fill(transfer,'只传这一段\n<pre>');a.handoff='上游另一个版本';f.emit();assert.equal(transfer.value,'只传这一段\n<pre>');assert.ok(visible(btn(ra,'载入最新交接预览')));assert.deepEqual(f.calls,[]);
  btn(ra,'批准并发送交接').click();await settle();assert.deepEqual(f.calls[0],['approve','t:1','a','只传这一段\n<pre>']);
  assert.ok(!visible(btn(rb,'批准并发送交接')));assert.ok(!visible(btn(rb,'发送追问')));btn(rb,'在侧栏查看原会话').click();await settle();assert.deepEqual(f.calls[1],['mountSessionPane','s-b']);
  assert.ok(rc.textContent.includes('沿用原会话模型与模式'));disclose(rc,'追问原会话');const reply=control(rc,'仅发往关联会话的追问');fill(reply,'继续这里');btn(rc,'发送追问').click();await settle();
  assert.deepEqual(f.calls[2],['followUp','t:1','c','继续这里']);assert.equal(reply.value,'');f.dispose();
});

test('仅显式可重试的失败/未确认回执可重试，冷数据内容全部按文本显示',async()=>{
  const s=uiState(), evil='<img src=x onerror="throw 1">';s.notice=evil;addTask(s,item('a','failed',{retryable:false,error:evil}),item('b','failed',{retryable:true}),item('c','unknown',{retryable:true}));
  const f=fixture(s);assert.ok(!visible(btn(nodeFor(f.root,'a'),'重试此项')));assert.equal(walk(f.root).filter(c=>c.tag==='img').length,0);
  assert.ok(walk(nodeFor(f.root,'a')).some(c=>visible(c)&&c.textContent==='异常：'+evil));
  btn(nodeFor(f.root,'c'),'重试此项').click();await settle();assert.deepEqual(f.calls,[['retry','t:1','c']]);f.dispose();
});

const recoveryOffer = {recoverableEmpty:true, expectedSessionId:'old:<literal-id>', project:'/work/原目录', retryable:true};
const previewRecovery = n => btn(n,'预览空会话恢复');
const confirmRecovery = n => btn(n,'确认恢复并仅投递此项');

test('空会话恢复：精确目录和 ID 的两步确认，不借普通重试、不换模型、不二次投递',async()=>{
  const s=uiState(), pending=deferred(), calls=[];
  addTask(s,item('a','failed',{...recoveryOffer,sessionId:'不可用这个 ID 替换原标识'}),item('ordinary','failed',{retryable:true,expectedSessionId:recoveryOffer.expectedSessionId}));
  const f=fixture(s,{recoverEmpty:(...args)=>{calls.push(args);return pending.promise;}}), a=nodeFor(f.root,'a'), ordinary=nodeFor(f.root,'ordinary');
  assert.ok(visible(previewRecovery(a)));assert.ok(!visible(confirmRecovery(a)));assert.ok(!visible(btn(a,'重试此项')));
  assert.ok(!visible(previewRecovery(ordinary)));assert.ok(visible(btn(ordinary,'重试此项')));
  btn(a,'重试此项').dispatchEvent(new Event('click'));confirmRecovery(a).dispatchEvent(new Event('click'));f.emit();await settle();
  assert.deepEqual(f.calls,[]);assert.deepEqual(calls,[]);
  previewRecovery(a).click();assert.ok(visible(confirmRecovery(a)));
  for (const literal of [recoveryOffer.project,recoveryOffer.expectedSessionId]) assert.ok(walk(a).some(n=>n.tag==='dd' && visible(n) && n.textContent===literal));
  assert.ok(walk(a).some(n=>n.tag==='p' && visible(n) && /已有消息、已归档或身份不符.*只投递本项.*不会另建.*沿用这个会话当前的模型，不改变任何会话配置/.test(n.textContent)));
  btn(a,'收起恢复预览').click(); confirmRecovery(a).dispatchEvent(new Event('click'));await settle();assert.deepEqual(calls,[]);
  previewRecovery(a).click();confirmRecovery(a).click();confirmRecovery(a).dispatchEvent(new Event('click'));await settle();
  assert.deepEqual(calls,[['t:1','a',recoveryOffer.expectedSessionId]]);assert.ok(confirmRecovery(a).disabled);
  pending.resolve();await settle();previewRecovery(a).click();confirmRecovery(a).dispatchEvent(new Event('click'));await settle();
  assert.equal(calls.length,1);assert.deepEqual(f.calls,[]);f.dispose();
});

test('精确恢复预览不能沿用到另一个 ID、另一个目录、已失效的子项或断开的连接',async()=>{
  const s=uiState(), a=item('a','failed',{...recoveryOffer});addTask(s,a);
  const calls=[];const f=fixture(s,{recoverEmpty:async(...args)=>calls.push(args)}), n=nodeFor(f.root,'a'), oldConfirm=confirmRecovery(n);
  previewRecovery(n).click();a.expectedSessionId='other';f.emit();assert.ok(!visible(oldConfirm));oldConfirm.dispatchEvent(new Event('click'));assert.deepEqual(calls,[]);
  assert.ok(walk(n).some(el=>el.tag==='p' && visible(el) && el.textContent.includes('恢复预览已失效')));
  previewRecovery(n).click();a.project='/new';f.emit();assert.ok(!visible(oldConfirm));
  // The saved cwd changed: the demand now lives under another, initially
  // closed project. Deliberately browse to it before reviewing recovery again.
  assert.equal(nodeFor(f.root,'a'),n);
  previewRecovery(n).click();f.state.connected=false;f.emit();assert.ok(oldConfirm.disabled);oldConfirm.dispatchEvent(new Event('click'));await settle();assert.deepEqual(calls,[]);
  f.state.connected=true;f.emit();
  // An asynchronously fetched fresh snapshot can race with an intervening subscription.
  const gate=deferred(), thenState=structuredClone(s);f.api.getState=()=>gate.promise;oldConfirm.click();
  a.expectedSessionId='replacement';f.emit(structuredClone(s));gate.resolve(thenState);await settle();assert.ok(alert(n,/预览已失效/));assert.deepEqual(calls,[]);
  f.api.getState=()=>s;previewRecovery(n).click();s.tasks[0].items=[];f.emit();oldConfirm.dispatchEvent(new Event('click'));await settle();assert.deepEqual(calls,[]);f.dispose();
});

test('恢复确认再读状态：没收到通知的标志撤销也不发送；宿主拒绝时保留原目录、ID 和草稿',async()=>{
  const s=uiState(), a=item('a','failed',{...recoveryOffer}), calls=[];addTask(s,a);
  const gate=deferred(),f=fixture(s,{recoverEmpty:(...args)=>{calls.push(args);return gate.promise;}}), n=nodeFor(f.root,'a');
  const draft=control(f.root,'任务内容');fill(draft,'不相关的未提交草稿');previewRecovery(n).click();
  const fresh=structuredClone(s);fresh.tasks[0].items[0].recoverableEmpty=false;
  f.api.getState=()=>fresh;confirmRecovery(n).click();await settle();assert.deepEqual(calls,[]);assert.ok(alert(n,/未发送请求/));
  f.api.getState=()=>s;previewRecovery(n).click();confirmRecovery(n).click();await settle();gate.reject(Error('已归档，拒绝恢复'));await settle();
  assert.ok(alert(n,/已归档，拒绝恢复/));assert.ok(visible(confirmRecovery(n)));assert.equal(confirmRecovery(n).disabled,false);
  assert.ok(walk(n).some(el=>el.tag==='dd' && visible(el) && el.textContent===recoveryOffer.expectedSessionId));assert.equal(draft.value,'不相关的未提交草稿');
  assert.deepEqual(calls,[['t:1','a',recoveryOffer.expectedSessionId]]);f.dispose();
});

test('不从错误、retryable 或旧 sessionId 推断恢复；缺少绑定或宿主不支持时明示',()=>{
  const s=uiState();addTask(s,item('text','failed',{...recoveryOffer,recoverableEmpty:'true',error:'原空会话可恢复'}),
    item('noid','failed',{...recoveryOffer,expectedSessionId:'',sessionId:'不可替代'}),item('nodir','failed',{...recoveryOffer,project:''}),item('noapi','failed',{...recoveryOffer}));
  const f=fixture(s);assert.ok(!visible(previewRecovery(nodeFor(f.root,'text'))));
  const noapi=nodeFor(f.root,'noapi');assert.ok(previewRecovery(noapi).disabled);assert.ok(noapi.textContent.includes('当前入口不支持恢复'));
  f.api.recoverEmpty=()=>assert.fail('Incomplete addresses must never be submitted');f.emit();
  for (const id of ['noid','nodir']){const n=nodeFor(f.root,id);assert.ok(previewRecovery(n).disabled);assert.ok(n.textContent.includes('缺少原目标目录或精确会话 ID'));
    previewRecovery(n).dispatchEvent(new Event('click'));confirmRecovery(n).dispatchEvent(new Event('click'));assert.ok(!visible(confirmRecovery(n)));}
  f.dispose();
});

test('跨订阅、筛选和授权范围内重挂载保留草稿；不同作用域不会接手',()=>{
  const s=uiState(),scope={};addTask(s,item('a','done',{sessionId:'s'}));const f=fixture(s,{draftScope:scope});
  const a=nodeFor(f.root,'a');disclose(a,'追问原会话');const reply=control(a,'仅发往关联会话的追问');fill(reply,'未发内容');fill(control(f.root,'任务内容'),'还没提交');
  fill(control(f.root,'按状态筛选'),'running');fill(control(f.root,'按状态筛选'),'');assert.equal(control(nodeFor(f.root,'a'),'仅发往关联会话的追问'),reply);
  const unloadEvent=new Event('beforeunload',{cancelable:true});f.root.ownerDocument.defaultView.dispatchEvent(unloadEvent);assert.equal(unloadEvent.defaultPrevented,true);
  s.tasks=[];f.emit();const lost=find(f.root,n=>n.className==='rt-card rt-orphan');assert.ok(visible(lost));assert.ok(lost.textContent.includes('未发内容'));f.dispose();
  const next=fixture(s,{draftScope:scope});assert.equal(control(next.root,'任务内容').value,'还没提交');next.dispose();
  const other=fixture(s);assert.equal(control(other.root,'任务内容').value,'');other.dispose();
});

test('旧异步读取不压过新快照；长期断连及订阅失败都明示，可手动刷新',async()=>{
  const s=uiState(),gate=deferred();const f=fixture(s,{getState:()=>gate.promise});f.emit({...s,notice:'最新通知'});gate.resolve({...s,connected:false,notice:'过期通知'});await settle();
  assert.ok(!btn(f.root,'提交任务').disabled);assert.ok(walk(f.root).some(c=>c.tag==='p' && c.textContent==='最新通知'));f.dispose();
  let loaded=false;const g=fixture(s,{subscribe:()=>{throw Error('没有事件订阅');},getState:()=>{if(!loaded)throw Error('401');return s;},refresh:async()=>{loaded=true;}});
  assert.ok(alert(g.root,/读取入口状态失败.*未获授权/));assert.ok(walk(g.root).some(n=>n.tag==='p' && visible(n) && n.textContent.includes('实时更新不可用')));
  btn(g.root,'刷新状态').click();await settle();assert.ok(!btn(g.root,'提交任务').disabled);g.dispose();
});

const record=(state,id,items,text=id,createdAt=1736000000000)=>{
  const t={id,kind:'conversation',text,createdAt,items}; state.tasks.push(t);return t;
};
const selectRecord=(root,id)=>find(rowFor(root,id),n=>n.tag==='button' && n.getAttribute('data-action'));
const side=root=>find(root,n=>n.tag==='aside' && n.getAttribute('aria-label')==='原会话侧栏');
const idsIn=scope=>taskRows(scope).map(n=>n.getAttribute('data-task-id'));
// Read only a group's visible header. A parent cannot pass because an open
// child happens to contain a matching path, session id or title in its text.
function headingText(group) {
  function own(n) {
    if(!visible(n) || (n!==group && (n.getAttribute('data-ledger-level') || n.getAttribute('data-task-id')))) return '';
    return n.data+n.children.map(own).join('');
  }
  return own(group);
}
function byHeading(scope,level,literal) {
  const found=groups(scope,level).filter(g=>headingText(g).includes(literal));
  assert.equal(found.length,1,'expected exactly one visible '+level+' header containing '+literal);return found[0];
}
const openOriginal=group=>walk(group).filter(n=>n.tag==='button' && n.getAttribute('data-ledger-open')==='session' && visible(n) && !n.disabled);
const groupedItem=(id,status,project,sessionId,extra={})=>item(id,status,{decision:'reuse',project,sessionId,accepted:true,...extra});

test('项目与会话分别按最近需求排序；同名分开，同会话的独立提交有两条，追问不生成第三条',async()=>{
  const s=uiState(),a='/east/site',b='/west/site';
  s.settings.projects=[{name:'同名项目',path:b},{name:'同名项目',path:a}];
  s.sessions=[['S-甲',a],['S-乙',a],['S-丙',b]].map(([id,cwd])=>({id,cwd,title:'同名会话'}));
  // Deliberately neither insertion order nor lexical group order is recency.
  record(s,'甲一',[groupedItem('root','done',a,'S-甲'),groupedItem('follow','running',a,'S-甲',{parentItemId:'root'})],'第一份独立原文',1710000000100);
  record(s,'丙一',[groupedItem('root','done',b,'S-丙')],'西项目原文',1710000000250);
  record(s,'乙一',[groupedItem('root','running',a,'S-乙')],'另一个会话的需求',1710000000200);
  record(s,'甲二',[groupedItem('root','done',a,'S-甲')],'第二份独立原文',1710000000300);
  const f=fixture(s), root=f.root, hist=find(root,n=>n.getAttribute('aria-label')==='任务历史');
  const project=cwd=>byHeading(hist,'project',cwd), session=(cwd,sid)=>byHeading(project(cwd),'session',sid);
  const expanded=(g,l)=>toggleFor(g,l).getAttribute('aria-expanded');
  const checkToggle=(g,l)=>{
    const t=toggleFor(g,l), id=t.getAttribute('aria-controls');assert.equal(t.type,'button');assert.ok(keyOf(g,l));assert.ok(id);
    assert.equal(walk(root).filter(n=>(n.id||n.getAttribute('id'))===id).length,1,'each disclosure controls one unique region');
    assert.equal(expanded(g,l),'false');
  };
  assert.deepEqual(groups(hist,'project'),[project(a),project(b)]);assert.notEqual(keyOf(project(a),'project'),keyOf(project(b),'project'));
  for(const p of groups(hist,'project')) {checkToggle(p,'project');assert.match(headingText(p),/同名项目/);}
  assert.match(headingText(project(a)),/2 个会话 · 3 条需求/);assert.match(headingText(project(a)),/进行中 2/);
  assert.match(headingText(project(b)),/1 个会话 · 1 条需求/);
  assert.deepEqual(idsIn(hist),[]);assert.deepEqual(groups(hist,'session'),[]);assert.ok(!hist.textContent.includes('独立原文'));
  setGroup(project(a),'project',true);assert.deepEqual(groups(project(a),'session'),[session(a,'S-甲'),session(a,'S-乙')]);
  for(const g of groups(project(a),'session')) {checkToggle(g,'session');assert.match(headingText(g),/同名会话/);}
  assert.match(headingText(session(a,'S-甲')),/2 条需求/);assert.match(headingText(session(a,'S-甲')),/进行中 1/);
  assert.deepEqual(idsIn(hist),[]);assert.equal(expanded(project(b),'project'),'false');
  const aKey=keyOf(project(a),'project'), alphaKey=keyOf(session(a,'S-甲'),'session'), betaKey=keyOf(session(a,'S-乙'),'session');
  setGroup(session(a,'S-甲'),'session',true);assert.deepEqual(idsIn(hist),['甲二','甲一']);
  assert.match(selectRecord(root,'甲一').textContent,/1 条追问/);assert.equal(expanded(session(a,'S-乙'),'session'),'false');
  setGroup(project(b),'project',true);checkToggle(session(b,'S-丙'),'session');setGroup(session(b,'S-丙'),'session',true);
  const gammaKey=keyOf(session(b,'S-丙'),'session');assert.equal(new Set([alphaKey,betaKey,gammaKey]).size,3);
  assert.deepEqual(idsIn(hist),['甲二','甲一','丙一']);
  setGroup(project(b),'project',false);assert.deepEqual(idsIn(hist),['甲二','甲一']);assert.deepEqual(f.calls,[]);
  const filter=control(root,'按状态筛选');fill(filter,'running');
  assert.deepEqual(groups(hist,'project'),[project(a)]);assert.equal(keyOf(project(a),'project'),aKey);
  assert.equal(keyOf(session(a,'S-甲'),'session'),alphaKey);assert.equal(keyOf(session(a,'S-乙'),'session'),betaKey);
  assert.match(headingText(project(a)),/2 个会话 · 2 条需求/);assert.match(headingText(session(a,'S-甲')),/1 条需求/);
  assert.deepEqual(idsIn(hist),['甲一'],'filter matches its running follow-up but includes the demand only once');
  setGroup(session(a,'S-乙'),'session',true);setGroup(session(a,'S-甲'),'session',false);assert.deepEqual(idsIn(hist),['乙一']);
  btn(root,'刷新状态').click();await settle();f.emit(structuredClone(s));
  assert.equal(expanded(project(a),'project'),'true');assert.equal(expanded(session(a,'S-甲'),'session'),'false');
  assert.equal(expanded(session(a,'S-乙'),'session'),'true');assert.deepEqual(idsIn(hist),['乙一']);
  fill(filter,'');assert.equal(expanded(project(b),'project'),'false');assert.deepEqual(idsIn(hist),['乙一']);
  setGroup(project(b),'project',true);assert.equal(keyOf(session(b,'S-丙'),'session'),gammaKey);setGroup(session(b,'S-丙'),'session',true);
  setGroup(session(a,'S-甲'),'session',true);assert.deepEqual(idsIn(hist),['甲二','甲一','乙一','丙一']);
  assert.deepEqual(f.calls,[['refresh']]);assert.ok(!visible(side(root)));f.dispose();
});

test('读取失败时已展开分支保留本机需求，但不再展示上次的原生标题或访问权限',()=>{
  const s=uiState(),sid='sid-roster';s.sessions=[{id:sid,cwd:'/web',title:'实时会话标题'}];
  record(s,'saved',[groupedItem('entry','done','/web',sid)],'本机保存的需求');let fail=false;
  const f=fixture(s,{getState:()=>{if(fail) throw Error('读取中断');return s;}}),root=f.root;
  const project=byHeading(root,'project','/web');setGroup(project,'project',true);
  const session=byHeading(project,'session',sid);setGroup(session,'session',true);
  assert.match(headingText(session),/实时会话标题/);assert.equal(openOriginal(session).length,1);
  fail=true;f.emit();assert.match(headingText(session),/本机保存的需求/);assert.doesNotMatch(headingText(session),/实时会话标题/);
  assert.deepEqual(idsIn(session),['saved']);assert.deepEqual(openOriginal(session),[]);
  fail=false;f.emit();assert.match(headingText(session),/实时会话标题/);assert.equal(toggleFor(session,'session').getAttribute('aria-expanded'),'true');
  assert.deepEqual(f.calls,[]);f.dispose();
});

test('显式定位提交的需求才会展开、清除不匹配筛选并聚焦，不打开原会话',async()=>{
  const s=uiState();s.sessions=['first','latest'].map(id=>({id,cwd:'/web',title:'同名'}));
  record(s,'prior',[groupedItem('old','queued','/web','first')]);const f=fixture(s),root=f.root;
  const filter=control(root,'按状态筛选'),draft=control(root,'任务内容');fill(filter,'queued');
  const text='这次通过主表单提交的独立需求';f.api.submit=async raw=>{
    f.calls.push(['submit',raw]);return record(s,'issued',[groupedItem('new','running','/web','latest')],raw).id;
  };
  fill(draft,text);submit(draft);await settle();assert.deepEqual(f.calls,[['submit',text]]);
  assert.equal(filter.value,'queued');assert.equal(toggleFor(byHeading(root,'project','/web'),'project').getAttribute('aria-expanded'),'false');
  assert.deepEqual(idsIn(root),[]);assert.deepEqual(groups(root,'session'),[]);
  btn(root,'定位本次需求').click();assert.equal(filter.value,'');assert.ok(walk(root).some(n=>n.tag==='p' && visible(n) && /已切换到.*全部状态/.test(n.textContent)));
  assert.deepEqual(idsIn(root),['issued']);const row=taskRows(root)[0];assert.ok(row.contains(root.ownerDocument.activeElement));
  assert.ok(!visible(side(root)));assert.deepEqual(f.calls,[['submit',text]]);f.dispose();
});

test('相同 ID 迁往另一 cwd：历史仍可读，组标题、需求详情、候选和侧栏都不能泄露错目录标题或取得挂载权',async()=>{
  const s=uiState(),old='/old/same',now='/new/same',sid='shared-id',secret='SECRET：仅当前精确目录的原生标题';
  s.settings.projects=[{path:old,name:'同名项目'},{path:now,name:'同名项目'}];
  s.sessions=[{id:sid,cwd:now,title:secret},{id:'side-id',cwd:old,title:'可手选目标'}];
  record(s,'old',[groupedItem('base','done',old,sid)],'原来的本地需求');
  record(s,'new',[groupedItem('base','running',now,sid)],'现在的需求',1750000000000);
  record(s,'another',[groupedItem('other','done',now,sid)],'同会话的另一次独立提交',1750100000000);
  // A clarification can already have a recommended project, candidateDirs,
  // and an expected id. None is a binding until a target has been chosen.
  const pending=item('pick','clarify',{decision:'clarify',project:old,expectedSessionId:sid,candidates:[sid,'side-id'],candidateDirs:{[sid]:old,'side-id':old}});
  record(s,'pick',[pending],'还没有选择去向');
  let grant=now,unmounted=0;const f=fixture(s,{sessionPaneTarget:id=>id===sid?grant:old,
    mountSessionPane:(_,id)=>{f.calls.push(['mountSessionPane',id]);return ()=>{unmounted++;};}}),root=f.root;
  const project=cwd=>byHeading(root,'project',cwd), orig=()=>byHeading(project(old),'session',sid), live=()=>byHeading(project(now),'session',sid);
  setGroup(project(old),'project',true);setGroup(project(now),'project',true);
  assert.notEqual(keyOf(orig(),'session'),keyOf(live(),'session'),'session key includes the saved project identity');
  assert.ok(!headingText(orig()).includes(secret));assert.match(headingText(live()),/SECRET/);assert.deepEqual(openOriginal(orig()),[]);
  setGroup(orig(),'session',true);assert.deepEqual(idsIn(orig()),['old']);
  const previous=nodeFor(root,'base','old');disclose(previous,'路由详情');assert.ok(previous.textContent.includes(old));assert.ok(previous.textContent.includes(sid));
  assert.ok(!previous.textContent.includes(secret));assert.equal(selectRecord(root,'old').getAttribute('data-action'),'view-details');
  assert.deepEqual(f.calls,[]);assert.ok(!visible(side(root)));
  const pendingProject=byHeading(root,'project','待归属');setGroup(pendingProject,'project',true);
  const unbound=byHeading(pendingProject,'session','未绑定');assert.deepEqual(openOriginal(unbound),[]);setGroup(unbound,'session',true);assert.deepEqual(idsIn(unbound),['pick']);
  const choices=nodeFor(root,'pick','pick'), sel=control(choices,'复用候选会话');assert.ok(!sel.textContent.includes(secret),'a candidate at the wrong cwd is not entitled to a live title');
  fill(sel,sid);assert.ok(btn(choices,'使用此会话').disabled);assert.ok(btn(choices,'在侧栏查看候选会话').disabled);
  fill(sel,'side-id');assert.ok(!btn(choices,'使用此会话').disabled);assert.deepEqual(f.calls,[]);
  // A grant can change between render and click. An old enabled control may
  // not use a historical id to claim today's session at the wrong cwd.
  assert.equal(openOriginal(live()).length,1);grant=old;openOriginal(live())[0].click();assert.deepEqual(f.calls,[]);
  grant=now;f.emit();openOriginal(live())[0].click();assert.deepEqual(f.calls,[['mountSessionPane',sid]]);assert.ok(visible(side(root)));
  setGroup(live(),'session',true);assert.deepEqual(idsIn(live()),['another','new']);
  selectRecord(root,'another').click();selectRecord(root,'new').click();assert.deepEqual(f.calls,[['mountSessionPane',sid]]);assert.equal(unmounted,0);
  // Roster no longer matches the retained original; no stale title may leak,
  // even when the adapter still vouches for the saved cwd's admitted receipt.
  s.sessions[0]={id:sid,cwd:old,title:'SECRET：又换了目录'};f.emit();assert.ok(!visible(side(root)));assert.equal(unmounted,1);
  assert.ok(!side(root).textContent.includes('SECRET：又换了目录'));assert.deepEqual(openOriginal(live()),[]);
  // Two native rows claiming that id are worse than a temporarily absent
  // row: even the live authority alone must not select one dialog or title.
  s.sessions.push({id:sid,cwd:now,title:secret});f.emit();
  for(const g of [orig(),live()]) {assert.deepEqual(openOriginal(g),[]);assert.ok(!headingText(g).includes('SECRET'));}
  assert.equal(selectRecord(root,'new').getAttribute('data-action'),'view-details');assert.ok(!previous.textContent.includes('SECRET'));
  s.sessions.pop();grant=old;s.settings.projects=[{path:now,name:'同名项目'}];f.emit();
  assert.deepEqual(openOriginal(orig()),[]);assert.ok(!headingText(orig()).includes('SECRET'));assert.ok(!previous.textContent.includes('SECRET'));
  s.settings.projects.push({path:old,name:'同名项目'});s.connected=false;f.emit();
  assert.deepEqual(openOriginal(orig()),[]);assert.ok(!headingText(orig()).includes('SECRET'));assert.ok(!previous.textContent.includes('SECRET'));
  assert.ok(rowFor(root,'old').textContent.includes('原来的本地需求'));assert.equal(selectRecord(root,'old').getAttribute('data-action'),'view-details');
  s.connected=true;f.emit();fill(sel,'side-id');btn(choices,'使用此会话').click();await settle();
  assert.deepEqual(f.calls,[['mountSessionPane',sid],['resolve','pick','pick',{kind:'reuse',sessionId:'side-id'}]]);f.dispose();
});

test('删除最后一条需求会移除空的会话或项目；在途同级保留，查看和手动清理不投递、不导航',async()=>{
  const s=uiState();s.settings.projects.push({path:'/only',name:'单条项目'});
  s.sessions=[['solo','/only'],['finished','/web'],['in-flight','/web']].map(([id,cwd])=>({id,cwd}));
  for(const [id,status,cwd] of [['solo','done','/only'],['finished','done','/web'],['in-flight','queued','/web']])record(s,id,[groupedItem('req',status,cwd,id)]);
  const before=structuredClone(s.sessions),f=fixture(s), root=f.root,proj=cwd=>byHeading(root,'project',cwd);
  setGroup(proj('/only'),'project',true);const lone=byHeading(proj('/only'),'session','solo');openOriginal(lone)[0].click();
  assert.ok(visible(side(root)));assert.deepEqual(f.calls,[['mountSessionPane','solo']]);
  setGroup(lone,'session',true);const row=expand(root,'solo');btn(row,'删除记录').click();assert.equal(groups(root,'project').length,2);
  btn(row,'确认删除这条记录').click();await settle();assert.ok(!visible(side(root)));assert.deepEqual(groups(root,'project'),[proj('/web')]);
  setGroup(proj('/web'),'project',true);const finish=byHeading(proj('/web'),'session','finished'),flight=byHeading(proj('/web'),'session','in-flight');
  setGroup(flight,'session',true);assert.ok(btn(expand(root,'in-flight'),'删除记录').disabled);assert.deepEqual(idsIn(flight),['in-flight']);
  setGroup(finish,'session',true);assert.deepEqual(idsIn(finish),['finished']);btn(root,'清理已完成').click();btn(root,'确认清理已完成记录').click();await settle();
  assert.deepEqual(groups(root,'project'),[proj('/web')]);assert.deepEqual(groups(proj('/web'),'session'),[byHeading(proj('/web'),'session','in-flight')]);
  assert.deepEqual(idsIn(root),['in-flight']);assert.ok(btn(root,'清理已完成').disabled);assert.deepEqual(s.sessions,before);
  assert.deepEqual(f.calls,[['mountSessionPane','solo'],['removeTask','solo'],['clearCompleted',['finished']]]);f.dispose();
});

test('不展开记录也看得见本次新建或续接和实际工作区',()=>{
  const s=uiState();record(s,'one',[item('create','done',{decision:'create',project:'/web'})]);
  record(s,'two',[item('reuse','queued',{decision:'reuse',project:'/general'})]);
  const f=fixture(s);assert.match(selectRecord(f.root,'one').textContent,/新建 · 站点/);assert.match(selectRecord(f.root,'two').textContent,/续接 · 通用目录/);
  assert.equal(btn(rowFor(f.root,'one'),'展开详情').getAttribute('aria-expanded'),'false');f.dispose();
});
test('历史默认只呈现时间、状态和摘要；一段原文只展开一份，追问、结果和旧交接均可核对',()=>{
  const s=uiState(), raw='检查网站和文档\n  保持格式 '+ '长'.repeat(145), a=item('base','done',{text:raw,result:'完整结果 <b>不解释为 HTML</b>'});
  record(s,'new',[a,item('follow','running',{parentItemId:'base',accepted:true})],raw,1750000000000);
  const old=record(s,'old',[item('up','done'),item('down','done',{dependsOn:['up'],handoff:'原样交接\n不改写',approved:true})],'历史完整原文',1740000000000); delete old.kind;
  const f=fixture(s), history=find(f.root,n=>n.getAttribute('aria-label')==='任务历史');
  assert.equal(taskRows(history).length,0);assert.equal(groups(history,'session').length,0);
  const row=rowFor(f.root,'new');rowFor(f.root,'old');
  const rendered=taskRows(history);assert.deepEqual(rendered.map(n=>n.getAttribute('data-task-id')),['new','old']);
  for(const r of rendered) {
    assert.equal(btn(r,'展开详情').getAttribute('aria-expanded'),'false');assert.equal(walk(r).filter(n=>n.tag==='article').length,0);
    assert.ok(visible(find(r,n=>n.tag==='time' && n.getAttribute('datetime'))));
  }
  const headline=selectRecord(f.root,'new');assert.match(headline.textContent,/检查网站和文档 保持格式.*…/);assert.ok(!headline.textContent.includes('\n'));assert.match(headline.textContent,/运行中/);
  assert.ok(!headline.textContent.includes('完整结果'));assert.ok(!f.root.textContent.includes('创建总任务'));
  btn(row,'展开详情').click();f.emit();assert.ok(visible(btn(row,'收起详情')));
  assert.equal(walk(row).filter(n=>n.data===raw).length,1);const base=nodeFor(f.root,'base','new');
  assert.ok(!visible(find(base,n=>n.data===a.result)));disclose(base,'查看结果');assert.ok(visible(find(base,n=>n.data===a.result)));
  assert.ok(!visible(find(base,n=>n.data==='路由依据：按目录选择')));disclose(base,'路由详情');assert.ok(visible(find(base,n=>n.data==='路由依据：按目录选择')));
  assert.ok(nodeFor(f.root,'follow','new').textContent.includes('追问来源：原任务'));
  const prior=nodeFor(f.root,'down','old');assert.ok(prior.textContent.includes('依赖：历史分项 1'));disclose(prior,'已确认的交接内容');assert.ok(visible(find(prior,n=>n.data==='原样交接\n不改写')));
  assert.ok(!visible(btn(prior,'批准并发送交接')));btn(row,'收起详情').click();assert.ok(!visible(base));f.dispose();
});

test('单条清理必须明确确认；离线只删本机记录，未发送待选择和确定失败可删，在途或需恢复不可删',async()=>{
  const s=uiState();s.connected=false;s.sessions=[{id:'original',cwd:'/web',title:'原会话'}];
  for(const status of ['new','queued','dispatching','running','input-required','waiting','handoff','unknown','recovering']) record(s,status,[item('i',status)]);
  record(s,'unconfirmed',[item('i','failed',{attempted:true,accepted:false})]);record(s,'recovery',[item('i','failed',{recoverableEmpty:true})]);
  record(s,'mixed',[item('a','done'),item('b','running')]);record(s,'tried',[item('i','clarify',{attempted:true})]);
  for(const [id,status] of [['done','done'],['manual','clarify'],['known','failed']]) record(s,id,[item('i',status)]);
  const f=fixture(s), original=structuredClone(s.sessions);
  for(const t of s.tasks) {
    const remove=btn(expand(f.root,t.id),'删除记录'), allowed=['done','manual','known'].includes(t.id);assert.equal(!remove.disabled,allowed,t.id);
    if(!allowed) {remove.dispatchEvent(new Event('click'));assert.ok(!walk(f.root).some(n=>visible(n) && n.textContent==='确认删除这条记录'));}
  }
  const r=rowFor(f.root,'manual'), b=btn(r,'删除记录');b.click();assert.deepEqual(f.calls,[]);
  assert.ok(note(r,'不会删除原会话或消息，也不会停止会话'));const confirm=btn(r,'确认删除这条记录');btn(r,'取消').click();confirm.dispatchEvent(new Event('click'));assert.deepEqual(f.calls,[]);
  // An old confirmation control must not act on a different newly reviewed record.
  const known=rowFor(f.root,'known');btn(known,'删除记录').click();confirm.dispatchEvent(new Event('click'));await settle();assert.deepEqual(f.calls,[]);btn(known,'取消').click();
  b.click();btn(r,'确认删除这条记录').click();confirm.dispatchEvent(new Event('click'));await settle();assert.deepEqual(f.calls,[['removeTask','manual']]);
  assert.equal(r.isConnected,false);assert.deepEqual(s.sessions,original);assert.ok(note(f.root,'已移除 1 条本机路由记录'));f.dispose();
});

test('清理已完成冻结当前可见 IDs，以确认后的实际数量反馈；过滤、取消和新完成项不扩大范围',async()=>{
  const s=uiState(), done=id=>record(s,id,[item('i','done')]);done('a');const b=done('b');const late=record(s,'later',[item('i','queued')]);
  record(s,'mixed',[item('one','done'),item('two','clarify')]);record(s,'failed',[item('i','failed')]);const f=fixture(s),filter=control(f.root,'按状态筛选');
  fill(filter,'queued');assert.ok(btn(f.root,'清理已完成').disabled);fill(filter,'done');const bulk=btn(f.root,'清理已完成');bulk.click();
  assert.ok(note(f.root,'2 条已完成记录'));assert.deepEqual(f.calls,[]);assert.equal(rowFor(f.root,'mixed').getAttribute('data-status'),'clarify');assert.match(selectRecord(f.root,'mixed').textContent,/含已完成项/);
  btn(f.root,'取消').click();assert.deepEqual(f.calls,[]);bulk.click();
  b.items[0].status='running';late.items[0].status='done';done('joined-after-preview');f.emit();
  const yes=btn(f.root,'确认清理已完成记录');yes.click();yes.dispatchEvent(new Event('click'));await settle();
  assert.deepEqual(f.calls,[['clearCompleted',['a']]]);assert.deepEqual(s.tasks.map(t=>t.id),['b','later','mixed','failed','joined-after-preview']);
  assert.ok(note(f.root,'已移除 1 条本机路由记录'));bulk.click();fill(filter,'failed');yes.dispatchEvent(new Event('click'));assert.equal(f.calls.length,1);f.dispose();
});

test('过时的删除确认不能在订阅更新、异步读取、切换页面或卸载后执行',async()=>{
  const s=uiState(), t=record(s,'id',[item('i','clarify')]),f=fixture(s),r=expand(f.root,'id'),ask=btn(r,'删除记录');
  ask.click();const stale=btn(r,'确认删除这条记录');t.items[0].status='unknown';f.emit();assert.ok(!visible(stale));stale.dispatchEvent(new Event('click'));assert.deepEqual(f.calls,[]);
  // The original clarify bucket was unassigned. Now it has a saved project;
  // browse into that project before asking for a new, visible confirmation.
  t.items[0].status='done';f.emit();btn(expand(f.root,'id'),'删除记录').click();let g=deferred(),then=structuredClone(s);f.api.getState=()=>g.promise;btn(r,'确认删除这条记录').click();
  t.items[0].status='queued';f.emit(s);g.resolve(then);await settle();assert.deepEqual(f.calls,[]);assert.ok(note(f.root,'没有移除记录'));
  t.items[0].status='done';f.emit(s);ask.click();settings(f.root);stale.dispatchEvent(new Event('click'));await settle();assert.deepEqual(f.calls,[]);
  btn(f.root,'任务台').click();ask.click();g=deferred();f.api.getState=()=>g.promise;btn(r,'确认删除这条记录').click();f.dispose();g.resolve(s);await settle();assert.deepEqual(f.calls,[]);
});

test('点击活动记录直接在本页挂载；重绘复用、快速切换、显式关闭、断线和卸载均释放对应租约',async()=>{
  const s=uiState(), gates=[],events=[];s.sessions=['A','B'].map(id=>({id,cwd:'/web',title:'会话 '+id}));
  for(const sid of ['A','B']) record(s,'task-'+sid,[item('i','running',{sessionId:sid})]);
  const f=fixture(s,{mountSessionPane:(host,sid)=>{const part={host,sid,clean:0};events.push(part);host.append(host.ownerDocument.createElement('section'));
    if(sid==='B') return ()=>{part.clean++;}; const g=deferred();gates.push(()=>g.resolve(()=>{part.clean++;}));return g.promise;}});
  const aside=side(f.root), a=selectRecord(f.root,'task-A'), b=selectRecord(f.root,'task-B');assert.ok(!visible(aside));assert.equal(a.getAttribute('data-action'),'view-session');
  a.click();assert.ok(visible(aside));assert.ok(visible(control(f.root,'任务内容')));assert.equal(btn(rowFor(f.root,'task-A'),'展开详情').getAttribute('aria-expanded'),'false');
  const [first]=events;assert.equal(first.host.getAttribute('data-session-id'),'A');for(let n=first.host;n;n=n.parent) assert.ok(!n.className?.split(' ').includes('dshr'));
  f.emit();a.click();assert.equal(events.length,1);assert.ok(first.host.isConnected);
  b.click();assert.ok(!first.host.isConnected);assert.equal(events[1].sid,'B');gates[0]();await settle();assert.equal(first.clean,1);assert.equal(events[1].clean,0);
  const close=btn(aside,'关闭侧栏');close.click();assert.ok(!visible(aside));assert.equal(events[1].clean,1);assert.equal(f.root.ownerDocument.activeElement,b);
  b.click();s.connected=false;f.emit();assert.equal(events[2].clean,1);assert.ok(!visible(aside));assert.equal(b.getAttribute('data-action'),'view-details');
  s.connected=true;f.emit();a.click();settings(f.root);assert.ok(!visible(aside));gates[1]();await settle();assert.equal(events[3].clean,1);
  btn(f.root,'任务台').click();a.click();f.dispose();f.dispose();gates[2]();await settle();assert.equal(events[4].clean,1);assert.deepEqual(f.calls,[]);
});

test('侧栏仅使用最新已授权的绑定或候选；失效标记不降级、撤权后清空，从不跳到全局会话',async()=>{
  const s=uiState();s.sessions=[{id:'same',cwd:'/web',title:'原会话'}];const candidate=item('i','clarify',{project:null,candidates:['same'],candidateDirs:{same:'/web'}});
  record(s,'pending',[candidate]);record(s,'bound',[item('b','running',{sessionId:'same'})]);let allowed=null,clean=0,shows=0;
  const f=fixture(s,{sessionPaneTarget:()=>allowed,mountSessionPane:(_,sid)=>{assert.equal(sid,'same');shows++;return ()=>{clean++;};}});
  const c=nodeFor(f.root,'i','pending'), sel=control(c,'复用候选会话'), peek=btn(c,'在侧栏查看候选会话');fill(sel,'same');
  assert.ok(peek.disabled);peek.dispatchEvent(new Event('click'));assert.equal(shows,0);assert.equal(selectRecord(f.root,'bound').getAttribute('data-action'),'view-details');
  allowed='/web';s.sessions=[];f.emit();assert.ok(!peek.disabled);peek.click();assert.equal(shows,1);assert.ok(visible(side(f.root)));
  // Same ID still generally authorized through another record, but this *source* is withdrawn.
  candidate.candidates=[];f.emit();assert.ok(!visible(side(f.root)));assert.equal(clean,1);
  candidate.candidates=['same'];candidate.candidateDirs={same:'/elsewhere'};f.emit();assert.ok(peek.disabled);peek.dispatchEvent(new Event('click'));assert.equal(shows,1);
  selectRecord(f.root,'bound').click();assert.equal(shows,2);s.sessions=[{id:'same',cwd:'/web'}];allowed=null;f.emit();assert.ok(!visible(side(f.root)));assert.equal(clean,2);
  f.dispose();const old=fixture(s,{mountSessionPane:null});const source=nodeFor(old.root,'b','bound');btn(source,'在侧栏查看原会话').dispatchEvent(new Event('click'));await settle();assert.deepEqual(old.calls,[]);old.dispose();
});

test('无法区分多份旧活动会话时先展示原分项；过期挂载错误不能覆盖新的会话',async()=>{
  const s=uiState();s.sessions=['one','two'].map(id=>({id,cwd:'/web'}));addTask(s,item('a','running',{sessionId:'one'}),item('b','running',{sessionId:'two'}));
  const pending=deferred(), seen=[];const f=fixture(s,{mountSessionPane:(_,sid)=>{seen.push(sid);return sid==='one'?pending.promise:()=>{};}});
  const p=byHeading(f.root,'project','/web');assert.deepEqual(idsIn(p),[]);setGroup(p,'project',true);
  const special=byHeading(p,'session','历史多会话');assert.deepEqual(openOriginal(special),[]);assert.deepEqual(idsIn(p),[]);
  setGroup(special,'session',true);assert.deepEqual(idsIn(p),['t:1']);assert.deepEqual(seen,[]);
  const r=rowFor(f.root),choose=selectRecord(f.root,'t:1');assert.equal(choose.getAttribute('data-action'),'view-details');choose.click();assert.ok(visible(btn(r,'收起详情')));assert.deepEqual(seen,[]);
  btn(nodeFor(f.root,'a'),'在侧栏查看原会话').click();btn(nodeFor(f.root,'b'),'在侧栏查看原会话').click();pending.reject(Error('过期失败'));await settle();
  assert.ok(visible(side(f.root)));assert.deepEqual(seen,['one','two']);assert.ok(!alert(f.root,/过期失败/));
  s.sessions=[];f.emit();assert.ok(!visible(side(f.root)));assert.deepEqual(f.calls,[]);f.dispose();
});
