import test from 'node:test';
import assert from 'node:assert/strict';
import {createSessionPanes} from '../src/ui/session-pane.mjs';

// Synthetic native service faces, no filesystem history, provider, or host. The
// presenter is just a handoff probe; these tests do NOT simulate DSH Chat.
const turn=()=>new Promise(resolve=>setImmediate(resolve));
function latch(){let release;const promise=new Promise(y=>{release=y;});return {release,promise};}
function observable(value){const listeners=new Set();return {getSnapshot:()=>value,subscribe(fn){listeners.add(fn);return ()=>listeners.delete(fn);},set(v){value=v;for(const f of [...listeners])f();},listeners};}
class Node extends EventTarget {
  constructor(doc,tag){super();this.ownerDocument=doc;this.tag=tag;this.nodes=[];this.attrs={};this.text='';}
  set textContent(v){this.text=v;}get textContent(){return this.text+this.nodes.map(n=>n.textContent).join('');}
  append(n){n.remove();this.nodes.push(n);n.parent=this;} remove(){if(this.parent){this.parent.nodes=this.parent.nodes.filter(n=>n!==this);this.parent=undefined;}}
  setAttribute(k,v){this.attrs[k]=v;}
  find(fn){return fn(this)?this:this.nodes.map(n=>n.find(fn)).find(Boolean);}
}
const doc={createElement:tag=>new Node(doc,tag)}, ids=['selected','other'], cwd='/synthetic/authorized';
function fixture(){
  const root=doc.createElement('main'), trace=[], allowed=new Set(['session/projections','session/follow','session/page','session/prompt']), guards=new Map();
  const settings=observable(cwd), generation=observable({id:1});
  const list=observable({phase:'ready',ids,byId:Object.fromEntries(ids.map(id=>[id,{id,cwd,formatStatus:'current'}])),projectionsBySession:{}});
  const ws=observable({phase:'ready',archivedSessionIds:[]});
  const f={proof:{active:true},owner:true,root,settings,generation,list,ws,trace,allowed,guards,leases:[],proofs:[],owners:[]};
  const ctx={connection:{generation},workspaces:{list:ws},uiSession:{whenAccess(id,action,install){
    assert.ok(ids.includes(id));if(!allowed.has(action)) return ()=>{};
    const remove=install();guards.set(action,remove);return ()=>{guards.delete(action);remove();};
  }},sessions:{list,retain(id,{source,signal}){
    assert.ok(ids.includes(id));assert.equal(source,'routerPane');assert.equal(signal.aborted,false);
    const snapshot=observable({sessionId:id,removed:false,subagent:null,openState:'open'}), directory=observable(cwd);
    const binding={sessionId:id,session:{...snapshot,projections:{faceOf(key){assert.equal(key,'workingDirectory');return directory;}}}};
    const ref={sessionId:id,binding,ready:f.ready?f.ready.promise.then(()=>binding):Promise.resolve(binding),release(){trace.push('release:'+id);}};
    f.leases.push({ref,snapshot,directory,signal});trace.push('retain:'+id);return ref;
  }}};
  const panes=createSessionPanes({ctx,ownerGeneration:generation.getSnapshot(),api:{sessionPaneTarget:id=>ids.includes(id)?settings.getSnapshot():null, subscribe:settings.subscribe},
    async verifyOwner(signal){f.owners.push(signal);if(f.owner!==true)throw Error('not owner');},
    adapter:{async inspectPaneTarget(id,project,signal){assert.equal(project,cwd);f.proofs.push({id,signal});if(f.proofWait)await f.proofWait.promise;return f.proof;}},
    present(node,ref){assert.equal(node.attrs['data-router-native-session'],ref.sessionId);trace.push('present:'+ref.sessionId);node.textContent='synthetic-test-marker:'+ref.sessionId;
      return ()=>{assert.equal(node.parent,undefined);trace.push('withdraw:'+ref.sessionId);};}});
  return Object.assign(f,{panes,ctx,mount:(id=ids[0])=>panes.mount(root,id)});
}
function clean(f){assert.equal(f.guards.size,0);for(const s of [f.settings,f.ws,f.list,f.generation,...f.leases.flatMap(l=>[l.snapshot,l.directory])])assert.equal(s.listeners.size,0);}

 test('explicit selection retains just that exact generation; close detaches, withdraws, releases once and never navigates',async()=>{
  const f=fixture(),close=f.mount();assert.equal(typeof close,'function');await turn();
  assert.deepEqual(f.trace,['retain:selected','present:selected']);assert.equal(f.owners.length,1);assert.equal(f.proofs.length,1);
  assert.match(f.root.textContent,/synthetic-test-marker:selected/);close();close();f.panes.dispose();
  assert.deepEqual(f.trace,['retain:selected','present:selected','withdraw:selected','release:selected']);
  assert.equal(f.root.textContent,'');assert.ok(f.leases[0].signal.aborted);clean(f);
});

test('no lease or transcript for stale controller IDs, foreign/fallback/archived rows, wrong owner or missing native grant',async()=>{
  for(const setup of [f=>f.settings.set(null),f=>{f.owner=false;},f=>f.generation.set({id:2}),f=>f.ws.set({phase:'pending',archivedSessionIds:[]}),
    f=>f.ws.set({phase:'ready',archivedSessionIds:['selected']}),f=>f.list.set({...f.list.getSnapshot(),ids:[]}),
    ...[{id:'other'},{cwd:'/synthetic/no'},{origin:'subagent'},{formatStatus:'migration-required'}].map(change=>f=>{
      const l=f.list.getSnapshot();f.list.set({...l,byId:{selected:{...l.byId.selected,...change}}});}),f=>f.allowed.delete('session/prompt')]){
    const f=fixture();setup(f);f.mount();await turn();assert.deepEqual(f.trace,[]);clean(f);f.panes.dispose();
  }
});

test('every live revocation synchronously erases controls/content and unsubscribes; regrant cannot reopen a stale selection',async()=>{
  for(const revoke of [f=>f.settings.set('/another'),f=>f.generation.set(undefined),f=>f.generation.set({id:2}),
    f=>f.guards.get('session/follow')(), f=>f.ws.set({phase:'ready',archivedSessionIds:['selected']}),
    f=>f.list.set({...f.list.getSnapshot(),ids:[]}),f=>f.leases[0].directory.set('/other'),f=>f.leases[0].directory.set(undefined),
    f=>f.leases[0].snapshot.set({...f.leases[0].snapshot.getSnapshot(),removed:true}),
    f=>f.leases[0].snapshot.set({...f.leases[0].snapshot.getSnapshot(),openState:'error'})]){
    const f=fixture(),close=f.mount();await turn();revoke(f);assert.doesNotMatch(f.root.textContent,/synthetic-test-marker/);
    assert.deepEqual(f.trace,['retain:selected','present:selected','withdraw:selected','release:selected']);clean(f);
    f.settings.set(cwd);await turn();assert.equal(f.leases.length,1);close();f.panes.dispose();
  }
});

test('revocation/close during proof, ready or switching IDs fences late deliveries; a stale disposer cannot remove its successor',async()=>{
  const f=fixture();f.proofWait=latch();const stale=f.mount();await turn();assert.equal(f.proofs.length,1);
  stale();assert.ok(f.proofs[0].signal.aborted);f.proofWait.release();await turn();assert.deepEqual(f.trace,[]);
  f.proofWait=undefined;f.ready=latch();const close=f.mount();await turn();assert.deepEqual(f.trace,['retain:selected']);
  const oldReady=f.ready;f.ready=undefined;const successor=f.mount('other');await turn();oldReady.release();await turn();close();
  assert.deepEqual(f.trace,['retain:selected','release:selected','retain:other','present:other']);assert.match(f.root.textContent,/marker:other/);
  successor();f.panes.dispose();clean(f);assert.ok(f.leases.every(l=>l.signal.aborted));
});

test('cold candidate lookup never wakes it; only a single explicit load with a second live proof can retain it',async()=>{
  const f=fixture();f.proof={active:false};const close=f.mount();await turn();
  const button=f.root.find(n=>n.tag==='button');assert.equal(button.textContent,'载入原会话');assert.deepEqual(f.trace,[]);
  assert.match(f.root.textContent,/唤醒.*不会提交/);
  button.dispatchEvent(new Event('click'));button.dispatchEvent(new Event('click'));await turn();
  assert.equal(f.owners.length,2);assert.equal(f.proofs.length,2);assert.deepEqual(f.trace,['retain:selected','present:selected']);close();clean(f);
  for(const reject of ['owner','mid-proof','post-close']){
    const g=fixture();g.proof={active:false};const stop=g.mount();await turn();const pick=g.root.find(n=>n.tag==='button');
    if(reject==='owner')g.owner=false;
    if(reject==='mid-proof')g.proofWait=latch();if(reject==='post-close')stop();pick.dispatchEvent(new Event('click'));await turn();
    if(g.proofWait){g.settings.set(null);g.proofWait.release();await turn();}
    assert.deepEqual(g.trace,[]);stop();clean(g);
  }
});

test('release also covers presenter/ready failure, stale Session epoch and plugin disposal while hidden/unopened',async()=>{
  for(const alter of [l=>l.snapshot.set({...l.snapshot.getSnapshot(),subagent:{}}),l=>l.directory.set('/wrong'),l=>l.snapshot.set({...l.snapshot.getSnapshot(),sessionId:'other'}),l=>l.snapshot.set({...l.snapshot.getSnapshot(),openState:'error'})]){
    const f=fixture();f.ready=latch();f.mount();await turn();alter(f.leases[0]);f.ready.release();await turn();assert.deepEqual(f.trace,['retain:selected','release:selected']);clean(f);f.panes.dispose();
  }
  const f=fixture();f.panes.dispose();f.mount();await turn();assert.equal(f.root.textContent,'');assert.deepEqual(f.trace,[]);
});
