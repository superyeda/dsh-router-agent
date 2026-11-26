import assert from 'node:assert/strict'
import { existsSync } from 'node:fs'
import { readFile } from 'node:fs/promises'
import { panelDOM } from './panel-dom.mjs'
import { checkRouting } from './routing.mjs'
import { checkLedger } from './ledger.mjs'
import { checkAutomatic } from './automatic.mjs'
import { checkSlowInfer, semanticRequest, semanticSettings } from './slow-infer.mjs'
import { join } from 'node:path'

// Run the exact distributed factory in the SAME JS realm as Cordis. Its React
// component merely passes the DOM root to connectRouter; drive that registered
// main-slot callback directly (no real window, React renderer, or Web server).
async function loadBundle(name) {
  let row
  globalThis.window = {__ModuleLoader__: {load(r) { assert.equal(row, undefined); row = r }}}
  await import(new URL('./' + name + '.cjs', import.meta.url))
  assert.equal(row.id, 'dsh-router-agent')
  return row.factory(id => { assert.ok(['react','react-dom'].includes(id)); return {} })
}

export async function checkProductionPanel({client, Service, host, endpoints, calls, provider, cwd, defaultModel, targetModel, replyText, routing, installDesktop, streams}) {
  const slots = new Map(), navigations=[], ledger=process.env.DSH_SMOKE_PHASE==='ledger'
  let notify = () => {}
  // Just the page shell seams: existing main/sidebar surfaces and their
  // access-granted slot gate. The panel itself still verifies owner through
  // the REAL remoteAccess.follow stream; no Remote service is supplied here.
  class Slots extends Service {
    constructor(ctx) { super(ctx, 'slots') }
    inject(_, fn) { return this.ctx.effect(fn) }
    provideRoot() { return this.ctx.effect(()=>()=>{}) } // no React hooks rendered
    installScope(name, adapter) { assert.equal(name,'session');assert.ok(adapter.bindingSource);return this.ctx.effect(()=>()=>{}) }
    bindStoreScope() { /* Slot host never asks to render this test's hooks. */ }
    register(spec, component) {
      const owner = this.ctx
      return owner.effect(() => {
        assert.ok(!slots.has(spec.name)); slots.set(spec.name, {spec, component, owner}); notify()
        return () => { slots.delete(spec.name); notify() }
      })
    }
  }
  class AccessGate extends Service {
    constructor(ctx) { super(ctx, 'remoteAccess') }
    whenAccess(action, fn) { assert.equal(action, 'routerAgent/infer'); return this.ctx.effect(fn) }
  }
  const shell = client.plugin(ctx => {
    new Slots(ctx); if (!ledger) {new AccessGate(ctx);ctx.provide('uiSession',{whenAccess(){assert.fail('unexpected sidebar outside ledger scenario')}})}
    ctx.provide('layout', {}); ctx.provide('uiWorkspace', {openSession(...args) { navigations.push(args); assert.fail('unexpected navigation') }})
  })
  await shell
  if (ledger) {
    await installDesktop('dsh-api-remote-access')
    await installDesktop('dsh-client-ui-session')
    assert.ok(client.get('uiSession') && client.get('remoteAccess'))
  }
  async function withPanel(plugin, doc, legacy, run, display) {
    assert.equal(client.get('remote.routerAgent'), undefined, 'a root mount must not mask this test')
    globalThis.window = doc.win; notify = doc.changed
    const fiber = client.plugin(plugin) // IMPORTANT: real non-root Cordis fiber; never plugin.apply(client)
    let disconnect
    try {
      await fiber
      const {spec, owner} = await doc.until(() => slots.get('main'), 'no registered production main slot')
      assert.ok(owner.fiber.runtime, 'slot must not have been registered through the Cordis root')
      if (!legacy) assert.ok('remote.routerAgent' in owner.fiber.inject, 'panel registered outside its injected child')
      if (ledger) {
        assert.deepEqual(spec.children['routerAgent.sessionPane'],{kind:'single',scope:'session'})
        assert.equal(typeof slots.get('routerAgent.sessionPane')?.component,'function')
      }
      const {connectRouter} = spec.inject()
      const reopen = async () => { disconnect?.(); disconnect = connectRouter(doc.root,display); await doc.ready() }
      await reopen(); await run(reopen)
    } finally {
      try { disconnect?.() } finally { await fiber.dispose() }
      assert.equal(slots.size, 0, 'slot registrations survived disposal')
      assert.equal(client.get('remote.routerAgent'), undefined, 'Remote namespace survived disposal')
    }
  }
  async function submit(plugin, legacy, round) {
    const tiers = Object.fromEntries(['fast', 'standard', 'deep'].map(k => [k, {provider, model: k === 'fast' ? defaultModel : targetModel, effort: ''}]))
    const settings = legacy ? {generalDir:cwd,projects:[],tiers} : await semanticSettings(host, join(cwd,'scope-'+round), tiers)
    const doc = panelDOM(settings)
    const offset = endpoints.length, callCount = calls.length
    await withPanel(plugin, doc, legacy, async () => {
      await doc.submit(legacy ? '在通用目录新建会话，用标准档写一首关于四季的短诗。' : semanticRequest)
      const item = await doc.until(() => {
        const i = doc.item()
        if (i && ['done','failed','unknown','clarify'].includes(i.status)) return i
      }, 'no final production item')
      const trace = endpoints.slice(offset), error = 'cannot get property "remote.routerAgent" without inject'
      if (legacy) {
        assert.equal(item.status, 'failed'); assert.ok(item.error.includes(error), item.error)
        assert.deepEqual(trace.filter(s => s.startsWith('api/routerAgent/') || s === 'api/session/prompt'), [])
        assert.equal(calls.length, callCount)
        console.log('REPRO 0.1.0: ' + error + ' (failed production item; no router/prompt RPC)')
      } else {
        assert.equal(item.status, 'done', item.error || item.reason); assert.equal(item.result, replyText)
        assert.match(item.reason, /模型建议经本地校验/, 'a classification fallback must not count as scoped inference')
        assert.deepEqual(trace.filter(s => s.startsWith('api/routerAgent/') || s === 'api/session/prompt'),
          ['api/routerAgent/infer','api/routerAgent/create','api/routerAgent/configure','api/session/prompt'])
        assert.deepEqual(calls.slice(callCount).map(c => c.model), [defaultModel, targetModel])
        assert.equal(item.text,semanticRequest); assert.equal(item.project,settings.projects[1].path)
        assert.equal(host.agents.get(item.sessionId).session.header.cwd,item.project)
        assert.deepEqual(host.agents.get(item.sessionId).model.current(), {provider, model: targetModel})
        assert.deepEqual(host.agentDefaultModel.currentSelection(), {provider, model: defaultModel})
        console.log('PASS production panel ' + round + ': form → infer/create/configure/prompt → done via non-root Cordis fiber')
      }
    })
  }
  try {
    const phase = process.env.DSH_SMOKE_PHASE
    if (phase === 'slow-infer' || phase === 'slow-infer-0.2.1') {
      const old = phase === 'slow-infer-0.2.1'
      await checkSlowInfer({old, plugin:await loadBundle(old?'legacy-slow':'current'), host, withPanel, routing, endpoints, cwd, provider}); return
    }
    const production = await loadBundle('current')
    if (!routing) {
      const old = new URL('./legacy.json', import.meta.url)
      if (existsSync(old)) {
        const {name, version} = JSON.parse(await readFile(old, 'utf8'))
        assert.equal(name, 'dsh-router-agent'); assert.equal(version, '0.1.0')
        await submit(await loadBundle('legacy'), true, 'legacy')
      }
      await submit(production, false, 'mount')
      await submit(production, false, 'remount')
      return
    }
    if(process.env.DSH_SMOKE_PHASE==='automatic') {
      const manifest=new URL('./legacy-automatic.json',import.meta.url);let old
      if(existsSync(manifest)) {
        const {name,version}=JSON.parse(await readFile(manifest,'utf8'));assert.equal(name,'dsh-router-agent');assert.equal(version,'0.2.0')
        old=await loadBundle('legacy-automatic')
      }
      await checkAutomatic({host,native:client.remote,production,old,withPanel,routing,endpoints,cwd,provider});return
    }
    const oldRouter = new URL('./legacy-routing.json', import.meta.url)
    let legacyRouting
    if (existsSync(oldRouter)) {
      const {name, version} = JSON.parse(await readFile(oldRouter, 'utf8'))
      assert.equal(name, 'dsh-router-agent'); assert.equal(version, '0.1.2')
      legacyRouting = await loadBundle('legacy-routing')
    }
    if (process.env.DSH_SMOKE_PHASE==='ledger') {
      await checkLedger({host,client,production,withPanel,endpoints,streams,navigations,routing,provider,cwd})
    } else await checkRouting({host, native:client.remote, cwd, provider, production, legacyRouting, withPanel, endpoints, routing})
  } finally { delete globalThis.window; await shell.dispose() }
}
