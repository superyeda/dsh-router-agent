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
  focus(){this.ownerDocument.activeElement=this;}
  click(){if (!this.disabled)this.dispatchEvent(new Event('click'));}
}
const dom=()=>{const doc={defaultView:new EventTarget(),createElement(tag){return new Element(doc,tag);}};return doc.createElement('main');};
const walk=n=>[n,...n.children.flatMap(walk)];
const visible=n=>!!n && !n.hidden && (!n.parent || visible(n.parent));
const find=(n,pred)=>{const result=walk(n).find(pred);assert.ok(result,'Missing node: '+pred);return result;};
const btn=(n,label)=>find(n,c=>c.tag==='button' && c.textContent===label);
const control=(n,label)=>find(n,c=>c.tag==='label' && c.children[0]?.textContent===label).children[1];
const alert=(n,pattern)=>walk(n).some(c=>c.getAttribute('role')==='alert' && visible(c) && pattern.test(c.textContent));
const fill=(el,value)=>{el.value=value;el.dispatchEvent(new Event(el.tag==='select'?'change':'input'));};
const submit=el=>{for(let n=el;n;n=n.parent){if(n.tag==='form'){n.dispatchEvent(new Event('submit',{cancelable:true}));return;}}throw Error('No form');};
const uiState=()=>({settings:{generalDir:'/general',projects:[{path:'/web',name:'站点'}],tiers:Object.fromEntries(['fast','standard','deep'].map(k=>[k,{provider:'p',model:'m',effort:'low'}]))},
  workspaces:[{path:'/docs',name:'文档'}],catalog:[{provider:'p',model:'m',efforts:['low','high']}],sessions:[],tasks:[],connected:true});
function fixture(state=uiState(), extra={}){
  const root=dom(),listeners=new Set(),calls=[];let unsubs=0;
  const emit=(...args)=>listeners.forEach(f=>f(...args));
  const api={getState:()=>state,subscribe:f=>{listeners.add(f);return ()=>{listeners.delete(f);unsubs++;};},...extra};
  for(const k of ['submit','resolve','approve','followUp','retry','refresh','openSession','saveSettings']) if (!api[k]) api[k]=async(...args)=>{calls.push([k,...args]);if(k==='saveSettings')state.settings=args[0];};
  return {root,api,state,calls,emit,get unsubs(){return unsubs;},dispose:mountRouter(root,api)};
}
const settle=()=>new Promise(r=>setImmediate(r));
const deferred=()=>{let resolve,reject;const promise=new Promise((yes,no)=>{resolve=yes;reject=no;});return {promise,resolve,reject};};
const addTask=(state,...items)=>state.tasks.push({id:'t:1',text:'跨项目任务',createdAt:'2026-01-01T00:00:00Z',items});
const item=(id,status,more={})=>({id,text:id+' 的内容',status,tier:'standard',project:'/web',reason:'按目录选择',candidates:[],dependsOn:[],...more});
const nodeFor=(root,id)=>find(root,c=>c.tag==='article' && c.children.some(n=>n.tag==='h4' && n.textContent===id+' 的内容'));

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
  const f=fixture(s),rt=id=>find(nodeFor(f.root,id),n=>n.className==='rt-runtime');
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

test('全部状态与总进度单独可见；筛选不会把相邻状态合并',()=>{
  const s=uiState(), ids=[...STATUS.keys()];addTask(s,...ids.map(v=>item(v,v)));const f=fixture(s);
  for(const [id,[label]] of STATUS){const el=nodeFor(f.root,id);assert.equal(el.getAttribute('data-status'),id);assert.ok(visible(find(el,c=>c.textContent===label)));}
  const allProgress=find(f.root,c=>c.getAttribute('aria-label')==='所有任务已完成子项');assert.equal(allProgress.value,1);assert.equal(allProgress.max,ids.length);
  fill(control(f.root,'按子项状态筛选'),'queued');assert.ok(visible(nodeFor(f.root,'queued')));assert.ok(!visible(nodeFor(f.root,'running')));
  fill(control(f.root,'按子项状态筛选'),'');assert.ok(visible(nodeFor(f.root,'input-required')));f.dispose();
});

test('候选复用、目录新建：明确点击后仅针对本项，过时选择可见但不能提交',async()=>{
  const s=uiState();s.sessions=[{id:'s:1',cwd:'/web',title:'站点',busy:true}];addTask(s,item('a','clarify',{candidates:['s:1']}),item('b','running',{sessionId:'s:2'}));
  const f=fixture(s), a=nodeFor(f.root,'a'), b=nodeFor(f.root,'b');assert.ok(visible(b));
  const reuse=control(a,'复用候选会话');fill(reuse,'s:1');s.tasks[0].items[0].candidates=[];f.emit();
  assert.equal(reuse.value,'s:1');assert.ok(btn(a,'使用此会话').disabled);assert.ok(walk(reuse).some(o=>o.textContent.includes('不再可选')));
  s.tasks[0].items[0].candidates=['s:1'];f.emit();assert.deepEqual(f.calls,[]);
  btn(a,'查看候选会话 ↗').click();await settle();btn(a,'使用此会话').click();await settle();assert.deepEqual(f.calls[0],['openSession','s:1']);
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

test('交接预览保留手改，即使远端更新；需输入仅跳回原会话，追问绑定源子项',async()=>{
  const s=uiState();const a=item('a','handoff',{handoff:'上游结果',dependsOn:['b']}),b=item('b','input-required',{sessionId:'s-b'}),c=item('c','done',{decision:'reuse',sessionId:'s-c'});
  addTask(s,a,b,c);const f=fixture(s), ra=nodeFor(f.root,'a'),rb=nodeFor(f.root,'b'),rc=nodeFor(f.root,'c');
  const transfer=control(ra,'将发往目标会话的内容（可编辑）');assert.equal(transfer.value,'上游结果');
  fill(transfer,'只传这一段\n<pre>');a.handoff='上游另一个版本';f.emit();assert.equal(transfer.value,'只传这一段\n<pre>');assert.ok(visible(btn(ra,'载入最新交接预览')));assert.deepEqual(f.calls,[]);
  btn(ra,'批准并发送交接').click();await settle();assert.deepEqual(f.calls[0],['approve','t:1','a','只传这一段\n<pre>']);
  assert.ok(!visible(btn(rb,'批准并发送交接')));assert.ok(!visible(btn(rb,'发送此项追问')));btn(rb,'打开原会话 ↗').click();await settle();assert.deepEqual(f.calls[1],['openSession','s-b']);
  assert.ok(rc.textContent.includes('沿用原会话模型与模式'));const reply=control(rc,'仅发往本项关联会话的追问');fill(reply,'继续这里');btn(rc,'发送此项追问').click();await settle();
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
  const reply=control(nodeFor(f.root,'a'),'仅发往本项关联会话的追问');fill(reply,'未发内容');fill(control(f.root,'任务内容'),'还没提交');
  fill(control(f.root,'按子项状态筛选'),'running');fill(control(f.root,'按子项状态筛选'),'');assert.equal(control(nodeFor(f.root,'a'),'仅发往本项关联会话的追问'),reply);
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
