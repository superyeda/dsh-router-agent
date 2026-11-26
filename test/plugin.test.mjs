import test from 'node:test';
import assert from 'node:assert/strict';
import vm from 'node:vm';
import {readFile} from 'node:fs/promises';
import {routerAgentHostContribution} from '../src/host/contract.mjs';
const root=new URL('../',import.meta.url);
const source=await readFile(new URL('lib/client.js',root),'utf8');
const manifest=JSON.parse(await readFile(new URL('package.json',root),'utf8'));

// Model Cordis' two distinct capabilities: publishing a descriptor via $mount
// does not inject its sub-service into the publishing plugin. This fake is strict
// on that boundary; the isolated native smoke repeats it with real Cordis.
function loadClient() {
  let row; const requests=[];
  vm.runInNewContext(source,{window:{__ModuleLoader__:{load:r=>{assert.equal(row,undefined);row=r;}}},TextEncoder,AbortSignal});
  assert.equal(row.id,manifest.name);
  const plugin=row.factory(name=>{requests.push(name);assert.equal(name,'react');return {createElement(){}};});
  assert.deepEqual(requests,['react']);return plugin;
}
function clientScope(plugin,owner) {
  const events=[],mounts=new Map(),properties=new Set();let mounted,gate;
  const services={remoteAccess:{whenAccess(action,cb){gate=action;const stops=owner?[...cb()]:[];return ()=>stops.reverse().forEach(f=>f());}},
    slots:{inject:(_name,fn)=>fn(),register(d,component){mounts.set(d.name,{d,component});return ()=>events.push(d.name+'-');}},uiWorkspace:{}};
  const getRemote=(deps,scope)=>new Proxy({$mount:async c=>{
    assert.equal(scope,'parent');events.push('rpc+');mounted=c;return async()=>{events.push('rpc-');};
  }},{get(obj,k){if(k in obj)return obj[k];if(!deps.includes('remote.'+k))throw Error('cannot get property "remote.'+k+'" without inject');
    assert.equal(scope,'child');if(k==='routerAgent')assert.ok(mounted);properties.add('remote.'+k);return {};}});
  const parent={remote:getRemote(plugin.inject,'parent'),inject(deps,fn){assert.ok(mounted);events.push('child+');
    const child=new Proxy({remote:getRemote(deps,'child')},{get(target,k){if(k in target)return target[k];assert.ok(deps.includes(k),k+' must be injected');return services[k];}});
    const withdraw=fn(child);return {async dispose(){await withdraw?.();events.push('child-');}};
  }};
  return {parent,mounts,events,properties,get mounted(){return mounted;},get gate(){return gate;}};
}

test('distributed bundle uses the injected consumer fiber, then releases it before withdrawing its provider',async()=>{
  const plugin=loadClient(),ctx=clientScope(plugin,true);
  assert.ok(!plugin.inject.includes('remote.routerAgent'),'self-injection would park the provider before $mount');
  assert.throws(()=>ctx.parent.remote.routerAgent,/without inject/);
  const stop=await plugin.apply(ctx.parent);assert.equal(ctx.gate,'routerAgent/infer');
  assert.equal(ctx.mounted.package,manifest.name);assert.equal(JSON.stringify(ctx.mounted.descriptors.map(x=>x.id)),JSON.stringify(routerAgentHostContribution.invocations.map(x=>x.id)));
  assert.deepEqual([...ctx.properties].sort(),['remote.remoteAccess','remote.routerAgent','remote.session','remote.workspace']);
  assert.equal(ctx.mounts.get('main').d.key,ctx.mounts.get('sidebar.panellist').d.id);assert.equal(ctx.mounts.get('sidebar.panellist').d.label(),'任务路由');assert.equal(typeof ctx.mounts.get('main').d.inject().connectRouter,'function');
  await stop();assert.deepEqual(ctx.events,['rpc+','child+','sidebar.panellist-','main-','child-','rpc-']);
});
test('non-owner without access never mounts the board or reads its local journal',async()=>{
  const plugin=loadClient(),ctx=clientScope(plugin,false);const stop=await plugin.apply(ctx.parent);
  assert.equal(ctx.gate,'routerAgent/infer');assert.equal(ctx.mounts.size,0);await stop();
});
test('published package entries exist and offline demo cannot open network connections',async()=>{
  for(const rel of [manifest.main,manifest.exports['./client'],manifest.dsh.bundle.patch])assert.ok((await readFile(new URL(rel,root))).length);
  const demo=await readFile(new URL('examples/try-router.html',root),'utf8');assert.match(demo,/connect-src 'none'/);assert.ok(!demo.includes('/*APP*/'));assert.match(demo,/离线演练/);
});
