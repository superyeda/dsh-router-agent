// Browser-local journal. Web Locks serializes *all* read/modify/write operations
// across DSH tabs. A second tab cannot overwrite another tab's outbox receipts.
const VERSION = 1;
export const STORAGE_KEY = 'dsh.router-agent.journal.v1';
export const TIER_NAMES = ['fast', 'standard', 'deep'];
export function emptyDocument() {
  return { version: VERSION, settings: { projects: [], generalDir: '', defaultProject:'', routingMode:'auto', modelMode:'auto', sessionMode:'standard', tiers: Object.fromEntries(TIER_NAMES.map(k => [k, {provider:'', model:'', effort:''}])) }, tasks: [] };
}
function decode(raw) {
  if (raw === null) return emptyDocument();
  try {
    const doc = JSON.parse(raw);
    if (doc?.version !== VERSION || !Array.isArray(doc.tasks) || !Array.isArray(doc.settings?.projects) || !doc.settings.tiers || doc.tasks.some(t => !Array.isArray(t.items))) throw Error();
    return doc;
  } catch { throw new Error('本地路由记录损坏或版本不兼容。为避免重复派发，已停止写入；请先备份浏览器中的路由记录。'); }
}
export function browserJournal(win = window) {
  return {
    read() { return decode(win.localStorage.getItem(STORAGE_KEY)); },
    write(doc) {
      try { win.localStorage.setItem(STORAGE_KEY, JSON.stringify(doc)); }
      catch { throw new Error('无法保存路由记录（可能空间已满或存储被禁用）。已停止后续投递，勿清空记录后重发。'); }
    },
    exclusive(fn) {
      if (!win.navigator.locks) return Promise.reject(new Error('此入口需要支持 Web Locks 的安全上下文（DSH 桌面、本机或 HTTPS）。未投递。'));
      return win.navigator.locks.request(STORAGE_KEY, { mode:'exclusive' }, fn);
    },
    subscribe(fn) {
      const onStorage = e => { if (e.key === STORAGE_KEY || e.key === null) fn(); };
      win.addEventListener('storage', onStorage);
      return () => win.removeEventListener('storage', onStorage);
    },
  };
}
// Deterministic in-memory journal for isolated tests and the clearly labelled demo.
export function memoryJournal() {
  let raw = null, tail = Promise.resolve();
  return {
    read: () => decode(raw), write: doc => { raw = JSON.stringify(doc); },
    exclusive(fn) { const result = tail.then(fn); tail = result.catch(() => {}); return result; },
    subscribe: () => () => {},
  };
}
