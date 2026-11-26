import assert from 'node:assert/strict'
import { pathToFileURL } from 'node:url'

// Stock Cordis services are the rc.5 browser factories, not substitutes for
// Session.retain(), its scoped bindings, native event windows or their streams.
// No standalone Node module for the shell's dsh-client-store export in the
// desktop bundle: provide only its tiny observable cell/listener primitives.
const notifySubscribers = listeners => { for (const listener of [...listeners]) listener() }
const store = {notifySubscribers, createSnapshotStore(initial) {
  const listeners=new Set(); let state=initial
  return {getSnapshot:()=>state,subscribe(fn){listeners.add(fn);return ()=>listeners.delete(fn)},
    set(next){if(!Object.is(next,state)){state=next;notifySubscribers(listeners)}}}
}}
export async function installStockSessions({client,host,req,pkg}) {
  const deps={ '@deepseek-ai/cordis':await pkg('cordis'), '@deepseek-ai/dsh-api-gateway/client':await pkg('dsh-api-gateway/client'), '@deepseek-ai/dsh-client-store':store,
    zod:req('zod'), '@deepseek-ai/dsh-client-ui-slots':{standardHookPropName:n=>'use'+n[0].toUpperCase()+n.slice(1)}, 'react/jsx-runtime':{} }
  async function desktopPlugin(name) {
    const id='@deepseek-ai/'+name
    const saved=globalThis.window; let row
    try {
      globalThis.window={__ModuleLoader__:{load(r){assert.equal(r.id,id);row=r}}}
      await import(pathToFileURL(req.resolve(id+'/client')).href)
      const plugin=row.factory(key=>{assert.ok(Object.hasOwn(deps,key),'unexpected stock module import: '+key);return deps[key]})
      await client.plugin(plugin)
    } finally { if(saved===undefined) delete globalThis.window; else globalThis.window=saved }
  }
  for (const n of ['dsh-commands','dsh-subagent']) {
    await host.typert.register((await pkg(n+'/typert')).TYPERT)
    await client.remote.$mount((await pkg(n+'/remote')).default)
  }
  await desktopPlugin('dsh-client-file-upload')
  await desktopPlugin('dsh-api-session-controller')
  await desktopPlugin('dsh-api-workspace-controller')
  assert.equal(typeof client.get('sessions')?.retain,'function','stock SessionController was not activated')
  assert.ok(client.get('workspaces'),'stock WorkspaceController was not activated')
  return desktopPlugin
}
