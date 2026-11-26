// Runs from file://. All workspaces, sessions, tickets and replies below are fictional.
import { createRouter } from '../src/core/controller.mjs';
import { memoryJournal } from '../src/core/journal.mjs';
import { mountRouter } from '../src/ui/main.mjs';
const projects=[{name:'发布工具',path:'/demo/A'},{name:'账单核算',path:'/demo/B'}];
const pre=[{id:'demo-release',cwd:'/demo/A',title:'A 项目发版检查',updatedAt:Date.now(),busy:true}];
const catalog=[{provider:'demo',model:'swift',efforts:['low']},{provider:'demo',model:'work',efforts:['medium']},{provider:'demo',model:'reason',efforts:['high']}];
const byCreate=new Map(), work=new Map();
const adapter={
  async listWorkspaces(){return projects;},async catalog(){return catalog;},
  async listSessions(paths){return pre.filter(s=>paths.includes(s.cwd));},async recent(){return ['继续发版检查'];},
  async createSession(cwd,key){if(!byCreate.has(key)){const id='demo-'+(byCreate.size+1);byCreate.set(key,id);pre.push({id,cwd,title:'演练中新建的会话',updatedAt:Date.now(),busy:false});}return byCreate.get(key);},
  async configure(){}, async cursor(){return work.size;}, async deliver(id,key,text){if(!work.has(key))work.set(key,{id,text,step:0});},
  async observe(id,key){const w=work.get(key);if(!w||id!==w.id)return {status:'unknown'};
    if(++w.step<(id==='demo-release'?4:2))return {status:'running'};
    return {status:'done',result:'[模拟结果 · 未执行实际任务]\n'+w.text.slice(0,140)+'\n1. 已完成演练检查。\n2. 可在同一会话继续追问。'};},
};
const journal=memoryJournal();const doc=journal.read();doc.settings={projects,generalDir:'/demo/general',tiers:Object.fromEntries(['fast','standard','deep'].map((k,i)=>[k,{provider:'demo',model:catalog[i].model,effort:catalog[i].efforts[0]}]))};journal.write(doc);
const api=createRouter({adapter,journal});
// Deliberately synthetic; only the installed plugin embeds a native DSH chat.
api.mountSessionPane=(container,sid)=>{
  const frame=document.createElement('section'), name=document.createElement('h3'), mode=document.createElement('small'), stream=document.createElement('div');
  name.textContent=pre.find(s=>s.id===sid)?.title || '演练会话';mode.textContent='离线模拟 · 不连接真实 DSH';frame.append(name,mode,stream);container.replaceChildren(frame);
  function render(){
    if(!api.sessionPaneTarget(sid)) {frame.remove();return;}
    const rows=api.getState().tasks.slice().reverse().flatMap(t=>t.items).filter(i=>i.sessionId===sid);
    stream.replaceChildren(...rows.flatMap(i=>[i.text,i.result || '[模拟会话正在处理…]'].map(t=>{const p=document.createElement('p');p.textContent=t;return p;})));
  }
  const stop=api.subscribe(render);render();return ()=>{stop();frame.remove();};
};
mountRouter(document.getElementById('router'),api);
const feedback=document.getElementById('demo-feedback');
for(const button of document.querySelectorAll('[data-sample]'))button.addEventListener('click',async()=>{
  button.disabled=true;try{await api.submit(button.dataset.sample);feedback.textContent='示例已交给演练路由器。';}catch(e){feedback.textContent=e.message;}finally{button.disabled=false;}
});
void api.refresh();setInterval(()=>{void api.tick().catch(e=>{feedback.textContent=e.message;});},1400);
