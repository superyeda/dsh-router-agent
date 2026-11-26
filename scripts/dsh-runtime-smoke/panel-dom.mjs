// The Node smoke has no browser/React renderer. Supply only the DOM and storage
// primitives used by the registered panel's connectRouter callback. No DSH
// service, namespace, planner, session or model is implemented here.
export function panelDOM(settings, restored) {
  const win = new EventTarget(), journalKey = 'dsh.router-agent.journal.v1'
  const store = new Map([[journalKey, restored ?? JSON.stringify({version: 1, settings, tasks: []})]])
  const watchers = new Set()
  let notification = false
  function changed() {
    if (!notification) {
      notification = true
      queueMicrotask(() => { notification = false; for (const f of watchers) f() })
    }
  }
  // One tab, just in memory; keep the ordinary Web Lock transaction order.
  let tail = Promise.resolve()
  win.navigator = {locks: {request(_key, _opts, fn) { const p = tail.then(fn); tail = p.catch(() => {}); return p }}}
  win.localStorage = {getItem: k => store.get(k) ?? null, setItem(k, v) { store.set(k, v); changed() }}
  class Element extends EventTarget {
    constructor(tag) { super(); this.tag = tag; this.ownerDocument = doc; this.children = []; this.attrs = {}; this.value = ''; this.data = '' }
    set textContent(value) { this.replaceChildren(); this.data = String(value) }
    get textContent() { return this.data + this.children.map(n => n.textContent).join('') }
    setAttribute(k,v) { this.attrs[k] = String(v); changed() }
    getAttribute(k) { return this.attrs[k] ?? null }
    get isConnected() { return this===root || !!this.parent?.isConnected }
    get parentElement() { return this.parent || null }
    get parentNode() { return this.parentElement }
    contains(n) { return n === this || this.children.some(c => c.contains(n)) }
    removeAttribute(k) { delete this.attrs[k] }
    append(...nodes) { for (const n of nodes) this.insertBefore(n, null) }
    insertBefore(n, before) { n.remove(); this.children.splice(before ? this.children.indexOf(before) : this.children.length, 0, n); n.parent = this; changed() }
    remove() { if (this.parent) { const a = this.parent.children; a.splice(a.indexOf(this), 1); this.parent = null; changed() } }
    replaceChildren(...nodes) { for (const n of [...this.children]) n.remove(); this.data = ''; this.append(...nodes); changed() }
    focus() { doc.activeElement = this }
    find(f) { if (f(this)) return this; for (const child of this.children) { const n = child.find(f); if (n) return n } }
  }
  const doc = {defaultView: win, createElement: tag => new Element(tag)}
  const root = doc.createElement('main')
  function until(check, label, timeoutMs = 6000) {
    return new Promise((resolve, reject) => {
      const finish = (fn, value) => { clearTimeout(timer); watchers.delete(test); fn(value) }
      const test = () => { try { const value = check(); if (value) finish(resolve, value) } catch (e) { finish(reject, e) } }
      const timer = setTimeout(() => finish(reject, Error(label + ': ' + (root.find(n => n.attrs.role === 'alert' && !n.hidden)?.textContent || 'not ready'))), timeoutMs)
      watchers.add(test); test()
    })
  }
  const ready = () => until(() => root.find(n => n.tag === 'button' && n.type === 'submit' && n.textContent === '提交任务' && visible(n) && !n.disabled), 'production form unavailable')
  async function submit(text) {
    await ready()
    const form = root.find(n => n.tag === 'form' && n.className.includes('rt-compose'))
    const input = form.find(n => n.tag === 'textarea')
    input.value = text; input.dispatchEvent(new Event('input'))
    form.dispatchEvent(new Event('submit', {cancelable: true}))
  }
  const task = text => {
    const tasks = JSON.parse(store.get(journalKey)).tasks
    return text === undefined ? tasks[0] : tasks.find(t => t.text === text)
  }
  const item = text => task(text)?.items?.[0]
  // Only interact with attached controls a user could reach. A former task
  // scope can survive in a test variable after rendering/collapsing the tree.
  function visible(n) {
    for (; n; n=n.parentElement) {
      if (n.hidden) return false
      if (n===root) return true
      if (n.parentElement?.tag==='details' && n.tag!=='summary' && !n.parentElement.open) return false
    }
    return false
  }
  async function click(predicate,scope=root,label='visible control') {
    const node = await until(() => scope.find(n => n.tag==='button' && visible(n) && !n.disabled && predicate(n)), label)
    node.dispatchEvent(new Event('click',{cancelable:true,bubbles:true}))
  }
  const onChange = fn => {watchers.add(fn); return () => watchers.delete(fn)}
  return {win, root, until, changed, onChange, item, task, ready, submit, visible, click, snapshot: () => store.get(journalKey)}
}
